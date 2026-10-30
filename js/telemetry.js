// Shared boundary for pageviews and aggregate actions. Never send draw results.
(function () {
  const website = 'd8c95849-978e-48d7-ba4d-7a783397609b';
  const events = new Set([
    'lottery_draw', 'lottery_reroll', 'lottery_copy', 'lottery_tree_open',
    'lottery_pool_open', 'lottery_pool_change', 'lottery_settings_change',
    'lottery_skip_animation',
  ]);
  const categories = {
    side: ['survivor', 'hunter', 'trait'],
    target: ['character', 'build', 'trait'],
    format: ['full', 'brief', 'tree_image'],
    outcome: ['copied', 'downloaded', 'failed'],
    setting: ['survivor_ultimate', 'hunter_ultimate', 'despair', 'draw_trait', 'sound'],
    survivor_ult: ['random', 0, 1, 2],
    hunter_ult: ['random', 0, 1, 2],
    value: ['random', 0, 1, 2, true, false],
  };
  const counts = ['survivor_pool', 'hunter_pool', 'trait_pool', 'kept', 'total'];
  const enabled = () => location.hostname === 'pkuidv.com'
    && /^\/lottery\/(?:index\.html)?$/.test(location.pathname)
    && ![navigator.doNotTrack, navigator.msDoNotTrack, window.doNotTrack].includes('1');

  window.pilLotteryBeforeSend = function (type, payload) {
    if (!enabled() || type !== 'event' || !payload || payload.website !== website) return false;
    const result = {
      website, hostname: 'pkuidv.com', title: '第五人格随机抽取工具',
      url: '/lottery/', tag: 'lottery',
    };
    if (/^[a-zA-Z-]{2,35}$/.test(payload.language || '')) result.language = payload.language;
    if (/^\d{1,5}x\d{1,5}$/.test(payload.screen || '')) result.screen = payload.screen;
    try {
      const referrer = new URL(payload.referrer);
      if (['https:', 'http:'].includes(referrer.protocol)) result.referrer = referrer.origin;
    } catch {}
    if (!payload.name) return result;
    if (!events.has(payload.name)) return false;
    result.name = payload.name;
    result.data = { application: 'lottery' };
    const data = payload.data || {};
    for (const [key, allowed] of Object.entries(categories)) {
      if (allowed.includes(data[key])) result.data[key] = data[key];
    }
    for (const key of counts) {
      if (Number.isInteger(data[key]) && data[key] >= 0 && data[key] <= 1000) result.data[key] = data[key];
    }
    for (const key of ['despair', 'draw_trait']) {
      if (typeof data[key] === 'boolean') result.data[key] = data[key];
    }
    return result;
  };

  const pending = [];
  function send(event) {
    // A failed or blocked analytics request must not affect drawing or copying.
    try { Promise.resolve(window.umami.track(...event)).catch(() => {}); } catch {}
  }
  window.pilLotteryTrack = function (name, data = {}) {
    if (!enabled() || !events.has(name)) return;
    const payload = window.pilLotteryBeforeSend('event', { website, name, data });
    const event = [name, payload.data];
    if (typeof window.umami?.track === 'function') send(event);
    else if (pending.length < 32) pending.push(event);
  };
  // Load analytics independently so a slow or blocked tracker cannot delay the app.
  if (!enabled()) return;
  const tracker = document.createElement('script');
  tracker.async = true;
  tracker.src = 'https://umami.pkuidv.com/script.js';
  for (const [name, value] of Object.entries({
    'data-website-id': website, 'data-domains': 'pkuidv.com', 'data-tag': 'lottery',
    'data-exclude-search': 'true', 'data-exclude-hash': 'true', 'data-do-not-track': 'true',
    'data-before-send': 'pilLotteryBeforeSend',
  })) tracker.setAttribute(name, value);
  tracker.addEventListener('load', () => {
      if (!enabled() || typeof window.umami?.track !== 'function') { pending.length = 0; return; }
      for (const event of pending.splice(0)) send(event);
    }, { once: true });
  document.head.append(tracker);
})();
