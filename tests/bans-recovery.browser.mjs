// Isolated by default. LOTTERY_TEST_ORIGIN is only for authorized deployment checks;
// every externally created room is owned by this run and removed in finally.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const checks = [], errors = [], rooms = [];
let child, browser, dir, origin = process.env.LOTTERY_TEST_ORIGIN;
const api = async (room, path, method = 'GET', body) => {
  const res = await room.host.request.fetch(origin + '/lottery/live-api/rooms/' + room.roomId + path, {
    method, headers: { Authorization: 'Bearer ' + room.hostToken }, data: body,
  });
  return res;
};
async function create(preset = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', locale: 'zh-CN', viewport: { width: 1440, height: 1080 } });
  await context.addInitScript(preset => {
    Object.defineProperty(navigator, 'doNotTrack', { get: () => '1' });
    localStorage.setItem('pil-lottery:v1', JSON.stringify({ sound: false, drawTrait: false, draft: { survivorSelfBans: 1, banSeconds: 0, ...preset } }));
  }, preset);
  const host = await context.newPage();host.on('pageerror', error => errors.push(error.message));
  await host.goto(origin + '/lottery/', { waitUntil: 'domcontentloaded' });await host.waitForFunction(() => !document.querySelector('#btn-draw').disabled);
  await host.locator('#btn-live').click();
  const creating = host.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/rooms'));
  await host.locator('#live-create').click();const response = await creating;assert.equal(response.status(), 201);
  const room = { ...await response.json(), host };rooms.push(room);
  await host.waitForFunction(() => !document.querySelector('#live-on').hidden);return room;
}
async function reset(room) {
  const { host } = room;await host.locator('#live-reset').click();const response = host.waitForResponse(r => r.url().endsWith('/reset'));
  await host.locator('#live-reset').click();assert.equal((await response).status(), 200);
}
async function start(room) {
  await room.host.locator('#dlg-live button[value="close"]').click();await room.host.locator('#btn-draw').click();
  await room.host.waitForFunction(() => !document.querySelector('.ban-board').hidden);
}
async function enter(room, view) {
  const context = await browser.newContext({ reducedMotion: 'reduce', locale: 'zh-CN', viewport: { width: 1440, height: 1080 } });
  await context.addInitScript(() => Object.defineProperty(navigator, 'doNotTrack', { get: () => '1' }));
  const page = await context.newPage();page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/lottery/live/#' + room.roomId, { waitUntil: 'domcontentloaded' });
  await page.locator('#entry-views [data-view="' + view + '"]').click();await page.locator('#entry-submit').click();
  await page.waitForFunction(() => !document.querySelector('#table').hidden);return page;
}
async function confirmAsPlayer(room) {
  const bans = (await (await api(room, '/draft')).json()).bans;
  const player = await (await api(room, '/join', 'POST', { view: 'survivor' })).json();
  const step = bans.stage + ':' + (bans.picks.survivor.survivor.length + bans.passed.survivor.survivor);
  assert.equal((await api(room, '/bans/pick', 'POST', { session: player.session, round: bans.round, step, char: bans.targets.survivor[0] })).status(), 200);
  assert.equal((await api(room, '/bans/confirm', 'POST', { session: player.session, round: bans.round, step })).status(), 200);
}
try {
  if (!origin) {
    dir = await mkdtemp(join(tmpdir(), 'pil-ban-recovery-'));let port;
    for (let p = 23500; p < 23600; p++) {
      const held = [];
      try { for (const n of [p, p + 1000]) { const s = createServer();await new Promise((resolve, reject) => { s.once('error', reject);s.listen(n, '127.0.0.1', resolve); });held.push(s); }port = p;break; }
      catch { /* Try another pair. */ } finally { await Promise.all(held.map(s => new Promise(resolve => s.close(resolve)))); }
    }
    assert.ok(port);origin = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, ['server/dev.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), LIVE_DB_PATH: join(dir, 'rooms.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });await Promise.race([once(lines, 'line'), once(child, 'exit').then(() => { throw Error('Isolated server failed'); })]);lines.close();
  }
  browser = await chromium.launch({ headless: true });
  const first = await create();await reset(first);await start(first);const watcher = await enter(first, 'spectator');
  let held;await first.host.route('**/state', route => { held = route; });
  await first.host.locator('#btn-init').click();await first.host.locator('#btn-init').click();
  for (let i = 0; !held && i < 100; i++) await first.host.waitForTimeout(20);
  assert.ok(held);assert.ok(await first.host.locator('#btn-init').isDisabled());assert.equal(await first.host.locator('.ban-board').isHidden(), false);
  await held.fulfill({ status: 503, json: { error: 'server-busy' } });
  await first.host.waitForFunction(() => document.querySelector('#toast').textContent === '初始化未确认，请重试。');
  assert.ok((await (await api(first, '/draft')).json()).bans);assert.equal(await first.host.locator('.ban-board').isHidden(), false);
  checks.push('initialization waits for acknowledgement and preserves the active ban when it fails');
  await first.host.unroute('**/state');await first.host.locator('#btn-init').click();await first.host.locator('#btn-init').click();
  await first.host.waitForFunction(() => document.querySelector('#toast').textContent === '已初始化');
  const initialized = await (await api(first, '/draft')).json();assert.equal(initialized.bans, null);assert.equal(initialized.draft, null);assert.equal(initialized.round, 0);
  await watcher.waitForFunction(() => document.querySelector('.ban-board').hidden && document.querySelector('#live-phase').textContent === '等待裁判开始');
  assert.equal((await (await api(first, '/status')).json()).access.spectator.taken, 1);
  checks.push('reset then initialize clears the server and viewers while preserving their seats');

  const race = await create({ survivorBans: 1 });await start(race);const a = await enter(race, 'survivor'), b = await enter(race, 'survivor');
  await a.locator('.ban-tile:not([disabled])').first().click();await b.waitForFunction(() => Boolean(document.querySelector('.ban-tile.is-pending')));
  const heldConfirms = [];
  for (const page of [a, b]) await page.route('**/bans/confirm', route => { heldConfirms.push(route); });
  const responses = [a.waitForResponse(r => r.url().endsWith('/bans/confirm')), b.waitForResponse(r => r.url().endsWith('/bans/confirm'))];
  await Promise.all([a.locator('.ban-confirm').click(), b.locator('.ban-confirm').click()]);
  for (let i = 0; heldConfirms.length < 2 && i < 100; i++) await a.waitForTimeout(20);
  assert.equal(heldConfirms.length, 2);assert.ok(heldConfirms.every(route => route.request().postDataJSON().step === 'own:0'));
  await Promise.all(heldConfirms.map(route => route.continue()));assert.deepEqual((await Promise.all(responses)).map(res => res.status()).sort(), [200, 409]);
  const next = (await (await api(race, '/draft')).json()).bans;assert.equal(next.stage, 'enemy');assert.equal(next.passed.survivor.hunter, 0);assert.equal(next.done.survivor, false);
  checks.push('two real player pages cannot spend the next-stage quota with simultaneous confirmations');
  for (const page of [a, b]) await page.unroute('**/bans/confirm');
  await a.waitForFunction(() => document.querySelector('.ban-confirm')?.dataset.step === 'enemy:0');
  await a.locator('.ban-tile:not([disabled])').first().click();await a.locator('.ban-confirm').click();
  await race.host.waitForFunction(() => !document.body.classList.contains('is-busy') && document.querySelectorAll('.card.is-open').length === 5);
  checks.push('fresh next-stage player actions still complete banning and drawing');

  const third = await create();await start(third);await third.host.locator('#btn-live').click();await confirmAsPlayer(third);
  await third.host.waitForSelector('.ban-reveal', { state: 'attached' });assert.ok(await third.host.locator('#live-reset').isDisabled());
  let resets = 0;third.host.on('request', req => { if (req.url().endsWith('/reset')) resets++; });
  await third.host.locator('#live-reset').dispatchEvent('click');await third.host.locator('#live-reset').dispatchEvent('click');
  assert.equal(resets, 0);assert.equal((await (await api(third, '/draft')).json()).bans.closed, true);
  await third.host.waitForFunction(() => !document.body.classList.contains('is-busy') && document.querySelectorAll('.card.is-open').length === 5);
  await reset(third);await third.host.waitForTimeout(500);
  const cleared = await (await api(third, '/draft')).json();assert.equal(cleared.round, 0);assert.equal(cleared.bans, null);assert.equal(cleared.draft, null);
  checks.push('reset is blocked through the reveal; resetting after completion stays cleared');
  assert.deepEqual(errors, []);
} finally {
  for (const room of rooms) { const res = await api(room, '', 'DELETE');assert.ok([200, 404].includes(res.status())); }
  await browser?.close();if (child && child.exitCode === null) { const ended = once(child, 'exit');child.kill('SIGTERM');await ended; }
  if (dir) await rm(dir, { recursive: true, force: true });
}
const report = { passed: true, checks, pageErrors: errors, testRoomsDeleted: rooms.length };
if (process.env.BAN_TEST_REPORT) await writeFile(process.env.BAN_TEST_REPORT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
