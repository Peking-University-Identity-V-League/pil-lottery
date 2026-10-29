import { sfx } from './sound.js';
import {
  MAX_LAYERS, POINTS_PER_LAYER, createRng, pickOne, sample, prepareTree, rollBuild, validateBuild,
} from './rules.js';

/* ------------------------------------------------------------------ 基础 */

const $ = (sel, root = document) => root.querySelector(sel);
const SVG_NS = 'http://www.w3.org/2000/svg';
const STORE_KEY = 'pil-lottery:v1';
const ORDINALS = ['第一位', '第二位', '第三位', '第四位'];
const DESPAIR = '绝处逢生';
const STEP = 140; // 人格树每一圈点亮的间隔（毫秒），同步到 CSS 变量 --step
const rng = createRng();
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const ASSET_BASE = new URL('../', import.meta.url);
const asset = (path) => new URL(encodeURI(path), ASSET_BASE).href;

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

document.documentElement.style.setProperty('--step', `${STEP}ms`);

/* ------------------------------------------------------------------ 设置 */

const DEFAULTS = {
  survivorUlt: 'random',
  hunterUlt: 'random',
  despair: false,
  sound: true,
  excluded: { survivor: [], hunter: [], trait: [] },
};

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { /* 隐私模式等 */ }
  return { ...DEFAULTS, ...saved, excluded: { ...DEFAULTS.excluded, ...(saved.excluded || {}) } };
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
      if (n.content) out[n.id] = n.content.replace(/<br\s*\/?>/gi, '\n');
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
  if (pool('survivor').length < POOL_MIN.survivor) return '角色池里至少要留 4 名求生者，才能凑齐一局。';
  if (pool('hunter').length < POOL_MIN.hunter) return '角色池里至少要留 1 名监管者。';
  if (pool('trait').length < POOL_MIN.trait) return '角色池里至少要留 1 个辅助特质。';
  return null;
}

/* ------------------------------------------------------------------ 抽取 */

let match = null; // { slots: [{ side, char, build, trait? }] }，前 4 个求生者，最后 1 个监管者

function rollFor(side) {
  const tree = data.trees[side];
  const requiredIds = [];
  if (side === 'survivor' && settings.despair) {
    const node = tree.findByName(DESPAIR);
    if (node) requiredIds.push(node.id);
  }
  const ultimateSetting = side === 'survivor' ? settings.survivorUlt : settings.hunterUlt;
  const build = rollBuild(tree, { ultimateSetting, requiredIds }, rng);
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
  const slots = [
    ...survivors.map((char) => ({ side: 'survivor', char, build: rollFor('survivor') })),
    { side: 'hunter', char: hunter, build: rollFor('hunter'), trait: pickOne(pool('trait'), rng) },
  ];
  slots.forEach((s) => preload(s.char.portrait));
  return { slots };
}

function splitBuild(tree, build) {
  const lit = tree.talents.filter((n) => build.levels[n.id]).map((n) => ({ node: n, level: build.levels[n.id] }));
  return {
    ultimates: lit.filter((t) => t.node.is_ultimate),
    others: lit.filter((t) => !t.node.is_ultimate),
  };
}

/* ------------------------------------------------------------------ 动画调度 */

let busy = false;
let skipping = false;
let instantFrame = 0;
const running = new Set();
const skipHooks = new Set();

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
    // 动画类只在播放期间存在，避免移除 .instant 后重播
    document.querySelectorAll('.lighting').forEach((n) => n.classList.remove('lighting'));
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
        <span class="panel-count"></span>
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
    count: $('.panel-count', root),
    webBtn: $('.web-btn', root),
    web: $('.web', root),
    list: $('.talent-list', root),
    traitBox: $('.trait', root),
    traitImg: $('.trait-icon img', root),
    traitName: $('.trait-name', root),
  };

  slot.webBtn.addEventListener('click', () => openTree(slot));
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
  slot.count.textContent = '';
  slot.list.replaceChildren();
}

function fillPanel(slot, entry, animate) {
  const tree = data.trees[slot.side];
  slot.panel.classList.remove('pending');
  slot.panel.classList.toggle('lighting', animate);
  renderWeb(slot.web, tree, entry.build, { animate });
  slot.count.textContent = `${entry.build.used} 层 / ${entry.build.used * POINTS_PER_LAYER} 点`;
  slot.list.replaceChildren(...talentItems(tree, entry.build));
}

function talentItems(tree, build) {
  const { ultimates, others } = splitBuild(tree, build);
  const items = [];
  for (const { node } of ultimates) {
    const li = el('li', 't t-ult');
    const img = new Image();
    img.src = asset(node.icon.local_path);
    img.alt = '';
    li.append(img, el('span', '', node.name));
    li.title = node.desc;
    items.push(li);
  }
  for (const { node, level } of others) {
    const li = el('li', 't', node.name);
    if (node.max_level > 1) li.append(el('small', '', level < node.max_level ? `${level}/${node.max_level}` : `${level}`));
    li.title = node.desc;
    items.push(li);
  }
  items.forEach((li, i) => li.style.setProperty('--i', i));
  return items;
}

function resetTrait(slot) {
  if (!slot.traitBox) return;
  slot.traitBox.classList.remove('rolling', 'locked');
  slot.traitImg.removeAttribute('src');
  slot.traitName.textContent = '待揭晓';
}

function showTrait(slot, trait) {
  slot.traitImg.src = asset(trait.icon.local_path);
  slot.traitName.textContent = trait.name;
}

/* ------------------------------------------------------------------ 人格树 SVG */

function renderWeb(svg, tree, build, { animate = false, detailed = false } = {}) {
  const levels = build?.levels || {};
  svg.replaceChildren();
  svg.classList.toggle('lighting', animate);

  const edges = svgEl('g', { class: 'edges' });
  for (const e of tree.edges) {
    const a = tree.byId.get(e.from);
    const b = tree.byId.get(e.to);
    const line = svgEl('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      class: levels[b.id] ? 'edge lit' : 'edge',
    });
    line.style.setProperty('--d', b.depth - 1);
    line.style.setProperty('--len', Math.hypot(b.x - a.x, b.y - a.y).toFixed(1));
    edges.append(line);
  }

  const nodes = svgEl('g', { class: 'nodes' });
  nodes.append(svgEl('circle', { class: 'hub', r: 13 }));
  for (const n of tree.talents) {
    const level = levels[n.id] || 0;
    const r = n.is_ultimate ? 31 : 25;
    const cls = ['node'];
    if (level) cls.push('lit');
    if (n.is_ultimate) cls.push('ult');
    const g = svgEl('g', { class: cls.join(' '), transform: `translate(${n.x} ${n.y})` });
    g.style.setProperty('--d', n.depth);
    const body = svgEl('g', { class: 'node-body' });
    if (n.is_ultimate) body.append(svgEl('circle', { class: 'burst', r: r + 4 }));
    body.append(svgEl('circle', { class: 'disc', r }));
    if (n.icon?.local_path) {
      body.append(svgEl('image', {
        href: asset(n.icon.local_path), x: -r * 0.8, y: -r * 0.8, width: r * 1.6, height: r * 1.6,
      }));
    }
    if (detailed && level && n.max_level > 1) {
      body.append(svgEl('circle', { class: 'badge', cx: r * 0.78, cy: -r * 0.78, r: 13 }));
      const t = svgEl('text', { class: 'badge-text', x: r * 0.78, y: -r * 0.78 });
      t.textContent = String(level);
      body.append(t);
    }
    const title = svgEl('title');
    title.textContent = `${n.name}　${level}/${n.max_level}${n.is_ultimate ? '（终极人格）' : ''}${n.desc ? `\n${n.desc}` : ''}`;
    g.append(body, title);
    nodes.append(g);
  }
  svg.append(edges, nodes);
}

/** 揭晓后点亮人格面板，返回动画结束的 Promise。 */
function lightPanel(slot, entry, delay = 160) {
  return wait(delay).then(() => {
    const animate = !skipping;
    fillPanel(slot, entry, animate);
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
  play(card, [
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

  // 收拢到桌面中央
  say('shuffle');
  await Promise.all(cards.map((c, i) => play(c,
    [{ transform: 'none' }, { transform: at(to[i]) }],
    { duration: 460, delay: i * 55, easing: 'cubic-bezier(.55,0,.25,1)' })));

  // 两轮洗牌：信封左右错开再合拢
  for (let round = 0; round < 2; round++) {
    say('shuffle');
    await Promise.all(cards.map((c, i) => {
      const shift = ((i + round) % 2 ? 1 : -1) * (48 + rng() * 26);
      return play(c,
        [{ transform: at(to[i]) }, { transform: at(to[i], shift) }, { transform: at(to[i]) }],
        { duration: 300, easing: 'ease-in-out' });
    }));
  }

  // 依次发回各自的位置
  await Promise.all(cards.map((c, i) => {
    later(i * 95 + 330, () => sfx.deal());
    return play(c,
      [{ transform: at(to[i]) }, { transform: 'none' }],
      { duration: 480, delay: i * 95, easing: 'cubic-bezier(.2,.85,.25,1)' });
  }));

  cards.forEach((c) => {
    c.getAnimations().forEach((a) => a.cancel());
    c.style.zIndex = '';
  });
}

async function rollTrait(slot, final) {
  const box = slot.traitBox;
  const candidates = pool('trait');
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

  sequence(async () => {
    const wasOpen = slots.some((s) => s.card.classList.contains('is-open'));
    slots.forEach((s) => { closeCard(s); setPanelPending(s); resetTrait(s); });
    if (wasOpen) { say('flip'); await wait(680); }

    match = next;
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
    await revealHunter(hunter);
    lights.push(lightPanel(hunter, match.slots[4], 60));
    await wait(520);
    await rollTrait(hunter, match.slots[4].trait);
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
  if (!candidates.length) { toast('角色池里没有其他可换的角色了。'); return; }
  const next = pickOne(candidates, rng);
  preload(next.portrait);
  sfx.unlock();

  sequence(async () => {
    closeCard(slot);
    say('flip');
    await wait(680);
    entry.char = next;
    fillLetter(slot, entry);
    say('shuffle');
    await play(slot.card, [
      { transform: 'none' },
      { transform: 'translateY(-12px) rotate(-2.5deg)' },
      { transform: 'translateY(2px) rotate(1.5deg)' },
      { transform: 'none' },
    ], { duration: 460, easing: 'ease-in-out', fill: 'none' });
    if (slot.side === 'hunter') await revealHunter(slot);
    else await openCard(slot);
  });
}

function rerollBuild(slot) {
  const entry = match.slots[slot.index];
  entry.build = rollFor(slot.side);
  sfx.unlock();
  sequence(async () => {
    setPanelPending(slot);
    say('flip');
    await lightPanel(slot, entry, 220);
  });
}

function rerollTrait(slot) {
  const entry = match.slots[slot.index];
  const candidates = pool('trait');
  const others = candidates.filter((t) => t.name !== entry.trait.name);
  entry.trait = pickOne(others.length ? others : candidates, rng);
  sfx.unlock();
  sequence(() => rollTrait(slot, entry.trait));
}

/* ------------------------------------------------------------------ 复制结果 */

function buildLines(entry) {
  const tree = data.trees[entry.side];
  const { ultimates, others } = splitBuild(tree, entry.build);
  const other = others.map(({ node, level }) => (node.max_level > 1 ? `${node.name}${level}/${node.max_level}` : node.name));
  return [
    `   终极人格：${ultimates.length ? ultimates.map((t) => t.node.name).join('、') : '无'}`,
    `   其他人格：${other.join('、') || '无'}`,
    `   共 ${entry.build.used} 层，${entry.build.used * POINTS_PER_LAYER} 点`,
  ];
}

function resultText() {
  const lines = ['第五人格 4v1 抽取结果', '', '【求生者】'];
  match.slots.forEach((entry, i) => {
    if (entry.side !== 'survivor') return;
    lines.push(`${i + 1}. ${entry.char.name}（${(entry.char.roles || []).join('、')}）`, ...buildLines(entry));
  });
  const hunter = match.slots[4];
  lines.push('', '【监管者】', `${hunter.char.name}　辅助特质：${hunter.trait.name}`, ...buildLines(hunter));
  return lines.join('\n');
}

async function copyResult() {
  if (!match || busy) return;
  const text = resultText();
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
  toast(copied ? '已复制本局结果' : '浏览器不允许自动复制，请在控制台查看结果文本');
  if (!copied) console.log(text);
}

/* ------------------------------------------------------------------ 人格树详情 */

function openTree(slot) {
  const entry = match?.slots[slot.index];
  if (!entry || busy) return;
  const tree = data.trees[slot.side];
  const { ultimates, others } = splitBuild(tree, entry.build);
  const dlg = $('#dlg-tree');
  dlg.classList.remove('side-survivor', 'side-hunter');
  dlg.classList.add(`side-${slot.side}`);
  $('#tree-title').textContent = `${entry.char.name}的人格`;
  $('#tree-sub').textContent = `${entry.build.used} 层，${entry.build.used * POINTS_PER_LAYER} 点。`
    + (ultimates.length ? `终极人格：${ultimates.map((t) => t.node.name).join('、')}` : '这套人格没有终极人格');

  const svg = svgEl('svg', { class: 'web', viewBox: '-372 -372 744 744', role: 'img', 'aria-label': '人格树' });
  renderWeb(svg, tree, entry.build, { detailed: true });
  $('#tree-web').replaceChildren(svg);

  $('#tree-list').replaceChildren(...[...ultimates, ...others].map(({ node, level }) => {
    const li = el('li', node.is_ultimate ? 'is-ult' : '');
    const img = new Image();
    img.src = asset(node.icon.local_path);
    img.alt = '';
    const body = el('div');
    const head = el('p', 'tree-item-head');
    head.append(el('b', '', node.name), el('span', '', node.is_ultimate ? '终极人格' : `${level}/${node.max_level} 层`));
    body.append(head);
    if (node.desc) body.append(el('p', 'tree-item-desc', node.desc));
    li.append(img, body);
    return li;
  }));
  dlg.showModal();
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
}

function bindPool() {
  const dlg = $('#dlg-pool');
  $('#btn-pool').addEventListener('click', () => { renderPool(); dlg.showModal(); });
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
  $('#btn-pool').disabled = busy;
  document.querySelectorAll('.slot-actions .btn, .web-btn').forEach((b) => { b.disabled = !match || busy; });
  document.body.classList.toggle('is-busy', busy);
}

function syncSettingsUI() {
  document.querySelectorAll('.segmented').forEach((group) => {
    const value = String(group.dataset.setting === 'survivor' ? settings.survivorUlt : settings.hunterUlt);
    group.querySelectorAll('[role="radio"]').forEach((b) => {
      const on = b.dataset.value === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  });
  $('#opt-despair').checked = settings.despair;
  const sound = $('#btn-sound');
  sound.textContent = settings.sound ? '音效：开' : '音效：关';
  sound.setAttribute('aria-pressed', String(settings.sound));
  sfx.setEnabled(settings.sound);
}

function bindControls() {
  document.querySelectorAll('.segmented').forEach((group) => {
    const choose = (button) => {
      const value = button.dataset.value === 'random' ? 'random' : Number(button.dataset.value);
      if (group.dataset.setting === 'survivor') settings.survivorUlt = value; else settings.hunterUlt = value;
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
    saveSettings();
  });
  $('#btn-sound').addEventListener('click', () => {
    settings.sound = !settings.sound;
    saveSettings();
    syncSettingsUI();
  });
  $('#btn-draw').addEventListener('click', draw);
  $('#btn-copy').addEventListener('click', copyResult);
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
  try {
    await loadData();
  } catch (err) {
    console.error(err);
    $('#notice').textContent = `暂时无法读取角色数据（${err.message}），请刷新页面后重试。`;
    return;
  }
  buildTable();
  syncButtons();
  requestAnimationFrame(() => { void warmAllImages(); });
}

main();
