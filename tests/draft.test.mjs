import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { DRAFT_DEFAULTS, dealDraft, draftEnabled, draftNeeds, normalizeDraftSettings } from '../js/rules.js';
import {
  ALL_HIDDEN, ALL_VISIBLE, applyDraftPick, draftComplete, normalizeDraft, normalizeState, project,
} from '../js/live-visibility.js';
import { createLiveServer } from '../server/live-server.mjs';

const chars = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));
const personal = (extra = {}) => normalizeDraft({
  round: 7, deadline: null, onTimeout: 'random',
  survivor: { mode: 'personal', cands: [['s0', 's1'], ['s2', 's3'], ['s4', 's5'], ['s6', 's7']] },
  hunter: { mode: 'pick', cands: ['h0', 'h1', 'h2'] },
  ...extra,
});
const shared = () => normalizeDraft({
  round: 8, deadline: null, onTimeout: 'random',
  survivor: { mode: 'shared', pool: ['s0', 's1', 's2', 's3', 's4'] },
  hunter: { mode: 'direct' },
});

test('默认设置等于普通抽取，无效的保存值恢复默认', () => {
  assert.equal(draftEnabled(DRAFT_DEFAULTS), false);
  assert.deepEqual(draftNeeds(DRAFT_DEFAULTS), { survivor: 4, hunter: 1 });
  assert.deepEqual(normalizeDraftSettings({ survivor: 'x', survivorCount: 99, seconds: 7 }), DRAFT_DEFAULTS);
  assert.equal(normalizeDraftSettings({ hunter: 'pick', hunterCount: 12 }).hunterCount, 12);
  assert.equal(normalizeDraftSettings({ hunterCount: 13 }).hunterCount, DRAFT_DEFAULTS.hunterCount);
  assert.equal(normalizeDraftSettings({ survivorCount: 6 }).survivorCount, 6);
  assert.equal(normalizeDraftSettings({ sharedSize: 36 }).sharedSize, 36);
});

test('各自候选互不重复，直接抽取的一方不发牌', () => {
  const settings = { ...DRAFT_DEFAULTS, survivor: 'personal', survivorCount: 5 };
  const { survivor, hunter } = dealDraft(settings, chars('s', 20), chars('h', 3));
  assert.equal(new Set(survivor.cands.flat()).size, 20);
  assert.deepEqual(hunter, { mode: 'direct' });
  const both = dealDraft({ ...DRAFT_DEFAULTS, survivor: 'shared', sharedSize: 4, hunter: 'pick', hunterCount: 2 }, chars('s', 4), chars('h', 2));
  assert.equal(both.survivor.pool.length, 4);
  assert.equal(both.hunter.cands.length, 2);
});

test('服务器接受设置允许的最大候选数', () => {
  const ids = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const base = { round: 1, deadline: null, onTimeout: 'random' };
  assert.equal(normalizeDraft({ ...base, survivor: { mode: 'shared', pool: ids('s', 36) }, hunter: { mode: 'pick', cands: ids('h', 12) } }).hunter.cands.length, 12);
  assert.throws(() => normalizeDraft({ ...base, survivor: { mode: 'shared', pool: ids('s', 37) }, hunter: { mode: 'direct' } }));
  assert.throws(() => normalizeDraft({ ...base, survivor: { mode: 'direct' }, hunter: { mode: 'pick', cands: ids('h', 13) } }));
  const personal6 = [0, 1, 2, 3].map((i) => ids(`s${i}-`, 6));
  assert.equal(normalizeDraft({ ...base, survivor: { mode: 'personal', cands: personal6 }, hunter: { mode: 'direct' } }).survivor.cands[0].length, 6);
  assert.throws(() => normalizeDraft({ ...base, survivor: { mode: 'personal', cands: [0, 1, 2, 3].map((i) => ids(`s${i}-`, 7)) }, hunter: { mode: 'direct' } }));
});

test('预选、放回和锁定都要合法', () => {
  let draft = personal();
  assert.throws(() => applyDraftPick(draft, 0, 's2'), /invalid-char/);
  assert.throws(() => applyDraftPick(draft, 0, undefined, true), /nothing-selected/);
  draft = applyDraftPick(draft, 0, 's1');
  draft = applyDraftPick(draft, 0, 's0');
  draft = applyDraftPick(draft, 0, undefined, true);
  assert.deepEqual(draft.seats[0], { sel: 's0', locked: true });
  assert.throws(() => applyDraftPick(draft, 0, 's1'), /already-locked/);
  assert.equal(draftComplete(draft), false);
});

test('共享卡池每张牌只能属于一个号位，直接抽取的座位不能操作', () => {
  let draft = shared();
  draft = applyDraftPick(draft, 0, 's0');
  assert.throws(() => applyDraftPick(draft, 1, 's0'), /card-taken/);
  draft = applyDraftPick(draft, 0, null);
  draft = applyDraftPick(draft, 1, 's0');
  assert.equal(draft.seats[1].sel, 's0');
  assert.throws(() => applyDraftPick(draft, 4, 's1'), /invalid-position/);
  assert.equal(draft.seats[4].locked, true);
});

test('敌方收不到候选和选择，揭晓后的未选候选也不会给敌方', () => {
  const draft = applyDraftPick(applyDraftPick(personal(), 0, 's1', true), 4, 'h2');
  const state = normalizeState({ round: 7, phase: 'drawing', slots: [], draft });
  const toHunter = JSON.stringify(project(state, 'hunter', ALL_VISIBLE));
  for (const id of ['s0', 's1', 's7']) assert.ok(!toHunter.includes(id));
  assert.ok(toHunter.includes('h2'));
  const toSurvivor = JSON.stringify(project(state, 'survivor', ALL_VISIBLE));
  for (const id of ['h0', 'h2']) assert.ok(!toSurvivor.includes(id));
  assert.ok(toSurvivor.includes('s1'));
  const spectator = JSON.stringify(project(state, 'spectator', ALL_HIDDEN));
  for (const id of ['s1', 'h2']) assert.ok(spectator.includes(id));
  assert.equal(project(state, 'hunter', ALL_VISIBLE).draft.seats[0].locked, true);

  const done = normalizeState({
    round: 9, phase: 'done', leftover: ['s9'],
    slots: [
      { char: 's1', rejected: ['s0'], build: null }, { char: 's2', build: null }, { char: 's3', build: null }, { char: 's4', build: null },
      { char: 'h1', rejected: ['h9'], build: null, trait: 'free' },
    ],
  });
  const seenByHunter = project(done, 'hunter', ALL_VISIBLE);
  assert.equal(seenByHunter.slots[0].rejected, undefined);
  assert.equal(seenByHunter.leftover, undefined);
  assert.deepEqual(seenByHunter.slots[4].rejected, ['h9']);
  assert.equal(project(done, 'survivor', ALL_VISIBLE).slots[4].rejected, undefined);
});

let server, base, clock = 1_000_000;
before(async () => {
  server = createLiveServer({ now: () => clock });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/lottery/live-api/rooms`;
});
after(() => server.shutdown());

const send = (path, method, body, token) => fetch(base + path, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
async function setup(draftBody, seconds = null) {
  const { roomId, hostToken } = await (await send('', 'POST')).json();
  const room = `/${roomId}`;
  const join = async (view) => (await (await send(`${room}/join`, 'POST', { view })).json()).session;
  const res = await send(`${room}/draft`, 'PUT', { seq: 10, draft: draftBody, seconds }, hostToken);
  assert.equal(res.status, 200);
  return { room, hostToken, join, round: draftBody.round };
}
const { seats: _s, closed: _c, ...personalBody } = personal();
const { seats: _s2, closed: _c2, ...sharedBody } = shared();

test('求生者进入时按顺序获得号位，只能操作自己的座位，观众和敌方不能操作', async () => {
  const { room, hostToken, join, round } = await setup(personalBody);
  const [a, b, h, watcher] = [await join('survivor'), await join('survivor'), await join('hunter'), await join('spectator')];
  const act = (action, session, body) => send(`${room}/draft/${action}`, 'POST', { session, round, ...body });
  assert.equal((await act('pick', b, { position: 0, char: 's0' })).status, 403);
  assert.equal((await act('pick', b, { position: 1, char: 's2' })).status, 200);
  assert.equal((await act('pick', a, { position: 0, char: 's0' })).status, 200);
  assert.equal((await act('pick', a, { position: 1, char: 's2' })).status, 403);
  assert.equal((await act('pick', watcher, { position: 0, char: 's1' })).status, 403);
  assert.equal((await act('pick', h, { position: 0, char: 's1' })).status, 403);
  assert.equal((await act('lock', h, { position: 4 })).status, 409);
  assert.equal((await act('pick', h, { position: 4, char: 'h0' })).status, 200);
  assert.equal((await act('lock', a, { position: 0 })).status, 200);
  const status = await (await send(`${room}/draft`, 'GET', null, hostToken)).json();
  assert.deepEqual(status.draft.seats[0], { sel: 's0', locked: true });
  assert.deepEqual(status.claimed, [true, true, false, false]);
  assert.equal((await act('pick', a, { round: 1, position: 0, char: 's1' })).status, 409);
});

test('共享卡池里无人认领的号位可以代选，到点后选手不能再操作，裁判可以延时和代选', async () => {
  const { room, hostToken, join, round } = await setup(sharedBody, 30);
  const a = await join('survivor');
  const act = (action, body) => send(`${room}/draft/${action}`, 'POST', { session: a, round, ...body });
  assert.equal((await act('pick', { position: 1, char: 's1' })).status, 200);
  assert.equal((await act('pick', { position: 0, char: 's1' })).status, 409);
  clock += 31_000;
  assert.equal((await act('pick', { position: 0, char: 's2' })).status, 409);
  const hostPick = await send(`${room}/draft/host-pick`, 'POST', { round, position: 0, char: 's2', lock: true }, hostToken);
  assert.equal(hostPick.status, 200);
  assert.equal((await hostPick.json()).draft.seats[0].locked, true);
  assert.equal((await send(`${room}/draft/extend`, 'POST', { round, seconds: 30 }, hostToken)).status, 200);
  assert.equal((await act('pick', { position: 1, char: 's3' })).status, 200);
  assert.equal((await send(`${room}/draft/close`, 'POST', { round }, hostToken)).status, 200);
  assert.equal((await act('pick', { position: 1, char: 's4' })).status, 409);
});

test('裁判发布旧状态不会覆盖选择，开始新一轮后选角结束，号位保留', async () => {
  const { room, hostToken, join, round } = await setup(personalBody);
  const a = await join('survivor');
  const act = (action, body) => send(`${room}/draft/${action}`, 'POST', { session: a, round, ...body });
  await act('pick', { position: 0, char: 's0' });
  const stale = await send(`${room}/state`, 'PUT', { seq: 11, state: { round, phase: 'drawing', slots: [] } }, hostToken);
  assert.equal(stale.status, 200);
  let status = await (await send(`${room}/draft`, 'GET', null, hostToken)).json();
  assert.equal(status.draft.seats[0].sel, 's0');
  await send(`${room}/state`, 'PUT', { seq: 12, state: { round: round + 1, phase: 'drawing', slots: [] } }, hostToken);
  status = await (await send(`${room}/draft`, 'GET', null, hostToken)).json();
  assert.equal(status.draft, null);
  assert.equal((await act('pick', { position: 0, char: 's1' })).status, 409);
  assert.deepEqual(status.claimed, [true, false, false, false]);
});

test('裁判以外不能发放候选，不合法的候选会被拒绝', async () => {
  const { room, hostToken } = await setup(personalBody);
  assert.equal((await send(`${room}/draft`, 'PUT', { seq: 20, draft: personalBody })).status, 403);
  const dup = { ...personalBody, survivor: { mode: 'personal', cands: [['a', 'b'], ['a', 'c'], ['d', 'e'], ['f', 'g']] } };
  assert.equal((await send(`${room}/draft`, 'PUT', { seq: 21, draft: dup }, hostToken)).status, 400);
  assert.equal((await send(`${room}/draft`, 'PUT', { seq: 22, draft: { ...personalBody, survivor: { mode: 'direct' }, hunter: { mode: 'direct' } } }, hostToken)).status, 400);
});

test('新房间默认 4 名求生者和 1 名监管者，满员后拒绝进入', async () => {
  const { room, join } = await setup(personalBody);
  for (let i = 0; i < 4; i++) assert.ok(await join('survivor'));
  assert.equal((await send(`${room}/join`, 'POST', { view: 'survivor' })).status, 409);
  assert.ok(await join('hunter'));
  assert.equal((await send(`${room}/join`, 'POST', { view: 'hunter' })).status, 409);
  assert.ok(await join('spectator'));
  assert.ok(await join('spectator'));
});

test('裁判踢出指定号位后，只有这个人失效，下一个进入的人补上空位', async () => {
  const { room, hostToken, join, round } = await setup(personalBody);
  const a = await join('survivor');
  const b = await join('survivor');
  const kicked = await send(`${room}/seats/kick`, 'POST', { position: 0 }, hostToken);
  assert.equal(kicked.status, 200);
  assert.deepEqual((await kicked.json()).access.survivor.positions.map((p) => p.taken), [false, true, false, false]);
  assert.equal((await send(`${room}/draft/pick`, 'POST', { session: a, round, position: 0, char: 's0' })).status, 403);
  assert.equal((await send(`${room}/draft/pick`, 'POST', { session: b, round, position: 1, char: 's2' })).status, 200);
  const again = await (await send(`${room}/join`, 'POST', { view: 'survivor' })).json();
  assert.equal(again.position, 0);
  assert.equal((await send(`${room}/seats/kick`, 'POST', { position: 0 })).status, 403);
  assert.equal((await send(`${room}/seats/kick`, 'POST', { position: 9 }, hostToken)).status, 400);
});

test('上限调高后，多出来的求生者没有号位，有人被踢后自动补位', async () => {
  const { room, hostToken, join } = await setup(personalBody);
  await send(`${room}/access`, 'PUT', { view: 'survivor', limit: 6 }, hostToken);
  for (let i = 0; i < 4; i++) await join('survivor');
  const extra = await (await send(`${room}/join`, 'POST', { view: 'survivor' })).json();
  assert.equal(extra.position, null);
  const stream = new AbortController();
  const events = await fetch(`${base}${room}/events?session=${extra.session}`, { signal: stream.signal });
  assert.equal(events.status, 200);
  const positions = async (res) => (await res.json()).access.survivor.positions.map((p) => p.taken);
  assert.deepEqual(await positions(await send(`${room}/seats/kick`, 'POST', { position: 2 }, hostToken)), [true, true, true, true]);
  stream.abort();
});


test('断线很久仍保留号位，裁判移除后旧凭证不能操作新持有者或代选', async () => {
  for (const body of [personalBody, sharedBody]) {
    const { room, hostToken, round } = await setup(body);
    const old = await (await send(`${room}/join`, 'POST', { view: 'survivor' })).json();
    clock += 2 * 60 * 60 * 1000;
    const other = await (await send(`${room}/join`, 'POST', { view: 'survivor' })).json();
    assert.equal(old.position, 0); assert.equal(other.position, 1);
    assert.equal((await send(`${room}/draft/pick`, 'POST', { session: old.session, round, position: 0, char: 's0' })).status, 200);
    assert.equal((await send(`${room}/seats/kick`, 'POST', { position: 0 }, hostToken)).status, 200);
    const replacement = await (await send(`${room}/join`, 'POST', { view: 'survivor' })).json();assert.equal(replacement.position, 0);
    for (const position of [0, 2]) assert.equal((await send(`${room}/draft/lock`, 'POST', { session: old.session, round, position, char: 's0' })).status, 403);
    assert.equal((await send(`${room}/draft/lock`, 'POST', { session: replacement.session, round, position: 0, char: 's1' })).status, 200);
    const saved = await (await send(`${room}/draft`, 'GET', null, hostToken)).json();assert.deepEqual(saved.draft.seats[0], { sel: 's1', locked: true });
  }
});

test('监管者名额不会因时间过去被顶替，主动释放后旧凭证失效', async () => {
  const { room, hostToken, join, round } = await setup(personalBody);
  const old = await join('hunter'); clock += 60 * 60 * 1000;
  assert.equal((await send(`${room}/join`, 'POST', { view: 'hunter' })).status, 409);
  assert.equal((await send(`${room}/leave`, 'POST', { session: old })).status, 200);
  const replacement = await join('hunter');
  assert.equal((await send(`${room}/draft/lock`, 'POST', { session: old, round, position: 4, char: 'h0' })).status, 403);
  assert.equal((await send(`${room}/draft/lock`, 'POST', { session: replacement, round, position: 4, char: 'h1' })).status, 200);
});

test('长时间断线后重连仍使用原号位，不能操作其他人的号位', async () => {
  const { room, hostToken, join, round } = await setup(personalBody);
  const old = await join('survivor');
  const first = await fetch(`${base}${room}/events?session=${old}`);await first.body.cancel();
  await new Promise(resolve => setTimeout(resolve, 20));clock += 2 * 60 * 60 * 1000;
  const other = await (await send(`${room}/join`, 'POST', { view: 'survivor' })).json();assert.equal(other.position, 1);
  const stream = await fetch(`${base}${room}/events?session=${old}`);
  try {
    assert.equal(stream.status, 200);
    assert.equal((await send(`${room}/draft/lock`, 'POST', { session: old, round, position: 0, char: 's0' })).status, 200);
    assert.equal((await send(`${room}/draft/lock`, 'POST', { session: old, round, position: 1, char: 's2' })).status, 403);
    assert.equal((await send(`${room}/draft/lock`, 'POST', { session: other.session, round, position: 1, char: 's2' })).status, 200);
  } finally { await stream.body.cancel(); }
});
