import { sfx } from './sound.js';
import {
  RANDOM_ULTIMATE_WEIGHTS, createRng, normalizeUltimateWeights, pickOne, sample, prepareTree, rollBuild, validateBuild,
} from './rules.js';
import {
  FIT_RULES, buildViolatesFit, describeRule, fitFor, isListedBlocked, isRuleEnabled, isRuleModified, setRuleEnabled, toggleCharacter,
} from './fit-rules.js';
import { createLiveHost, liveLink } from './live-host.js';
import {
  DEFAULT_VISIBILITY, LIVE_VIEWS, VISIBILITY_OPTIONS, VISIBILITY_TOGGLES, activeToggles, toggleVisibility,
} from './live-visibility.js';
import {
  applyPortraitView, asset, cleanDescription, el, renderWeb, showTreeDialog, splitBuild, talentItems,
} from './shared-ui.js';

/* ------------------------------------------------------------------ 基础 */

const $ = (sel, root = document) => root.querySelector(sel);
const STORE_KEY = 'pil-lottery:v1';
const ORDINALS = ['第一位', '第二位', '第三位', '第四位'];
const DESPAIR = '绝处逢生';
const STEP = 140; // 人格树每一圈点亮的间隔（毫秒），同步到 CSS 变量 --step
const SEP = '　'; // 复制结果里的分隔符（全角空格）
const rng = createRng();
const track = (...args) => window.pilLotteryTrack?.(...args);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

document.documentElement.style.setProperty('--step', `${STEP}ms`);

/* ------------------------------------------------------------------ 设置 */

const DEFAULTS = {
  survivorUlt: 'random',
  hunterUlt: 'random',
  despair: false,
  drawTrait: true,
  sound: true,
  excluded: { survivor: [], hunter: [], trait: [] },
  fit: {},
  ultWeights: { survivor: RANDOM_ULTIMATE_WEIGHTS, hunter: RANDOM_ULTIMATE_WEIGHTS },
};

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { /* 隐私模式等 */ }
  return {
    ...DEFAULTS,
    ...saved,
    excluded: { ...DEFAULTS.excluded, ...(saved.excluded || {}) },
    fit: saved.fit || {},
    ultWeights: {
      survivor: normalizeUltimateWeights(saved.ultWeights?.survivor) || RANDOM_ULTIMATE_WEIGHTS,
      hunter: normalizeUltimateWeights(saved.ultWeights?.hunter) || RANDOM_ULTIMATE_WEIGHTS,
    },
  };
}

const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* 忽略 */ }
}

/* ------------------------------------------------------------------ 数据 */

const data = { survivors: [], hunters: [], traits: [], trees: {} };

async function getJSON(url) {
  const res = await fetch(asset(url));
  if (!res.ok) throw new Error(`${url} 返回 HTTP ${res.status}`);
  return res.json();
}

async function loadData() {
  const [chars, trees, traits, config] = await Promise.all([
    getJSON('characters.json'),
    getJSON('talent-trees.json'),
    getJSON('auxiliary-traits.json'),
    getJSON('tree-config-source.json').catch(() => null), // 只用来补人格描述，缺了也能用
  ]);
  const descriptions = (side) => {
    const out = {};
    for (const n of config?.[side]?.treeData?.nodes || []) {
      if (n.content) out[n.id] = cleanDescription(n.content);
    }
    return out;
  };
  data.survivors = chars.survivors;
  data.hunters = chars.hunters;
  data.traits = traits.traits;
  data.trees.survivor = prepareTree(trees.trees.survivor, descriptions('survivor'));
  data.trees.hunter = prepareTree(trees.trees.hunter, descriptions('hunter'));
}

/* ------------------------------------------------------------------ 角色池 */

const POOL_SOURCE = {
  survivor: () => data.survivors,
  hunter: () => data.hunters,
  trait: () => data.traits,
};
const POOL_MIN = { survivor: 4, hunter: 1, trait: 1 };
const keyOf = (kind, item) => (kind === 'trait' ? item.name : item.id);

function pool(kind) {
  const excluded = new Set(settings.excluded[kind]);
  return POOL_SOURCE[kind]().filter((item) => !excluded.has(keyOf(kind, item)));
}

function poolProblem() {
  if (pool('survivor').length < POOL_MIN.survivor) return '卡池里至少要留 4 名求生者，才能凑齐一局。';
  if (pool('hunter').length < POOL_MIN.hunter) return '卡池里至少要留 1 名监管者。';
  if (settings.drawTrait && pool('trait').length < POOL_MIN.trait) return '卡池里至少要留 1 个辅助特质，或关闭“抽取辅助特质”。';
  return null;
}

/* ------------------------------------------------------------------ 抽取 */

let match = null; // { slots: [{ side, char, build, trait? }], at: Date }，前 4 个求生者，最后 1 个监管者；trait 为 null 表示自选

const charFit = (char, side) => fitFor(char, side, data.trees[side], settings.fit);

/** 这名监管者可以抽到的辅助特质。 */
function traitsFor(char) {
  const { bannedTraits } = charFit(char, 'hunter');
  return pool('trait').filter((t) => !bannedTraits.has(t.name));
}

/** 抽一个辅助特质；关闭抽取或没有可选特质时返回 null（自选）。 */
function pickTrait(char, exclude = null) {
  if (!settings.drawTrait) return null;
  const candidates = traitsFor(char);
  if (!candidates.length) return null;
  const others = candidates.filter((t) => t.name !== exclude);
  return pickOne(others.length ? others : candidates, rng);
}

function rollFor(side, char) {
  const tree = data.trees[side];
  const requiredIds = [];
  if (side === 'survivor' && settings.despair) {
    const node = tree.findByName(DESPAIR);
    if (node) requiredIds.push(node.id);
  }
  const ultimateSetting = side === 'survivor' ? settings.survivorUlt : settings.hunterUlt;
  const { bannedIds, softBannedIds } = charFit(char, side);
  const build = rollBuild(tree, { ultimateSetting, ultimateWeights: settings.ultWeights[side], requiredIds, bannedIds, softBannedIds }, rng);
  const problems = validateBuild(tree, build);
  if (problems.length) console.warn('人格校验未通过', problems, build);
  return build;
}

const imageLoads = new Map();

function preload(path, { priority = 'auto' } = {}) {
  const url = asset(path);
  if (imageLoads.has(url)) return imageLoads.get(url);
  const ready = new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.fetchPriority = priority;
    img.onload = () => resolve(true);
    img.onerror = () => { imageLoads.delete(url); resolve(false); };
    img.src = url;
  });
  imageLoads.set(url, ready);
  return ready;
}

/** 首屏控件就绪后后台加载全部图片，限制并发，避免争抢当前抽取的资源。 */
async function warmAllImages() {
  const paths = new Set([
    ...data.survivors.map((char) => char.portrait),
    ...data.hunters.map((char) => char.portrait),
    ...data.traits.map((trait) => trait.icon.local_path),
  ]);
  for (const tree of Object.values(data.trees)) {
    for (const node of tree.byId.values()) {
      if (node.icon?.local_path) paths.add(node.icon.local_path);
    }
  }
  const queue = [...paths];
  const status = document.documentElement.dataset;
  status.imagePreload = 'loading';
  status.imagePreloadTotal = String(queue.length);
  status.imagePreloaded = '0';
  let cursor = 0;
  let loaded = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const path = queue[cursor++];
      if (await preload(path, { priority: 'low' })) loaded++;
      status.imagePreloaded = String(loaded);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  status.imagePreload = loaded === queue.length ? 'complete' : 'partial';
}

function newMatch() {
  const survivors = sample(pool('survivor'), 4, rng);
  const hunter = pickOne(pool('hunter'), rng);
  const trait = pickTrait(hunter);
  if (settings.drawTrait && !trait) toast(`${hunter.name}没有可抽的辅助特质，改为自选。`);
  const slots = [
    ...survivors.map((char) => ({ side: 'survivor', char, build: rollFor('survivor', char) })),
    { side: 'hunter', char: hunter, build: rollFor('hunter', hunter), trait },
  ];
  slots.forEach((s) => preload(s.char.portrait));
  return { slots, at: new Date() };
}

/* ------------------------------------------------------------------ 动画调度 */

let busy = false;
let skipping = false;
let instantFrame = 0;
const running = new Set();
const skipHooks = new Set();
const cardMotions = new Set();

/** 可被“跳过”打断的等待。 */
function wait(ms) {
  return new Promise((resolve) => {
    if (skipping || ms <= 0) { resolve(); return; }
    const hook = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { skipHooks.delete(hook); resolve(); }, ms);
    skipHooks.add(hook);
  });
}

/** Web Animations 的薄封装：默认保留终态，跳过时直接到终点。 */
function play(node, keyframes, options) {
  const anim = node.animate(keyframes, { fill: 'forwards', ...options });
  running.add(anim);
  if (skipping) anim.finish();
  return anim.finished.then(() => {}, () => {}).finally(() => running.delete(anim));
}

/** 卡片位移只保留显式终态，不留下叠加的 forwards 动画。 */
function moveCard(card, keyframes, options) {
  const anim = card.animate(keyframes, { fill: 'forwards', ...options });
  cardMotions.add(anim);
  running.add(anim);
  if (skipping) anim.finish();
  return anim.finished.then(() => {
    // 统一复位后，即使完成回调才抵达，也不能把旧位置写回来。
    if (cardMotions.has(anim)) card.style.transform = keyframes[keyframes.length - 1].transform;
  }, () => {}).finally(() => {
    anim.cancel();
    cardMotions.delete(anim);
    running.delete(anim);
  });
}

/** 只清理本流程持有的卡片动画；火漆等后代动画保留各自的终态。 */
function resetCardMotion() {
  const motions = [...cardMotions];
  cardMotions.clear();
  for (const anim of motions) {
    running.delete(anim);
    anim.cancel();
  }
  for (const { card } of slots) {
    card.style.removeProperty('transform');
    card.style.removeProperty('z-index');
    card.classList.remove('is-charging');
  }
}

/** 只在未跳过时播放音效。 */
function say(name, ...args) {
  if (!skipping) sfx[name](...args);
}

function later(ms, fn) {
  wait(ms).then(() => { if (!skipping) fn(); });
}

function skip() {
  if (!busy || skipping) return;
  skipping = true;
  track('lottery_skip_animation');
  document.body.classList.add('instant');
  for (const anim of [...running]) { try { anim.finish(); } catch { /* 已结束 */ } }
  for (const hook of [...skipHooks]) hook();
  skipHooks.clear();
}

async function sequence(task) {
  cancelAnimationFrame(instantFrame);
  busy = true;
  skipping = reduceMotion.matches;
  document.body.classList.toggle('instant', skipping);
  syncButtons();
  try {
    await task();
  } catch (err) {
    console.error(err);
    toast(`抽取时出错：${err.message}`);
  } finally {
    resetCardMotion();
    // 动画类只在播放期间存在，避免移除 .instant 后重播
    document.querySelectorAll('.lighting').forEach((n) => n.classList.remove('lighting'));
    liveShown = null;
    syncLive('done');
    busy = false;
    skipping = false;
    instantFrame = requestAnimationFrame(() => {
      instantFrame = requestAnimationFrame(() => document.body.classList.remove('instant'));
    });
    syncButtons();
  }
}

/* ------------------------------------------------------------------ 桌面 */

const slots = [];

function buildTable() {
  const table = $('#table');
  const survivorSide = el('section', 'lineup lineup-survivor');
  survivorSide.setAttribute('aria-label', '求生者');
  const hunterSide = el('section', 'lineup lineup-hunter');
  hunterSide.setAttribute('aria-label', '监管者');
  const divider = el('div', 'divider');
  divider.setAttribute('aria-hidden', 'true');

  for (let i = 0; i < 5; i++) {
    const slot = createSlot(i);
    slots.push(slot);
    (slot.side === 'survivor' ? survivorSide : hunterSide).append(slot.root);
  }
  table.replaceChildren(survivorSide, divider, hunterSide);
  slots.forEach((slot) => { setPanelPending(slot); resetTrait(slot); });
}

function createSlot(index) {
  const side = index < 4 ? 'survivor' : 'hunter';
  const hunter = side === 'hunter';
  const root = el('div', `slot slot-${side} side-${side}`);
  root.innerHTML = `
    <div class="card">
      <div class="card-inner">
        <div class="face face-envelope" aria-hidden="true">
          <span class="env-flap"></span>
          <span class="env-fold"></span>
          <span class="seal">
            <span class="seal-half seal-l"><span class="seal-face">${hunter ? '屠' : '人'}</span></span>
            <span class="seal-half seal-r"><span class="seal-face">${hunter ? '屠' : '人'}</span></span>
          </span>
          <span class="env-address">${hunter ? '监管者' : `${ORDINALS[index]}求生者`}</span>
        </div>
        <div class="face face-letter">
          <img class="portrait" alt="" decoding="async">
          <ul class="roles" aria-label="定位"></ul>
          <h3 class="name"></h3>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <span class="panel-title">人格</span>
        <button type="button" class="panel-copy">复制人格树</button>
      </div>
      ${hunter ? `
      <div class="trait">
        <span class="trait-icon"><img alt=""></span>
        <span class="trait-text"><span class="trait-label">辅助特质</span><b class="trait-name"></b></span>
      </div>` : ''}
      <button type="button" class="web-btn" aria-label="查看完整人格树">
        <svg class="web" viewBox="-372 -372 744 744" aria-hidden="true"></svg>
      </button>
      <ul class="talent-list"></ul>
      <div class="slot-actions">
        <button type="button" class="btn btn-mini" data-act="char">换角色</button>
        <button type="button" class="btn btn-mini" data-act="build">换人格</button>
        ${hunter ? '<button type="button" class="btn btn-mini" data-act="trait">换特质</button>' : ''}
      </div>
    </div>`;

  const slot = {
    index,
    side,
    root,
    card: $('.card', root),
    seal: $('.seal', root),
    sealHalves: [$('.seal-l', root), $('.seal-r', root)],
    portrait: $('.portrait', root),
    roles: $('.roles', root),
    name: $('.name', root),
    panel: $('.panel', root),
    webBtn: $('.web-btn', root),
    web: $('.web', root),
    list: $('.talent-list', root),
    traitBox: $('.trait', root),
    traitImg: $('.trait-icon img', root),
    traitName: $('.trait-name', root),
  };

  slot.webBtn.addEventListener('click', () => openTree(slot));
  $('.panel-copy', root).addEventListener('click', () => copyTreeImage(slot));
  $('.slot-actions', root).addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act || busy || !match) return;
    if (act === 'char') rerollCharacter(slot);
    if (act === 'build') rerollBuild(slot);
    if (act === 'trait') rerollTrait(slot);
  });
  return slot;
}

function fillLetter(slot, entry) {
  const { char } = entry;
  applyPortraitView(slot.portrait, char);
  slot.portrait.src = asset(char.portrait);
  slot.portrait.alt = `${char.name}立绘`;
  slot.name.textContent = char.name;
  slot.roles.replaceChildren(
    ...(slot.side === 'survivor' ? (char.roles || []).map((r) => el('li', '', r)) : []),
  );
}

function setPanelPending(slot) {
  slot.panel.classList.add('pending');
  slot.panel.classList.remove('lighting');
  renderWeb(slot.web, data.trees[slot.side], null);
  slot.list.replaceChildren();
}

function fillPanel(slot, entry, animate) {
  const tree = data.trees[slot.side];
  slot.panel.classList.remove('pending');
  slot.panel.classList.toggle('lighting', animate);
  renderWeb(slot.web, tree, entry.build, { animate });
  slot.list.replaceChildren(...talentItems(tree, entry.build));
}

function resetTrait(slot) {
  if (!slot.traitBox) return;
  if (!settings.drawTrait) { showTraitFree(slot); return; }
  slot.traitBox.classList.remove('rolling', 'locked', 'is-free');
  slot.traitImg.removeAttribute('src');
  slot.traitName.textContent = '待揭晓';
}

function showTrait(slot, trait) {
  slot.traitBox.classList.remove('is-free');
  slot.traitImg.src = asset(trait.icon.local_path);
  slot.traitName.textContent = trait.name;
}

/** 关闭“抽取辅助特质”时：由监管者自己选择。 */
function showTraitFree(slot) {
  slot.traitBox.classList.remove('rolling', 'locked');
  slot.traitBox.classList.add('is-free');
  slot.traitImg.removeAttribute('src');
  slot.traitName.textContent = '自选';
}

/* ------------------------------------------------------------------ 人格树 SVG */

/** 揭晓后点亮人格面板，返回动画结束的 Promise。 */
function lightPanel(slot, entry, delay = 160) {
  return wait(delay).then(() => {
    const animate = !skipping;
    fillPanel(slot, entry, animate);
    liveReveal(slot.index, 'build');
    if (!animate) return undefined;
    const tree = data.trees[slot.side];
    const depths = [...new Set(Object.keys(entry.build.levels).map((id) => tree.byId.get(id).depth))].sort();
    depths.forEach((d, i) => later(d * STEP, () => sfx.light(i)));
    let ultEnd = 0;
    if (entry.build.ultimates.length) {
      const ultDepth = Math.max(...entry.build.ultimates.map((id) => tree.byId.get(id).depth));
      later(ultDepth * STEP + 80, () => sfx.ultimate());
      ultEnd = ultDepth * STEP + 1200; // 与 CSS web-burst 的时长对应
    }
    const listEnd = (slot.list.children.length - 1) * 35 + 900; // 与 CSS t-rise 对应
    return wait(Math.max(Math.max(0, ...depths) * STEP + 700, ultEnd, listEnd));
  });
}

/* ------------------------------------------------------------------ 信封动作 */

function resetSeal(slot) {
  for (const half of slot.sealHalves) half.getAnimations().forEach((a) => a.cancel());
  slot.seal.getAnimations().forEach((a) => a.cancel());
}

function crackSeal(slot) {
  say('crack');
  play(slot.seal, [{ transform: 'scale(1)' }, { transform: 'scale(1.14)' }, { transform: 'scale(1)' }], { duration: 160 });
  const [l, r] = slot.sealHalves;
  const opts = { duration: 520, delay: 90, easing: 'cubic-bezier(.2,.7,.3,1)' };
  play(l, [{ transform: 'none', opacity: 1 }, { transform: 'translate(-22px, 14px) rotate(-32deg)', opacity: 0 }], opts);
  play(r, [{ transform: 'none', opacity: 1 }, { transform: 'translate(20px, 18px) rotate(26deg)', opacity: 0 }], opts);
}

async function openCard(slot) {
  crackSeal(slot);
  await wait(200);
  say('flip');
  slot.card.classList.add('is-open');
  await wait(420);
  liveReveal(slot.index, 'char');
}

async function closeCard(slot) {
  resetSeal(slot);
  slot.card.classList.remove('is-open');
}

async function revealHunter(slot) {
  const { card } = slot;
  card.classList.add('is-charging');
  say('heartbeat');
  later(520, () => sfx.heartbeat());
  moveCard(card, [
    { transform: 'none' },
    { transform: 'translate(-2px, 1px) rotate(-.7deg)' },
    { transform: 'translate(2px, -1px) rotate(.7deg)' },
    { transform: 'translate(-1px, 1px) rotate(-.4deg)' },
    { transform: 'none' },
  ], { duration: 360, iterations: 3, fill: 'none' });
  await wait(1000);
  crackSeal(slot);
  await wait(180);
  say('flip');
  card.classList.add('is-open');
  await wait(260);
  liveReveal(slot.index, 'char');
  card.classList.remove('is-charging');
  say('boom');
  play($('#flash'), [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 0 }], { duration: 950, fill: 'none' });
  play($('#table'), [
    { transform: 'none' },
    { transform: 'translate(-6px, 3px)' },
    { transform: 'translate(5px, -4px)' },
    { transform: 'translate(-3px, 2px)' },
    { transform: 'translate(2px, -1px)' },
    { transform: 'none' },
  ], { duration: 460, easing: 'ease-out', fill: 'none' });
  await wait(320);
}

async function shuffleAndDeal() {
  // 测量布局前先归位，避免上一局的临时位移影响本局轨迹。
  resetCardMotion();
  const cards = slots.map((s) => s.card);
  const rects = cards.map((c) => c.getBoundingClientRect());
  const left = Math.min(...rects.map((r) => r.left));
  const right = Math.max(...rects.map((r) => r.right));
  const top = Math.max(0, Math.min(...rects.map((r) => r.top)));
  const bottom = Math.min(window.innerHeight, Math.max(...rects.map((r) => r.bottom)));
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const to = rects.map((r, i) => ({
    dx: cx - (r.left + r.width / 2),
    dy: cy - (r.top + r.height / 2),
    rot: (i - 2) * 3.5 + (rng() * 4 - 2),
  }));
  const at = (t, shift = 0) => `translate(${t.dx + shift}px, ${t.dy}px) rotate(${t.rot + shift / 9}deg)`;

  cards.forEach((c, i) => { c.style.zIndex = String(10 + i); });

  try {
    // 收拢到桌面中央
    say('shuffle');
    await Promise.all(cards.map((c, i) => moveCard(c,
      [{ transform: 'none' }, { transform: at(to[i]) }],
      { duration: 460, delay: i * 55, easing: 'cubic-bezier(.55,0,.25,1)' })));

    // 两轮洗牌：信封左右错开再合拢
    for (let round = 0; round < 2; round++) {
      say('shuffle');
      await Promise.all(cards.map((c, i) => {
        const shift = ((i + round) % 2 ? 1 : -1) * (48 + rng() * 26);
        return moveCard(c,
          [{ transform: at(to[i]) }, { transform: at(to[i], shift) }, { transform: at(to[i]) }],
          { duration: 300, easing: 'ease-in-out' });
      }));
    }

    // 依次发回各自的位置
    await Promise.all(cards.map((c, i) => {
      later(i * 95 + 330, () => sfx.deal());
      return moveCard(c,
        [{ transform: at(to[i]) }, { transform: 'none' }],
        { duration: 480, delay: i * 95, easing: 'cubic-bezier(.2,.85,.25,1)' });
    }));
  } finally {
    resetCardMotion();
  }
}

async function rollTrait(slot, final) {
  const box = slot.traitBox;
  const candidates = traitsFor(match.slots[slot.index].char);
  if (!candidates.length) candidates.push(final);
  box.classList.remove('locked');
  box.classList.add('rolling');
  let interval = 50;
  let last = null;
  while (interval < 300 && !skipping) {
    let t = pickOne(candidates, rng);
    if (candidates.length > 1) while (t === last) t = pickOne(candidates, rng);
    last = t;
    showTrait(slot, t);
    say('tick');
    await wait(interval);
    interval *= 1.16;
  }
  showTrait(slot, final);
  box.classList.remove('rolling');
  box.classList.add('locked');
  liveReveal(slot.index, 'trait');
  say('lock');
  play($('.trait-icon', box), [{ transform: 'scale(1.3)' }, { transform: 'scale(1)' }],
    { duration: 380, easing: 'cubic-bezier(.3,1.6,.5,1)', fill: 'none' });
}

/* ------------------------------------------------------------------ 操作 */

function draw() {
  if (busy) { skip(); return; }
  if (!data.trees.survivor) return;
  const problem = poolProblem();
  if (problem) { toast(problem); return; }
  sfx.unlock();
  const next = newMatch();
  track('lottery_draw', {
    survivor_ult: settings.survivorUlt, hunter_ult: settings.hunterUlt,
    despair: settings.despair, draw_trait: settings.drawTrait,
    survivor_pool: pool('survivor').length, hunter_pool: pool('hunter').length, trait_pool: pool('trait').length,
  });

  sequence(async () => {
    const wasOpen = slots.some((s) => s.card.classList.contains('is-open'));
    slots.forEach((s) => { closeCard(s); setPanelPending(s); resetTrait(s); });
    if (wasOpen) { say('flip'); await wait(680); }

    match = next;
    startLiveRound();
    slots.forEach((s, i) => fillLetter(s, match.slots[i]));
    await shuffleAndDeal();

    const lights = [];
    for (let i = 0; i < 4; i++) {
      await openCard(slots[i]);
      lights.push(lightPanel(slots[i], match.slots[i]));
      await wait(240);
    }
    await wait(300);
    const hunter = slots[4];
    syncLive('hunter');
    await revealHunter(hunter);
    lights.push(lightPanel(hunter, match.slots[4], 60));
    if (match.slots[4].trait) {
      await wait(520);
      syncLive('trait');
      await rollTrait(hunter, match.slots[4].trait);
    } else {
      showTraitFree(hunter);
      liveReveal(4, 'trait');
    }
    await Promise.all(lights);
  });
}

function rerollCharacter(slot) {
  const entry = match.slots[slot.index];
  let candidates;
  if (slot.side === 'survivor') {
    const taken = new Set(match.slots.filter((s) => s.side === 'survivor').map((s) => s.char.id));
    candidates = pool('survivor').filter((c) => !taken.has(c.id));
  } else {
    candidates = pool('hunter').filter((c) => c.id !== entry.char.id);
  }
  if (!candidates.length) { toast('卡池里没有其他可换的角色了。'); return; }
  const next = pickOne(candidates, rng);
  track('lottery_reroll', { side: slot.side, target: 'character' });
  preload(next.portrait);
  sfx.unlock();

  // 原人格或特质不适配新角色时，只重抽不适配的部分
  const nextFit = charFit(next, slot.side);
  const rebuild = buildViolatesFit(data.trees[slot.side], entry.build, nextFit);
  const traitBad = Boolean(entry.trait && nextFit.bannedTraits.has(entry.trait.name));
  const retrait = slot.side === 'hunter' && settings.drawTrait
    && (traitBad || (!entry.trait && traitsFor(next).length > 0));

  sequence(async () => {
    startLiveReroll(slot.index, ['char', ...(rebuild ? ['build'] : []), ...(retrait ? ['trait'] : [])]);
    if (rebuild) setPanelPending(slot);
    if (retrait) resetTrait(slot);
    closeCard(slot);
    say('flip');
    await wait(680);
    entry.char = next;
    match.at = new Date();
    fillLetter(slot, entry);
    say('shuffle');
    await moveCard(slot.card, [
      { transform: 'none' },
      { transform: 'translateY(-12px) rotate(-2.5deg)' },
      { transform: 'translateY(2px) rotate(1.5deg)' },
      { transform: 'none' },
    ], { duration: 460, easing: 'ease-in-out', fill: 'none' });
    if (slot.side === 'hunter') {
      syncLive('hunter');
      await revealHunter(slot);
    } else await openCard(slot);
    if (rebuild) {
      entry.build = rollFor(slot.side, next);
      await lightPanel(slot, entry, 60);
    }
    if (retrait) {
      entry.trait = pickTrait(next);
      if (entry.trait) {
        syncLive('trait');
        await rollTrait(slot, entry.trait);
      } else {
        showTraitFree(slot);
        liveReveal(slot.index, 'trait');
      }
    }
    if (rebuild && traitBad) toast('原人格和辅助特质不适配，已一并重抽');
    else if (rebuild) toast('原人格不适配，已一并重抽');
    else if (traitBad) toast('原辅助特质不适配，已一并重抽');
  });
}

function rerollBuild(slot) {
  const entry = match.slots[slot.index];
  entry.build = rollFor(slot.side, entry.char);
  track('lottery_reroll', { side: slot.side, target: 'build' });
  match.at = new Date();
  sfx.unlock();
  sequence(async () => {
    startLiveReroll(slot.index, ['build']);
    setPanelPending(slot);
    say('flip');
    await lightPanel(slot, entry, 220);
  });
}

function rerollTrait(slot) {
  const entry = match.slots[slot.index];
  const next = pickTrait(entry.char, entry.trait?.name);
  if (!next) {
    toast(`${entry.char.name}没有可抽的辅助特质，改为自选。`);
    entry.trait = null;
    match.at = new Date();
    showTraitFree(slot);
    syncLive('done');
    return;
  }
  entry.trait = next;
  track('lottery_reroll', { side: slot.side, target: 'trait' });
  match.at = new Date();
  sfx.unlock();
  sequence(() => {
    startLiveReroll(slot.index, ['trait'], 'trait');
    return rollTrait(slot, entry.trait);
  });
}

/** 切换“抽取辅助特质”后，立即更新当前结果。 */
function applyTraitSetting() {
  if (!match || busy) return;
  const slot = slots[4];
  const entry = match.slots[4];
  if (!settings.drawTrait) {
    if (!entry.trait) return;
    entry.trait = null;
    match.at = new Date();
    showTraitFree(slot);
    syncLive('done');
  } else if (!entry.trait) {
    rerollTrait(slot);
  }
}

/* ------------------------------------------------------------------ 复制结果 */

function formatTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ultimateText(entry) {
  const { ultimates } = splitBuild(data.trees[entry.side], entry.build);
  return `终极人格：${ultimates.length ? ultimates.map((t) => t.node.name).join('、') : '无'}`;
}

function othersLine(entry) {
  const { others } = splitBuild(data.trees[entry.side], entry.build);
  const names = others.map(({ node, level }) => (node.max_level > 1 ? `${node.name}${level}/${node.max_level}` : node.name));
  return `   其他人格：${names.join('、') || '无'}`;
}

/**
 * 完整版包含其他人格和监管者辅助特质；简略版只保留角色和终极人格。
 */
function resultText({ brief = false } = {}) {
  const lines = [`第五人格随机抽取工具-抽取结果 (${formatTime(match.at)})`, '', '【求生者】'];
  match.slots.forEach((entry, i) => {
    if (entry.side !== 'survivor') return;
    lines.push(`${i + 1}. ${entry.char.name}${SEP}${ultimateText(entry)}`);
    if (!brief) lines.push(othersLine(entry));
  });
  const hunter = match.slots[4];
  const trait = brief ? '' : `辅助特质：${hunter.trait ? hunter.trait.name : '自选'}${SEP}`;
  lines.push('', `【监管者】${hunter.char.name}${SEP}${trait}${ultimateText(hunter)}`);
  if (!brief) lines.push(othersLine(hunter));
  return lines.join('\n');
}

async function copyResult({ brief = false } = {}) {
  if (!match || busy) return;
  const text = resultText({ brief });
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    const area = el('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    area.remove();
  }
  track('lottery_copy', { format: brief ? 'brief' : 'full', outcome: copied ? 'copied' : 'failed' });
  if (copied) toast(brief ? '已复制简略结果' : '已复制本局结果');
  else {
    toast('浏览器不允许自动复制，请在控制台查看结果文本');
    console.log(text);
  }
}

/* ------------------------------------------------------------------ 复制人格树图片 */

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** 用 Canvas 画出一张人格树图片（配色取自页面 CSS 变量），返回 PNG Blob。 */
async function renderTreeImage(slot, entry) {
  const tree = data.trees[slot.side];
  const levels = entry.build.levels;
  const css = getComputedStyle(slot.root);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const color = {
    accent: v('--accent', '#61d5dd'),
    nodeFill: v('--node-fill', '#1c3337'),
    brass: v('--brass', '#b39158'),
    night: v('--night', '#181c21'),
    parchment: v('--parchment', '#ddd0b1'),
    muted: v('--muted', '#9b958a'),
  };
  const font = v('--font', 'serif');

  const W = 760;
  const HEAD = 76;
  const H = HEAD + 760;
  const SCALE = 2;
  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);

  // 背景
  ctx.fillStyle = color.night;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, HEAD + 380, 0, W / 2, HEAD + 380, 380);
  glow.addColorStop(0, 'rgba(255, 255, 255, .045)');
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, HEAD, W, 760);

  // 标题：角色名 + 终极人格
  const { ultimates } = splitBuild(tree, entry.build);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = color.parchment;
  ctx.font = `700 28px ${font}`;
  ctx.fillText(entry.char.name, 32, 42);
  ctx.textAlign = 'right';
  ctx.fillStyle = color.brass;
  ctx.font = `16px ${font}`;
  ctx.fillText(`终极人格：${ultimates.length ? ultimates.map((t) => t.node.name).join('、') : '无'}`, W - 32, 42);
  ctx.fillStyle = 'rgba(179, 145, 88, .35)';
  ctx.fillRect(32, HEAD - 1, W - 64, 1);

  const icons = new Map(await Promise.all(
    tree.talents.map(async (n) => [n.id, n.icon?.local_path ? await loadImage(asset(n.icon.local_path)) : null]),
  ));

  ctx.save();
  ctx.translate(W / 2, HEAD + 380);

  // 连线
  ctx.lineCap = 'round';
  for (const e of tree.edges) {
    const a = tree.byId.get(e.from);
    const b = tree.byId.get(e.to);
    const lit = Boolean(levels[b.id]);
    ctx.strokeStyle = lit ? color.accent : 'rgba(255, 255, 255, .11)';
    ctx.lineWidth = lit ? 6 : 4;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // 中心
  ctx.fillStyle = color.brass;
  ctx.beginPath();
  ctx.arc(0, 0, 13, 0, Math.PI * 2);
  ctx.fill();

  // 节点
  for (const n of tree.talents) {
    const level = levels[n.id] || 0;
    const r = n.is_ultimate ? 31 : 25;
    ctx.save();
    ctx.translate(n.x, n.y);

    if (n.is_ultimate && level) {
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = color.brass;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, r + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = level ? color.nodeFill : '#1b2026';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    if (level) {
      ctx.strokeStyle = n.is_ultimate ? color.brass : color.accent;
      ctx.lineWidth = n.is_ultimate ? 5 : 3.5;
    } else {
      ctx.strokeStyle = n.is_ultimate ? 'rgba(179, 145, 88, .4)' : 'rgba(255, 255, 255, .16)';
      ctx.lineWidth = 2;
      if (n.is_ultimate) ctx.setLineDash([5, 5]);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    const icon = icons.get(n.id);
    if (icon) {
      ctx.globalAlpha = level ? 1 : 0.2;
      ctx.drawImage(icon, -r * 0.8, -r * 0.8, r * 1.6, r * 1.6);
      ctx.globalAlpha = 1;
    }

    if (level && n.max_level > 1) {
      const bx = r * 0.78;
      const by = -r * 0.78;
      ctx.fillStyle = color.brass;
      ctx.beginPath();
      ctx.arc(bx, by, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1b1611';
      ctx.font = `700 17px ${font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(level), bx, by + 1);
    }
    ctx.restore();
  }
  ctx.restore();

  // 角标
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color.muted;
  ctx.font = `13px ${font}`;
  ctx.fillText('PIL 第五人格随机抽取工具', W - 20, H - 18);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('图片生成失败'))), 'image/png');
  });
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function copyTreeImage(slot) {
  const entry = match?.slots[slot.index];
  if (!entry || busy) return;
  const name = entry.char.name;
  // 先发起生成：ClipboardItem 接受 Promise，Safari 需要在点击当下调用 clipboard.write
  const blobPromise = renderTreeImage(slot, entry);
  blobPromise.catch(() => {});
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('不支持复制图片');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
    track('lottery_copy', { side: slot.side, format: 'tree_image', outcome: 'copied' });
    toast(`已复制${name}的人格树图片`);
  } catch {
    try {
      downloadBlob(await blobPromise, `${name}-人格树.png`);
      track('lottery_copy', { side: slot.side, format: 'tree_image', outcome: 'downloaded' });
      toast('浏览器不允许复制图片，已下载为 PNG');
    } catch (err) {
      console.error(err);
      track('lottery_copy', { side: slot.side, format: 'tree_image', outcome: 'failed' });
      toast('人格树图片生成失败，请重试');
    }
  }
}

/* ------------------------------------------------------------------ 人格树详情 */

function openTree(slot) {
  const entry = match?.slots[slot.index];
  if (!entry || busy) return;
  track('lottery_tree_open', { side: slot.side });
  showTreeDialog({ tree: data.trees[slot.side], build: entry.build, side: slot.side, name: entry.char.name });
}

/* ------------------------------------------------------------------ 角色池弹窗 */

let poolTab = 'survivor';

function renderPool() {
  const grid = $('#pool-grid');
  const excluded = new Set(settings.excluded[poolTab]);
  grid.className = `pool-grid pool-${poolTab}`;
  grid.replaceChildren(...POOL_SOURCE[poolTab]().map((item) => {
    const key = keyOf(poolTab, item);
    const tile = el('button', 'tile');
    tile.type = 'button';
    tile.dataset.key = key;
    tile.setAttribute('aria-pressed', String(!excluded.has(key)));
    const img = new Image();
    img.src = asset(poolTab === 'trait' ? item.icon.local_path : item.portrait);
    if (poolTab !== 'trait') applyPortraitView(img, item, true);
    img.alt = '';
    img.loading = 'lazy';
    const photo = el('span', 'tile-photo');
    photo.append(img);
    tile.append(photo, el('span', 'tile-name', item.name));
    return tile;
  }));
  updatePoolCount();
}

function updatePoolCount() {
  const total = POOL_SOURCE[poolTab]().length;
  const kept = pool(poolTab).length;
  const min = POOL_MIN[poolTab];
  const out = $('#pool-count');
  out.textContent = kept < min ? `已选 ${kept}/${total}，至少需要 ${min} 个` : `已选 ${kept}/${total}`;
  out.classList.toggle('is-short', kept < min);
}

function setExcluded(kind, keys) {
  settings.excluded[kind] = [...keys];
  saveSettings();
  track('lottery_pool_change', { side: kind, kept: pool(kind).length, total: POOL_SOURCE[kind]().length });
}

function bindPool() {
  const dlg = $('#dlg-pool');
  $('#btn-pool').addEventListener('click', () => {
    renderPool(); dlg.showModal(); track('lottery_pool_open');
  });
  $('.pool-tabs', dlg).addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    poolTab = tab.dataset.tab;
    dlg.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    renderPool();
  });
  $('#pool-grid').addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const excluded = new Set(settings.excluded[poolTab]);
    const nowKept = excluded.has(tile.dataset.key);
    if (nowKept) excluded.delete(tile.dataset.key); else excluded.add(tile.dataset.key);
    tile.setAttribute('aria-pressed', String(nowKept));
    setExcluded(poolTab, excluded);
    updatePoolCount();
  });
  $('#pool-all').addEventListener('click', () => { setExcluded(poolTab, []); renderPool(); });
  $('#pool-none').addEventListener('click', () => {
    setExcluded(poolTab, POOL_SOURCE[poolTab]().map((item) => keyOf(poolTab, item)));
    renderPool();
  });
}

/* ------------------------------------------------------------------ 适配设置弹窗 */

let fitTab = 'hunter';
let fitResetTimer = 0;
const FIT_SOURCE = { survivor: () => data.survivors, hunter: () => data.hunters };

function fitIcon(rule) {
  if (rule.kind === 'trait') return data.traits.find((t) => t.name === rule.target)?.icon?.local_path;
  return data.trees[rule.side].findByName(rule.target)?.icon?.local_path;
}

function fitTileLabel(char, blocked) {
  return `${char.name}：${blocked ? '不会抽到' : '可以抽到'}`;
}

function syncFitCard(card, rule) {
  const roster = FIT_SOURCE[rule.side]();
  const allowed = roster.filter((c) => !isListedBlocked(rule, c, settings.fit)).length;
  const enabled = isRuleEnabled(rule, settings.fit);
  $('.fit-count', card).textContent = enabled ? `${allowed}/${roster.length} 名可以抽到` : '规则已关闭，所有角色都可以抽到';
  $('.fit-desc', card).textContent = describeRule(rule, roster, settings.fit);
  $('.fit-reset', card).disabled = !isRuleModified(rule, settings.fit);
  $('.switch input', card).checked = enabled;
  card.classList.toggle('is-off', !enabled);
}

function createFitCard(rule) {
  const card = el('article', `fit-card side-${rule.side}`);
  card.dataset.rule = rule.id;
  const head = el('header', 'fit-head');
  const icon = el('span', `fit-icon fit-icon-${rule.kind}`);
  const path = fitIcon(rule);
  if (path) {
    const img = new Image();
    img.src = asset(path);
    img.alt = '';
    icon.append(img);
  }
  const text = el('div', 'fit-text');
  const title = el('h3', '', rule.target);
  if (rule.kind === 'trait') title.append(el('small', '', '辅助特质'));
  text.append(title, el('p', 'fit-desc'), el('p', 'fit-count'));
  const tools = el('div', 'fit-tools');
  const reset = el('button', 'btn btn-mini fit-reset', '重置');
  reset.type = 'button';
  reset.setAttribute('aria-label', `重置${rule.target}规则`);
  const sw = el('label', 'switch');
  const input = el('input');
  input.type = 'checkbox';
  input.setAttribute('aria-label', `启用${rule.target}规则`);
  const track = el('span', 'switch-track');
  track.setAttribute('aria-hidden', 'true');
  sw.append(input, track);
  tools.append(reset, sw);
  head.append(icon, text, tools);

  const grid = el('div', 'fit-grid');
  grid.append(...FIT_SOURCE[rule.side]().map((char) => {
    const blocked = isListedBlocked(rule, char, settings.fit);
    const tile = el('button', 'fit-tile');
    tile.type = 'button';
    tile.dataset.id = char.id;
    tile.title = char.name;
    tile.setAttribute('aria-pressed', String(!blocked));
    tile.setAttribute('aria-label', fitTileLabel(char, blocked));
    const photo = el('span', 'fit-photo');
    const img = new Image();
    img.src = asset(char.portrait);
    applyPortraitView(img, char, true);
    img.alt = '';
    img.loading = 'lazy';
    photo.append(img);
    tile.append(photo, el('span', 'fit-name', char.name));
    return tile;
  }));
  card.append(head, grid);
  syncFitCard(card, rule);
  return card;
}

function syncFitSummary() {
  const on = FIT_RULES.filter((rule) => isRuleEnabled(rule, settings.fit)).length;
  $('#fit-count').textContent = `已启用 ${on}/${FIT_RULES.length}`;
  $('#fit-reset-all').disabled = !FIT_RULES.some((rule) => isRuleModified(rule, settings.fit));
}

function renderFit() {
  $('#fit-list').replaceChildren(...FIT_RULES.filter((rule) => rule.side === fitTab).map(createFitCard));
  syncFitSummary();
}

function disarmFitReset() {
  clearTimeout(fitResetTimer);
  fitResetTimer = 0;
  const button = $('#fit-reset-all');
  button.textContent = '全部重置';
  button.classList.remove('is-armed');
}

function bindFit() {
  const dlg = $('#dlg-fit');
  const list = $('#fit-list');
  const ruleOf = (node) => FIT_RULES.find((rule) => rule.id === node.closest('.fit-card')?.dataset.rule);

  $('#btn-fit').addEventListener('click', () => {
    disarmFitReset();
    renderFit();
    dlg.showModal();
  });
  $('.pool-tabs', dlg).addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    fitTab = tab.dataset.tab;
    dlg.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    renderFit();
  });
  list.addEventListener('click', (e) => {
    const rule = ruleOf(e.target);
    if (!rule) return;
    const card = e.target.closest('.fit-card');
    const tile = e.target.closest('.fit-tile');
    if (tile) {
      const char = FIT_SOURCE[rule.side]().find((c) => c.id === tile.dataset.id);
      settings.fit = toggleCharacter(rule, char.id, settings.fit);
      saveSettings();
      const blocked = isListedBlocked(rule, char, settings.fit);
      tile.setAttribute('aria-pressed', String(!blocked));
      tile.setAttribute('aria-label', fitTileLabel(char, blocked));
      syncFitCard(card, rule);
      syncFitSummary();
    } else if (e.target.closest('.fit-reset')) {
      const next = { ...settings.fit };
      delete next[rule.id];
      settings.fit = next;
      saveSettings();
      const fresh = createFitCard(rule);
      card.replaceWith(fresh);
      $('.switch input', fresh).focus();
      syncFitSummary();
      toast(`已重置${rule.target}规则`);
    }
  });
  list.addEventListener('change', (e) => {
    if (!e.target.matches('.switch input')) return;
    const rule = ruleOf(e.target);
    settings.fit = setRuleEnabled(rule, e.target.checked, settings.fit);
    saveSettings();
    syncFitCard(e.target.closest('.fit-card'), rule);
    syncFitSummary();
  });
  $('#fit-reset-all').addEventListener('click', (e) => {
    const button = e.currentTarget;
    if (!fitResetTimer) {
      button.textContent = '再点一次确认';
      button.classList.add('is-armed');
      fitResetTimer = setTimeout(disarmFitReset, 3000);
      return;
    }
    disarmFitReset();
    settings.fit = {};
    saveSettings();
    renderFit();
    $('#fit-done').focus();
    toast('已重置全部适配规则');
  });
  dlg.addEventListener('close', disarmFitReset);
}

/* ------------------------------------------------------------------ 随机终极人格概率 */

function syncUltWeights() {
  document.querySelectorAll('.ult-weights').forEach((box) => {
    const { side } = box.dataset;
    const weights = settings.ultWeights[side];
    const scale = Math.max(...weights);
    const total = weights.reduce((sum, weight) => sum + weight / scale, 0);
    const setting = side === 'survivor' ? settings.survivorUlt : settings.hunterUlt;
    box.hidden = setting !== 'random';
    box.querySelectorAll('label').forEach((label, i) => {
      $('input', label).value = String(weights[i]);
      $('.ult-pct', label).textContent = `${Math.round(((weights[i] / scale) / total) * 100)}%`;
    });
  });
}

function bindUltWeights() {
  document.querySelectorAll('.ult-weights').forEach((box) => {
    const { side } = box.dataset;
    box.addEventListener('change', () => {
      const raw = [...box.querySelectorAll('input')].map((input) => (input.value.trim() === '' ? NaN : Number(input.value)));
      const next = normalizeUltimateWeights(raw);
      if (next) {
        settings.ultWeights[side] = next;
        saveSettings();
      } else {
        toast('权重要填非负数，且不能全部为 0。');
      }
      syncUltWeights();
    });
    $('.ult-reset', box).addEventListener('click', () => {
      settings.ultWeights[side] = RANDOM_ULTIMATE_WEIGHTS;
      saveSettings();
      syncUltWeights();
    });
  });
}

/* ------------------------------------------------------------------ 选手同步 */

const live = createLiveHost({
  onFail: () => toast('同步暂时失败，正在重试，抽取不受影响。'),
  onRecover: () => toast('同步已恢复'),
  onLost: () => {
    syncLiveUI();
    $('#dlg-live').close();
    $('#dlg-live-lost').showModal();
  },
});
let liveShown = null; // 抽取动画期间记录每个位置已揭晓的部分；null 表示全部已揭晓
let liveRound = 0;
let livePhase = 'idle';
let livePoll = 0;
let liveResetTimer = 0;
let liveSuppressed = false; // 重置后不再发布上一场结果，下一次抽取才恢复

function startLiveRound() {
  liveRound = Date.now();
  liveSuppressed = false;
  liveShown = match.slots.map(() => ({ char: false, build: false, trait: false }));
  syncLive('drawing');
}

/** 重抽也先撤下对应结果，直到主控真正揭晓后再发布。 */
function startLiveReroll(index, parts, phase = 'drawing') {
  liveShown = match.slots.map(() => ({ char: true, build: true, trait: true }));
  for (const part of parts) liveShown[index][part] = false;
  syncLive(phase);
}

function liveReveal(index, ...parts) {
  if (!liveShown) return;
  for (const part of parts) liveShown[index][part] = true;
  syncLive(livePhase);
}

/** 只发送已揭晓的内容，还没揭晓的结果不会离开裁判的浏览器。 */
function liveSnapshot(phase) {
  if (!match) return { round: 0, phase: 'idle', slots: [] };
  const despairId = data.trees.survivor.findByName(DESPAIR)?.id;
  return {
    round: liveRound,
    phase,
    slots: match.slots.map((entry, i) => {
      const shown = liveShown?.[i];
      const showChar = !shown || shown.char;
      const showBuild = !shown || shown.build;
      const out = {
        char: showChar ? entry.char.id : null,
        build: showBuild ? { levels: entry.build.levels, ultimates: entry.build.ultimates, used: entry.build.used } : null,
      };
      if (entry.side === 'survivor') {
        out.despair = showBuild && Boolean(entry.build.levels[despairId]);
      } else if (!shown || shown.trait) {
        out.trait = entry.trait ? { name: entry.trait.name } : 'free';
      } else {
        out.trait = null;
      }
      return out;
    }),
  };
}

function syncLive(phase) {
  livePhase = phase;
  if (live.room && !liveSuppressed) live.push(liveSnapshot(phase));
}

function syncLiveUI() {
  const { room } = live;
  const warning = $('#live-sync-warning');
  warning.hidden = !live.syncBlocked;
  warning.textContent = live.syncBlockReason === 'closing'
    ? '关闭房间尚未完成，结果同步已暂停。请打开房间设置重试。'
    : '可见范围尚未确认保存，结果同步已暂停。请打开房间设置重新保存。';
  const button = $('#btn-live');
  button.setAttribute('aria-pressed', String(Boolean(room)));
  $('#live-off').hidden = Boolean(room);
  $('#live-on').hidden = !room;
  $('#live-reset').hidden = !room;
  $('#live-end').hidden = !room;
  if (!room) { $('#live-count').textContent = ''; return; }
  const visibility = room.visibility || DEFAULT_VISIBILITY;
  // 监管者能看到全部人格时已经包含绝处逢生；不抽取辅助特质时所有人都看到“自选”。这两项不可修改，房间里的设置保留
  const despairLocked = visibility.hunterSeesTalents === 'all';
  const traitLocked = !settings.drawTrait;
  for (const key of Object.keys(VISIBILITY_OPTIONS)) {
    let value = visibility[key];
    if (key === 'hunterSeesDespair' && despairLocked) value = 'show';
    if (key === 'survivorSeesTrait' && traitLocked) value = 'free';
    $(`[data-vis="${key}"]`).querySelectorAll('[role="radio"]').forEach((b) => {
      const on = b.dataset.value === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      b.disabled = key === 'hunterSeesDespair' && despairLocked;
      if (key === 'survivorSeesTrait') b.hidden = traitLocked !== (b.dataset.value === 'free');
    });
  }
  const active = activeToggles(visibility, { traitLocked: !settings.drawTrait });
  document.querySelectorAll('#live-presets [data-toggle]').forEach((b) => {
    const isTrait = b.dataset.toggle === 'trait';
    b.disabled = isTrait && !settings.drawTrait;
    b.setAttribute('aria-pressed', String(active.has(b.dataset.toggle)));
  });
  $('#live-room-id').textContent = room.roomId;
  syncLiveAccess(room, visibility);
}

/** 隐藏了内容却没设密码的身份：知道房间号的人都能选择。 */
function exposedViews(visibility, passwords) {
  const hiddenFromSurvivors = ['survivorSeesChar', 'survivorSeesTrait'].some((key) => visibility[key] === 'hide') || visibility.survivorSeesTalents !== 'all';
  const hiddenFromHunter = visibility.hunterSeesChar === 'hide' || visibility.hunterSeesTalents !== 'all';
  const needed = [];
  if (hiddenFromSurvivors) needed.push(['hunter', '监管者']);
  if (hiddenFromHunter) needed.push(['survivor', '求生者']);
  if (hiddenFromSurvivors || hiddenFromHunter) needed.push(['spectator', '观众']);
  return needed.filter(([view]) => !passwords[view]).map(([, name]) => name);
}

function syncLiveAccess(room, visibility) {
  const passwords = {};
  for (const view of LIVE_VIEWS) {
    const row = $(`[data-access="${view}"]`);
    const access = room.access?.[view] || {};
    // 未开放的身份没有人能选择，不需要密码
    passwords[view] = access.password || access.open === false;
    const open = $('.access-open', row);
    open.checked = access.open !== false;
    row.classList.toggle('is-closed', !open.checked);
    const password = $('.access-password', row);
    const limit = $('.access-limit', row);
    // 正在输入时不覆盖
    if (document.activeElement !== password) {
      password.value = room.passwords?.[view] || '';
      password.placeholder = access.password && !room.passwords?.[view] ? '已设密码（在其他设备设置）' : '不设密码';
    }
    if (document.activeElement !== limit) limit.value = access.limit ?? '';
    limit.max = String(access.maxLimit ?? 64);
    limit.placeholder = `默认 ${access.maxLimit ?? 64}`;
    password.disabled = limit.disabled = $('.access-clear', row).disabled = !open.checked;
    $('.live-access-taken', row).textContent = open.checked ? `已占 ${access.taken ?? 0}/${access.effectiveLimit ?? access.limit ?? 64}` : '未开放';
  }
  const exposed = exposedViews(visibility, passwords);
  const warning = $('#live-access-warning');
  warning.hidden = !exposed.length;
  warning.textContent = exposed.length ? `已隐藏部分内容，但${exposed.join('、')}没有密码：知道房间号的人都能选择这些身份。` : '';
}

function disarmLiveReset() {
  clearTimeout(liveResetTimer);
  liveResetTimer = 0;
  const button = $('#live-reset');
  button.textContent = '重置房间';
  button.classList.remove('is-armed');
}

async function refreshLiveViewers() {
  if (!live.room) return;
  try {
    const { viewers } = await live.status();
    syncLiveUI();
    const counts = [['监管者', viewers.hunter], ['求生者', viewers.survivor], ['观众', viewers.spectator]];
    $('#live-count').replaceChildren(el('span', 'live-online-label', '在线'), ...counts.map(([name, count]) => {
      const item = el('span', 'live-online-item', name);
      item.append(el('b', '', String(count)));
      return item;
    }));
  } catch { /* 下一轮再试 */ }
}

async function applyVisibility(visibility) {
  try {
    const saving = live.setVisibility(visibility);
    syncLiveUI();
    await saving;
  } catch {
    toast('可见范围没有保存，结果同步已暂停。请重试。');
  }
  syncLiveUI();
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}已复制`);
  } catch {
    toast(`浏览器不允许自动复制，${label}：${text}`);
  }
}

async function saveAccess(view, changes, savedMessage) {
  try {
    await live.setAccess(view, changes);
    if (savedMessage) toast(savedMessage);
  } catch {
    toast('设置没有保存，请重试。');
  }
  syncLiveUI();
}

function bindLive() {
  const dlg = $('#dlg-live');
  $('#live-presets').replaceChildren(...VISIBILITY_TOGGLES.map((toggle) => {
    const button = el('button', 'btn btn-mini live-toggle', toggle.name);
    button.type = 'button';
    button.dataset.toggle = toggle.id;
    return button;
  }));
  $('#live-lost-open').addEventListener('click', () => {
    $('#dlg-live-lost').close();
    $('#btn-live').click();
  });
  $('#btn-live').addEventListener('click', () => {
    syncLiveUI();
    dlg.showModal();
    refreshLiveViewers();
    livePoll = setInterval(refreshLiveViewers, 5000);
  });
  dlg.addEventListener('close', () => {
    clearInterval(livePoll);
    disarmLiveReset();
  });
  $('#live-create').addEventListener('click', async () => {
    try {
      await live.create();
    } catch {
      toast('暂时无法创建同步房间，请稍后再试。');
      return;
    }
    syncLive(busy ? livePhase : 'done');
    syncLiveUI();
    refreshLiveViewers();
  });
  $('#live-presets').addEventListener('click', (e) => {
    const button = e.target.closest('[data-toggle]');
    if (button) applyVisibility(toggleVisibility(live.room.visibility, button.dataset.toggle, { traitLocked: !settings.drawTrait }));
  });
  const chooseVisibility = (button) => {
    const { vis } = button.closest('[data-vis]').dataset;
    applyVisibility({ ...live.room.visibility, [vis]: button.dataset.value });
  };
  $('#live-options').addEventListener('click', (e) => {
    const button = e.target.closest('[data-vis] [role="radio"]');
    if (button) chooseVisibility(button);
  });
  $('#live-options').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const group = e.target.closest('[data-vis]');
    if (!group) return;
    e.preventDefault();
    const radios = [...group.querySelectorAll('[role="radio"]')].filter((b) => !b.hidden && !b.disabled);
    if (!radios.length) return;
    const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = radios[(radios.indexOf(e.target) + dir + radios.length) % radios.length];
    chooseVisibility(next);
    next.focus();
  });
  $('#copy-room').addEventListener('click', () => copyText(live.room.roomId, '房间号'));
  $('#copy-link').addEventListener('click', () => copyText(liveLink(live.room), '链接'));
  $('#live-access').addEventListener('change', (e) => {
    const view = e.target.closest('[data-access]')?.dataset.access;
    if (!view) return;
    if (e.target.matches('.access-open')) {
      saveAccess(view, { open: e.target.checked }, e.target.checked ? '已开放该身份' : '已关闭该身份，已进入的人会退出');
    } else if (e.target.matches('.access-password')) {
      const value = e.target.value.trim();
      if (value === (live.room.passwords?.[view] || '')) return;
      saveAccess(view, { password: value || null }, value ? '密码已更新，该身份已进入的人需要重新进入' : '密码已取消，该身份已进入的人需要重新进入');
    } else if (e.target.matches('.access-limit')) {
      const value = e.target.value.trim();
      const limit = value === '' ? null : Number(value);
      const maximum = Number(e.target.max) || 64;
      if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > maximum)) {
        toast(`人数上限要填 1 到 ${maximum} 的整数，留空使用默认上限。`);
        syncLiveUI();
        return;
      }
      saveAccess(view, { limit });
    }
  });
  $('#live-access').addEventListener('click', async (e) => {
    if (!e.target.matches('.access-clear')) return;
    try {
      await live.clearSeats(e.target.closest('[data-access]').dataset.access);
      toast('已清空该身份的名额');
    } catch {
      toast('没有清空名额，请重试。');
    }
    syncLiveUI();
  });
  $('#live-reset').addEventListener('click', async (e) => {
    if (busy) { toast('抽取进行中，结束后才能重置房间。'); return; }
    if (!liveResetTimer) {
      e.currentTarget.textContent = '再点一次确认';
      e.currentTarget.classList.add('is-armed');
      liveResetTimer = setTimeout(disarmLiveReset, 6000);
      return;
    }
    disarmLiveReset();
    try {
      liveSuppressed = true;
      await live.reset();
      toast('房间已重置，所有人需要重新进入');
    } catch {
      liveSuppressed = false;
      toast('房间没有重置，请重试。');
    }
    syncLiveUI();
    refreshLiveViewers();
  });
  $('#live-end').addEventListener('click', async () => {
    try {
      const closing = live.close();
      syncLiveUI();
      await closing;
      toast('已结束同步');
    } catch {
      toast('关闭房间未完成，结果同步已暂停。请重试。');
    }
    syncLiveUI();
  });
}

/* ------------------------------------------------------------------ 控件 */

let toastTimer = 0;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-on'), 2600);
}

function syncButtons() {
  const draw = $('#btn-draw');
  draw.disabled = !data.trees.survivor;
  draw.textContent = busy ? '跳过动画' : (match ? '再抽一局' : '抽取结果');
  draw.classList.toggle('is-skip', busy);
  $('#btn-copy').disabled = !match || busy;
  $('#btn-copy-brief').disabled = !match || busy;
  $('#btn-pool').disabled = busy;
  $('#btn-fit').disabled = busy || !data.trees.survivor;
  $('#opt-trait').disabled = busy;
  document.querySelectorAll('.slot-actions .btn, .web-btn, .panel-copy').forEach((b) => { b.disabled = !match || busy; });
  document.querySelectorAll('[data-act="trait"]').forEach((b) => { b.hidden = !settings.drawTrait; });
  document.body.classList.toggle('is-busy', busy);
}

function syncSettingsUI() {
  document.querySelectorAll('.rule .segmented').forEach((group) => {
    const value = String(group.dataset.setting === 'survivor' ? settings.survivorUlt : settings.hunterUlt);
    group.querySelectorAll('[role="radio"]').forEach((b) => {
      const on = b.dataset.value === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  });
  $('#opt-despair').checked = settings.despair;
  $('#opt-trait').checked = settings.drawTrait;
  const sound = $('#btn-sound');
  sound.setAttribute('aria-pressed', String(settings.sound));
  sfx.setEnabled(settings.sound);
  syncUltWeights();
}

function bindControls() {
  document.querySelectorAll('.rule .segmented').forEach((group) => {
    const choose = (button) => {
      const value = button.dataset.value === 'random' ? 'random' : Number(button.dataset.value);
      if (group.dataset.setting === 'survivor') settings.survivorUlt = value; else settings.hunterUlt = value;
      track('lottery_settings_change', { setting: group.dataset.setting === 'survivor' ? 'survivor_ultimate' : 'hunter_ultimate', value });
      saveSettings();
      syncSettingsUI();
    };
    group.addEventListener('click', (e) => {
      const b = e.target.closest('[role="radio"]');
      if (b) choose(b);
    });
    group.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const radios = [...group.querySelectorAll('[role="radio"]')];
      const i = radios.indexOf(document.activeElement);
      const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
      const next = radios[(i + dir + radios.length) % radios.length];
      choose(next);
      next.focus();
    });
  });

  $('#opt-despair').addEventListener('change', (e) => {
    settings.despair = e.target.checked;
    track('lottery_settings_change', { setting: 'despair', value: settings.despair });
    saveSettings();
  });
  $('#opt-trait').addEventListener('change', (e) => {
    if (e.target.checked && !pool('trait').length) {
      e.target.checked = false;
      toast('卡池里至少要留 1 个辅助特质，才能抽取。');
      return;
    }
    settings.drawTrait = e.target.checked;
    track('lottery_settings_change', { setting: 'draw_trait', value: settings.drawTrait });
    saveSettings();
    syncButtons();
    applyTraitSetting();
  });
  $('#btn-sound').addEventListener('click', () => {
    settings.sound = !settings.sound;
    track('lottery_settings_change', { setting: 'sound', value: settings.sound });
    saveSettings();
    syncSettingsUI();
  });
  $('#btn-draw').addEventListener('click', draw);
  $('#btn-copy').addEventListener('click', () => copyResult());
  $('#btn-copy-brief').addEventListener('click', () => copyResult({ brief: true }));
  $('#table').addEventListener('click', (e) => { if (busy && !e.target.closest('button')) skip(); });

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape' && busy) { skip(); return; }
    const onPage = e.target === document.body;
    if (onPage && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      draw();
    }
  });
}

/* ------------------------------------------------------------------ 启动 */

async function main() {
  syncSettingsUI();
  bindControls();
  bindPool();
  bindFit();
  bindUltWeights();
  bindLive();
  syncLiveUI();
  try {
    await loadData();
  } catch (err) {
    console.error(err);
    $('#notice').textContent = `暂时无法读取角色数据（${err.message}），请刷新页面后重试。`;
    return;
  }
  buildTable();
  syncButtons();
  refreshLiveViewers(); // 刷新页面后确认之前的同步房间还有效
  requestAnimationFrame(() => { void warmAllImages(); });
}

main();
