// 专项冒烟：斗牛「选 3 张牛牌 / 没牛」互动 + 大手牌整行展示
// 支持 DN_MODE=none；默认有庄
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
await page.setViewport({ width: 1280, height: 900 });

const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});

await page.goto(URL, { waitUntil: 'networkidle2' });
await page.type('#playerName', '选牌员');
await page.evaluate(() => document.querySelector('input[name="gameType"][value="dn"]').click());
await page.select('#dnBankerMode', MODE);
await page.click('#createRoomBtn');
await page.waitForSelector('#tableView:not(.hidden)', { timeout: 8000 });
await page.click('#addBotBtn');
await new Promise((r) => setTimeout(r, 400));
await page.click('#startHandBtn');

const waitFor = async (fn, timeout, label) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate(fn)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`等待${label}超时`);
  return false;
};

// 等到发牌 + 轮到我选牌
await waitFor(() => {
  const cards = document.querySelectorAll('#viewerCards .card').length;
  const hasPick = [...document.querySelectorAll('#actionPanel button')].some((b) => b.textContent === '确定');
  const noBull = [...document.querySelectorAll('#actionPanel button')].some((b) => b.textContent === '没牛');
  return cards === 5 && (hasPick || noBull);
}, 60000, '选牌阶段');

// 手牌应整行排开且尺寸够大
const layout = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('#viewerCards .card')];
  const rects = cards.map((el) => el.getBoundingClientRect());
  const sameRow = rects.every((r) => Math.abs(r.top - rects[0].top) < 4);
  return {
    count: cards.length,
    width: Math.round(rects[0]?.width ?? 0),
    height: Math.round(rects[0]?.height ?? 0),
    sameRow,
    containerWidth: Math.round(document.getElementById('viewerCards').getBoundingClientRect().width),
  };
});
console.log('手牌布局:', JSON.stringify(layout),
  layout.count === 5 && layout.sameRow && layout.width >= 46 ? '✓ 整行且够大' : '✗');

// 点击第一张牌 → 应出现选中态
await page.evaluate(() => document.querySelectorAll('#viewerCards .card')[0].click());
await new Promise((r) => setTimeout(r, 300));
const afterOne = await page.evaluate(() => ({
  selected: document.querySelectorAll('#viewerCards .card.selected').length,
  status: document.querySelector('.dn-pick-status')?.textContent ?? '',
  okDisabled: [...document.querySelectorAll('#actionPanel button')].find((b) => b.textContent === '确定')?.disabled,
}));
console.log('选 1 张:', JSON.stringify(afterOne), afterOne.selected === 1 ? '✓' : '✗');

// 再选两张（第 2、3 张）
await page.evaluate(() => {
  const cards = document.querySelectorAll('#viewerCards .card');
  cards[1].click(); cards[2].click();
});
await new Promise((r) => setTimeout(r, 300));
const afterThree = await page.evaluate(() => ({
  selected: document.querySelectorAll('#viewerCards .card.selected').length,
  status: document.querySelector('.dn-pick-status')?.textContent ?? '',
  okDisabled: [...document.querySelectorAll('#actionPanel button')].find((b) => b.textContent === '确定')?.disabled,
}));
console.log('选 3 张:', JSON.stringify(afterThree));

// 点「提示」→ 自动挑一组合法组合，确定按钮应可用
const hintWorked = await page.evaluate(() => {
  const hint = [...document.querySelectorAll('#actionPanel button')].find((b) => b.textContent === '提示');
  if (!hint) return null;
  hint.click();
  return true;
});
await new Promise((r) => setTimeout(r, 400));
const afterHint = await page.evaluate(() => ({
  selected: document.querySelectorAll('#viewerCards .card.selected').length,
  okDisabled: [...document.querySelectorAll('#actionPanel button')].find((b) => b.textContent === '确定')?.disabled,
  status: document.querySelector('.dn-pick-status')?.textContent ?? '',
}));
console.log('点击提示后:', JSON.stringify(afterHint),
  hintWorked && afterHint.selected === 3 && afterHint.okDisabled === false ? '✓ 自动凑成整十' : '(可能本就无牛)');

// 确定选牌；无合法组合时点「没牛」
if (afterHint.okDisabled === false) {
  await page.evaluate(() => {
    const ok = [...document.querySelectorAll('#actionPanel button')].find((b) => b.textContent === '确定');
    ok?.click();
  });
} else {
  const noBullClicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#actionPanel button')].find((b) => b.textContent === '没牛');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  });
  console.log('点击「没牛」:', noBullClicked ? '✓' : '✗');
}
await new Promise((r) => setTimeout(r, 600));
const afterSubmit = await page.evaluate(() => ({
  handLabel: [...document.querySelectorAll('.dn-hand-label')].map((el) => el.textContent),
  bullCards: document.querySelectorAll('#viewerCards .card.bull').length,
  actionHint: document.getElementById('actionPanel')?.textContent?.slice(0, 40) ?? '',
}));
console.log('提交选牌后:', JSON.stringify(afterSubmit));

// 推进到结算
await waitFor(() => !document.getElementById('handEndModal').classList.contains('hidden'), 60000, '结算');
await new Promise((r) => setTimeout(r, 1200));
const settled = await page.evaluate(() => ({
  results: document.getElementById('modalResults')?.textContent?.slice(0, 260) ?? '',
  bullHighlight: document.querySelectorAll('.dn-bull-card').length,
  viewerCards: document.querySelectorAll('#viewerCards .card').length,
}));
console.log('结算内容:', settled.results.replace(/\s+/g, ' ').trim());
console.log('牛牌高亮数:', settled.bullHighlight, '我的手牌:', settled.viewerCards);
console.log('控制台错误数:', errors.length);
if (errors.length) console.log(errors.slice(0, 10).join('\n'));

await browser.close();
process.exitCode = errors.length ? 1 : 0;
