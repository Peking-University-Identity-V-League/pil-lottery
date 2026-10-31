import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { normalizeUltimateWeights, prepareTree, rollBuild } from '../js/rules.js';
const trees = JSON.parse(await readFile(new URL('../talent-trees.json', import.meta.url), 'utf8'));
const tree = prepareTree(trees.trees.survivor);
test('large finite weights cannot select a zero-weight outcome', () => {
  const weights = normalizeUltimateWeights([1e308, 1e308, 0]);
  for (const value of [0, 0.25, 0.5, 0.75, 1 - Number.EPSILON]) {
    const build = rollBuild(tree, { ultimateWeights: weights }, () => value);
    assert.ok(build.ultimates.length < 2);
  }
});
test('single positive weights preserve zero-probability outcomes at float boundaries', () => {
  for (let k = 0; k <= 2; k++) {
    const weights = [0, 0, 0]; weights[k] = Number.MAX_VALUE;
    for (const value of [0, 0.5, 1 - Number.EPSILON]) {
      assert.equal(rollBuild(tree, { ultimateWeights: weights }, () => value).ultimates.length, k);
    }
  }
});
