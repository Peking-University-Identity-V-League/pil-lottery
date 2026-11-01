// Shared boundary for pageviews and aggregate actions. Never send draw results.
(function () {
  const website = 'd8c95849-978e-48d7-ba4d-7a783397609b';
  const events = new Set([
    'lottery_draw', 'lottery_reroll', 'lottery_copy', 'lottery_tree_open',
    'lottery_pool_open', 'lottery_pool_change', 'lottery_settings_change',
    'lottery_skip_animation', 'lottery_draft', 'lottery_bans', 'lottery_advanced_open', 'sponsor_afdian_open',
  ]);
  const categories = {
    side: ['survivor', 'hunter', 'trait'],
    target: ['character', 'build', 'trait'],
    format: ['full', 'brief', 'tree_image'],
    outcome: ['copied', 'downloaded', 'failed'],
    setting: ['survivor_ultimate', 'hunter_ultimate', 'despair', 'draw_trait', 'sound',
      'draft_survivor', 'draft_survivorCount', 'draft_sharedSize', 'draft_hunter', 'draft_hunterCount', 'draft_seconds', 'draft_onTimeout',
      'draft_survivorSelfBans', 'draft_survivorBans', 'draft_hunterSelfBans', 'draft_hunterBans', 'draft_banOrder', 'draft_banSeconds', 'draft_banTimeout'],
    survivor_ult: ['random', 0, 1, 2],
    hunter_ult: ['random', 0, 1, 2],
    value: ['random', 0, 1, 2, true, false, 3, 4, 5, 6, 30, 60, 90, 'direct', 'personal', 'shared', 'pick', 'wait'],
    survivor_mode: ['direct', 'personal', 'shared'],
    hunter_mode: ['direct', 'pick'],
    seconds: [0, 30, 60, 90],
  };
  const counts = ['survivor_pool', 'hunter_pool', 'trait_pool', 'kept', 'total'];
  const live = /^\/lottery\/live\/(?:index\.html)?$/.test(location.pathname);
  const enabled = () => location.hostname === 'pkuidv.com'
    && (live || /^\/lottery\/(?:index\.html)?$/.test(location.pathname))
    && ![navigator.doNotTrack, navigator.msDoNotTrack, window.doNotTrack].includes('1');

  window.pilLotteryBeforeSend = function (type, payload) {
    if (!enabled() || type !== 'event' || !payload || payload.website !== website) return false;
    const result = {
      website, hostname: 'pkuidv.com', title: live ? '第五人格抽签房间' : '第五人格随机抽取工具',
      url: live ? '/lottery/live/' : '/lottery/', tag: live ? 'lottery-live' : 'lottery',
    };
    if (/^[a-zA-Z-]{2,35}$/.test(payload.language || '')) result.language = payload.language;
    if (/^\d{1,5}x\d{1,5}$/.test(payload.screen || '')) result.screen = payload.screen;
    try {
      const referrer = new URL(payload.referrer);
      if (['https:', 'http:'].includes(referrer.protocol)) result.referrer = referrer.origin;
    } catch {}
    if (!payload.name) return result;
    if (live || !events.has(payload.name)) return false;
    result.name = payload.name;
    result.data = { application: 'lottery' };
    if (payload.name === 'sponsor_afdian_open') return result;
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
    if (!payload) return;
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
    'data-website-id': website, 'data-domains': 'pkuidv.com', 'data-tag': live ? 'lottery-live' : 'lottery',
    'data-exclude-search': 'true', 'data-exclude-hash': 'true', 'data-do-not-track': 'true',
    'data-before-send': 'pilLotteryBeforeSend',
  })) tracker.setAttribute(name, value);
  tracker.addEventListener('load', () => {
      if (!enabled() || typeof window.umami?.track !== 'function') { pending.length = 0; return; }
      for (const event of pending.splice(0)) send(event);
    }, { once: true });
  document.head.append(tracker);
})();
