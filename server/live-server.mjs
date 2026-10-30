// 选手同步服务：裁判提交已揭晓的状态，服务器按视角过滤后用 SSE 推送。数据只放内存。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_VISIBILITY, LIVE_VIEWS, emptyState, normalizeState, normalizeVisibility, project,
} from '../js/live-visibility.js';

export const API_PREFIX = '/lottery/live-api';
const MAX_BODY = 64 * 1024;
const PING_MS = 25_000;
const SWEEP_MS = 60_000;
const CREATE_WINDOW_MS = 60 * 60 * 1000;

const newToken = (bytes = 24) => randomBytes(bytes).toString('base64url');

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

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

export function createLiveServer({
  now = Date.now,
  runtimeVersion = 'development',
  ttlMs = 12 * 60 * 60 * 1000,
  maxRooms = 200,
  maxClients = 1000,
  maxClientsPerRoom = 64,
  maxCreatesPerHour = 30,
} = {}) {
  const rooms = new Map();
  const creates = new Map();
  let clientCount = 0;

  const send = (client, event, data) => client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  function pushTo(room, client) {
    const text = JSON.stringify(project(room.state, client.view, room.visibility));
    if (text === client.last) return;
    client.last = text;
    client.res.write(`event: state\ndata: ${text}\n\n`);
  }

  const broadcast = (room) => room.clients.forEach((client) => pushTo(room, client));

  function closeClients(room) {
    for (const client of room.clients) {
      send(client, 'closed', {});
      client.res.end();
    }
  }

  function removeRoom(id) {
    const room = rooms.get(id);
    if (!room) return;
    closeClients(room);
    rooms.delete(id);
  }

  const issueTokens = () => Object.fromEntries(LIVE_VIEWS.map((view) => [view, newToken()]));

  function viewers(room) {
    const counts = Object.fromEntries(LIVE_VIEWS.map((view) => [view, 0]));
    room.clients.forEach((client) => { counts[client.view]++; });
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

  function createRoom(req, res) {
    const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
    if (rooms.size >= maxRooms || !allowCreate(ip)) return reply(res, 429, { error: 'too-many-rooms' });
    const room = {
      id: newToken(9),
      hostToken: newToken(),
      tokens: issueTokens(),
      state: emptyState(),
      visibility: { ...DEFAULT_VISIBILITY },
      seq: 0,
      touchedAt: now(),
      clients: new Set(),
    };
    rooms.set(room.id, room);
    return reply(res, 201, { roomId: room.id, hostToken: room.hostToken, tokens: room.tokens, visibility: room.visibility });
  }

  function subscribe(req, res, room, token) {
    const view = LIVE_VIEWS.find((name) => sameToken(room.tokens[name], token));
    if (!view) return reply(res, 403, { error: 'invalid-token' });
    if (room.clients.size >= maxClientsPerRoom || clientCount >= maxClients) return reply(res, 503, { error: 'too-many-viewers' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    });
    const client = { res, view, last: null };
    room.clients.add(client);
    clientCount++;
    res.write('retry: 2000\n\n');
    pushTo(room, client);
    req.on('close', () => {
      room.clients.delete(client);
      clientCount--;
    });
    return undefined;
  }

  async function hostUpdate(req, res, room, action) {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return reply(res, error.message === 'too-large' ? 413 : 400, { error: error.message });
    }
    if (!rooms.has(room.id)) return reply(res, 404, { error: 'room-not-found' });
    room.touchedAt = now();
    if (action === 'state') {
      if (!Number.isSafeInteger(body.seq) || body.seq < 0) return reply(res, 400, { error: 'invalid-seq' });
      if (body.seq <= room.seq) return reply(res, 200, { stale: true, viewers: viewers(room) }); // 网络乱序时丢弃旧状态
      try {
        room.state = normalizeState(body.state);
      } catch (error) {
        return reply(res, 400, { error: error.message });
      }
      room.seq = body.seq;
      broadcast(room);
      return reply(res, 200, { viewers: viewers(room) });
    }
    const visibility = normalizeVisibility(body.visibility);
    if (!visibility) return reply(res, 400, { error: 'invalid-visibility' });
    room.visibility = visibility;
    broadcast(room);
    return reply(res, 200, { visibility, viewers: viewers(room) });
  }

  function rotateTokens(res, room) {
    closeClients(room);
    room.clients.clear();
    room.tokens = issueTokens();
    room.touchedAt = now();
    return reply(res, 200, { tokens: room.tokens });
  }

  const hostAuthorized = (req, room) => sameToken((req.headers.authorization || '').replace(/^Bearer /, ''), room.hostToken);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://live.invalid');
    if (req.headers.origin && ![`https://${req.headers.host}`, `http://${req.headers.host}`].includes(req.headers.origin)) {
      return reply(res, 403, { error: 'invalid-origin' });
    }
    if (req.method === 'GET' && url.pathname === `${API_PREFIX}/health`) {
      return reply(res, 200, { ok: true, runtime_version: runtimeVersion });
    }
    if (!url.pathname.startsWith(`${API_PREFIX}/`)) return reply(res, 404, { error: 'not-found' });
    const parts = url.pathname.slice(API_PREFIX.length + 1).split('/');
    if (parts[0] !== 'rooms') return reply(res, 404, { error: 'not-found' });

    if (parts.length === 1) {
      return req.method === 'POST' ? createRoom(req, res) : reply(res, 405, { error: 'method-not-allowed' });
    }

    const room = rooms.get(parts[1]);
    if (!room) return reply(res, 404, { error: 'room-not-found' });
    const action = parts.slice(2).join('/');
    const token = url.searchParams.get('token');

    if (req.method === 'GET' && action === 'events') return subscribe(req, res, room, token);
    if (req.method === 'GET' && action === 'check') {
      const valid = LIVE_VIEWS.some((name) => sameToken(room.tokens[name], token));
      return valid ? reply(res, 200, { ok: true }) : reply(res, 403, { error: 'invalid-token' });
    }

    if (!hostAuthorized(req, room)) return reply(res, 403, { error: 'invalid-host-token' });
    if (req.method === 'GET' && action === 'status') {
      return reply(res, 200, { visibility: room.visibility, tokens: room.tokens, viewers: viewers(room) });
    }
    if (req.method === 'PUT' && (action === 'state' || action === 'visibility')) return hostUpdate(req, res, room, action);
    if (req.method === 'POST' && action === 'rotate') return rotateTokens(res, room);
    if (req.method === 'DELETE' && action === '') {
      removeRoom(room.id);
      return reply(res, 200, {});
    }
    return reply(res, 404, { error: 'not-found' });
  }

  function sweep() {
    const time = now();
    for (const [id, room] of rooms) {
      if (time - room.touchedAt > ttlMs) removeRoom(id);
    }
    for (const [ip, list] of creates) {
      if (!list.some((at) => time - at < CREATE_WINDOW_MS)) creates.delete(ip);
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) reply(res, 500, { error: 'server-error' });
      else res.end();
    });
  });
  // SSE 是长连接，不能被默认的请求超时切断
  server.requestTimeout = 0;
  const pingTimer = setInterval(() => {
    for (const room of rooms.values()) room.clients.forEach((client) => send(client, 'ping', {}));
  }, PING_MS);
  const sweepTimer = setInterval(sweep, SWEEP_MS);
  pingTimer.unref();
  sweepTimer.unref();
  server.on('close', () => {
    clearInterval(pingTimer);
    clearInterval(sweepTimer);
  });
  server.sweep = sweep;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const port = Number(process.env.LIVE_PORT || 18306);
  const metadata = process.env.LIVE_METADATA ? JSON.parse(readFileSync(process.env.LIVE_METADATA, 'utf8')) : {};
  if (process.env.LIVE_METADATA && !/^[a-f0-9]{64}$/.test(metadata.runtime_version || '')) throw new Error('Invalid runtime metadata');
  createLiveServer({ runtimeVersion: metadata.runtime_version }).listen(port, '127.0.0.1', () => console.log(`live server on 127.0.0.1:${port}`));
}
