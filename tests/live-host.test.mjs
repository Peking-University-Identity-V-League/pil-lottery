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
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/rooms')) return response({ roomId: 'test-room', hostToken: 'test-host', tokens: {}, visibility: initial });
    if (url.endsWith('/state')) { states.push(JSON.parse(options.body)); return response({ viewers: {} }); }
    if (url.endsWith('/status')) return new Promise(resolve => polls.push(body => resolve(response(body))));
    if (url.endsWith('/visibility')) return new Promise(resolve => {
      writes.push({ visibility: JSON.parse(options.body).visibility, finish: status => resolve(response({ visibility: JSON.parse(options.body).visibility }, status)) });
    });
    throw new Error('Unexpected test request');
  });
  return { live: createLiveHost(), initial, writes, polls, states };
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
  const retry = live.setVisibility({ ...live.room.visibility, hunterSeesChar: 'hide' });
  await tick();
  writes[1].finish(200);
  await retry;
  assert.equal(live.room.visibility.hunterSeesChar, 'hide');
});
