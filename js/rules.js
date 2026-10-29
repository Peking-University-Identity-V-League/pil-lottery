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

/**
 * 终极人格数量设为“随机”时的权重：[0 个, 1 个, 2 个]。
 * 实战中带 2 个终极人格最常见，所以略微偏向 2 个。
 */
export const RANDOM_ULTIMATE_WEIGHTS = [20, 35, 45];

function weightedIndex(weights, rng) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

/**
 * 随机生成一套人格。
 *
 * 分配思路（“按分支点到底”）：
 *   1. 先抽出 k 个终极人格，把从中心到它们的整条路径点满；
 *   2. 再把“必带”人格（如绝处逢生）的路径点满；
 *   3. 剩余层数按轮分配：每轮从所有“非终极、未点满”的人格里等概率抽一个目标，
 *      沿中心到目标的路径依次点满。于是每轮都会长出一条完整的小分支，
 *      而不是一层一层均匀往外扩散。
 *      树的每个方向上，第 1 圈 1 个、第 2 圈 3 个、第 3 圈 5 个人格，
 *      等概率抽目标天然更常把分支点到末梢。
 *   4. 最后一轮如果剩余层数不够点完整条路径，就沿路径能点多少点多少，
 *      可能留下一个未满级的人格（游戏里同样合法），不做“优先挑放得下的”这种偏置。
 *
 * @param tree             prepareTree 的结果
 * @param ultimateSetting  'random' | 0 | 1 | 2
 * @param requiredIds      必须点亮的人格（会连同前置路径一起点满）
 * @returns {{ levels: Record<string, number>, used: number, ultimates: string[] }}
 */
export function rollBuild(tree, { ultimateSetting = 'random', requiredIds = [] } = {}, rng = createRng()) {
  const k = ultimateSetting === 'random'
    ? weightedIndex(RANDOM_ULTIMATE_WEIGHTS, rng)
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

  // 随机部分：沿路径依次点，预算用完就停；前一个没点满时不会继续往后点
  const investPath = (id) => {
    for (const n of pathTo(id)) {
      const add = Math.min(n.max_level - cur(n.id), MAX_LAYERS - used);
      if (add > 0) {
        levels.set(n.id, cur(n.id) + add);
        used += add;
      }
      if (cur(n.id) < n.max_level) return;
    }
  };

  const ultimates = sample(tree.ultimateIds, k, rng);
  ultimates.forEach(unlockPath);
  requiredIds.filter((id) => tree.byId.has(id)).forEach(unlockPath);

  if (used > MAX_LAYERS) throw new Error(`固定人格需要 ${used} 层，超过上限 ${MAX_LAYERS} 层`);

  while (used < MAX_LAYERS) {
    const targets = tree.talents.filter((n) => !n.is_ultimate && cur(n.id) < n.max_level);
    if (!targets.length) break;
    investPath(pickOne(targets, rng).id); // 每轮至少点 1 层，循环必然结束
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
