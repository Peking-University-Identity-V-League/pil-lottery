import { sfx } from './sound.js';
import {
  DRAFT_DEFAULTS, DRAFT_LIMITS, RANDOM_ULTIMATE_WEIGHTS, banNeeds, bansEnabled, createRng, dealDraft, draftEnabled, draftNeeds, normalizeDraftSettings, normalizeUltimateWeights, pickOne, sample, prepareTree, rollBuild, validateBuild,
} from './rules.js';
import {
  FIT_RULES, buildViolatesFit, describeRule, fitFor, isListedBlocked, isRuleEnabled, isRuleModified, setRuleEnabled, toggleCharacter,
} from './fit-rules.js';
import { createLiveHost, liveLink } from './live-host.js';
import {
  DEFAULT_VISIBILITY, LIVE_VIEWS, VISIBILITY_OPTIONS, VISIBILITY_TOGGLES, activeToggles, applyDraftPick, bannedChars, bansComplete, closeBans, confirmBans, draftCandidates, extendBans, draftComplete, normalizeBans, normalizeDraft, timeoutBans, toggleBan, toggleVisibility,
} from './live-visibility.js';
import {
  applyPortraitView, asset, cleanDescription, el, renderWeb, showTreeDialog, splitBuild, talentItems,
} from './shared-ui.js';
import { banModel, createBanUI } from './ban-ui.js';
import { createSeatTabs } from './seat-tabs.js';
import { createDraftUI, draftModel, setLeftoverLine, setRejectedLine } from './draft-ui.js';
import { applyI18n, bindLanguageSelect, charName, joinList, roleName, t, talentName, traitName } from './i18n.js';

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
  draft: DRAFT_DEFAULTS,
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
    draft: normalizeDraftSettings(saved.draft),
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
  if (!res.ok) throw new Error(t('{path} 返回 HTTP {status}', { path: url, status: res.status }));
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

/** 这一局实际抽取的范围：卡池减去禁用的角色。 */
function drawPool(kind) {
  const banned = new Set(roundBans[kind]);
  return pool(kind).filter((item) => !banned.has(item.id));
}

function pool(kind) {
  const excluded = new Set(settings.excluded[kind]);
  return POOL_SOURCE[kind]().filter((item) => !excluded.has(keyOf(kind, item)));
}

function poolProblem() {
  if (pool('survivor').length < POOL_MIN.survivor) return t('卡池里至少要留 4 名求生者，才能凑齐一局。');
  if (pool('hunter').length < POOL_MIN.hunter) return t('卡池里至少要留 1 名监管者。');
  if (settings.drawTrait && pool('trait').length < POOL_MIN.trait) return t('卡池里至少要留 1 个辅助特质，或关闭“抽取辅助特质”。');
  const needs = banNeeds(settings.draft);
  if (pool('survivor').length < needs.survivor) return t('高级玩法需要 {count} 名求生者，卡池不够。', { count: needs.survivor });
  if (pool('hunter').length < needs.hunter) return t('高级玩法需要 {count} 名监管者，卡池不够。', { count: needs.hunter });
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
  return composeMatch(sample(drawPool('survivor'), 4, rng), pickOne(drawPool('hunter'), rng));
}

/** 角色定下来之后才抽人格和特质，适配设置才能生效。 */
function composeMatch(survivors, hunter) {
  const trait = pickTrait(hunter);
  if (settings.drawTrait && !trait) toast(t('{name}没有可抽的辅助特质，改为自选。', { name: charName(hunter) }));
  const slots = [
    ...survivors.map((char) => ({ side: 'survivor', char, build: rollFor('survivor', char) })),
    { side: 'hunter', char: hunter, build: rollFor('hunter', hunter), trait },
  ];
  slots.forEach((s) => preload(s.char.portrait));
  return { slots, at: new Date() };
}

/* ------------------------------------------------------------------ 动画调度 */

let busy = false;
let initializing = false;
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
    toast(t('抽取时出错：{error}', { error: err.message }));
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
    seatTabs.settle();
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
  draftUI = createDraftUI({
    slots, table, lookup: lookupChar, toast,
    onPick: (position, char) => hostDraftPick(position, char),
    onLock: (position) => hostDraftPick(position, undefined, true),
    onExpire: onDraftExpire,
    motion: () => !reduceMotion.matches && !skipping,
  });
  banUI = createBanUI({
    table, lookup: lookupChar,
    onPick: (side, char, step) => hostBanAct('pick', side, char, step),
    onConfirm: (side, step) => hostBanAct('confirm', side, undefined, step),
    motion: () => !reduceMotion.matches,
  });
  seatTabs = createSeatTabs({ slots, table });
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
  applyI18n(root);

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
  slot.portrait.alt = t('{name}立绘', { name: charName(char) });
  slot.name.textContent = charName(char);
  slot.roles.replaceChildren(
    ...(slot.side === 'survivor' ? (char.roles || []).map((r) => el('li', '', roleName(r))) : []),
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
  slot.traitName.textContent = t('待揭晓');
}

function showTrait(slot, trait) {
  slot.traitBox.classList.remove('is-free');
  slot.traitImg.src = asset(trait.icon.local_path);
  slot.traitName.textContent = traitName(trait.name);
}

/** 关闭“抽取辅助特质”时：由监管者自己选择。 */
function showTraitFree(slot) {
  slot.traitBox.classList.remove('rolling', 'locked');
  slot.traitBox.classList.add('is-free');
  slot.traitImg.removeAttribute('src');
  slot.traitName.textContent = t('自选');
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
  // 窄屏只显示一个座位，隐藏的信封不参与定位
  const shown = rects.filter((r) => r.width);
  const left = Math.min(...shown.map((r) => r.left));
  const right = Math.max(...shown.map((r) => r.right));
  const top = Math.max(0, Math.min(...shown.map((r) => r.top)));
  const bottom = Math.min(window.innerHeight, Math.max(...shown.map((r) => r.bottom)));
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
  if (initializing || hostDraft || hostBans || banRevealing || draftResuming) return;
  if (busy) { skip(); return; }
  if (!data.trees.survivor) return;
  const problem = poolProblem();
  if (problem) { toast(problem); return; }
  sfx.unlock();
  seatTabs.reset();
  clearDraftResult();
  roundBans = { survivor: [], hunter: [] };
  roundBanRound = null;
  banUI.clear();
  if (bansEnabled(settings.draft)) { startHostBans(); return; }
  continueDraw();
}

/** 禁用结束后（或没有禁用时）才发候选或抽取。 */
function continueDraw() {
  if (draftEnabled(settings.draft)) { startHostDraft(); return; }
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
    await revealMatch();
  });
}

/** 依次揭晓求生者、监管者、人格和特质。kept 标记选角时已经翻开的座位，它们不再翻牌。 */
async function revealMatch(kept = []) {
  const lights = [];
  for (let i = 0; i < 4; i++) {
    if (kept[i]) liveReveal(i, 'char');
    else await openCard(slots[i]);
    lights.push(lightPanel(slots[i], match.slots[i]));
    await wait(kept[i] ? 120 : 240);
  }
  await wait(300);
  const hunter = slots[4];
  if (kept[4]) {
    liveReveal(4, 'char');
  } else {
    syncLive('hunter');
    await revealHunter(hunter);
  }
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
  showDraftResult();
}

/* ------------------------------------------------------------------ 高级玩法：选角 */

const DRAFT_POLL_MS = 1000;
const DRAFT_DEAL_GRACE_SECONDS = 4; // 发牌动画不占选择时间
const DRAFT_EXTEND_SECONDS = 30;
const DRAFT_ERRORS = {
  'already-locked': '这个座位已经锁定了。',
  'card-taken': '这张牌已被其他号位占用。',
  'nothing-selected': '先选一张牌，再锁定。',
};
let hostDraft = null; // { draft, claimed, online, stage: 'dealing' | 'picking' | 'finishing', poll }
let draftResuming = false;
let draftUI = null;
let seatTabs = null;

const lookupChar = (side, id) => (side === 'survivor' ? data.survivors : data.hunters).find((c) => c.id === id);
const draftOnline = () => Boolean(hostDraft?.online && live.room);

function renderHostDraft({ animate = !reduceMotion.matches, before = null } = {}) {
  return draftUI.show(draftModel(hostDraft.draft, { host: true, claimed: hostDraft.claimed }), { animate, before });
}

function draftNames(side, ids) {
  return ids.map((id) => charName(lookupChar(side, id)));
}

function clearDraftResult() {
  slots.forEach((slot) => setRejectedLine(slot, []));
  setLeftoverLine($('.lineup-survivor'), []);
}

function showDraftResult() {
  if (!match) return;
  match.slots.forEach((entry, i) => setRejectedLine(slots[i], entry.rejected ? draftNames(entry.side, entry.rejected) : []));
  setLeftoverLine($('.lineup-survivor'), match.leftover ? draftNames('survivor', match.leftover) : []);
}

async function startHostDraft() {
  const { survivor, hunter } = dealDraft(settings.draft, drawPool('survivor'), drawPool('hunter'), rng);
  const seconds = settings.draft.seconds ? settings.draft.seconds + DRAFT_DEAL_GRACE_SECONDS : null;
  const round = Date.now();
  const onTimeout = settings.draft.onTimeout;
  let draft = normalizeDraft({ round, survivor, hunter, onTimeout, deadline: seconds ? Date.now() + seconds * 1000 : null });
  const online = Boolean(live.room);
  if (online && live.syncBlocked) { toast(t('同步暂停时不能发放候选，请先打开房间设置处理。')); return; }
  [...(survivor.cands || []).flat(), ...(survivor.pool || [])].forEach((id) => preload(lookupChar('survivor', id).portrait));
  (hunter.cands || []).forEach((id) => preload(lookupChar('hunter', id).portrait));
  hostDraft = { draft, claimed: [false, false, false, false], online, stage: 'dealing', poll: 0 };
  syncButtons();
  track('lottery_draft', { survivor_mode: settings.draft.survivor, hunter_mode: settings.draft.hunter, seconds: settings.draft.seconds });
  if (online) {
    try {
      const res = await live.startDraft(draft, seconds, roundBanRound);
      if (res.stale || !res.draft) throw new Error('stale');
      draft = res.draft;
      hostDraft.draft = draft;
      hostDraft.claimed = res.claimed;
      draftUI.setClockOffset(res.now - Date.now());
    } catch {
      hostDraft = null;
      toast(t('候选没有发出去，请重试。'));
      syncButtons();
      return;
    }
  } else {
    draftUI.setClockOffset(0);
  }
  const wasOpen = slots.some((s) => s.card.classList.contains('is-open'));
  match = null;
  liveShown = null;
  slots.forEach((s) => { closeCard(s); setPanelPending(s); resetTrait(s); });
  syncButtons();
  skipping = reduceMotion.matches;
  const prelude = (async () => {
    if (wasOpen) { say('flip'); await wait(680); }
    await shuffleAndDeal();
  })();
  await renderHostDraft({ before: prelude });
  skipping = false;
  if (!hostDraft || hostDraft.draft.round !== draft.round) return;
  enterDraftPicking();
}

function enterDraftPicking() {
  hostDraft.stage = 'picking';
  syncButtons();
  if (draftOnline()) scheduleDraftPoll();
  // 恢复或发牌结束时重新检查；渲染期间的超时回调可能已被 dealing 阶段忽略。
  if (draftComplete(hostDraft.draft) || hostDraft.draft.closed
    || (hostDraft.draft.onTimeout === 'random' && draftUI.expired)) finishHostDraft();
}

function scheduleDraftPoll() {
  clearTimeout(hostDraft.poll);
  hostDraft.poll = setTimeout(async () => {
    const current = hostDraft;
    if (!current || current.stage !== 'picking') return;
    if (!draftOnline()) { abortHostDraft(t('选角已被其他操作取消。')); return; }
    try {
      const res = await live.draftStatus();
      if (hostDraft === current && current.stage === 'picking') applyDraftStatus(res);
    } catch { /* 下一轮再试 */ }
    if (hostDraft === current && current.stage === 'picking') scheduleDraftPoll();
  }, DRAFT_POLL_MS);
}

function applyDraftStatus(res) {
  if (initializing || !hostDraft || hostDraft.stage === 'finishing') return;
  if (res.draft?.round !== hostDraft.draft.round) {
    // 房间被重置，或其他设备开始了新一轮
    abortHostDraft(t('选角已被其他操作取消。'));
    return;
  }
  hostDraft.draft = res.draft;
  hostDraft.claimed = res.claimed;
  draftUI.setClockOffset(res.now - Date.now());
  renderHostDraft();
  if (!hostDraft.finishFailed && draftComplete(res.draft)) finishHostDraft();
}

function abortHostDraft(message) {
  clearTimeout(hostDraft.poll);
  hostDraft = null;
  draftUI.clear();
  slots.forEach((s) => { closeCard(s); });
  if (message) toast(message);
  syncButtons();
}

async function hostDraftPick(position, char, lock = false) {
  if (initializing || !hostDraft || hostDraft.stage !== 'picking') return;
  sfx.unlock();
  try {
    if (draftOnline()) {
      applyDraftStatus(await live.draftAction('host-pick', { round: hostDraft.draft.round, position, char, lock }));
    } else {
      hostDraft.draft = applyDraftPick(hostDraft.draft, position, char, lock);
      renderHostDraft();
      if (draftComplete(hostDraft.draft)) finishHostDraft();
    }
  } catch (error) {
    toast(t(DRAFT_ERRORS[error.code || error.message] || '操作没有成功，请重试。'));
  }
}

async function extendHostDraft() {
  if (initializing || !hostDraft || hostDraft.draft.deadline === null || hostDraft.stage !== 'picking') return;
  try {
    if (draftOnline()) {
      applyDraftStatus(await live.draftAction('extend', { round: hostDraft.draft.round, seconds: DRAFT_EXTEND_SECONDS }));
    } else {
      hostDraft.draft = { ...hostDraft.draft, deadline: Math.max(hostDraft.draft.deadline, Date.now()) + DRAFT_EXTEND_SECONDS * 1000 };
      renderHostDraft();
    }
    toast(t('已延时 {seconds} 秒', { seconds: DRAFT_EXTEND_SECONDS }));
  } catch {
    toast(t('操作没有成功，请重试。'));
  }
}

function onDraftExpire() {
  if (hostDraft?.stage === 'picking' && !hostDraft.finishFailed && hostDraft.draft.onTimeout === 'random') finishHostDraft();
}

/** 结束选角：未锁定的座位保留预选，没有预选的随机补齐，然后才抽人格。 */
async function finishHostDraft() {
  if (initializing || !hostDraft || hostDraft.stage === 'finishing') return;
  const current = hostDraft;
  current.stage = 'finishing';
  clearTimeout(current.poll);
  syncButtons();
  if (current.online) {
    // 曾经在线的选角不能因为房间丢失而退回本地快照生成结果。
    if (!live.room) { abortHostDraft(t('选角已被其他操作取消。')); return; }
    try {
      const res = await live.draftAction('close', { round: current.draft.round });
      if (hostDraft !== current) return;
      if (res.draft?.round !== current.draft.round) { abortHostDraft(t('选角已被其他操作取消。')); return; }
      if (!res.draft.closed) throw new Error('close-not-confirmed');
      current.draft = res.draft;
      current.claimed = res.claimed;
      renderHostDraft();
    } catch {
      if (hostDraft !== current) return;
      if (!live.room) { abortHostDraft(t('选角已被其他操作取消。')); return; }
      current.stage = 'picking';
      current.finishFailed = true;
      toast(t('结束选角未确认，已保留当前选择，请重试。'));
      syncButtons();
      scheduleDraftPoll();
      return;
    }
  }
  const { draft } = current;
  const chosen = draft.seats.map((seat) => seat.sel);
  const missing = [0, 1, 2, 3, 4].filter((i) => !chosen[i] && draftCandidates(draft, i).length);
  if (missing.length) await draftUI.hop(missing);
  if (hostDraft !== current) return;
  for (const i of missing) {
    const free = draftCandidates(draft, i).filter((id) => !draft.survivor.pool || i === 4 || !chosen.slice(0, 4).includes(id));
    chosen[i] = pickOne(free, rng);
  }
  const pickedSurvivors = draft.survivor.mode === 'direct'
    ? sample(drawPool('survivor'), 4, rng)
    : chosen.slice(0, 4).map((id) => lookupChar('survivor', id));
  const pickedHunter = draft.hunter.mode === 'direct' ? pickOne(drawPool('hunter'), rng) : lookupChar('hunter', chosen[4]);
  const next = composeMatch(pickedSurvivors, pickedHunter);
  next.slots.forEach((entry, i) => {
    const pickedId = entry.char.id;
    if (i === 4 ? draft.hunter.cands : draft.survivor.cands) {
      const rejected = draftCandidates(draft, i).filter((id) => id !== pickedId);
      if (rejected.length) entry.rejected = rejected;
    }
  });
  if (draft.survivor.pool) {
    const leftover = draft.survivor.pool.filter((id) => !chosen.slice(0, 4).includes(id));
    if (leftover.length) next.leftover = leftover;
  }
  hostDraft = null;
  sequence(async () => {
    const kept = slots.map((s) => s.card.classList.contains('is-open'));
    match = next;
    startLiveRound();
    slots.forEach((s, i) => fillLetter(s, match.slots[i]));
    await draftUI.leave();
    await revealMatch(kept);
  });
}

/** 刷新页面后从服务器恢复选角：此时人格还没生成，没有东西会丢。 */
async function resumeHostDraft() {
  if (!live.room) return;
  let continueAfterResume = false;
  draftResuming = true;
  syncButtons();
  try {
    const res = await live.draftStatus();
    if (res.bans && !res.bans.closed) {
      hostBans = { bans: res.bans, online: true, stage: 'open', poll: 0 };
      banUI.setClockOffset(res.now - Date.now());
      renderHostBans();
      scheduleBanTick();
    } else if (res.bans) {
      roundBans = bannedChars(res.bans);
      roundBanRound = res.bans.round;
      banUI.show(banModel(res.bans, { host: true }));
      // 禁用刚结束就刷新页面：这一局还没开始，接着往下走
      continueAfterResume = !res.draft && res.round === res.bans.round;
    }
    if (res.draft) {
      hostDraft = { draft: res.draft, claimed: res.claimed, online: true, stage: 'dealing', poll: 0 };
      draftUI.setClockOffset(res.now - Date.now());
      await renderHostDraft({ animate: false });
      enterDraftPicking();
    }
  } catch { /* 房间失效时由其他流程提示 */ }
  draftResuming = false;
  syncButtons();
  if (continueAfterResume) continueDraw();
}

/* ------------------------------------------------------------------ 高级玩法：禁用 */

const BAN_TICK_MS = 1000;
const BAN_ERRORS = {
  'ban-step-changed': '禁用环节已更新，请按当前页面重新操作。',
  'already-locked': '这一方已经确认了。',
  'bans-closed': '禁用已结束。',
  'bans-full': '已经选满了，先取消一个。',
  'not-your-turn': '还没轮到这一方。',
};
let hostBans = null; // { bans, online, stage: 'open' | 'finishing', poll }
let banUI = null;
let banRevealing = false;
let roundBans = { survivor: [], hunter: [] }; // 这一局从卡池移除的角色，单项重抽也要避开
let roundBanRound = null;

function renderHostBans() {
  banUI.show(banModel(hostBans.bans, { host: true }));
}

async function startHostBans() {
  const online = Boolean(live.room);
  if (online && live.syncBlocked) { toast(t('同步暂停时不能开始禁用，请先打开房间设置处理。')); return; }
  const { survivorSelfBans, survivorBans, hunterSelfBans, hunterBans, banOrder, banSeconds, banTimeout } = settings.draft;
  const seconds = banSeconds || null;
  let bans = normalizeBans({
    round: Date.now(), order: banOrder, onTimeout: banTimeout, seconds,
    deadline: seconds ? Date.now() + seconds * 1000 : null,
    quota: { survivor: { survivor: survivorSelfBans, hunter: survivorBans }, hunter: { survivor: hunterBans, hunter: hunterSelfBans } },
    targets: { survivor: pool('survivor').map((c) => c.id), hunter: pool('hunter').map((c) => c.id) },
    needs: draftNeeds(settings.draft),
  });
  hostBans = { bans, online, stage: 'open', poll: 0 };
  syncButtons();
  track('lottery_bans', { survivor_self_bans: survivorSelfBans, survivor_bans: survivorBans, hunter_self_bans: hunterSelfBans, hunter_bans: hunterBans, order: banOrder, seconds: banSeconds });
  if (online) {
    try {
      const res = await live.startBans(bans);
      if (res.stale || !res.bans) throw new Error('stale');
      bans = res.bans;
      hostBans.bans = bans;
      banUI.setClockOffset(res.now - Date.now());
    } catch {
      hostBans = null;
      toast(t('禁用没有开始，请重试。'));
      syncButtons();
      return;
    }
  } else {
    banUI.setClockOffset(0);
  }
  match = null;
  liveShown = null;
  slots.forEach((s) => { closeCard(s); setPanelPending(s); resetTrait(s); });
  syncButtons();
  renderHostBans();
  scheduleBanTick();
}

/** 在线时跟服务器同步；时间到了由裁判这一端触发超时处理，房间里没有裁判时就停在这里。 */
function scheduleBanTick() {
  clearTimeout(hostBans.poll);
  hostBans.poll = setTimeout(async () => {
    const current = hostBans;
    if (!current || current.stage !== 'open') return;
    try {
      if (current.online) {
        if (!live.room) { abortHostBans(t('禁用已被其他操作取消。')); return; }
        const res = await live.draftStatus();
        if (hostBans !== current) return;
        if (res.bans?.round !== current.bans.round) { abortHostBans(t('禁用已被其他操作取消。')); return; }
        applyBanStatus(res);
        if (hostBans !== current) return;
      }
      const { deadline, round } = current.bans;
      if (deadline !== null && banUI.now() >= deadline) {
        if (current.online) applyBanStatus(await live.banAction('timeout', { round }));
        else { current.bans = timeoutBans(current.bans, Date.now(), rng); afterLocalBan(); }
      }
    } catch { /* 下一轮再试 */ }
    if (hostBans === current && current.stage === 'open') scheduleBanTick();
  }, BAN_TICK_MS);
}

function applyBanStatus(res) {
  if (initializing || !hostBans || hostBans.stage !== 'open' || res.bans?.round !== hostBans.bans.round) return;
  hostBans.bans = res.bans;
  banUI.setClockOffset(res.now - Date.now());
  renderHostBans();
  syncButtons();
  if (bansComplete(res.bans)) finishHostBans();
}

function afterLocalBan() {
  renderHostBans();
  syncButtons();
  if (bansComplete(hostBans.bans)) finishHostBans();
}

function abortHostBans(message) {
  clearTimeout(hostBans.poll);
  hostBans = null;
  banUI.clear();
  if (message) toast(message);
  syncButtons();
}

async function hostBanAct(action, side, char, step) {
  if (initializing || hostBans?.stage !== 'open') return;
  sfx.unlock();
  try {
    if (hostBans.online) {
      applyBanStatus(await live.banAction(`host-${action}`, { round: hostBans.bans.round, side, char, step }));
    } else {
      hostBans.bans = action === 'pick' ? toggleBan(hostBans.bans, side, char) : confirmBans(hostBans.bans, side, Date.now());
      afterLocalBan();
    }
  } catch (error) {
    toast(t(BAN_ERRORS[error.code || error.message] || '操作没有成功，请重试。'));
  }
}

async function extendHostBans() {
  if (initializing || hostBans?.stage !== 'open' || (hostBans.bans.deadline === null && !hostBans.bans.expired)) return;
  try {
    if (hostBans.online) {
      applyBanStatus(await live.banAction('extend', { round: hostBans.bans.round, seconds: DRAFT_EXTEND_SECONDS }));
    } else {
      hostBans.bans = extendBans(hostBans.bans, DRAFT_EXTEND_SECONDS, Date.now());
      renderHostBans();
    }
    toast(t('已延时 {seconds} 秒', { seconds: DRAFT_EXTEND_SECONDS }));
  } catch {
    toast(t('操作没有成功，请重试。'));
  }
}

/** 结束禁用，把结果移出这一局的卡池，再接着发候选或抽取。 */
async function finishHostBans() {
  if (initializing || hostBans?.stage !== 'open') return;
  const current = hostBans;
  current.stage = 'finishing';
  clearTimeout(current.poll);
  syncButtons();
  let bans = closeBans(current.bans, Date.now());
  if (current.online) {
    if (!live.room) { abortHostBans(t('禁用已被其他操作取消。')); return; }
    try {
      const res = await live.banAction('close', { round: current.bans.round });
      if (hostBans !== current) return;
      if (res.bans?.round !== current.bans.round || !res.bans.closed) throw new Error('close-not-confirmed');
      bans = res.bans;
    } catch {
      if (hostBans !== current) return;
      if (!live.room) { abortHostBans(t('禁用已被其他操作取消。')); return; }
      current.stage = 'open';
      toast(t('结束禁用未确认，请重试。'));
      syncButtons();
      scheduleBanTick();
      return;
    }
  }
  hostBans = null;
  roundBans = bannedChars(bans);
  roundBanRound = bans.round;
  const model = banModel(bans, { host: true });
  banUI.show(model);
  banRevealing = true;
  syncButtons();
  await banUI.reveal(model);
  banRevealing = false;
  syncButtons();
  continueDraw();
}

/* ------------------------------------------------------------------ 初始化 */

const INIT_CONFIRM_MS = 3000;
let initArmed = 0;

function disarmInit() {
  clearTimeout(initArmed);
  initArmed = 0;
  $('#btn-init').textContent = t('初始化');
}

/** 回到开局前的样子：撤下上一局结果和进行中的禁用、选角，选手留在房间里，设置不变。 */
async function initRound() {
  if (initializing || busy || banRevealing || draftResuming || hostBans?.stage === 'finishing' || hostDraft?.stage === 'finishing') return;
  // 这会撤下所有人看到的结果，点两次才生效
  if (!initArmed) {
    $('#btn-init').textContent = t('再点一次确认');
    initArmed = setTimeout(disarmInit, INIT_CONFIRM_MS);
    return;
  }
  disarmInit();
  initializing = true;
  syncButtons();
  try {
    if (live.room) await live.initialize();
    if (hostBans) abortHostBans();
    if (hostDraft) abortHostDraft();
    match = null;
    liveShown = null;
    roundBans = { survivor: [], hunter: [] };
    roundBanRound = null;
    banUI.clear();
    clearDraftResult();
    seatTabs.reset();
    slots.forEach((s) => { closeCard(s); setPanelPending(s); resetTrait(s); });
    livePhase = 'idle';
    liveSuppressed = false;
    toast(t('已初始化'));
  } catch {
    toast(t('初始化未确认，请重试。'));
  } finally {
    initializing = false;
    syncButtons();
  }
}

/* ------------------------------------------------------------------ 高级玩法：设置 */

function syncAdvanced() {
  const draft = settings.draft;
  document.querySelectorAll('#dlg-advanced [data-draft]').forEach((group) => {
    group.querySelectorAll('[role="radio"]').forEach((b) => {
      const value = group.hasAttribute('data-number') ? Number(b.dataset.value) : b.dataset.value;
      const on = value === draft[group.dataset.draft];
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  });
  document.querySelectorAll('#dlg-advanced [data-draft-for]').forEach((node) => {
    node.hidden = ![draft.survivor, draft.hunter].includes(node.dataset.draftFor);
  });
  const needs = banNeeds(draft);
  const hint = (id, need, have) => {
    const node = $(id);
    node.hidden = have >= need;
    node.textContent = have < need ? t('需要 {need} 名，卡池只有 {have} 名。', { need, have }) : '';
  };
  if (data.survivors.length) {
    hint('#adv-hint-survivor', needs.survivor, pool('survivor').length);
    hint('#adv-hint-hunter', needs.hunter, pool('hunter').length);
  }
  document.querySelectorAll('#dlg-advanced [data-draft-input]').forEach((input) => {
    if (document.activeElement !== input) input.value = draft[input.dataset.draftInput];
  });
  syncButtons();
}

function bindAdvanced() {
  const dlg = $('#dlg-advanced');
  $('#btn-advanced').addEventListener('click', () => { syncAdvanced(); dlg.showModal(); track('lottery_advanced_open'); });
  dlg.querySelectorAll('[data-draft]').forEach((group) => {
    const choose = (b) => {
      const key = group.dataset.draft;
      settings.draft = normalizeDraftSettings({ ...settings.draft, [key]: group.hasAttribute('data-number') ? Number(b.dataset.value) : b.dataset.value });
      track('lottery_settings_change', { setting: `draft_${key}`, value: settings.draft[key] });
      saveSettings();
      syncAdvanced();
    };
    group.addEventListener('click', (e) => {
      const b = e.target.closest('[role="radio"]');
      if (b) choose(b);
    });
    group.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const radios = [...group.querySelectorAll('[role="radio"]')];
      const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
      const next = radios[(radios.indexOf(document.activeElement) + dir + radios.length) % radios.length];
      choose(next);
      next.focus();
    });
  });
  dlg.querySelectorAll('[data-draft-input]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.draftInput;
      const [min, max] = DRAFT_LIMITS[key];
      // 超出范围时取最近的有效值，没填或不是整数时保持原值
      const value = Number(input.value);
      if (input.value !== '' && Number.isFinite(value)) {
        settings.draft = { ...settings.draft, [key]: Math.min(max, Math.max(min, Math.round(value))) };
        track('lottery_settings_change', { setting: `draft_${key}` });
        saveSettings();
      }
      input.value = settings.draft[key];
      syncAdvanced();
    });
  });
  $('#adv-reset').addEventListener('click', () => {
    settings.draft = { ...DRAFT_DEFAULTS };
    saveSettings();
    syncAdvanced();
  });
}

function rerollCharacter(slot) {
  const entry = match.slots[slot.index];
  let candidates;
  if (slot.side === 'survivor') {
    const taken = new Set(match.slots.filter((s) => s.side === 'survivor').map((s) => s.char.id));
    candidates = drawPool('survivor').filter((c) => !taken.has(c.id));
  } else {
    candidates = drawPool('hunter').filter((c) => c.id !== entry.char.id);
  }
  if (!candidates.length) { toast(t('卡池里没有其他可换的角色了。')); return; }
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
    if (rebuild && traitBad) toast(t('原人格和辅助特质不适配，已一并重抽'));
    else if (rebuild) toast(t('原人格不适配，已一并重抽'));
    else if (traitBad) toast(t('原辅助特质不适配，已一并重抽'));
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
    toast(t('{name}没有可抽的辅助特质，改为自选。', { name: charName(entry.char) }));
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
  return t('最终天赋：{names}', { names: ultimates.length ? joinList(ultimates.map((u) => talentName(u.node.name))) : t('无') });
}

function othersLine(entry) {
  const { others } = splitBuild(data.trees[entry.side], entry.build);
  const names = others.map(({ node, level }) => (node.max_level > 1 ? `${talentName(node.name)} ${level}/${node.max_level}` : talentName(node.name)));
  return `   ${t('其他人格：{names}', { names: joinList(names) || t('无') })}`;
}

/**
 * 完整版包含其他人格和监管者辅助特质；简略版只保留角色和最终天赋。
 */
function resultText({ brief = false } = {}) {
  const lines = [t('第五人格随机抽取工具-抽取结果 ({time})', { time: formatTime(match.at) }), '', t('【求生者】')];
  match.slots.forEach((entry, i) => {
    if (entry.side !== 'survivor') return;
    lines.push(`${i + 1}. ${charName(entry.char)}${SEP}${ultimateText(entry)}`);
    if (!brief) lines.push(othersLine(entry));
    if (!brief && entry.rejected) lines.push(`   ${t('未选：{names}', { names: joinList(draftNames('survivor', entry.rejected)) })}`);
  });
  if (!brief && match.leftover) lines.push(t('未选：{names}', { names: joinList(draftNames('survivor', match.leftover)) }));
  const hunter = match.slots[4];
  const trait = brief ? '' : `${t('辅助特质：{name}', { name: hunter.trait ? traitName(hunter.trait.name) : t('自选') })}${SEP}`;
  lines.push('', `${t('【监管者】')}${charName(hunter.char)}${SEP}${trait}${ultimateText(hunter)}`);
  if (!brief) lines.push(othersLine(hunter));
  if (!brief && hunter.rejected) lines.push(`   ${t('未选：{names}', { names: joinList(draftNames('hunter', hunter.rejected)) })}`);
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
  if (copied) toast(t(brief ? '已复制简略结果' : '已复制本局结果'));
  else {
    toast(t('浏览器不允许自动复制，请在控制台查看结果文本'));
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

  // 标题：角色名 + 最终天赋
  const { ultimates } = splitBuild(tree, entry.build);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = color.parchment;
  ctx.font = `700 28px ${font}`;
  ctx.fillText(charName(entry.char), 32, 42);
  ctx.textAlign = 'right';
  ctx.fillStyle = color.brass;
  ctx.font = `16px ${font}`;
  ctx.fillText(t('最终天赋：{names}', { names: ultimates.length ? joinList(ultimates.map((u) => talentName(u.node.name))) : t('无') }), W - 32, 42);
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
  ctx.fillText(t('PIL 第五人格随机抽取工具'), W - 20, H - 18);

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
  const name = charName(entry.char);
  // 先发起生成：ClipboardItem 接受 Promise，Safari 需要在点击当下调用 clipboard.write
  const blobPromise = renderTreeImage(slot, entry);
  blobPromise.catch(() => {});
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('不支持复制图片');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
    track('lottery_copy', { side: slot.side, format: 'tree_image', outcome: 'copied' });
    toast(t('已复制{name}的人格树图片', { name }));
  } catch {
    try {
      downloadBlob(await blobPromise, t('{name}-人格树.png', { name }));
      track('lottery_copy', { side: slot.side, format: 'tree_image', outcome: 'downloaded' });
      toast(t('浏览器不允许复制图片，已下载为 PNG'));
    } catch (err) {
      console.error(err);
      track('lottery_copy', { side: slot.side, format: 'tree_image', outcome: 'failed' });
      toast(t('人格树图片生成失败，请重试'));
    }
  }
}

/* ------------------------------------------------------------------ 人格树详情 */

function openTree(slot) {
  const entry = match?.slots[slot.index];
  if (!entry || busy) return;
  track('lottery_tree_open', { side: slot.side });
  showTreeDialog({ tree: data.trees[slot.side], build: entry.build, side: slot.side, name: charName(entry.char) });
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
    tile.dataset.removed = t('已移出');
    tile.setAttribute('aria-pressed', String(!excluded.has(key)));
    const img = new Image();
    img.src = asset(poolTab === 'trait' ? item.icon.local_path : item.portrait);
    if (poolTab !== 'trait') applyPortraitView(img, item, true);
    img.alt = '';
    img.loading = 'lazy';
    const photo = el('span', 'tile-photo');
    photo.append(img);
    tile.append(photo, el('span', 'tile-name', poolTab === 'trait' ? traitName(item.name) : charName(item)));
    return tile;
  }));
  updatePoolCount();
}

function updatePoolCount() {
  const total = POOL_SOURCE[poolTab]().length;
  const kept = pool(poolTab).length;
  const min = POOL_MIN[poolTab];
  const out = $('#pool-count');
  out.textContent = t(kept < min ? '已选 {kept}/{total}，至少需要 {min} 个' : '已选 {kept}/{total}', { kept, total, min });
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
  return `${charName(char)}${t('：')}${t(blocked ? '不会抽到' : '可以抽到')}`;
}

function syncFitCard(card, rule) {
  const roster = FIT_SOURCE[rule.side]();
  const allowed = roster.filter((c) => !isListedBlocked(rule, c, settings.fit)).length;
  const enabled = isRuleEnabled(rule, settings.fit);
  $('.fit-count', card).textContent = enabled ? t('{allowed}/{total} 名可以抽到', { allowed, total: roster.length }) : t('规则已关闭，所有角色都可以抽到');
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
  const target = rule.kind === 'trait' ? traitName(rule.target) : talentName(rule.target);
  const title = el('h3', '', target);
  if (rule.kind === 'trait') title.append(el('small', '', t('辅助特质')));
  text.append(title, el('p', 'fit-desc'), el('p', 'fit-count'));
  const tools = el('div', 'fit-tools');
  const reset = el('button', 'btn btn-mini fit-reset', t('重置'));
  reset.type = 'button';
  reset.setAttribute('aria-label', t('重置{name}规则', { name: target }));
  const sw = el('label', 'switch');
  const input = el('input');
  input.type = 'checkbox';
  input.setAttribute('aria-label', t('启用{name}规则', { name: target }));
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
    tile.title = charName(char);
    tile.setAttribute('aria-pressed', String(!blocked));
    tile.setAttribute('aria-label', fitTileLabel(char, blocked));
    const photo = el('span', 'fit-photo');
    const img = new Image();
    img.src = asset(char.portrait);
    applyPortraitView(img, char, true);
    img.alt = '';
    img.loading = 'lazy';
    photo.append(img);
    tile.append(photo, el('span', 'fit-name', charName(char)));
    return tile;
  }));
  card.append(head, grid);
  syncFitCard(card, rule);
  return card;
}

function syncFitSummary() {
  const on = FIT_RULES.filter((rule) => isRuleEnabled(rule, settings.fit)).length;
  $('#fit-count').textContent = t('已启用 {on}/{total}', { on, total: FIT_RULES.length });
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
  button.textContent = t('全部重置');
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
      toast(t('已重置{name}规则', { name: rule.kind === 'trait' ? traitName(rule.target) : talentName(rule.target) }));
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
      button.textContent = t('再点一次确认');
      button.classList.add('is-armed');
      fitResetTimer = setTimeout(disarmFitReset, 3000);
      return;
    }
    disarmFitReset();
    settings.fit = {};
    saveSettings();
    renderFit();
    $('#fit-done').focus();
    toast(t('已重置全部适配规则'));
  });
  dlg.addEventListener('close', disarmFitReset);
}

/* ------------------------------------------------------------------ 随机最终天赋概率 */

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
        toast(t('权重要填非负数，且不能全部为 0。'));
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
  onFail: () => toast(t('同步暂时失败，正在重试，抽取不受影响。')),
  onRecover: () => toast(t('同步已恢复')),
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
    ...(roundBanRound !== null ? { banRound: roundBanRound } : {}),
    ...(match.leftover ? { leftover: match.leftover } : {}),
    slots: match.slots.map((entry, i) => {
      const shown = liveShown?.[i];
      const showChar = !shown || shown.char;
      const showBuild = !shown || shown.build;
      const out = {
        char: showChar ? entry.char.id : null,
        build: showBuild ? { levels: entry.build.levels, ultimates: entry.build.ultimates, used: entry.build.used } : null,
      };
      if (showChar && entry.rejected) out.rejected = entry.rejected;
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
  if (initializing || hostDraft || hostBans) return; // 选角和禁用期间的同步走各自的接口，这里发布会结束这一轮
  if (live.room && !liveSuppressed) live.push(liveSnapshot(phase));
}

function syncLiveUI() {
  const { room } = live;
  const warning = $('#live-sync-warning');
  warning.hidden = !live.syncBlocked;
  warning.textContent = t(live.syncBlockReason === 'closing'
    ? '关闭房间尚未完成，结果同步已暂停。请打开房间设置重试。'
    : '可见范围尚未确认保存，结果同步已暂停。请打开房间设置重新保存。');
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
  if (hiddenFromSurvivors) needed.push(['hunter', t('监管者')]);
  if (hiddenFromHunter) needed.push(['survivor', t('求生者')]);
  if (hiddenFromSurvivors || hiddenFromHunter) needed.push(['spectator', t('观众')]);
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
      password.placeholder = t(access.password && !room.passwords?.[view] ? '已设密码（在其他设备设置）' : '不设密码');
    }
    if (document.activeElement !== limit) limit.value = access.limit ?? '';
    limit.max = String(access.maxLimit ?? 64);
    limit.placeholder = t('默认 {max}', { max: access.maxLimit ?? 64 });
    password.disabled = limit.disabled = $('.access-clear', row).disabled = !open.checked;
    $('.live-access-taken', row).textContent = open.checked ? t('已占 {taken}/{limit}', { taken: access.taken ?? 0, limit: access.effectiveLimit ?? access.limit ?? 64 }) : t('未开放');
  }
  syncLivePositions(room);
  const exposed = exposedViews(visibility, passwords);
  const warning = $('#live-access-warning');
  warning.hidden = !exposed.length;
  warning.textContent = exposed.length ? t('已隐藏部分内容，但{names}没有密码：知道房间号的人都能选择这些身份。', { names: joinList(exposed) }) : '';
}

/** 求生者的 4 个号位：谁在、是否在线，可以单独踢出。 */
function syncLivePositions(room) {
  const box = $('#live-positions');
  const positions = room.access?.survivor?.positions;
  box.hidden = !positions || room.access.survivor.open === false;
  if (box.hidden) return;
  box.replaceChildren(...positions.map(({ taken, online }, position) => {
    const item = el('div', `live-position${online ? ' is-online' : ''}`);
    item.append(el('span', '', t('{position} 号位', { position: position + 1 })), el('small', '', t(online ? '在线' : taken ? '已断线' : '空位')));
    const kick = el('button', 'btn btn-mini', t('踢出'));
    kick.type = 'button';
    kick.dataset.kick = String(position);
    kick.disabled = !taken;
    kick.setAttribute('aria-label', t('踢出 {position} 号位', { position: position + 1 }));
    item.append(kick);
    return item;
  }));
}

function disarmLiveReset() {
  clearTimeout(liveResetTimer);
  liveResetTimer = 0;
  const button = $('#live-reset');
  button.textContent = t('重置房间');
  button.classList.remove('is-armed');
}

async function refreshLiveViewers() {
  if (!live.room) return;
  try {
    const { viewers } = await live.status();
    syncLiveUI();
    const counts = [[t('监管者'), viewers.hunter], [t('求生者'), viewers.survivor], [t('观众'), viewers.spectator]];
    $('#live-count').replaceChildren(el('span', 'live-online-label', t('在线')), ...counts.map(([name, count]) => {
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
    toast(t('可见范围没有保存，结果同步已暂停。请重试。'));
  }
  syncLiveUI();
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('{label}已复制', { label }));
  } catch {
    toast(t('浏览器不允许自动复制，{label}：{text}', { label, text }));
  }
}

async function saveAccess(view, changes, savedMessage) {
  try {
    await live.setAccess(view, changes);
    if (savedMessage) toast(savedMessage);
  } catch {
    toast(t('设置没有保存，请重试。'));
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
      toast(t('暂时无法创建同步房间，请稍后再试。'));
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
  $('#copy-room').addEventListener('click', () => copyText(live.room.roomId, t('房间号')));
  $('#copy-link').addEventListener('click', () => copyText(liveLink(live.room), t('链接')));
  $('#live-access').addEventListener('change', (e) => {
    const view = e.target.closest('[data-access]')?.dataset.access;
    if (!view) return;
    if (e.target.matches('.access-open')) {
      saveAccess(view, { open: e.target.checked }, t(e.target.checked ? '已开放该身份' : '已关闭该身份，已进入的人会退出'));
    } else if (e.target.matches('.access-password')) {
      const value = e.target.value.trim();
      if (value === (live.room.passwords?.[view] || '')) return;
      saveAccess(view, { password: value || null }, t(value ? '密码已更新，该身份已进入的人需要重新进入' : '密码已取消，该身份已进入的人需要重新进入'));
    } else if (e.target.matches('.access-limit')) {
      const value = e.target.value.trim();
      const limit = value === '' ? null : Number(value);
      const maximum = Number(e.target.max) || 64;
      if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > maximum)) {
        toast(t('人数上限要填 1 到 {max} 的整数，留空使用默认上限。', { max: maximum }));
        syncLiveUI();
        return;
      }
      saveAccess(view, { limit });
    }
  });
  $('#live-positions').addEventListener('click', async (e) => {
    const button = e.target.closest('[data-kick]');
    if (!button) return;
    const position = Number(button.dataset.kick);
    try {
      await live.kickPosition(position);
      toast(t('已踢出 {position} 号位', { position: position + 1 }));
    } catch {
      toast(t('操作没有成功，请重试。'));
    }
    syncLiveUI();
  });
  $('#live-access').addEventListener('click', async (e) => {
    if (!e.target.matches('.access-clear')) return;
    try {
      await live.clearSeats(e.target.closest('[data-access]').dataset.access);
      toast(t('已清空该身份的名额'));
    } catch {
      toast(t('没有清空名额，请重试。'));
    }
    syncLiveUI();
  });
  $('#live-reset').addEventListener('click', async (e) => {
    if (initializing || busy || hostDraft || hostBans || banRevealing || draftResuming) { toast(t('抽取进行中，结束后才能重置房间。')); return; }
    if (!liveResetTimer) {
      e.currentTarget.textContent = t('再点一次确认');
      e.currentTarget.classList.add('is-armed');
      liveResetTimer = setTimeout(disarmLiveReset, 6000);
      return;
    }
    disarmLiveReset();
    try {
      liveSuppressed = true;
      await live.reset();
      toast(t('房间已重置，所有人需要重新进入'));
    } catch {
      liveSuppressed = false;
      toast(t('房间没有重置，请重试。'));
    }
    syncLiveUI();
    refreshLiveViewers();
  });
  $('#live-end').addEventListener('click', async () => {
    try {
      const closing = live.close();
      syncLiveUI();
      await closing;
      toast(t('已结束同步'));
    } catch {
      toast(t('关闭房间未完成，结果同步已暂停。请重试。'));
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
  const picking = hostDraft?.stage === 'picking';
  const banning = hostBans?.stage === 'open';
  const inDraft = Boolean(hostDraft) || Boolean(hostBans) || banRevealing || draftResuming || initializing;
  $('#btn-init').disabled = initializing || busy || banRevealing || draftResuming || hostBans?.stage === 'finishing' || hostDraft?.stage === 'finishing';
  draw.disabled = initializing || !data.trees.survivor || (inDraft && !picking && !banning);
  const idleLabel = bansEnabled(settings.draft) ? '开始禁用' : draftEnabled(settings.draft) ? '发放候选' : (match ? '再抽一局' : '抽取结果');
  draw.textContent = t(banning ? '结束禁用' : picking ? (hostDraft.finishFailed ? '重试结束选角' : '结束选角') : busy ? '跳过动画' : idleLabel);
  draw.classList.toggle('is-skip', busy);
  $('#btn-draft-extend').hidden = banning ? hostBans.bans.deadline === null && !hostBans.bans.expired : !picking || hostDraft.draft.deadline === null;
  $('#btn-draft-redeal').hidden = !picking;
  $('#btn-advanced').disabled = busy || inDraft;
  $('#live-create').disabled = inDraft;
  $('#live-reset').disabled = busy || inDraft;
  $('#btn-copy').disabled = !match || busy;
  $('#btn-copy-brief').disabled = !match || busy;
  $('#btn-pool').disabled = busy || inDraft;
  $('#btn-fit').disabled = busy || inDraft || !data.trees.survivor;
  $('#opt-trait').disabled = busy || inDraft;
  $('#lang-select').disabled = busy || inDraft;
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
      toast(t('卡池里至少要留 1 个辅助特质，才能抽取。'));
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
  $('#btn-draw').addEventListener('click', () => { if (hostBans) finishHostBans(); else if (hostDraft) finishHostDraft(); else draw(); });
  $('#btn-init').addEventListener('click', initRound);
  $('#btn-draft-extend').addEventListener('click', () => { if (hostBans) extendHostBans(); else extendHostDraft(); });
  $('#btn-draft-redeal').addEventListener('click', () => {
    if (hostDraft?.stage !== 'picking') return;
    abortHostDraft();
    const problem = poolProblem();
    if (problem) toast(problem); else startHostDraft();
  });
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

/** 切换语言时保留本局结果，只重写文字。动画期间语言选择已禁用。 */
function relocalize() {
  applyI18n();
  if (data.trees.survivor) {
    slots.forEach((slot) => {
      const entry = match?.slots[slot.index];
      if (!entry) { setPanelPending(slot); resetTrait(slot); return; }
      fillLetter(slot, entry);
      fillPanel(slot, entry, false);
      if (slot.traitBox) { if (entry.trait) showTrait(slot, entry.trait); else showTraitFree(slot); }
    });
    syncButtons();
  }
  disarmFitReset();
  disarmLiveReset();
  syncLiveUI();
  refreshLiveViewers();
}

async function main() {
  bindLanguageSelect(relocalize);
  syncSettingsUI();
  bindControls();
  bindPool();
  bindFit();
  bindUltWeights();
  bindLive();
  bindAdvanced();
  applyI18n();
  syncLiveUI();
  try {
    await loadData();
  } catch (err) {
    console.error(err);
    $('#notice').textContent = t('暂时无法读取角色数据（{error}），请刷新页面后重试。', { error: err.message });
    return;
  }
  buildTable();
  syncButtons();
  refreshLiveViewers(); // 刷新页面后确认之前的同步房间还有效
  syncAdvanced();
  await resumeHostDraft();
  requestAnimationFrame(() => { void warmAllImages(); });
}

main();
