import { withRequestTimeout } from './request-timeout.js';
// 裁判端同步：异步请求绑定房间，未确认的权限变更阻止结果发布。
const API = '/lottery/live-api/rooms';
const STORE_KEY = 'pil-lottery:live';
const RETRY_MS = 2000;

export function liveLink(room) {
  return location.origin + '/lottery/live/#' + room.roomId;
}

export function createLiveHost({ onFail = () => {}, onRecover = () => {}, onLost = () => {}, requestTimeoutMs = 10000 } = {}) {
  function session(room) {
    return {
      room, seq: 0, pending: null, sending: false, failing: false, retryTimer: 0,
      visibilityQueue: Promise.resolve(), visibilityVersion: 0, visibilityPending: 0,
      confirmedVisibility: room.visibility, blocked: Boolean(room.pendingVisibility),
      accessQueue: Promise.resolve(), accessVersion: 0, accessPending: 0, resetting: false, closing: Boolean(room.pendingClose), closeRequest: null,
    };
  }
  let current = null;
  let creating = null;
  try {
    const room = JSON.parse(localStorage.getItem(STORE_KEY));
    // 旧版房间靠链接令牌进入，没有 access 字段，不再恢复
    if (room?.roomId && room?.hostToken && room?.access && room?.visibility) current = session(room);
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
  async function call(context, method, path, body, { missingOK = false } = {}) {
    assertActive(context);
    return withRequestTimeout(requestTimeoutMs, async signal => {
      const res = await fetch(API + '/' + context.room.roomId + path, {
        method, signal,
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
      if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { code: (await res.json().catch(() => ({}))).error });
      const result = await res.json();
      assertActive(context);
      return result;
    });
  }

  async function flush(context) {
    if (!active(context) || context.sending || !context.pending || context.visibilityPending || context.blocked || context.closing || context.resetting) return;
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
        const data = await withRequestTimeout(requestTimeoutMs, async signal => {
          const res = await fetch(API, { method: 'POST', signal });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        });
        const room = { ...data, passwords: {} };
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
    /** 撤下结果和进行中的流程，保留名额；调用方等待服务端确认后再清理本地。 */
    async initialize() {
      const context = current;
      if (!context) throw new Error('room-lost');
      context.resetting = true;
      context.pending = null;
      clearTimeout(context.retryTimer);
      context.seq = Math.max(context.seq + 1, Date.now());
      try {
        const result = await call(context, 'PUT', '/state', { seq: context.seq, state: { round: 0, phase: 'idle', slots: [] } });
        if (result.stale) throw new Error('state-changed');
        return result;
      } finally {
        context.resetting = false;
        if (active(context)) flush(context);
      }
    },
    /** 发放候选。旧状态序号更小，还在路上也不会盖掉这一轮。 */
    startDraft(draft, seconds, banRound = null) {
      const context = current;
      if (!context) return Promise.reject(new Error('room-lost'));
      context.pending = null;
      clearTimeout(context.retryTimer);
      context.seq = Math.max(context.seq + 1, Date.now());
      return call(context, 'PUT', '/draft', { seq: context.seq, draft, seconds, banRound });
    },
    /** 开始禁用阶段。和发放候选一样，序号前移后旧状态不会盖掉这一轮。 */
    startBans(bans) {
      const context = current;
      if (!context) return Promise.reject(new Error('room-lost'));
      context.pending = null;
      clearTimeout(context.retryTimer);
      context.seq = Math.max(context.seq + 1, Date.now());
      return call(context, 'PUT', '/bans', { seq: context.seq, bans });
    },
    /** action：host-pick、host-confirm 代选，extend 延时，timeout 超时处理，close 结束禁用。 */
    banAction(action, body) {
      const context = current;
      if (!context) return Promise.reject(new Error('room-lost'));
      return call(context, 'POST', '/bans/' + action, body);
    },
    draftStatus() {
      const context = current;
      if (!context) return Promise.reject(new Error('room-lost'));
      return call(context, 'GET', '/draft');
    },
    /** action：host-pick 代选、extend 延时、close 结束选角。 */
    draftAction(action, body) {
      const context = current;
      if (!context) return Promise.reject(new Error('room-lost'));
      return call(context, 'POST', '/draft/' + action, body);
    },
    /** 改某个身份的密码或人数上限；password 为 null 表示取消密码。明文只留在裁判自己的浏览器，用于回填密码框。 */
    setAccess(view, changes) {
      const context = current;
      if (!context) return Promise.reject(new Error('room-lost'));
      context.accessPending++;
      context.accessVersion++;
      const saving = context.accessQueue.catch(() => {}).then(async () => {
        try {
          const res = await call(context, 'PUT', '/access', { view, ...changes });
          context.room.access = res.access;
          if (changes.password !== undefined) context.room.passwords = { ...context.room.passwords, [view]: changes.password || '' };
          persist();
          return res;
        } finally { context.accessPending--; }
      });
      context.accessQueue = saving;
      return saving;
    },
    clearSeats(view) {
      const context = current;
      if (!context) return Promise.reject(new Error('room-lost'));
      context.accessPending++;
      context.accessVersion++;
      const clearing = context.accessQueue.catch(() => {}).then(async () => {
        try {
          const res = await call(context, 'POST', '/seats/clear', { view });
          context.room.access = res.access;
          persist();
          return res;
        } finally { context.accessPending--; }
      });
      context.accessQueue = clearing;
      return clearing;
    },
    /** 踢出某个号位上的求生者。 */
    kickPosition(position) {
      const context = current;
      if (!context) return Promise.reject(new Error('room-lost'));
      context.accessPending++;
      context.accessVersion++;
      const kicking = context.accessQueue.catch(() => {}).then(async () => {
        try {
          const res = await call(context, 'POST', '/seats/kick', { position });
          context.room.access = res.access;
          persist();
          return res;
        } finally { context.accessPending--; }
      });
      context.accessQueue = kicking;
      return kicking;
    },
    /** 重置房间：丢弃还没发出的状态，序号前移，防止上一场结果被写回。 */
    async reset({ clearPasswords = false } = {}) {
      const context = current;
      if (!context) throw new Error('room-lost');
      context.resetting = true;
      context.accessVersion++;
      context.pending = null;
      clearTimeout(context.retryTimer);
      context.seq = Math.max(context.seq + 1, Date.now());
      try {
        const res = await call(context, 'POST', '/reset', { seq: context.seq, clearPasswords });
        context.room.access = res.access;
        if (clearPasswords) context.room.passwords = {};
        persist();
        return res;
      } finally {
        context.resetting = false;
        if (active(context)) flush(context);
      }
    },
    async status() {
      const context = current;
      assertActive(context);
      const revision = context.visibilityVersion;
      const wasPending = context.visibilityPending > 0;
      const accessRevision = context.accessVersion;
      const accessWasPending = context.accessPending > 0 || context.resetting;
      const res = await call(context, 'GET', '/status');
      if (!wasPending && !context.visibilityPending && revision === context.visibilityVersion) {
        context.room.visibility = res.visibility;
        context.confirmedVisibility = res.visibility;
      }
      if (res.access && !accessWasPending && !context.accessPending && !context.resetting && accessRevision === context.accessVersion) {
        context.room.access = res.access;
        // 服务器上已没有密码时，不再显示本地记下的旧密码
        const passwords = { ...context.room.passwords };
        for (const [view, access] of Object.entries(res.access || {})) if (!access.password) delete passwords[view];
        context.room.passwords = passwords;
      }
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
