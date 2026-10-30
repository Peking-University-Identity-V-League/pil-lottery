// 抽取规则：纯逻辑，不依赖 DOM。
// 人格规则（BWIKI 已核对）：
//   - 每层人格 5 点，每人最多 130 点 = 26 层；
//   - 前置人格必须点满，后续人格才能解锁（例：韦伯定律需要 3 点祸福相依）；
//   - 四个方向最外侧为终极人格，最多携带 2 个。

export const POINTS_PER_LAYER = 5;
export const MAX_POINTS = 130;
export const MAX_LAYERS = MAX_POINTS / POINTS_PER_LAYER; // 26
export const MAX_ULTIMATES = 2;

/** 基于 crypto 的随机数，返回 [0, 1)。 */
export function createRng() {
  const buf = new Uint32Array(1);
  return () => {
    crypto.getRandomValues(buf);
    return buf[0] / 4294967296;
  };
}

export const pickOne = (arr, rng) => arr[Math.floor(rng() * arr.length)];

/** 不放回抽样 k 个（Fisher–Yates）。 */
export function sample(arr, k, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

/**
 * 把 talent-trees.json 里的一棵树整理成便于查询的结构。
 * @param raw   trees.survivor / trees.hunter
 * @param descs 可选：{ [nodeId]: 描述文本 }
 */
export function prepareTree(raw, descs = {}) {
  const byId = new Map(raw.nodes.map((n) => [n.id, { ...n }]));
  const depthOf = (id) => {
    let d = 0;
    for (let n = byId.get(id); n && !n.is_center; n = byId.get(n.prerequisite_id)) d++;
    return d;
  };
  for (const n of byId.values()) {
    n.depth = n.is_center ? 0 : depthOf(n.id);
    n.desc = descs[n.id] || '';
  }
  const talents = [...byId.values()].filter((n) => !n.is_center);
  return {
    byId,
    talents,
    edges: raw.edges,
    ultimateIds: talents.filter((n) => n.is_ultimate).map((n) => n.id),
    findByName: (name) => talents.find((n) => n.name === name) || null,
  };
}

/** 终极人格数量设为“随机”时的默认权重：[0 个, 1 个, 2 个]，主办方可以自定义。 */
export const RANDOM_ULTIMATE_WEIGHTS = [1, 1, 1];

/** 权重必须是 3 个非负数且不能全为 0；否则返回 null。 */
export function normalizeUltimateWeights(weights) {
  if (!Array.isArray(weights) || weights.length !== RANDOM_ULTIMATE_WEIGHTS.length) return null;
  if (!weights.every((w) => Number.isFinite(w) && w >= 0)) return null;
  return weights.some((w) => w > 0) ? [...weights] : null;
}

/**
 * 抽中一个多层人格作为目标时，目标层数的权重：[1 层, 2 层, 3 层]。
 * 默认等概率；如果已经点了一部分，只在更高的层数里按对应权重抽。
 */
export const TARGET_LEVEL_WEIGHTS = [1, 1, 1];

function weightedIndex(weights, rng) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

/** 在 (当前层数, 最高层数] 中按 TARGET_LEVEL_WEIGHTS 抽一个目标层数。 */
function rollTargetLevel(node, current, rng) {
  if (node.max_level - current <= 1) return node.max_level;
  const levels = [];
  for (let lv = current + 1; lv <= node.max_level; lv++) levels.push(lv);
  const weights = levels.map((lv) => TARGET_LEVEL_WEIGHTS[lv - 1] ?? 1);
  return levels[weightedIndex(weights, rng)];
}

/**
 * 随机生成一套人格。
 *
 * 分配思路（“按分支生长”）：
 *   1. 先抽出 k 个终极人格，把从中心到它们的整条路径点满；
 *   2. 再把“必带”人格（如绝处逢生）的路径点满；
 *   3. 剩余层数按轮分配：每轮从所有“非终极、未点满”的人格里等概率抽一个目标，
 *      再为目标抽一个层数（多层人格按 TARGET_LEVEL_WEIGHTS 抽 1～3 层），
 *      然后沿中心到目标的路径点：路径上的前置人格按规则必须点满，目标点到抽中的层数。
 *      于是每轮长出一条小分支；分支末端可能停在任意层数，
 *      未满级的人格可以出现在多个位置，之后若有目标经过它，会先把它补满。
 *   4. 剩余层数不够时，沿路径能点多少点多少，同样合法。
 *
 * @param tree             prepareTree 的结果
 * @param ultimateSetting  'random' | 0 | 1 | 2
 * @param ultimateWeights  “随机”时 0、1、2 个终极人格的权重
 * @param requiredIds      必须点亮的人格（会连同前置路径一起点满）
 * @param bannedIds        不会抽到的人格，路径经过它们的目标也不会被选中
 * @param softBannedIds    不会被主动抽中，但作为后续人格的前置时仍会点亮
 * @returns {{ levels: Record<string, number>, used: number, ultimates: string[] }}
 */
export function rollBuild(tree, { ultimateSetting = 'random', ultimateWeights = RANDOM_ULTIMATE_WEIGHTS, requiredIds = [], bannedIds = [], softBannedIds = [] } = {}, rng = createRng()) {
  const k = ultimateSetting === 'random'
    ? weightedIndex(ultimateWeights, rng)
    : Math.max(0, Math.min(MAX_ULTIMATES, Number(ultimateSetting) || 0));

  const levels = new Map();
  let used = 0;
  const cur = (id) => levels.get(id) || 0;
  const node = (id) => tree.byId.get(id);

  const pathTo = (id) => {
    const chain = [];
    for (let n = node(id); n && !n.is_center; n = node(n.prerequisite_id)) chain.unshift(n);
    return chain;
  };

  // 固定部分：整条路径无条件点满（之后统一检查是否超限）
  const unlockPath = (id) => {
    for (const n of pathTo(id)) {
      used += n.max_level - cur(n.id);
      levels.set(n.id, n.max_level);
    }
  };

  // 随机部分：前置人格点满，目标点到 targetLevel；预算用完就停，前一个没点满时不会继续往后点
  const investPath = (id, targetLevel) => {
    const chain = pathTo(id);
    chain.forEach((n, i) => {
      if (i > 0 && cur(chain[i - 1].id) < chain[i - 1].max_level) return;
      const goal = i === chain.length - 1 ? targetLevel : n.max_level;
      const add = Math.min(goal - cur(n.id), MAX_LAYERS - used);
      if (add > 0) {
        levels.set(n.id, cur(n.id) + add);
        used += add;
      }
    });
  };

  const banned = new Set(bannedIds);
  const softBanned = new Set(softBannedIds);

  // 目标是否可选：路径不经过被禁的人格；若要经过尚未解锁的软限制人格，
  // 剩余层数必须够点到目标本身，否则会留下一个孤立的软限制人格。
  const canTarget = (target) => {
    if (target.is_ultimate || cur(target.id) >= target.max_level) return false;
    if (banned.has(target.id) || softBanned.has(target.id)) return false;
    const before = pathTo(target.id).slice(0, -1);
    if (before.some((n) => banned.has(n.id))) return false;
    if (!before.some((n) => softBanned.has(n.id) && !cur(n.id))) return true;
    const cost = before.reduce((sum, n) => sum + n.max_level - cur(n.id), 0);
    return MAX_LAYERS - used > cost;
  };

  const ultimates = sample(tree.ultimateIds.filter((id) => !banned.has(id)), k, rng);
  ultimates.forEach(unlockPath);
  requiredIds.filter((id) => tree.byId.has(id)).forEach(unlockPath);

  if (used > MAX_LAYERS) throw new Error(`固定人格需要 ${used} 层，超过上限 ${MAX_LAYERS} 层`);

  while (used < MAX_LAYERS) {
    const targets = tree.talents.filter(canTarget);
    if (!targets.length) break;
    const target = pickOne(targets, rng);
    // 目标未满级，目标层数 > 当前层数；路径上第一个未满的节点至少会点 1 层，循环必然结束
    investPath(target.id, rollTargetLevel(target, cur(target.id), rng));
  }

  return { levels: Object.fromEntries(levels), used, ultimates };
}

/** 校验一套人格是否合规，返回问题列表（空数组表示合规）。用于自检。 */
export function validateBuild(tree, build) {
  const problems = [];
  let total = 0;
  let ults = 0;
  for (const [id, lv] of Object.entries(build.levels)) {
    const n = tree.byId.get(id);
    if (!n) { problems.push(`未知人格 ${id}`); continue; }
    if (lv < 1 || lv > n.max_level) problems.push(`${n.name} 层数 ${lv} 越界`);
    const pre = tree.byId.get(n.prerequisite_id);
    if (!pre.is_center && (build.levels[pre.id] || 0) < pre.max_level) problems.push(`${n.name} 的前置 ${pre.name} 未点满`);
    if (n.is_ultimate) ults++;
    total += lv;
  }
  if (total > MAX_LAYERS) problems.push(`共 ${total} 层，超过 ${MAX_LAYERS} 层`);
  if (ults > MAX_ULTIMATES) problems.push(`终极人格 ${ults} 个，超过 ${MAX_ULTIMATES} 个`);
  return problems;
}
