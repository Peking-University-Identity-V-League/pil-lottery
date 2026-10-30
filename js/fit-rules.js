// 适配设置规则：决定某个角色不会抽到哪些人格或辅助特质。纯逻辑，不依赖 DOM。
//
// 角色事实放在 characters.json（fixed_item、has_weak_skill），
// 主办方的平衡取舍放在这里的名单中。
// 主办方在设置页的调整只记录与默认值不同的部分：
//   overrides = { [规则 id]: { enabled?: false, toggled?: [与默认状态相反的角色 id] } }

export const normalizeName = (name) => String(name).replace(/[“”"]/g, '');

const named = (names) => {
  const set = new Set(names);
  return (char) => set.has(normalizeName(char.name));
};

export const FIT_RULES = [
  {
    id: 'critical-point',
    side: 'hunter',
    kind: 'talent',
    target: '临界点',
    soft: true, // 不会被主动抽中，但作为巨钳、拘禁狂的前置仍会解锁
    summary: '只有技能伤害小于普通攻击的监管者才会抽到。',
    note: '抽到巨钳或拘禁狂时仍会解锁。',
    allowed: (char) => Boolean(char.has_weak_skill),
  },
  {
    id: 'chase',
    side: 'hunter',
    kind: 'talent',
    target: '追猎',
    allowed: named(['厂长', '摄影师', '梦之女巫', '疯眼', '时空之影']),
  },
  {
    id: 'tease',
    side: 'hunter',
    kind: 'talent',
    target: '嬉弄',
    blocked: named(['博士']),
  },
  {
    id: 'excited',
    side: 'hunter',
    kind: 'trait',
    target: '兴奋',
    blocked: named(['博士']),
  },
  {
    id: 'arrogance',
    side: 'hunter',
    kind: 'talent',
    target: '张狂',
    blocked: named(['摄影师', '红夫人', '博士']),
  },
  {
    id: 'emergency-reserve',
    side: 'survivor',
    kind: 'talent',
    target: '应急储备',
    summary: '手持物不可更换的求生者不会抽到。',
    blocked: (char) => Boolean(char.fixed_item),
  },
];

/** 不考虑主办方调整时，这个角色是否“不会抽到”。 */
export function isBlockedByDefault(rule, char) {
  return rule.allowed ? !rule.allowed(char) : rule.blocked(char);
}

export const isRuleEnabled = (rule, overrides = {}) => overrides[rule.id]?.enabled !== false;

/** 名单上的状态（不看总开关）：这个角色是否被标记为“不会抽到”。 */
export function isListedBlocked(rule, char, overrides = {}) {
  const flipped = overrides[rule.id]?.toggled?.includes(char.id) ?? false;
  return isBlockedByDefault(rule, char) !== flipped;
}

/** 规则实际生效时，这个角色是否不会抽到。 */
export function isBlocked(rule, char, overrides = {}) {
  return isRuleEnabled(rule, overrides) && isListedBlocked(rule, char, overrides);
}

export function isRuleModified(rule, overrides = {}) {
  const o = overrides[rule.id];
  return Boolean(o && (o.enabled === false || o.toggled?.length));
}

/** 返回切换某个角色后的 overrides（不修改原对象），回到默认状态的记录会被清理。 */
export function toggleCharacter(rule, charId, overrides = {}) {
  const current = overrides[rule.id] || {};
  const toggled = new Set(current.toggled || []);
  if (!toggled.delete(charId)) toggled.add(charId);
  return withRule(overrides, rule, { ...current, toggled: [...toggled] });
}

export function setRuleEnabled(rule, enabled, overrides = {}) {
  return withRule(overrides, rule, { ...(overrides[rule.id] || {}), enabled });
}

function withRule(overrides, rule, value) {
  const next = { ...overrides };
  const clean = {};
  if (value.enabled === false) clean.enabled = false;
  if (value.toggled?.length) clean.toggled = value.toggled;
  if (Object.keys(clean).length) next[rule.id] = clean;
  else delete next[rule.id];
  return next;
}

/**
 * 某个角色受到的限制。
 * @returns {{ bannedIds: string[], softBannedIds: string[], bannedTraits: Set<string> }}
 */
export function fitFor(char, side, tree, overrides = {}) {
  const fit = { bannedIds: [], softBannedIds: [], bannedTraits: new Set() };
  for (const rule of FIT_RULES) {
    if (rule.side !== side || !isBlocked(rule, char, overrides)) continue;
    if (rule.kind === 'trait') {
      fit.bannedTraits.add(rule.target);
      continue;
    }
    const node = tree.findByName(rule.target);
    if (node) (rule.soft ? fit.softBannedIds : fit.bannedIds).push(node.id);
  }
  return fit;
}


/** 根据当前名单生成规则说明。 */
export function describeRule(rule, roster, overrides = {}) {
  if (!isRuleEnabled(rule, overrides)) return '规则已关闭，名单会保留，重新开启后生效。';
  const blocked = roster.filter((c) => isListedBlocked(rule, c, overrides));
  const allowed = roster.filter((c) => !isListedBlocked(rule, c, overrides));
  const list = (chars) => chars.map((c) => c.name).join('、');
  const label = rule.side === 'hunter' ? '监管者' : '求生者';
  let text;
  if (!blocked.length) text = `所有${label}都可以抽到。`;
  else if (!allowed.length) text = `所有${label}都不会抽到。`;
  else if (rule.summary && !overrides[rule.id]?.toggled?.length) text = rule.summary;
  else if (blocked.length <= allowed.length) text = `${list(blocked)}不会抽到。`;
  else text = `只有${list(allowed)}会抽到。`;
  return rule.note && allowed.length < roster.length ? `${text}${rule.note}` : text;
}

/** 这套人格是否违反限制。软限制的人格只有作为已点亮后续人格的前置时才算合规。 */
export function buildViolatesFit(tree, build, fit) {
  const lit = (id) => Boolean(build.levels[id]);
  if (fit.bannedIds.some(lit)) return true;
  return fit.softBannedIds.some((id) => lit(id)
    && !tree.talents.some((n) => n.prerequisite_id === id && lit(n.id)));
}
