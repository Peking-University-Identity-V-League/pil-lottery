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
  { id: 'mutual', name: '终极人格互相可见' },
  { id: 'survivor-ult', name: '求生者终极人格对监管者可见' },
  { id: 'hunter-ult', name: '监管者终极人格对求生者可见' },
  { id: 'despair', name: '求生者绝处逢生对监管者可见' },
  { id: 'trait', name: '监管者辅助特质对求生者可见' },
  { id: 'none', name: '全部隐藏' },
];

const seesUltimates = (talents) => talents !== 'hide'; // 能看到全部人格时也包含终极人格

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
    // 全部人格里包含绝处逢生，要隐藏它只能退到“仅终极”
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

/** 只保留已知字段，其他内容不会进入房间状态。无效时抛出错误。 */
export function normalizeState(raw) {
  if (!raw || !PHASES.has(raw.phase) || !Number.isSafeInteger(raw.round) || raw.round < 0) throw new Error('invalid-state');
  if (!Array.isArray(raw.slots) || (raw.slots.length !== 0 && raw.slots.length !== SLOT_COUNT)) throw new Error('invalid-state');
  return {
    round: raw.round,
    phase: raw.phase,
    slots: raw.slots.map((slot, index) => {
      if (!slot || (slot.char !== null && !validId(slot.char))) throw new Error('invalid-slot');
      const out = { side: index < 4 ? 'survivor' : 'hunter', char: slot.char, build: normalizeBuild(slot.build) };
      if (out.side === 'hunter') out.trait = normalizeTrait(slot.trait);
      else if (slot.despair === true && out.build) out.despair = true;
      return out;
    }),
  };
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

/** 计算某个视角能收到的数据；未揭晓和被隐藏的字段都不会出现在结果里。 */
export function project(state, view, visibility) {
  return {
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
      return out;
    }),
  };
}
