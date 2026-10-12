// ============================================================
// GTO 下注尺度
//
// 尺度不是「牌力越强下越大」的简单映射，而是按**场合**选择：
//   干面 + 有利位置 → 小尺度（1/3 池）范围下注，用整个范围施压
//   湿面 + 极化     → 大尺度（2/3 池），强牌与诈唬混合
//   河牌坚果优势    → 超池，只有极化的强牌才能这么打
//   多人底池        → 整体放大（要让多个对手都为听牌付出错误代价）
// ============================================================

export const SIZE_LADDER = [0.25, 0.33, 0.5, 0.66, 0.75, 1.0, 1.25, 1.6];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 按场合选择下注尺度（占底池的比例）。
 *
 * @param kind 'range'（范围注）| 'value' | 'protect'（半诈唬/保护）
 *             | 'bluff' | 'overbet'
 * @param ctx  { street, isInPosition, texture, isMultiway, allowOverbet,
 *               rangeAdvantage, nutAdvantage, spr, sizeBias, rng }
 */
export function gtoSize(kind, ctx) {
  const {
    street = 'flop',
    isInPosition = false,
    texture = 'semi-wet',
    isMultiway = false,
    allowOverbet = false,
    rangeAdvantage = 0,
    nutAdvantage = 0,
    spr = 4,
    sizeBias = 1,
    rng = Math.random,
  } = ctx;

  let base = 0.5;

  if (kind === 'overbet') {
    base = 1.25;
  } else if (street === 'flop') {
    if (isInPosition && texture === 'dry') base = 0.33; // 范围下注
    else if (texture === 'wet' || texture === 'semi-wet') base = 0.66; // 湿面极化
    else base = isInPosition ? 0.5 : 0.66;
  } else if (street === 'turn') {
    base = texture === 'dry' ? 0.5 : 0.66;
    if (kind === 'bluff' || kind === 'protect') base = 0.75; // 转牌半诈唬要更大才有弃牌率
  } else if (street === 'river') {
    if (kind === 'bluff') base = 0.75; // 河牌诈唬需要弃牌率
    else if (kind === 'value') base = 0.66;
    else base = 0.5;
  }

  if (kind === 'value') base *= 1.1; // 值注略大
  if (kind === 'bluff') base *= 1.05;
  if (isMultiway) base *= 1.25; // 多人底池要让所有人都付出代价

  // 范围优势与坚果优势支撑更大的尺度
  base *= 1 + clamp(rangeAdvantage, -0.5, 0.5) * 0.25;
  base *= 1 + clamp(nutAdvantage, -0.5, 0.5) * 0.2;

  // 超池需要坚果优势 + 低 SPR 支撑，否则是纯送钱
  if (allowOverbet && kind === 'overbet') {
    if (nutAdvantage > 0.25 && spr <= 2.5) base = 1.6;
    else if (nutAdvantage > 0.1) base = 1.25;
    else base = 1.0;
  } else if (kind === 'overbet') {
    base = 1.0;
  }

  base *= sizeBias;

  // 15% 概率滑到邻近档位：真人不会每次都下同一个尺寸。
  // 没有这个抖动的话，同档 AI 的尺度会高度集中在单一档位上，一眼看出是机器。
  if (rng() < 0.15) {
    const neighbors = SIZE_LADDER.filter((f) => Math.abs(f - base) <= 0.4 && f !== base);
    if (neighbors.length) base = neighbors[Math.floor(rng() * neighbors.length)];
  }

  // 取最接近的档位
  let closest = SIZE_LADDER[0];
  let bestGap = Infinity;
  for (const f of SIZE_LADDER) {
    const gap = Math.abs(f - base);
    if (gap < bestGap) {
      bestGap = gap;
      closest = f;
    }
  }
  return closest;
}

/** 取整到半个大盲的整数倍，避免出现碎筹码 */
export function snapToChips(raw, bb, min, max) {
  const grid = bb % 2 === 0 ? bb / 2 : bb;
  const rounded = Math.round(raw / grid) * grid;
  return Math.round(clamp(rounded, min, max));
}

/**
 * 由尺度比例算出「加注到」的总额。
 *
 * 标准公式：raiseTo = currentBet + (pot + toCall) × fraction
 * 其中 (pot + toCall) 是"我若只是跟注后的底池"，即尺度参照的池。
 * 引擎约定 raise 的 amount 是**加注到**的总额，不是增量。
 */
export function buildRaiseTarget(view, fraction) {
  const actions = view.actions;
  const potAfterCall = Math.max(0, view.hand.pot + actions.toCall);
  const raw = view.hand.currentBet + potAfterCall * fraction;
  return snapToChips(raw, view.config.bigBlind, actions.minRaiseTo, actions.maxRaiseTo);
}

/** 翻前开池尺度（按大盲计） */
export function openSizeBB(position) {
  switch (position) {
    case 'BTN': return 2.4;
    case 'SB': return 2.8;
    case 'CO': return 2.5;
    case 'MP': return 2.6;
    default: return 2.7;
  }
}

/** 3bet 尺度：约为开池额的 3 倍 */
export function threeBetSizeBB(openSize) {
  return clamp(openSize * 3, 7, 13);
}

/** 4bet 尺度 */
export function fourBetSizeBB(threeBetSize) {
  return clamp(threeBetSize * 2.2, 18, 30);
}
