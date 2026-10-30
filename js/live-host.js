// 裁判端的同步连接：保存房间信息，并把最新状态发给服务器。发送失败不影响抽取。

const API = '/lottery/live-api/rooms';
const STORE_KEY = 'pil-lottery:live';
const RETRY_MS = 2000;

export function liveLink(room, view) {
  return `${location.origin}/lottery/live/#${room.roomId}.${room.tokens[view]}`;
}

export function createLiveHost({ onFail = () => {}, onRecover = () => {}, onLost = () => {} } = {}) {
  let room = null;
  try { room = JSON.parse(localStorage.getItem(STORE_KEY)); } catch { /* 隐私模式等 */ }
  let seq = 0;
  let pending = null;
  let sending = false;
  let failing = false;
  let retryTimer = 0;

  function persist() {
    try {
      if (room) localStorage.setItem(STORE_KEY, JSON.stringify(room));
      else localStorage.removeItem(STORE_KEY);
    } catch { /* 忽略 */ }
  }

  async function call(method, path, body) {
    const res = await fetch(`${API}/${room.roomId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${room.hostToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 || res.status === 403) {
      room = null;
      pending = null;
      persist();
      onLost();
      throw new Error('room-lost');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** 同一时间只发一个请求；排队期间只保留最新状态，失败后自动重试。 */
  async function flush() {
    if (sending || !pending || !room) return;
    sending = true;
    const body = pending;
    pending = null;
    try {
      await call('PUT', '/state', body);
      if (failing) { failing = false; onRecover(); }
    } catch (error) {
      if (error.message !== 'room-lost') {
        if (!pending) pending = body;
        if (!failing) { failing = true; onFail(); }
        clearTimeout(retryTimer);
        retryTimer = setTimeout(flush, RETRY_MS);
      }
    } finally {
      sending = false;
    }
    if (pending && !failing) flush();
  }

  return {
    get room() { return room; },
    async create() {
      const res = await fetch(API, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      room = await res.json();
      persist();
      return room;
    },
    push(state) {
      if (!room) return;
      seq = Math.max(seq + 1, Date.now()); // 刷新页面后序号仍然递增
      pending = { seq, state };
      flush();
    },
    async setVisibility(visibility) {
      const res = await call('PUT', '/visibility', { visibility });
      room.visibility = res.visibility;
      persist();
      return res;
    },
    async rotate() {
      const res = await call('POST', '/rotate');
      room.tokens = res.tokens;
      persist();
      return room;
    },
    async status() {
      const res = await call('GET', '/status');
      room.visibility = res.visibility;
      room.tokens = res.tokens;
      persist();
      return res;
    },
    async close() {
      await call('DELETE', '').catch(() => {});
      room = null;
      pending = null;
      clearTimeout(retryTimer);
      persist();
    },
  };
}
