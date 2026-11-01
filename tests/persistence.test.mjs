import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createLiveServer } from '../server/live-server.mjs';
import { openRoomStore } from '../server/room-store.mjs';
import { openRoomStore as openV1Store } from './fixtures/room-store-v1.mjs';
import { ALL_HIDDEN } from '../js/live-visibility.js';

const state = {
  round: 7, phase: 'done',
  slots: Array.from({ length: 5 }, (_, i) => ({
    char: 'c' + i, build: { levels: { skill: 1 }, ultimates: [], used: 1 },
    ...(i === 4 ? { trait: { name: 'trait' } } : {}),
  })),
};
async function start(options = {}) {
  const server = createLiveServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/lottery/live-api/rooms';
  return { server, base, stop: () => server.shutdown() };
}
const create = async base => {
  const res = await fetch(base, { method: 'POST' });
  assert.equal(res.status, 201);
  return res.json();
};
const host = (base, room, method, path, body) => fetch(base + '/' + room.roomId + path, {
  method, headers: { Authorization: 'Bearer ' + room.hostToken, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});
const joinAs = async (base, room, view, password) => {
  const res = await fetch(base + '/' + room.roomId + '/join', { method: 'POST', body: JSON.stringify({ view, password }) });
  assert.equal(res.status, 200);
  return (await res.json()).session;
};
async function firstState(base, room, session) {
  const res = await fetch(base + '/' + room.roomId + '/events?session=' + session, { signal: AbortSignal.timeout(3000) });
  assert.equal(res.status, 200);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  try {
    for (;;) {
      text += (await reader.read()).value;
      const match = /event: state\ndata: (.*)\n\n/.exec(text);
      if (match) return JSON.parse(match[1]);
    }
  } finally { await reader.cancel(); }
}

test('SQLite restores state, permissions, passwords, seats and sequence numbers; deletion survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pil-room-db-'));
  const dbPath = join(dir, 'rooms.sqlite');
  let instance;
  try {
    instance = await start({ dbPath });
    const room = await create(instance.base);
    assert.equal((await host(instance.base, room, 'PUT', '/state', { seq: 50, state })).status, 200);
    assert.equal((await host(instance.base, room, 'PUT', '/visibility', { visibility: ALL_HIDDEN })).status, 200);
    assert.equal((await host(instance.base, room, 'PUT', '/access', { view: 'spectator', password: 'watch', limit: 1 })).status, 200);
    const survivorSession = await joinAs(instance.base, room, 'survivor');
    const spectatorSession = await joinAs(instance.base, room, 'spectator', 'watch');
    await instance.stop();
    instance = await start({ dbPath });
    const restored = await (await host(instance.base, room, 'GET', '/status')).json();
    assert.deepEqual(restored.visibility, ALL_HIDDEN);
    assert.equal(restored.access.spectator.password, true);
    assert.equal(restored.access.spectator.limit, 1);
    // 重启后名额仍保留，密码仍要校验，明文不落库
    assert.equal(restored.access.spectator.taken, 1);
    const denied = await fetch(instance.base + '/' + room.roomId + '/join', { method: 'POST', body: JSON.stringify({ view: 'spectator', password: 'watch' }) });
    assert.equal(denied.status, 409);
    const wrong = await fetch(instance.base + '/' + room.roomId + '/join', { method: 'POST', body: JSON.stringify({ view: 'spectator', password: 'nope' }) });
    assert.equal(wrong.status, 403);
    assert.equal((await fetch(instance.base + '/' + room.roomId + '/check?session=bad')).status, 403);
    const view = await firstState(instance.base, room, survivorSession);
    assert.equal(view.round, 7);
    assert.deepEqual(view.slots[4].char, { status: 'hidden' });
    assert.deepEqual(view.slots[4].trait, { status: 'hidden' });
    const stale = await host(instance.base, room, 'PUT', '/state', { seq: 49, state: { round: 0, phase: 'idle', slots: [] } });
    assert.equal((await stale.json()).stale, true);
    assert.equal((await firstState(instance.base, room, spectatorSession)).round, 7);
    assert.equal((await host(instance.base, room, 'DELETE', '')).status, 200);
    await instance.stop();
    instance = await start({ dbPath });
    assert.equal((await fetch(instance.base + '/' + room.roomId + '/check?session=' + survivorSession)).status, 404);
    assert.equal((await stat(dbPath)).mode & 0o777, 0o600);
    await instance.stop(); instance = null;
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('SELECT count(*) AS count FROM rooms_v2').get().count, 0);
    db.close();
  } finally { if (instance) await instance.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('passwords and player credentials are never stored in plain text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pil-room-secret-'));
  const dbPath = join(dir, 'rooms.sqlite');
  let instance;
  try {
    instance = await start({ dbPath });
    const room = await create(instance.base);
    await host(instance.base, room, 'PUT', '/access', { view: 'hunter', password: 'plain-text-pass' });
    const session = await joinAs(instance.base, room, 'hunter', 'plain-text-pass');
    await instance.stop(); instance = null;
    const db = new DatabaseSync(dbPath);
    const row = JSON.stringify(db.prepare('SELECT access, seats FROM rooms_v2').get());
    db.close();
    assert.ok(!row.includes('plain-text-pass'));
    assert.ok(!row.includes(session));
  } finally { if (instance) await instance.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('v1 records survive upgrade, old-code rollback writes, and a second upgrade', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pil-room-migrate-'));
  const dbPath = join(dir, 'rooms.sqlite');
  const legacy = { id: 'old-room', hostToken: 'legacy-host', tokens: { hunter: 'h', survivor: 's', spectator: 'v' },
    state, visibility: ALL_HIDDEN, seq: 7, touchedAt: Date.now() };
  let instance;
  try {
    const before = openV1Store(dbPath); before.put(legacy); before.close();
    instance = await start({ dbPath });
    assert.equal((await fetch(instance.base + '/old-room/info')).status, 404);
    const room = await create(instance.base);
    await host(instance.base, room, 'PUT', '/state', { seq: 50, state });
    await instance.stop(); instance = null;
    // The exact deployed adapter must open and still update its original table.
    const rollback = openV1Store(dbPath);
    assert.deepEqual(rollback.load(0), [legacy]);
    const changed = { ...legacy, seq: 8 };
    rollback.put(changed);
    assert.deepEqual(rollback.load(0), [changed]);
    rollback.close();
    instance = await start({ dbPath });
    assert.equal((await firstState(instance.base, room, await joinAs(instance.base, room, 'spectator'))).round, 7);
    await instance.stop(); instance = null;
    const again = openV1Store(dbPath);
    assert.deepEqual(again.load(0), [changed]); again.close();
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); db.close();
  } finally { if (instance) await instance.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('the unreleased v2 preview is migrated without losing room data or renewing unknown seat leases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pil-preview-migrate-'));
  const dbPath = join(dir, 'rooms.sqlite');
  let instance;
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE rooms (id TEXT PRIMARY KEY, host_token TEXT NOT NULL, access TEXT NOT NULL, seats TEXT NOT NULL,
      state TEXT NOT NULL, visibility TEXT NOT NULL, seq INTEGER NOT NULL, touched_at INTEGER NOT NULL) STRICT;
      CREATE INDEX rooms_expiry ON rooms(touched_at); PRAGMA user_version = 2;`);
    const access = Object.fromEntries(['hunter', 'survivor', 'spectator'].map(view => [view, { passwordHash: null, limit: 1 }]));
    db.prepare('INSERT INTO rooms VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('123456', 'host', JSON.stringify(access),
      JSON.stringify({ historical: 'hunter' }), JSON.stringify(state), JSON.stringify(ALL_HIDDEN), 10, Date.now()); db.close();
    instance = await start({ dbPath });
    const room = { roomId: '123456', hostToken: 'host' };
    const status = await (await host(instance.base, room, 'GET', '/status')).json();
    assert.equal(status.access.hunter.taken, 0);
    assert.equal((await firstState(instance.base, room, await joinAs(instance.base, room, 'spectator'))).round, 7);
    await instance.stop(); instance = null;
    const rollback = openV1Store(dbPath); assert.deepEqual(rollback.load(0), []); rollback.close();
  } finally { if (instance) await instance.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('expired rooms are removed on restart and cannot reappear', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pil-room-expiry-'));
  const dbPath = join(dir, 'rooms.sqlite');
  let time = 10000, instance;
  try {
    instance = await start({ dbPath, now: () => time, ttlMs: 1000 });
    const room = await create(instance.base);
    await instance.stop();
    time += 1001;
    instance = await start({ dbPath, now: () => time, ttlMs: 1000 });
    assert.equal((await host(instance.base, room, 'GET', '/status')).status, 404);
    await instance.stop(); instance = null;
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare('SELECT count(*) AS count FROM rooms_v2').get().count, 0); db.close();
  } finally { if (instance) await instance.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('failed database writes do not publish or mutate authoritative room state', async () => {
  const real = openRoomStore();
  let failing = false;
  const roomStore = {
    ...real,
    put(room) { if (failing) throw new Error('simulated disk failure'); real.put(room); },
    remove(id) { if (failing) throw new Error('simulated disk failure'); real.remove(id); },
  };
  const instance = await start({ roomStore });
  try {
    const room = await create(instance.base);
    failing = true;
    for (const [method, path, body] of [
      ['PUT', '/state', { seq: 1, state }], ['PUT', '/visibility', { visibility: ALL_HIDDEN }],
      ['PUT', '/access', { view: 'hunter', limit: 2 }], ['POST', '/reset', {}], ['DELETE', '', undefined],
    ]) assert.equal((await host(instance.base, room, method, path, body)).status, 500);
    const saved = await (await host(instance.base, room, 'GET', '/status')).json();
    assert.deepEqual(saved.visibility, room.visibility);
    assert.equal(saved.access.hunter.limit, 1);
    failing = false;
    assert.equal((await firstState(instance.base, room, await joinAs(instance.base, room, 'spectator'))).phase, 'idle');
    assert.equal((await host(instance.base, room, 'PUT', '/state', { seq: 1, state })).status, 200);
  } finally { await instance.stop(); }
});

test('committed room data survives an abrupt process kill and WAL recovery', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pil-room-crash-'));
  const dbPath = join(dir, 'rooms.sqlite');
  const source = new URL('../server/live-server.mjs', import.meta.url).href;
  const code = "import {createLiveServer} from " + JSON.stringify(source) + "; const s=createLiveServer({dbPath:process.env.TEST_DB,pingIntervalMs:50}); s.listen(0,'127.0.0.1',()=>console.log(s.address().port));";
  let child, instance;
  try {
    child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TEST_DB: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    const [port] = await once(lines, 'line');
    const base = 'http://127.0.0.1:' + port + '/lottery/live-api/rooms';
    const room = await create(base);
    assert.equal((await host(base, room, 'PUT', '/state', { seq: 8, state })).status, 200);
    await host(base, room, 'PUT', '/access', { view: 'hunter', limit: 1 });
    const staleSession = await joinAs(base, room, 'hunter');
    await fetch(base + '/' + room.roomId + '/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: staleSession }) });
    const currentSession = await joinAs(base, room, 'hunter');
    const stream = await fetch(base + '/' + room.roomId + '/events?session=' + currentSession);
    assert.equal(stream.status, 200);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; child = null; lines.close();
    await stream.body.cancel().catch(() => {});
    instance = await start({ dbPath });
    assert.equal((await firstState(instance.base, room, await joinAs(instance.base, room, 'spectator'))).round, 7);
    assert.equal((await fetch(instance.base + '/' + room.roomId + '/check?session=' + staleSession)).status, 403);
    assert.equal((await fetch(instance.base + '/' + room.roomId + '/check?session=' + currentSession)).status, 200);
  } finally {
    if (child) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    if (instance) await instance.stop();
    await rm(dir, { recursive: true, force: true });
  }
});


// Start handling a request, then hold back its JSON body while another request commits.
async function pausedRequest(instance, room, method, path, body) {
  const data = JSON.stringify(body);
  const arrived = once(instance.server, 'request');
  let finish;
  const response = new Promise((resolve, reject) => {
    const req = request(instance.base + '/' + room.roomId + path, {
      method, headers: { Authorization: 'Bearer ' + room.hostToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write(data.slice(0, 1));
    finish = () => req.end(data.slice(1));
  });
  await arrived;
  return { finish: () => { finish(); return response; } };
}

test('late join, settings, clear and reset bodies cannot resurrect a deleted room', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pil-late-room-'));
  const dbPath = join(dir, 'rooms.sqlite');
  let instance;
  try {
    instance = await start({ dbPath });
    const room = await create(instance.base);
    const delayed = [];
    for (const [method, path, body] of [
      ['POST', '/join', { view: 'hunter' }], ['POST', '/seats/clear', { view: 'hunter' }],
      ['POST', '/reset', { clearPasswords: true }], ['PUT', '/access', { view: 'hunter', password: 'late' }],
      ['PUT', '/state', { seq: 99, state }], ['PUT', '/visibility', { visibility: ALL_HIDDEN }],
    ]) delayed.push(await pausedRequest(instance, room, method, path, body));
    assert.equal((await host(instance.base, room, 'DELETE', '')).status, 200);
    for (const pending of delayed) assert.equal(await pending.finish(), 404);
    await instance.stop();
    instance = await start({ dbPath });
    assert.equal((await host(instance.base, room, 'GET', '/status')).status, 404);
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare('SELECT count(*) AS count FROM rooms_v2').get().count, 0); db.close();
  } finally { if (instance) await instance.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('pre-reset requests cannot enter or restore credentials into the next match', { timeout: 10000 }, async () => {
  const instance = await start();
  try {
    const room = await create(instance.base);
    const joining = await pausedRequest(instance, room, 'POST', '/join', { view: 'hunter' });
    const changing = await pausedRequest(instance, room, 'PUT', '/access', { view: 'hunter', password: 'stale' });
    assert.equal((await host(instance.base, room, 'POST', '/reset', { clearPasswords: true })).status, 200);
    assert.equal(await joining.finish(), 409);
    assert.equal(await changing.finish(), 409);
    const status = await (await host(instance.base, room, 'GET', '/status')).json();
    assert.equal(status.access.hunter.password, false);
    assert.equal(status.access.hunter.taken, 0);
  } finally { await instance.stop(); }
});

test('storage update never inserts a removed room', () => {
  const store = openRoomStore();
  try {
    const room = { id: '123456', hostToken: 'h', access: {}, seats: {}, state, visibility: ALL_HIDDEN, seq: 1, touchedAt: Date.now() };
    assert.throws(() => store.put(room), /no longer exists/);
    store.create(room); store.remove(room.id);
    assert.throws(() => store.put(room), /no longer exists/);
    assert.deepEqual(store.load(0), []);
  } finally { store.close(); }
});

test('offline reservations survive hours and restarts until an explicit exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pil-permanent-seat-')), dbPath = join(dir, 'rooms.sqlite');
  let time = 1_000_000, instance;
  const options = { dbPath, now: () => time };
  try {
    instance = await start(options);const room = await create(instance.base);
    const a = await joinAs(instance.base, room, 'hunter');
    await instance.stop();time += 2 * 60 * 60 * 1000;instance = await start(options);
    const check = session => fetch(instance.base + '/' + room.roomId + '/check?session=' + session);
    assert.equal((await check(a)).status, 200);
    assert.equal((await fetch(instance.base + '/' + room.roomId + '/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ view: 'hunter' }) })).status, 409);
    assert.equal((await (await host(instance.base, room, 'GET', '/status')).json()).access.hunter.taken, 1);
    const stream = await fetch(instance.base + '/' + room.roomId + '/events?session=' + a);assert.equal(stream.status, 200);await stream.body.cancel();
    await fetch(instance.base + '/' + room.roomId + '/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: a }) });
    const b = await joinAs(instance.base, room, 'hunter');await instance.stop();time += 3600000;instance = await start(options);
    assert.equal((await check(a)).status, 403);assert.equal((await check(b)).status, 200);
  } finally { if (instance) await instance.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('online heartbeats do not rewrite reservations or extend room lifetime', async () => {
  const real = openRoomStore();let time = 1_000_000, writes = 0;
  const roomStore = { ...real, putSeats(id, seats) { writes++;real.putSeats(id, seats); }, renewSeats() { throw new Error('No lease renewal expected'); } };
  const instance = await start({ roomStore, now: () => time, pingIntervalMs: 100000 });
  try {
    const room = await create(instance.base), session = await joinAs(instance.base, room, 'hunter');
    const stream = await fetch(instance.base + '/' + room.roomId + '/events?session=' + session);
    const before = writes;time += 3600000;await instance.server.heartbeat();
    assert.equal(writes, before);assert.equal(real.load(0)[0].touchedAt, 1_000_000);
    assert.equal(Object.values(real.load(0)[0].seats)[0].expiresAt, Number.MAX_SAFE_INTEGER);
    await stream.body.cancel();
  } finally { await instance.stop(); }
});

test('legacy active reservations become permanent without reviving already expired seats', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pil-seat-upgrade-')), dbPath = join(dir, 'rooms.sqlite');
  let time = 1_000_000, instance;
  try {
    instance = await start({ dbPath, now: () => time });const room = await create(instance.base);
    const active = await joinAs(instance.base, room, 'hunter'), expired = await joinAs(instance.base, room, 'spectator');await instance.stop();instance = null;
    const db = new DatabaseSync(dbPath);const row = db.prepare('SELECT seats FROM rooms_v2 WHERE id=?').get(room.roomId);const seats = JSON.parse(row.seats);
    for (const seat of Object.values(seats)) seat.expiresAt = seat.view === 'hunter' ? time + 120000 : time - 1;
    db.prepare('UPDATE rooms_v2 SET seats=? WHERE id=?').run(JSON.stringify(seats), room.roomId);db.close();
    instance = await start({ dbPath, now: () => time });assert.equal((await fetch(instance.base + '/' + room.roomId + '/check?session=' + expired)).status, 403);
    await instance.stop();time += 3600000;instance = await start({ dbPath, now: () => time });
    assert.equal((await fetch(instance.base + '/' + room.roomId + '/check?session=' + active)).status, 200);
    assert.equal((await (await host(instance.base, room, 'GET', '/status')).json()).access.hunter.taken, 1);
  } finally { if (instance) await instance.stop();await rm(dir, { recursive: true, force: true }); }
});
