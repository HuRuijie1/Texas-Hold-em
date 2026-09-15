// 临时脚本：测量干瞪眼「点击按钮 → 界面更新」延迟 + 验证 WebSocket 升级
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createRealtimeApp } from '../src/realtime-app.js';
import { RoomStore } from '../src/store.js';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = new RoomStore(join(mkdtempSync(join(tmpdir(), 'poker-perf-')), 'perf.sqlite'));
const { server, close } = createRealtimeApp({ store });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`server on :${port}`);

function pctl(list, p) {
  if (!list?.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
}

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
  await page.emulate({
    viewport: { width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  // 包一层 io() 以捕获 socket 实例与传输层升级过程（socket.io 脚本稍后才赋值 window.io，用 setter 拦截）
  await page.evaluateOnNewDocument(() => {
    window.__transportLog = [];
    let ioRef;
    Object.defineProperty(window, 'io', {
      configurable: true,
      get() {
        return ioRef;
      },
      set(v) {
        const orig = v;
        const wrapper = function (...args) {
          const socket = orig.apply(this, args);
          window.__ioSocket = socket;
          try {
            socket.io.engine.on('transport', (t) => {
              window.__transportLog.push(typeof t === 'string' ? t : t?.name);
            });
          } catch {
            window.__transportLog.push('engine-hook-failed');
          }
          return socket;
        };
        Object.assign(wrapper, orig);
        ioRef = wrapper;
      },
    });
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#createRoomBtn:not([disabled])', { timeout: 10000 });
  await page.type('#playerName', '延迟测试');
  await page.evaluate(() => document.querySelector('input[name="gameType"][value="gdy"]').click());
  await page.click('#createRoomBtn');
  await page.waitForSelector('#tableView:not(.hidden)', { timeout: 10000 });
  console.log('房间已创建');
  await page.evaluate(() => document.getElementById('addBotBtn').click());
  await sleep(400);
  await page.evaluate(() => document.getElementById('startHandBtn').click());
  console.log('对局开始，开始记录行动延迟…');

  let actions = 0;
  const deadline = Date.now() + 120000;
  while (actions < 15 && Date.now() < deadline) {
    const modalVisible = await page.evaluate(() => {
      const m = document.getElementById('handEndModal');
      return !!m && !m.classList.contains('hidden');
    });
    if (modalVisible) {
      await page.evaluate(() => document.getElementById('nextHandBtn').click());
      await sleep(700);
      continue;
    }
    const turn = await page.evaluate(() => {
      const grid = document.querySelector('#actionPanel .gdy-action-grid');
      if (!grid) return null;
      return {
        hasPass: !!grid.querySelector('.btn-fold'),
        cardTexts: [...document.querySelectorAll('.viewer-cards .card')].map((c) => c.textContent),
      };
    });
    if (!turn) {
      await sleep(250);
      continue;
    }
    if (turn.hasPass) {
      await page.evaluate(() => document.querySelector('#actionPanel .gdy-action-grid .btn-fold').click());
    } else {
      // 自由出牌：点选一张非王的牌，再点「出牌」
      const ok = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.viewer-cards .card')];
        let idx = cards.findIndex((c) => !c.textContent.includes('王'));
        if (idx < 0) idx = 0;
        if (!cards[idx]) return false;
        cards[idx].click();
        const playBtn = document.querySelector('#actionPanel .gdy-action-grid .btn-raise');
        if (!playBtn) return false;
        playBtn.click();
        return true;
      });
      if (!ok) {
        await sleep(300);
        continue;
      }
    }
    actions += 1;
    await sleep(1200);
  }
  console.log(`共执行 ${actions} 次人类行动`);

  const report = await page.evaluate(() => ({
    transportLog: window.__transportLog ?? null,
    finalTransport: window.__ioSocket?.io?.engine?.transport?.name ?? null,
    stats: window.__actionStats ?? null,
  }));
  console.log(`传输层轨迹: ${JSON.stringify(report.transportLog)}，最终: ${report.finalTransport}`);
  const { ack, push } = report.stats ?? {};
  for (const [name, list] of [['ack(乐观渲染)', ack], ['push(广播渲染)', push]]) {
    if (!list?.length) {
      console.log(`${name}: 无样本`);
      continue;
    }
    console.log(`${name}: n=${list.length} min=${pctl(list, 0)}ms p50=${pctl(list, 50)}ms p90=${pctl(list, 90)}ms max=${pctl(list, 100)}ms`);
    console.log(`  全部样本: ${JSON.stringify(list)}`);
  }
  console.log(`页面 JS 错误: ${consoleErrors.length === 0 ? '无' : consoleErrors.join(' | ')}`);
  await page.screenshot({ path: 'logs/perf-gdy-final.png' });
} finally {
  await browser.close();
  await close();
}
