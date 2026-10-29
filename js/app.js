import { sfx } from './sound.js';
import {
  POINTS_PER_LAYER, createRng, pickOne, sample, prepareTree, rollBuild, validateBuild,
} from './rules.js';

/* ------------------------------------------------------------------ 基础 */

const $ = (sel, root = document) => root.querySelector(sel);
const SVG_NS = 'http://www.w3.org/2000/svg';
const STORE_KEY = 'pil-lottery:v1';
const ORDINALS = ['第一位', '第二位', '第三位', '第四位'];
const DESPAIR = '绝处逢生';
const STEP = 140; // 人格树每一圈点亮的间隔（毫秒），同步到 CSS 变量 --step
const SEP = '　'; // 复制结果里的分隔符（全角空格）
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
  drawTrait: true,
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

/** 人格文案：换行标签转成换行，去掉“【WIKI编辑组注：…】”。 */
function cleanDescription(text) {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/【\s*WIKI编辑组注[\s\S]*?】/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
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
    { side: 'hunter', char: hunter, build: rollFor('hunter'), trait: settings.drawTrait ? pickOne(pool('trait'), rng) : null },
  ];
  slots.forEach((s) => preload(s.char.portrait));
  return { slots, at: new Date() };
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
    const g = svgEl('g', { class: cls.join(' '), transform: `translate(${n.x} ${n.y})`, 'data-id': n.id });
    g.style.setProperty('--d', n.depth);
    if (detailed) {
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', `${n.name}，${talentStatus(n, level)}`);
    }
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
    g.append(body);
    if (!detailed) {
      const title = svgEl('title');
      title.textContent = `${n.name}　${level}/${n.max_level}${n.is_ultimate ? '（终极人格）' : ''}${n.desc ? `\n${n.desc}` : ''}`;
      g.append(title);
    }
    nodes.append(g);
  }
  svg.append(edges, nodes);
}

function talentStatus(node, level) {
  if (node.is_ultimate) return level ? '终极人格' : '终极人格（未点亮）';
  return level ? `${level}/${node.max_level} 层` : `未点亮（最高 ${node.max_level} 层）`;
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
    if (match.slots[4].trait) {
      await wait(520);
      await rollTrait(hunter, match.slots[4].trait);
    } else {
      showTraitFree(hunter);
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
  preload(next.portrait);
  sfx.unlock();

  sequence(async () => {
    closeCard(slot);
    say('flip');
    await wait(680);
    entry.char = next;
    match.at = new Date();
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
  match.at = new Date();
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
  if (!candidates.length) { toast('卡池里至少要留 1 个辅助特质。'); return; }
  const others = candidates.filter((t) => t.name !== entry.trait?.name);
  entry.trait = pickOne(others.length ? others : candidates, rng);
  match.at = new Date();
  sfx.unlock();
  sequence(() => rollTrait(slot, entry.trait));
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
    toast(`已复制${name}的人格树图片`);
  } catch {
    try {
      downloadBlob(await blobPromise, `${name}-人格树.png`);
      toast('浏览器不允许复制图片，已下载为 PNG');
    } catch (err) {
      console.error(err);
      toast('人格树图片生成失败，请重试');
    }
  }
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

  const svg = svgEl('svg', { class: 'web', viewBox: '-372 -372 744 744', role: 'group', 'aria-label': '人格树，点击人格图标查看详情' });
  renderWeb(svg, tree, entry.build, { detailed: true });
  $('#tree-web').replaceChildren(svg);

  const list = $('#tree-list');
  list.replaceChildren(...[...ultimates, ...others].map(({ node, level }) => {
    const li = el('li', node.is_ultimate ? 'is-ult' : '');
    li.dataset.id = node.id;
    const img = new Image();
    img.src = asset(node.icon.local_path);
    img.alt = '';
    const body = el('div');
    const head = el('p', 'tree-item-head');
    head.append(el('b', '', node.name), el('span', '', talentStatus(node, level)));
    body.append(head);
    if (node.desc) body.append(el('p', 'tree-item-desc', node.desc));
    li.append(img, body);
    return li;
  }));

  const focus = $('#tree-focus');
  focus.className = 'tree-focus is-empty';
  focus.textContent = '点击人格树上的图标，查看对应人格的说明。';

  const select = (id) => {
    const node = tree.byId.get(id);
    if (!node || node.is_center) return;
    const level = entry.build.levels[id] || 0;
    svg.querySelectorAll('.node.is-selected').forEach((g) => g.classList.remove('is-selected'));
    svg.querySelector(`.node[data-id="${id}"]`)?.classList.add('is-selected');
    let selectedItem = null;
    list.querySelectorAll('li').forEach((li) => {
      const on = li.dataset.id === id;
      li.classList.toggle('is-selected', on);
      if (on) selectedItem = li;
    });

    const cls = ['tree-focus'];
    if (node.is_ultimate) cls.push('is-ult');
    if (!level) cls.push('is-off');
    focus.className = cls.join(' ');
    const img = new Image();
    img.src = asset(node.icon.local_path);
    img.alt = '';
    const body = el('div');
    const head = el('p', 'tree-focus-head');
    head.append(el('b', '', node.name), el('span', '', talentStatus(node, level)));
    body.append(head, el('p', 'tree-focus-desc', node.desc || '暂无说明。'));
    focus.replaceChildren(img, body);
    selectedItem?.scrollIntoView({ block: 'nearest' });
  };

  svg.addEventListener('click', (e) => {
    const g = e.target.closest('.node[data-id]');
    if (g) select(g.dataset.id);
  });
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const g = e.target.closest('.node[data-id]');
    if (!g) return;
    e.preventDefault();
    select(g.dataset.id);
  });
  list.onclick = (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) select(li.dataset.id);
  };

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
  $('#btn-copy-brief').disabled = !match || busy;
  $('#btn-pool').disabled = busy;
  $('#opt-trait').disabled = busy;
  document.querySelectorAll('.slot-actions .btn, .web-btn, .panel-copy').forEach((b) => { b.disabled = !match || busy; });
  document.querySelectorAll('[data-act="trait"]').forEach((b) => { b.hidden = !settings.drawTrait; });
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
  $('#opt-trait').checked = settings.drawTrait;
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
  $('#opt-trait').addEventListener('change', (e) => {
    if (e.target.checked && !pool('trait').length) {
      e.target.checked = false;
      toast('卡池里至少要留 1 个辅助特质，才能抽取。');
      return;
    }
    settings.drawTrait = e.target.checked;
    saveSettings();
    syncButtons();
    applyTraitSetting();
  });
  $('#btn-sound').addEventListener('click', () => {
    settings.sound = !settings.sound;
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
