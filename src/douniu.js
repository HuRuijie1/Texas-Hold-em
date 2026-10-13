import { createDeck, shuffleDeck } from './poker.js';

// ===== 斗牛（牛牛）纯牌型逻辑 =====
// 牌表示沿用德州扑克的 52 张标准牌 "RS"（R=2..9,T,J,Q,K,A；S=S,H,D,C）。
//
// 点数（用于凑牛）：A=1，2~10 为面值，J/Q/K=10
// 比牌大小：K>Q>J>10>9>...>2>A（A 最小），同点比花色 黑桃>红桃>梅花>方块
//
// 牌型由大到小：
//   五小牛(13) > 炸弹(12) > 五花牛(11) > 牛牛(10) > 牛9(9) > ... > 牛1(1) > 无牛(0)
// 牌型倍数（决定输赢倍率）：
//   无牛/牛1~牛6 = 1 倍，牛7~牛9 = 2 倍，牛牛 = 3 倍，五花牛 = 5 倍，炸弹 = 6 倍，五小牛 = 7 倍

export const DN_CATEGORY = {
  NONE: 0,
  NIU_NIU: 10,
  WU_HUA: 11,
  BOMB: 12,
  WU_XIAO: 13,
};

// 牌型倍数表（键为牌型值）
export const DN_MULTIPLIER = {
  0: 1,
  1: 1,
  2: 1,
  3: 1,
  4: 1,
  5: 1,
  6: 1,
  7: 2,
  8: 2,
  9: 2,
  10: 3,
  11: 5,
  12: 6,
  13: 7,
};

export function dnCategoryName(category) {
  if (category === DN_CATEGORY.NONE) return '无牛';
  if (category === DN_CATEGORY.NIU_NIU) return '牛牛';
  if (category === DN_CATEGORY.WU_HUA) return '五花牛';
  if (category === DN_CATEGORY.BOMB) return '炸弹';
  if (category === DN_CATEGORY.WU_XIAO) return '五小牛';
  if (category >= 1 && category <= 9) return `牛${category}`;
  return '未知牌型';
}

export const DN_CATEGORY_NAME = Object.fromEntries(
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((value) => [value, dnCategoryName(value)]),
);

// 花色大小：黑桃 > 红桃 > 梅花 > 方块
const DN_SUIT_ORDER = { S: 4, H: 3, C: 2, D: 1 };

export function createDnDeck() {
  return shuffleDeck(createDeck());
}

// 计分点数：A=1，J/Q/K/T=10，2~9 为面值
export function dnCardPoints(card) {
  const rank = card?.[0];
  if (rank === 'A') return 1;
  if (rank === 'T' || rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  const numeric = Number(rank);
  return Number.isFinite(numeric) ? numeric : 0;
}

// 比牌点数：A=1 最小，K=13 最大
export function dnCardRank(card) {
  const rank = card?.[0];
  if (rank === 'A') return 1;
  if (rank === 'T') return 10;
  if (rank === 'J') return 11;
  if (rank === 'Q') return 12;
  if (rank === 'K') return 13;
  const numeric = Number(rank);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function dnSuitOrder(card) {
  return DN_SUIT_ORDER[card?.[1]] ?? 0;
}

export function dnRankFace(value) {
  if (value === 1) return 'A';
  if (value === 10) return '10';
  if (value === 11) return 'J';
  if (value === 12) return 'Q';
  if (value === 13) return 'K';
  return String(value ?? '');
}

// 一张牌的排序权重（先比点数，再比花色）
function cardWeight(card) {
  return dnCardRank(card) * 10 + dnSuitOrder(card);
}

// 手中最大的一张牌（同点时取花色大的）
function maxCardOf(cards) {
  let best = cards[0];
  for (const card of cards.slice(1)) {
    if (cardWeight(card) > cardWeight(best)) best = card;
  }
  return best;
}

// 5 选 3 的全部组合下标
const TRIPLE_INDICES = [
  [0, 1, 2], [0, 1, 3], [0, 1, 4], [0, 2, 3], [0, 2, 4], [0, 3, 4],
  [1, 2, 3], [1, 2, 4], [1, 3, 4], [2, 3, 4],
];

// 统一的牌型结果构造：category 决定倍数，其余为展示与比较字段
function buildDnRank(cards, category, { niu = 0, bombRank = null, bullCards = null, niuCards = null } = {}) {
  const top = maxCardOf(cards);
  return {
    category,
    niu,
    mult: DN_MULTIPLIER[category] ?? 1,
    maxCard: top,
    maxRank: dnCardRank(top),
    maxSuit: dnSuitOrder(top),
    bombRank,
    bullCards: bullCards ? [...bullCards] : null,
    niuCards: niuCards ? [...niuCards] : null,
    cards: [...cards],
  };
}

// 特殊牌型（五小牛 / 炸弹 / 五花牛）与选哪三张无关，由整手牌直接决定
export function dnSpecialRank(cards) {
  const points = cards.map(dnCardPoints);
  const total = points.reduce((sum, value) => sum + value, 0);
  if (total < 10) {
    return buildDnRank(cards, DN_CATEGORY.WU_XIAO);
  }
  const rankCounts = new Map();
  for (const card of cards) {
    const rank = dnCardRank(card);
    rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1);
  }
  for (const [rank, count] of rankCounts) {
    if (count === 4) {
      return buildDnRank(cards, DN_CATEGORY.BOMB, { bombRank: rank });
    }
  }
  if (cards.every((card) => card[0] === 'J' || card[0] === 'Q' || card[0] === 'K')) {
    return buildDnRank(cards, DN_CATEGORY.WU_HUA, { niu: 10 });
  }
  return null;
}

// 所有「凑得成整十」的三张组合（返回牌面数组，牌在一副牌内唯一）
export function dnBullCandidates(cards) {
  const points = cards.map(dnCardPoints);
  const combos = [];
  for (const [i, j, k] of TRIPLE_INDICES) {
    if ((points[i] + points[j] + points[k]) % 10 === 0) {
      combos.push([cards[i], cards[j], cards[k]]);
    }
  }
  return combos;
}

// 一副牌里「牛数最大」的选牌方案（提示 / 机器人 / 超时托管用）
// 返回 { bull: [3], rest: [2], niu }；无解返回 null
export function dnBestBullPick(cards) {
  const points = cards.map(dnCardPoints);
  let best = null;
  for (const [i, j, k] of TRIPLE_INDICES) {
    if ((points[i] + points[j] + points[k]) % 10 !== 0) continue;
    const rest = [0, 1, 2, 3, 4].filter((index) => index !== i && index !== j && index !== k);
    const restSum = points[rest[0]] + points[rest[1]];
    const niu = restSum % 10 === 0 ? 10 : restSum % 10;
    // 牛数相同时，比剩余两张的强度（点数 + 花色），保证结果稳定
    const restStrength = cardWeight(cards[rest[0]]) + cardWeight(cards[rest[1]]);
    const candidate = {
      bull: [cards[i], cards[j], cards[k]],
      rest: [cards[rest[0]], cards[rest[1]]],
      niu,
      restStrength,
    };
    if (!best || candidate.niu > best.niu
      || (candidate.niu === best.niu && candidate.restStrength > best.restStrength)) {
      best = candidate;
    }
  }
  return best;
}

// 按玩家「亲手选的三张牛牌」评估牌型（欢乐斗牛式互动）
//   cards     5 张手牌
//   bullCards 玩家选的三张；null/[] 表示玩家选择「没牛」
// 规则：特殊牌型（五小牛/炸弹/五花牛）优先于选牌结果；选牌不合法时按无牛结算
export function evaluateDnPick(cards, bullCards) {
  if (!Array.isArray(cards) || cards.length !== 5) {
    throw new Error('斗牛手牌必须为 5 张');
  }
  const special = dnSpecialRank(cards);
  if (special) return special;

  if (!Array.isArray(bullCards) || bullCards.length !== 3) {
    return buildDnRank(cards, DN_CATEGORY.NONE);
  }
  const bullPoints = bullCards.map(dnCardPoints);
  const bullSum = bullPoints.reduce((sum, value) => sum + value, 0);
  if (bullSum % 10 !== 0) {
    // 非法选牌：保守按无牛结算（服务端会先行校验，正常不会走到这里）
    return buildDnRank(cards, DN_CATEGORY.NONE);
  }
  const bullSet = new Set(bullCards);
  const rest = cards.filter((card) => !bullSet.has(card));
  const restSum = rest.reduce((sum, card) => sum + dnCardPoints(card), 0);
  const niu = restSum % 10 === 0 ? 10 : restSum % 10;
  return buildDnRank(cards, niu, { niu, bullCards, niuCards: rest });
}

// 自动评估（取牛数最大的方案），用于测试与「未选牌」兜底
export function evaluateDnHand(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) {
    throw new Error('斗牛手牌必须为 5 张');
  }
  const special = dnSpecialRank(cards);
  if (special) return special;

  const best = dnBestBullPick(cards);
  if (!best) {
    return buildDnRank(cards, DN_CATEGORY.NONE);
  }
  return buildDnRank(cards, best.niu, { niu: best.niu, bullCards: best.bull, niuCards: best.rest });
}

// 比较两手牌：>0 a 大，<0 b 大，0 平（同型同最大牌时按花色仍可区分，故几乎不会为 0）
export function compareDnHands(a, b) {
  if (!a || !b) return 0;
  if (a.category !== b.category) return a.category - b.category;

  // 炸弹：比四张同点的点数
  if (a.category === DN_CATEGORY.BOMB) return a.bombRank - b.bombRank;

  // 其余牌型：比最大牌点数，再比最大牌花色
  if (a.maxRank !== b.maxRank) return a.maxRank - b.maxRank;
  return a.maxSuit - b.maxSuit;
}

// 中文描述，如 "牛牛 K高"、"牛7 Q高"、"无牛 A高"、"炸弹 K"、"五花牛"、"五小牛 A高"
export function describeDnHand(rank) {
  if (!rank) return '';
  const name = dnCategoryName(rank.category);
  if (rank.category === DN_CATEGORY.BOMB) {
    return `${name} ${dnRankFace(rank.bombRank)}`;
  }
  if (rank.category === DN_CATEGORY.WU_HUA) return name;
  return `${name} ${dnRankFace(rank.maxRank)}高`;
}

// 牌力估值（0~1）。盲注阶段机器人看不到手牌，不使用本函数；仅供测试与外部参考
export function estimateDnStrength(holeCards) {
  if (!Array.isArray(holeCards) || holeCards.length !== 5 || holeCards.some((card) => card === '??' || !card)) {
    return 0.35;
  }
  const rank = evaluateDnHand(holeCards);
  // 特殊牌型直接给高分
  if (rank.category >= DN_CATEGORY.WU_HUA) {
    return Math.min(0.99, 0.88 + (rank.category - DN_CATEGORY.WU_HUA + 1) * 0.04);
  }
  if (rank.category === DN_CATEGORY.NONE) {
    // 无牛：最大牌点数越高略强，但整体仍是弱牌
    return 0.06 + (rank.maxRank / 13) * 0.12;
  }
  // 牛1~牛牛：牛1 约 0.22，牛9 约 0.78，牛牛 0.86
  const niuBase = 0.16 + (rank.niu / 10) * 0.62;
  const kicker = (rank.maxRank / 13) * 0.08;
  return Math.min(0.87, niuBase + kicker);
}
