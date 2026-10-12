// ============================================================
// AI 行为测量台
//
// 用法：node scripts/sim-ai-behavior.mjs [手数] [--mixed | --vs=参考档]
//
// 跑全 bot 桌，统计每档的扑克指标（VPIP / PFR / 3BET / CBET / WTSD / AGG%）
// 与盈利（bb/手），用来验证：
//   1. 档位画像是否符合设定（松凶真的松凶、紧凶真的紧）
//   2. 档位强弱是否单调
//   3. 是否有「像机器」的迹象（动作或下注尺度过于单一）
//
// 三种模式衡量的是不同的东西，不要混为一谈：
//   --mixed   混合桌：衡量「谁最能从弱手身上榨钱」。剥削性打法（松凶）天然占优，
//             GTO 只是不可被剥削，并不以收益最大化为目标，所以这里排第一不代表最难打。
//   --vs=档   单挑：用参考档当标尺，衡量「谁最难被打败」。样本方差极大，只能看趋势。
//   默认       同档互打：只看画像（VPIP/PFR/...），总盈利恒为 0，绝对值无意义。
//
// 模拟本体在 ./ai-harness.mjs，和测试共用同一份，避免"测试绿但实测跑偏"。
// ============================================================

import { TEXAS_LEVELS, texasLevelLabel } from '../src/ai/levels.js';
import {
  BIG_BLIND as BB,
  aggregateStats,
  runMixedTable,
  runTable,
} from './ai-harness.mjs';

const HANDS = Number(process.argv[2] ?? 400);
const SEATS = 6;
const MIXED = process.argv.includes('--mixed');
const VS = (process.argv.find((a) => a.startsWith('--vs=')) ?? '').split('=')[1] || null;

const started = Date.now();

function bar(value, scale = 60) {
  return '█'.repeat(Math.max(0, Math.round(value * scale)));
}

function reportBbPerHand(rows, { scale = 60, offset = 0.2 } = {}) {
  for (const row of rows) {
    const sign = row.bb >= 0 ? '+' : '';
    console.log(`  ${row.label.padEnd(6)} ${sign}${row.bb.toFixed(3).padStart(6)} bb/手  ${bar(row.bb + offset, scale)}`);
  }
}

if (VS) {
  // 单挑：每档轮流和参考档打，用参考档当标尺衡量「难不难打」。
  // 轮转两次抵消庄位。X 的 bb/手 越高，说明参考档越啃不动 X。
  if (!TEXAS_LEVELS.includes(VS)) {
    console.error(`--vs 只支持：${TEXAS_LEVELS.join(' / ')}`);
    process.exit(1);
  }
  const rows = [];
  for (const level of TEXAS_LEVELS) {
    let chips = 0;
    let hands = 0;
    for (let round = 0; round < 2; round += 1) {
      const levelList = round === 0 ? [level, VS] : [VS, level];
      const { manager, code, statsByToken } = runTable(levelList, HANDS);
      const tokenToLevel = new Map();
      for (const player of manager.getRoom(code).players) {
        if (player.isBot) tokenToLevel.set(player.token, player.botLevel);
      }
      for (const [token, stats] of statsByToken) {
        if (tokenToLevel.get(token) !== level) continue;
        chips += stats.chips;
        hands += stats.hands;
      }
    }
    rows.push({ level, label: texasLevelLabel(level), bb: chips / Math.max(1, hands) / BB });
  }
  rows.sort((a, b) => b.bb - a.bb);
  console.log(`单挑 ${HANDS * 2} 手，参考档：${texasLevelLabel(VS)}（数值越高 = 参考档越啃不动）\n`);
  reportBbPerHand(rows, { scale: 20, offset: 1.5 });
  console.log(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
} else if (MIXED) {
  const bbByLevel = runMixedTable(HANDS);
  const rows = TEXAS_LEVELS
    .map((level) => ({ level, label: texasLevelLabel(level), bb: bbByLevel.get(level) ?? 0 }))
    .sort((a, b) => b.bb - a.bb);
  console.log(`混合桌 ${HANDS * TEXAS_LEVELS.length} 手（${TEXAS_LEVELS.length} 轮轮转，每档在每个座位各打 ${HANDS} 手）\n`);
  reportBbPerHand(rows);
  console.log(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
} else {
  const rows = {};
  for (const level of TEXAS_LEVELS) {
    const { statsByToken } = runTable(Array.from({ length: SEATS }, () => level), HANDS);
    const stats = aggregateStats(statsByToken);
    rows[level] = stats;
    console.log(
      `${texasLevelLabel(level).padEnd(6)} VPIP ${stats.vpip.toFixed(1).padStart(5)}%  `
      + `PFR ${stats.pfr.toFixed(1).padStart(5)}%  3BET ${stats.threeBet.toFixed(1).padStart(5)}%  `
      + `CBET ${stats.cbet.toFixed(1).padStart(5)}%  WTSD ${stats.wtsd.toFixed(1).padStart(5)}%  `
      + `AGG ${stats.agg.toFixed(1).padStart(5)}%`,
    );
  }

  console.log('\n翻后加注尺度分布（加注到 / 当时的底池）:');
  for (const level of TEXAS_LEVELS) {
    const sizes = rows[level].postflopSizes;
    if (!sizes.length) {
      console.log(`  ${texasLevelLabel(level).padEnd(6)} 无样本`);
      continue;
    }
    const buckets = new Map();
    for (const ratio of sizes) {
      const key = ratio < 0.45 ? '<0.45'
        : ratio < 0.7 ? '0.45-0.7'
          : ratio < 1.0 ? '0.7-1.0'
            : ratio < 1.5 ? '1.0-1.5' : '>1.5';
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    const parts = [...buckets].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, c]) => `${k}:${((c / sizes.length) * 100).toFixed(0)}%`);
    console.log(`  ${texasLevelLabel(level).padEnd(6)} ${parts.join('  ')}`);
  }

  console.log('\n动作构成:');
  for (const level of TEXAS_LEVELS) {
    const counts = rows[level].actionCounts;
    const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
    const parts = [...counts].sort((a, b) => b[1] - a[1])
      .map(([k, c]) => `${k}:${((c / total) * 100).toFixed(0)}%`);
    console.log(`  ${texasLevelLabel(level).padEnd(6)} ${parts.join('  ')}`);
  }

  console.log(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
