import { withRequestTimeout } from './request-timeout.js';
import { createPlayerSessions } from './live-session.js';
import { reconnectDelay, retryAfterMs } from './live-retry.js';
// 选手页：保持和服务器的连接，收到推送后自动更新，不需要手动刷新。
import { sfx } from './sound.js';
import { prepareTree } from './rules.js';
import { LIVE_VIEW_NAMES } from './live-visibility.js';
import {
  applyPortraitView, asset, cleanDescription, despairItem, el, renderWeb, showTreeDialog, talentItems,
} from './shared-ui.js';

const $ = (sel, root = document) => root.querySelector(sel);
const ORDINALS = ['第一位', '第二位', '第三位', '第四位'];
const API = '/lottery/live-api/rooms';
const WATCHDOG_MS = 35_000; // 服务器每 25 秒发一次 ping，超时视为断线
const FLIP_MS = 460;
const ENTRY_POLL_MS = 5000;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const data = { survivors: new Map(), hunters: new Map(), traits: new Map(), trees: {} };
const slots = [];
let shownRound = null;
let firstState = true;
let source = null;
let lastEvent = 0;
let retryAttempt = 0;
let retryInFlight = false;
let joinBusyUntil = 0;
let retryTimer = 0;
let closed = true; // 还没进入房间，或已被退回进入页
let connection = null; // { url, checkUrl }
let tableBuilt = false;
let everConnected = false;
let latestState = null;
let instantFrame = 0;
let shuffleRun = 0;
const shuffleAnimations = new Set();

async function getJSON(path) {
  const res = await fetch(asset(path));
  if (!res.ok) throw new Error(`${path} 返回 HTTP ${res.status}`);
  return res.json();
}

async function loadData() {
  const [chars, trees, traits, config] = await Promise.all([
    getJSON('characters.json'), getJSON('talent-trees.json'), getJSON('auxiliary-traits.json'),
    getJSON('tree-config-source.json').catch(() => null), // 只用来补人格描述，缺了也能用
  ]);
  const descriptions = (side) => {
    const out = {};
    for (const n of config?.[side]?.treeData?.nodes || []) {
      if (n.content) out[n.id] = cleanDescription(n.content);
    }
    return out;
  };
  chars.survivors.forEach((c) => data.survivors.set(c.id, c));
  chars.hunters.forEach((c) => data.hunters.set(c.id, c));
  traits.traits.forEach((t) => data.traits.set(t.name, t));
  data.trees.survivor = prepareTree(trees.trees.survivor, descriptions('survivor'));
  data.trees.hunter = prepareTree(trees.trees.hunter, descriptions('hunter'));
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
          <span class="env-address"></span>
        </div>
        <div class="face face-letter">
          <img class="portrait" alt="" decoding="async">
          <ul class="roles" aria-label="定位"></ul>
          <h3 class="name"></h3>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><span class="panel-title">人格</span></div>
      ${hunter ? `
      <div class="trait">
        <span class="trait-icon"><img alt=""></span>
        <span class="trait-text"><span class="trait-label">辅助特质</span><b class="trait-name"></b></span>
      </div>` : ''}
      <button type="button" class="web-btn" aria-label="查看完整人格树"><svg class="web" viewBox="-372 -372 744 744" aria-hidden="true"></svg></button>
      <p class="live-note" hidden></p>
      <ul class="talent-list"></ul>
    </div>`;
  const slot = {
    index, side, root,
    defaultAddress: hunter ? '监管者' : `${ORDINALS[index]}求生者`,
    card: $('.card', root),
    sealHalves: [$('.seal-l', root), $('.seal-r', root)],
    address: $('.env-address', root),
    portrait: $('.portrait', root),
    roles: $('.roles', root),
    name: $('.name', root),
    panel: $('.panel', root),
    webBox: $('.web-btn', root),
    web: $('.web', root),
    note: $('.live-note', root),
    list: $('.talent-list', root),
    traitBox: $('.trait', root),
    traitImg: $('.trait-icon img', root),
    traitName: $('.trait-name', root),
    seen: { char: '', build: '', trait: '' },
    charRun: 0,
    rerolling: false,
    charReady: Promise.resolve(),
    buildRun: 0,
    wantedBuild: '',
    traitTimer: 0,
    charName: '',
    fullBuild: null,
  };
  slot.webBox.addEventListener('click', () => {
    if (!slot.fullBuild) return;
    showTreeDialog({ tree: data.trees[side], build: slot.fullBuild, side, name: slot.charName || (hunter ? '监管者' : '求生者') });
  });
  return slot;
}

function summaryItem(className, text, iconPath) {
  const li = el('li', `t t-ult ${className}`);
  if (iconPath) {
    const img = new Image();
    img.src = asset(iconPath);
    img.alt = '';
    li.append(img);
  }
  li.append(el('span', '', text));
  return li;
}

/** 看不到全部人格时的摘要：最终天赋一行，绝处逢生一行。 */
function limitedItems(tree, build) {
  const items = [];
  if (build.status === 'ultimates') {
    const nodes = build.ultimates.map((id) => tree.byId.get(id));
    if (nodes.length) items.push(...nodes.map((n) => summaryItem(nodes.length === 1 ? 'is-single' : '', n.name, n.icon?.local_path)));
    else items.push(summaryItem('is-single is-none', '无最终天赋'));
  }
  if (build.despair !== undefined) items.push(despairItem(tree, build.despair));
  items.forEach((li, i) => li.style.setProperty('--i', i));
  return items;
}

function buildTable() {
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
    resetSlot(slot);
  }
  $('#table').replaceChildren(survivorSide, divider, hunterSide);
}

function resetSlot(slot) {
  slot.charRun++;
  slot.rerolling = false;
  slot.charReady = Promise.resolve();
  slot.buildRun++;
  slot.wantedBuild = '';
  stopTraitRoll(slot);
  slot.charName = '';
  slot.seen = { char: '', build: '', trait: '' };
  slot.card.classList.remove('is-open', 'is-charging', 'live-rerolling');
  slot.sealHalves.forEach((half) => half.getAnimations().forEach((a) => a.cancel()));
  slot.address.textContent = slot.defaultAddress;
  slot.name.textContent = '';
  slot.portrait.removeAttribute('src');
  slot.portrait.alt = '';
  slot.roles.replaceChildren();
  applyBuild(slot, { status: 'pending' }, false);
  if (slot.traitBox) applyTrait(slot, { status: 'pending' }, false);
}

function crackSeal(slot) {
  const [l, r] = slot.sealHalves;
  const opts = { duration: 420, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' };
  l.animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(-22px, 14px) rotate(-32deg)', opacity: 0 }], opts);
  r.animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(20px, 18px) rotate(26deg)', opacity: 0 }], opts);
}

/** 揭晓或更换角色；重复快照不会重启动画，新快照可取消旧的揭晓。 */
function applyChar(slot, char, animate) {
  const key = JSON.stringify(char);
  if (key === slot.seen.char) return;
  const previous = slot.seen.char ? JSON.parse(slot.seen.char) : null;
  slot.rerolling = char.status === 'pending' && Boolean(previous && previous.status !== 'pending');
  slot.seen.char = key;
  if ($('#dlg-tree').open) $('#dlg-tree').close();
  const run = ++slot.charRun;
  slot.charName = '';
  slot.charReady = revealChar(slot, char, animate, run);
}

async function revealChar(slot, char, animate, run) {
  const wasOpen = slot.card.classList.contains('is-open');
  if (char.status !== 'shown') {
    slot.card.classList.remove('is-open');
    slot.address.textContent = char.status === 'hidden' ? '角色未公开' : slot.defaultAddress;
    slot.sealHalves.forEach(half => half.getAnimations().forEach(a => a.cancel()));
    return;
  }
  if (wasOpen && animate) {
    slot.card.classList.remove('is-open');
    sfx.flip();
    await new Promise(resolve => setTimeout(resolve, FLIP_MS));
    if (run !== slot.charRun) return;
  }
  const info = (slot.side === 'survivor' ? data.survivors : data.hunters).get(char.id);
  if (!info) return;
  applyPortraitView(slot.portrait, info);
  slot.portrait.src = asset(info.portrait);
  slot.portrait.alt = `${info.name}立绘`;
  slot.name.textContent = info.name;
  slot.charName = info.name;
  slot.roles.replaceChildren(...(slot.side === 'survivor' ? (info.roles || []).map(r => el('li', '', r)) : []));
  if (animate) {
    crackSeal(slot);
    sfx.crack();
    await new Promise(resolve => setTimeout(resolve, 200));
    if (run !== slot.charRun) return;
  }
  slot.card.classList.remove('is-charging', 'live-rerolling');
  slot.card.classList.add('is-open');
  if (animate) {
    sfx.flip();
    await new Promise(resolve => setTimeout(resolve, 420));
    if (run !== slot.charRun) return;
    if (slot.side === 'hunter') sfx.boom();
  }
}

/** 人格必须等本页的角色翻牌，避免名单和详情按钮抢先揭晓。 */
function queueBuild(slot, build, animate) {
  const key = JSON.stringify(build);
  if (key === slot.wantedBuild) return;
  slot.wantedBuild = key;
  const run = ++slot.buildRun;
  if ($('#dlg-tree').open) $('#dlg-tree').close();
  slot.fullBuild = null;
  slot.webBox.disabled = true;
  if (!animate || build.status === 'pending') {
    applyBuild(slot, build, animate);
    return;
  }
  slot.charReady.then(() => {
    if (run === slot.buildRun) applyBuild(slot, build, true);
  });
}

function applyBuild(slot, build, animate) {
  const tree = data.trees[slot.side];
  const key = JSON.stringify(build);
  if (key === slot.seen.build) return;
  slot.seen.build = key;
  slot.note.hidden = true;
  slot.panel.classList.remove('lighting');
  slot.list.replaceChildren();
  // 只有能看到全部人格时才显示人格树
  slot.webBox.hidden = build.status === 'pending' ? Boolean(build.limited) : build.status !== 'full';
  slot.webBox.disabled = build.status !== 'full';
  slot.fullBuild = build.status === 'full' ? build : null;
  slot.list.classList.toggle('is-limited', build.status !== 'full' && build.status !== 'pending');
  if (build.status === 'pending') {
    slot.panel.classList.add('pending');
    renderWeb(slot.web, tree, null);
    return;
  }
  slot.panel.classList.remove('pending');
  slot.panel.classList.toggle('lighting', animate);
  if (build.status !== 'full') {
    slot.note.textContent = '人格未公开';
    slot.note.hidden = build.status !== 'hidden';
    slot.list.replaceChildren(...limitedItems(tree, build));
    return;
  }
  renderWeb(slot.web, tree, build, { animate });
  slot.list.replaceChildren(...talentItems(tree, build));
  if (animate) sfx.light(0);
}

function applyTrait(slot, trait, animate) {
  const key = JSON.stringify(trait);
  if (key === slot.seen.trait) return;
  slot.seen.trait = key;
  stopTraitRoll(slot);
  const box = slot.traitBox;
  box.classList.remove('rolling', 'locked', 'is-free');
  slot.traitImg.removeAttribute('src');
  if (trait.status === 'shown') {
    const info = data.traits.get(trait.name);
    if (info) slot.traitImg.src = asset(info.icon.local_path);
    slot.traitName.textContent = trait.name;
    box.classList.add('locked');
    if (animate) sfx.lock();
  } else if (trait.status === 'free') {
    box.classList.add('is-free');
    slot.traitName.textContent = '自选';
  } else {
    slot.traitName.textContent = trait.status === 'hidden' ? '未公开' : '待揭晓';
  }
}

const PHASE_TEXT = {
  idle: '等待裁判开始',
  drawing: '裁判正在抽取',
  hunter: '监管者即将揭晓',
  trait: '辅助特质抽取中',
  done: '抽取完成',
};

/** 洗牌只移动信封；收到揭晓、跳过、重连或退出时立即归位。 */
function stopShuffle() {
  shuffleRun++;
  for (const animation of shuffleAnimations) animation.cancel();
  shuffleAnimations.clear();
  for (const { card } of slots) {
    card.style.removeProperty('transform');
    card.style.removeProperty('z-index');
  }
}

async function shuffleAndDeal() {
  stopShuffle();
  const run = shuffleRun;
  const rects = slots.map(slot => slot.card.getBoundingClientRect());
  const cx = (Math.min(...rects.map(r => r.left)) + Math.max(...rects.map(r => r.right))) / 2;
  const cy = (Math.max(0, Math.min(...rects.map(r => r.top))) + Math.min(innerHeight, Math.max(...rects.map(r => r.bottom)))) / 2;
  const poses = rects.map((r, i) => ({ x: cx - r.left - r.width / 2, y: cy - r.top - r.height / 2, angle: (i - 2) * 3.5 }));
  const at = (i, shift = 0) => `translate(${poses[i].x + shift}px, ${poses[i].y}px) rotate(${poses[i].angle + shift / 9}deg)`;
  const move = async (i, transforms, options) => {
    const card = slots[i].card;
    const animation = card.animate(transforms.map(transform => ({ transform })), { fill: 'forwards', ...options });
    shuffleAnimations.add(animation);
    try {
      await animation.finished;
      if (run === shuffleRun) card.style.transform = transforms[transforms.length - 1];
    } catch { /* A newer state cancelled this motion. */ }
    finally { animation.cancel(); shuffleAnimations.delete(animation); }
  };
  slots.forEach((slot, i) => { slot.card.style.zIndex = String(10 + i); });
  try {
    sfx.shuffle();
    await Promise.all(slots.map((_, i) => move(i, ['none', at(i)], { duration: 460, delay: i * 55, easing: 'cubic-bezier(.55,0,.25,1)' })));
    for (let round = 0; round < 2; round++) {
      if (run !== shuffleRun) return;
      sfx.shuffle();
      await Promise.all(slots.map((_, i) => move(i, [at(i), at(i, (i + round) % 2 ? 60 : -60), at(i)], { duration: 300, easing: 'ease-in-out' })));
    }
    if (run !== shuffleRun) return;
    await Promise.all(slots.map((_, i) => move(i, [at(i), 'none'], { duration: 480, delay: i * 95, easing: 'cubic-bezier(.2,.85,.25,1)' })));
  } finally { if (run === shuffleRun) stopShuffle(); }
}

function stopTraitRoll(slot) {
  clearTimeout(slot.traitTimer);
  slot.traitTimer = 0;
  slot.traitBox?.classList.remove('rolling');
}

function startTraitRoll(slot) {
  if (slot.traitTimer) return;
  // 只用公开图标作滚动装饰，不依赖未揭晓的结果或主控私有卡池。
  const icons = [...data.traits.values()];
  let index = 0;
  slot.traitBox.classList.remove('locked', 'is-free');
  slot.traitBox.classList.add('rolling');
  slot.traitName.textContent = '抽取中';
  const tick = () => {
    if (icons.length) slot.traitImg.src = asset(icons[index++ % icons.length].icon.local_path);
    sfx.tick();
    slot.traitTimer = setTimeout(tick, 100);
  };
  tick();
}

function stopLiveMotion() {
  stopShuffle();
  for (const slot of slots) {
    slot.charRun++;
    slot.buildRun++;
    stopTraitRoll(slot);
    slot.card.classList.remove('is-charging', 'live-rerolling');
    slot.sealHalves.forEach(half => half.getAnimations().forEach(a => a.cancel()));
  }
}

function applyState(state) {
  latestState = state;
  const animate = !firstState && !document.hidden && !reduceMotion.matches;
  const activeMotion = !document.hidden && !reduceMotion.matches;
  const newRound = state.round !== shownRound;
  const restart = firstState || newRound;
  cancelAnimationFrame(instantFrame);
  document.body.classList.toggle('instant', !animate);
  if (restart) {
    stopLiveMotion();
    shownRound = state.round;
    slots.forEach(resetSlot);
    if ($('#dlg-tree').open) $('#dlg-tree').close();
  }
  const allPending = state.slots.length === 5 && state.slots.every(entry => entry.char.status === 'pending');
  if (state.phase !== 'drawing' || !allPending || !activeMotion) stopShuffle();
  else if (restart) void shuffleAndDeal();

  $('#live-view').textContent = `${LIVE_VIEW_NAMES[state.view]}视角`;
  $('#live-phase').textContent = PHASE_TEXT[state.phase];
  if (!state.slots.length) {
    slots.forEach(slot => queueBuild(slot, state.limited[slot.side] ? { status: 'pending', limited: true } : { status: 'pending' }, false));
  }
  state.slots.forEach((entry, i) => {
    const slot = slots[i];
    applyChar(slot, entry.char, animate);
    queueBuild(slot, entry.build, animate);
    // 单项重抽保持其他四张牌不动。
    slot.card.classList.toggle('live-rerolling', activeMotion && slot.rerolling && state.phase === 'drawing' && entry.char.status === 'pending');
    if (slot.traitBox) applyTrait(slot, entry.trait, animate);
  });
  const hunter = slots[4];
  hunter.card.classList.toggle('is-charging', activeMotion && state.phase === 'hunter' && state.slots[4]?.char.status === 'pending');
  if (state.phase === 'trait' && state.slots[4]?.trait.status === 'pending') {
    if (activeMotion) startTraitRoll(hunter);
    else { stopTraitRoll(hunter); hunter.traitName.textContent = '抽取中'; }
  } else stopTraitRoll(hunter);
  firstState = false;
  if (!animate) {
    // 强制提交无动画的快照，再恢复之后的新事件动画。
    void document.body.offsetHeight;
    instantFrame = requestAnimationFrame(() => {
      instantFrame = requestAnimationFrame(() => document.body.classList.remove('instant'));
    });
  }
}

const CONN_ALERTS = {
  retry: {
    title: '连接已中断',
    waiting: true,
  },
  reconnected: {
    title: '已重新连接',
    body: '页面已更新到最新状态。',
    success: true,
  },
};
const RECONNECTED_CLOSE_MS = 1600; // 成功动画播放完后自动关闭
const ALERT_FADE_MS = 220; // 与 CSS 的淡出时长对应
let reconnectedTimer = 0;
let lostAt = 0;
let lostTicker = 0;

function syncLostSeconds() {
  const seconds = Math.floor((Date.now() - lostAt) / 1000);
  $('#conn-waiting').textContent = `正在等待重连......（${seconds} 秒）`;
}

function showConnAlert(kind) {
  const alert = CONN_ALERTS[kind];
  const dlg = $('#dlg-conn');
  clearTimeout(reconnectedTimer);
  dlg.classList.remove('is-closing');
  dlg.dataset.kind = kind;
  dlg.classList.toggle('is-success', Boolean(alert.success));
  dlg.classList.toggle('is-retry', Boolean(alert.waiting));
  $('#conn-fail').style.display = alert.waiting ? 'block' : 'none';
  $('#conn-checklist').hidden = !alert.waiting;
  $('#conn-body').hidden = !alert.body;
  $('#conn-check').style.display = alert.success ? 'block' : 'none';
  $('#conn-title').textContent = alert.title;
  $('#conn-body').textContent = alert.body || '';
  $('#conn-waiting').hidden = !alert.waiting;
  if (!dlg.open) dlg.showModal();
}

function stopLostTimer() {
  clearInterval(lostTicker);
  lostAt = 0;
}

/** 重连成功：弹窗转为成功状态，播放动画后自动关闭。 */
function showReconnected() {
  const dlg = $('#dlg-conn');
  showConnAlert('reconnected');
  reconnectedTimer = setTimeout(() => {
    dlg.classList.add('is-closing');
    reconnectedTimer = setTimeout(() => {
      delete dlg.dataset.kind;
      dlg.close();
    }, ALERT_FADE_MS);
  }, RECONNECTED_CLOSE_MS);
}

function setConnection(kind, text) {
  const node = $('#live-conn');
  node.dataset.state = kind;
  node.textContent = text;
  if (kind === 'on') {
    stopLostTimer();
    if ($('#dlg-conn').dataset.kind === 'retry') showReconnected();
  }
}

/** 连接中断：立即提示，选手不能手动关闭，恢复后自动关闭。 */
function connectionLost() {
  setConnection('lost', '连接中断，正在重连…');
  if (!lostAt) {
    lostAt = Date.now();
    syncLostSeconds();
    lostTicker = setInterval(syncLostSeconds, 1000);
  }
  if (!closed) showConnAlert('retry');
}

const LEAVE_MESSAGES = {
  reset: '房间已重置，请重新进入。',
  'password-changed': '密码已更改，请使用新密码重新进入。',
  'seat-cleared': '裁判已清空该身份的名额，请重新进入。',
  'view-closed': '裁判已关闭该身份，请选择其他身份。',
  'room-closed': '房间已结束，请向裁判确认房间号。',
  'room-not-found': '房间不存在或已结束，请向裁判确认房间号。',
  'view-full': '该身份人数已满，请联系裁判。',
  'invalid-session': '身份已失效，请重新进入。',
  'session-replaced': '已在其他页面退出或切换身份，请重新进入。',
};
const JOIN_ERRORS = {
  'wrong-password': '密码不正确，请重新输入。',
  'server-busy': '进入的人较多，请稍后重试，已输入的密码会保留。',
  'room-changed': '房间设置已更改，请确认后重新进入。',
  'view-full': LEAVE_MESSAGES['view-full'],
  'view-closed': LEAVE_MESSAGES['view-closed'],
  'too-many-attempts': '尝试次数过多，请 10 分钟后再试。',
  'room-not-found': LEAVE_MESSAGES['room-not-found'],
};

const NONE_OPEN = '裁判暂未开放任何身份，请稍候。';

const playerSessions = createPlayerSessions();
const loadSession = room => playerSessions.load(room);
const saveSession = (room, value) => playerSessions.save(room, value);
const EXIT_PENDING = '退出尚未完成，名额可能仍被占用。请重试退出，或重新选择身份进入。';
const EXIT_SAVING = '正在退出房间，请稍候…';
const entry = { room: '', view: '', info: null };

function showEntry(message = '') {
  $('#live-entry').hidden = false;
  $('#table').hidden = true;
  $('#live-conn').hidden = true;
  $('#btn-leave').hidden = true;
  $('#live-view').textContent = '';
  $('#live-phase').textContent = '输入房间号进入';
  setEntryMessage(message);
}

function setEntryMessage(message) {
  $('#entry-message').hidden = !message;
  $('#entry-message').textContent = message;
}

/** 主动退出保留凭证和退出记录；收到服务器撤销通知后才清理对应凭证。 */
function leaveRoom(message, { kept = false } = {}) {
  const leavingSession = connection?.session;
  closed = true;
  connection = null;
  source?.close();
  source = null;
  clearTimeout(retryTimer); retryTimer = 0;
  stopLostTimer();
  const dlg = $('#dlg-conn');
  delete dlg.dataset.kind;
  if (dlg.open) dlg.close();
  if ($('#dlg-tree').open) $('#dlg-tree').close();
  if (!kept) playerSessions.forget(entry.room, leavingSession);
  stopLiveMotion();
  latestState = null;
  shownRound = null;
  firstState = true;
  everConnected = false;
  showEntry(message);
  $('#entry-room').value = entry.room;
  refreshEntryInfo();
}

function enterRoom(room, session) {
  entry.room = room;
  history.replaceState(null, '', `#${room}`);
  $('#live-entry').hidden = true;
  if (!tableBuilt) {
    buildTable();
    tableBuilt = true;
  }
  $('#table').hidden = false;
  $('#live-conn').hidden = false;
  $('#btn-leave').hidden = false;
  closed = false;
  retryAttempt = 0;
  const query = `session=${encodeURIComponent(session)}`;
  connection = { session, view: loadSession(room)?.view, url: `${API}/${room}/events?${query}`, checkUrl: `${API}/${room}/check?${query}` };
  connect(connection.url, connection.checkUrl);
}

function renderEntryViews() {
  const { info } = entry;
  const room = $('#entry-room').value.trim();
  const pending = playerSessions.pending(room);
  const savingExit = playerSessions.isLeaving(room);
  $('#entry-retry-leave').hidden = !pending;
  $('#entry-retry-leave').disabled = savingExit;
  $('#entry-retry-leave').textContent = savingExit ? '正在退出…' : '重试退出';
  if (info?.views[entry.view]?.open === false) entry.view = '';
  $('#entry-views-box').hidden = !info;
  const noneOpen = Boolean(info) && Object.values(info.views).every((access) => access.open === false);
  if (noneOpen && $('#entry-message').hidden) setEntryMessage(NONE_OPEN);
  else if (!noneOpen && $('#entry-message').textContent === NONE_OPEN) setEntryMessage('');
  document.querySelectorAll('#entry-views [data-view]').forEach((button) => {
    const access = info?.views[button.dataset.view];
    const on = button.dataset.view === entry.view;
    button.setAttribute('aria-checked', String(on));
    button.tabIndex = on || !entry.view ? 0 : -1;
    if (!access) return;
    button.hidden = access.open === false;
    const parts = [];
    if (access.password) parts.push('需要密码');
    if (access.effectiveLimit || access.limit) parts.push(`${access.taken}/${access.effectiveLimit || access.limit}`);
    const canReplace = pending?.view === button.dataset.view;
    $('small', button).textContent = canReplace ? '原身份，可尝试重新进入' : access.full ? `人数已满${access.limit ? ` ${access.taken}/${access.limit}` : ''}` : parts.join(' · ') || '可直接进入';
    button.classList.toggle('is-full', access.full && !canReplace);
  });
  const needsPassword = Boolean(entry.view && info?.views[entry.view]?.password);
  $('#entry-password-box').hidden = !needsPassword;
  if (!needsPassword) $('#entry-password').value = '';
  const canReplace = pending?.view === entry.view;
  $('#entry-submit').disabled = !info || !entry.view || savingExit || (Boolean(info.views[entry.view]?.full) && !canReplace) || Date.now() < joinBusyUntil;
}

let entryRequest = 0;

/** 读取房间的身份信息。message 为空时才显示读取错误，避免盖掉退回进入页的原因。 */
async function refreshEntryInfo() {
  const room = $('#entry-room').value.trim();
  const request = ++entryRequest;
  // 同一房间刷新名额时保留旧信息，避免界面闪动
  if (room !== entry.room) entry.info = null;
  if (!/^\d{6}$/.test(room)) { entry.info = null; renderEntryViews(); return; }
  try {
    const res = await fetch(`${API}/${room}/info`, { cache: 'no-store' });
    if (request !== entryRequest) return;
    if (!res.ok) {
      entry.info = null;
      const { error } = await res.json().catch(() => ({}));
      if ($('#entry-message').hidden) setEntryMessage(JOIN_ERRORS[error] || '暂时无法读取房间，请稍后再试。');
      renderEntryViews();
      return;
    }
    const info = await res.json();
    if (request !== entryRequest) return;
    entry.room = room;
    entry.info = info;
  } catch {
    if (request === entryRequest && $('#entry-message').hidden) setEntryMessage('暂时无法连接服务器，请检查网络后重试。');
  }
  if (request === entryRequest) renderEntryViews();
}

async function retryLeave(room, pending = playerSessions.pending(room)) {
  if (!pending?.session) return;
  const relevant = () => !$('#live-entry').hidden && $('#entry-room').value.trim() === room;
  const releasing = playerSessions.release(room, pending.session);
  if (relevant()) { setEntryMessage(EXIT_SAVING); renderEntryViews(); }
  try {
    await releasing;
    if (relevant()) setEntryMessage('已退出，请选择身份重新进入。');
  } catch {
    if (relevant()) setEntryMessage(playerSessions.pending(room) ? EXIT_PENDING : '已退出，请选择身份重新进入。');
  }
  if (relevant()) { renderEntryViews(); await refreshEntryInfo(); }
}

/** 先保存退出记录，刷新后继续退出；keepalive 只是尽量完成请求，不能代替确认。 */
async function switchIdentity() {
  const room = entry.room;
  const pending = playerSessions.beginLeave(room, connection?.session, connection?.view || entry.view);
  leaveRoom(EXIT_SAVING, { kept: true });
  await retryLeave(room, pending);
}

async function submitEntry() {
  const room = $('#entry-room').value.trim();
  if (!entry.info || !entry.view || playerSessions.isLeaving(room) || Date.now() < joinBusyUntil) return;
  const pending = playerSessions.pending(room);
  const button = $('#entry-submit');
  button.disabled = true;
  setEntryMessage('');
  try {
    const res = await fetch(`${API}/${room}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ view: entry.view, password: $('#entry-password').value, previous: pending?.session }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (body.error === 'server-busy') {
        const delay = retryAfterMs(res.headers.get('Retry-After')) || 2000;
        joinBusyUntil = Date.now() + delay;
        setTimeout(renderEntryViews, delay + 10);
      }
      setEntryMessage(JOIN_ERRORS[body.error] || '暂时无法进入，请稍后再试。');
      if (body.error === 'wrong-password') { $('#entry-password').value = ''; $('#entry-password').focus(); }
      await refreshEntryInfo();
      return;
    }
    saveSession(room, { session: body.session, view: body.view });
    playerSessions.forget(room, pending?.session);
    $('#entry-password').value = '';
    enterRoom(room, body.session);
  } catch {
    setEntryMessage('暂时无法连接服务器，请检查网络后重试。');
  } finally {
    renderEntryViews();
  }
}

function bindEntry() {
  $('#entry-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitEntry();
  });
  $('#entry-room').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    setEntryMessage('');
    entry.view = '';
    refreshEntryInfo();
  });
  $('#entry-views').addEventListener('click', (e) => {
    const button = e.target.closest('[data-view]');
    if (!button) return;
    entry.view = button.dataset.view;
    setEntryMessage('');
    renderEntryViews();
    if (!$('#entry-password-box').hidden) $('#entry-password').focus();
  });
  $('#btn-leave').addEventListener('click', switchIdentity);
  $('#entry-retry-leave').addEventListener('click', () => retryLeave($('#entry-room').value.trim()));
  // 等名额时不用手动刷新；房间不存在时不再轮询，避免消耗猜测次数
  setInterval(() => {
    if (!$('#live-entry').hidden && entry.info && !document.hidden) refreshEntryInfo();
  }, ENTRY_POLL_MS);
}

const CONNECTION_MESSAGES = {
  'too-many-tabs': '同一身份打开的页面过多，请关闭其他页面后等待重连。',
  'spectator-capacity': '观众连接已满，正在等待空位。',
  'too-many-viewers': '房间连接已满，正在等待空位。',
};

function scheduleRetry(url, checkUrl, minimumMs = 0) {
  if (closed || retryTimer || retryInFlight) return;
  const expected = connection;
  const delay = reconnectDelay(retryAttempt++, Math.random, minimumMs);
  retryTimer = setTimeout(async () => {
    retryTimer = 0;
    if (closed || connection !== expected) return;
    retryInFlight = true;
    let ready = false, nextMinimum = 0;
    try {
      const { res, body } = await withRequestTimeout(5000, async signal => {
        const res = await fetch(checkUrl, { cache: 'no-store', signal });
        return { res, body: await res.json() };
      });
      if (closed || connection !== expected) return;
      if ([403, 404, 409].includes(res.status)) {
        leaveRoom(LEAVE_MESSAGES[body.error] || LEAVE_MESSAGES['invalid-session']);
        return;
      }
      ready = res.ok && !body.connectionError;
      nextMinimum = retryAfterMs(res.headers.get('Retry-After'));
      if (body.connectionError) {
        const message = CONNECTION_MESSAGES[body.connectionError] || '正在等待重连';
        setConnection('wait', message);
        $('#conn-body').hidden = false;
        $('#conn-body').textContent = message;
        $('#conn-checklist').hidden = true;
      }
    } catch { /* Temporary network failure; preserve credentials and back off. */ }
    finally { retryInFlight = false; }
    if (closed || connection !== expected) return;
    if (ready) connect(url, checkUrl);
    else scheduleRetry(url, checkUrl, nextMinimum);
  }, delay);
}

/** 收到服务器的消息说明连接正常；网络短暂波动时连接可能没断，要恢复显示。 */
function markAlive() {
  retryAttempt = 0;
  lastEvent = Date.now();
  everConnected = true;
  setConnection('on', '已连接');
}

function connect(url, checkUrl) {
  if (closed) return;
  source?.close();
  clearTimeout(retryTimer); retryTimer = 0;
  if (!everConnected) setConnection('wait', '连接中…');
  const openedSource = source = new EventSource(url);
  const isCurrent = () => source === openedSource && !closed;
  lastEvent = Date.now();
  source.onopen = () => {
    if (!isCurrent()) return;
    firstState = true; // 重连直接恢复快照，只继续尚未结束的阶段
    everConnected = true;
    setConnection('on', '已连接');
  };
  source.addEventListener('state', (e) => {
    if (!isCurrent()) return;
    markAlive();
    applyState(JSON.parse(e.data));
  });
  source.addEventListener('ping', () => { if (isCurrent()) markAlive(); });
  source.addEventListener('closed', (e) => {
    if (!isCurrent()) return;
    const { reason } = JSON.parse(e.data);
    leaveRoom(LEAVE_MESSAGES[reason] || LEAVE_MESSAGES['invalid-session']);
  });
  source.onerror = () => {
    if (!isCurrent()) return;
    // Own the retry loop: native fixed-interval retries would bypass backoff.
    openedSource.close();
    connectionLost();
    scheduleRetry(url, checkUrl);
  };
}

function bindConnAlert() {
  const dlg = $('#dlg-conn');
  // 不允许手动退出：拦截 Esc；个别浏览器连按 Esc 仍会关闭，这时立刻重新打开
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  dlg.addEventListener('close', () => {
    if (dlg.dataset.kind) dlg.showModal();
    else dlg.classList.remove('is-closing', 'is-success');
  });
  // 在同一个标签页里粘贴新房间链接时，只有 # 后面变化，页面不会自动重新加载
  window.addEventListener('hashchange', () => location.reload());
}

function bindSound() {
  const button = $('#btn-sound');
  let on = false;
  sfx.setEnabled(false);
  button.addEventListener('click', () => {
    on = !on;
    sfx.setEnabled(on);
    sfx.unlock();
    button.setAttribute('aria-pressed', String(on));
  });
}

async function main() {
  bindSound();
  bindConnAlert();
  bindEntry();
  try {
    await loadData();
  } catch (err) {
    console.error(err);
    showEntry(`暂时无法读取角色数据（${err.message}），请刷新页面后重试。`);
    return;
  }
  const room = /^#(\d{6})$/.exec(location.hash)?.[1] || '';
  const saved = room ? loadSession(room) : null;
  const pending = room ? playerSessions.pending(room) : null;
  if (saved?.session && saved.session !== pending?.session) {
    enterRoom(room, saved.session);
  } else {
    $('#entry-room').value = room;
    entry.view = pending?.view || '';
    showEntry(location.hash && !room ? '链接格式已更新，请向裁判确认 6 位房间号。' : '');
    refreshEntryInfo();
    if (pending) retryLeave(room, pending);
    $(room ? '#entry-views [data-view]' : '#entry-room').focus();
  }
  const reconnectIfStale = () => {
    if (closed || !connection || document.hidden) return;
    if (source?.readyState !== EventSource.OPEN || Date.now() - lastEvent > WATCHDOG_MS) {
      connectionLost();
      source?.close();
      scheduleRetry(connection.url, connection.checkUrl);
    } else {
      setConnection('on', '已连接');
    }
  };
  // 手机切后台时连接可能被静默断开
  document.addEventListener('visibilitychange', () => {
    if (!closed && latestState) {
      firstState = true;
      applyState(latestState);
    }
    reconnectIfStale();
  });
  reduceMotion.addEventListener('change', () => {
    if (!closed && latestState) { firstState = true; applyState(latestState); }
  });
  window.addEventListener('online', reconnectIfStale);
  window.addEventListener('offline', () => { if (!closed) connectionLost(); });
  setInterval(reconnectIfStale, 15_000);
}

main();
