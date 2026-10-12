// ============================================================
// 离线生成 169 手牌的翻前权益表
//
// 用法：node scripts/gen-preflop-equity.mjs
// 产出：src/ai/data/preflop-equity.js
//
// 为什么离线生成而不是运行时算：
//   1. 可 review：表内容能提交进版本库，改动可见
//   2. 启动零成本
//   3. 脚本内建锚点断言，算错会直接失败退出，不会把错误数据带进线上
// ============================================================

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ALL_CARDS, makeRng, partialShuffle } from '../src/ai/prng.js';
import { evalCards } from '../src/ai/fast-eval.js';

const RANK_CHAR = '23456789TJQKA';
const MAX_OPPONENTS = 5;

// ---------- 169 手牌定义 ----------
// 索引方案（与 src/ai/ranges.js 保持一致）：
//   对子  rank r        → r * 13 + r      （对角线）
//   同花  high h > low l → h * 13 + l      （上三角）
//   杂花  high h > low l → l * 13 + h      （下三角）
function handIndex(high, low, suited) {
  if (high === low) return high * 13 + low;
  return suited ? high * 13 + low : low * 13 + high;
}

function handLabel(high, low, suited) {
  const h = RANK_CHAR[high];
  const l = RANK_CHAR[low];
  if (high === low) return `${h}${l}`;
  return suited ? `${h}${l}s` : `${h}${l}o`;
}

const HANDS = [];
for (let high = 12; high >= 0; high -= 1) {
  for (let low = high; low >= 0; low -= 1) {
    if (high === low) {
      HANDS.push({ high, low, suited: false, combos: 6, index: handIndex(high, low, false) });
    } else {
      HANDS.push({ high, low, suited: true, combos: 4, index: handIndex(high, low, true) });
      HANDS.push({ high, low, suited: false, combos: 12, index: handIndex(high, low, false) });
    }
  }
}

if (HANDS.length !== 169) {
  throw new Error(`手牌数应为 169，实际 ${HANDS.length}`);
}

/** 每手牌取一个代表组合（同花/杂花/对子的权益与具体花色无关） */
function canonicalCards(hand) {
  if (hand.high === hand.low) return [hand.high, 13 + hand.high]; // 两种花色
  if (hand.suited) return [hand.low, hand.high]; // 同花色（suit 0）
  return [hand.low, 13 + hand.high]; // 不同花色
}

// ---------- 蒙特卡洛 ----------
function equityVsOpponents(hand, opponents, samples) {
  const hero = canonicalCards(hand);
  const known = new Set(hero);
  const pool = ALL_CARDS.filter((id) => !known.has(id));

  const rng = makeRng('preflop-equity', hand.high, hand.low, hand.suited, opponents);
  const heroAll = new Array(7);
  heroAll[0] = hero[0];
  heroAll[1] = hero[1];
  const oppAll = new Array(7);

  let wins = 0;
  let ties = 0;
  let counted = 0;

  // partialShuffle 会把抽出的牌放到数组前部
  const need = 5 + opponents * 2;

  for (let s = 0; s < samples; s += 1) {
    partialShuffle(pool, rng, need);
    for (let b = 0; b < 5; b += 1) {
      const card = pool[b];
      heroAll[2 + b] = card;
      oppAll[b] = card;
    }

    const heroScore = evalCards(heroAll, 7);
    let bestOpponent = -1;
    for (let k = 0; k < opponents; k += 1) {
      const a = pool[5 + k * 2];
      const b = pool[6 + k * 2];
      oppAll[5] = a;
      oppAll[6] = b;
      const score = evalCards(oppAll, 7);
      if (score > bestOpponent) bestOpponent = score;
    }

    counted += 1;
    if (heroScore > bestOpponent) wins += 1;
    else if (heroScore === bestOpponent) ties += 1;
  }

  return (wins + ties * 0.5) / counted;
}

// ---------- 锚点校验 ----------
const ANCHORS = [
  { label: 'AA', value: 0.852 },
  { label: 'KK', value: 0.824 },
  { label: 'AKs', value: 0.670 },
  { label: 'T9s', value: 0.539 },
  { label: '72o', value: 0.348 },
];
const ANCHOR_TOLERANCE = 0.02;

function run() {
  const started = Date.now();
  const table1 = new Float64Array(169);

  for (const hand of HANDS) {
    table1[hand.index] = equityVsOpponents(hand, 1, 40000);
  }

  // 锚点校验：算错就地失败，避免污染线上
  for (const anchor of ANCHORS) {
    const hand = HANDS.find((h) => handLabel(h.high, h.low, h.suited) === anchor.label);
    if (!hand) throw new Error(`锚点手牌未找到: ${anchor.label}`);
    const actual = table1[hand.index];
    const diff = Math.abs(actual - anchor.value);
    if (diff > ANCHOR_TOLERANCE) {
      throw new Error(
        `锚点校验失败 ${anchor.label}: 期望 ${anchor.value}±${ANCHOR_TOLERANCE}，实际 ${actual.toFixed(4)}`,
      );
    }
    console.log(`  ✓ ${anchor.label.padEnd(4)} ${actual.toFixed(4)} (期望 ${anchor.value})`);
  }

  // 多人底池权益
  const multi = {};
  for (let opponents = 2; opponents <= MAX_OPPONENTS; opponents += 1) {
    const table = new Float64Array(169);
    const samples = opponents >= 4 ? 12000 : 20000;
    for (const hand of HANDS) {
      table[hand.index] = equityVsOpponents(hand, opponents, samples);
    }
    multi[opponents] = table;
    console.log(`  ✓ 完成 vs ${opponents} 个对手（${samples} 样本）`);
  }

  // 排序依据：单挑权益与三人底池权益各半。
  // 只用单挑权益会把 88 这类小对子排在 AKs 之前（对随机手牌的权益确实略高），
  // 但真实范围看重可玩性。多人底池权益天然奖励同花与连张、惩罚小对子，
  // 混合后得到的顺序与真实开池范围高度吻合（AA KK QQ JJ TT 99 AKs 88 AQs AKo ...）。
  const blended = new Float64Array(169);
  for (let i = 0; i < 169; i += 1) {
    blended[i] = 0.5 * table1[i] + 0.5 * multi[3][i];
  }
  const order = [...HANDS]
    .sort((a, b) => blended[b.index] - blended[a.index])
    .map((hand) => hand.index);

  // ---------- 输出 ----------
  const encode = (table) => Array.from(table, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255));

  const labels = new Array(169);
  for (const hand of HANDS) labels[hand.index] = handLabel(hand.high, hand.low, hand.suited);

  const combos = new Array(169);
  for (const hand of HANDS) combos[hand.index] = hand.combos;

  const lines = [];
  lines.push('// ============================================================');
  lines.push('// 自动生成，请勿手改。运行 `node scripts/gen-preflop-equity.mjs` 重新生成。');
  lines.push('//');
  lines.push('// 169 手牌索引（与 src/ai/ranges.js 一致）：');
  lines.push('//   对子  rank r         → r * 13 + r');
  lines.push('//   同花  high h > low l → h * 13 + l');
  lines.push('//   杂花  high h > low l → l * 13 + h');
  lines.push('//');
  lines.push('// 权益值以 0-255 的整数存储（equity × 255 取整），解码时除以 255。');
  lines.push('// ============================================================');
  lines.push('');
  lines.push('export const PREFLOP_EQUITY_1P = Uint8Array.from([');
  lines.push(`  ${encode(table1).join(', ')},`);
  lines.push(']);');
  for (let opponents = 2; opponents <= MAX_OPPONENTS; opponents += 1) {
    lines.push('');
    lines.push(`export const PREFLOP_EQUITY_${opponents}P = Uint8Array.from([`);
    lines.push(`  ${encode(multi[opponents]).join(', ')},`);
    lines.push(']);');
  }
  lines.push('');
  lines.push('export const PREFLOP_EQUITY_BY_OPPONENTS = {');
  for (let opponents = 1; opponents <= MAX_OPPONENTS; opponents += 1) {
    lines.push(`  ${opponents}: PREFLOP_EQUITY_${opponents}P,`);
  }
  lines.push('};');
  lines.push('');
  lines.push('/** 从强到弱排序的手牌索引：单挑权益与三人底池权益各半混合 */');
  lines.push('export const HAND_ORDER = [');
  for (let i = 0; i < order.length; i += 13) {
    lines.push(`  ${order.slice(i, i + 13).join(', ')},`);
  }
  lines.push('];');
  lines.push('');
  lines.push('/** HAND_ORDER 中每手牌的组合数，用于按百分比截取范围 */');
  lines.push('export const HAND_COMBOS = [');
  for (let i = 0; i < 169; i += 13) {
    lines.push(`  ${combos.slice(i, i + 13).join(', ')},`);
  }
  lines.push('];');
  lines.push('');
  lines.push('/** 调试用：索引 → 手牌标签 */');
  lines.push('export const HAND_LABELS = [');
  for (let i = 0; i < 169; i += 13) {
    lines.push(`  ${labels.slice(i, i + 13).map((l) => `'${l}'`).join(', ')},`);
  }
  lines.push('];');
  lines.push('');

  const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ai', 'data', 'preflop-equity.js');
  writeFileSync(outPath, lines.join('\n'), 'utf8');

  console.log(`\n已写入 ${outPath}`);
  console.log(`最强: ${labels[order[0]]}  最弱: ${labels[order[168]]}`);
  console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

run();
