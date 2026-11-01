// 禁用阶段界面：主页面和选手页共用。禁用期间人物牌桌收起，结束后只留一行结果。
import { applyPortraitView, asset, el } from './shared-ui.js';
import { charName, joinList, t } from './i18n.js';
import { sfx } from './sound.js';

const URGENT_SECONDS = 10;
const CLOCK_MS = 250;
const NARROW_WIDTH = 900;
const REVEAL_INTRO_MS = 450;
const REVEAL_CARD_MS = 480;
const REVEAL_HOLD_MS = 1800;
const REVEAL_STILL_MS = 2600; // 减少动态效果时一次显示全部结果，留够阅读时间
const REVEAL_FADE_MS = 280;
const SIDES = ['survivor', 'hunter'];
const GROUP_TITLE = {
  survivor: { survivor: '禁用己方求生者', hunter: '禁用对方监管者' },
  hunter: { hunter: '禁用己方监管者', survivor: '禁用对方求生者' },
};
const SIDE_NAME = { survivor: '求生者方', hunter: '监管者方' };

const stageOf = (side, kind) => (kind === side ? 'own' : 'enemy');

/** 把禁用数据整理成界面需要的样子。host 为 true 时是裁判视角，可以替双方操作。 */
export function banModel(bans, { view = 'spectator', host = false, myPosition = null } = {}) {
  // 选手只看自己这一方；裁判和观众才同时看双方
  const mineOnly = !host && view !== 'spectator';
  const sumPicks = (side) => bans.picks[side].survivor.length + bans.picks[side].hunter.length;
  const group = (side, kind) => {
    const current = stageOf(side, kind) === bans.stage;
    // 选手确认后只留下自己禁用的牌；已结束的环节也只留结果
    const ids = current && !(mineOnly && bans.done[side]) ? bans.targets[kind] ?? [] : bans.picks[side][kind];
    return {
      kind,
      current,
      quota: bans.quota[side][kind],
      ids,
      picks: bans.picks[side][kind],
      pending: bans.pending[side][kind],
      // 对方已经公开禁用的角色，这里也不能再选
      taken: bans.picks[side === 'survivor' ? 'hunter' : 'survivor'][kind],
    };
  };
  const kindsOf = (side) => [side, side === 'survivor' ? 'hunter' : 'survivor'];
  // 揭晓和结果行用：不分环节，列出全部次数
  const allColumns = SIDES.filter((side) => bans.quota[side].survivor + bans.quota[side].hunter > 0).map((side) => ({
    side,
    groups: kindsOf(side).filter((kind) => bans.quota[side][kind] > 0).map((kind) => group(side, kind)),
  }));
  const stageColumns = SIDES.map((side) => {
    const groups = kindsOf(side)
      .filter((kind) => bans.quota[side][kind] > 0)
      .filter((kind) => stageOf(side, kind) === bans.stage || (stageOf(side, kind) === 'own' && bans.picks[side][kind].length))
      .map((kind) => group(side, kind));
    const current = groups.find((entry) => entry.current) ?? null;
    const canAct = host || (view === side && (side !== 'survivor' || myPosition !== null));
    return {
      side,
      groups,
      hasCurrent: Boolean(current),
      quota: current?.quota ?? 0,
      used: current ? current.picks.length + bans.passed[side][current.kind] : 0,
      pendingCount: current?.pending.length ?? 0,
      done: bans.done[side],
      turn: bans.turn === side,
      canAct,
      actionable: Boolean(current) && canAct && !bans.closed && !bans.done[side] && (!bans.turn || bans.turn === side) && (host || !bans.expired),
    };
  }).filter((column) => column.groups.length);
  const enemy = mineOnly ? (view === 'survivor' ? 'hunter' : 'survivor') : null;
  const columns = mineOnly ? stageColumns.filter((column) => column.side === view) : stageColumns;
  const own = columns.find((column) => column.side === view);
  return {
    round: bans.round, stage: bans.stage, order: bans.order, turn: bans.turn, deadline: bans.deadline,
    closed: bans.closed, expired: bans.expired, total: sumPicks('survivor') + sumPicks('hunter'),
    allColumns,
    columns,
    mine: mineOnly ? { side: view, canPick: Boolean(own?.actionable) } : null,
    // 轮流禁用时对方的结果已经公开，提示一行就够了
    enemyPicks: enemy ? SIDES.flatMap((kind) => bans.picks[enemy][kind].map((id) => ({ kind, id }))) : [],
  };
}

export function createBanUI({ table, lookup, onPick, onConfirm, motion = () => true }) {
  const root = el('section', 'ban-board');
  root.setAttribute('aria-labelledby', 'ban-title');
  const bar = el('div', 'ban-bar');
  bar.setAttribute('role', 'status');
  const barText = el('div', 'ban-bar-text');
  const barTitle = el('b');
  barTitle.id = 'ban-title';
  const barHint = el('small');
  barText.append(barTitle, barHint);
  const clock = el('div', 'ban-clock');
  const clockText = el('span');
  const clockTrack = el('div', 'ban-clock-track');
  const clockFill = el('i');
  clockTrack.append(clockFill);
  clock.append(clockText, clockTrack);
  bar.append(barText, clock);
  const grid = el('div', 'ban-columns');
  root.append(bar, grid);
  root.hidden = true;
  const summary = el('p', 'ban-summary');
  summary.hidden = true;
  table.before(root, summary);

  let model = null;
  let round = null;
  let stage = null;
  let builtLayout = '';
  let offset = 0;
  let timer = 0;
  let clockTotal = 0;
  const parts = new Map();

  const now = () => Date.now() + offset;

  function tile(side, kind, id) {
    const char = lookup(kind, id);
    const button = el('button', 'ban-tile');
    button.type = 'button';
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.draggable = false;
    applyPortraitView(img, char, true);
    img.src = asset(char.portrait);
    button.append(img, el('span', 'ban-tile-name', charName(char)));
    button.addEventListener('click', () => {
      const column = model?.columns.find((other) => other.side === side);
      const group = column?.groups.find((other) => other.kind === kind);
      if (column?.actionable && !group.picks.includes(id) && !group.taken.includes(id)) onPick(side, id);
    });
    return button;
  }

  function buildColumn(column) {
    const box = el('section', `ban-column side-${column.side}${column.canAct ? ' is-own' : ''}`);
    const head = el('header', 'ban-column-head');
    const title = el('h3', '', t(SIDE_NAME[column.side]));
    const count = el('span', 'ban-count');
    const chip = el('span', 'ban-chip');
    head.append(title, count, chip);
    box.append(head);
    const groups = new Map();
    for (const group of column.groups) {
      const section = el('div', `ban-group kind-${group.kind}${group.current ? '' : ' is-past'}`);
      const groupHead = el('p', 'ban-group-head');
      const label = el('span', '', t(GROUP_TITLE[column.side][group.kind]));
      const groupCount = el('span', 'ban-count');
      groupHead.append(label, groupCount);
      const tray = el('div', 'ban-tray');
      section.append(groupHead, tray);
      box.append(section);
      groups.set(group.kind, { section, groupCount, tray, tiles: new Map(), order: null });
    }
    const confirm = el('button', 'btn btn-quiet ban-confirm');
    confirm.type = 'button';
    confirm.addEventListener('click', () => onConfirm(column.side));
    box.append(confirm);
    grid.append(box);
    parts.set(column.side, { count, chip, groups, confirm });
  }

  function renderColumn(column) {
    const part = parts.get(column.side);
    part.count.hidden = !column.hasCurrent;
    part.count.textContent = t('已用 {used}/{quota}', { used: column.used, quota: column.quota });
    part.chip.hidden = !column.hasCurrent;
    part.chip.textContent = t(column.done ? '已确认' : column.turn ? '轮到这一方' : model.turn ? '等待' : '禁用中');
    part.chip.classList.toggle('is-locked', column.done);
    part.chip.classList.toggle('is-waiting', !column.done && (column.turn || !model.turn));
    for (const group of column.groups) {
      const view = part.groups.get(group.kind);
      view.groupCount.textContent = `${group.picks.length + group.pending.length}/${group.quota}`;
      const order = group.ids.join();
      if (order !== view.order) {
        view.order = order;
        view.tray.replaceChildren(...group.ids.map((id) => {
          if (!view.tiles.has(id)) view.tiles.set(id, tile(column.side, group.kind, id));
          return view.tiles.get(id);
        }));
      }
      for (const [id, node] of view.tiles) {
        const banned = group.picks.includes(id) || group.taken.includes(id);
        const pending = group.pending.includes(id);
        node.disabled = !column.actionable || !group.current || banned;
        node.classList.toggle('is-banned', banned);
        node.classList.toggle('is-pending', pending);
        node.setAttribute('aria-pressed', String(banned || pending));
      }
    }
    part.confirm.hidden = !column.canAct || column.done || !column.hasCurrent;
    part.confirm.disabled = !column.actionable;
    const room = model.turn ? 1 : column.quota - column.used;
    part.confirm.textContent = t(!column.pendingCount ? '放弃禁用' : column.pendingCount < room ? '确认，放弃其余次数' : '确认禁用');
  }

  function renderBar() {
    const stageTitle = t(model.stage === 'own' ? '禁用己方角色' : '禁用对方角色');
    if (model.expired) {
      barTitle.textContent = t('时间到，等待裁判处理');
      barHint.textContent = stageTitle;
      return;
    }
    if (model.mine) {
      barTitle.textContent = model.mine.canPick ? stageTitle : t('等待对方禁用');
      const names = model.enemyPicks.map(({ kind, id }) => charName(lookup(kind, id)));
      barHint.textContent = names.length ? t('对方已禁用：{names}', { names: joinList(names) }) : t(model.mine.canPick ? '选好后点确认，时间到时已选中的会自动锁定' : '全部确认后统一公布结果');
      return;
    }
    const current = model.columns.find((column) => column.turn);
    barTitle.textContent = current ? `${stageTitle} · ${t('轮到{side}禁用', { side: t(SIDE_NAME[current.side]) })}` : stageTitle;
    barHint.textContent = t(model.order === 'simultaneous' ? '同时暗禁：双方都确认后才公开' : '轮流禁用：每一手确认后公开');
  }

  function tick() {
    if (!model || model.closed || model.deadline === null) { clock.hidden = true; return; }
    clock.hidden = false;
    const left = Math.max(0, model.deadline - now());
    const seconds = Math.ceil(left / 1000);
    clockTotal = Math.max(clockTotal, left);
    clockText.textContent = t('{seconds} 秒', { seconds });
    clockFill.style.transform = `scaleX(${clockTotal ? left / clockTotal : 0})`;
    clock.classList.toggle('is-urgent', seconds <= URGENT_SECONDS);
  }

  function showSummary(next) {
    const text = next.allColumns.map((column) => {
      const names = column.groups.flatMap((group) => group.picks.map((id) => charName(lookup(group.kind, id))));
      return t('{side}：{names}', { side: t(SIDE_NAME[column.side]), names: names.length ? joinList(names) : t('未禁用') });
    });
    summary.textContent = `${t('本局禁用')}　${text.join('　')}`;
    summary.hidden = false;
  }

  /* ---------------- 统一揭晓：所有视角看到同样的结果 ---------------- */

  let finishReveal = null;

  /** 播放揭晓动画，结束或被跳过后返回。裁判等它结束才进入下一步，选手和裁判的节奏因此一致。 */
  function reveal(next) {
    endReveal();
    const animated = motion();
    const overlay = el('div', 'ban-reveal');
    overlay.setAttribute('role', 'status');
    const panel = el('div', 'ban-reveal-panel');
    panel.append(el('h2', 'ban-reveal-title', t('禁用结果')));
    const cards = [];
    const body = el('div', 'ban-reveal-body');
    for (const column of next.allColumns) {
      const box = el('section', `ban-reveal-side side-${column.side}`);
      box.append(el('h3', '', t(SIDE_NAME[column.side])));
      const row = el('div', 'ban-reveal-row');
      const picks = column.groups.flatMap((group) => group.picks.map((id) => ({ kind: group.kind, id })));
      if (!picks.length) row.append(el('p', 'ban-reveal-none', t('未禁用')));
      for (const { kind, id } of picks) {
        const char = lookup(kind, id);
        const card = el('div', `ban-reveal-card kind-${kind}`);
        const img = el('img');
        img.alt = '';
        applyPortraitView(img, char, true);
        img.src = asset(char.portrait);
        card.append(img, el('span', 'ban-tile-name', charName(char)));
        if (!animated) card.classList.add('is-stamped');
        row.append(card);
        cards.push(card);
      }
      box.append(row);
      body.append(box);
    }
    if (!cards.length) body.replaceChildren(el('p', 'ban-reveal-none', t('双方都未禁用')));
    panel.append(body, el('p', 'ban-reveal-skip', t('点击任意位置跳过')));
    overlay.append(panel);
    document.body.append(overlay);

    return new Promise((resolve) => {
      const timers = [];
      const later = (ms, fn) => timers.push(setTimeout(fn, ms));
      const finish = (fade) => {
        if (finishReveal !== close) return;
        finishReveal = null;
        timers.forEach(clearTimeout);
        overlay.classList.add('is-leaving');
        setTimeout(() => overlay.remove(), fade ? REVEAL_FADE_MS : 0);
        resolve();
      };
      const close = () => finish(true);
      finishReveal = close;
      overlay.addEventListener('click', close);
      if (animated) {
        cards.forEach((card, i) => later(REVEAL_INTRO_MS + i * REVEAL_CARD_MS, () => {
          card.classList.add('is-stamped');
          sfx.lock();
        }));
        later(REVEAL_INTRO_MS + cards.length * REVEAL_CARD_MS + REVEAL_HOLD_MS, close);
      } else {
        later(REVEAL_STILL_MS, close);
      }
    });
  }

  function endReveal() { finishReveal?.(); }

  function clear() {
    endReveal();
    clearInterval(timer);
    timer = 0;
    model = null;
    round = null;
    stage = null;
    clockTotal = 0;
    parts.clear();
    grid.replaceChildren();
    root.hidden = true;
    summary.hidden = true;
    table.classList.remove('is-ban-hidden');
  }

  return {
    now,
    clear,
    reveal,
    endReveal,
    setClockOffset(value) { offset = value; },
    show(next) {
      let fresh = false;
      if (!next) { clear(); return; }
      if (next.closed) {
        const running = finishReveal;
        finishReveal = null;
        clear();
        finishReveal = running;
        showSummary(next);
        return;
      }
      if (next.round !== round) {
        clear();
        round = next.round;
        timer = setInterval(tick, CLOCK_MS);
        fresh = true;
      }
      // 每个环节显示的内容不同，重新搭一次面板
      const layout = next.columns.map((column) => `${column.side}:${column.groups.map((group) => group.kind).join()}`).join();
      if (fresh || next.stage !== stage || layout !== builtLayout) {
        stage = next.stage;
        builtLayout = layout;
        parts.clear();
        grid.replaceChildren();
        next.columns.forEach(buildColumn);
        clockTotal = 0;
      }
      // 轮流禁用每一手重新计时，进度条也从头开始
      if (model && next.deadline !== model.deadline) clockTotal = 0;
      model = next;
      root.hidden = false;
      summary.hidden = true;
      table.classList.add('is-ban-hidden');
      renderBar();
      next.columns.forEach(renderColumn);
      tick();
      // 窄屏上设置区很长，开始时要把禁用面板带到眼前
      if (fresh && innerWidth < NARROW_WIDTH) root.scrollIntoView({ block: 'start' });
    },
  };
}
