// 窄屏的座位标签：一次只显示一个座位，揭晓时跟着翻牌的座位走，结束后回到自己的座位。宽屏只用 CSS 隐藏，不改变布局。
import { el } from './shared-ui.js';
import { t } from './i18n.js';

const SETTLE_MS = 700;
const SWIPE_MIN = 60;
const SWIPE_MAX_DRIFT = 40;

export function createSeatTabs({ slots, table, defaultSeat = () => 0 }) {
  const narrow = matchMedia('(max-width: 760px)');
  const nav = el('div', 'seat-tabs');
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', t('座位'));
  const tabs = slots.map((slot, i) => {
    const tab = el('button', `seat-tab side-${slot.side}`);
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    const face = el('span', 'seat-tab-face');
    const img = new Image();
    img.alt = '';
    img.draggable = false;
    face.append(img, el('span', 'seat-tab-seal', slot.side === 'hunter' ? '屠' : '人'));
    const name = el('span', 'seat-tab-name');
    tab.append(face, name);
    tab.addEventListener('click', () => choose(i));
    nav.append(tab);
    return { tab, img, name };
  });
  table.before(nav);
  table.classList.add('has-seat-tabs');

  let current = -1;
  let home = null; // 用户点过的座位；没点过时用 defaultSeat
  let manual = false; // 揭晓中用户点了标签，就不再自动跟随
  let settleTimer = 0;
  let frame = 0;
  const seen = slots.map(() => ({ open: false, charging: false }));

  function show(i, { scroll = false } = {}) {
    current = i;
    slots.forEach((slot, index) => slot.root.classList.toggle('is-seat-active', index === i));
    tabs.forEach(({ tab }, index) => {
      tab.setAttribute('aria-selected', String(index === i));
      tab.tabIndex = index === i ? 0 : -1;
    });
    table.dataset.seatSide = slots[i].side;
    if (scroll && narrow.matches) {
      const gap = table.getBoundingClientRect().top - nav.getBoundingClientRect().bottom;
      if (gap < 0) window.scrollBy(0, gap - 8);
    }
  }

  function choose(i) {
    clearTimeout(settleTimer);
    manual = true;
    home = i;
    show(i, { scroll: true });
  }

  function refresh() {
    frame = 0;
    slots.forEach((slot, i) => {
      const { tab, img, name } = tabs[i];
      const open = slot.card.classList.contains('is-open');
      const charging = slot.card.classList.contains('is-charging');
      const src = open ? slot.portrait.getAttribute('src') : null;
      if (src && img.getAttribute('src') !== src) img.src = src;
      tab.classList.toggle('is-open', Boolean(src));
      tab.classList.toggle('is-locked', Boolean(slot.root.querySelector('.draft-chip.is-locked')));
      const label = src && slot.name.textContent ? slot.name.textContent : slot.side === 'hunter' ? t('监管者') : t('{position} 号位', { position: i + 1 });
      if (name.textContent !== label) name.textContent = label;
      const started = (open && !seen[i].open) || (charging && !seen[i].charging);
      seen[i] = { open, charging };
      if (started && !manual && !table.classList.contains('is-drafting') && !document.body.classList.contains('instant')) {
        clearTimeout(settleTimer);
        show(i, { scroll: true });
      }
    });
  }

  const observer = new MutationObserver(() => { frame ||= requestAnimationFrame(refresh); });
  slots.forEach((slot) => observer.observe(slot.root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'src'] }));

  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = (current + (e.key === 'ArrowLeft' ? -1 : 1) + slots.length) % slots.length;
    choose(next);
    tabs[next].tab.focus();
  });

  // 左右滑动切换；共享卡池的号位都在一屏，手势留给拖牌
  let swipe = null;
  table.addEventListener('touchstart', (e) => {
    swipe = narrow.matches && e.touches.length === 1 && !table.classList.contains('is-draft-shared')
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  table.addEventListener('touchend', (e) => {
    if (!swipe) return;
    const dx = e.changedTouches[0].clientX - swipe.x;
    const dy = e.changedTouches[0].clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) < SWIPE_MIN || Math.abs(dy) > SWIPE_MAX_DRIFT) return;
    choose((current + (dx < 0 ? 1 : -1) + slots.length) % slots.length);
  }, { passive: true });

  let lastDefault = defaultSeat();
  show(lastDefault);
  refresh();

  return {
    /** 揭晓结束：回到用户点过的座位，没点过就回到自己的座位。 */
    settle() {
      manual = false;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => show(home ?? defaultSeat(), { scroll: true }), document.body.classList.contains('instant') ? 0 : SETTLE_MS);
    },
    /** 新一局：回到自己的座位，否则选手可能停在别人的标签上，看不到自己的候选。 */
    reset() {
      clearTimeout(settleTimer);
      home = null;
      manual = false;
      show(lastDefault = defaultSeat());
    },
    /** 自己的座位确定后，还没手动选过就切过去。 */
    syncDefault() {
      // 每次状态更新都会调用，默认座位没变时不能打断揭晓时的跟随
      if (home === null && defaultSeat() !== lastDefault) show(lastDefault = defaultSeat());
      refresh();
    },
  };
}
