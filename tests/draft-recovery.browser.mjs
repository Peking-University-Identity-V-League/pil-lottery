// Real browser recovery scenarios; independent server/database, no production access.
// Run with Playwright installed or PLAYWRIGHT_MODULE pointing to its entry module.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(tmpdir(), 'pil-draft-recovery-'));
let child, browser;
const errors = [], checks = [];
const chars = JSON.parse(await readFile(join(root, 'characters.json'), 'utf8'));
const cands = [0, 1, 2, 3].map(i => chars.survivors.slice(i * 2, i * 2 + 2).map(c => c.id));
const port = await (async () => {
  for (let p = 23200; p < 23300; p++) {
    const held = [];
    try {
      for (const n of [p, p + 1000]) {
        const server = createServer();
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(n, '127.0.0.1', resolve); });
        held.push(server);
      }
      return p;
    } catch { /* Try an unused port pair. */ }
    finally { await Promise.all(held.map(server => new Promise(resolve => server.close(resolve)))); }
  }
  throw Error('No isolated port pair available');
})();
const origin = `http://127.0.0.1:${port}`;
const api = (room, path, method = 'GET', body) => fetch(origin + '/lottery/live-api/rooms' + (room ? '/' + room.roomId : '') + path, {
  method, headers: { 'Content-Type': 'application/json', ...(room ? { Authorization: 'Bearer ' + room.hostToken } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
async function setup(seconds = null, onTimeout = 'random') {
  const room = await (await api(null, '', 'POST')).json();
  const draft = { round: Date.now(), deadline: null, onTimeout, survivor: { mode: 'personal', cands }, hunter: { mode: 'direct' } };
  assert.equal((await api(room, '/draft', 'PUT', { seq: 1, draft, seconds })).status, 200);
  return room;
}
async function host(room, picking = true) {
  const context = await browser.newContext({ reducedMotion: 'reduce', locale: 'zh-CN', viewport: { width: 1440, height: 1080 } });
  await context.addInitScript(room => {
    localStorage.setItem('pil-lottery:live', JSON.stringify({ ...room, passwords: {} }));
    localStorage.setItem('pil-lottery:v1', JSON.stringify({ drawTrait: false, sound: false }));
  }, room);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/lottery/', { waitUntil: 'domcontentloaded' });
  if (picking) await page.waitForFunction(() => document.querySelector('#btn-draw').textContent === '结束选角');
  return page;
}
async function finish(page, room, expected = []) {
  await page.waitForFunction(() => !document.body.classList.contains('is-busy') && document.querySelectorAll('#table .card.is-open').length === 5 && document.querySelectorAll('#table .panel.pending').length === 0);
  await page.waitForFunction(async () => {
    const room = JSON.parse(localStorage.getItem('pil-lottery:live'));
    const res = await fetch('/lottery/live-api/rooms/' + room.roomId + '/draft', { headers: { Authorization: 'Bearer ' + room.hostToken } });
    return (await res.json()).draft === null;
  });
  const names = await page.locator('#table .slot .name').allTextContents();
  expected.forEach((id, i) => assert.equal(names[i], chars.survivors.find(c => c.id === id).name));
  assert.equal((await (await api(room, '/draft')).json()).draft, null);
}
async function lockPlayers(room, count = 4) {
  const snapshot = await (await api(room, '/draft')).json();
  for (let i = 0; i < count; i++) {
    const player = await (await api(room, '/join', 'POST', { view: 'survivor' })).json();
    assert.equal((await api(room, '/draft/lock', 'POST', { session: player.session, round: snapshot.draft.round, position: i, char: cands[i][1] })).status, 200);
  }
  return cands.slice(0, count).map(list => list[1]);
}
try {
  child = spawn(process.execPath, ['server/dev.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), LIVE_DB_PATH: join(dir, 'rooms.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  await Promise.race([once(lines, 'line'), once(child, 'exit').then(() => { throw Error('Isolated server failed'); })]); lines.close();
  browser = await chromium.launch({ headless: true });

  const expired = await setup(1); await new Promise(resolve => setTimeout(resolve, 1200));
  const resumed = await host(expired, false); await finish(resumed, expired);
  checks.push('expired random drafts resume automatically instead of stalling at time up');
  await resumed.close();

  const waiting = await setup(1, 'wait'); await new Promise(resolve => setTimeout(resolve, 1200));
  const waitingHost = await host(waiting); await waitingHost.waitForTimeout(400);
  assert.ok((await (await api(waiting, '/draft')).json()).draft);
  assert.ok((await waitingHost.locator('.draft-bar').textContent()).includes('等待裁判处理'));
  await waitingHost.locator('#btn-draw').click(); await finish(waitingHost, waiting);
  checks.push('wait-on-timeout still waits for the referee'); await waitingHost.close();

  const room = await setup(), page = await host(room);
  const stale = await (await api(room, '/draft')).json();
  await page.route('**/draft', route => route.request().method() === 'GET' ? route.fulfill({ json: stale }) : route.continue());
  const chosen = await lockPlayers(room);
  let closes = 0, writes = 0;
  page.on('request', req => { if (req.method() === 'PUT' && req.url().endsWith('/state')) writes++; });
  await page.route('**/draft/close', route => { closes++; return route.fulfill({ status: 503, json: { error: 'server-busy' } }); });
  await page.locator('#btn-draw').click();
  await page.waitForFunction(() => document.querySelector('#btn-draw').textContent === '重试结束选角');
  await page.unroute('**/draft'); await page.waitForTimeout(1300);
  assert.equal(closes, 1, 'a completed poll must not automatically repeat a failed close'); assert.equal(writes, 0);
  assert.deepEqual((await (await api(room, '/draft')).json()).draft.seats.slice(0, 4).map(s => s.sel), chosen);
  await page.unroute('**/draft/close'); await page.locator('#btn-draw').click(); await finish(page, room, chosen);
  checks.push('failed close publishes nothing; manual retry uses all server-confirmed player locks'); await page.close();

  const lost = await setup(), lostHost = await host(lost);
  const selected = await lockPlayers(lost, 1);
  await lostHost.route('**/draft/close', async route => { const res = await route.fetch(); assert.equal(res.status(), 200); await route.abort('failed'); });
  await lostHost.locator('#btn-draw').click();
  await lostHost.waitForFunction(() => document.querySelector('#btn-draw').textContent === '重试结束选角');
  assert.equal((await (await api(lost, '/draft')).json()).draft.closed, true);
  await lostHost.unroute('**/draft/close'); await lostHost.locator('#btn-draw').click(); await finish(lostHost, lost, selected);
  checks.push('lost close acknowledgement is retryable without losing locked selections'); await lostHost.close();

  const closed = await setup(), closedChoice = await lockPlayers(closed, 1);
  const current = await (await api(closed, '/draft')).json();
  assert.equal((await api(closed, '/draft/close', 'POST', { round: current.draft.round })).status, 200);
  const closedHost = await host(closed, false); await finish(closedHost, closed, closedChoice);
  checks.push('reload after confirmed close resumes finalization with its locked selections');
  assert.deepEqual(errors, []); console.log(JSON.stringify({ passed: true, checks, pageErrors: errors }, null, 2));
} finally {
  await browser?.close();
  if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
  await rm(dir, { recursive: true, force: true });
}
