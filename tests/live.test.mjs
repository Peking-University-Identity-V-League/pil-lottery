import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createLiveServer } from '../server/live-server.mjs';
import {
  ALL_HIDDEN, ALL_VISIBLE, LIVE_VIEWS, activeToggles, normalizeState, normalizeVisibility, project, toggleVisibility,
} from '../js/live-visibility.js';

const build = (name) => ({ levels: { [`${name}-a`]: 3, [`${name}-ult`]: 1 }, ultimates: [`${name}-ult`], used: 26 });
const fullState = (phase = 'done') => ({
  round: 1,
  phase,
  slots: [
    ...['s1', 's2', 's3', 's4'].map((id) => ({ char: id, build: build(id) })),
    { char: 'h1', build: build('h1'), trait: { name: 'SECRET-TRAIT' } },
  ],
});
const PRESETS = {
  open: ALL_VISIBLE,
  closed: ALL_HIDDEN,
  ultimates: { ...ALL_VISIBLE, hunterSeesTalents: 'ultimates', hunterSeesDespair: 'hide', survivorSeesTalents: 'ultimates' },
  'no-trait': { ...ALL_VISIBLE, survivorSeesTrait: 'hide' },
  'hunter-only': { ...ALL_VISIBLE, hunterSeesTalents: 'ultimates', survivorSeesTalents: 'hide', survivorSeesTrait: 'hide' },
};
const preset = (id) => PRESETS[id];

test('全部公开时每个视角都能看到完整内容', () => {
  for (const view of LIVE_VIEWS) {
    const out = project(normalizeState(fullState()), view, preset('open'));
    assert.equal(out.slots[4].char.id, 'h1');
    assert.equal(out.slots[4].trait.name, 'SECRET-TRAIT');
    assert.equal(out.slots[0].build.status, 'full');
  }
});

test('隐藏特质时求生者收不到，监管者和观众可以看到', () => {
  const state = normalizeState(fullState());
  const visibility = preset('no-trait');
  assert.ok(!JSON.stringify(project(state, 'survivor', visibility)).includes('SECRET-TRAIT'));
  assert.equal(project(state, 'hunter', visibility).slots[4].trait.name, 'SECRET-TRAIT');
  assert.equal(project(state, 'spectator', visibility).slots[4].trait.name, 'SECRET-TRAIT');
});

test('敌方只看终极时收不到其他人格', () => {
  const state = normalizeState(fullState());
  const out = project(state, 'survivor', preset('ultimates'));
  assert.equal(out.slots[4].build.status, 'ultimates');
  assert.deepEqual(out.slots[4].build.ultimates, ['h1-ult']);
  assert.ok(!JSON.stringify(out.slots[4]).includes('h1-a'));
  assert.equal(out.slots[0].build.status, 'full');
  const hunterView = project(state, 'hunter', preset('ultimates'));
  assert.ok(!JSON.stringify(hunterView.slots[0]).includes('s1-a'));
  assert.ok(JSON.stringify(hunterView.slots[4]).includes('h1-a'));
});

test('敌方全隐藏时不泄露角色、人格和特质', () => {
  const state = normalizeState(fullState());
  const survivor = JSON.stringify(project(state, 'survivor', preset('closed')).slots[4]);
  for (const secret of ['h1', 'SECRET-TRAIT']) assert.ok(!survivor.includes(secret));
  const hunter = JSON.stringify(project(state, 'hunter', preset('closed')).slots.slice(0, 4));
  for (const secret of ['s1', 's2', 's3', 's4']) assert.ok(!hunter.includes(secret));
});

test('未揭晓的内容不会出现在输出里', () => {
  const state = normalizeState({
    round: 2,
    phase: 'drawing',
    slots: [
      { char: 's1', build: null },
      { char: null, build: null }, { char: null, build: null }, { char: null, build: null },
      { char: null, build: null, trait: null },
    ],
  });
  const out = project(state, 'spectator', preset('open'));
  assert.equal(out.slots[0].char.id, 's1');
  assert.equal(out.slots[0].build.status, 'pending');
  assert.deepEqual(out.slots[4], { side: 'hunter', char: { status: 'pending' }, build: { status: 'pending' }, trait: { status: 'pending' } });
});

test('双方可以分别设置：求生者看不到监管者终极，监管者能看到求生者终极和绝处逢生', () => {
  const raw = fullState();
  raw.slots[0].despair = true;
  const state = normalizeState(raw);
  const visibility = preset('hunter-only');
  const toHunter = project(state, 'hunter', visibility);
  assert.deepEqual(toHunter.slots[0].build, { status: 'ultimates', ultimates: ['s1-ult'], despair: true });
  assert.equal(toHunter.slots[1].build.despair, false);
  const toSurvivor = project(state, 'survivor', visibility);
  assert.equal(toSurvivor.slots[4].build.status, 'hidden');
  assert.ok(!JSON.stringify(toSurvivor.slots[4]).includes('h1-ult'));
  assert.ok(!('despair' in toSurvivor.slots[4].build));
});

test('绝处逢生可以单独公开或隐藏', () => {
  const raw = fullState();
  raw.slots[0].despair = true;
  const state = normalizeState(raw);
  const base = { ...preset('closed'), hunterSeesChar: 'show' };
  assert.equal(project(state, 'hunter', { ...base, hunterSeesDespair: 'show' }).slots[0].build.despair, true);
  assert.ok(!('despair' in project(state, 'hunter', base).slots[0].build));
  assert.ok(!JSON.stringify(project(state, 'hunter', base)).includes('despair'));
});

test('按钮亮不亮只取决于当前状态', () => {
  const press = (v, ...ids) => ids.reduce((cur, id) => toggleVisibility(cur, id), v);
  const on = (v, options) => [...activeToggles(v, options)].sort();

  assert.deepEqual(on(ALL_VISIBLE), ['all', 'despair', 'hunter-ult', 'mutual', 'survivor-ult', 'trait']);
  assert.deepEqual(on(ALL_HIDDEN), ['none']);

  // 全部可见时点亮着的按钮，只关闭对应内容
  const noSurvivorUlt = press(ALL_VISIBLE, 'survivor-ult');
  assert.deepEqual(on(noSurvivorUlt), ['hunter-ult', 'trait']);
  assert.equal(noSurvivorUlt.hunterSeesTalents, 'hide');
  assert.equal(noSurvivorUlt.survivorSeesTalents, 'all');
  assert.equal(noSurvivorUlt.hunterSeesDespair, 'hide');

  assert.deepEqual(on(press(ALL_VISIBLE, 'mutual')), ['trait']);
  assert.deepEqual(on(press(ALL_VISIBLE, 'trait')), ['despair', 'hunter-ult', 'mutual', 'survivor-ult']);

  // 绝处逢生可以单独打开；能看到全部人格时要隐藏它，只能退到仅终极
  const despairOnly = press(ALL_HIDDEN, 'despair');
  assert.deepEqual(on(despairOnly), ['despair']);
  assert.equal(despairOnly.hunterSeesTalents, 'hide');
  assert.equal(despairOnly.hunterSeesDespair, 'show');
  const noDespair = press(ALL_VISIBLE, 'despair');
  assert.deepEqual(on(noDespair), ['hunter-ult', 'mutual', 'survivor-ult', 'trait']);
  assert.equal(noDespair.hunterSeesTalents, 'ultimates');
  assert.equal(noDespair.hunterSeesDespair, 'hide');

  // 两个单向都打开时，互相可见自动亮；关掉一个方向后另一个保留
  const fromHidden = press(ALL_HIDDEN, 'survivor-ult');
  assert.deepEqual(on(fromHidden), ['survivor-ult']);
  assert.equal(fromHidden.hunterSeesChar, 'show');
  assert.deepEqual(on(press(fromHidden, 'hunter-ult')), ['hunter-ult', 'mutual', 'survivor-ult']);
  assert.deepEqual(on(press(fromHidden, 'hunter-ult', 'hunter-ult')), ['survivor-ult']);

  // 互相可见不会把“全部”降级成“仅终极”
  const oneWay = { ...ALL_VISIBLE, survivorSeesTalents: 'hide' };
  const mutual = press(oneWay, 'mutual');
  assert.equal(mutual.hunterSeesTalents, 'all');
  assert.equal(mutual.survivorSeesTalents, 'ultimates');

  assert.deepEqual(on(press(ALL_VISIBLE, 'trait', 'all')), on(ALL_VISIBLE));
  assert.deepEqual(on(press(ALL_VISIBLE, 'none')), ['none']);
  assert.deepEqual(on(press(ALL_VISIBLE, 'all')), []);
  assert.deepEqual(on(press(ALL_HIDDEN, 'none')), []);

  // 关闭抽取辅助特质时，特质设置不影响其他按钮
  const locked = { traitLocked: true };
  assert.deepEqual(on({ ...ALL_VISIBLE, survivorSeesTrait: 'hide' }, locked), ['all', 'despair', 'hunter-ult', 'mutual', 'survivor-ult']);
  assert.deepEqual(on({ ...ALL_HIDDEN, survivorSeesTrait: 'show' }, locked), ['none']);
  assert.ok(normalizeVisibility(press(ALL_VISIBLE, 'mutual', 'trait')));
});

test('看不到全部人格时，揭晓前就标记不显示人格树', () => {
  const state = normalizeState({
    round: 1, phase: 'drawing',
    slots: Array.from({ length: 5 }, (_, i) => (i === 4 ? { char: null, build: null, trait: null } : { char: null, build: null })),
  });
  const visibility = preset('hunter-only');
  assert.equal(project(state, 'hunter', visibility).slots[0].build.limited, true);
  assert.equal(project(state, 'hunter', visibility).slots[4].build.limited, undefined);
  assert.equal(project(state, 'spectator', visibility).slots[0].build.limited, undefined);
});

test('自选特质对所有视角都显示自选', () => {
  const raw = fullState();
  raw.slots[4].trait = 'free';
  const state = normalizeState(raw);
  assert.equal(project(state, 'survivor', preset('no-trait')).slots[4].trait.status, 'free');
  assert.equal(project(state, 'survivor', preset('open')).slots[4].trait.status, 'free');
  assert.equal(project(state, 'spectator', preset('open')).slots[4].trait.status, 'free');
  assert.equal(project(state, 'hunter', preset('closed')).slots[4].trait.status, 'free');
});

test('状态校验会丢弃多余字段并拒绝无效数据', () => {
  const raw = fullState();
  raw.slots[0].extra = 'x';
  assert.ok(!('extra' in normalizeState(raw).slots[0]));
  assert.throws(() => normalizeState({ ...raw, phase: 'bad' }));
  assert.throws(() => normalizeState({ ...raw, slots: [raw.slots[0]] }));
  assert.equal(normalizeVisibility({ hunterSeesChar: 'show' }), null);
});

/* ------------------------------------------------------------------ 服务 */

let server;
let base;
let clock = 1_000_000;

before(async () => {
  server = createLiveServer({ now: () => clock, maxCreatesPerHour: 1000 });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/lottery/live-api/rooms`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => { server.close(resolve); });
});

async function createRoom() {
  const res = await fetch(base, { method: 'POST' });
  assert.equal(res.status, 201);
  return res.json();
}

const hostCall = (room, method, path, body, token = room.hostToken) => fetch(`${base}/${room.roomId}${path}`, {
  method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

/** 读取 SSE，把 state 事件依次交给调用方。 */
async function openStream(room, view) {
  const controller = new AbortController();
  const res = await fetch(`${base}/${room.roomId}/events?token=${room.tokens[view]}`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const events = [];
  return {
    async next(type = 'state') {
      for (;;) {
        const index = events.findIndex((e) => e.type === type);
        if (index >= 0) return events.splice(index, 1)[0].data;
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += value;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const payload = /^data: (.+)$/m.exec(block)?.[1];
          if (name) events.push({ type: name, data: JSON.parse(payload) });
        }
      }
    },
    close: () => controller.abort(),
  };
}

test('错误的令牌被拒绝，不存在的房间返回 404', async () => {
  const room = await createRoom();
  assert.equal((await fetch(`${base}/${room.roomId}/events?token=bad`)).status, 403);
  assert.equal((await fetch(`${base}/${room.roomId}/check?token=bad`)).status, 403);
  assert.equal((await fetch(`${base}/nope/events?token=bad`)).status, 404);
  assert.equal((await hostCall(room, 'PUT', '/state', { seq: 1, state: fullState() }, 'bad')).status, 403);
  // 选手令牌不能当裁判令牌使用
  assert.equal((await hostCall(room, 'PUT', '/state', { seq: 1, state: fullState() }, room.tokens.spectator)).status, 403);
});

test('裁判提交后，已连接的选手不刷新就收到按视角过滤的推送', async () => {
  const room = await createRoom();
  await hostCall(room, 'PUT', '/visibility', { visibility: preset('no-trait') });
  const survivor = await openStream(room, 'survivor');
  const hunter = await openStream(room, 'hunter');
  assert.equal((await survivor.next()).phase, 'idle');
  assert.equal((await hunter.next()).phase, 'idle');

  const res = await hostCall(room, 'PUT', '/state', { seq: 1, state: fullState() });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).viewers, { hunter: 1, survivor: 1, spectator: 0 });

  const toSurvivor = await survivor.next();
  assert.equal(toSurvivor.view, 'survivor');
  assert.equal(toSurvivor.slots[4].trait.status, 'hidden');
  const toHunter = await hunter.next();
  assert.equal(toHunter.slots[4].trait.name, 'SECRET-TRAIT');
  survivor.close();
  hunter.close();
});

test('中途加入直接收到当前状态，放宽可见范围也会推送', async () => {
  const room = await createRoom();
  await hostCall(room, 'PUT', '/visibility', { visibility: preset('closed') });
  await hostCall(room, 'PUT', '/state', { seq: 1, state: fullState() });
  const survivor = await openStream(room, 'survivor');
  assert.equal((await survivor.next()).slots[4].char.status, 'hidden');
  await hostCall(room, 'PUT', '/visibility', { visibility: preset('open') });
  assert.equal((await survivor.next()).slots[4].char.id, 'h1');
  survivor.close();
});

test('乱序到达的旧状态被丢弃', async () => {
  const room = await createRoom();
  await hostCall(room, 'PUT', '/state', { seq: 5, state: fullState('done') });
  const res = await hostCall(room, 'PUT', '/state', { seq: 4, state: fullState('drawing') });
  assert.equal((await res.json()).stale, true);
  const stream = await openStream(room, 'spectator');
  assert.equal((await stream.next()).phase, 'done');
  stream.close();
});

test('重新生成链接后旧链接立即失效', async () => {
  const room = await createRoom();
  const stream = await openStream(room, 'survivor');
  await stream.next();
  const rotated = await (await hostCall(room, 'POST', '/rotate')).json();
  await stream.next('closed');
  assert.equal((await fetch(`${base}/${room.roomId}/check?token=${room.tokens.survivor}`)).status, 403);
  assert.equal((await fetch(`${base}/${room.roomId}/check?token=${rotated.tokens.survivor}`)).status, 200);
});

test('房间超时后被清理', async () => {
  const room = await createRoom();
  clock += 12 * 60 * 60 * 1000 + 1;
  server.sweep();
  assert.equal((await fetch(`${base}/${room.roomId}/check?token=${room.tokens.survivor}`)).status, 404);
});

test('过大的请求被拒绝', async () => {
  const room = await createRoom();
  const res = await hostCall(room, 'PUT', '/state', { seq: 1, padding: 'x'.repeat(70 * 1024) }).catch(() => null);
  if (res) assert.equal(res.status, 413);
});
