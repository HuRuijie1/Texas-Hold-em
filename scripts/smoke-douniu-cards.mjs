// 校验斗牛手牌可见性时序：
//   有庄模式：下注阶段应为 0 张（未发牌）→ 盲注 → 全员决定后发 5 张 → 点击查看翻开
//   无庄模式（DN_MODE=none）：开局即自动发牌，立刻 5 张
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
await page.setViewport({ width: 1280, height: 940 });
await page.goto(URL, { waitUntil: 'networkidle2' });
await page.type('#playerName', '查牌员');
await page.evaluate(() => document.querySelector('input[name="gameType"][value="dn"]').click());
await page.select('#dnBankerMode', MODE);
await page.click('#createRoomBtn');
await page.waitForSelector('#tableView:not(.hidden)', { timeout: 8000 });
await page.click('#addBotBtn');
await new Promise((r) => setTimeout(r, 400));
await page.click('#startHandBtn');

const readCards = () => page.evaluate(() => ({
  count: document.querySelectorAll('#viewerCards .card').length,
  faces: [...document.querySelectorAll('#viewerCards .card')].map((el) => ({
    isBack: el.classList.contains('back'),
    rank: el.querySelector('.rank')?.textContent ?? '',
  })),
  peekBtnText: document.getElementById('peekCardsBtn')?.textContent ?? '',
  text: document.getElementById('viewerCards')?.textContent ?? '',
}));

const waitFor = async (fn, timeout, label) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate(fn)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`等待${label}超时`);
  return false;
};

if (MODE === 'banker') {
  // 发牌前：必须 0 张手牌
  const before = await readCards();
  console.log('下注阶段手牌张数:', before.count, before.count === 0 ? '（✓ 发牌前不发牌）' : '（✗ 应为 0）', '文案:', before.text.trim());
  // 轮到房主就盲注，否则等机器人推进
  await waitFor(() => {
    const buttons = [...document.querySelectorAll('#actionPanel button')];
    const target = buttons.find((b) => /^盲注\s*×/.test(b.textContent));
    if (target) { target.click(); return false; }
    return !document.getElementById('handEndModal').classList.contains('hidden');
  }, 40000, '本局结束');
} else {
  await waitFor(() => !document.getElementById('handEndModal').classList.contains('hidden'), 40000, '无庄结算');
}

// 等发牌完成（最多 40s，机器人在决策）
await waitFor(() => document.querySelectorAll('#viewerCards .card').length === 5, 40000, '发牌');
const after = await readCards();
console.log('发牌后（默认）：', JSON.stringify(after.faces), after.count === 5 ? '（✓ 5 张）' : '（✗ 未拿到 5 张）');
console.log('查看按钮文案:', after.peekBtnText);

await page.evaluate(() => document.getElementById('peekCardsBtn')?.click());
await new Promise((r) => setTimeout(r, 1200));
const peeked = await readCards();
console.log('点击查看后：', JSON.stringify(peeked.faces), '按钮:', peeked.peekBtnText);
const allFaceUp = peeked.faces.length === 5 && peeked.faces.every((f) => !f.isBack && f.rank);
console.log('5 张全部正面:', allFaceUp ? '✓' : '✗');

await new Promise((r) => setTimeout(r, 4000));
const later = await readCards();
const stillFaceUp = later.faces.length === 5 && later.faces.every((f) => !f.isBack && f.rank);
console.log('数秒后仍为正面:', stillFaceUp ? '✓' : '✗');

await browser.close();
