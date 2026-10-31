import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { createLiveServer } from '../server/live-server.mjs';
import { openRoomStore } from '../server/room-store.mjs';
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
  return { server, base, stop: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
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
async function firstState(base, room, token) {
  const res = await fetch(base + '/' + room.roomId + '/events?token=' + token, { signal: AbortSignal.timeout(3000) });
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

test('SQLite restores state, permissions, rotated tokens and sequence numbers; deletion survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pil-room-db-'));
  const dbPath = join(dir, 'rooms.sqlite');
  let instance;
  try {
    instance = await start({ dbPath });
    const room = await create(instance.base);
    assert.equal((await host(instance.base, room, 'PUT', '/state', { seq: 50, state })).status, 200);
    assert.equal((await host(instance.base, room, 'PUT', '/visibility', { visibility: ALL_HIDDEN })).status, 200);
    const tokens = (await (await host(instance.base, room, 'POST', '/rotate')).json()).tokens;
    await instance.stop();
    instance = await start({ dbPath });
    const restored = await (await host(instance.base, room, 'GET', '/status')).json();
    assert.deepEqual(restored.visibility, ALL_HIDDEN);
    assert.deepEqual(restored.tokens, tokens);
    assert.equal((await fetch(instance.base + '/' + room.roomId + '/check?token=' + room.tokens.survivor)).status, 403);
    const view = await firstState(instance.base, room, tokens.survivor);
    assert.equal(view.round, 7);
    assert.deepEqual(view.slots[4].char, { status: 'hidden' });
    assert.deepEqual(view.slots[4].trait, { status: 'hidden' });
    const stale = await host(instance.base, room, 'PUT', '/state', { seq: 49, state: { round: 0, phase: 'idle', slots: [] } });
    assert.equal((await stale.json()).stale, true);
    assert.equal((await firstState(instance.base, room, tokens.spectator)).round, 7);
    assert.equal((await host(instance.base, room, 'DELETE', '')).status, 200);
    await instance.stop();
    instance = await start({ dbPath });
    assert.equal((await fetch(instance.base + '/' + room.roomId + '/check?token=' + tokens.survivor)).status, 404);
    assert.equal((await stat(dbPath)).mode & 0o777, 0o600);
    await instance.stop(); instance = null;
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('SELECT count(*) AS count FROM rooms').get().count, 0);
    db.close();
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
    assert.equal(db.prepare('SELECT count(*) AS count FROM rooms').get().count, 0); db.close();
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
      ['POST', '/rotate', undefined], ['DELETE', '', undefined],
    ]) assert.equal((await host(instance.base, room, method, path, body)).status, 500);
    const saved = await (await host(instance.base, room, 'GET', '/status')).json();
    assert.deepEqual(saved.visibility, room.visibility);
    assert.deepEqual(saved.tokens, room.tokens);
    assert.equal((await firstState(instance.base, room, room.tokens.spectator)).phase, 'idle');
    failing = false;
    assert.equal((await host(instance.base, room, 'PUT', '/state', { seq: 1, state })).status, 200);
  } finally { await instance.stop(); }
});

test('committed room data survives an abrupt process kill and WAL recovery', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pil-room-crash-'));
  const dbPath = join(dir, 'rooms.sqlite');
  const source = new URL('../server/live-server.mjs', import.meta.url).href;
  const code = "import {createLiveServer} from " + JSON.stringify(source) + "; const s=createLiveServer({dbPath:process.env.TEST_DB}); s.listen(0,'127.0.0.1',()=>console.log(s.address().port));";
  let child, instance;
  try {
    child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TEST_DB: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    const [port] = await once(lines, 'line');
    const base = 'http://127.0.0.1:' + port + '/lottery/live-api/rooms';
    const room = await create(base);
    assert.equal((await host(base, room, 'PUT', '/state', { seq: 8, state })).status, 200);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; child = null; lines.close();
    instance = await start({ dbPath });
    assert.equal((await firstState(instance.base, room, room.tokens.spectator)).round, 7);
  } finally {
    if (child) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    if (instance) await instance.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
