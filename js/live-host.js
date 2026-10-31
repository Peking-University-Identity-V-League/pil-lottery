// 裁判端同步：异步请求绑定房间，未确认的权限变更阻止结果发布。
const API = '/lottery/live-api/rooms';
const STORE_KEY = 'pil-lottery:live';
const RETRY_MS = 2000;

export function liveLink(room, view) {
  return location.origin + '/lottery/live/#' + room.roomId + '.' + room.tokens[view];
}

export function createLiveHost({ onFail = () => {}, onRecover = () => {}, onLost = () => {}, requestTimeoutMs = 10000 } = {}) {
  function session(room) {
    return {
      room, seq: 0, pending: null, sending: false, failing: false, retryTimer: 0,
      visibilityQueue: Promise.resolve(), visibilityVersion: 0, visibilityPending: 0,
      confirmedVisibility: room.visibility, blocked: Boolean(room.pendingVisibility),
      tokenQueue: Promise.resolve(), tokenVersion: 0, tokenPending: 0, closing: Boolean(room.pendingClose), closeRequest: null,
    };
  }
  let current = null;
  let creating = null;
  try {
    const room = JSON.parse(localStorage.getItem(STORE_KEY));
    if (room?.roomId && room?.hostToken && room?.tokens && room?.visibility) current = session(room);
  } catch {}
  const active = context => current === context;
  const assertActive = context => { if (!context || !active(context)) throw new Error('room-changed'); };

  function persist() {
    try {
      if (current) localStorage.setItem(STORE_KEY, JSON.stringify(current.room));
      else localStorage.removeItem(STORE_KEY);
    } catch {}
  }
  function forget(context) {
    if (!active(context)) return;
    clearTimeout(context.retryTimer);
    context.pending = null;
    current = null;
    persist();
  }
  async function request(url, options) {
    return fetch(url, { ...options, signal: AbortSignal.timeout(requestTimeoutMs) });
  }
  async function call(context, method, path, body, { missingOK = false } = {}) {
    assertActive(context);
    const res = await request(API + '/' + context.room.roomId + path, {
      method,
      headers: { Authorization: 'Bearer ' + context.room.hostToken, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    assertActive(context);
    if (missingOK && res.status === 404) return {};
    if (res.status === 404 || res.status === 403) {
      forget(context);
      onLost();
      throw new Error('room-lost');
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const result = await res.json();
    assertActive(context);
    return result;
  }

  async function flush(context) {
    if (!active(context) || context.sending || !context.pending || context.visibilityPending || context.blocked || context.closing) return;
    context.sending = true;
    const body = context.pending;
    context.pending = null;
    try {
      await call(context, 'PUT', '/state', body);
      if (context.failing) { context.failing = false; onRecover(); }
    } catch (error) {
      if (active(context) && !['room-lost', 'room-changed'].includes(error.message)) {
        if (!context.pending) context.pending = body;
        if (!context.failing) { context.failing = true; onFail(); }
        clearTimeout(context.retryTimer);
        context.retryTimer = setTimeout(() => flush(context), RETRY_MS);
      }
    } finally {
      context.sending = false;
    }
    if (active(context) && context.pending && !context.failing) flush(context);
  }

  return {
    get room() { return current?.room || null; },
    get syncBlocked() { return Boolean(current?.blocked || current?.closing); },
    get syncBlockReason() { return current?.closing ? 'closing' : current?.blocked ? 'visibility' : null; },
    create() {
      if (creating) return creating;
      if (current) return Promise.reject(new Error('room-exists'));
      creating = (async () => {
        const res = await request(API, { method: 'POST' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const room = await res.json();
        current = session(room);
        persist();
        return room;
      })().finally(() => { creating = null; });
      return creating;
    },
    push(state) {
      const context = current;
      if (!context) return;
      context.seq = Math.max(context.seq + 1, Date.now());
      context.pending = { seq: context.seq, state };
      flush(context);
    },
    setVisibility(visibility) {
      const context = current;
      if (!context) return Promise.reject(new Error('room-lost'));
      const revision = ++context.visibilityVersion;
      const snapshot = { ...visibility };
      context.room.visibility = snapshot;
      context.room.pendingVisibility = snapshot;
      context.blocked = true;
      context.visibilityPending++;
      persist();
      const saving = context.visibilityQueue.catch(() => {}).then(async () => {
        try {
          const res = await call(context, 'PUT', '/visibility', { visibility: snapshot });
          context.confirmedVisibility = res.visibility;
          if (revision === context.visibilityVersion) {
            context.room.visibility = res.visibility;
            delete context.room.pendingVisibility;
            context.blocked = false;
            persist();
          }
          return res;
        } catch (error) {
          if (active(context) && revision === context.visibilityVersion) {
            context.room.visibility = context.confirmedVisibility;
            // Keep pendingVisibility across reloads; polling alone must not resume publishing.
            context.blocked = true;
            persist();
          }
          throw error;
        } finally {
          context.visibilityPending--;
          if (active(context) && !context.visibilityPending && !context.blocked) flush(context);
        }
      });
      context.visibilityQueue = saving;
      return saving;
    },
    rotate() {
      const context = current;
      if (!context) return Promise.reject(new Error('room-lost'));
      const revision = ++context.tokenVersion;
      context.tokenPending++;
      const rotating = context.tokenQueue.catch(() => {}).then(async () => {
        try {
          const res = await call(context, 'POST', '/rotate');
          if (revision === context.tokenVersion) { context.room.tokens = res.tokens; persist(); }
          return context.room;
        } finally { context.tokenPending--; }
      });
      context.tokenQueue = rotating;
      return rotating;
    },
    async status() {
      const context = current;
      assertActive(context);
      const revision = context.visibilityVersion;
      const wasPending = context.visibilityPending > 0;
      const tokenRevision = context.tokenVersion;
      const tokenPending = context.tokenPending > 0;
      const res = await call(context, 'GET', '/status');
      if (!wasPending && !context.visibilityPending && revision === context.visibilityVersion) {
        context.room.visibility = res.visibility;
        context.confirmedVisibility = res.visibility;
      }
      if (!tokenPending && !context.tokenPending && tokenRevision === context.tokenVersion) context.room.tokens = res.tokens;
      persist();
      return res;
    },
    close() {
      const context = current;
      if (!context) return Promise.resolve();
      if (context.closeRequest) return context.closeRequest;
      context.closing = true;
      context.room.pendingClose = true;
      clearTimeout(context.retryTimer);
      persist();
      context.closeRequest = call(context, 'DELETE', '', undefined, { missingOK: true })
        .then(() => forget(context))
        .finally(() => { context.closeRequest = null; });
      return context.closeRequest;
    },
  };
}
