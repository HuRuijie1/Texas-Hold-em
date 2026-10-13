// 浏览器端冒烟：大厅选「斗牛」→ 选庄家模式 → 建房 → 加机器人 → 开局 → 盲注 → 庄家操作 → 检查渲染与控制台报错
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
await page.setViewport({ width: 1280, height: 900 });

const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});

await page.goto(URL, { waitUntil: 'networkidle2' });
await page.type('#playerName', 'UI房主');
await page.evaluate(() => {
  document.querySelector('input[name="gameType"][value="dn"]').click();
});

const dnRowVisible = await page.evaluate(() => {
  const row = document.getElementById('dnConfigRow');
  const gdy = document.getElementById('gdyConfigRow');
  return !row.classList.contains('hidden') && gdy.classList.contains('hidden');
});
console.log('斗牛配置项可见:', dnRowVisible);

// 庄家模式下拉：确认两个选项存在，并按 DN_MODE 选中
const modeSelect = await page.evaluate(() => ({
  exists: Boolean(document.getElementById('dnBankerMode')),
  options: [...(document.getElementById('dnBankerMode')?.options ?? [])].map((o) => o.value),
}));
console.log('庄家模式选项:', JSON.stringify(modeSelect.options), modeSelect.exists ? '✓' : '✗');
await page.select('#dnBankerMode', MODE);

// 无庄模式：倍数/封顶/时限字段应隐藏且禁用
const fieldState = await page.evaluate(() => {
  const check = (id) => {
    const wrapper = document.getElementById(id);
    const input = wrapper?.querySelector('input');
    return { hidden: Boolean(wrapper?.classList.contains('hidden')), disabled: Boolean(input?.disabled) };
  };
  return {
    maxBetMult: check('dnMaxBetMultField'),
    scoreCap: check('dnScoreCapField'),
    actionTimeout: check('dnActionTimeoutField'),
  };
});
console.log('无庄字段联动:', JSON.stringify(fieldState),
  MODE === 'none'
    ? (fieldState.maxBetMult.hidden && fieldState.maxBetMult.disabled ? '✓ 已隐藏并禁用' : '✗ 未正确隐藏')
    : '✓ 有庄模式保持可见');

await page.click('#createRoomBtn');
await page.waitForSelector('#tableView:not(.hidden)', { timeout: 8000 });
console.log('已进入牌桌，模式:', MODE);

await page.evaluate(() => {
  document.getElementById('botLevelSelect').value = 'intermediate';
});
await page.click('#addBotBtn');
await new Promise((r) => setTimeout(r, 500));
await page.click('#addBotBtn');
await new Promise((r) => setTimeout(r, 500));
await page.click('#startHandBtn');

const waitFor = async (fn, timeout = 40000, label = '条件') => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate(fn)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`等待${label}超时`);
  return false;
};

// 有庄模式等轮到房主；无庄模式开局即结算，直接等结算弹窗
if (MODE === 'banker') {
  await waitFor(() => {
    const buttons = document.querySelectorAll('#actionPanel button').length > 0;
    const finished = !document.getElementById('handEndModal').classList.contains('hidden');
    return buttons || finished;
  }, 40000, '房主行动按钮');
} else {
  await waitFor(() => !document.getElementById('handEndModal').classList.contains('hidden'), 40000, '无庄结算');
}

const snapshot = await page.evaluate(() => ({
  seats: document.querySelectorAll('#seatGrid .seat').length,
  viewerCards: document.querySelectorAll('#viewerCards .card').length,
  infoText: document.getElementById('dnInfoText')?.textContent ?? '',
  pot: document.getElementById('pot')?.textContent ?? '',
  actionButtons: [...document.querySelectorAll('#actionPanel button')].map((b) => b.textContent),
  actionHint: document.getElementById('actionPanel')?.textContent?.slice(0, 60) ?? '',
  infoHidden: document.getElementById('dnInfo')?.classList.contains('hidden'),
}));
console.log('座位数量:', snapshot.seats);
console.log('我的手牌张数:', snapshot.viewerCards, MODE === 'banker' ? '（下注阶段应为 0）' : '（无庄应立即为 5）');
console.log('信息条:', snapshot.infoHidden ? '(隐藏)' : snapshot.infoText);
console.log('底池区:', snapshot.pot);
console.log('操作按钮:', JSON.stringify(snapshot.actionButtons));
console.log('操作区提示:', snapshot.actionHint.replace(/\s+/g, ' ').trim());

// 点击盲注按钮推进牌局（有庄模式）
const clicked = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('#actionPanel button')];
  const target = buttons.find((b) => /^盲注\s*×/.test(b.textContent));
  if (!target) return null;
  const text = target.textContent;
  target.click();
  return text;
});
if (clicked) console.log('已点击动作:', clicked);
else console.log('无可点击动作（我是庄家或无庄模式）');

// 本轮牌局结束
await waitFor(() => !document.getElementById('handEndModal').classList.contains('hidden'), 60000, '本局结束');
await new Promise((r) => setTimeout(r, 1500));

const finished = await page.evaluate(() => ({
  modalOpen: !document.getElementById('handEndModal').classList.contains('hidden'),
  results: document.getElementById('modalResults')?.textContent?.slice(0, 400) ?? '',
  seatLabels: [...document.querySelectorAll('.dn-hand-label')].map((el) => el.textContent),
  viewerCards: document.querySelectorAll('#viewerCards .card').length,
  // 庄家操作区：弹窗内 + 牌桌顶部
  modalBankerVisible: !document.getElementById('dnBankerModalControl')?.classList.contains('hidden'),
  modalBankerText: document.getElementById('dnBankerModalControl')?.textContent?.slice(0, 120) ?? '',
  tableBankerVisible: !document.getElementById('dnBankerTableControl')?.classList.contains('hidden'),
  tableBankerText: document.getElementById('dnBankerTableControl')?.textContent?.slice(0, 120) ?? '',
  hasKeepBtn: Boolean(document.querySelector('.dn-banker-keep-btn')),
  hasTransferBtn: Boolean(document.querySelector('.dn-banker-transfer-btn')),
  hasTargetSelect: Boolean(document.querySelector('.dn-banker-target')),
  nextBankerBadge: [...document.querySelectorAll('.dn-next-banker')].map((el) => el.textContent),
}));
console.log('结算弹窗:', finished.modalOpen);
console.log('结算内容:', finished.results.replace(/\s+/g, ' ').trim());
console.log('座位牌型标签:', JSON.stringify(finished.seatLabels));
console.log('我的手牌张数(结算后):', finished.viewerCards);
console.log('庄家操作区-弹窗:', finished.modalBankerVisible ? `可见「${finished.modalBankerText.trim()}」` : '隐藏');
console.log('庄家操作区-顶部:', finished.tableBankerVisible ? `可见「${finished.tableBankerText.trim()}」` : '隐藏');
console.log('续庄/移交按钮:', finished.hasKeepBtn ? '续庄✓' : '', finished.hasTransferBtn ? '移交✓' : '', finished.hasTargetSelect ? '候选下拉✓' : '');
console.log('下局庄徽章:', JSON.stringify(finished.nextBankerBadge));

// 有庄模式且我是庄家 → 实际点一次续庄，验证决定文案
if (finished.hasKeepBtn) {
  await page.evaluate(() => document.querySelector('.dn-banker-keep-btn')?.click());
  await new Promise((r) => setTimeout(r, 1500));
  const decided = await page.evaluate(() => ({
    modal: document.getElementById('dnBankerModalControl')?.textContent?.slice(0, 120) ?? '',
    table: document.getElementById('dnBankerTableControl')?.textContent?.slice(0, 120) ?? '',
  }));
  console.log('点击续庄后 → 弹窗:', decided.modal.trim(), '| 顶部:', decided.table.trim());
}

console.log('控制台错误数:', errors.length);
if (errors.length) console.log(errors.slice(0, 10).join('\n'));

await browser.close();
process.exitCode = errors.length ? 1 : 0;
