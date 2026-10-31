import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveHost } from '../js/live-host.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(t) {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  } });
  t.after(() => {
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else delete globalThis.localStorage;
  });
  const initial = { hunterSeesChar: 'show', survivorSeesChar: 'show' };
  const writes = [];
  const polls = [];
  const states = [];
  const rotations = [];
  const control = { deleteStatus: 200 };
  let created = 0;
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/rooms')) return response({ roomId: 'test-room-' + (++created), hostToken: 'test-host', tokens: { survivor: 'old-token' }, visibility: initial });
    if (url.endsWith('/state')) { states.push(JSON.parse(options.body)); return response({ viewers: {} }); }
    if (url.endsWith('/status')) return new Promise(resolve => polls.push((body, status = 200) => resolve(response(body, status))));
    if (url.endsWith('/rotate')) return new Promise(resolve => rotations.push(body => resolve(response(body))));
    if (options.method === 'DELETE') return response({}, control.deleteStatus);
    if (url.endsWith('/visibility')) return new Promise(resolve => {
      writes.push({ visibility: JSON.parse(options.body).visibility, finish: status => resolve(response({ visibility: JSON.parse(options.body).visibility }, status)) });
    });
    throw new Error('Unexpected test request');
  });
  return { live: createLiveHost(), initial, writes, polls, states, rotations, control };
}

test('rapid visibility changes are serialized and stale status responses cannot undo them', async t => {
  const { live, initial, writes, polls, states } = setup(t);
  await live.create();
  const oldPoll = live.status();
  const first = live.setVisibility({ ...live.room.visibility, hunterSeesChar: 'hide' });
  const second = live.setVisibility({ ...live.room.visibility, survivorSeesChar: 'hide' });
  assert.deepEqual(live.room.visibility, { hunterSeesChar: 'hide', survivorSeesChar: 'hide' });
  await tick();
  assert.equal(writes.length, 1);
  live.push({ phase: 'drawing' });
  assert.equal(states.length, 0);
  writes[0].finish(200);
  await first;
  await tick();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].visibility, { hunterSeesChar: 'hide', survivorSeesChar: 'hide' });
  assert.deepEqual(live.room.visibility, writes[1].visibility);
  writes[1].finish(200);
  await second;
  await tick();
  assert.equal(states.length, 1);
  polls[0]({ visibility: initial, tokens: {}, viewers: {} });
  await oldPoll;
  assert.deepEqual(live.room.visibility, { hunterSeesChar: 'hide', survivorSeesChar: 'hide' });
});

test('failed visibility saves restore the last confirmed settings and allow retry', async t => {
  const { live, initial, writes } = setup(t);
  await live.create();
  const failed = live.setVisibility({ ...initial, hunterSeesChar: 'hide' });
  await tick();
  writes[0].finish(503);
  await assert.rejects(failed, /HTTP 503/);
  assert.deepEqual(live.room.visibility, initial);
  assert.equal(live.syncBlocked, true);
  const retry = live.setVisibility({ ...live.room.visibility, hunterSeesChar: 'hide' });
  await tick();
  writes[1].finish(200);
  await retry;
  assert.equal(live.room.visibility.hunterSeesChar, 'hide');
});

test('failed visibility save blocks queued draws until a confirmed retry, including reload', async t => {
  const { live, writes, states } = setup(t);
  await live.create();
  const hidden = { hunterSeesChar: 'hide', survivorSeesChar: 'hide' };
  const saving = live.setVisibility(hidden);
  live.push({ phase: 'done', round: 1 });
  await tick();
  writes[0].finish(503);
  await assert.rejects(saving);
  await tick();
  assert.equal(states.length, 0);
  assert.equal(live.syncBlocked, true);
  const reloaded = createLiveHost();
  reloaded.push({ phase: 'done', round: 2 });
  await tick();
  assert.equal(states.length, 0);
  assert.equal(reloaded.syncBlocked, true);
  const retry = live.setVisibility(hidden);
  await tick();
  writes[1].finish(200);
  await retry;
  await tick();
  assert.equal(states.length, 1);
  assert.equal(states[0].state.round, 1);
  assert.equal(live.syncBlocked, false);
});

test('closing errors keep credentials, pause publishing and permit retry', async t => {
  const { live, states, control } = setup(t);
  await live.create();
  const id = live.room.roomId;
  control.deleteStatus = 503;
  await assert.rejects(live.close(), /HTTP 503/);
  assert.equal(live.room.roomId, id);
  assert.equal(JSON.parse(localStorage.getItem('pil-lottery:live')).roomId, id);
  live.push({ phase: 'done' });
  await tick();
  assert.equal(states.length, 0);
  assert.equal(live.syncBlockReason, 'closing');
  assert.equal(createLiveHost().syncBlockReason, 'closing');
  control.deleteStatus = 200;
  await live.close();
  assert.equal(live.room, null);
  assert.equal(localStorage.getItem('pil-lottery:live'), null);
});

test('closing an already expired room is idempotent', async t => {
  const { live, control } = setup(t);
  await live.create();
  control.deleteStatus = 404;
  await live.close();
  assert.equal(live.room, null);
});

test('a stale status response cannot restore revoked links', async t => {
  const { live, polls, rotations } = setup(t);
  await live.create();
  const polling = live.status();
  const rotating = live.rotate();
  await tick();
  rotations[0]({ tokens: { survivor: 'new-token' } });
  await rotating;
  polls[0]({ visibility: live.room.visibility, tokens: { survivor: 'old-token' } });
  await polling;
  assert.equal(live.room.tokens.survivor, 'new-token');
});

test('an old room error cannot remove the newly created room', async t => {
  const { live, polls } = setup(t);
  await live.create();
  const polling = live.status().catch(error => error.message);
  await live.close();
  await live.create();
  const newRoom = live.room;
  polls[0]({}, 404);
  assert.equal(await polling, 'room-changed');
  assert.equal(live.room, newRoom);
});

test('a stale successful response cannot write into a replacement room', async t => {
  const { live, polls } = setup(t);
  await live.create();
  const polling = live.status().catch(error => error.message);
  await live.close();
  await live.create();
  polls[0]({ visibility: { hunterSeesChar: 'hide' }, tokens: { survivor: 'stale-token' } });
  assert.equal(await polling, 'room-changed');
  assert.equal(live.room.tokens.survivor, 'old-token');
});

test('hung requests time out instead of permanently blocking the host', async t => {
  setup(t);
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const live = createLiveHost({ requestTimeoutMs: 10 });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(live.create(), error => error.name === 'TimeoutError'); }
  finally { clearTimeout(keepAlive); }
  assert.equal(live.room, null);
});
