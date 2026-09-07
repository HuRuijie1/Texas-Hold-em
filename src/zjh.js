import { createDeck, shuffleDeck, formatCard, formatCards } from './poker.js';

// 炸金花牌型类别（数值越大越大）：
// 5 豹子 / 4 顺金 / 3 金花 / 2 顺子 / 1 对子 / 0 散牌
export const ZJH_CATEGORY = {
  SAN_PAI: 0,
  DUI_ZI: 1,
  SHUN_ZI: 2,
  JIN_HUA: 3,
  SHUN_JIN: 4,
  BAO_ZI: 5,
};

export const ZJH_CATEGORY_NAME = {
  0: '散牌',
  1: '对子',
  2: '顺子',
  3: '金花',
  4: '顺金',
  5: '豹子',
};

// 复用德州扑克的 52 张标准牌：牌面 "RS"（R=2..T,J,Q,K,A；S=S,H,D,C）
export function createZjhDeck() {
  return shuffleDeck(createDeck());
}

function zjhRankValue(card) {
  const value = card.charCodeAt(0);
  if (value >= 50 && value <= 57) return value - 48; // '2'..'9' → 2..9
  if (card[0] === 'T') return 10;
  if (card[0] === 'J') return 11;
  if (card[0] === 'Q') return 12;
  if (card[0] === 'K') return 13;
  if (card[0] === 'A') return 14;
  return 0;
}

function zjhCardSuit(card) {
  return card[1];
}

// 计算三张牌的顺子最高牌；A23 视为最小顺（高牌 3），AKQ 最大（高牌 14）
function straightHigh(values) {
  const uniq = [...new Set(values)].sort((a, b) => a - b);
  if (uniq.length !== 3) return null;
  const [low, mid, high] = uniq;
  if (high - mid === 1 && mid - low === 1) return high;
  if (low === 2 && mid === 3 && high === 14) return 3; // A23 轮子顺
  return null;
}

// 评估三张手牌，返回 { category, kickers, cards }
// kickers 语义按类别：
//   豹子   [点数]
//   顺金/顺子 [顺子高牌]
//   金花/散牌 [第1大, 第2大, 第3大]
//   对子   [对子点数, 单张点数]
export function evaluateZjhHand(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) {
    throw new Error('炸金花手牌必须为 3 张');
  }
  const values = cards.map(zjhRankValue).sort((a, b) => b - a);
  const suits = cards.map(zjhCardSuit);
  const isFlush = suits[0] === suits[1] && suits[1] === suits[2];
  const straight = straightHigh(values);

  if (values[0] === values[1] && values[1] === values[2]) {
    return { category: ZJH_CATEGORY.BAO_ZI, kickers: [values[0]], cards };
  }
  if (isFlush && straight !== null) {
    return { category: ZJH_CATEGORY.SHUN_JIN, kickers: [straight], cards };
  }
  if (isFlush) {
    return { category: ZJH_CATEGORY.JIN_HUA, kickers: values, cards };
  }
  if (straight !== null) {
    return { category: ZJH_CATEGORY.SHUN_ZI, kickers: [straight], cards };
  }
  if (values[0] === values[1] || values[1] === values[2]) {
    const pair = values[0] === values[1] ? values[0] : values[1];
    const kicker = values[0] === values[1] ? values[2] : values[0];
    return { category: ZJH_CATEGORY.DUI_ZI, kickers: [pair, kicker], cards };
  }
  return { category: ZJH_CATEGORY.SAN_PAI, kickers: values, cards };
}

// 比较 a 与 b：>0 a 大，<0 b 大，0 平
export function compareZjhHands(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const length = Math.max(a.kickers.length, b.kickers.length);
  for (let i = 0; i < length; i += 1) {
    const left = a.kickers[i] ?? 0;
    const right = b.kickers[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

export function zjhRankToFace(value) {
  if (value === 14) return 'A';
  if (value === 13) return 'K';
  if (value === 12) return 'Q';
  if (value === 11) return 'J';
  if (value === 10) return '10';
  return String(value);
}

// 中文描述，如 "豹子 A"、"顺金 A高"、"金花 K高"、"顺子 Q高"、"对子 9"、"散牌 A高"
export function describeZjhHand(rank) {
  if (!rank) return '';
  const name = ZJH_CATEGORY_NAME[rank.category] ?? '牌型';
  const [first, second] = rank.kickers;
  switch (rank.category) {
    case ZJH_CATEGORY.BAO_ZI:
      return `${name} ${zjhRankToFace(first)}${zjhRankToFace(first)}${zjhRankToFace(first)}`;
    case ZJH_CATEGORY.SHUN_JIN:
    case ZJH_CATEGORY.SHUN_ZI:
      return `${name} ${zjhRankToFace(first)}高`;
    case ZJH_CATEGORY.JIN_HUA:
      return `${name} ${zjhRankToFace(first)}高`;
    case ZJH_CATEGORY.DUI_ZI:
      return `${name} ${zjhRankToFace(first)}带${zjhRankToFace(second)}`;
    default:
      return `${name} ${zjhRankToFace(first)}高`;
  }
}

export { formatCard, formatCards };
