// 选手同步的可见范围：决定每个链接能收到什么。服务器用它过滤，隐藏的内容不会发给浏览器。

export const LIVE_VIEWS = ['hunter', 'survivor', 'spectator'];
export const LIVE_VIEW_NAMES = { hunter: '监管者', survivor: '求生者', spectator: '观众' };

export const VISIBILITY_OPTIONS = {
  hunterSeesChar: ['show', 'hide'],
  hunterSeesTalents: ['all', 'ultimates', 'hide'],
  hunterSeesDespair: ['show', 'hide'], // 只在监管者看不到求生者全部人格时起作用
  survivorSeesChar: ['show', 'hide'],
  survivorSeesTalents: ['all', 'ultimates', 'hide'],
  survivorSeesTrait: ['show', 'hide'],
};

export const ALL_VISIBLE = {
  hunterSeesChar: 'show', hunterSeesTalents: 'all', hunterSeesDespair: 'show',
  survivorSeesChar: 'show', survivorSeesTalents: 'all', survivorSeesTrait: 'show',
};
export const ALL_HIDDEN = {
  hunterSeesChar: 'hide', hunterSeesTalents: 'hide', hunterSeesDespair: 'hide',
  survivorSeesChar: 'hide', survivorSeesTalents: 'hide', survivorSeesTrait: 'hide',
};
// 从“全部可见”或“全部隐藏”切出来时的起点：角色公开，其余隐藏，再叠加选中的按钮
const NOTHING_SELECTED = { ...ALL_HIDDEN, hunterSeesChar: 'show', survivorSeesChar: 'show' };

export const DEFAULT_VISIBILITY = ALL_VISIBLE;

export const VISIBILITY_TOGGLES = [
  { id: 'all', name: '全部可见' },
  { id: 'mutual', name: '最终天赋互相可见' },
  { id: 'survivor-ult', name: '求生者最终天赋对监管者可见' },
  { id: 'hunter-ult', name: '监管者最终天赋对求生者可见' },
  { id: 'despair', name: '求生者绝处逢生对监管者可见' },
  { id: 'trait', name: '监管者辅助特质对求生者可见' },
  { id: 'none', name: '全部隐藏' },
];

const seesUltimates = (talents) => talents !== 'hide'; // 能看到全部人格时也包含最终天赋

/**
 * 按钮亮不亮只取决于当前可见范围，没有单独的选中记录，所以下拉框改动后按钮也会跟着变。
 * 关闭抽取辅助特质时所有人都看到“自选”，特质设置不参与判断。
 */
export function activeToggles(v, { traitLocked = false } = {}) {
  const active = new Set();
  const survivorUlt = seesUltimates(v.hunterSeesTalents);
  const hunterUlt = seesUltimates(v.survivorSeesTalents);
  const traitShown = v.survivorSeesTrait === 'show';
  if (survivorUlt) active.add('survivor-ult');
  if (hunterUlt) active.add('hunter-ult');
  if (survivorUlt && hunterUlt) active.add('mutual');
  if (v.hunterSeesTalents === 'all' || v.hunterSeesDespair === 'show') active.add('despair');
  if (traitShown && !traitLocked) active.add('trait');
  if (v.hunterSeesChar === 'show' && v.hunterSeesTalents === 'all'
    && v.survivorSeesChar === 'show' && v.survivorSeesTalents === 'all' && (traitShown || traitLocked)) active.add('all');
  if (Object.keys(ALL_HIDDEN).every((key) => (key === 'survivorSeesTrait' && traitLocked) || v[key] === 'hide')) active.add('none');
  return active;
}

/** 点亮着的按钮就关闭它代表的内容，点没亮的按钮就打开，其他内容保持不变。 */
export function toggleVisibility(v, id, options = {}) {
  const active = activeToggles(v, options);
  if (id === 'all') return active.has('all') ? { ...NOTHING_SELECTED } : { ...ALL_VISIBLE };
  if (id === 'none') return active.has('none') ? { ...NOTHING_SELECTED } : { ...ALL_HIDDEN };
  const next = active.has('none') ? { ...NOTHING_SELECTED } : { ...v };
  const hideHunterView = () => {
    // 不再能看到全部人格时，绝处逢生要单独决定，默认不公开
    if (next.hunterSeesTalents === 'all') next.hunterSeesDespair = 'hide';
    next.hunterSeesTalents = 'hide';
  };
  const showUltimates = (key) => { if (next[key] === 'hide') next[key] = 'ultimates'; };
  if (id === 'trait') {
    next.survivorSeesTrait = active.has('trait') ? 'hide' : 'show';
  } else if (id === 'despair') {
    // 全部人格里包含绝处逢生，要隐藏它只能退到“仅最终天赋”
    if (active.has(id) && next.hunterSeesTalents === 'all') next.hunterSeesTalents = 'ultimates';
    next.hunterSeesDespair = active.has(id) ? 'hide' : 'show';
  } else if (id === 'survivor-ult') {
    if (active.has(id)) hideHunterView(); else showUltimates('hunterSeesTalents');
  } else if (id === 'hunter-ult') {
    if (active.has(id)) next.survivorSeesTalents = 'hide'; else showUltimates('survivorSeesTalents');
  } else if (active.has('mutual')) {
    hideHunterView();
    next.survivorSeesTalents = 'hide';
  } else {
    showUltimates('hunterSeesTalents');
    showUltimates('survivorSeesTalents');
  }
  return next;
}

const PHASES = new Set(['idle', 'drawing', 'hunter', 'trait', 'done']);
const SLOT_COUNT = 5;
const MAX_LEVEL = 20;

const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 64;

export function normalizeVisibility(raw) {
  const out = {};
  for (const [key, options] of Object.entries(VISIBILITY_OPTIONS)) {
    if (!options.includes(raw?.[key])) return null;
    out[key] = raw[key];
  }
  return out;
}

function normalizeBuild(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || !raw.levels || typeof raw.levels !== 'object') throw new Error('invalid-build');
  const entries = Object.entries(raw.levels);
  if (entries.length > 64 || !Array.isArray(raw.ultimates) || raw.ultimates.length > 2) throw new Error('invalid-build');
  const levels = {};
  for (const [id, level] of entries) {
    if (!validId(id) || !Number.isInteger(level) || level < 1 || level > MAX_LEVEL) throw new Error('invalid-build');
    levels[id] = level;
  }
  if (!raw.ultimates.every(validId) || !Number.isInteger(raw.used) || raw.used < 0 || raw.used > 64) throw new Error('invalid-build');
  return { levels, ultimates: [...raw.ultimates], used: raw.used };
}

function normalizeTrait(raw) {
  if (raw === null || raw === 'free') return raw;
  if (raw?.name && validId(raw.name)) return { name: raw.name };
  throw new Error('invalid-trait');
}

const MAX_DRAFT_PERSONAL = 6;
const MAX_DRAFT_HUNTER = 12;
const MAX_DRAFT_POOL = 36;

function normalizeIdList(raw, min, max) {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max || !raw.every(validId) || new Set(raw).size !== raw.length) throw new Error('invalid-draft');
  return [...raw];
}

/** 选角数据只保留已知字段；直接抽取的座位一开始就算锁定，它的角色要到揭晓前才抽。 */
export function normalizeDraft(raw) {
  if (!raw || !Number.isSafeInteger(raw.round) || raw.round < 0) throw new Error('invalid-draft');
  const mode = raw.survivor?.mode;
  const hunterMode = raw.hunter?.mode;
  if (!['direct', 'personal', 'shared'].includes(mode) || !['direct', 'pick'].includes(hunterMode)) throw new Error('invalid-draft');
  if (mode === 'direct' && hunterMode === 'direct') throw new Error('invalid-draft');
  if (raw.deadline !== null && !Number.isSafeInteger(raw.deadline)) throw new Error('invalid-draft');
  if (!['random', 'wait'].includes(raw.onTimeout)) throw new Error('invalid-draft');
  const survivor = { mode };
  if (mode === 'personal') {
    if (!Array.isArray(raw.survivor.cands) || raw.survivor.cands.length !== 4) throw new Error('invalid-draft');
    survivor.cands = raw.survivor.cands.map((list) => normalizeIdList(list, 2, MAX_DRAFT_PERSONAL));
    if (new Set(survivor.cands.flat()).size !== survivor.cands.flat().length) throw new Error('invalid-draft');
  } else if (mode === 'shared') {
    survivor.pool = normalizeIdList(raw.survivor.pool, 4, MAX_DRAFT_POOL);
  }
  const hunter = { mode: hunterMode };
  if (hunterMode === 'pick') hunter.cands = normalizeIdList(raw.hunter.cands, 2, MAX_DRAFT_HUNTER);
  const out = { round: raw.round, survivor, hunter, deadline: raw.deadline, onTimeout: raw.onTimeout, closed: raw.closed === true };
  const blank = () => [0, 1, 2, 3, 4].map((i) => ({ sel: null, locked: i < 4 ? mode === 'direct' : hunterMode === 'direct' }));
  if (raw.seats === undefined) { out.seats = blank(); return out; }
  if (!Array.isArray(raw.seats) || raw.seats.length !== SLOT_COUNT) throw new Error('invalid-draft');
  out.seats = raw.seats.map((seat, i) => {
    const allowed = draftCandidates(out, i);
    if (seat?.sel !== null && !allowed.includes(seat?.sel)) throw new Error('invalid-draft');
    if (seat.locked && !seat.sel && allowed.length) throw new Error('invalid-draft');
    return { sel: seat.sel, locked: seat.locked === true };
  });
  return out;
}

/** 这个座位可以选的牌；直接抽取的座位没有。 */
export function draftCandidates(draft, position) {
  if (position === 4) return draft.hunter.cands || [];
  return draft.survivor.pool || draft.survivor.cands?.[position] || [];
}

/**
 * 预选、放回或锁定，返回新的选角数据；不合法时抛出带错误码的 Error。
 * char 为 undefined 表示保持当前预选，null 表示放回。
 */
export function applyDraftPick(draft, position, char, lock = false) {
  if (!Number.isInteger(position) || position < 0 || position >= SLOT_COUNT) throw new Error('invalid-position');
  const seat = draft.seats[position];
  const allowed = draftCandidates(draft, position);
  if (!allowed.length) throw new Error('invalid-position');
  if (seat.locked) throw new Error('already-locked');
  const sel = char === undefined ? seat.sel : char;
  if (sel !== null && !allowed.includes(sel)) throw new Error('invalid-char');
  // 共享卡池里每张牌只能属于一个号位
  if (sel !== null && draft.survivor.pool && position < 4 && draft.seats.some((other, i) => i !== position && i < 4 && other.sel === sel)) throw new Error('card-taken');
  if (lock && sel === null) throw new Error('nothing-selected');
  return { ...draft, seats: draft.seats.map((other, i) => (i === position ? { sel, locked: lock } : other)) };
}

/** 全部座位都锁定后才能揭晓。 */
export const draftComplete = (draft) => draft.seats.every((seat) => seat.locked);

/** 选角期间是否还接受选手操作。裁判代选不受影响。 */
export const draftOpen = (draft, time) => !draft.closed && (draft.deadline === null || time < draft.deadline);

const BAN_SIDES = ['survivor', 'hunter'];
const BAN_STAGES = ['own', 'enemy'];
const MAX_BAN_QUOTA = 12;
const MAX_BAN_TARGETS = 128;
const otherSide = (side) => (side === 'survivor' ? 'hunter' : 'survivor');
const emptyBanLists = () => ({ survivor: { survivor: [], hunter: [] }, hunter: { survivor: [], hunter: [] } });
const emptyBanCounts = () => ({ survivor: { survivor: 0, hunter: 0 }, hunter: { survivor: 0, hunter: 0 } });
/** 这一方在这个环节禁哪个阵营：先禁己方，再禁对方。 */
const banStageKind = (side, stage) => (stage === 'own' ? side : otherSide(side));
const stageHasBans = (quota, stage) => BAN_SIDES.some((side) => quota[side][banStageKind(side, stage)] > 0);

/** 进入一个环节：重新计时，没有次数的一方直接算完成。 */
function banStageFields(order, quota, stage, seconds, time) {
  const done = {};
  for (const side of BAN_SIDES) done[side] = !quota[side][banStageKind(side, stage)];
  const turn = order === 'simultaneous' ? null : done[order] ? otherSide(order) : order;
  return { stage, done, turn, expired: false, deadline: seconds === null ? null : time + seconds * 1000 };
}

/**
 * 禁用数据。side 是动手的一方，kind 是被禁角色的阵营：quota.survivor.hunter 是求生者方
 * 能禁几名监管者，quota.survivor.survivor 是求生者方能禁几名己方角色。
 * 流程分两个环节，stage 为 own 时双方禁己方，enemy 时双方禁对方，各自计时；没有次数的环节跳过。
 * pending 是还没确认的选择，picks 是确认后的结果，passed 是放弃的次数，都按 [side][kind] 存放。
 * expired 表示时间已到、正在等裁判处理。needs 是双方都用满次数后，每个卡池至少要留下的角色数。
 */
export function normalizeBans(raw) {
  const fail = () => { throw new Error('invalid-bans'); };
  if (!raw || !Number.isSafeInteger(raw.round) || raw.round < 0) fail();
  if (!['simultaneous', ...BAN_SIDES].includes(raw.order) || !['skip', 'random', 'wait'].includes(raw.onTimeout)) fail();
  if (raw.deadline !== null && !Number.isSafeInteger(raw.deadline)) fail();
  if (raw.seconds !== null && (!Number.isInteger(raw.seconds) || raw.seconds < 1)) fail();
  const quota = { survivor: {}, hunter: {} };
  const targets = {};
  const needs = {};
  for (const side of BAN_SIDES) {
    for (const kind of BAN_SIDES) {
      const value = raw.quota?.[side]?.[kind];
      if (!Number.isInteger(value) || value < 0 || value > MAX_BAN_QUOTA) fail();
      quota[side][kind] = value;
    }
  }
  for (const kind of BAN_SIDES) {
    if (!Number.isInteger(raw.needs?.[kind]) || raw.needs[kind] < 1) fail();
    needs[kind] = raw.needs[kind];
    targets[kind] = normalizeIdList(raw.targets?.[kind], 1, MAX_BAN_TARGETS);
    if (targets[kind].length - quota.survivor[kind] - quota.hunter[kind] < needs[kind]) fail();
  }
  const first = BAN_STAGES.find((stage) => stageHasBans(quota, stage));
  if (!first) fail();
  const out = {
    round: raw.round, order: raw.order, onTimeout: raw.onTimeout, seconds: raw.seconds, deadline: raw.deadline,
    closed: raw.closed === true, quota, targets, needs,
  };
  if (raw.picks === undefined) {
    const fields = banStageFields(raw.order, quota, first, raw.seconds, 0);
    return { ...out, ...fields, deadline: raw.deadline, picks: emptyBanLists(), pending: emptyBanLists(), passed: emptyBanCounts() };
  }
  out.picks = emptyBanLists();
  out.pending = emptyBanLists();
  out.passed = emptyBanCounts();
  out.done = {};
  for (const side of BAN_SIDES) {
    for (const kind of BAN_SIDES) {
      out.picks[side][kind] = normalizeIdList(raw.picks[side]?.[kind], 0, quota[side][kind]);
      out.pending[side][kind] = normalizeIdList(raw.pending?.[side]?.[kind], 0, quota[side][kind]);
      if (![...out.picks[side][kind], ...out.pending[side][kind]].every((id) => targets[kind].includes(id))) fail();
      const passed = raw.passed?.[side]?.[kind];
      if (!Number.isInteger(passed) || passed < 0) fail();
      out.passed[side][kind] = passed;
    }
    out.done[side] = raw.done?.[side] === true;
  }
  if (raw.turn !== null && !BAN_SIDES.includes(raw.turn)) fail();
  if (!BAN_STAGES.includes(raw.stage)) fail();
  out.turn = raw.turn;
  out.stage = raw.stage;
  out.expired = raw.expired === true;
  return out;
}

const stageKindOf = (bans, side) => banStageKind(side, bans.stage);
const banUsed = (bans, side, kind) => bans.picks[side][kind].length + bans.passed[side][kind];
/** 这一方现在总共还能选几张：轮流禁用时每手一张。 */
function banRoom(bans, side) {
  const kind = stageKindOf(bans, side);
  return bans.turn ? 1 : bans.quota[side][kind] - banUsed(bans, side, kind);
}
const nextBanStage = (bans) => (bans.stage === 'own' && stageHasBans(bans.quota, 'enemy') ? 'enemy' : null);

function assertBanAction(bans, side) {
  if (bans.closed) throw new Error('bans-closed');
  if (bans.done[side]) throw new Error('already-locked');
  if (bans.turn && bans.turn !== side) throw new Error('not-your-turn');
}

const withPending = (bans, side, kind, list) => ({ ...bans, pending: { ...bans.pending, [side]: { ...bans.pending[side], [kind]: list } } });

/** 选中或取消一张牌。只剩一次时，再点另一张就是换选。 */
export function toggleBan(bans, side, char) {
  assertBanAction(bans, side);
  const kind = stageKindOf(bans, side);
  if (!bans.targets[kind].includes(char) || bans.picks[side][kind].includes(char)) throw new Error('invalid-char');
  // 对方已经公开禁用的角色不用再禁一次
  if (bans.turn && bans.picks[otherSide(side)][kind].includes(char)) throw new Error('invalid-char');
  const current = bans.pending[side][kind];
  if (current.includes(char)) return withPending(bans, side, kind, current.filter((id) => id !== char));
  const room = banRoom(bans, side);
  if (room === 1) return withPending(bans, side, kind, [char]);
  if (current.length >= room) throw new Error('bans-full');
  return withPending(bans, side, kind, [...current, char]);
}

/** 把这一方选中的牌写入结果。 */
function lockPending(bans, side) {
  const kind = stageKindOf(bans, side);
  return {
    ...bans,
    picks: { ...bans.picks, [side]: { ...bans.picks[side], [kind]: [...bans.picks[side][kind], ...bans.pending[side][kind]] } },
    pending: { ...bans.pending, [side]: { ...bans.pending[side], [kind]: [] } },
  };
}

/** 确认后交给下一手；双方都完成就进入下一个环节，并重新计时。 */
function advanceBans(bans, time) {
  if (bans.done.survivor && bans.done.hunter) {
    const stage = nextBanStage(bans);
    if (stage) return { ...bans, ...banStageFields(bans.order, bans.quota, stage, bans.seconds, time) };
    return { ...bans, turn: null };
  }
  if (!bans.turn) return bans;
  const turn = bans.done[otherSide(bans.turn)] ? bans.turn : otherSide(bans.turn);
  return { ...bans, turn, expired: false, deadline: bans.seconds === null ? null : time + bans.seconds * 1000 };
}

/** 确认当前选择；选得不够就算放弃剩下的次数。轮流禁用时每手一张，没选就是放弃这一手。 */
export function confirmBans(bans, side, time) {
  assertBanAction(bans, side);
  const kind = stageKindOf(bans, side);
  const hadPending = bans.pending[side][kind].length > 0;
  const locked = lockPending(bans, side);
  const quota = bans.quota[side][kind];
  const picked = locked.picks[side][kind].length;
  const passedBefore = bans.passed[side][kind];
  const passedNow = bans.turn ? passedBefore + (hadPending ? 0 : 1) : quota - picked;
  const passed = { ...bans.passed, [side]: { ...bans.passed[side], [kind]: passedNow } };
  const done = { ...bans.done, [side]: picked + passedNow >= quota };
  return advanceBans({ ...locked, passed, done }, time);
}

/** 所有环节都结束了。 */
export const bansComplete = (bans) => bans.done.survivor && bans.done.hunter && !nextBanStage(bans);

/** 禁用期间是否还接受选手操作。裁判代选不受影响。 */
export const bansOpen = (bans, time) => !bans.closed && !bans.expired && (bans.deadline === null || time < bans.deadline);

/** 随机补齐这一方这个环节还没选的次数，不重复，也不选已确认禁用的角色。 */
function fillBans(bans, side, rng) {
  const kind = stageKindOf(bans, side);
  let next = bans;
  while (next.pending[side][kind].length < banRoom(next, side)) {
    const taken = [...next.picks.survivor[kind], ...next.picks.hunter[kind], ...next.pending[side][kind]];
    const free = next.targets[kind].filter((id) => !taken.includes(id));
    if (!free.length) break;
    next = withPending(next, side, kind, [...next.pending[side][kind], free[Math.floor(rng() * free.length)]]);
  }
  return next;
}

/**
 * 时间到：已选中的牌一律自动锁定，剩下的次数按设置放弃、随机补齐或等裁判处理。
 * 轮流禁用只结束当前这一手，同时禁用结束所有还没确认的一方。
 */
export function timeoutBans(bans, time, rng) {
  let next = bans;
  for (const side of bans.turn ? [bans.turn] : BAN_SIDES.filter((other) => !bans.done[other])) {
    if (bans.onTimeout === 'wait') {
      const kind = stageKindOf(next, side);
      const filled = next.pending[side][kind].length > 0 && next.pending[side][kind].length >= banRoom(next, side);
      if (filled) next = confirmBans(next, side, time);
      else next = lockPending(next, side);
      continue;
    }
    if (bans.onTimeout === 'random') next = fillBans(next, side, rng);
    next = confirmBans(next, side, time);
  }
  // 进入了下一手或下一个环节时已经重新计时，否则停表等裁判
  if (bans.onTimeout === 'wait' && next.stage === bans.stage && next.turn === bans.turn && !bansComplete(next)) {
    return { ...next, expired: true, deadline: null };
  }
  return next;
}

/** 结束禁用：已选的算数，没用完的次数作废，还没开始的环节不再进行。 */
export function closeBans(bans, time) {
  let next = bans;
  while (!bansComplete(next)) next = confirmBans(next, next.turn || BAN_SIDES.find((side) => !next.done[side]), time);
  return { ...next, closed: true, expired: false, deadline: null };
}

/** 延时；已经停表等裁判时重新开始计时，选手可以继续操作。 */
export function extendBans(bans, seconds, time) {
  return { ...bans, expired: false, deadline: Math.max(bans.deadline ?? time, time) + seconds * 1000 };
}

/** 从卡池里移除的角色，按角色阵营分组；双方禁了同一个角色时只算一次。 */
export const bannedChars = (bans) => Object.fromEntries(BAN_SIDES.map((kind) => [kind, [...new Set([...bans.picks.survivor[kind], ...bans.picks.hunter[kind]])]]));

/** 只保留已知字段，其他内容不会进入房间状态。无效时抛出错误。 */
export function normalizeState(raw) {
  if (!raw || !PHASES.has(raw.phase) || !Number.isSafeInteger(raw.round) || raw.round < 0) throw new Error('invalid-state');
  if (!Array.isArray(raw.slots) || (raw.slots.length !== 0 && raw.slots.length !== SLOT_COUNT)) throw new Error('invalid-state');
  const out = {
    round: raw.round,
    phase: raw.phase,
    slots: raw.slots.map((slot, index) => {
      if (!slot || (slot.char !== null && !validId(slot.char))) throw new Error('invalid-slot');
      const out = { side: index < 4 ? 'survivor' : 'hunter', char: slot.char, build: normalizeBuild(slot.build) };
      if (out.side === 'hunter') out.trait = normalizeTrait(slot.trait);
      else if (slot.despair === true && out.build) out.despair = true;
      if (slot.rejected !== undefined) out.rejected = normalizeIdList(slot.rejected, 1, MAX_DRAFT_HUNTER - 1);
      return out;
    }),
  };
  if (raw.leftover !== undefined) out.leftover = normalizeIdList(raw.leftover, 1, MAX_DRAFT_POOL - 4);
  if (raw.draft !== undefined) out.draft = normalizeDraft(raw.draft);
  if (raw.bans !== undefined) out.bans = normalizeBans(raw.bans);
  return out;
}

export const emptyState = () => ({ round: 0, phase: 'idle', slots: [] });

function projectBuild(slot, own, talents, despairVisible) {
  const { build } = slot;
  const full = own || talents === 'all';
  if (!build) return full ? { status: 'pending' } : { status: 'pending', limited: true };
  if (full) return { status: 'full', ...build };
  const out = talents === 'ultimates' ? { status: 'ultimates', ultimates: build.ultimates } : { status: 'hidden' };
  if (despairVisible) out.despair = slot.despair === true;
  return out;
}

function projectTrait(trait, own, visibility) {
  if (trait === null) return { status: 'pending' };
  // 自选时没有抽取结果需要隐藏，所有视角都显示“自选”
  if (trait === 'free') return { status: 'free' };
  if (!own && visibility.survivorSeesTrait === 'hide') return { status: 'hidden' };
  return { status: 'shown', name: trait.name };
}

/** 敌方只能知道每个座位是否已锁定，收不到候选牌，也收不到选了哪张。 */
function projectDraft(draft, view) {
  const seesSurvivor = view === 'survivor' || view === 'spectator';
  const seesHunter = view === 'hunter' || view === 'spectator';
  const survivor = { mode: draft.survivor.mode };
  if (seesSurvivor && draft.survivor.cands) survivor.cands = draft.survivor.cands;
  if (seesSurvivor && draft.survivor.pool) survivor.pool = draft.survivor.pool;
  const hunter = { mode: draft.hunter.mode };
  if (seesHunter && draft.hunter.cands) hunter.cands = draft.hunter.cands;
  return {
    round: draft.round,
    deadline: draft.deadline,
    onTimeout: draft.onTimeout,
    closed: draft.closed,
    survivor,
    hunter,
    seats: draft.seats.map((seat, i) => ((i < 4 ? seesSurvivor : seesHunter)
      ? { sel: seat.sel, locked: seat.locked }
      : { locked: seat.locked })),
  };
}

/**
 * 同时禁用时，全部结束之前敌方看不到结果；轮流禁用的结果确认后就公开。
 * 没确认的选择只发给动手的一方和观众，可禁范围只发给有这项次数的一方和观众。
 */
function projectBans(bans, view) {
  const open = bans.order !== 'simultaneous' || bans.closed || bansComplete(bans);
  const out = {
    round: bans.round, order: bans.order, onTimeout: bans.onTimeout, deadline: bans.deadline,
    closed: bans.closed, expired: bans.expired, stage: bans.stage, quota: bans.quota, done: bans.done, turn: bans.turn,
    targets: {}, pending: emptyBanLists(), picks: emptyBanLists(), passed: emptyBanCounts(),
  };
  for (const side of BAN_SIDES) {
    const own = view === 'spectator' || view === side;
    if (own) {
      out.pending[side] = bans.pending[side];
      for (const kind of BAN_SIDES) if (bans.quota[side][kind]) out.targets[kind] = bans.targets[kind];
    }
    if (own || open) {
      out.picks[side] = bans.picks[side];
      out.passed[side] = bans.passed[side];
    }
  }
  return out;
}

/** 计算某个视角能收到的数据；未揭晓和被隐藏的字段都不会出现在结果里。 */
export function project(state, view, visibility) {
  const projected = {
    view,
    round: state.round,
    phase: state.phase,
    // 还没有抽取时也要知道哪一方不显示人格树
    limited: {
      survivor: view === 'hunter' && visibility.hunterSeesTalents !== 'all',
      hunter: view === 'survivor' && visibility.survivorSeesTalents !== 'all',
    },
    slots: state.slots.map((slot) => {
      const own = view === 'spectator' || view === slot.side;
      let char = { status: 'pending' };
      // 敌方内容按“谁在看”分别设置：监管者看求生者，求生者看监管者
      const seesChar = view === 'hunter' ? visibility.hunterSeesChar : visibility.survivorSeesChar;
      const seesTalents = view === 'hunter' ? visibility.hunterSeesTalents : visibility.survivorSeesTalents;
      const despairVisible = view === 'hunter' && slot.side === 'survivor' && visibility.hunterSeesDespair === 'show';
      if (slot.char) char = own || seesChar === 'show' ? { status: 'shown', id: slot.char } : { status: 'hidden' };
      const out = { side: slot.side, char, build: projectBuild(slot, own, seesTalents, despairVisible) };
      if (slot.side === 'hunter') out.trait = projectTrait(slot.trait, own, visibility);
      // 没选的候选只有己方和观众能看到
      if (own && slot.rejected) out.rejected = slot.rejected;
      return out;
    }),
  };
  if (state.leftover && view !== 'hunter') projected.leftover = state.leftover;
  if (state.draft) projected.draft = projectDraft(state.draft, view);
  if (state.bans) projected.bans = projectBans(state.bans, view);
  return projected;
}
