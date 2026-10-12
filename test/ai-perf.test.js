// ============================================================
// 性能层测试
//
// AI 决策跑在牌局的 tick 里：一次卡顿会拖慢整桌所有人的出牌节奏，
// 玩家感受到的就是"这桌怎么这么慢"。预算定在单次决策 p95 < 10ms。
//
// 取的是最重的配置：满员桌 + GTO大师（mcSamples 最高、开精确枚举 / 阻断牌 / 超池）
// + 河牌 + 多人底池。轻档位天然更快，所以只要最重的守住，其余都在预算内。
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { TEXAS_LEVELS, getProfile, texasLevelLabel } from '../src/ai/levels.js';
import { createTable, playHand } from '../scripts/ai-harness.mjs';

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// 先跑一桌不计入统计的牌，让 V8 把评估器、范围展开这些热点路径编译掉。
// 不预热的话，前几十次决策里混着 JIT 编译时间，测出来的是"冷启动"而不是稳态延迟，
// 数字会飘，测试也就跟着偶发失败。
let warmedUp = false;
function warmUp() {
  if (warmedUp) return;
  warmedUp = true;
  const { manager, code, statsByToken } = createTable(['gto', 'gto', 'gto', 'gto', 'gto', 'gto']);
  for (let i = 0; i < 15; i += 1) playHand(manager, code, statsByToken);
}

function collectTimings(levels, hands) {
  warmUp();
  const { manager, code, statsByToken } = createTable(levels);
  const timings = [];
  for (let i = 0; i < hands; i += 1) {
    for (const entry of playHand(manager, code, statsByToken)) timings.push(entry.elapsedMs);
  }
  timings.sort((a, b) => a - b);
  return timings;
}

test('worst-case configuration stays inside the latency budget', () => {
  const timings = collectTimings(Array.from({ length: 8 }, () => 'gto'), 120);
  assert.ok(timings.length > 400, `样本太少：${timings.length}`);

  const p50 = percentile(timings, 50);
  const p95 = percentile(timings, 95);
  const p99 = percentile(timings, 99);
  console.log(`  8 人满桌 GTO大师：p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms (n=${timings.length})`);

  assert.ok(p95 < 10, `p95 ${p95.toFixed(2)}ms 超出 10ms 预算`);
  assert.ok(p99 < 30, `p99 ${p99.toFixed(2)}ms 太高，玩家会感觉到卡顿`);
});

test('every level stays inside the latency budget', () => {
  for (const level of TEXAS_LEVELS) {
    const timings = collectTimings(Array.from({ length: 6 }, () => level), 60);
    assert.ok(timings.length > 150, `${texasLevelLabel(level)} 的样本只有 ${timings.length} 个`);
    const p95 = percentile(timings, 95);
    assert.ok(p95 < 10, `${texasLevelLabel(level)} 的 p95 ${p95.toFixed(2)}ms 超出预算`);
  }
});

test('compute budgets are bounded, and scale with level strength', () => {
  for (const level of TEXAS_LEVELS) {
    const profile = getProfile(level);
    const label = texasLevelLabel(level);
    assert.ok(
      profile.mcSamples > 0 && profile.mcSamples <= 5000,
      `${label} 的 mcSamples ${profile.mcSamples} 超出合理范围`,
    );
    // 真实牌局里 tick 有截止时间，budgetMs 是最后的刹车，必须存在且有限
    assert.ok(
      profile.budgetMs > 0 && profile.budgetMs <= 20,
      `${label} 的 budgetMs ${profile.budgetMs} 超出合理范围`,
    );
  }
  // 档位越高，愿意花的计算越多 —— 这是"想得更深"的可观测体现
  assert.ok(
    getProfile('gto').mcSamples > getProfile('fish').mcSamples,
    'GTO大师 应当比新手鱼采样更多',
  );
  assert.ok(
    getProfile('gto').budgetMs >= getProfile('fish').budgetMs,
    'GTO大师 的计算预算不应低于新手鱼',
  );
});
