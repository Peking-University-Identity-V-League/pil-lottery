import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MAX_LAYERS, RANDOM_ULTIMATE_WEIGHTS, normalizeUltimateWeights, prepareTree, rollBuild, validateBuild } from '../js/rules.js';
import {
  FIT_RULES, buildViolatesFit, describeRule, fitFor, isBlocked, isListedBlocked, isRuleModified, normalizeName, setRuleEnabled, toggleCharacter,
} from '../js/fit-rules.js';

const read = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
const chars = await read('characters.json');
const raw = await read('talent-trees.json');
const traits = (await read('auxiliary-traits.json')).traits;
const trees = { survivor: prepareTree(raw.trees.survivor), hunter: prepareTree(raw.trees.hunter) };
const roster = { survivor: chars.survivors, hunter: chars.hunters };
const rule = (target) => FIT_RULES.find((r) => r.target === target);
const char = (side, name) => roster[side].find((c) => normalizeName(c.name) === name);
const names = (list) => list.map((c) => normalizeName(c.name)).sort();
const ROUNDS = 400;

test('角色属性与给定名单一致', () => {
  assert.deepEqual(names(chars.survivors.filter((c) => c.fixed_item)),
    '盲女 祭司 先知 勘探员 咒术师 野人 邮差 囚徒 小说家 小女孩 教授 作曲家 木偶师 幻灯师 斗牛士 杂技演员 心理学家 入殓师 玩具商 拉拉队员'.split(' ').sort());
  assert.deepEqual(names(chars.hunters.filter((c) => c.has_weak_skill)),
    '鹿头 杰克 蜘蛛 疯眼 26号守卫 雕刻家 破轮 记录员 愚人金 杂货商 女王蜂 牙医 心兽'.split(' ').sort());
  for (const c of chars.survivors) assert.equal(typeof c.fixed_item, 'boolean', c.name);
  for (const c of chars.hunters) assert.equal(typeof c.has_weak_skill, 'boolean', c.name);
});

test('规则的目标和名单都能匹配到真实数据', () => {
  for (const r of FIT_RULES) {
    if (r.kind === 'trait') assert.ok(traits.some((t) => t.name === r.target), r.target);
    else assert.ok(trees[r.side].findByName(r.target), r.target);
  }
  const blockedNames = (target) => names(chars.hunters.filter((c) => isBlocked(rule(target), c)));
  assert.deepEqual(blockedNames('嬉弄'), ['博士']);
  assert.deepEqual(blockedNames('兴奋'), ['博士']);
  assert.deepEqual(blockedNames('张狂'), ['博士', '摄影师', '红夫人'].sort());
  assert.deepEqual(names(chars.hunters.filter((c) => !isBlocked(rule('追猎'), c))),
    ['厂长', '摄影师', '梦之女巫', '疯眼', '时空之影'].sort());
});

test('每名角色的配置都符合适配规则和基础规则', () => {
  for (const side of ['survivor', 'hunter']) {
    const tree = trees[side];
    for (const c of roster[side]) {
      const fit = fitFor(c, side, tree);
      for (const setting of ['random', 0, 1, 2]) {
        for (let i = 0; i < ROUNDS; i++) {
          const build = rollBuild(tree, { ultimateSetting: setting, ...fit });
          assert.deepEqual(validateBuild(tree, build), [], c.name);
          assert.equal(build.used, MAX_LAYERS, c.name);
          assert.equal(buildViolatesFit(tree, build, fit), false, `${c.name} ${JSON.stringify(build.levels)}`);
          if (setting !== 'random') assert.equal(build.ultimates.length, setting, c.name);
        }
      }
    }
  }
});

test('无弱技能的监管者仍可通过巨钳或拘禁狂解锁临界点', () => {
  const tree = trees.hunter;
  const c = char('hunter', '厂长');
  const fit = fitFor(c, 'hunter', tree);
  const point = tree.findByName('临界点').id;
  let unlocked = 0;
  for (let i = 0; i < 3000; i++) if (rollBuild(tree, fit).levels[point]) unlocked++;
  assert.ok(unlocked > 0);
  assert.deepEqual(fit.softBannedIds, [point]);
});

test('规则默认生效的角色确实抽不到，可抽到的角色确实会抽到', () => {
  const tree = trees.survivor;
  const id = tree.findByName('应急储备').id;
  const count = (c) => {
    const fit = fitFor(c, 'survivor', tree);
    let n = 0;
    for (let i = 0; i < 3000; i++) if (rollBuild(tree, fit).levels[id]) n++;
    return n;
  };
  assert.equal(count(char('survivor', '盲女')), 0);
  assert.ok(count(char('survivor', '医生')) > 0);
});

test('总开关和逐个角色调整都生效，回到默认后不留记录', () => {
  const r = rule('应急储备');
  const blind = char('survivor', '盲女');
  let o = setRuleEnabled(r, false, {});
  assert.equal(isBlocked(r, blind, o), false);
  assert.equal(isRuleModified(r, o), true);
  o = setRuleEnabled(r, true, o);
  assert.deepEqual(o, {});
  o = toggleCharacter(r, blind.id, {});
  assert.equal(isBlocked(r, blind, o), false);
  o = toggleCharacter(r, blind.id, o);
  assert.deepEqual(o, {});
  const doctor = char('survivor', '医生');
  assert.equal(isBlocked(r, doctor, toggleCharacter(r, doctor.id, {})), true);
});

test('关闭规则后可以抽到原本被排除的人格', () => {
  const tree = trees.hunter;
  const c = char('hunter', '博士');
  const r = rule('张狂');
  const fit = fitFor(c, 'hunter', tree, setRuleEnabled(r, false, {}));
  const id = tree.findByName('张狂').id;
  let n = 0;
  for (let i = 0; i < 500; i++) if (rollBuild(tree, { ultimateSetting: 2, ...fit }).levels[id]) n++;
  assert.ok(n > 0);
});

test('规则说明跟随名单和开关变化', () => {
  const r = rule('嬉弄');
  const list = chars.hunters;
  const doctor = char('hunter', '博士');
  const clown = char('hunter', '小丑');
  assert.equal(describeRule(r, list), '“博士”不会抽到。');
  assert.equal(describeRule(r, list, toggleCharacter(r, clown.id, {})), '小丑、“博士”不会抽到。');
  assert.equal(describeRule(r, list, toggleCharacter(r, doctor.id, {})), '所有监管者都可以抽到。');
  assert.match(describeRule(r, list, setRuleEnabled(r, false, {})), /规则已关闭/);
  assert.equal(describeRule(rule('追猎'), list), '只有厂长、摄影师、疯眼、梦之女巫、时空之影会抽到。');
  assert.equal(describeRule(rule('临界点'), list), '只有技能伤害小于普通攻击的监管者才会抽到。抽到巨钳或拘禁狂时仍会解锁。');
  const edited = toggleCharacter(rule('应急储备'), char('survivor', '盲女').id, {});
  const blocked = chars.survivors.filter((c) => isListedBlocked(rule('应急储备'), c, edited)).map((c) => c.name);
  assert.equal(blocked.length, 19);
  assert.equal(describeRule(rule('应急储备'), chars.survivors, edited), `${blocked.join('、')}不会抽到。`);
  // 增加角色后按名单顺序列出名字，不会变成数字
  let chase = {};
  for (const added of list.filter((c) => isListedBlocked(rule('追猎'), c, {})).slice(0, 6)) {
    chase = toggleCharacter(rule('追猎'), added.id, chase);
    const names = list.filter((c) => !isListedBlocked(rule('追猎'), c, chase)).map((c) => c.name);
    assert.equal(describeRule(rule('追猎'), list, chase), `只有${names.join('、')}会抽到。`);
  }
});

test('随机最终天赋默认各 1/3，也可以自定义', () => {
  const tree = trees.survivor;
  const count = (ultimateWeights) => {
    const out = [0, 0, 0];
    for (let i = 0; i < 3000; i++) out[rollBuild(tree, { ultimateSetting: 'random', ultimateWeights }).ultimates.length]++;
    return out;
  };
  for (const n of count(undefined)) assert.ok(n > 850 && n < 1150, `默认分布 ${n}`);
  assert.deepEqual(count([0, 0, 1]), [0, 0, 3000]);
  const [none, one, two] = count([1, 0, 3]);
  assert.equal(one, 0);
  assert.ok(two > none * 2);
  assert.deepEqual(RANDOM_ULTIMATE_WEIGHTS, [1, 1, 1]);
  assert.equal(normalizeUltimateWeights([0, 0, 0]), null);
  assert.equal(normalizeUltimateWeights([1, -1, 1]), null);
  assert.equal(normalizeUltimateWeights([1, 2]), null);
  assert.deepEqual(normalizeUltimateWeights([1, 2, 3]), [1, 2, 3]);
});
