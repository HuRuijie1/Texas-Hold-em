// ============================================================
// 起手牌范围表
//
// 范围用 Uint8Array(169) 表示，每项是 0-100 的**参与百分比**：
//   100 = 这个位置/这个动作下永远打这手牌
//    50 = 一半的时候打（GTO 的混合策略就体现在这些边界手牌上）
//     0 = 不打
//
// 范围由「按强度排序的前 N%」构造，而不是逐个手牌列举。
// 好处是改动一个百分比就能整体调松紧，且永远保证强牌 100% 参与。
// ============================================================

import { RANK_OF, SUIT_OF } from './prng.js';
import {
  HAND_COMBOS,
  HAND_LABELS,
  HAND_ORDER,
} from './data/preflop-equity.js';

export { HAND_LABELS };

export const TOTAL_COMBOS = 1326;

/** 由两张牌的 id 得到 169 手牌索引 */
export function handIndexFromIds(a, b) {
  const high = Math.max(RANK_OF[a], RANK_OF[b]) - 2;
  const low = Math.min(RANK_OF[a], RANK_OF[b]) - 2;
  if (high === low) return high * 13 + low;
  return SUIT_OF[a] === SUIT_OF[b] ? high * 13 + low : low * 13 + high;
}

export function handLabel(index) {
  return HAND_LABELS[index] ?? '';
}

/**
 * 按「前 percent%」截取强度排序，生成范围表。
 * 落在边界上的那手牌会得到分数权重 —— 这正是混合策略的表达方式。
 */
export function rangeFromPercent(percent) {
  const table = new Uint8Array(169);
  if (percent <= 0) return table;

  const target = (TOTAL_COMBOS * percent) / 100;
  let cumulative = 0;
  for (const index of HAND_ORDER) {
    const combos = HAND_COMBOS[index];
    if (cumulative >= target) break;
    if (cumulative + combos <= target) {
      table[index] = 100;
    } else {
      table[index] = Math.round((100 * (target - cumulative)) / combos);
    }
    cumulative += combos;
  }
  return table;
}

/**
 * 极化范围：只保留最强的 valuePct%（价值端）和最弱的 bluffPct%（诈唬端），中间留空。
 *
 * 为什么需要它：翻后主动开火的一方，持牌是两极的 —— 要么真有牌，要么纯诈唬，
 * 中等牌力通常选择过牌控池。用「前 X% 的牌」去近似下注范围，等于假设对手
 * 只拿好牌下注，会把对手想得太强（河牌尤其明显，那里诈唬占了很大比例）；
 * hero 于是高估自己的中等牌力，一路跟到摊牌。
 *
 * @param valuePct    强度排序最前百分之多少进价值端（满权重）
 * @param bluffPct    最弱百分之多少进诈唬端
 * @param bluffWeight 诈唬端的权重（低于 100，因为不是每次都诈唬）
 */
export function polarizedRange(valuePct, bluffPct, bluffWeight = 70) {
  const table = new Uint8Array(169);

  if (valuePct > 0) {
    const target = (TOTAL_COMBOS * valuePct) / 100;
    let cumulative = 0;
    for (const index of HAND_ORDER) {
      const combos = HAND_COMBOS[index];
      if (cumulative >= target) break;
      table[index] = cumulative + combos <= target
        ? 100
        : Math.round((100 * (target - cumulative)) / combos);
      cumulative += combos;
    }
  }

  if (bluffPct > 0) {
    // 从最弱的一端往回取，跳过已经被价值端占掉的手牌
    const target = (TOTAL_COMBOS * bluffPct) / 100;
    let cumulative = 0;
    for (let i = HAND_ORDER.length - 1; i >= 0; i -= 1) {
      const index = HAND_ORDER[i];
      if (table[index] > 0) continue;
      const combos = HAND_COMBOS[index];
      if (cumulative >= target) break;
      const weight = cumulative + combos <= target
        ? bluffWeight
        : Math.round((bluffWeight * (target - cumulative)) / combos);
      table[index] = Math.max(table[index], weight);
      cumulative += combos;
    }
  }

  return table;
}

/** 取两个范围中较宽的（逐项取较大值） */
export function unionRange(a, b) {
  const out = new Uint8Array(169);
  for (let i = 0; i < 169; i += 1) out[i] = Math.max(a[i], b[i]);
  return out;
}

/** 全范围（对手无信息时的先验） */
export const FULL_RANGE = (() => {
  const table = new Uint8Array(169);
  table.fill(100);
  return table;
})();

export const POSITIONS = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];

// ============================================================
// 各档位的范围百分比
//
// 数值方向：fish 的 RFI 很窄但跟注极宽 —— 这正是「跟注站」的画像：
// 只拿好牌加注，什么都跟。lag 的 RFI 与 3bet 都最宽最凶，tag 最紧。
// ============================================================

/**
 * 无人加注时的开池加注范围。
 *
 * 注意：这些数字**不等于**最终的 PFR。它们只在"轮到你且前面没人加注"时生效，
 * 而 6 人桌中越靠后的位置越常遇到前位已经开池，实际机会率约
 * UTG 100% / MP 65% / CO 45% / BTN 30% / SB 20%。
 * 因此这里的数值要比目标 PFR 高不少，是真实开池图表的量级
 * （例：紧凶 BTN 开池约 50%，但其整体 PFR 只有 20%）。
 * 数值由 scripts/sim-ai-behavior.mjs 实测校准。
 */
export const RFI_PCT = {
  // 新手鱼没有位置概念，各位置用同一个值；再乘 leak.passivity 后得到真实的低 PFR
  fish: { UTG: 24, MP: 24, CO: 24, BTN: 24, SB: 24 },
  regular: { UTG: 19, MP: 26, CO: 42, BTN: 64, SB: 47 },
  lag: { UTG: 33, MP: 44, CO: 66, BTN: 88, SB: 70 },
  tag: { UTG: 15, MP: 20, CO: 32, BTN: 50, SB: 36 },
  gto: { UTG: 18, MP: 26, CO: 42, BTN: 62, SB: 46 },
};

/** 面对公开加注时的冷跟注范围（在 RFI 之外贡献 VPIP） */
export const COLD_CALL_PCT = {
  fish: { UTG: 80, MP: 80, CO: 80, BTN: 80, SB: 80, BB: 86 },
  regular: { UTG: 12, MP: 18, CO: 30, BTN: 38, SB: 28, BB: 42 },
  lag: { UTG: 9, MP: 13, CO: 20, BTN: 27, SB: 20, BB: 30 },
  tag: { UTG: 3, MP: 5, CO: 8, BTN: 12, SB: 8, BB: 14 },
  gto: { UTG: 9, MP: 13, CO: 20, BTN: 29, SB: 22, BB: 32 },
};

/** 面对公开加注时的 3bet 范围 */
export const THREEBET_PCT = {
  fish: { UTG: 2, MP: 2, CO: 2, BTN: 2, SB: 2, BB: 3 },
  regular: { UTG: 4, MP: 5, CO: 7, BTN: 9, SB: 8, BB: 9 },
  lag: { UTG: 9, MP: 11, CO: 15, BTN: 18, SB: 16, BB: 17 },
  tag: { UTG: 5, MP: 6, CO: 8, BTN: 10, SB: 9, BB: 10 },
  gto: { UTG: 7, MP: 9, CO: 12, BTN: 14, SB: 13, BB: 14 },
};

/** 面对 3bet 时的 4bet 范围 */
export const FOURBET_PCT = { fish: 1, regular: 3, lag: 5, tag: 4, gto: 4.5 };

/** 面对 3bet 时的跟注范围 */
export const VS_3BET_CALL_PCT = { fish: 12, regular: 7, lag: 9, tag: 6, gto: 7 };

/** 大盲位面对后位偷盲时的总防守范围（3bet + 跟注，需与 COLD_CALL 的 BB 列一致） */
export const BB_DEFEND_PCT = { fish: 86, regular: 54, lag: 60, tag: 40, gto: 55 };

/**
 * 短码推入范围，按有效筹码深度分档。
 * 真实 push/fold 表在 ≤6BB 时会推到 50-60%，随深度迅速收窄。
 */
export const PUSH_PCT = {
  fish: { shallow: 30, mid: 18, deep: 10 },
  regular: { shallow: 55, mid: 33, deep: 20 },
  lag: { shallow: 62, mid: 40, deep: 25 },
  tag: { shallow: 52, mid: 31, deep: 19 },
  gto: { shallow: 57, mid: 34, deep: 21 },
};

/** 无人加注时的跛入（limp）范围 —— 只有被动的玩家会这么打 */
export const LIMP_PCT = {
  fish: { UTG: 42, MP: 44, CO: 46, BTN: 48, SB: 54, BB: 0 },
  regular: { UTG: 1, MP: 2, CO: 3, BTN: 4, SB: 6, BB: 0 },
  lag: { UTG: 1, MP: 1, CO: 2, BTN: 3, SB: 5, BB: 0 },
  tag: { UTG: 0.5, MP: 1, CO: 1.5, BTN: 2, SB: 3, BB: 0 },
  gto: { UTG: 0.5, MP: 1, CO: 1.5, BTN: 2, SB: 3, BB: 0 },
};

// ============================================================
// 预编译范围表（模块加载时一次算好，运行期零开销）
// ============================================================

function compileByPosition(pctTable, positions = POSITIONS) {
  const out = {};
  for (const level of Object.keys(pctTable)) {
    out[level] = {};
    for (const position of positions) {
      const pct = pctTable[level]?.[position];
      out[level][position] = pct == null ? null : rangeFromPercent(pct);
    }
  }
  return out;
}

export const RFI = compileByPosition(RFI_PCT);
export const COLD_CALL = compileByPosition(COLD_CALL_PCT);
export const THREEBET = compileByPosition(THREEBET_PCT);
export const LIMP = compileByPosition(LIMP_PCT);

export const FOURBET = Object.fromEntries(
  Object.entries(FOURBET_PCT).map(([level, pct]) => [level, rangeFromPercent(pct)]),
);
export const VS_3BET_CALL = Object.fromEntries(
  Object.entries(VS_3BET_CALL_PCT).map(([level, pct]) => [level, rangeFromPercent(pct)]),
);
export const BB_DEFEND = Object.fromEntries(
  Object.entries(BB_DEFEND_PCT).map(([level, pct]) => [level, rangeFromPercent(pct)]),
);

export const PUSH_FOLD = Object.fromEntries(
  Object.entries(PUSH_PCT).map(([level, bands]) => [
    level,
    Object.fromEntries(Object.entries(bands).map(([band, pct]) => [band, rangeFromPercent(pct)])),
  ]),
);

/** 有效筹码深度分档 */
export function depthBand(effBB) {
  if (effBB <= 6) return 'shallow';
  if (effBB <= 12) return 'mid';
  return 'deep';
}

function pickTable(compiled, level, position, fallback = 'BTN') {
  const byLevel = compiled[level] ?? compiled.regular;
  return byLevel?.[position] ?? byLevel?.[fallback] ?? null;
}

export function rfiRange(level, position) {
  return pickTable(RFI, level, position);
}
export function coldCallRange(level, position) {
  return pickTable(COLD_CALL, level, position);
}
export function threeBetRange(level, position) {
  return pickTable(THREEBET, level, position);
}
export function limpRange(level, position) {
  return pickTable(LIMP, level, position);
}
export function fourBetRange(level) {
  return FOURBET[level] ?? FOURBET.regular;
}
export function vsThreeBetCallRange(level) {
  return VS_3BET_CALL[level] ?? VS_3BET_CALL.regular;
}
export function bbDefendRange(level) {
  return BB_DEFEND[level] ?? BB_DEFEND.regular;
}
export function pushRange(level, band) {
  return PUSH_FOLD[level]?.[band] ?? PUSH_FOLD.regular[band];
}

// ============================================================
// 组合展开与加权采样（供翻后权益计算使用）
// ============================================================

/**
 * 把范围表展开成具体组合，剔除已被占用的牌（阻断牌天然生效：
 * hero 手牌与公共牌占用的组合会直接从对手范围里消失）。
 * 返回累积权重数组，采样时二分查找，避免拒绝采样在窄范围下退化。
 */
export function expandCombos(range, deadCards) {
  const dead = new Uint8Array(52);
  for (const card of deadCards) {
    if (Number.isInteger(card) && card >= 0 && card <= 51) dead[card] = 1;
  }

  const aList = [];
  const bList = [];
  const cumulative = [];
  let total = 0;

  // 枚举出的每一对牌本身就是一个具体组合，直接按手牌权重计入即可
  // （不要再乘组合数，否则同花/杂花/对子会被重复计数）
  for (let a = 0; a < 52; a += 1) {
    if (dead[a]) continue;
    for (let b = a + 1; b < 52; b += 1) {
      if (dead[b]) continue;
      const weight = range[handIndexFromIds(a, b)];
      if (weight <= 0) continue;
      total += weight / 100;
      aList.push(a);
      bList.push(b);
      cumulative.push(total);
    }
  }

  return { aList, bList, cumulative, total };
}

/** 从展开的组合中按权重采样一对牌 */
export function sampleCombo(expanded, rng) {
  const { aList, bList, cumulative, total } = expanded;
  if (!aList.length || total <= 0) return null;

  const target = rng() * total;
  let low = 0;
  let high = cumulative.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (cumulative[mid] < target) low = mid + 1;
    else high = mid;
  }
  return [aList[low], bList[low]];
}

/** 范围中是否包含某手牌（用于判断对手是否可能持有强牌） */
export function rangeContains(range, index, threshold = 0) {
  return (range[index] ?? 0) > threshold;
}
