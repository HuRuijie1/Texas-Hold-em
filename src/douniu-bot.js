import { dnBestBullPick } from './douniu.js';
import { normalizeBotLevel } from './legacy-bot-levels.js';

export { dnBestBullPick };

// ============================================================
// 斗牛机器人
//
// 关键约束：新规则下「闲家下注在发牌前完成」，机器人看不到自己的牌，
// 因此盲注倍数不能由牌力决定，只能由难度、筹码承受力与随机性决定。
// ============================================================

// base 为偏好倍数，foldRate 为放弃概率，spread 为倍数抖动幅度
const THRESHOLDS = {
  beginner: { base: 1.4, foldRate: 0.14, spread: 0.5, delay: [500, 1100] },
  intermediate: { base: 2.2, foldRate: 0.08, spread: 0.9, delay: [450, 1000] },
  advanced: { base: 3.0, foldRate: 0.04, spread: 1.2, delay: [400, 900] },
};

function pickThreshold(level) {
  return THRESHOLDS[normalizeBotLevel(level)] ?? THRESHOLDS.beginner;
}

function randomDelay(threshold) {
  const [min, max] = threshold.delay;
  return min + Math.random() * (max - min);
}

// 牌局最坏赔付不会超过「底分 × 倍数 × 最大牌型倍数(7)」，据此估算可承受倍数
function affordableMult(player, actions) {
  const options = (actions?.betOptions ?? [1]).filter((value) => Number.isFinite(value));
  const minMult = options.length ? Math.min(...options) : 1;
  const baseStake = Math.max(1, actions?.baseStake ?? 1);
  return Math.max(minMult, Math.floor(player.stack / (baseStake * 7)));
}

// 盲注决策：看不到手牌，按难度与自身筹码承受力挑倍数
function decideBlindBet(player, actions, threshold) {
  const options = (actions?.betOptions ?? [1]).filter((value) => Number.isFinite(value));
  if (!options.length) {
    return { action: { type: 'pass' }, delayMs: randomDelay(threshold) };
  }
  const maxMult = Math.max(...options);
  const minMult = Math.min(...options);

  if (Math.random() < threshold.foldRate) {
    return { action: { type: 'pass' }, delayMs: randomDelay(threshold) };
  }

  const jitter = (Math.random() * 2 - 1) * threshold.spread;
  let mult = Math.round(threshold.base + jitter);
  mult = Math.max(minMult, Math.min(mult, Math.min(maxMult, affordableMult(player, actions))));
  if (!options.includes(mult)) {
    // 落到最接近的合法档位
    mult = options.reduce((best, value) => (
      Math.abs(value - mult) < Math.abs(best - mult) ? value : best
    ), options[0]);
  }
  return { action: { type: 'bet', amount: mult }, delayMs: randomDelay(threshold) };
}

export function decideDnBotTurn(room, player, actions) {
  const threshold = pickThreshold(player.botLevel);
  const decision = actions?.phase === 'bet'
    ? decideBlindBet(player, actions, threshold)
    : { action: { type: 'pass' }, delayMs: randomDelay(threshold) };
  return {
    action: decision.action,
    delayMs: Math.max(300, Math.min(3500, Math.round(decision.delayMs))),
  };
}

// 选牛牌阶段：机器人从自己手牌里挑三张凑整十
// 低难度机器人偶尔"看走眼"按没牛结算，让牌局更真实
function decideBotPick(player) {
  const threshold = pickThreshold(player.botLevel);
  const best = dnBestBullPick(player.holeCards ?? []);
  if (!best) {
    return { action: { type: 'nobull' }, delayMs: randomDelay(threshold) };
  }
  const misplayRate = { beginner: 0.18, intermediate: 0.06, advanced: 0 }[normalizeBotLevel(player.botLevel)] ?? 0;
  if (Math.random() < misplayRate) {
    return { action: { type: 'nobull' }, delayMs: randomDelay(threshold) };
  }
  return { action: { type: 'pick', cards: best.bull }, delayMs: randomDelay(threshold) };
}

export function decideDnBotPick(room, player) {
  const decision = decideBotPick(player);
  return {
    action: decision.action,
    delayMs: Math.max(300, Math.min(3500, Math.round(decision.delayMs))),
  };
}

// 机器人庄家在牌局结束后决定续庄 / 移交
// - 破产、离座、暂离：只要有合法候选就移交，否则保持续庄（开局时会自动回退）
// - 其余默认续庄，难度越高偶尔主动换手
export function decideDnBotBanker(room, banker, candidates = []) {
  const threshold = pickThreshold(banker.botLevel);
  const usable = candidates.filter((player) => (
    player && player.seatIndex !== null && player.stack > 0 && !player.sitOut
  ));
  const unhealthy = banker.stack <= 0 || banker.seatIndex === null || banker.sitOut;

  if (unhealthy && usable.length > 0) {
    const target = usable.reduce((best, player) => (player.stack > best.stack ? player : best), usable[0]);
    return {
      action: 'transfer',
      targetToken: target.token,
      delayMs: 500 + Math.random() * 500,
    };
  }

  // 高级机器人偶尔主动换手，避免一家独庄
  const rotateRate = { beginner: 0, intermediate: 0.05, advanced: 0.12 }[normalizeBotLevel(banker.botLevel)] ?? 0;
  if (usable.length > 0 && Math.random() < rotateRate) {
    const target = usable[Math.floor(Math.random() * usable.length)];
    return {
      action: 'transfer',
      targetToken: target.token,
      delayMs: 600 + Math.random() * 700,
    };
  }

  return { action: 'keep', targetToken: null, delayMs: 500 + Math.random() * 800 };
}


