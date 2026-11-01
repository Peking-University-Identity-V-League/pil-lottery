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
  const resets = [];
  const control = { deleteStatus: 200 };
  let created = 0;
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/rooms')) return response({ roomId: 'test-room-' + (++created), hostToken: 'test-host', access: { survivor: { password: false, limit: null, taken: 0 } }, visibility: initial });
    if (url.endsWith('/state')) { states.push(JSON.parse(options.body)); return response({ viewers: {} }); }
    if (url.endsWith('/status')) return new Promise(resolve => polls.push((body, status = 200) => resolve(response(body, status))));
    if (url.endsWith('/access')) return new Promise(resolve => rotations.push(body => resolve(response(body))));
    if (url.endsWith('/reset')) { resets.push(JSON.parse(options.body)); return response({ access: { survivor: { password: false, limit: 4, taken: 0 } } }); }
    if (options.method === 'DELETE') return response({}, control.deleteStatus);
    if (url.endsWith('/visibility')) return new Promise(resolve => {
      writes.push({ visibility: JSON.parse(options.body).visibility, finish: status => resolve(response({ visibility: JSON.parse(options.body).visibility }, status)) });
    });
    throw new Error('Unexpected test request');
  });
  return { live: createLiveHost(), initial, writes, polls, states, rotations, resets, control };
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
  polls[0]({ visibility: initial, viewers: {} });
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

test('a stale status response cannot undo a newer access change', async t => {
  const { live, polls, rotations } = setup(t);
  await live.create();
  const polling = live.status();
  const saving = live.setAccess('survivor', { password: 'new-pass', limit: 4 });
  await tick();
  rotations[0]({ access: { survivor: { password: true, limit: 4, taken: 0 } } });
  await saving;
  polls[0]({ visibility: live.room.visibility, access: { survivor: { password: false, limit: null, taken: 0 } } });
  await polling;
  assert.equal(live.room.access.survivor.limit, 4);
  assert.equal(live.room.passwords.survivor, 'new-pass');
});

test('reset drops unsent state and moves the sequence forward so old results cannot return', async t => {
  const { live, states, resets, writes } = setup(t);
  await live.create();
  const saving = live.setVisibility({ ...live.room.visibility, hunterSeesChar: 'hide' });
  await tick();
  live.push({ phase: 'done', old: true }); // 可见范围保存中，状态排队
  assert.equal(states.length, 0);
  await live.reset({ clearPasswords: true });
  writes[0].finish(200);
  await saving;
  await tick();
  assert.equal(states.length, 0);
  assert.equal(resets[0].clearPasswords, true);
  assert.ok(resets[0].seq > 0);
  live.push({ phase: 'drawing' });
  await tick();
  assert.equal(states.length, 1);
  assert.ok(states[0].seq > resets[0].seq);
});

test('a host room saved before room numbers is not restored', t => {
  const { live } = setup(t);
  assert.equal(live.room, null);
  localStorage.setItem('pil-lottery:live', JSON.stringify({ roomId: 'old', hostToken: 'h', tokens: {}, visibility: {} }));
  assert.equal(createLiveHost().room, null);
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
  polls[0]({ visibility: { hunterSeesChar: 'hide' }, access: { survivor: { password: true, limit: 9, taken: 0 } } });
  assert.equal(await polling, 'room-changed');
  assert.equal(live.room.access.survivor.limit, null);
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


test('poll started during access save cannot overwrite the completed password and limit', async t => {
  const { live, polls, rotations } = setup(t);
  await live.create();
  const saving = live.setAccess('survivor', { password: 'new-pass', limit: 1 });
  await tick();
  const polling = live.status();
  rotations[0]({ access: { survivor: { password: true, limit: 1, taken: 0 } } });
  await saving;
  polls[0]({ visibility: live.room.visibility, access: { survivor: { password: false, limit: null, taken: 0 } } });
  await polling;
  assert.equal(live.room.access.survivor.password, true);
  assert.equal(live.room.access.survivor.limit, 1);
  assert.equal(live.room.passwords.survivor, 'new-pass');
  assert.equal(JSON.parse(localStorage.getItem('pil-lottery:live')).passwords.survivor, 'new-pass');
});

test('poll started during reset cannot restore the pre-reset access summary', async t => {
  const { live, polls } = setup(t);
  await live.create();
  const resetting = live.reset({ clearPasswords: true });
  const polling = live.status();
  await resetting;
  polls[0]({ visibility: live.room.visibility, access: { survivor: { password: true, limit: null, taken: 4 } } });
  await polling;
  assert.equal(live.room.access.survivor.password, false);
  assert.equal(live.room.access.survivor.taken, 0);
});


test('older Safari can create, configure, poll and close rooms without AbortSignal.timeout', async t => {
  const original=Object.getOwnPropertyDescriptor(AbortSignal,'timeout');
  Object.defineProperty(AbortSignal,'timeout',{configurable:true,value:undefined});
  t.after(()=>Object.defineProperty(AbortSignal,'timeout',original));
  const {live,writes,rotations,polls}=setup(t);
  await live.create();assert.ok(live.room.roomId);
  const visibility={...live.room.visibility,hunterSeesChar:'hide'};
  const saving=live.setVisibility(visibility);await tick();writes[0].finish(200);await saving;
  const access={survivor:{password:true,limit:4,taken:0}};
  const changing=live.setAccess('survivor',{password:'pw',limit:4});await tick();rotations[0]({access});await changing;
  const polling=live.status();polls[0]({visibility,access,viewers:{}});await polling;
  assert.equal(live.room.access.survivor.password,true);await live.close();assert.equal(live.room,null);
});

test('the request deadline includes a response body that stalls after successful headers', async t => {
  setup(t);
  t.mock.method(globalThis,'fetch',async(_url,{signal})=>({status:201,ok:true,
    json:()=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})),
  }));
  const live=createLiveHost({requestTimeoutMs:10});
  await assert.rejects(live.create(),error=>error.name==='TimeoutError');assert.equal(live.room,null);
});


test('initialization waits for acknowledgement and discards an older queued result', async t => {
  const { live, writes } = setup(t);await live.create();
  const visibility = live.setVisibility({ ...live.room.visibility, hunterSeesChar: 'hide' });await tick();
  live.push({ round: 99, phase: 'done', slots: [] });
  const original = globalThis.fetch, sent = [];let acknowledge;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (url.endsWith('/state')) { sent.push(JSON.parse(options.body));return new Promise(resolve => { acknowledge = () => resolve({ ok: true, status: 200, json: async () => ({}) }); }); }
    return original(url, options);
  });
  let confirmed = false;const pending = live.initialize().then(() => { confirmed = true; });await tick();
  assert.equal(confirmed, false);assert.equal(sent.length, 1);assert.deepEqual(sent[0].state, { round: 0, phase: 'idle', slots: [] });
  acknowledge();await pending;assert.equal(confirmed, true);
  writes[0].finish(200);await visibility;await tick();assert.equal(sent.length, 1);
});

test('initialization rejects failures and stale acknowledgements, then permits retry', async t => {
  const { live } = setup(t);await live.create();const original = globalThis.fetch;let attempt = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!url.endsWith('/state')) return original(url, options);
    attempt++;return { ok: attempt !== 1, status: attempt === 1 ? 503 : 200, json: async () => attempt === 2 ? { stale: true } : {} };
  });
  await assert.rejects(live.initialize(), /HTTP 503/);
  await assert.rejects(live.initialize(), /state-changed/);
  await live.initialize();assert.equal(attempt, 3);
});
