// Run with Node and Playwright installed, or set PLAYWRIGHT_MODULE to its entry point.
// Uses its own temporary database and local server; never touches the preview rooms.
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
const dir = await mkdtemp(join(tmpdir(), 'pil-animation-'));
const checks = [], errors = [];
let child, browser;
const port = await (async () => {
  for (let p = 22400; p < 22500; p++) {
    const held = [];
    try {
      for (const n of [p, p + 1000]) {
        const server = createServer();
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(n, '127.0.0.1', resolve); });
        held.push(server);
      }
      return p;
    } catch { /* Try another isolated port pair. */ }
    finally { await Promise.all(held.map(server => new Promise(resolve => server.close(resolve)))); }
  }
  throw Error('No test port available');
})();
const origin = `http://127.0.0.1:${port}`;
async function page(options = {}) {
  const context = await browser.newContext({ locale: 'zh-CN',  viewport: { width: 1440, height: 1080 }, ...options });
  await context.addInitScript(() => {
    window.__sent = []; window.__received = []; window.__motions = [];
    const fetchOriginal = window.fetch;
    window.fetch = function(url, options) {
      if (String(url).endsWith('/state') && options?.body) {
        const { state } = JSON.parse(options.body);
        const slots = [...document.querySelectorAll('#table .slot')].map(slot => ({
          open: slot.querySelector('.card').classList.contains('is-open'),
          pending: slot.querySelector('.panel').classList.contains('pending'),
          rolling: Boolean(slot.querySelector('.trait.rolling')),
          trait: slot.querySelector('.trait-name')?.textContent,
        }));
        window.__sent.push({ state, slots, at: Date.now() });
      }
      return fetchOriginal.call(this, url, options);
    };
    const NativeSource = window.EventSource;
    window.EventSource = class extends NativeSource {
      constructor(...args) {
        super(...args); window.__source = this;
        this.addEventListener('state', e => window.__received.push({ state: JSON.parse(e.data), at: Date.now() }));
      }
    };
    const animate = Element.prototype.animate;
    Element.prototype.animate = function(frames, options) {
      window.__motions.push({ card: this.classList.contains('card'), at: Date.now() });
      return animate.call(this, frames, options);
    };
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
  });
  const result = await context.newPage();
  result.on('pageerror', error => errors.push(error.message));
  return result;
}
async function enter(p, room, view) {
  await p.goto(`${origin}/lottery/live/#${room}`);
  await p.locator(`#entry-views [data-view="${view}"]`).click();
  await p.locator('#entry-submit').click();
  await p.waitForFunction(() => window.__received.length > 0);
}
async function done(host, viewers) {
  await host.waitForFunction(() => !document.body.classList.contains('is-busy'), null, { timeout: 25000 });
  for (const p of viewers) {
    await p.waitForFunction(() => document.querySelector('#live-phase').textContent === '抽取完成');
    await p.waitForFunction(() => document.querySelectorAll('#table .card.is-open').length === 5);
    await p.waitForFunction(() => document.querySelectorAll('#table .panel.pending').length === 0);
  }
}
async function auditHost(host) {
  const events = await host.evaluate(() => window.__sent);
  for (const event of events) for (let i = 0; i < event.state.slots.length; i++) {
    const state = event.state.slots[i], dom = event.slots[i];
    if (state.char) assert.ok(dom.open, `slot ${i} published before host flip`);
    if (state.build) assert.ok(!dom.pending, `slot ${i} published before host panel`);
    if (state.trait && state.trait !== 'free') {
      assert.ok(!dom.rolling, 'trait published while host is rolling');
      assert.equal(state.trait.name, dom.trait);
    }
  }
}
try {
  child = spawn(process.execPath, ['server/dev.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), LIVE_DB_PATH: join(dir, 'rooms.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  await Promise.race([once(lines, 'line'), once(child, 'exit').then(() => { throw Error('Isolated server failed'); })]); lines.close();
  browser = await chromium.launch({ headless: true });
  const host = await page();
  await host.goto(origin + '/lottery/');
  await host.waitForFunction(() => !document.querySelector('#btn-draw').disabled);
  await host.locator('#btn-live').click(); await host.locator('#live-create').click();
  await host.waitForFunction(() => !document.querySelector('#live-on').hidden);
  const room = await host.locator('#live-room-id').textContent();
  const viewers = [];
  for (const view of ['hunter', 'survivor', 'spectator']) {
    const p = await page(); await enter(p, room, view); viewers.push(p);
  }
  const reduced = await page({ reducedMotion: 'reduce' }); await enter(reduced, room, 'spectator');
  const spectator = viewers[2];
  await host.locator('#dlg-live button[value="close"]').click();
  await host.locator('#btn-draw').click();
  for (const p of viewers) {
    await p.waitForFunction(() => window.__motions.filter(m => m.card).length >= 5);
    assert.equal(await p.locator('.card.is-open').count(), 0);
  }
  checks.push('all three views shuffle sealed cards before any result');
  await spectator.waitForFunction(() => document.querySelectorAll('.card.is-open').length === 1);
  assert.ok(await spectator.locator('.panel.pending').count() >= 4);
  if (process.env.ANIMATION_SCREENSHOTS) await spectator.screenshot({ path: join(process.env.ANIMATION_SCREENSHOTS, 'desktop-reveal.png'), fullPage: true });
  checks.push('survivors reveal one card at a time and panels wait for their own flip');
  await spectator.waitForFunction(() => document.querySelector('.slot-hunter .card').classList.contains('is-charging'));
  assert.equal(await spectator.locator('.slot-hunter .card.is-open').count(), 0);
  checks.push('hunter charge plays before its reveal');
  await spectator.waitForFunction(() => document.querySelector('.trait').classList.contains('rolling'));
  const beforeIcon = await spectator.locator('.trait-icon img').getAttribute('src');
  await spectator.waitForTimeout(150);
  assert.notEqual(await spectator.locator('.trait-icon img').getAttribute('src'), beforeIcon);
  const late = await page(); await enter(late, room, 'spectator');
  await done(host, [...viewers, reduced, late]);
  assert.equal(await late.evaluate(() => window.__motions.filter(m => m.card).length), 0);
  checks.push('trait icons roll, and joining mid-draw restores revealed cards without replaying the deal');
  assert.equal(await reduced.evaluate(() => window.__motions.length), 0);
  checks.push('reduced-motion viewer waits for real reveal events without running animations');
  await auditHost(host);

  await spectator.reload(); await spectator.waitForFunction(() => window.__received.length > 0);
  assert.equal(await spectator.evaluate(() => window.__motions.length), 0);
  checks.push('reloading a completed round shows the final snapshot without replay');
  const eventCount = await spectator.evaluate(() => window.__received.length);
  await spectator.evaluate(() => { window.__source.close(); window.__source.onerror(new Event('error')); });
  await spectator.waitForFunction(count => window.__received.length > count && document.querySelector('#live-conn').textContent.includes('已连接'), eventCount);
  assert.equal(await spectator.evaluate(() => window.__motions.length), 0);
  await spectator.waitForFunction(() => !document.querySelector('#dlg-conn').open);
  checks.push('SSE disconnect and reconnect restore the latest completed state without replay');
  await late.setViewportSize({ width: 390, height: 844 });
  assert.equal(await late.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.ANIMATION_SCREENSHOTS) await late.screenshot({ path: join(process.env.ANIMATION_SCREENSHOTS, 'mobile-result.png'), fullPage: true });
  checks.push('390px viewport keeps results within the page width');

  const oldOthers = await spectator.locator('.slot .name').allTextContents();
  await host.locator('[data-act="char"]').first().click();
  await spectator.waitForFunction(() => document.querySelector('.card.live-rerolling'));
  assert.equal(await spectator.locator('.card.is-open').count(), 4);
  assert.deepEqual((await spectator.locator('.slot .name').allTextContents()).slice(1), oldOthers.slice(1));
  await done(host, viewers); await auditHost(host);
  checks.push('single character reroll animates only its slot and masks the replacement until host reveal');

  await host.locator('[data-act="build"]').first().click();
  await spectator.waitForFunction(() => window.__received.some(e => e.state.phase === 'drawing' && e.state.slots[0].char.status === 'shown' && e.state.slots[0].build.status === 'pending'));
  await done(host, viewers); await auditHost(host);
  checks.push('talent reroll sends a pending panel before revealing the new build');

  await host.locator('[data-act="trait"]').click();
  await spectator.waitForFunction(() => document.querySelector('.trait').classList.contains('rolling'));
  await spectator.emulateMedia({ reducedMotion: 'reduce' });
  await spectator.waitForFunction(() => !document.querySelector('.trait').classList.contains('rolling') && document.querySelector('.trait-name').textContent === '抽取中');
  await spectator.emulateMedia({ reducedMotion: 'no-preference' });
  await spectator.waitForFunction(() => document.querySelector('.trait').classList.contains('rolling'));
  await spectator.reload(); await spectator.waitForFunction(() => window.__received.length > 0);
  await spectator.waitForFunction(() => document.querySelector('.trait').classList.contains('rolling'));
  await done(host, viewers); await auditHost(host);
  checks.push('trait reroll, motion preference changes and reload keep the final trait unrevealed until lock');

  await host.locator('[data-act="char"]').last().click();
  await spectator.waitForFunction(() => document.querySelector('.slot-hunter .card').classList.contains('is-charging'));
  await done(host, viewers); await auditHost(host);
  checks.push('hunter reroll charges and respects combined character, build and trait reveal timing');

  await host.locator('#btn-draw').click();
  await spectator.waitForFunction(() => document.querySelectorAll('.card.is-open').length === 0);
  await host.locator('#btn-draw').click();
  await done(host, viewers); await auditHost(host);
  await spectator.waitForTimeout(800);
  assert.equal(await spectator.evaluate(() => [...document.querySelectorAll('.card')].some(c => c.style.transform || c.style.zIndex || c.classList.contains('live-rerolling'))), false);
  checks.push('skip cancels the deal and leaves no stale transforms or reopened old cards');

  await host.locator('#btn-live').click();
  const hiding = host.waitForResponse(r => r.url().endsWith('/visibility') && r.request().method() === 'PUT');
  await host.locator('[data-vis="survivorSeesTrait"] [data-value="hide"]').click(); await hiding;
  await host.locator('#dlg-live button[value="close"]').click();
  await host.locator('[data-act="trait"]').click();
  await done(host, viewers);
  const hidden = await viewers[1].evaluate(() => window.__received.at(-1).state.slots[4].trait);
  assert.deepEqual(hidden, { status: 'hidden' });
  assert.equal(await viewers[1].locator('.trait-name').textContent(), '未公开');
  checks.push('hidden trait remains absent from survivor SSE and DOM after animation');

  await host.locator('[data-act="trait"]').click();
  await spectator.waitForFunction(() => document.querySelector('.trait').classList.contains('rolling'));
  await spectator.locator('#btn-leave').click();
  await spectator.waitForTimeout(300);
  assert.equal(await spectator.locator('.trait.rolling').count(), 0);
  assert.equal(await spectator.locator('#table').isVisible(), false);
  checks.push('leaving during rolling stops viewer timers and animations');
  await done(host, viewers.slice(0, 2)); await auditHost(host);
  const midHost = await page();
  await midHost.goto(origin + '/lottery/');
  await midHost.waitForFunction(() => !document.querySelector('#btn-draw').disabled);
  await midHost.locator('#btn-draw').click();
  await midHost.waitForFunction(() => document.querySelector('.trait').classList.contains('rolling'));
  await midHost.locator('#btn-live').click(); await midHost.locator('#live-create').click();
  await midHost.waitForFunction(() => !document.querySelector('#live-on').hidden);
  const midRoom = await midHost.locator('#live-room-id').textContent();
  const midViewer = await page(); await enter(midViewer, midRoom, 'spectator');
  assert.equal(await midViewer.evaluate(() => window.__received[0].state.phase), 'trait');
  await midViewer.waitForFunction(() => document.querySelector('.trait').classList.contains('rolling'));
  await done(midHost, [midViewer]); await auditHost(midHost);
  checks.push('creating a room during an active draw preserves the current animation phase');
  assert.deepEqual(errors, []);
  const report = { passed: true, checks, pageErrors: errors };
  if (process.env.ANIMATION_REPORT) await writeFile(process.env.ANIMATION_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({ passed: false, checks, pageErrors: errors, error: String(error) }, null, 2));
  throw error;
} finally {
  await browser?.close();
  if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped; }
  await rm(dir, { recursive: true, force: true });
}
