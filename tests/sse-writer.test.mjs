import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createSseWriter } from '../server/sse-writer.mjs';

class Response extends EventEmitter {
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  blocked = true;
  frames = [];
  write(frame) { this.frames.push(frame); return !this.blocked; }
  end(frame) { this.frames.push(frame); this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}
test('a blocked viewer retains only the latest state and drops heartbeats', () => {
  const res = new Response();
  const writer = createSseWriter(res);
  writer.send('state', { seq: 1 });
  for (let seq = 2; seq <= 1000; seq++) { writer.send('state', { seq }); writer.send('ping', {}); }
  assert.equal(res.frames.length, 1);
  res.blocked = false;
  res.emit('drain');
  assert.equal(res.frames.length, 2);
  assert.match(res.frames[1], /"seq":1000/);
  writer.close();
});
test('slow and oversized viewers are disconnected within a bound', async () => {
  const res = new Response();
  const writer = createSseWriter(res, { slowClientTimeoutMs: 10 });
  writer.send('state', {});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(res.destroyed, true);
  const oversized = new Response();
  createSseWriter(oversized, { maxBufferedBytes: 100 }).send('state', { data: 'x'.repeat(200) });
  assert.equal(oversized.destroyed, true);
  assert.equal(oversized.frames.length, 0);
});
test('token revocation immediately disconnects a blocked viewer', () => {
  const res = new Response();
  const writer = createSseWriter(res);
  writer.send('state', {});
  writer.send('state', { private: 'pending' });
  writer.close();
  assert.equal(res.destroyed, true);
  assert.equal(res.frames.length, 1);
});
