import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../js/telemetry.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const website = 'd8c95849-978e-48d7-ba4d-7a783397609b';
function client({ hostname = 'pkuidv.com', pathname = '/lottery/', dnt = '0' } = {}) {
  let onLoad;
  let tracker;
  const context = {
    URL, Promise, location: { hostname, pathname }, navigator: { doNotTrack: dnt },
    document: {
      createElement: () => ({ setAttribute(name, value) { this[name] = value; }, addEventListener: (type, listener) => { onLoad = listener; } }),
      head: { append: element => { tracker = element; } },
    },
  };
  context.window = context;
  vm.runInNewContext(source, context);
  return { context, tracker, loaded: () => onLoad?.(), filter: (type, payload) => context.pilLotteryBeforeSend(type, payload) };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('privacy hook loads before an asynchronous tracker using the existing production site', () => {
  const { tracker, context } = client();
  assert.equal(typeof context.pilLotteryBeforeSend, 'function');
  assert.equal(tracker.src, 'https://umami.pkuidv.com/script.js');
  assert.equal(tracker.async, true);
  for (const [name, value] of Object.entries({
    'data-website-id': website, 'data-domains': 'pkuidv.com', 'data-tag': 'lottery',
    'data-exclude-search': 'true', 'data-exclude-hash': 'true', 'data-do-not-track': 'true',
    'data-before-send': 'pilLotteryBeforeSend',
  })) assert.equal(tracker[name], value);
  assert.equal((html.match(/src="js\/telemetry.js"/g) || []).length, 1);
  assert.ok(!html.includes('src="https://umami.pkuidv.com/script.js"'));
});

test('pageviews discard query, fragment, identifiers and referrer path', () => {
  const { filter } = client();
  assert.deepEqual(plain(filter('event', {
    website, url: '/lottery/?token=private#secret', title: 'private name', id: 'person',
    referrer: 'https://example.org/private?email=secret#id', language: 'zh-CN', screen: '1440x900',
    data: { clipboard: 'private' }, extra: 'private',
  })), {
    website, hostname: 'pkuidv.com', title: '第五人格随机抽取工具', url: '/lottery/', tag: 'lottery',
    language: 'zh-CN', screen: '1440x900', referrer: 'https://example.org',
  });
});

test('actions retain only bounded counts and fixed choices, never results or clipboard data', () => {
  const { filter } = client();
  assert.deepEqual(plain(filter('event', { website, name: 'lottery_draw', data: {
    survivor_pool: 50, hunter_pool: 31, trait_pool: 8, survivor_ult: 'random', hunter_ult: 2,
    despair: true, draw_trait: false, kept: -1, total: 1001, value: 'private',
    side: 'private', character: 'private', result: { name: 'private' }, clipboard: 'private',
  } })), {
    website, hostname: 'pkuidv.com', title: '第五人格随机抽取工具', url: '/lottery/', tag: 'lottery',
    name: 'lottery_draw', data: {
      application: 'lottery', survivor_ult: 'random', hunter_ult: 2,
      survivor_pool: 50, hunter_pool: 31, trait_pool: 8, despair: true, draw_trait: false,
    },
  });
  assert.equal(filter('event', { website, name: 'unknown' }), false);
  assert.equal(filter('identify', { website, id: 'person' }), false);
  assert.equal(filter('event', { website: 'another-site' }), false);
});

test('development hosts, other paths and Do Not Track produce no payload or queued action', () => {
  for (const options of [{ hostname: 'localhost' }, { pathname: '/tactical-friend/' }, { dnt: '1' }]) {
    const { context, tracker, filter, loaded } = client(options);
    assert.equal(tracker, undefined);
    const sent = [];
    context.pilLotteryTrack('lottery_draw');
    context.umami = { track: (...args) => sent.push(args) };
    loaded();
    context.pilLotteryTrack('lottery_draw');
    assert.equal(filter('event', { website }), false);
    assert.equal(sent.length, 0);
  }
});

test('early actions queue once with a bound, and tracking failures never escape', async () => {
  const { context, loaded } = client();
  const sent = [];
  for (let i = 0; i < 40; i++) context.pilLotteryTrack('lottery_copy', { format: 'brief', clipboard: 'secret' });
  context.umami = { track: (...args) => { sent.push(plain(args)); return Promise.reject(new Error('offline')); } };
  loaded();
  assert.equal(sent.length, 32);
  assert.deepEqual(sent[0], ['lottery_copy', { application: 'lottery', format: 'brief' }]);
  context.umami.track = () => { throw new Error('blocked'); };
  assert.doesNotThrow(() => context.pilLotteryTrack('lottery_draw'));
  await new Promise(resolve => setImmediate(resolve));
});

test('room entry pageviews exclude room, role, password, access token and state', async () => {
  for (const pathname of ['/lottery/live/', '/lottery/live/index.html']) {
    const { tracker, context, filter, loaded } = client({ pathname });
    assert.equal(tracker['data-tag'], 'lottery-live');
    const payload = filter('event', { website, url: pathname + '?room=PRIVATE&token=PRIVATE#PRIVATE',
      id: 'PRIVATE', title: 'PRIVATE', referrer: 'https://pkuidv.com/lottery/?token=PRIVATE',
      data: { password: 'PRIVATE', role: 'PRIVATE', results: 'PRIVATE' } });
    assert.deepEqual(plain(payload), { website, hostname: 'pkuidv.com', title: '第五人格抽签房间',
      url: '/lottery/live/', tag: 'lottery-live', referrer: 'https://pkuidv.com' });
    assert.equal(filter('event', { website, name: 'lottery_draw', data: { result: 'PRIVATE' } }), false);
    assert.equal(filter('identify', { website, id: 'PRIVATE' }), false);
    const sent = []; context.umami = { track: (...event) => sent.push(event) }; loaded();
    context.pilLotteryTrack('lottery_draw', { room: 'PRIVATE' });
    assert.equal(sent.length, 0);
  }
  const liveHtml = await readFile(new URL('../live/index.html', import.meta.url), 'utf8');
  assert.equal((liveHtml.match(/src="\.\.\/js\/telemetry.js"/g) || []).length, 1);
  assert.equal(client({ pathname: '/lottery/live/', dnt: '1' }).tracker, undefined);
});

test('main-page sponsor clicks are retained without arbitrary data', () => {
  const { filter } = client();
  const event = filter('event', { website, name: 'sponsor_afdian_open', data: { private: 'PRIVATE', total: 10 } });
  assert.equal(event.name, 'sponsor_afdian_open');
  assert.deepEqual(plain(event.data), { application: 'lottery' });
  assert.ok(html.includes('data-umami-event="sponsor_afdian_open"'));
});
