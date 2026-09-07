// 行动气泡（player-action）显示完整性验收测试。
//
// 背景：德州扑克 / 炸金花两个游戏共用同一套座位渲染，任何座位数、任何位置、
// 任意视口下，本轮行动气泡都必须完整可见：不被牌桌容器裁剪、不被截断省略、
// 朝向选择正确、层级不被相邻座位盖住。
//
// 做法：从 public/client.js 中原样提取 layoutSeats / createActionElement /
// placeActionBubble 的源码，在无头 Edge 里用真实 styles.css 渲染座位网格，
// 覆盖 2~9 人桌 × 多种视口 × 紧凑/宽松两种桌面高度，逐座位测量 DOM 矩形后断言。

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'public', 'client.js'), 'utf8');
const STYLES_PATH = path.join(ROOT, 'public', 'styles.css');
const STYLES_SRC = fs.readFileSync(STYLES_PATH, 'utf8');

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function findBrowserExecutable() {
  return EDGE_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;
}

// 按花括号配对从源码中截取完整函数文本，供测试夹具原样执行
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `client.js 中找不到 function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`function ${name} 花括号不配对`);
}

const LAYOUT_SEATS_SRC = extractFunction(CLIENT_SRC, 'layoutSeats');
const CREATE_ACTION_SRC = extractFunction(CLIENT_SRC, 'createActionElement');
const PLACE_BUBBLE_SRC = extractFunction(CLIENT_SRC, 'placeActionBubble');

test('client.js 与 styles.css 已包含气泡防裁剪修复', () => {
  // 两个座位渲染器（德州 enhancedRenderSeatGrid / 炸金花 renderZjhSeats）都要接线
  assert.ok(
    (CLIENT_SRC.match(/placeActionBubble\(card\)/g) || []).length >= 2,
    '两个渲染器都应在座位入 DOM 后调用 placeActionBubble',
  );
  assert.ok(
    (CLIENT_SRC.match(/classList\.add\('has-action'\)/g) || []).length >= 2,
    '两个渲染器都应给带气泡的座位加 has-action 抬高层级',
  );

  // 关键帧必须携带水平居中位移，否则 fill: forwards 会在动画结束后丢掉 translateX(-50%)
  assert.match(STYLES_SRC, /@keyframes actionBubbleIn/);
  const keyframes = STYLES_SRC.slice(
    STYLES_SRC.indexOf('@keyframes actionBubbleIn'),
    STYLES_SRC.indexOf('}', STYLES_SRC.indexOf('@keyframes actionBubbleIn') + 200),
  );
  const centered = 'calc(-50% + var(--bubble-shift, 0px))';
  assert.ok(keyframes.includes(centered), 'actionBubbleIn 关键帧需携带居中 + 位移变量');

  // 带气泡 / 行动中的座位需抬高，避免被 DOM 靠后的相邻座位遮挡
  assert.match(STYLES_SRC, /\.seat\.has-action[\s\S]{0,60}z-index:\s*3/);

  // 牌桌视图下不允许再对气泡做宽度截断
  const tvStart = STYLES_SRC.indexOf('body.is-table-view .player-action');
  assert.ok(tvStart >= 0, '缺少 body.is-table-view .player-action 规则');
  const tvBlock = STYLES_SRC.slice(tvStart, STYLES_SRC.indexOf('}', tvStart));
  assert.match(tvBlock, /width:\s*max-content/);
  assert.doesNotMatch(tvBlock, /text-overflow|max-width/);
});

const BUBBLE_TEXTS = ['加注 88888', '过牌', '全下 120000', '弃牌', '跟注 5000', '看牌'];
const VIEWPORTS = [
  { width: 1400, height: 900, label: 'desktop' },
  { width: 900, height: 600, label: 'laptop' },
  { width: 500, height: 360, label: 'phone-landscape' },
  { width: 400, height: 800, label: 'phone-portrait' },
];

function buildHarnessHtml() {
  const stylesUrl = pathToFileURL(STYLES_PATH).href;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${stylesUrl}">
<style>
  /* 布局测量需要在稳定状态下进行，动画终态由静态断言另行覆盖 */
  .player-action { animation: none !important; }
  html, body { margin: 0; }
</style>
<script>
const BUBBLE_TEXTS = ${JSON.stringify(BUBBLE_TEXTS)};
${LAYOUT_SEATS_SRC}
${CREATE_ACTION_SRC}
let elements;
${PLACE_BUBBLE_SRC}
</script>
</head>
<body class="is-table-view">
<div id="app">
  <main>
    <div class="table-view">
      <div class="table-surface" id="surface">
        <div id="seatGrid" class="seat-grid"></div>
      </div>
    </div>
  </main>
</div>
<script>
  elements = { seatGrid: document.getElementById('seatGrid') };

  // 复刻线上渲染：座位内容、viewer/host 差异、气泡长短文本交替
  function buildScenario(maxSeats) {
    const grid = elements.seatGrid;
    grid.innerHTML = '';
    const positions = layoutSeats(maxSeats);
    const cards = [];
    for (let index = 0; index < maxSeats; index += 1) {
      const [x, y] = positions[index];
      const card = document.createElement('div');
      card.className = 'seat';
      if (index === 0) card.classList.add('viewer');
      if (index === 1) card.classList.add('active-turn');
      card.style.left = x + '%';
      card.style.top = y + '%';

      const name = document.createElement('div');
      name.className = 'seat-name';
      name.innerHTML = '<span>玩家' + (index + 1) + '</span><span>#' + (index + 1) + '</span>';
      const stack = document.createElement('div');
      stack.className = 'seat-stack';
      stack.textContent = '100000 筹码';
      card.append(name, stack);

      const bubble = createActionElement(
        index % 2 === 0 ? 'raise' : 'check',
        index % 2 === 0 ? BUBBLE_TEXTS[index % BUBBLE_TEXTS.length].split(' ')[1] : undefined,
      );
      card.appendChild(bubble);
      card.classList.add('has-action');

      const status = document.createElement('div');
      status.className = 'seat-status';
      status.textContent = '已准备';
      card.append(status);

      if (index === 1) {
        const manage = document.createElement('button');
        manage.className = 'ghost seat-manage-btn';
        manage.textContent = '移除 AI';
        card.append(manage);
      }

      grid.append(card);
      placeActionBubble(card);
      cards.push(card);
    }
    return cards;
  }

  window.__runScenario = function (maxSeats) {
    const cards = buildScenario(maxSeats);
    const grid = elements.seatGrid;
    const gridRect = grid.getBoundingClientRect();
    const seats = cards.map((card, index) => {
      const bubble = card.querySelector('.player-action');
      const seatRect = card.getBoundingClientRect();
      const bubbleRect = bubble.getBoundingClientRect();
      return {
        index,
        position: card.dataset.position,
        seat: { top: seatRect.top, bottom: seatRect.bottom, left: seatRect.left, right: seatRect.right },
        bubble: { top: bubbleRect.top, bottom: bubbleRect.bottom, left: bubbleRect.left, right: bubbleRect.right },
          scrollWidth: bubble.scrollWidth,
          clientWidth: bubble.clientWidth,
          seatZ: getComputedStyle(card).zIndex,
          bubbleZ: getComputedStyle(bubble).zIndex,
        };
    });
    return { grid: { top: gridRect.top, bottom: gridRect.bottom, left: gridRect.left, right: gridRect.right }, seats };
  };
</script>
</body>
</html>`;
}

test('所有座位数 × 视口下行动气泡均完整显示', { timeout: 180000 }, async (t) => {
  const executablePath = findBrowserExecutable();
  if (!executablePath) t.skip('未找到 Edge 可执行文件，跳过浏览器布局验收');

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-first-run', '--disable-gpu', '--hide-scrollbars'],
  });
  t.after(() => browser.close());

  const harnessPath = path.join(os.tmpdir(), `bubble-harness-${process.pid}.html`);
  fs.writeFileSync(harnessPath, buildHarnessHtml(), 'utf8');
  t.after(() => fs.rmSync(harnessPath, { force: true }));

  const page = await browser.newPage();
  await page.goto(pathToFileURL(harnessPath).href, { waitUntil: 'load' });

  const failures = [];
  let checked = 0;

  for (const viewport of VIEWPORTS) {
    await page.setViewport(viewport);
    for (const squeeze of [false, true]) {
      // squeeze: 压缩桌面高度，模拟真实界面里顶栏/底栏占位后的受限空间
      await page.evaluate((on) => {
        document.querySelector('.table-view').style.height = on ? '46vh' : '';
      }, squeeze);
      for (let maxSeats = 2; maxSeats <= 9; maxSeats += 1) {
        const report = await page.evaluate((count) => window.__runScenario(count), maxSeats);
        for (const seat of report.seats) {
          checked += 1;
          const ctx = `视口=${viewport.label}(${viewport.width}x${viewport.height})`
            + ` squeeze=${squeeze} 人数=${maxSeats} 座位#${seat.index + 1}`;
          const tol = 1;

          if (seat.bubble.left < report.grid.left - tol
            || seat.bubble.right > report.grid.right + tol
            || seat.bubble.top < report.grid.top - tol
            || seat.bubble.bottom > report.grid.bottom + tol) {
            failures.push(`${ctx}: 气泡超出牌桌容器 bubble=[${seat.bubble.left.toFixed(1)},${seat.bubble.top.toFixed(1)},${seat.bubble.right.toFixed(1)},${seat.bubble.bottom.toFixed(1)}] grid=[${report.grid.left.toFixed(1)},${report.grid.top.toFixed(1)},${report.grid.right.toFixed(1)},${report.grid.bottom.toFixed(1)}]`);
          }
          if (seat.position === 'bottom' ? seat.bubble.top < seat.seat.bottom - tol
            : seat.bubble.bottom > seat.seat.top + tol) {
            failures.push(`${ctx}: 气泡朝向(position=${seat.position})与实际渲染位置不符`);
          }
          if (seat.scrollWidth > seat.clientWidth + 0.5) {
            failures.push(`${ctx}: 气泡文本被截断 scrollWidth=${seat.scrollWidth} clientWidth=${seat.clientWidth}`);
          }
          if (seat.seatZ !== '3') {
            failures.push(`${ctx}: 带气泡座位 z-index=${seat.seatZ}，期望 3（防相邻座位遮挡）`);
          }
        }
      }
    }
  }

  // 留两张代表场景截图便于人工复核：9 人桌桌面端 + 手机横屏（最易裁剪的场景）
  const shotDir = path.join(os.tmpdir(), `bubble-shots-${process.pid}`);
  fs.mkdirSync(shotDir, { recursive: true });
  await page.setViewport({ width: 1400, height: 900 });
  await page.evaluate(() => { document.querySelector('.table-view').style.height = ''; });
  await page.evaluate(() => window.__runScenario(9));
  await page.screenshot({ path: path.join(shotDir, 'seats9-desktop.png') });
  await page.setViewport({ width: 500, height: 360 });
  await page.evaluate((on) => {
    document.querySelector('.table-view').style.height = on ? '46vh' : '';
  }, true);
  await page.evaluate(() => window.__runScenario(9));
  await page.screenshot({ path: path.join(shotDir, 'seats9-phone-landscape.png') });
  console.log(`气泡截图已保存: ${shotDir}`);

  assert.equal(failures.length, 0, `\n${failures.slice(0, 20).join('\n')}`);
  assert.ok(checked > 300, `覆盖面不足：仅断言了 ${checked} 个座位场景`);
});
