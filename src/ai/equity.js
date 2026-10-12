// ============================================================
// 权益计算：hero 手牌对**建模后的对手范围**的胜率
//
// 分街调度（实测耗时）：
//   翻前   → 查 169 手牌权益表                    ~0
//   河牌+单对手 → 精确枚举范围内所有组合          0.15ms
//   其余   → 蒙特卡洛（带时间预算保护）           ~2ms
//
// 为什么河牌要精确枚举：河牌是下注尺度最大、决策最关键的一条街，
// 蒙特卡洛 3% 的误差在这里不可接受；而枚举全部组合只要 0.15ms，比采样更准还更快。
// 额外红利：阻断牌天然生效 —— hero 与公共牌占用的组合会直接从对手范围里消失，
// 不需要单独写 blocker 逻辑。
// ============================================================

import { ALL_CARDS, makeRng, partialShuffle } from './prng.js';
import { evalCards } from './fast-eval.js';
import { PREFLOP_EQUITY_BY_OPPONENTS } from './data/preflop-equity.js';
import { expandCombos, handIndexFromIds, sampleCombo } from './ranges.js';

const MAX_TABLE_OPPONENTS = 5;

/**
 * 两张底牌是否都是合法 card id。
 * 非法输入一律返回中性值 0.5，绝不让 NaN 流进后面的比较 —— NaN 参与的大小比较
 * 恒为 false，会让决策悄悄走偏而不是报错，排查成本极高。
 */
function validHand(ids) {
  return Array.isArray(ids)
    && ids.length === 2
    && ids.every((id) => Number.isInteger(id) && id >= 0 && id <= 51);
}

/** 翻前权益：直接查离线生成的表，无需采样 */
export function equityPreflop(heroIds, opponents) {
  if (opponents <= 0) return 1;
  if (!validHand(heroIds)) return 0.5;
  const k = Math.min(Math.max(1, opponents), MAX_TABLE_OPPONENTS);
  const table = PREFLOP_EQUITY_BY_OPPONENTS[k];
  return table[handIndexFromIds(heroIds[0], heroIds[1])] / 255;
}

function deadMask(cards) {
  const dead = new Uint8Array(52);
  for (const card of cards) {
    if (Number.isInteger(card) && card >= 0 && card <= 51) dead[card] = 1;
  }
  return dead;
}

/** 河牌对单对手：精确枚举，返回准确胜率 */
function enumerateRiver(hero, board, range) {
  const dead = deadMask([...hero, ...board]);

  const heroAll = new Int8Array(7);
  heroAll[0] = hero[0];
  heroAll[1] = hero[1];
  for (let i = 0; i < 5; i += 1) heroAll[2 + i] = board[i];
  const heroScore = evalCards(heroAll, 7);

  const oppAll = new Int8Array(7);
  for (let i = 0; i < 5; i += 1) oppAll[i] = board[i];

  let winWeight = 0;
  let tieWeight = 0;
  let totalWeight = 0;

  for (let a = 0; a < 52; a += 1) {
    if (dead[a]) continue;
    for (let b = a + 1; b < 52; b += 1) {
      if (dead[b]) continue;
      const weight = range[handIndexFromIds(a, b)];
      if (weight <= 0) continue;
      totalWeight += weight;
      oppAll[5] = a;
      oppAll[6] = b;
      const score = evalCards(oppAll, 7);
      if (heroScore > score) winWeight += weight;
      else if (heroScore === score) tieWeight += weight;
    }
  }

  if (totalWeight <= 0) return 0.5;
  return (winWeight + tieWeight * 0.5) / totalWeight;
}

/** 蒙特卡洛：采样剩余公共牌 + 对手范围 */
function monteCarlo(hero, board, oppRanges, samples, budgetMs, rng) {
  const K = oppRanges.length;
  const dead = deadMask([...hero, ...board]);
  const pool = [];
  for (const card of ALL_CARDS) if (!dead[card]) pool.push(card);

  const boardNeed = Math.max(0, 5 - board.length);
  const deadList = [...hero, ...board];
  const expanded = oppRanges.map((range) => expandCombos(range, deadList));
  if (expanded.some((entry) => entry.aList.length === 0)) {
    // 范围被完全阻断（极罕见，例如对手范围只剩 hero 手里的牌）
    return 0.5;
  }

  const heroAll = new Int8Array(7);
  heroAll[0] = hero[0];
  heroAll[1] = hero[1];
  for (let i = 0; i < board.length; i += 1) heroAll[2 + i] = board[i];

  // 对手侧的 7 张牌布局：前 board.length 张是已有公共牌，中间是发出的后续公共牌，
  // 最后两张是手牌。公共牌必须在这里先填进去 —— 漏掉的话这几格会保持为 0（黑桃 2），
  // evalCards 会把重复的牌算成超强牌型，于是 hero 几乎恒输。
  const oppAll = new Int8Array(7);
  for (let i = 0; i < board.length; i += 1) oppAll[i] = board[i];
  const runout = new Int8Array(2);

  const deadline = performance.now() + budgetMs;
  let wins = 0;
  let ties = 0;
  let counted = 0;

  for (let s = 0; s < samples; s += 1) {
    // 每 64 个样本检查一次预算，避免大桌多人底池拖慢 tick
    if ((s & 63) === 0 && s > 0 && performance.now() > deadline) break;

    if (boardNeed > 0) {
      partialShuffle(pool, rng, boardNeed);
      for (let i = 0; i < boardNeed; i += 1) {
        const card = pool[i];
        runout[i] = card;
        heroAll[2 + board.length + i] = card;
        oppAll[board.length + i] = card;
      }
    }

    const heroScore = evalCards(heroAll, 7);
    let bestOpponent = -1;

    for (let k = 0; k < K; k += 1) {
      let combo = null;
      // 抽到的组合不能与本次公共牌冲突，重试若干次
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = sampleCombo(expanded[k], rng);
        if (!candidate) break;
        const [a, b] = candidate;
        let conflict = false;
        for (let i = 0; i < boardNeed; i += 1) {
          if (a === runout[i] || b === runout[i]) { conflict = true; break; }
        }
        if (!conflict) { combo = candidate; break; }
      }
      if (!combo) continue;

      oppAll[5] = combo[0];
      oppAll[6] = combo[1];
      const score = evalCards(oppAll, 7);
      if (score > bestOpponent) bestOpponent = score;
    }

    if (bestOpponent < 0) continue;
    counted += 1;
    if (heroScore > bestOpponent) wins += 1;
    else if (heroScore === bestOpponent) ties += 1;
  }

  if (!counted) return 0.5;
  return (wins + ties * 0.5) / counted;
}

/**
 * 对建模范围计算权益。
 *
 * @param hero      hero 的两张牌（card id）
 * @param board     公共牌（card id），长度 0/3/4/5
 * @param oppRanges 每个存活对手一个 Uint8Array(169) 范围
 * @param profile   档位配置（提供 mcSamples / budgetMs / abilities）
 * @param rng       随机源
 */
export function equityVsRange({ hero, board, oppRanges, profile, rng }) {
  const ranges = (oppRanges ?? []).filter(Boolean);
  const K = ranges.length;
  if (K === 0) return 1;
  if (!validHand(hero)) return 0.5;

  if (!board?.length) return equityPreflop(hero, K);

  const precise = profile?.abilities?.preciseRiver !== false;

  // 河牌 + 单对手：精确枚举（比采样更快也更准，且阻断牌自动生效）
  if (board.length === 5 && K === 1 && precise) {
    return enumerateRiver(hero, board, ranges[0]);
  }

  // 样本随存活对手数衰减，控制总计算量
  const baseSamples = profile?.mcSamples ?? 600;
  const samples = Math.max(80, Math.round(baseSamples / (1 + 0.5 * (K - 1))));
  // 河牌没有后续公共牌，方差更小，可以少采样；翻牌需要更多
  const streetFactor = board.length >= 5 ? 0.6 : board.length === 4 ? 0.85 : 1;
  const budgetMs = profile?.budgetMs ?? 2;

  return monteCarlo(
    hero,
    board,
    ranges,
    Math.max(60, Math.round(samples * streetFactor)),
    budgetMs,
    rng ?? makeRng('equity', hero[0], hero[1], board.length, K),
  );
}

/**
 * 绝对牌力：不考虑对手范围，只看这手牌在随机牌面下的强弱。
 * 用于给「权益噪声」提供基线，以及在无对手范围信息时的兜底。
 */
export function handStrengthRaw(hero, board, samples = 120) {
  if (!board?.length) return equityPreflop(hero, 1);
  const rng = makeRng('raw', hero[0], hero[1], board.length);
  const full = new Uint8Array(169);
  full.fill(100);
  return monteCarlo(hero, board, [full], samples, 5, rng);
}
