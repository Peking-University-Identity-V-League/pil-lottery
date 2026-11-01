// 选角界面：主页面和选手页共用。候选牌放在信封下方，也就是人格面板的位置；操作结果由调用方决定。
import { applyPortraitView, asset, el } from './shared-ui.js';
import { charName, joinList, roleName, t } from './i18n.js';
import { sfx } from './sound.js';

const FLY_MS = 460;
const CLAIM_FLY_MS = 320;
const URGENT_SECONDS = 10;
const TIMEOUT_HOP_MS = 1500;
const LEAVE_MS = 380;
const DRAG_THRESHOLD = 5;
const TOUCH_HOLD_MS = 220; // 触屏要先按住，否则手指滑动还是滚动页面
const TOUCH_SLOP = 8;
const SCROLL_EDGE = 70; // 拖到窗口边缘时自动滚动，座位和卡池不在同一屏也能拖
const SCROLL_SPEED = 12;

/** 把选角数据整理成界面需要的样子。host 为 true 时是裁判视角。 */
export function draftModel(draft, { view = 'spectator', host = false, myPosition = null, claimed = [false, false, false, false] } = {}) {
  const mode = draft.survivor.mode;
  const shared = mode === 'shared';
  const seats = draft.seats.map((seat, position) => {
    const side = position < 4 ? 'survivor' : 'hunter';
    const direct = position < 4 ? mode === 'direct' : draft.hunter.mode === 'direct';
    const own = host || view === 'spectator' || view === side;
    let actionable = false;
    if (!direct) {
      if (host) actionable = true;
      else if (view === 'hunter') actionable = position === 4;
      else if (view === 'survivor' && position < 4) actionable = myPosition === position || (shared && myPosition !== null && !claimed[position]);
    }
    return {
      position, side, direct, own, actionable,
      cands: position < 4 ? draft.survivor.cands?.[position] ?? null : draft.hunter.cands ?? null,
      sel: seat.sel ?? null,
      locked: seat.locked,
      mine: !host && ((view === 'hunter' && position === 4) || (view === 'survivor' && myPosition === position)),
    };
  });
  const lockedSurvivors = seats.slice(0, 4).filter((seat) => seat.locked).length;
  const hunterLocked = seats[4].locked;
  const progress = t(hunterLocked ? '求生者 {count}/4 已锁定，监管者已锁定' : '求生者 {count}/4 已锁定，监管者选择中', { count: lockedSurvivors });
  let title = t('选手正在选角');
  if (!host && view === 'survivor' && mode !== 'direct') {
    if (myPosition === null) title = t('求生者号位已满，你只能观看');
    else if (seats[myPosition].locked) title = t('已锁定，等待其他人');
    else title = t(shared ? '认领一张牌，然后锁定' : '选一张牌，然后锁定');
  } else if (!host && view === 'hunter' && draft.hunter.mode !== 'direct') {
    title = t(hunterLocked ? '已锁定，等待其他人' : '选一张牌，然后锁定');
  }
  return {
    round: draft.round, shared, pool: draft.survivor.pool ?? null, seats, title, progress,
    deadline: draft.deadline, closed: draft.closed, onTimeout: draft.onTimeout, host, myPosition,
  };
}

export function createDraftUI({ slots, table, lookup, onPick, onLock, onExpire, toast, motion }) {
  const bar = el('div', 'draft-bar');
  bar.setAttribute('role', 'status');
  const barText = el('div', 'draft-bar-text');
  const barTitle = el('b');
  const barHint = el('small');
  barText.append(barTitle, barHint);
  const clock = el('div', 'draft-clock');
  const clockText = el('span');
  const clockTrack = el('div', 'draft-clock-track');
  const clockFill = el('i');
  clockTrack.append(clockFill);
  clock.append(clockText, clockTrack);
  clock.hidden = true;
  bar.append(barText, clock);
  bar.hidden = true;
  table.before(bar);

  let model = null;
  let round = null;
  let dealing = false;
  let timer = 0;
  let offset = 0;
  let clockTotal = 0;
  let lastSecond = null;
  let expiredAt = null;
  let hopRun = 0;
  let active = null;
  let parts = [];
  let poolTray = null;
  let leaveRun = 0;
  const cards = new Map();
  const skipFly = new Set(); // 拖放的牌已经在目标位置，不再飞一次
  let press = null;
  let drag = null;
  let suppressClick = false;

  function fillMain(slot, char) {
    applyPortraitView(slot.portrait, char);
    slot.portrait.src = asset(char.portrait);
    slot.portrait.alt = t('{name}立绘', { name: charName(char) });
    slot.name.textContent = charName(char);
    slot.roles.replaceChildren(...(slot.side === 'survivor' ? (char.roles || []).map((r) => el('li', '', roleName(r))) : []));
  }

  function candidate(id, side, position) {
    const char = lookup(side, id);
    const button = el('button', 'draft-cand is-undealt');
    button.type = 'button';
    button.setAttribute('aria-label', charName(char));
    button.innerHTML = '<span class="draft-cand-inner"><span class="draft-cand-back"><span class="draft-cand-seal"></span></span><span class="draft-cand-front"><img alt="" decoding="async"><b></b><small></small></span></span>';
    button.querySelector('.draft-cand-seal').textContent = side === 'hunter' ? '屠' : '人';
    const img = button.querySelector('img');
    img.draggable = false;
    applyPortraitView(img, char, true);
    img.src = asset(char.portrait);
    button.querySelector('b').textContent = charName(char);
    button.querySelector('small').textContent = (char.roles || []).map(roleName).join(' · ');
    button.addEventListener('click', () => clickCard(id, position));
    if (position === null) button.addEventListener('pointerdown', (e) => startPress(e, id, null, button));
    cards.set(id, button);
    return button;
  }

  function build(next) {
    leaveRun++;
    teardown();
    round = next.round;
    table.classList.add('is-drafting');
    table.classList.toggle('is-draft-shared', Boolean(next.pool));
    next.seats.forEach((seat, i) => {
      const slot = slots[i];
      const head = el('div', 'draft-head');
      const label = el('button', 'draft-label');
      label.type = 'button';
      label.addEventListener('click', () => {
        if (!model) return;
        const current = model.seats[i];
        if (model.shared && current.actionable && !current.locked) { active = i; render(); }
      });
      const chip = el('span', 'draft-chip');
      head.append(label, chip);
      slot.root.prepend(head);
      const tray = el('div', 'draft-tray');
      tray.hidden = !seat.cands;
      (seat.cands || []).forEach((id) => tray.append(candidate(id, seat.side, i)));
      const lock = el('button', 'btn btn-quiet draft-lock', t('锁定'));
      lock.type = 'button';
      lock.addEventListener('click', () => onLock(model.seats[i].position));
      slot.card.after(tray, lock);
      parts[i] = { head, label, chip, tray, lock };
    });
    if (next.pool) {
      poolTray = el('div', 'draft-tray draft-pool side-survivor');
      poolTray.append(el('p', 'draft-pool-title', t('共享卡池：把牌拖到任意号位，也可以点牌放到当前号位；拖回卡池或点座位上的牌可以放回')));
      next.pool.forEach((id) => poolTray.append(candidate(id, 'survivor', null)));
      slots[0].root.parentElement.append(poolTray);
    }
  }

  /* ---------------- 共享卡池拖放：从卡池或座位拖到任意可操作的号位，或拖回卡池 ---------------- */

  function canDrag(id, from) {
    if (!model || dealing || !model.shared) return false;
    if (from !== null) {
      const seat = model.seats[from];
      return seat.actionable && !seat.locked && seat.sel === id;
    }
    return !model.seats.some((seat) => seat.position < 4 && seat.sel === id)
      && model.seats.some((seat) => seat.position < 4 && seat.actionable && !seat.locked);
  }

  function startPress(e, id, from, node) {
    if (e.button || press || drag || !canDrag(id, from)) return;
    press = { id, from, node, pointerId: e.pointerId, touch: e.pointerType === 'touch', x: e.clientX, y: e.clientY, timer: 0 };
    if (press.touch) press.timer = setTimeout(() => beginDrag(press.x, press.y), TOUCH_HOLD_MS);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', cancelPress);
  }

  function endPress() {
    clearTimeout(press?.timer);
    press = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', cancelPress);
  }

  function beginDrag(x, y) {
    if (!press || !canDrag(press.id, press.from)) { endPress(); return; }
    const { id, from, node } = press;
    const source = cards.get(id);
    const rect = source.getBoundingClientRect();
    const clone = source.cloneNode(true);
    clone.classList.remove('is-selected', 'is-gone', 'is-dim', 'is-undealt', 'is-hop', 'is-denied');
    clone.classList.add('draft-fly', 'draft-drag');
    Object.assign(clone.style, { width: `${rect.width}px`, height: `${rect.height}px` });
    document.body.append(clone);
    node.classList.add('is-dragging');
    drag = { id, from, node, clone, width: rect.width, height: rect.height };
    moveClone(x, y);
    autoScroll(drag);
    slots.slice(0, 4).forEach((slot, i) => {
      const seat = model.seats[i];
      slot.root.classList.toggle('is-drop-target', seat.actionable && !seat.locked && i !== from);
    });
  }

  function autoScroll(current) {
    if (drag !== current) return;
    const { y } = current;
    const step = y < SCROLL_EDGE ? -SCROLL_SPEED : y > innerHeight - SCROLL_EDGE ? SCROLL_SPEED : 0;
    if (step) {
      window.scrollBy(0, step);
      moveClone(current.x, y);
    }
    requestAnimationFrame(() => autoScroll(current));
  }

  function moveClone(x, y) {
    drag.clone.style.left = `${x - drag.width / 2}px`;
    drag.clone.style.top = `${y - drag.height / 2}px`;
    drag.x = x;
    drag.y = y;
    const over = dropTargetAt(x, y);
    slots.slice(0, 4).forEach((slot, i) => slot.root.classList.toggle('is-drop-over', over === i && slot.root.classList.contains('is-drop-target')));
    poolTray?.classList.toggle('is-drop-over', over === 'pool' && drag.from !== null);
  }

  function dropTargetAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    if (poolTray?.contains(hit)) return 'pool';
    const index = slots.slice(0, 4).findIndex((slot) => slot.root.contains(hit));
    return index < 0 ? null : index;
  }

  function onPointerMove(e) {
    if (!press || e.pointerId !== press.pointerId) return;
    if (drag) { moveClone(e.clientX, e.clientY); return; }
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    if (press.touch) {
      if (moved > TOUCH_SLOP) cancelPress();
    } else if (moved > DRAG_THRESHOLD) {
      beginDrag(e.clientX, e.clientY);
    }
  }

  function clearDragMarks() {
    slots.forEach((slot) => slot.root.classList.remove('is-drop-target', 'is-drop-over'));
    poolTray?.classList.remove('is-drop-over');
    drag?.node.classList.remove('is-dragging');
  }

  function cancelPress() {
    endPress();
    if (!drag) return;
    clearDragMarks();
    drag.clone.remove();
    drag = null;
  }

  function onPointerUp(e) {
    if (!press || e.pointerId !== press.pointerId) return;
    endPress();
    if (!drag) return;
    const current = drag;
    const to = dropTargetAt(e.clientX, e.clientY);
    clearDragMarks(); // 要在清空 drag 之前，否则来源牌的半透明状态会留下来
    drag = null;
    // 拖放结束后浏览器还会补一次 click，不能再当成点牌
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    dropCard(current, to).finally(() => current.clone.remove());
  }

  async function dropCard({ id, from, clone }, to) {
    if (!model) return;
    if (to === 'pool') {
      if (from === null) return;
      skipFly.add(id);
      await onPick(from, null);
    } else if (to !== null && to !== from) {
      const seat = model.seats[to];
      if (!seat.actionable) { toast(t('这个座位不归你操作。')); return; }
      if (seat.locked) { toast(t('这个座位已经锁定了。')); return; }
      const displaced = seat.sel;
      skipFly.add(id);
      // 同一张牌不能同时在两个号位，要先放回再放下；两边都有牌时互换
      if (from !== null) await onPick(from, null);
      await onPick(to, id);
      if (from !== null && displaced) await onPick(from, displaced);
    } else {
      return;
    }
    clone.hidden = true;
    setTimeout(() => skipFly.delete(id), LEAVE_MS);
  }

  // 按住拖动时不能让页面跟着滚动
  document.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
  document.addEventListener('contextmenu', (e) => { if (drag || press?.touch) e.preventDefault(); });

  function clickCard(id, position) {
    if (!model || dealing || suppressClick) return;
    if (position !== null) {
      const seat = model.seats[position];
      if (seat.actionable && !seat.locked && seat.sel !== id) onPick(position, id);
      return;
    }
    const owner = model.seats.find((seat) => seat.position < 4 && seat.sel === id);
    if (owner) {
      if (owner.actionable && !owner.locked) { onPick(owner.position, null); return; }
      deny(id, t('这张牌已被 {position} 号位占用', { position: owner.position + 1 }));
      return;
    }
    const target = activeSeat();
    if (!target) return;
    onPick(target.position, id);
  }

  function deny(id, message) {
    const card = cards.get(id);
    card?.classList.remove('is-denied');
    void card?.offsetWidth;
    card?.classList.add('is-denied');
    toast(message);
  }

  /** 共享卡池里当前替谁选：默认自己；裁判默认第一个还没有牌的号位。 */
  function activeSeat() {
    const ok = (seat) => seat && seat.actionable && !seat.locked;
    const chosen = active === null ? null : model.seats[active];
    if (ok(chosen)) return chosen;
    if (model.myPosition !== null && ok(model.seats[model.myPosition])) return model.seats[model.myPosition];
    return model.seats.slice(0, 4).find((seat) => ok(seat) && !seat.sel) || null;
  }

  function fly(from, to, duration) {
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    if (!motion() || !a.width || !b.width) return;
    const clone = from.cloneNode(true);
    clone.classList.remove('is-selected', 'is-gone', 'is-dim', 'is-undealt', 'is-hop');
    clone.classList.add('draft-fly');
    Object.assign(clone.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
    document.body.append(clone);
    const scale = b.width / a.width;
    const dx = b.left + b.width / 2 - a.left - a.width / 2;
    const dy = b.top + b.height / 2 - a.top - a.height / 2;
    const anim = clone.animate([
      { transform: 'none' },
      { transform: `translate(${dx / 2}px, ${dy / 2 - 22}px) scale(${(scale + 1) / 2}) rotate(-3deg)`, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
    ], { duration, easing: 'cubic-bezier(.3,.7,.25,1)' });
    anim.finished.catch(() => {}).finally(() => clone.remove());
  }

  /** 共享认领和锁定时，牌在托盘和座位之间飞。 */
  function animateChanges(previous, next) {
    next.seats.forEach((seat) => {
      const before = previous.seats[seat.position];
      const slot = slots[seat.position];
      if (next.shared && seat.position < 4) {
        if (before.sel === seat.sel || !seat.own) return;
        if (before.sel && cards.get(before.sel) && !skipFly.has(before.sel)) { fly(slot.card, cards.get(before.sel), CLAIM_FLY_MS); sfx.deal(); }
        if (seat.sel && cards.get(seat.sel) && !skipFly.has(seat.sel)) { fly(cards.get(seat.sel), slot.card, CLAIM_FLY_MS); sfx.deal(); }
      }
      if (!before.locked && seat.locked && seat.own && !seat.direct) {
        const card = cards.get(seat.sel);
        if (!next.shared && card) fly(card, slot.card, FLY_MS);
        sfx.lock();
      }
    });
  }

  function render() {
    if (!model) return;
    barTitle.textContent = waitingReferee() ? t('时间到，等待裁判处理') : model.title;
    barHint.textContent = model.progress;
    const target = model.shared ? activeSeat() : null;
    model.seats.forEach((seat) => {
      const slot = slots[seat.position];
      const part = parts[seat.position];
      slot.root.classList.toggle('is-draft-mine', seat.mine);
      slot.root.classList.toggle('is-draft-active', target === seat);
      const name = seat.position < 4 ? t('{position} 号位', { position: seat.position + 1 }) : t('监管者');
      part.label.textContent = seat.mine ? t('{name}（你）', { name }) : name;
      part.label.disabled = !(model.shared && seat.actionable && !seat.locked);
      let status = '';
      if (seat.direct) status = t('直接抽取');
      else if (seat.locked) status = t('已锁定');
      else if (seat.own && seat.sel) status = t('预选中');
      else status = t('选择中');
      part.chip.textContent = status;
      part.chip.classList.toggle('is-locked', seat.locked && !seat.direct);
      part.chip.classList.toggle('is-waiting', !seat.locked);
      part.lock.hidden = !seat.actionable || seat.locked;
      part.lock.disabled = !seat.sel;
      const open = seat.own && Boolean(seat.sel) && !seat.direct && (seat.locked || (model.shared && seat.position < 4));
      if (open) fillMain(slot, lookup(seat.side, seat.sel));
      slot.card.classList.toggle('is-open', open);
      slot.card.classList.toggle('is-draft-return', model.shared && seat.position < 4 && open && seat.actionable && !seat.locked);
      (seat.cands || []).forEach((id) => {
        const card = cards.get(id);
        if (!card) return;
        card.classList.toggle('is-selected', seat.sel === id && !seat.locked);
        card.classList.toggle('is-gone', seat.sel === id && seat.locked);
        card.classList.toggle('is-dim', seat.locked && seat.sel !== id);
        card.disabled = !seat.actionable || seat.locked;
      });
    });
    (model.pool || []).forEach((id) => {
      const card = cards.get(id);
      if (!card) return;
      card.classList.toggle('is-gone', model.seats.some((seat) => seat.position < 4 && seat.sel === id));
    });
  }

  const waitingReferee = () => Boolean(model && model.deadline !== null && model.onTimeout === 'wait' && remaining() <= 0);
  const remaining = () => (model.deadline === null ? Infinity : (model.deadline - (Date.now() + offset)) / 1000);

  function tickClock() {
    if (!model || model.deadline === null) { clock.hidden = true; return; }
    const left = Math.max(0, remaining());
    if (left > clockTotal) clockTotal = left;
    clock.hidden = false;
    const second = Math.ceil(left);
    clockText.textContent = left > 0 ? t('剩余 {seconds} 秒', { seconds: second }) : t('时间到');
    clockFill.style.transform = `scaleX(${clockTotal ? left / clockTotal : 0})`;
    const urgent = left <= URGENT_SECONDS;
    clock.classList.toggle('is-urgent', urgent);
    if (urgent && left > 0 && second !== lastSecond && !dealing && motion()) sfx.tick();
    lastSecond = second;
    if (left <= 0 && expiredAt !== model.deadline && !dealing) {
      expiredAt = model.deadline;
      render();
      onExpire();
    }
  }

  async function deal(run) {
    const list = [];
    model.seats.forEach((seat) => (seat.cands || []).forEach((id) => list.push(id)));
    (model.pool || []).forEach((id) => list.push(id));
    const box = table.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = Math.min(innerHeight * 0.55, box.top + box.height / 2);
    await Promise.all(list.map((id, i) => {
      const card = cards.get(id);
      card.classList.remove('is-undealt');
      const r = card.getBoundingClientRect();
      setTimeout(() => { if (run === round) sfx.deal(); }, i * 70 + 200);
      return card.animate([
        { transform: `translate(${cx - r.left - r.width / 2}px, ${cy - r.top - r.height / 2}px) scale(.8) rotate(-8deg)`, opacity: 0 },
        { opacity: 1, offset: 0.2 },
        { transform: 'none', opacity: 1 },
      ], { duration: 420, delay: i * 70, easing: 'cubic-bezier(.2,.85,.25,1)', fill: 'backwards' }).finished.catch(() => {});
    }));
    for (const id of list) {
      if (run !== round) return;
      cards.get(id).classList.add('is-open');
      sfx.flip();
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await new Promise((resolve) => setTimeout(resolve, 620));
  }

  function teardown() {
    cancelPress();
    skipFly.clear();
    hopRun++;
    clearInterval(timer);
    timer = 0;
    parts.forEach(({ head, tray, lock }) => { head.remove(); tray.remove(); lock.remove(); });
    parts = [];
    poolTray?.remove();
    poolTray = null;
    cards.clear();
    document.querySelectorAll('.draft-fly').forEach((node) => node.remove());
    slots.forEach((slot) => slot.root.classList.remove('is-draft-mine', 'is-draft-active'));
    slots.forEach((slot) => slot.card.classList.remove('is-draft-return'));
    table.classList.remove('is-drafting', 'is-draft-shared');
    active = null;
    expiredAt = null;
    clockTotal = 0;
    lastSecond = null;
    round = null;
    dealing = false;
  }

  slots.forEach((slot, i) => {
    // 立绘是图片，浏览器默认的拖动会取消指针事件
    slot.card.addEventListener('dragstart', (e) => { if (model) e.preventDefault(); });
    slot.card.addEventListener('pointerdown', (e) => {
      const sel = model?.seats[i]?.sel;
      if (sel && i < 4) startPress(e, sel, i, slot.card);
    });
    slot.card.addEventListener('click', () => {
      if (!model || dealing || suppressClick) return;
      const seat = model.seats[i];
      if (model.shared && i < 4 && seat.sel && seat.actionable && !seat.locked) onPick(i, null);
    });
  });

  return {
    /** 显示或更新选角。before 是发牌前要等的洗牌动画。 */
    async show(next, { animate = false, before = null } = {}) {
      const fresh = next.round !== round;
      const previous = model;
      if (fresh) build(next);
      model = next;
      bar.hidden = false;
      if (!timer) { timer = setInterval(tickClock, 200); }
      tickClock();
      if (!fresh) {
        if (!dealing) {
          if (animate && previous) animateChanges(previous, next);
          render();
        }
        return;
      }
      if (next.seats.every((seat) => !seat.cands) && !next.pool) { render(); return; }
      render();
      if (animate && motion()) {
        dealing = true;
        const run = round;
        if (before) await before;
        if (run !== round) return;
        await deal(run);
        if (run !== round) return;
        dealing = false;
        render();
        tickClock();
      } else {
        cards.forEach((card) => { card.classList.remove('is-undealt'); card.classList.add('is-open'); });
      }
    },
    /** 超时随机：光标在牌之间跳动并逐渐减速。结果由裁判决定，这里只是过渡。 */
    async hop(positions) {
      const run = ++hopRun;
      if (!motion()) return;
      const lists = positions.map((position) => {
        const seat = model.seats[position];
        const free = seat.cands || (model.pool || []).filter((id) => !model.seats.some((other) => other.position < 4 && other.sel === id));
        return free.map((id) => cards.get(id)).filter(Boolean);
      }).filter((list) => list.length);
      if (!lists.length) return;
      const end = performance.now() + TIMEOUT_HOP_MS;
      let interval = 70;
      while (performance.now() < end && run === hopRun) {
        lists.forEach((list) => {
          list.forEach((card) => card.classList.remove('is-hop'));
          list[Math.floor(Math.random() * list.length)].classList.add('is-hop');
        });
        sfx.tick();
        await new Promise((resolve) => setTimeout(resolve, interval));
        interval *= 1.22;
      }
      if (run === hopRun) cards.forEach((card) => card.classList.remove('is-hop'));
    },
    deny,
    /** 选角结束：卡池向下淡出。信封留在原地，已翻开的角色不会再翻一次。 */
    async leave() {
      if (!model) return;
      if (!motion()) { this.clear(); return; }
      model = null;
      bar.hidden = true;
      clock.hidden = true;
      hopRun++;
      const run = ++leaveRun;
      const nodes = [...parts.flatMap(({ head, tray, lock }) => [head, tray, lock]), poolTray].filter((node) => node && !node.hidden);
      await Promise.all(nodes.map((node, i) => node.animate(
        [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(18px)' }],
        { duration: LEAVE_MS, delay: i * 12, easing: 'ease-in', fill: 'forwards' },
      ).finished.catch(() => {})));
      if (run === leaveRun) teardown();
    },
    setClockOffset(value) { offset = value; },
    get active() { return Boolean(model); },
    get expired() { return Boolean(model && model.deadline !== null && remaining() <= 0); },
    clear() {
      if (!model && !parts.length) return;
      leaveRun++;
      teardown();
      model = null;
      bar.hidden = true;
      clock.hidden = true;
    },
  };
}

/** 揭晓后显示没选的候选。names 为空时清除。 */
export function setRejectedLine(slot, names) {
  slot.rejectedLine ??= el('p', 'draft-rejected');
  slot.rejectedLine.textContent = names.length ? t('未选：{names}', { names: joinList(names) }) : '';
  slot.rejectedLine.hidden = !names.length;
  if (!slot.rejectedLine.isConnected && names.length) slot.card.after(slot.rejectedLine);
}

/** 共享卡池里没人要的牌，显示在求生者一侧下方。 */
export function setLeftoverLine(container, names) {
  let line = container.querySelector(':scope > .draft-leftover');
  if (!names.length) { line?.remove(); return; }
  if (!line) { line = el('p', 'draft-leftover'); container.append(line); }
  line.textContent = t('未选：{names}', { names: joinList(names) });
}
