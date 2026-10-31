import assert from 'node:assert/strict';
import test from 'node:test';
import { reconnectDelay, retryAfterMs } from '../js/live-retry.js';

test('reconnects use increasing jitter, a thirty-second cap, and server retry hints', () => {
  assert.equal(reconnectDelay(0, () => 0), 500);
  assert.equal(reconnectDelay(0, () => 1), 1000);
  assert.equal(reconnectDelay(3, () => 0), 4000);
  assert.equal(reconnectDelay(100, () => 0), 15000);
  assert.equal(reconnectDelay(100, () => 1), 30000);
  assert.equal(reconnectDelay(0, () => 0, 5000), 5000);
});

test('Retry-After supports seconds and HTTP dates without unbounded or invalid waits', () => {
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000), 4000);
  assert.equal(retryAfterMs('invalid'), 0);
  assert.equal(retryAfterMs('-10'), 0);
  assert.equal(retryAfterMs('10000000'), 600000);
});
