// 选手同步服务：裁判提交已揭晓的状态，服务器按视角过滤后用 SSE 推送。房间数据先持久化到 SQLite，再向选手推送。
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openWorkerRoomStore, PERMANENT_SEAT_EXPIRY } from './room-store.mjs';
import { createSseWriter } from './sse-writer.mjs';
import {
  DEFAULT_VISIBILITY, LIVE_VIEWS, applyDraftPick, draftOpen, emptyState, normalizeDraft, normalizeState, normalizeVisibility, project,
} from '../js/live-visibility.js';

export const API_PREFIX = '/lottery/live-api';
const MAX_BODY = 64 * 1024;
const PING_MS = 25_000;
const SWEEP_MS = 60_000;
const CREATE_WINDOW_MS = 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_PASSWORD_LENGTH = 64;
const MAX_STORED_SEATS = 256;
const MAX_DRAFT_SECONDS = 600;
const SURVIVOR_POSITIONS = [0, 1, 2, 3];

const newToken = (bytes = 24) => randomBytes(bytes).toString('base64url');

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const hashSession = (session) => createHash('sha256').update(String(session)).digest('hex');

function derivePassword(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, (error, key) => (error ? reject(error) : resolve(key.toString('hex'))));
  });
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${await derivePassword(password, salt)}`;
}

async function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  return sameToken(await derivePassword(password, salt), expected);
}

// 一局正好 4 名求生者和 1 名监管者；裁判可以在房间设置里调整
const DEFAULT_LIMITS = { survivor: 4, hunter: 1, spectator: null };
const emptyAccess = () => Object.fromEntries(LIVE_VIEWS.map((view) => [view, { passwordHash: null, limit: DEFAULT_LIMITS[view] }]));

function reply(res, status, body = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('too-large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('invalid-json')); }
    });
    req.on('error', reject);
  });
}

export function liveCapacityOptions(env = process.env) {
  const fields = {
    LIVE_MAX_CLIENTS: 'maxClients', LIVE_MAX_CLIENTS_PER_ROOM: 'maxClientsPerRoom',
    LIVE_MAX_CONNECTIONS_PER_SESSION: 'maxConnectionsPerSession', LIVE_MAX_ROOMS: 'maxRooms',
    LIVE_RESERVED_PLAYER_CONNECTIONS: 'reservedPlayerConnections',
    LIVE_RESERVED_PLAYER_CONNECTIONS_PER_ROOM: 'reservedPlayerConnectionsPerRoom',
  };
  const options = {};
  for (const [key, field] of Object.entries(fields)) {
    if (env[key] === undefined) continue;
    const value = Number(env[key]);
    if (!Number.isSafeInteger(value) || value < (field.startsWith('reserved') ? 0 : 1) || value > 100000) throw new Error('Invalid ' + key);
    options[field] = value;
  }
  if ((options.reservedPlayerConnections ?? 0) > (options.maxClients ?? 1000)
      || (options.reservedPlayerConnectionsPerRoom ?? 0) > (options.maxClientsPerRoom ?? 64)) throw new Error('Reserved connections exceed capacity');
  return options;
}

export function createLiveServer({
  now = Date.now,
  dbPath = ':memory:',
  roomStore,
  maxSseBufferBytes = 64 * 1024,
  slowClientTimeoutMs = 30000,
  pingIntervalMs = PING_MS,
  runtimeVersion = 'development',
  ttlMs = 12 * 60 * 60 * 1000,
  maxRooms = 200,
  maxClients = 1000,
  maxClientsPerRoom = 64,
  maxConnectionsPerSession = 2,
  reservedPlayerConnections = Math.min(100, Math.floor(maxClients / 2)),
  reservedPlayerConnectionsPerRoom = Math.min(10, Math.floor(maxClientsPerRoom / 2)),
  maxPendingWrites = 512,
  maxStoredSeats = Math.max(MAX_STORED_SEATS, maxClientsPerRoom * 2),
  maxCreatesPerHour = 30,
  maxPasswordFailures = 10,
  maxPasswordChecks = 16,
  maxRoomMisses = 30,
} = {}) {
  const store = roomStore || openWorkerRoomStore(dbPath);
  let rooms;
  try {
    rooms = new Map(store.load(now() - ttlMs, { permanentSeatsAt: now() }).map(room => {
      const visibility = normalizeVisibility(room.visibility);
      if (!visibility || !room.id || !room.hostToken || !LIVE_VIEWS.every(view => room.access?.[view]) || !room.seats) {
        throw new Error('Invalid persisted room');
      }
      return [room.id, { ...room, state: normalizeState(room.state), visibility, clients: new Set(), presence: new Map(), generation: 0, admissionVersion: 0, projectionCache: new Map() }];
    }));
  } catch (error) { store.close(); throw error; }
  const creates = new Map();
  const attempts = new Map();
  const passwordPending = new Map();
  let passwordChecks = 0;
  let storeClosed = false;
  let clientCount = 0;
  let spectatorCount = 0;
  let writeQueue = Promise.resolve();
  let pendingWrites = 0;
  let shutdownPromise;
  let storeClosing;
  const metrics = { projections: 0, leaseBatches: 0, maxPendingWrites: 0 };
  // Serialize only commit work, never a slow request body or password hash.
  // Memory changes and broadcasts follow the durable commit in the same queue.
  function commit(action, internal = false) {
    if (storeClosed) return Promise.reject(new Error('Room store is closed'));
    if (!internal && pendingWrites >= maxPendingWrites) return Promise.reject(Object.assign(new Error('server-busy'), { busy: true }));
    pendingWrites++;
    metrics.maxPendingWrites = Math.max(metrics.maxPendingWrites, pendingWrites);
    const result = writeQueue.then(action);
    writeQueue = result.catch(() => {}).finally(() => { pendingWrites--; });
    return result;
  }
  const persistedRoom = room => ({ id: room.id, hostToken: room.hostToken, access: room.access, seats: room.seats,
    state: room.state, visibility: room.visibility, seq: room.seq, touchedAt: room.touchedAt });

  const send = (client, event, data) => client.send(event, data);

  function pushTo(room, client) {
    let text = room.projectionCache.get(client.view);
    if (text === undefined) {
      const projected = project(room.state, client.view, room.visibility);
      if (projected.draft) projected.draft.claimed = claimedPositions(room);
      text = JSON.stringify(projected);
      room.projectionCache.set(client.view, text);
      metrics.projections++;
    }
    if (text === client.last) return;
    client.last = text;
    // 倒计时用服务器时间，避免各设备时钟不一致
    if (room.state.draft) client.send('clock', { now: now() });
    client.send('state', text, true);
  }

  const broadcast = (room) => room.clients.forEach((client) => pushTo(room, client));

  /** 号位跟着名额走，断线不释放，直到主动退出或裁判明确移除。 */
  function positionHolder(room, position, except, seats = room.seats) {
    return Object.entries(seats).find(([hash, seat]) => seat.view === 'survivor' && seat.position === position && hash !== except)?.[0] || null;
  }

  /** 最小的空号位；4 个都有人时返回 undefined，多出来的求生者只能观看。 */
  const freePosition = (room, except, seats = room.seats) => SURVIVOR_POSITIONS.find((position) => !positionHolder(room, position, except, seats));

  const notifyPosition = (room, hash, position) => room.clients.forEach((client) => {
    if (client.seat === hash) client.send('position', { position: position ?? null });
  });

  /** 有号位空出来时，补给在线但还没有号位的求生者。 */
  async function promoteSurvivors(room) {
    const seats = { ...room.seats };
    const promoted = [];
    for (const hash of Object.keys(seats)) {
      if (seats[hash].view !== 'survivor' || seats[hash].position !== undefined || !room.presence.get(hash)?.connections) continue;
      const position = freePosition(room, hash, seats);
      if (position === undefined) break;
      seats[hash] = { ...seats[hash], position };
      promoted.push([hash, position]);
    }
    if (!promoted.length) return;
    await saveSeats(room, seats);
    promoted.forEach(([hash, position]) => notifyPosition(room, hash, position));
  }

  const claimedPositions = (room) => SURVIVOR_POSITIONS.map((position) => Boolean(positionHolder(room, position)));

  /** 名额变化后更新选手看到的号位占用；只有变化时才推送。 */
  function refreshClaims(room) {
    if (!room.state.draft) return;
    const key = JSON.stringify(claimedPositions(room));
    if (key === room.claimKey) return;
    room.claimKey = key;
    room.projectionCache.clear();
    broadcast(room);
  }

  function closeClients(room, reason, match = () => true) {
    for (const client of [...room.clients]) {
      if (match(client)) { client.close(reason); client.detach(); }
    }
  }

  async function removeRoom(id) {
    const room = rooms.get(id);
    if (!room) return;
    await store.remove(id);
    rooms.delete(id);
    closeClients(room, 'room-closed');
  }

  const isCurrent = room => rooms.get(room.id) === room;
  function assertCurrent(room) { if (!isCurrent(room)) throw new Error('Room no longer exists'); }

  async function updateRoom(room, changes) {
    assertCurrent(room);
    const next = { ...room, ...changes, touchedAt: now() };
    await store.put(persistedRoom(next));
    Object.assign(room, next);
    if (changes.state || changes.visibility) room.projectionCache.clear();
  }

  // 选手占位只更新名额，不算裁判操作，不延长房间有效期
  async function saveSeats(room, seats) {
    assertCurrent(room);
    await store.putSeats(room.id, seats);
    room.seats = seats;
  }

  /** 名额跟随有效凭证持久保留，不依赖连接状态或断线时长。 */
  function holdsSeat(room, hash) {
    return Boolean(room.seats[hash]);
  }

  function seatsTaken(room, view, except) {
    return Object.entries(room.seats).filter(([hash, seat]) => seat.view === view && hash !== except && holdsSeat(room, hash)).length;
  }

  const seatLimit = (room, view) => room.access[view].limit ?? maxClientsPerRoom;

  function accessSummary(room) {
    const online = viewers(room);
    return Object.fromEntries(LIVE_VIEWS.map((view) => {
      const { passwordHash, limit } = room.access[view];
      const summary = { open: !room.access[view].closed, password: Boolean(passwordHash), limit, maxLimit: maxClientsPerRoom, effectiveLimit: seatLimit(room, view), taken: seatsTaken(room, view), online: online[view] };
      if (view === 'survivor') {
        summary.positions = SURVIVOR_POSITIONS.map((position) => {
          const hash = positionHolder(room, position);
          return { taken: Boolean(hash), online: Boolean(hash && room.presence.get(hash)?.connections) };
        });
      }
      return [view, summary];
    }));
  }

  /** 超过次数后拒绝继续尝试；成功的请求不计数。 */
  function overLimit(key, max) {
    const time = now();
    const recent = (attempts.get(key) || []).filter((at) => time - at < ATTEMPT_WINDOW_MS);
    attempts.set(key, recent);
    return recent.length >= max;
  }

  const recordAttempt = (key) => attempts.get(key)?.push(now()) ?? attempts.set(key, [now()]);
  // Reserve before scrypt: failures plus in-flight checks share the same budget.
  // A separate global cap bounds the worker queue across IPs and rooms.
  function reservePasswordCheck(key) {
    overLimit(key, maxPasswordFailures);
    const pending = passwordPending.get(key) || 0;
    if (attempts.get(key).length >= maxPasswordFailures) return { error: 'too-many-attempts', retryAfter: 600 };
    if (attempts.get(key).length + pending >= maxPasswordFailures || passwordChecks >= maxPasswordChecks) return { error: 'server-busy', retryAfter: 2 };
    passwordPending.set(key, pending + 1);
    passwordChecks++;
    return { release: (failed) => {
      const remaining = passwordPending.get(key) - 1;
      if (remaining) passwordPending.set(key, remaining);
      else passwordPending.delete(key);
      passwordChecks--;
      if (failed) recordAttempt(key);
    } };
  }
  const clientIp = (req) => String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');

  function viewers(room) {
    const counts = Object.fromEntries(LIVE_VIEWS.map((view) => [view, 0]));
    const seen = new Set();
    room.clients.forEach(client => { if (!seen.has(client.seat)) { seen.add(client.seat); counts[client.view]++; } });
    return counts;
  }

  function allowCreate(ip) {
    const time = now();
    const recent = (creates.get(ip) || []).filter((at) => time - at < CREATE_WINDOW_MS);
    if (recent.length >= maxCreatesPerHour) { creates.set(ip, recent); return false; }
    recent.push(time);
    creates.set(ip, recent);
    return true;
  }

  async function createRoom(req, res) {
    return commit(async () => {
      const ip = clientIp(req);
      if (rooms.size >= maxRooms || !allowCreate(ip)) return reply(res, 429, { error: 'too-many-rooms' });
      let id;
      do { id = String(randomInt(100000, 1000000)); } while (rooms.has(id));
      const room = {
        id,
        hostToken: newToken(),
        access: emptyAccess(),
        seats: {},
        presence: new Map(),
        generation: 0,
        admissionVersion: 0,
        projectionCache: new Map(),
        state: emptyState(),
        visibility: { ...DEFAULT_VISIBILITY },
        seq: 0,
        touchedAt: now(),
        clients: new Set(),
      };
      await store.create(persistedRoom(room));
      rooms.set(room.id, room);
      return reply(res, 201, { roomId: room.id, hostToken: room.hostToken, access: accessSummary(room), visibility: room.visibility });
    });
  }

  async function joinRoom(req, res, room) {
    const admissionVersion = room.admissionVersion;
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return reply(res, error.message === 'too-large' ? 413 : 400, { error: error.message });
    }
    if (!isCurrent(room)) return reply(res, 404, { error: 'room-not-found' });
    if (admissionVersion !== room.admissionVersion) return reply(res, 409, { error: 'room-changed' });
    const { view, password, previous } = body;
    if (!LIVE_VIEWS.includes(view)) return reply(res, 400, { error: 'invalid-view' });
    if (room.access[view].closed) return reply(res, 403, { error: 'view-closed' });
    const failureKey = `password:${clientIp(req)}:${room.id}`;
    const { passwordHash } = room.access[view];
    if (passwordHash) {
      const permit = reservePasswordCheck(failureKey);
      if (permit.error) { res.setHeader('Retry-After', String(permit.retryAfter)); return reply(res, 429, { error: permit.error }); }
      let valid;
      try { valid = typeof password === 'string' && password.length <= MAX_PASSWORD_LENGTH && await verifyPassword(password, passwordHash); }
      finally { permit.release(valid === false); }
      if (!isCurrent(room)) return reply(res, 404, { error: 'room-not-found' });
      if (admissionVersion !== room.admissionVersion) return reply(res, 409, { error: 'room-changed' });
      if (!valid || room.access[view].passwordHash !== passwordHash) return reply(res, 403, { error: 'wrong-password' });
    }
    return commit(async () => {
      if (!isCurrent(room)) return reply(res, 404, { error: 'room-not-found' });
      if (admissionVersion !== room.admissionVersion) return reply(res, 409, { error: 'room-changed' });
      const previousHash = typeof previous === 'string' ? hashSession(previous) : null;
      if (seatsTaken(room, view, previousHash) >= seatLimit(room, view)) return reply(res, 409, { error: 'view-full' });
      const seats = { ...room.seats };
      if (previousHash) delete seats[previousHash];
      if (Object.keys(seats).length >= maxStoredSeats) return reply(res, 409, { error: 'view-full' });
      const session = newToken();
      const hash = hashSession(session);
      seats[hash] = { view, expiresAt: PERMANENT_SEAT_EXPIRY };
      if (view === 'survivor') {
        const position = freePosition(room, hash, seats);
        if (position !== undefined) seats[hash].position = position;
      }
      await saveSeats(room, seats);
      if (previousHash) {
        closeClients(room, 'session-replaced', client => client.seat === previousHash);
        room.presence.delete(previousHash);
      }
      refreshClaims(room);
      return reply(res, 200, { session, view, position: seats[hash].position ?? null });
    });
  }

  /** 选手主动退出：立即释放名额，同一凭证打开的其他页面也一起退回进入页。 */
  async function leaveRoomSeat(req, res, room) {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return reply(res, error.message === 'too-large' ? 413 : 400, { error: error.message });
    }
    if (typeof body.session !== 'string') return reply(res, 400, { error: 'invalid-session' });
    const hash = hashSession(body.session);
    return commit(async () => {
      if (!isCurrent(room)) return reply(res, 404, { error: 'room-not-found' });
      if (!room.seats[hash]) return reply(res, 200, {});
      const seats = { ...room.seats };
      delete seats[hash];
      await saveSeats(room, seats);
      closeClients(room, 'session-replaced', client => client.seat === hash);
      room.presence.delete(hash);
      await promoteSurvivors(room);
      refreshClaims(room);
      return reply(res, 200, {});
    });
  }

  /** 有效凭证恢复原身份；已退出或被裁判撤销的凭证不能重连。 */
  function sessionStatus(room, session) {
    const hash = hashSession(session);
    const view = room.seats[hash]?.view;
    if (!session || !view) return { status: 403, error: 'invalid-session' };
    return { hash, view };
  }

  function connectionError(room, hash, view) {
    if ((room.presence.get(hash)?.connections || 0) >= maxConnectionsPerSession) return 'too-many-tabs';
    if (room.clients.size >= maxClientsPerRoom || clientCount >= maxClients) return 'too-many-viewers';
    if (view === 'spectator') {
      const spectators = [...room.clients].filter(client => client.view === 'spectator').length;
      if (spectators >= maxClientsPerRoom - reservedPlayerConnectionsPerRoom || spectatorCount >= maxClients - reservedPlayerConnections) return 'spectator-capacity';
    }
    return null;
  }

  async function subscribe(req, res, room, session) {
    return commit(async () => {
      if (!isCurrent(room)) return reply(res, 404, { error: 'room-not-found' });
      const { hash, view, status, error } = sessionStatus(room, session);
      if (error) return reply(res, status, { error });
      const unavailable = connectionError(room, hash, view);
      if (unavailable) { res.setHeader('Retry-After', '3'); return reply(res, 503, { error: unavailable }); }
      if (res.destroyed) return;
      // 兼容旧版尚未分配号位的凭证；正常重连保持原号位。
      const seat = { ...room.seats[hash] };
      if (view === 'survivor' && (seat.position === undefined || positionHolder(room, seat.position, hash))) {
        const position = freePosition(room, hash);
        if (position === undefined) delete seat.position; else seat.position = position;
      }
      if (seat.position !== room.seats[hash].position) await saveSeats(room, { ...room.seats, [hash]: seat });
      if (res.destroyed) return;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      });
      const client = { ...createSseWriter(res, { maxBufferedBytes: maxSseBufferBytes, slowClientTimeoutMs }), view, seat: hash, last: null };
      room.clients.add(client);
      clientCount++;
      if (view === 'spectator') spectatorCount++;
      const presence = room.presence.get(hash) || { connections: 0 };
      presence.connections++;
      room.presence.set(hash, presence);
      res.write('retry: ' + randomInt(1500, 4001) + '\n\n');
      client.send('position', { position: seat.position ?? null });
      pushTo(room, client);
      refreshClaims(room);
      client.detach = () => {
        if (!room.clients.delete(client)) return;
        clientCount--;
        if (view === 'spectator') spectatorCount--;
        presence.connections--;
        if (!presence.connections && room.presence.get(hash) === presence) {
          room.presence.delete(hash);
        }
      };
      res.once('close', client.detach);
      return undefined;
    });
  }

  async function hostUpdate(req, res, room, action) {
    const generation = room.generation;
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return reply(res, error.message === 'too-large' ? 413 : 400, { error: error.message });
    }
    return commit(async () => {
      if (!isCurrent(room)) return reply(res, 404, { error: 'room-not-found' });
      if (generation !== room.generation) return reply(res, 409, { error: 'room-changed' });
      if (action === 'state') {
        if (!Number.isSafeInteger(body.seq) || body.seq < 0) return reply(res, 400, { error: 'invalid-seq' });
        if (body.seq <= room.seq) return reply(res, 200, { stale: true, viewers: viewers(room) }); // 网络乱序时丢弃旧状态
        let state;
        try {
          state = normalizeState(body.state);
        } catch (error) {
          return reply(res, 400, { error: error.message });
        }
        // 选手的选择只由选角接口修改；开始新一轮时选角自然结束
        delete state.draft;
        if (room.state.draft?.round === state.round) state.draft = room.state.draft;
        await updateRoom(room, { state, seq: body.seq });
        broadcast(room);
        return reply(res, 200, { viewers: viewers(room) });
      }
      const visibility = normalizeVisibility(body.visibility);
      if (!visibility) return reply(res, 400, { error: 'invalid-visibility' });
      await updateRoom(room, { visibility });
      broadcast(room);
      return reply(res, 200, { visibility, viewers: viewers(room) });
    });
  }

  async function updateAccess(req, res, room) {
    const generation = room.generation;
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return reply(res, error.message === 'too-large' ? 413 : 400, { error: error.message });
    }
    if (!isCurrent(room)) return reply(res, 404, { error: 'room-not-found' });
    if (generation !== room.generation) return reply(res, 409, { error: 'room-changed' });
    const { view, password, limit, open } = body;
    if (!LIVE_VIEWS.includes(view)) return reply(res, 400, { error: 'invalid-view' });
    if (open !== undefined && typeof open !== 'boolean') return reply(res, 400, { error: 'invalid-open' });
    if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > maxClientsPerRoom)) {
      return reply(res, 400, { error: 'invalid-limit' });
    }
    if (password !== undefined && password !== null && (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH)) {
      return reply(res, 400, { error: 'invalid-password' });
    }
    const passwordHash = password === undefined || password === null ? password : await hashPassword(password);
    return commit(async () => {
      if (!isCurrent(room)) return reply(res, 404, { error: 'room-not-found' });
      if (generation !== room.generation) return reply(res, 409, { error: 'room-changed' });
      const next = { ...room.access[view] };
      if (limit !== undefined) next.limit = limit;
      if (password !== undefined) next.passwordHash = passwordHash;
      if (open !== undefined) next.closed = !open;
      const changes = { access: { ...room.access, [view]: next } };
      // 改密码或关闭身份后，这个身份已进入的人都要退出
      const removeSeats = password !== undefined || open === false;
      if (removeSeats) {
        changes.seats = Object.fromEntries(Object.entries(room.seats).filter(([, seat]) => seat.view !== view));
      }
      await updateRoom(room, changes);
      if (removeSeats) {
        room.admissionVersion++;
        closeClients(room, open === false ? 'view-closed' : 'password-changed', (client) => client.view === view);
        refreshClaims(room);
      }
      return reply(res, 200, { access: accessSummary(room) });
    });
  }

  async function clearSeats(req, res, room) {
    const generation = room.generation;
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return reply(res, error.message === 'too-large' ? 413 : 400, { error: error.message });
    }
    return commit(async () => {
      if (!isCurrent(room)) return reply(res, 404, { error: 'room-not-found' });
      if (generation !== room.generation) return reply(res, 409, { error: 'room-changed' });
      if (!LIVE_VIEWS.includes(body.view)) return reply(res, 400, { error: 'invalid-view' });
      await updateRoom(room, { seats: Object.fromEntries(Object.entries(room.seats).filter(([, seat]) => seat.view !== body.view)) });
      room.admissionVersion++;
      closeClients(room, 'seat-cleared', (client) => client.view === body.view);
      refreshClaims(room);
      return reply(res, 200, { access: accessSummary(room) });
    });
  }

  /** 踢出某个号位上的求生者；不封禁，对方可以重新进入，并拿到最小的空号位。 */
  async function kickPosition(req, res, room) {
    const generation = room.generation;
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return reply(res, error.message === 'too-large' ? 413 : 400, { error: error.message });
    }
    return commit(async () => {
      if (!isCurrent(room)) return reply(res, 404, { error: 'room-not-found' });
      if (generation !== room.generation) return reply(res, 409, { error: 'room-changed' });
      if (!SURVIVOR_POSITIONS.includes(body.position)) return reply(res, 400, { error: 'invalid-position' });
      const hash = positionHolder(room, body.position);
      if (hash) {
        const { [hash]: removed, ...seats } = room.seats;
        await updateRoom(room, { seats });
        closeClients(room, 'kicked', (client) => client.seat === hash);
        room.presence.delete(hash);
        await promoteSurvivors(room);
        refreshClaims(room);
      }
      return reply(res, 200, { access: accessSummary(room) });
    });
  }

  /** 一场结束：清空所有名额和上一场结果，房间号、可见范围和人数上限保留。 */
  async function resetRoom(req, res, room) {
    const generation = room.generation;
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return reply(res, error.message === 'too-large' ? 413 : 400, { error: error.message });
    }
    return commit(async () => {
      if (!isCurrent(room)) return reply(res, 404, { error: 'room-not-found' });
      if (generation !== room.generation) return reply(res, 409, { error: 'room-changed' });
      if (body.seq !== undefined && (!Number.isSafeInteger(body.seq) || body.seq < 0)) return reply(res, 400, { error: 'invalid-seq' });
      const access = body.clearPasswords
        ? Object.fromEntries(LIVE_VIEWS.map((view) => [view, { ...room.access[view], passwordHash: null }]))
        : room.access;
      // 序号前移，重置前还在路上的旧状态不会把上一场结果写回来
      await updateRoom(room, { access, seats: {}, state: emptyState(), seq: Math.max(room.seq, body.seq ?? 0) });
      room.generation++;
      room.admissionVersion++;
      room.presence.clear();
      closeClients(room, 'reset');
      return reply(res, 200, { access: accessSummary(room) });
    });
  }

  /** 选手操作不算裁判操作，不延长房间有效期。 */
  async function saveDraft(room, draft) {
    assertCurrent(room);
    const state = { ...room.state, draft };
    await store.put(persistedRoom({ ...room, state }));
    room.state = state;
    room.projectionCache.clear();
    broadcast(room);
  }

  const DRAFT_CONFLICTS = new Set(['already-locked', 'card-taken', 'nothing-selected']);
  const draftError = (res, error) => {
    if (DRAFT_CONFLICTS.has(error.message)) return reply(res, 409, { error: error.message });
    if (['invalid-position', 'invalid-char'].includes(error.message)) return reply(res, 400, { error: error.message });
    throw error;
  };
  const hostDraftView = (room) => ({ draft: room.state.draft || null, claimed: claimedPositions(room), now: now() });

  /** 裁判发放候选：开始新一轮，旧结果同时撤下。 */
  async function hostStartDraft(req, res, room) {
    const generation = room.generation;
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return reply(res, error.message === 'too-large' ? 413 : 400, { error: error.message });
    }
    return commit(async () => {
      if (!isCurrent(room)) return reply(res, 404, { error: 'room-not-found' });
      if (generation !== room.generation) return reply(res, 409, { error: 'room-changed' });
      if (!Number.isSafeInteger(body.seq) || body.seq < 0) return reply(res, 400, { error: 'invalid-seq' });
      if (body.seq <= room.seq) return reply(res, 200, { stale: true });
      const seconds = body.seconds ?? null;
      if (seconds !== null && (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_DRAFT_SECONDS)) return reply(res, 400, { error: 'invalid-seconds' });
      let draft;
      try {
        const { seats, closed, ...fresh } = body.draft || {};
        draft = normalizeDraft({ ...fresh, deadline: seconds === null ? null : now() + seconds * 1000 });
      } catch (error) {
        return reply(res, 400, { error: error.message });
      }
      await updateRoom(room, { state: { ...emptyState(), round: draft.round, phase: 'drawing', draft }, seq: body.seq });
      room.claimKey = JSON.stringify(claimedPositions(room));
      broadcast(room);
      return reply(res, 200, hostDraftView(room));
    });
  }

  /** 裁判代选、延时、结束选角。 */
  async function hostDraftAction(req, res, room, action) {
    const generation = room.generation;
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return reply(res, error.message === 'too-large' ? 413 : 400, { error: error.message });
    }
    return commit(async () => {
      if (!isCurrent(room)) return reply(res, 404, { error: 'room-not-found' });
      if (generation !== room.generation) return reply(res, 409, { error: 'room-changed' });
      const draft = room.state.draft;
      if (!draft || draft.round !== body.round) return reply(res, 409, { error: 'no-draft' });
      let next;
      if (action === 'pick') {
        try { next = applyDraftPick(draft, body.position, body.char, body.lock === true); } catch (error) { return draftError(res, error); }
      } else if (action === 'extend') {
        if (draft.deadline === null || !Number.isInteger(body.seconds) || body.seconds < 1 || body.seconds > MAX_DRAFT_SECONDS) return reply(res, 400, { error: 'invalid-seconds' });
        next = { ...draft, deadline: Math.max(draft.deadline, now()) + body.seconds * 1000 };
      } else {
        next = { ...draft, closed: true };
      }
      await saveDraft(room, next);
      return reply(res, 200, hostDraftView(room));
    });
  }

  /** 选手预选和锁定。 */
  async function playerDraftAction(req, res, room, action) {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return reply(res, error.message === 'too-large' ? 413 : 400, { error: error.message });
    }
    return commit(async () => {
      if (!isCurrent(room)) return reply(res, 404, { error: 'room-not-found' });
      const { hash, view, status, error } = sessionStatus(room, body.session);
      if (error) return reply(res, status, { error });
      const draft = room.state.draft;
      if (!draft || draft.round !== body.round) return reply(res, 409, { error: 'no-draft' });
      if (!draftOpen(draft, now())) return reply(res, 409, { error: 'draft-closed' });
      // 写入前检查凭证仍拥有名额，号位归属另行核对。
      if (!holdsSeat(room, hash)) return reply(res, 403, { error: 'not-your-seat' });
      const { position } = body;
      if (view === 'hunter') {
        if (position !== 4) return reply(res, 403, { error: 'not-your-seat' });
      } else if (view === 'survivor') {
        // 共享卡池里，无人认领的号位可以由在场队友代选
        const own = room.seats[hash].position;
        if (!SURVIVOR_POSITIONS.includes(own) || positionHolder(room, own) !== hash) return reply(res, 403, { error: 'not-your-seat' });
        const canHelp = draft.survivor.mode === 'shared' && !positionHolder(room, position);
        if (!SURVIVOR_POSITIONS.includes(position) || (own !== position && !canHelp)) return reply(res, 403, { error: 'not-your-seat' });
      } else {
        return reply(res, 403, { error: 'not-your-seat' });
      }
      let next;
      try { next = applyDraftPick(draft, position, body.char, action === 'lock'); } catch (err) { return draftError(res, err); }
      await saveDraft(room, next);
      return reply(res, 200, {});
    });
  }

  const hostAuthorized = (req, room) => sameToken((req.headers.authorization || '').replace(/^Bearer /, ''), room.hostToken);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://live.invalid');
    if (req.headers.origin && ![`https://${req.headers.host}`, `http://${req.headers.host}`].includes(req.headers.origin)) {
      return reply(res, 403, { error: 'invalid-origin' });
    }
    if (req.method === 'GET' && url.pathname === `${API_PREFIX}/health`) {
      await store.check();
      return reply(res, 200, { ok: true, runtime_version: runtimeVersion, storage: 'sqlite' });
    }
    if (!url.pathname.startsWith(`${API_PREFIX}/`)) return reply(res, 404, { error: 'not-found' });
    const parts = url.pathname.slice(API_PREFIX.length + 1).split('/');
    if (parts[0] !== 'rooms') return reply(res, 404, { error: 'not-found' });

    if (parts.length === 1) {
      return req.method === 'POST' ? createRoom(req, res) : reply(res, 405, { error: 'method-not-allowed' });
    }

    const action = parts.slice(2).join('/');
    const room = rooms.get(parts[1]);
    // 房间号位数少，限制猜测频率；超限后对所有房间都返回同样的结果，不暴露房间是否存在
    const missKey = `miss:${clientIp(req)}`;
    if (!(room && hostAuthorized(req, room)) && overLimit(missKey, maxRoomMisses)) return reply(res, 429, { error: 'too-many-attempts' });
    if (!room) {
      recordAttempt(missKey);
      return reply(res, 404, { error: 'room-not-found' });
    }
    const session = url.searchParams.get('session');

    if (req.method === 'GET' && action === 'info') {
      const summary = accessSummary(room);
      return reply(res, 200, {
        views: Object.fromEntries(LIVE_VIEWS.map((view) => [view, {
          open: summary[view].open, password: summary[view].password, limit: summary[view].limit, effectiveLimit: summary[view].effectiveLimit, taken: summary[view].taken,
          full: summary[view].taken >= seatLimit(room, view),
        }])),
      });
    }
    if (req.method === 'POST' && action === 'join') return joinRoom(req, res, room);
    if (req.method === 'POST' && action === 'leave') return leaveRoomSeat(req, res, room);
    if (req.method === 'GET' && action === 'events') return subscribe(req, res, room, session);
    if (req.method === 'POST' && ['draft/pick', 'draft/lock'].includes(action)) return playerDraftAction(req, res, room, action.slice(6));
    if (req.method === 'GET' && action === 'check') {
      const { hash, view, status, error } = sessionStatus(room, session);
      return error ? reply(res, status, { error }) : reply(res, 200, { ok: true, view, connectionError: connectionError(room, hash, view) });
    }

    if (!hostAuthorized(req, room)) return reply(res, 403, { error: 'invalid-host-token' });
    if (req.method === 'GET' && action === 'status') {
      return reply(res, 200, { visibility: room.visibility, access: accessSummary(room), viewers: viewers(room) });
    }
    if (req.method === 'PUT' && (action === 'state' || action === 'visibility')) return hostUpdate(req, res, room, action);
    if (req.method === 'PUT' && action === 'access') return updateAccess(req, res, room);
    if (req.method === 'PUT' && action === 'draft') return hostStartDraft(req, res, room);
    if (req.method === 'GET' && action === 'draft') return reply(res, 200, hostDraftView(room));
    if (req.method === 'POST' && ['draft/host-pick', 'draft/extend', 'draft/close'].includes(action)) return hostDraftAction(req, res, room, action.slice(6).replace('host-', ''));
    if (req.method === 'POST' && action === 'seats/clear') return clearSeats(req, res, room);
    if (req.method === 'POST' && action === 'seats/kick') return kickPosition(req, res, room);
    if (req.method === 'POST' && action === 'reset') return resetRoom(req, res, room);
    if (req.method === 'DELETE' && action === '') {
      return commit(async () => { await removeRoom(room.id); return reply(res, 200, {}); });
    }
    return reply(res, 404, { error: 'not-found' });
  }

  async function sweep() {
    return commit(async () => {
      const time = now();
      for (const [id, room] of rooms) {
        if (time - room.touchedAt > ttlMs) await removeRoom(id);
      }
      for (const [ip, list] of creates) {
        if (!list.some((at) => time - at < CREATE_WINDOW_MS)) creates.delete(ip);
      }
      for (const [key, list] of attempts) {
        if (!list.some((at) => time - at < ATTEMPT_WINDOW_MS)) attempts.delete(key);
      }
    }, true);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      if (error.busy && !res.headersSent) { res.setHeader('Retry-After', '2'); reply(res, 503, { error: 'server-busy' }); }
      else if (!res.headersSent) reply(res, 500, { error: 'server-error' });
      else res.end();
    });
  });
  // SSE 是长连接，不能被默认的请求超时切断
  server.requestTimeout = 0;
  function heartbeat() {
    for (const room of rooms.values()) room.clients.forEach(client => send(client, 'ping', {}));
  }
  const pingTimer = setInterval(heartbeat, pingIntervalMs);
  const sweepTimer = setInterval(() => { sweep().catch(() => console.error('Room expiration could not be persisted')); }, SWEEP_MS);
  pingTimer.unref(); sweepTimer.unref();
  server.on('close', () => {
    clearInterval(pingTimer); clearInterval(sweepTimer);
    storeClosing = writeQueue.then(() => { storeClosed = true; return store.close(); });
  });
  server.shutdown = () => shutdownPromise ||= (async () => {
    clearInterval(pingTimer); clearInterval(sweepTimer);
    for (const room of rooms.values()) for (const client of [...room.clients]) { client.res.destroy(); client.detach(); }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await storeClosing;
  })();
  server.sweep = sweep;
  server.heartbeat = heartbeat;
  server.metrics = () => ({ ...metrics, connections: clientCount, rooms: rooms.size, pendingWrites });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const port = Number(process.env.LIVE_PORT || 18306);
  const metadata = process.env.LIVE_METADATA ? JSON.parse(readFileSync(process.env.LIVE_METADATA, 'utf8')) : {};
  if (process.env.LIVE_METADATA && !/^[a-f0-9]{64}$/.test(metadata.runtime_version || '')) throw new Error('Invalid runtime metadata');
  if (process.env.LIVE_METADATA && !process.env.LIVE_DB_PATH) throw new Error('LIVE_DB_PATH is required in production');
  const dbPath = process.env.LIVE_DB_PATH || fileURLToPath(new URL('../.data/rooms.sqlite', import.meta.url));
  const server = createLiveServer({ ...liveCapacityOptions(), runtimeVersion: metadata.runtime_version, dbPath });
  server.listen(port, '127.0.0.1', () => console.log('live server on 127.0.0.1:' + port));
  const stop = () => { server.shutdown().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
