import { createDeck, shuffleDeck } from './poker.js';

// ===== 干瞪眼（癞子版）纯牌型逻辑 =====
// 牌的表示：普通牌沿用德州扑克的 "RS" 格式（R=3..9,T,J,Q,K,A,2；S=S,H,D,C），
// 大小王用 "RJ"（大王）/"BJ"（小王）表示，均为癞子（万能牌）。
// 规则要点：王不能单独出；双王不能直接出，但双王+一张普通牌可作炸弹；
// 点数 3<4<...<A<2（2 为最大普通牌）；顺子/连对最大到 A，2 与王不入顺。

export const GDY_SMALL_JOKER = 'BJ';
export const GDY_BIG_JOKER = 'RJ';
export const GDY_JOKERS = [GDY_SMALL_JOKER, GDY_BIG_JOKER];

export function isGdyJoker(card) {
  return card === GDY_SMALL_JOKER || card === GDY_BIG_JOKER;
}

// 点数值：3..9 → 3..9，T/J/Q/K/A → 10..14，2 → 15；癞子无固有点数返回 0
export function gdyRankValue(card) {
  if (isGdyJoker(card)) return 0;
  const c = card[0];
  if (c >= '3' && c <= '9') return c.charCodeAt(0) - 48;
  if (c === 'T') return 10;
  if (c === 'J') return 11;
  if (c === 'Q') return 12;
  if (c === 'K') return 13;
  if (c === 'A') return 14;
  if (c === '2') return 15;
  return 0;
}

const VALUE_FACE = { 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' };

export function gdyValueFace(value) {
  return VALUE_FACE[value] ?? String(value);
}

export function createGdyDeck() {
  return shuffleDeck([...createDeck(), GDY_SMALL_JOKER, GDY_BIG_JOKER]);
}

export const GDY_SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };

export function formatGdyCard(card) {
  if (card === GDY_BIG_JOKER) return '大王';
  if (card === GDY_SMALL_JOKER) return '小王';
  if (!card) return '';
  return `${gdyValueFace(gdyRankValue(card))}${GDY_SUIT_SYMBOL[card[1]] ?? ''}`;
}

export function formatGdyCards(cards) {
  return (cards ?? []).map(formatGdyCard).join(' ');
}

export const GDY_PLAY_TYPE = {
  SINGLE: 1,
  PAIR: 2,
  STRAIGHT: 3,
  PAIRS: 4,
  BOMB: 5,
};

export const GDY_PLAY_TYPE_NAME = {
  1: '单张',
  2: '对子',
  3: '顺子',
  4: '连对',
  5: '炸弹',
};

// 癞子顺子/连对只允许落在 3..A（3..14）区间
const RUN_MIN = 3;
const RUN_MAX = 14;

function realRanks(reals) {
  return reals.map(gdyRankValue);
}

function ranksInRange(values) {
  return values.every((value) => value >= RUN_MIN && value <= RUN_MAX);
}

// 顺子：n（>=3）张点数连续的单牌；真实牌不得重复、不得含 2，
// 癞子补在窗口内缺失的点数上。返回最高可成的窗口。
function evaluateStraight(values, wilds, size) {
  if (values.length !== new Set(values).size) return null;
  if (!ranksInRange(values) || size > RUN_MAX - RUN_MIN + 1) return null;
  const min = values.length ? Math.min(...values) : RUN_MIN;
  const max = values.length ? Math.max(...values) : RUN_MAX;
  const lo = Math.max(RUN_MIN, max - size + 1);
  if (lo > min) return null;
  const hi = lo + size - 1;
  if (hi > RUN_MAX) return null;
  // 窗口 [lo, hi] 内真实牌占据的点数，其余由癞子补齐，数量必须恰好相等
  const missing = size - values.length;
  if (missing !== wilds) return null;
  return { lo, hi };
}

// 连对：偶数张（>=4），每点恰好一对，点数连续；癞子既可补足半对，也可自组一对
function evaluatePairs(counts, wilds, size) {
  const pairCount = size / 2;
  if (size % 2 !== 0 || pairCount > RUN_MAX - RUN_MIN + 1) return null;
  if (Object.values(counts).some((count) => count > 2)) return null;
  const used = Object.keys(counts).map(Number);
  if (!ranksInRange(used)) return null;
  // 从高位窗口向低尝试，取对出牌者最有利（最大）的窗口
  for (let lo = RUN_MAX - pairCount + 1; lo >= RUN_MIN; lo -= 1) {
    const hi = lo + pairCount - 1;
    let need = 0;
    let ok = true;
    for (let value = lo; value <= hi; value += 1) {
      const count = counts[value] ?? 0;
      if (count > 2) { ok = false; break; }
      need += 2 - count;
    }
    if (!ok) continue;
    if (used.some((value) => value < lo || value > hi)) continue;
    if (need === wilds) return { lo, hi };
  }
  return null;
}

// 评估一组牌构成的最佳牌型（癞子自动按最有利方式取点）；
// 无效组合返回 null。返回 { type, size, rank, wilds, lo, hi }。
export function evaluateGdyPlay(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  if (new Set(cards).size !== cards.length) return null;

  const wilds = cards.filter(isGdyJoker).length;
  const reals = cards.filter((card) => !isGdyJoker(card));
  const values = realRanks(reals);
  const size = cards.length;

  // 单张：不能出癞子
  if (size === 1) {
    if (wilds > 0) return null;
    return { type: GDY_PLAY_TYPE.SINGLE, size: 1, rank: values[0], wilds: 0, lo: values[0], hi: values[0] };
  }

  // 炸弹：三张或四张同点（可含癞子），优先级高于顺子等其他解释
  if ((size === 3 || size === 4) && values.length > 0 && values.every((value) => value === values[0])) {
    return { type: GDY_PLAY_TYPE.BOMB, size, rank: values[0], wilds, lo: values[0], hi: values[0] };
  }

  // 对子：两张同点或一真一癞；双癞子不能直接出
  if (size === 2) {
    if (reals.length === 2) {
      if (values[0] !== values[1]) return null;
      return { type: GDY_PLAY_TYPE.PAIR, size: 2, rank: values[0], wilds: 0, lo: values[0], hi: values[0] };
    }
    if (reals.length === 1) {
      return { type: GDY_PLAY_TYPE.PAIR, size: 2, rank: values[0], wilds: 1, lo: values[0], hi: values[0] };
    }
    return null;
  }

  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;

  if (size % 2 === 0) {
    const run = evaluatePairs(counts, wilds, size);
    if (run) {
      return { type: GDY_PLAY_TYPE.PAIRS, size, rank: run.hi, wilds, lo: run.lo, hi: run.hi };
    }
  }

  const straight = evaluateStraight(values, wilds, size);
  if (straight) {
    return { type: GDY_PLAY_TYPE.STRAIGHT, size, rank: straight.hi, wilds, lo: straight.lo, hi: straight.hi };
  }

  return null;
}

// a 能否压过 b（干瞪眼核心：只能按顺序吃）
// - 炸弹吃一切非炸弹；炸弹之间先比张数（四张炸 > 三张炸），再比点数，同点真牌越多越大
// - 非炸弹必须同牌型、同张数，且点数紧邻大一号（10 只能被 J 吃、对 8 只能被对 9 吃、
//   567 只能被 678 吃）；2 为单张/对子的最大牌，可通吃任意单张/对子（但 2 不吃 2）
export function gdyBeats(a, b) {
  if (!a || !b) return false;
  if (a.type === GDY_PLAY_TYPE.BOMB) {
    if (b.type !== GDY_PLAY_TYPE.BOMB) return true;
    if (a.size !== b.size) return a.size > b.size;
    if (a.rank !== b.rank) return a.rank > b.rank;
    return a.wilds < b.wilds;
  }
  if (b.type === GDY_PLAY_TYPE.BOMB) return false;
  if (a.type !== b.type || a.size !== b.size) return false;
  if (a.rank === 15) return b.rank < 15; // 单2/对2 通吃，但吃不掉同点数的 2
  return a.rank === b.rank + 1;
}

// 中文描述：如 "炸弹 555"、"顺子 6~8"、"连对 55~77"、"对 K"、"单张 2"
export function describeGdyPlay(play) {
  if (!play) return '';
  const name = GDY_PLAY_TYPE_NAME[play.type] ?? '牌型';
  const wildTag = play.wilds > 0 ? `（含癞子×${play.wilds}）` : '';
  switch (play.type) {
    case GDY_PLAY_TYPE.BOMB: {
      const face = gdyValueFace(play.rank).repeat(play.size);
      return `${name} ${face}${wildTag}`;
    }
    case GDY_PLAY_TYPE.PAIR: {
      const face = gdyValueFace(play.rank);
      return `${name} ${face}${face}${wildTag}`;
    }
    case GDY_PLAY_TYPE.SINGLE:
      return `${name} ${gdyValueFace(play.rank)}`;
    case GDY_PLAY_TYPE.STRAIGHT:
      return `${name} ${gdyValueFace(play.lo)}~${gdyValueFace(play.hi)}${wildTag}`;
    case GDY_PLAY_TYPE.PAIRS: {
      const low = gdyValueFace(play.lo);
      const high = gdyValueFace(play.hi);
      return `${name} ${low}${low}~${high}${high}${wildTag}`;
    }
    default:
      return name;
  }
}
