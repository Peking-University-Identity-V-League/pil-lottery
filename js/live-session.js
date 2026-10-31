import { withRequestTimeout } from './request-timeout.js';
const PREFIX = 'pil-lottery:live-session:';

// Keep an exit receipt separately from the active session. Late responses from
// another tab may clear only the exact credential that the server revoked.
export function createPlayerSessions({ storage, request = (...args) => fetch(...args), requestTimeoutMs = 10000 } = {}) {
  const inFlight = new Map();
  const volatile = new Map();
  const key = room => PREFIX + room;
  const pendingKey = room => key(room) + ':pending-leave';
  const backing = () => storage ?? globalThis.localStorage;
  function read(name) {
    if (volatile.has(name)) return volatile.get(name);
    try { return JSON.parse(backing().getItem(name)); } catch { return null; }
  }
  function write(name, value) {
    volatile.set(name, value);
    try {
      if (value) backing().setItem(name, JSON.stringify(value));
      else backing().removeItem(name);
      volatile.delete(name);
    } catch { /* Storage may be unavailable in privacy mode. */ }
  }
  function forget(room, session) {
    if (!session) return;
    if (read(key(room))?.session === session) write(key(room), null);
    if (read(pendingKey(room))?.session === session) write(pendingKey(room), null);
  }
  return {
    load: room => read(key(room)),
    save: (room, value) => write(key(room), value),
    pending: room => read(pendingKey(room)),
    beginLeave(room, session, view) {
      if (!session) return;
      const pending = { session, view };
      write(pendingKey(room), pending);
      return pending;
    },
    forget,
    isLeaving: room => [...inFlight.keys()].some(key => key.startsWith(room + ':')),
    release(room, session) {
      const requestKey = room + ':' + session;
      if (inFlight.has(requestKey)) return inFlight.get(requestKey);
      const task = withRequestTimeout(requestTimeoutMs, async signal => {
        const res = await request('/lottery/live-api/rooms/' + room + '/leave', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session }), keepalive: true,
          signal,
        });
        // A missing route/proxy 404 is not confirmation that the room is gone.
        const gone = res.status === 404 && (await res.json().catch(() => ({}))).error === 'room-not-found';
        if (!res.ok && !gone) throw new Error('Exit not confirmed: HTTP ' + res.status);
        forget(room, session);
      }).finally(() => inFlight.delete(requestKey));
      inFlight.set(requestKey, task);
      return task;
    },
  };
}
