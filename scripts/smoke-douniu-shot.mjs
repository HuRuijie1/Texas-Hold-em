// 截图：斗牛大厅（含庄家模式下拉）→ 盲注阶段牌桌 → 结算弹窗（含庄家操作区）→ 续庄后
// 支持 DN_MODE=none 跑无庄模式；默认跑有庄模式
import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:3999';
const MODE = process.env.DN_MODE === 'none' ? 'none' : 'banker';

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 940, deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: 'networkidle2' });
await page.type('#playerName', '截图房主');
await page.evaluate(() => document.querySelector('input[name="gameType"][value="dn"]').click());
await page.select('#dnBankerMode', MODE);
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: 'dist/dn-lobby.png' });

await page.click('#createRoomBtn');
await page.waitForSelector('#tableView:not(.hidden)', { timeout: 8000 });
await page.evaluate(() => { document.getElementById('botLevelSelect').value = 'advanced'; });
await page.click('#addBotBtn');
await new Promise((r) => setTimeout(r, 400));
await page.click('#addBotBtn');
await new Promise((r) => setTimeout(r, 400));
await page.click('#startHandBtn');

const waitFor = async (fn, timeout, label) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate(fn)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`等待${label}超时`);
  return false;
};

if (MODE === 'banker') {
  // 等轮到房主（机器人在前，决策有延迟）；房主是庄家则不会出现按钮
  await waitFor(() => {
    const buttons = [...document.querySelectorAll('#actionPanel button')];
    const blind = buttons.find((b) => /^盲注\s*×/.test(b.textContent));
    if (blind) return true;
    return !document.getElementById('handEndModal').classList.contains('hidden');
  }, 40000, '房主盲注按钮');
  // 有庄模式：盲注后才会发牌，等手牌到位再截图
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('#actionPanel button')];
    const blind = buttons.find((b) => /^盲注\s*×/.test(b.textContent));
    blind?.click();
  });
  await waitFor(() => document.querySelectorAll('#viewerCards .card').length === 5, 40000, '发牌');
  await page.evaluate(() => document.getElementById('peekCardsBtn')?.click());
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: 'dist/dn-table.png' });
} else {
  // 无庄模式：开局即发牌，直接等结算
  await waitFor(() => document.querySelectorAll('#viewerCards .card').length === 5, 40000, '发牌');
  await page.evaluate(() => document.getElementById('peekCardsBtn')?.click());
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: 'dist/dn-table.png' });
}

// 推进到本局结束（无庄模式开局即结算）
await waitFor(() => {
  const done = !document.getElementById('handEndModal').classList.contains('hidden');
  if (done) return true;
  const buttons = [...document.querySelectorAll('#actionPanel button')];
  const blind = buttons.find((b) => /^盲注\s*×/.test(b.textContent));
  if (blind) blind.click();
  return false;
}, 60000, '本局结束');
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: 'dist/dn-result.png' });

// 庄家操作区单独截图（有庄模式且视角为庄家时）
const bankerShot = await page.evaluate(() => {
  const el = document.getElementById('dnBankerModalControl');
  return el && !el.classList.contains('hidden') ? el.getBoundingClientRect() : null;
});
if (bankerShot && bankerShot.width > 0) {
  await page.screenshot({
    path: 'dist/dn-banker.png',
    clip: {
      x: Math.max(0, bankerShot.x - 10),
      y: Math.max(0, bankerShot.y - 10),
      width: Math.min(bankerShot.width + 20, 1280),
      height: Math.min(bankerShot.height + 20, 940),
    },
  });
  console.log('已截取庄家操作区');
}

// 点一次续庄，验证决定后的只读展示
const keepClicked = await page.evaluate(() => {
  const btn = document.querySelector('.dn-banker-keep-btn');
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
});
if (keepClicked) {
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: 'dist/dn-banker-decided.png' });
  console.log('已截取续庄后的庄家操作区');
}

await browser.close();
console.log('截图完成');
