// 共享卡池拖放的回归测试。需要 Playwright，或用 PLAYWRIGHT_MODULE 指定入口；使用独立的临时服务和数据库。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(tmpdir(), 'pil-drag-'));
const port = 22990;
const child = spawn(process.execPath, ['server/dev.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), LIVE_DB_PATH: join(dir, 'rooms.sqlite') }, stdio: 'ignore' });
const browser = await chromium.launch();
try {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1700 }, locale: 'zh-CN' })).newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/lottery/`);
  await page.waitForSelector('#btn-draw:not([disabled])');
  await page.click('#btn-advanced');
  await page.click('#dlg-advanced [data-draft="survivor"] [data-value="shared"]');
  await page.click('#dlg-advanced button[value=close]');
  await page.click('#btn-draw');
  await page.waitForFunction(() => document.querySelector('#btn-draw').textContent === '结束选角', null, { timeout: 25000 });

  const seat = (i) => page.locator('.lineup-survivor .slot').nth(i).locator('.card');
  const free = () => page.locator('.draft-pool .draft-cand:not(.is-gone)');
  const center = async (locator) => { const r = await locator.boundingBox(); return [r.x + r.width / 2, r.y + r.height / 2]; };
  const names = () => page.$$eval('.lineup-survivor .slot', (nodes) => nodes.map((n) => (n.querySelector('.card').classList.contains('is-open') ? n.querySelector('.name').textContent : '')));
  /** 每次拖放后都不能留下半透明、高亮或克隆的牌。 */
  async function drag(from, to) {
    const [x1, y1] = await center(from);
    const [x2, y2] = await center(to);
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x1 + 12, y1 + 12);
    await page.mouse.move(x2, y2, { steps: 6 });
    assert.equal(await page.locator('.draft-drag').count(), 1);
    await page.mouse.up();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.is-dragging, .is-drop-target, .is-drop-over, .draft-fly').count(), 0);
  }

  await drag(free().first(), seat(3));
  let now = await names();
  assert.ok(now[3] && !now[0]);
  await drag(free().first(), seat(1));
  const [second, fourth] = [(await names())[1], (await names())[3]];
  await drag(seat(3), seat(1));
  now = await names();
  assert.deepEqual([now[1], now[3]], [fourth, second]);
  await drag(seat(3), page.locator('.draft-pool'));
  assert.equal((await names())[3], '');
  await drag(free().first(), page.locator('.site-sponsor')); // 拖到别处等于取消
  assert.equal(await free().count(), 5);
  assert.deepEqual(errors, []);
  console.log('draft drag ok');
} finally {
  await browser.close();
  child.kill();
  await rm(dir, { recursive: true, force: true });
}
