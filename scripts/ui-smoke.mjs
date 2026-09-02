import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createRealtimeApp } from '../src/realtime-app.js';
import { RoomStore } from '../src/store.js';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const store = new RoomStore(join(mkdtempSync(join(tmpdir(), 'poker-ui-')), 'smoke.sqlite'));
const { server, close } = createRealtimeApp({ store });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`server on :${port}`);

const browser = await puppeteer.launch({
  executablePath: EDGE_PATH,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
});
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('dialog', (dialog) => dialog.accept()); // 自动确认 settle 的 confirm()
  await page.emulate({
    viewport: { width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  await browser.defaultBrowserContext().overridePermissions(
    `http://127.0.0.1:${port}`,
    ['clipboard-read', 'clipboard-write'],
  );

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle2' });

  // 等待 socket 连接并创建房间
  await page.waitForSelector('#createRoomBtn:not([disabled])', { timeout: 10000 }).catch(() => {});
  await page.type('#playerName', '冒烟玩家');
  await page.evaluate(() => { document.getElementById('actionTimeout').value = '45'; });
  await page.click('#createRoomBtn');
  await page.waitForSelector('#tableView:not(.hidden)', { timeout: 10000 });
  check('进入牌桌视图', true);

  // 行动时限端到端：UI 输入 → room:create → 服务端归一化 → API 可查
  const roomCode = await page.$eval('#roomCodeBadge', (el) => el.textContent.trim());
  const apiRoom = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${roomCode}`)).json();
  check('行动时限(45s)已写入房间配置', apiRoom?.config?.actionTimeoutMs === 45000,
    `actionTimeoutMs=${apiRoom?.config?.actionTimeoutMs}`);

  const btnInfo = await page.evaluate(() => {
    const el = document.getElementById('moreBtn');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return { display: cs.display, w: rect.width, h: rect.height, x: rect.x, y: rect.y };
  });
  check('⋯ 按钮在移动端可见', !!btnInfo && btnInfo.display !== 'none' && btnInfo.w > 0,
    JSON.stringify(btnInfo));

  if (!btnInfo || btnInfo.w <= 0) {
    throw new Error('moreBtn not visible');
  }

  // 开一局真实对局，让底部操作面板填充完整（倒计时条+快捷加注行都在场）
  await page.evaluate(() => document.getElementById('addBotBtn').click());
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => document.getElementById('startHandBtn').click());
  await page.waitForFunction(
    () => document.querySelector('#actionPanel button'),
    { timeout: 8000 },
  ).catch(() => {});
  const hasActionButtons = await page.evaluate(() =>
    document.querySelectorAll('#actionPanel button').length > 0);
  check('行动面板已渲染完整操作', hasActionButtons);

  // 底栏截断检测：任一单元格 scrollHeight 超出 clientHeight 即被裁剪
  const clipInfo = await page.evaluate(() =>
    [...document.querySelectorAll('.bottom-bar > *')].map((cell) => ({
      cls: cell.className,
      clientH: cell.clientHeight,
      scrollH: cell.scrollHeight,
    })));
  console.log('bottom bar cells:', JSON.stringify(clipInfo));
  const clipped = clipInfo.filter((c) => c.scrollH > c.clientH + 1);
  check('底栏无上下截断', clipped.length === 0, JSON.stringify(clipped));

  // 手牌放大断言：卡牌尺寸 + 手牌列无横向溢出
  const handInfo = await page.evaluate(() => {
    const card = document.querySelector('.viewer-cards .card');
    const cell = document.querySelector('.bottom-bar-hand');
    if (!card || !cell) return null;
    const rect = card.getBoundingClientRect();
    return {
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      overflowX: cell.scrollWidth - cell.clientWidth,
    };
  });
  check('手牌卡已放大 (≥37×53)', !!handInfo && handInfo.w >= 37 && handInfo.h >= 53,
    JSON.stringify(handInfo));
  check('手牌列无横向溢出', !!handInfo && handInfo.overflowX <= 1, JSON.stringify(handInfo));

  await page.screenshot({ path: 'logs/ui-smoke-bottom.png' });

  // 点击 ⋯
  await page.tap('#moreBtn');
  await new Promise((r) => setTimeout(r, 300));

  const openState = await page.evaluate(() => {
    const panel = document.getElementById('headerSecondary');
    if (!panel) return null;
    const cs = getComputedStyle(panel);
    const rect = panel.getBoundingClientRect();
    let topEl = null;
    if (rect.width > 0 && rect.height > 0) {
      topEl = document.elementFromPoint(rect.x + rect.width / 2, rect.y + Math.min(20, rect.height / 2));
    }
    return {
      hasOpenClass: panel.classList.contains('open'),
      display: cs.display,
      position: cs.position,
      overflowHeader: getComputedStyle(document.querySelector('.table-header')).overflow,
      overflowActions: getComputedStyle(document.querySelector('.header-actions')).overflow,
      z: cs.zIndex,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      hitIsInsidePanel: !!(topEl && panel.contains(topEl)),
      hitTag: topEl ? `${topEl.tagName}.${topEl.className}` : null,
    };
  });
  console.log('panel state:', JSON.stringify(openState));
  check('点击后 open 类已切换', !!openState?.hasOpenClass);
  check('面板 display:flex', openState?.display === 'flex');
  check('面板有实际尺寸', !!openState && openState.rect.w > 0 && openState.rect.h > 0);
  check('header 裁剪已放开', openState?.overflowHeader === 'visible' && openState?.overflowActions === 'visible');
  check('命中测试落在面板内（无遮挡）', openState?.hitIsInsidePanel === true,
    `topElement=${openState?.hitTag}`);

  await page.screenshot({ path: 'logs/ui-smoke-open.png' });

  // 点外部关闭
  await page.touchscreen.tap(30, 400);
  await new Promise((r) => setTimeout(r, 300));
  const closed = await page.evaluate(() =>
    !document.getElementById('headerSecondary').classList.contains('open'));
  check('点外部自动收起', closed);

  // 结算 + 复制战报（放最后，会解散房间）
  await page.evaluate(() => document.querySelector('#actionPanel .btn-fold')?.click());
  let handStatus = 'running';
  for (let i = 0; i < 40 && handStatus === 'running'; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const api = await (await fetch(`http://127.0.0.1:${port}/api/rooms/${roomCode}`)).json();
      handStatus = api?.summary?.handStatus ?? 'idle';
    } catch {
      break;
    }
  }
  check('对局已结束可结算', handStatus !== 'running', handStatus);

  // 手牌结束弹窗会遮挡操作，按真实用户路径先关闭
  const endModal = await page.waitForSelector('#handEndModal:not(.hidden)', { timeout: 4000 }).catch(() => null);
  if (endModal) {
    await page.click('#handEndModal .modal-close');
    await new Promise((r) => setTimeout(r, 200));
  }

  // 手机端结算按钮在"⋯"菜单里，按真实用户路径先展开
  await page.tap('#moreBtn');
  await new Promise((r) => setTimeout(r, 250));
  await page.click('#settleBtn');
  await page.waitForSelector('#settlementModal:not(.hidden)', { timeout: 5000 });
  const reportRows = await page.$$eval('#settlementResults .settlement-row', (els) => els.length);
  check('结算弹窗包含玩家行', reportRows >= 1, `rows=${reportRows}`);

  await page.click('#copyReportBtn');
  await new Promise((r) => setTimeout(r, 400));
  const clipText = await page.evaluate(() =>
    navigator.clipboard.readText().then((text) => text).catch(() => ''));
  check(
    '一键复制战报生效',
    typeof clipText === 'string' && clipText.includes('德州扑克战报') && clipText.includes('买入'),
    String(clipText).split('\n')[0] || '(空)',
  );

  check('无页面 JS 错误', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 500));
} finally {
  await browser.close();
  await close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
process.exit(failed.length ? 1 : 0);
