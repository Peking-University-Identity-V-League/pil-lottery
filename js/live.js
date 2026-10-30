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

const data = { survivors: new Map(), hunters: new Map(), traits: new Map(), trees: {} };
const slots = [];
let shownRound = null;
let firstState = true;
let source = null;
let lastEvent = 0;
let retryDelay = 1000;
let retryTimer = 0;
let closed = false;
let everConnected = false;

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

/** 看不到全部人格时的摘要：终极人格一行，绝处逢生一行。 */
function limitedItems(tree, build) {
  const items = [];
  if (build.status === 'ultimates') {
    const nodes = build.ultimates.map((id) => tree.byId.get(id));
    if (nodes.length) items.push(...nodes.map((n) => summaryItem(nodes.length === 1 ? 'is-single' : '', n.name, n.icon?.local_path)));
    else items.push(summaryItem('is-single is-none', '无终极人格'));
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
  slot.charName = '';
  slot.seen = { char: '', build: '', trait: '' };
  slot.card.classList.remove('is-open', 'is-charging');
  slot.sealHalves.forEach((half) => half.getAnimations().forEach((a) => a.cancel()));
  slot.address.textContent = slot.defaultAddress;
  applyBuild(slot, { status: 'pending' }, false);
  if (slot.traitBox) applyTrait(slot, { status: 'pending' }, false);
}

function crackSeal(slot) {
  const [l, r] = slot.sealHalves;
  const opts = { duration: 420, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' };
  l.animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(-22px, 14px) rotate(-32deg)', opacity: 0 }], opts);
  r.animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(20px, 18px) rotate(26deg)', opacity: 0 }], opts);
}

/** 揭晓或更换角色；隐藏的角色保持信封状态。 */
async function applyChar(slot, char, animate) {
  const key = JSON.stringify(char);
  if (key === slot.seen.char) return;
  const wasOpen = slot.card.classList.contains('is-open');
  slot.seen.char = key;
  slot.charName = '';
  const run = ++slot.charRun;
  if (char.status !== 'shown') {
    slot.card.classList.remove('is-open');
    slot.address.textContent = char.status === 'hidden' ? '角色未公开' : slot.defaultAddress;
    return;
  }
  if (wasOpen && animate) {
    slot.card.classList.remove('is-open');
    sfx.flip();
    await new Promise((resolve) => { setTimeout(resolve, FLIP_MS); });
    if (run !== slot.charRun) return;
  }
  const info = (slot.side === 'survivor' ? data.survivors : data.hunters).get(char.id);
  if (!info) return;
  applyPortraitView(slot.portrait, info);
  slot.portrait.src = asset(info.portrait);
  slot.portrait.alt = `${info.name}立绘`;
  slot.name.textContent = info.name;
  slot.charName = info.name;
  slot.roles.replaceChildren(...(slot.side === 'survivor' ? (info.roles || []).map((r) => el('li', '', r)) : []));
  if (animate) {
    crackSeal(slot);
    if (slot.side === 'hunter') sfx.boom(); else sfx.crack();
  }
  slot.card.classList.remove('is-charging');
  slot.card.classList.add('is-open');
}

function applyBuild(slot, build, animate) {
  const tree = data.trees[slot.side];
  const key = JSON.stringify(build);
  if (key === slot.seen.build) return;
  slot.seen.build = key;
  slot.note.hidden = true;
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
  if (build.status !== 'full') {
    slot.note.textContent = '人格未公开';
    slot.note.hidden = build.status !== 'hidden';
    slot.list.replaceChildren(...limitedItems(tree, build));
    return;
  }
  slot.panel.classList.toggle('lighting', animate);
  renderWeb(slot.web, tree, build, { animate });
  slot.list.replaceChildren(...talentItems(tree, build));
  if (animate) sfx.light(0);
}

function applyTrait(slot, trait, animate) {
  const key = JSON.stringify(trait);
  if (key === slot.seen.trait) return;
  slot.seen.trait = key;
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

function applyState(state) {
  const animate = !firstState && !document.hidden;
  document.body.classList.toggle('instant', !animate);
  if (state.round !== shownRound) {
    shownRound = state.round;
    slots.forEach(resetSlot);
    if ($('#dlg-tree').open) $('#dlg-tree').close();
    if (animate && state.slots.length) sfx.shuffle();
  }
  $('#live-view').textContent = `${LIVE_VIEW_NAMES[state.view]}视角`;
  $('#live-phase').textContent = PHASE_TEXT[state.phase];
  if (!state.slots.length) {
    slots.forEach((slot) => applyBuild(slot, state.limited[slot.side] ? { status: 'pending', limited: true } : { status: 'pending' }, false));
  }
  state.slots.forEach((entry, i) => {
    const slot = slots[i];
    applyChar(slot, entry.char, animate);
    applyBuild(slot, entry.build, animate);
    if (slot.traitBox) applyTrait(slot, entry.trait, animate);
  });
  const hunter = slots[4];
  hunter.card.classList.toggle('is-charging', state.phase === 'hunter' && !hunter.card.classList.contains('is-open'));
  if (hunter.traitBox && state.phase === 'trait' && state.slots[4]?.trait.status === 'pending') {
    hunter.traitBox.classList.add('rolling');
    hunter.traitName.textContent = '抽取中';
    hunter.seen.trait = '';
  }
  firstState = false;
  if (!animate) {
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('instant')));
  }
}

const CONN_ALERTS = {
  retry: {
    title: '连接已中断',
    waiting: true,
  },
  invalid: {
    title: '链接已失效',
    body: '裁判可能重新生成了链接或结束了同步，房间也可能已过期。请确认链接是否是最新的，或向裁判索取新链接。',
    reload: true,
  },
  reconnected: {
    title: '已重新连接',
    body: '页面已更新到最新状态。',
    success: true,
  },
  incomplete: {
    title: '链接不完整',
    body: '这个链接缺少房间信息。请完整复制裁判发来的链接，或向裁判重新索取。',
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
  $('#conn-foot').hidden = !alert.reload;
  $('#conn-title').textContent = alert.title;
  $('#conn-body').textContent = alert.body || '';
  $('#conn-waiting').hidden = !alert.waiting;
  $('#conn-reload').hidden = !alert.reload;
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

function invalidate(message) {
  closed = true;
  source?.close();
  source = null;
  clearTimeout(retryTimer);
  stopLostTimer();
  setConnection('lost', message);
  $('#live-phase').textContent = '请向裁判索取新链接';
  showConnAlert('invalid');
}

function scheduleRetry(url, checkUrl) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => connect(url, checkUrl), retryDelay);
  retryDelay = Math.min(retryDelay * 2, 15_000);
}

/** 收到服务器的消息说明连接正常；网络短暂波动时连接可能没断，要恢复显示。 */
function markAlive() {
  lastEvent = Date.now();
  everConnected = true;
  setConnection('on', '已连接');
}

function connect(url, checkUrl) {
  if (closed) return;
  source?.close();
  if (!everConnected) setConnection('wait', '连接中…');
  source = new EventSource(url);
  lastEvent = Date.now();
  source.onopen = () => {
    retryDelay = 1000;
    firstState = true; // 重连后直接显示最新状态，不补播动画
    everConnected = true;
    setConnection('on', '已连接');
  };
  source.addEventListener('state', (e) => {
    markAlive();
    applyState(JSON.parse(e.data));
  });
  source.addEventListener('ping', markAlive);
  source.addEventListener('closed', () => invalidate('链接已失效'));
  source.onerror = async () => {
    connectionLost();
    if (source?.readyState !== EventSource.CLOSED) return; // 浏览器会自动重连
    // 服务器返回错误状态时浏览器不再重连，先判断链接是否仍然有效
    try {
      const res = await fetch(checkUrl, { cache: 'no-store' });
      if (res.status === 403 || res.status === 404) { invalidate('链接已失效'); return; }
    } catch { /* 网络仍未恢复 */ }
    scheduleRetry(url, checkUrl);
  };
}

function bindConnAlert() {
  const dlg = $('#dlg-conn');
  $('#conn-reload').addEventListener('click', () => location.reload());
  // 不允许手动退出：拦截 Esc；个别浏览器连按 Esc 仍会关闭，这时立刻重新打开
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  dlg.addEventListener('close', () => {
    if (dlg.dataset.kind) dlg.showModal();
    else dlg.classList.remove('is-closing', 'is-success');
  });
  // 在同一个标签页里粘贴新链接时，只有 # 后面变化，页面不会自动重新加载
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
  const match = /^#([\w-]+)\.([\w-]+)$/.exec(location.hash);
  if (!match) {
    $('#notice').textContent = '链接不完整，请向裁判重新获取。';
    setConnection('lost', '链接不完整');
    $('#live-phase').textContent = '请向裁判索取新链接';
    showConnAlert('incomplete');
    return;
  }
  try {
    await loadData();
  } catch (err) {
    console.error(err);
    $('#notice').textContent = `暂时无法读取角色数据（${err.message}），请刷新页面后重试。`;
    return;
  }
  buildTable();
  const [, room, token] = match;
  const url = `${API}/${room}/events?token=${encodeURIComponent(token)}`;
  const checkUrl = `${API}/${room}/check?token=${encodeURIComponent(token)}`;
  connect(url, checkUrl);
  const reconnectIfStale = () => {
    if (closed || document.hidden) return;
    if (source?.readyState !== EventSource.OPEN || Date.now() - lastEvent > WATCHDOG_MS) {
      connectionLost();
      connect(url, checkUrl);
    } else {
      setConnection('on', '已连接');
    }
  };
  // 手机切后台时连接可能被静默断开
  document.addEventListener('visibilitychange', reconnectIfStale);
  window.addEventListener('online', reconnectIfStale);
  window.addEventListener('offline', connectionLost);
  setInterval(reconnectIfStale, 15_000);
}

main();
