// ============================================================
// 牌面分析：纹理、听牌、范围与坚果优势、阻断牌
//
// 兼容约束：analyzeBoard / detectDraws 的**字段语义必须与旧实现完全一致**，
// 现有测试直接断言了 wet / paired / monotone / connected 与
// flushDraw(boolean) / straightDraw(2=两端)。新增信息一律以**新字段**追加。
// ============================================================

import { RANK_OF, SUIT_OF, cardId, isCardId } from './prng.js';

function toIds(cards) {
  if (!Array.isArray(cards) || !cards.length) return [];
  const ids = [];
  for (const card of cards) {
    if (card == null || card === '??') continue;
    const id = isCardId(card) ? card : cardId(card);
    if (id >= 0) ids.push(id);
  }
  return ids;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 牌面纹理。
 * 兼容字段：wet / paired / monotone / connected / highCard
 * 新增字段：texture / twoTone / threeToFlush / allSameSuit / rankSpread / lowCard / pairedTopCard
 */
export function analyzeBoard(board) {
  const ids = toIds(board);
  if (!ids.length) {
    return {
      wet: 0, paired: false, monotone: false, connected: false, highCard: 0,
      texture: 'dry', twoTone: false, threeToFlush: false, allSameSuit: false,
      rankSpread: 0, lowCard: 0, pairedTopCard: false, flushPossible: false, straightPossible: false,
    };
  }

  const ranks = ids.map((id) => RANK_OF[id]).sort((a, b) => b - a);
  const suitCounts = new Array(4).fill(0);
  for (const id of ids) suitCounts[SUIT_OF[id]] += 1;
  const maxSuit = Math.max(0, ...suitCounts);

  const paired = new Set(ranks).size < ranks.length;

  const uniq = [...new Set(ranks)].sort((a, b) => a - b);
  let connected = false;
  for (let i = 2; i < uniq.length; i += 1) {
    if (uniq[i] - uniq[i - 2] <= 4) connected = true;
  }
  if (!connected && uniq.length >= 3) {
    for (let i = 1; i < uniq.length; i += 1) {
      if (uniq[i] - uniq[i - 1] === 1) connected = true;
    }
  }

  const highCard = ranks[0] ?? 0;
  const lowCard = uniq[0] ?? 0;
  const wet = clamp(
    (maxSuit >= 3 ? 1 : maxSuit === 2 ? 0.45 : 0)
      + (connected ? 0.55 : 0)
      + (paired ? -0.35 : 0)
      + (highCard >= 12 ? 0.15 : 0),
    0,
    1.4,
  );

  // 配对的是否是最大牌（顶对对子 vs 底对对子，策略含义不同）
  let pairedTopCard = false;
  if (paired) {
    for (let i = 1; i < ranks.length; i += 1) {
      if (ranks[i] === ranks[i - 1]) {
        pairedTopCard = ranks[i] === highCard;
        break;
      }
    }
  }

  return {
    // ---- 兼容字段（语义与旧实现一致）----
    wet,
    paired,
    monotone: maxSuit >= 3,
    connected,
    highCard,
    // ---- 新增字段 ----
    texture: wet >= 0.85 ? 'wet' : wet >= 0.4 ? 'semi-wet' : 'dry',
    twoTone: maxSuit === 2,
    threeToFlush: maxSuit === 3,
    allSameSuit: maxSuit === ids.length && ids.length >= 3,
    rankSpread: highCard - lowCard,
    lowCard,
    pairedTopCard,
    flushPossible: maxSuit >= 3,
    straightPossible: connected,
  };
}

const STRAIGHT_WINDOWS = (() => {
  const windows = [];
  for (let start = 2; start <= 10; start += 1) windows.push([start, start + 4]);
  windows.push([1, 5]); // A-5 轮子
  return windows;
})();

/**
 * 听牌检测。
 * 兼容字段：flushDraw(boolean) / straightDraw(0|1|2)
 * 新增字段：flushDrawType(0无 1后门 2同花听) / straightDrawType(0无 1后门 2卡顺 3两端)
 *           outs（粗估补牌数） / combo（听牌叠加）
 */
export function detectDraws(holeCards, board) {
  const hole = toIds(holeCards);
  const boardIds = toIds(board);
  const empty = {
    flushDraw: false, straightDraw: 0,
    flushDrawType: 0, straightDrawType: 0, outs: 0, combo: false,
  };
  if (!hole.length || !boardIds.length) return empty;

  const all = [...hole, ...boardIds];

  // ---- 同花听（兼容原逻辑：4 张同色且至少一张在手里）----
  const bySuit = new Array(4).fill(null).map(() => []);
  for (const id of all) bySuit[SUIT_OF[id]].push(id);

  let flushDrawType = 0;
  for (const cards of bySuit) {
    if (!cards.some((card) => hole.includes(card))) continue;
    if (cards.length >= 4) flushDrawType = Math.max(flushDrawType, 2);
    else if (cards.length === 3) flushDrawType = Math.max(flushDrawType, 1);
  }

  // ---- 顺子听 ----
  const values = new Set(all.map((id) => RANK_OF[id]));
  if (values.has(14)) values.add(1);

  let straightDraw = 0; // 兼容字段
  let bestWindowCount = 0;
  let bestWindowMissingIsEdge = false;
  for (const [lo, hi] of STRAIGHT_WINDOWS) {
    let count = 0;
    let missing = -1;
    for (let v = lo; v <= hi; v += 1) {
      if (values.has(v)) count += 1;
      else missing = v;
    }
    if (count > bestWindowCount) {
      bestWindowCount = count;
      // 缺失的那张在窗口两端 → 两头都能成（OESD）；在中间 → 只有 4 个补牌（卡顺）
      bestWindowMissingIsEdge = missing === lo || missing === hi;
    }
    if (count === 4) straightDraw = Math.max(straightDraw, 2);
    else if (count === 3) straightDraw = Math.max(straightDraw, 1);
  }

  // 精确区分：还需要几张牌、还剩几条街
  const cardsKnown = all.length; // 5(翻牌) / 6(转牌) / 7(河牌)
  const streetsLeft = cardsKnown <= 5 ? 2 : cardsKnown === 6 ? 1 : 0;
  let straightDrawType = 0;
  if (bestWindowCount === 4 && streetsLeft >= 1) {
    straightDrawType = bestWindowMissingIsEdge ? 3 : 2;
  } else if (bestWindowCount === 3 && streetsLeft >= 2) {
    straightDrawType = 1; // 后门顺
  }

  const outs = (flushDrawType === 2 ? 9 : flushDrawType === 1 ? 1 : 0)
    + (straightDrawType === 3 ? 8 : straightDrawType === 2 ? 4 : straightDrawType === 1 ? 1 : 0);

  return {
    // ---- 兼容字段 ----
    flushDraw: flushDrawType === 2,
    straightDraw,
    // ---- 新增字段 ----
    flushDrawType,
    straightDrawType,
    outs,
    combo: flushDrawType === 2 && straightDrawType >= 2,
  };
}

/**
 * 范围优势：谁的范围在这个牌面上更强。
 * 翻前加注者持有更多高牌与大同花连张，因此在高牌面占优；
 * 跟注者的范围偏小牌与中对，在低牌连张面反而更贴合。
 */
export function rangeAdvantage(board, aggressorIsInPosition) {
  const info = analyzeBoard(board);
  if (!info.highCard) return 0;

  let advantage = 0;
  if (info.highCard >= 13) advantage += 0.35; // A/K 高面：加注者范围占优
  else if (info.highCard >= 11) advantage += 0.15;
  else if (info.highCard <= 9) advantage -= 0.2; // 低牌面：跟注者范围更贴合

  if (info.monotone || info.threeToFlush) advantage += 0.1; // 同花面利于有同花连张的一方
  if (info.paired) advantage -= 0.12; // 配对面缩小差距
  if (info.connected && info.highCard <= 10) advantage -= 0.15; // 低连张面利于跟注者

  return clamp(advantage * (aggressorIsInPosition ? 1.15 : 0.85), -1, 1);
}

/**
 * 坚果优势：hero 是否比对手更容易代表坚果牌。
 * 用于决定河牌是否可以超池下注（超池需要坚果优势支撑）。
 */
export function nutAdvantage(board, heroCards) {
  const info = analyzeBoard(board);
  if (!info.highCard) return 0;

  const hero = toIds(heroCards);
  let advantage = 0;

  // 持有牌面的顶对/暗三条/顺子/同花的组成牌 → 有坚果优势
  const heroRanks = new Set(hero.map((id) => RANK_OF[id]));
  if (heroRanks.has(info.highCard)) advantage += 0.3;
  if (info.paired && heroRanks.has(info.highCard)) advantage += 0.35; // 暗三条

  // 同花面时持有该花色的 A 或 K
  if (info.flushPossible || info.twoTone) {
    const boardSuitCounts = new Array(4).fill(0);
    for (const id of toIds(board)) boardSuitCounts[SUIT_OF[id]] += 1;
    const dominantSuit = boardSuitCounts.indexOf(Math.max(...boardSuitCounts));
    for (const id of hero) {
      if (SUIT_OF[id] !== dominantSuit) continue;
      const rank = RANK_OF[id];
      if (rank === 14) advantage += 0.4;
      else if (rank === 13) advantage += 0.25;
      else if (rank >= 10) advantage += 0.1;
    }
  }

  return clamp(advantage, -1, 1);
}

/**
 * 阻断牌评分。
 * value：阻断对手**价值范围**的程度（持有同花 A 就阻断了对手的坚果同花）
 * bluff：阻断对手**会跟注的强牌**的程度（诈唬时希望对手没有强牌可跟）
 */
export function blockerScore(heroCards, board, kind = 'bluff') {
  const hero = toIds(heroCards);
  const boardIds = toIds(board);
  if (!hero.length) return 0;

  const info = analyzeBoard(board);
  const heroRanks = new Set(hero.map((id) => RANK_OF[id]));
  let score = 0;

  // 阻断对手的顶对/超对：持有牌面高牌本身
  if (info.highCard && heroRanks.has(info.highCard)) score += 0.25;
  if (heroRanks.has(14)) score += 0.15; // 持有 A 减少对手的 AA/AK

  // 同花面持有该花色的关键牌 → 阻断坚果同花
  if (info.flushPossible || info.twoTone) {
    const boardSuitCounts = new Array(4).fill(0);
    for (const id of boardIds) boardSuitCounts[SUIT_OF[id]] += 1;
    const dominantSuit = boardSuitCounts.indexOf(Math.max(...boardSuitCounts));
    for (const id of hero) {
      if (SUIT_OF[id] !== dominantSuit) continue;
      const rank = RANK_OF[id];
      if (rank === 14) score += 0.35;
      else if (rank >= 11) score += 0.15;
    }
  }

  if (kind === 'value') {
    // 做价值下注时，反过来希望**不要**阻断对手的跟注范围
    return clamp(1 - score, 0, 1);
  }
  return clamp(score, 0, 1);
}
