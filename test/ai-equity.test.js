// ============================================================
// 权益层测试
//
// 权益是整个 GTO 决策的地基：跟注门槛看底池赔率、诈唬看 alpha、防守看 MDF，
// 全都要先有一个可信的胜率。地基错了，上面调什么参数都是在错误的方向上精修。
//
// 这里用三类断言钉死它：
//   1. 锚点：几个公认的翻前单挑胜率（AA 85.2% / AKs 67.0% / 72o 34.8%）
//   2. 一致性：河牌精确枚举要和蒙特卡洛收敛到同一个值
//   3. 独立对照：翻牌的蒙特卡洛要和一段独立的暴力枚举对上
//
// 第 3 条是血的教训换来的。曾经 monteCarlo 里对手那 7 张牌忘了填公共牌，
// 空格保持成 0（也就是五张重复的黑桃 2），evalCards 把重复牌算成超强牌型，
// 于是 hero 几乎恒输 —— 翻牌权益从 88% 掉到 8%。因为翻牌本来就只能走蒙特卡洛，
// "两种算法互相印证"根本抓不到，只有拿独立的暴力实现当标尺才暴露得出来。
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { cardId, makeRng } from '../src/ai/prng.js';
import { evalCards } from '../src/ai/fast-eval.js';
import { equityPreflop, equityVsRange } from '../src/ai/equity.js';
import { getProfile } from '../src/ai/levels.js';
import { FULL_RANGE, rangeFromPercent } from '../src/ai/ranges.js';

const ids = (...names) => names.map(cardId);

// 翻前单挑胜率的公认锚点，容差 ±0.02
const ANCHORS = [
  ['AA', ['AS', 'AH'], 0.852],
  ['KK', ['KS', 'KH'], 0.824],
  ['AKs', ['AS', 'KS'], 0.670],
  ['T9s', ['TS', '9S'], 0.539],
  ['72o', ['7S', '2H'], 0.348],
];

test('preflop equity matches published heads-up anchors', () => {
  for (const [label, cards, expected] of ANCHORS) {
    const equity = equityPreflop(ids(...cards), 1);
    assert.ok(
      Math.abs(equity - expected) <= 0.02,
      `${label}: got ${equity.toFixed(4)}, expected ~${expected} (±0.02)`,
    );
  }
});

test('preflop equity orders hands the way poker theory says it should', () => {
  const aa = equityPreflop(ids('AS', 'AH'), 1);
  const kk = equityPreflop(ids('KS', 'KH'), 1);
  const aks = equityPreflop(ids('AS', 'KS'), 1);
  const akOff = equityPreflop(ids('AS', 'KH'), 1);
  const t9s = equityPreflop(ids('TS', '9S'), 1);
  const deuces = equityPreflop(ids('2S', '2H'), 1);
  const junk = equityPreflop(ids('7S', '2H'), 1);

  assert.ok(aa > kk, 'AA 应强于 KK');
  assert.ok(kk > aks, 'KK 应强于 AKs');
  assert.ok(aks > akOff, '同花的 AK 应强于杂花的 AK（同花本身就有约 3% 的价值）');
  assert.ok(aks > t9s, 'AKs 应强于 T9s');
  assert.ok(t9s > junk, 'T9s 应强于 72o');
  assert.ok(deuces > junk, '小对子应强于 72o');
  // 注意别断言"小对子强于同花连张"：22 对上 T9s 是大约 48:52，反而是连张略占优，
  // 因为同花顺潜力盖过了先发制人的一个对子。
});

test('equity decays monotonically as more opponents are dealt in', () => {
  const hero = ids('AS', 'AH');
  const values = [1, 2, 3, 4, 5].map((opponents) => equityPreflop(hero, opponents));
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(
      values[i] < values[i - 1],
      `AA 面对 ${i + 1} 个对手的胜率应低于面对 ${i} 个：${values[i]} vs ${values[i - 1]}`,
    );
  }
  // 五人底池里 AA 仍然是巨兽，不该掉到"随手一张牌"的水平
  assert.ok(values[4] > 0.45, `AA vs 5 人应保持在 45% 以上，实际 ${values[4].toFixed(3)}`);
});

test('river equity with one opponent is exact: the nuts come back as 100%', () => {
  // K Q 8 5 2 无对子、花色最多两张、任意两张底牌都凑不出顺子 ——
  // 这张牌面上没有同花、没有葫芦、也没有顺子可能，天花板就是三条。
  const board = ids('KS', 'QH', '8D', '5C', '2S');
  const profile = getProfile('gto');
  const rng = makeRng('river-nuts');
  const run = (hero) => equityVsRange({ hero, board, oppRanges: [FULL_RANGE], profile, rng });

  // 三条 K：外面再没有 K，也盖不过三条 K，是纯坚果
  const kings = run(ids('KC', 'KD'));
  assert.ok(kings > 0.999, `三条 K 在这张牌面是坚果，胜率应为 100%，实际 ${kings.toFixed(4)}`);

  // 三条 Q：任何一张 K 都能压过去，所以不可能是 100%
  const queens = run(ids('QC', 'QD'));
  assert.ok(queens < 1, `三条 Q 会被任意 K 击败，不应该是 100%，实际 ${queens.toFixed(4)}`);
  assert.ok(queens > 0.9, `三条 Q 仍然极强，实际 ${queens.toFixed(4)}`);

  // 完全没中的 23o：只剩一张 2 配对
  const air = run(ids('2C', '3D'));
  assert.ok(air < 0.6, `23o 只中对 2，胜率不该高，实际 ${air.toFixed(4)}`);
});

test('river exact enumeration and Monte Carlo agree within 0.5%', () => {
  const hero = ids('AS', 'KD');
  const board = ids('AH', 'TS', '4D', '9C', '2S');

  // 同一副牌算两遍：一次走河牌精确枚举，一次强制切成蒙特卡洛
  const base = { ...getProfile('gto'), mcSamples: 200000, budgetMs: 5000 };
  const mcOnly = { ...base, abilities: { ...base.abilities, preciseRiver: false } };

  const exact = equityVsRange({ hero, board, oppRanges: [FULL_RANGE], profile: base, rng: makeRng('cmp') });
  const approx = equityVsRange({ hero, board, oppRanges: [FULL_RANGE], profile: mcOnly, rng: makeRng('cmp-x') });

  assert.ok(
    Math.abs(exact - approx) < 0.005,
    `精确枚举 ${exact.toFixed(4)} 与蒙特卡洛 ${approx.toFixed(4)} 应收敛到 0.5% 以内`,
  );
});

/**
 * 独立的暴力枚举：翻牌面对单个随机手牌的精确胜率。
 * 刻意不复用生产代码里的任何采样逻辑，才能给 monteCarlo 当真正的外部标尺。
 */
function bruteForceFlop(hero, board) {
  const dead = new Uint8Array(52);
  for (const card of [...hero, ...board]) dead[card] = 1;
  const rest = [];
  for (let i = 0; i < 52; i += 1) if (!dead[i]) rest.push(i);

  const heroAll = new Int8Array(7);
  heroAll[0] = hero[0];
  heroAll[1] = hero[1];
  for (let i = 0; i < board.length; i += 1) heroAll[2 + i] = board[i];

  const oppAll = new Int8Array(7);
  for (let i = 0; i < board.length; i += 1) oppAll[i] = board[i];

  let score = 0;
  let total = 0;
  for (let r = 0; r < rest.length; r += 1) {
    for (let s = r + 1; s < rest.length; s += 1) {
      const turn = rest[r];
      const river = rest[s];
      heroAll[5] = turn;
      heroAll[6] = river;
      oppAll[3] = turn;
      oppAll[4] = river;
      const heroScore = evalCards(heroAll, 7);

      for (let a = 0; a < rest.length; a += 1) {
        const ca = rest[a];
        if (ca === turn || ca === river) continue;
        for (let b = a + 1; b < rest.length; b += 1) {
          const cb = rest[b];
          if (cb === turn || cb === river) continue;
          oppAll[5] = ca;
          oppAll[6] = cb;
          const oppScore = evalCards(oppAll, 7);
          score += heroScore > oppScore ? 1 : heroScore === oppScore ? 0.5 : 0;
          total += 1;
        }
      }
    }
  }
  return score / total;
}

test('flop Monte Carlo matches an independent brute-force enumeration', () => {
  const cases = [
    // 顶对顶踢脚：对随机手牌应该是压倒性优势
    ['AK on A-T-4', ids('AS', 'KD'), ids('AH', 'TS', '4D')],
    // 超对
    ['AA on 9-7-2', ids('AS', 'AH'), ids('9H', '7D', '2C')],
    // 纯空气：什么都没中
    ['72o on A-K-Q', ids('7S', '2H'), ids('AS', 'KH', 'QD')],
  ];
  const profile = { ...getProfile('gto'), mcSamples: 120000, budgetMs: 8000 };

  for (const [label, hero, board] of cases) {
    const brute = bruteForceFlop(hero, board);
    const sampled = equityVsRange({
      hero, board, oppRanges: [FULL_RANGE], profile, rng: makeRng(`flop-${label}`),
    });
    assert.ok(
      Math.abs(brute - sampled) < 0.01,
      `${label}: 暴力枚举 ${brute.toFixed(4)} vs 蒙特卡洛 ${sampled.toFixed(4)}，应收敛到 1% 以内`,
    );
    // 顺带钉住直觉：顶对和超对都该是大优，空气牌该是大劣
    if (label.startsWith('AK') || label.startsWith('AA')) {
      assert.ok(brute > 0.7, `${label} 的真实胜率应超过 70%，实际 ${brute.toFixed(4)}`);
    }
    if (label.startsWith('72o')) {
      // 22% 看着偏高，但这里面绝大部分是"双方都只能打公共牌"的平局，按 0.5 计分。
      // 空气牌真正的成手概率只有 1% 出头，剩下的全靠平局撑着。
      assert.ok(brute < 0.35, `72o 在 AKQ 面应明显是劣势，实际 ${brute.toFixed(4)}`);
    }
  }
});

test('equity actually responds to the modelled opponent range', () => {
  const hero = ids('7S', '2H');
  const board = ids('AS', 'KS', 'QD');
  const profile = { ...getProfile('gto'), mcSamples: 100000, budgetMs: 8000 };

  const vsLoose = equityVsRange({
    hero, board, oppRanges: [FULL_RANGE], profile, rng: makeRng('loose'),
  });
  const vsTight = equityVsRange({
    hero, board, oppRanges: [rangeFromPercent(10)], profile, rng: makeRng('tight'),
  });

  assert.ok(
    vsTight < vsLoose - 0.01,
    `72o 在 AKQ 翻牌面打紧范围应明显更差：紧 ${vsTight.toFixed(3)} vs 松 ${vsLoose.toFixed(3)}`,
  );
});

test('equity degrades gracefully with degenerate input', () => {
  const profile = getProfile('gto');
  // 没有对手范围 → 无人可争，胜率 1
  assert.equal(equityVsRange({ hero: ids('AS', 'AH'), board: [], oppRanges: [], profile }), 1);
  // 底牌不合法 → 返回中性值而不是 NaN。NaN 参与大小比较恒为 false，
  // 会让决策悄悄走偏而不报错，比直接崩掉难查得多。
  assert.equal(equityVsRange({ hero: [], board: [], oppRanges: [FULL_RANGE], profile }), 0.5);
  assert.equal(equityVsRange({ hero: [999, -1], board: [], oppRanges: [FULL_RANGE], profile }), 0.5);
  assert.equal(equityPreflop([999, -1], 1), 0.5);
  assert.ok(Number.isFinite(equityPreflop(ids('AS', 'AH'), 3)));
});
