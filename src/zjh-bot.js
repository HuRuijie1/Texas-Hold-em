import { ZJH_CATEGORY, evaluateZjhHand } from './zjh.js';
import { normalizeBotLevel } from './bot-ai.js';

// 各级别决策阈值
const THRESHOLDS = {
  beginner: { fold: 0.46, raise: 0.76, compare: 0.70, lookRound: 2, raiseRate: 0.5, compareRate: 0.4 },
  intermediate: { fold: 0.4, raise: 0.7, compare: 0.64, lookRound: 2, raiseRate: 0.6, compareRate: 0.5 },
  advanced: { fold: 0.36, raise: 0.66, compare: 0.6, lookRound: 1, raiseRate: 0.68, compareRate: 0.6 },
};

// 看牌后的牌力估值（0~1）
export function estimateZjhStrength(holeCards) {
  if (!Array.isArray(holeCards) || holeCards.length !== 3 || holeCards.some((card) => card === '??')) {
    return 0.35;
  }
  const rank = evaluateZjhHand(holeCards);
  const [first, second, third] = rank.kickers;
  const face = (value) => (value ?? 0) / 14;

  switch (rank.category) {
    case ZJH_CATEGORY.BAO_ZI:
      return 0.99;
    case ZJH_CATEGORY.SHUN_JIN:
      return 0.92 + face(first) * 0.06;
    case ZJH_CATEGORY.JIN_HUA:
      return 0.78 + face(first) * 0.06;
    case ZJH_CATEGORY.SHUN_ZI:
      return 0.7 + face(first) * 0.06;
    case ZJH_CATEGORY.DUI_ZI:
      return 0.5 + face(first) * 0.14;
    default:
      // 散牌：由三张牌点数加权，A 高约 0.5，低牌约 0.15
      return 0.14 + (face(first) * 0.5 + face(second) * 0.3 + face(third) * 0.2) * 0.36;
  }
}

// 未看牌时的决策：早期廉价闷跟，中后期看牌；压力过大时立刻看牌再决定
function decideBlind(room, player, actions, threshold) {
  const round = room.hand?.round ?? 0;
  const pressure = actions.callCost / Math.max(1, player.stack);

  if (round >= threshold.lookRound || pressure > 0.35) {
    return { action: { type: 'look' }, delayMs: 500 + Math.random() * 700 };
  }

  const roll = Math.random();
  if (roll < 0.12 && actions.canRaise) {
    const targetStake = Math.min(
      actions.maxStake,
      Math.max(actions.minStake, actions.currentStake + actions.raiseStep),
    );
    return { action: { type: 'raise', amount: targetStake }, delayMs: 800 + Math.random() * 900 };
  }
  if (roll < 0.2 && actions.canLook) {
    return { action: { type: 'look' }, delayMs: 400 + Math.random() * 600 };
  }
  return { action: { type: 'call' }, delayMs: 400 + Math.random() * 800 };
}

// 看牌后的决策：牌力 + 底池压力 + 级别阈值 → 弃/跟/加/比
function decideSeen(room, player, actions, threshold) {
  const strength = estimateZjhStrength(player.holeCards);
  const round = room.hand?.round ?? 0;
  const pot = Math.max(1, room.hand?.pot ?? 1);
  const pressure = actions.callCost / Math.max(1, player.stack);
  const potOdds = actions.callCost / (pot + actions.callCost);
  const allInCall = actions.callCost >= player.stack;

  // 强牌加注抬单注
  if (actions.canRaise && strength >= threshold.raise && Math.random() < threshold.raiseRate) {
    const jump = Math.max(1, Math.round(1 + Math.random()));
    const targetStake = Math.min(
      actions.maxStake,
      Math.max(actions.minStake, actions.currentStake + actions.raiseStep * jump),
    );
    return { action: { type: 'raise', amount: targetStake }, delayMs: 700 + Math.random() * 1000 };
  }

  // 较强牌发起比牌：优先在对手少或轮数多时终结牌局
  if (actions.canCompare && strength >= threshold.compare && !allInCall) {
    if ((actions.targets.length <= 2 || round >= 2) && Math.random() < threshold.compareRate) {
      const target = actions.targets[Math.floor(Math.random() * actions.targets.length)];
      return { action: { type: 'compare', targetSeat: target.seatIndex }, delayMs: 900 + Math.random() * 1200 };
    }
  }

  // 弱牌弃牌阈值随压力抬升
  const foldLine = threshold.fold + pressure * 0.28;
  if (strength < foldLine && Math.random() < 0.85) {
    return { action: { type: 'fold' }, delayMs: 500 + Math.random() * 900 };
  }

  // 中级以上按底池赔率决定是否用弱牌跟注
  if (strength >= 0.5 && strength < foldLine && strength < potOdds - 0.08 && !allInCall) {
    return { action: { type: 'fold' }, delayMs: 600 + Math.random() * 800 };
  }

  // 需要全下的跟注只在牌力尚可时进行
  if (allInCall && strength < 0.55 && Math.random() < 0.6) {
    return { action: { type: 'fold' }, delayMs: 700 + Math.random() * 900 };
  }

  return { action: { type: 'call' }, delayMs: 450 + Math.random() * 900 };
}

export function decideZjhBotTurn(room, player, actions) {
  const level = normalizeBotLevel(player.botLevel);
  const threshold = THRESHOLDS[level] ?? THRESHOLDS.beginner;
  const decision = actions.canLook
    ? decideBlind(room, player, actions, threshold)
    : decideSeen(room, player, actions, threshold);
  return {
    action: decision.action,
    delayMs: Math.max(300, Math.min(3500, Math.round(decision.delayMs))),
  };
}
