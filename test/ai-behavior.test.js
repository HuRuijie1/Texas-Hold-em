// ============================================================
// 行为层测试
//
// 档位不是靠「参数不一样」来区分的，而是靠**打出来的牌面统计**不一样。
// 这里把每一档的画像钉在一个区间里，并用相对断言守住强弱顺序。
//
// 两条经验：
//   1. 绝对区间要留得比实测宽。蒙特卡洛本身有样本噪声，卡太死会变成随机失败的测试。
//   2. 真正该严格的是相对关系（激进度排序、谁更像跟注站），这些受噪声影响小得多。
//      参数漂移时，先坏掉的也往往是这些关系。
//
// HANDS=800 与 scripts/sim-ai-behavior.mjs 的实测画像同口径：WTSD 的相对断言
// （fish 高出 +8pp）在 800 手下的实测差距约 16pp，留一倍余量；400 手时间距
// 会缩到阈值边缘，变成随机失败，故不要为省时间再往下调。
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { TEXAS_LEVELS, texasLevelLabel } from '../src/ai/levels.js';
import { aggregateStats, runTable } from '../scripts/ai-harness.mjs';

const HANDS = 800;

/**
 * 领先下注（donk）机会：翻后、本街还没有人下注、翻前加注者还在局中且尚未行动。
 *
 * 「加注者还在局中」这条不能省：加注者已经弃牌的话这就不是领先下注了，
 * 漏掉它会让统计混进一批无关的局面，各档的样本构成还不一样（新手鱼因此
 * 多算了 75 个假样本），结论会被带偏。
 */
function isDonkSpot(room, player, legal) {
  if (legal.toCall > 0) return false;
  const aggressor = room.hand?.preflopAggrSeat;
  if (aggressor == null || aggressor === player.seatIndex) return false;
  const stillIn = room.players.some(
    (entry) => entry.seatIndex === aggressor && entry.inHand && !entry.folded,
  );
  if (!stillIn) return false;
  return !room.hand?.playerStreetActions?.[aggressor];
}

function measure(level) {
  const donk = { spots: 0, fired: 0 };
  const { statsByToken } = runTable(Array.from({ length: 6 }, () => level), HANDS, {
    onAction: ({ action, legal, player, room, street }) => {
      if (street === 'preflop') return;
      if (!isDonkSpot(room, player, legal)) return;
      donk.spots += 1;
      if (action.type === 'raise' || action.type === 'allin') donk.fired += 1;
    },
  });
  return { ...aggregateStats(statsByToken), donk };
}

// 五个档位各跑一遍要十几秒，缓存起来让同一文件里的多个测试共用
let cache = null;
function profiles() {
  if (!cache) cache = new Map(TEXAS_LEVELS.map((level) => [level, measure(level)]));
  return cache;
}

test('each level lands in its designed VPIP / PFR band', () => {
  const p = profiles();
  const bands = {
    fish: { vpip: [45, 68], pfr: [5, 18] },
    regular: { vpip: [23, 40], pfr: [12, 27] },
    lag: { vpip: [25, 42], pfr: [17, 33] },
    tag: { vpip: [15, 30], pfr: [11, 26] },
    gto: { vpip: [20, 36], pfr: [13, 29] },
  };

  for (const [level, band] of Object.entries(bands)) {
    const stats = p.get(level);
    const label = texasLevelLabel(level);
    assert.ok(
      stats.vpip >= band.vpip[0] && stats.vpip <= band.vpip[1],
      `${label} VPIP ${stats.vpip.toFixed(1)}% 不在设计区间 ${band.vpip.join('~')}%`,
    );
    assert.ok(
      stats.pfr >= band.pfr[0] && stats.pfr <= band.pfr[1],
      `${label} PFR ${stats.pfr.toFixed(1)}% 不在设计区间 ${band.pfr.join('~')}%`,
    );
    // 加注必然是"自愿投入"的子集，PFR 不可能超过 VPIP
    assert.ok(stats.pfr <= stats.vpip + 0.6, `${label} 的 PFR 超过了 VPIP，统计口径出问题了`);
  }
});

test('aggression is ordered the way the level names promise', () => {
  const p = profiles();
  const agg = (level) => p.get(level).agg;

  assert.ok(agg('fish') < agg('regular') - 4, `新手鱼(${agg('fish').toFixed(1)}%) 应明显比常规玩家(${agg('regular').toFixed(1)}%) 被动`);
  assert.ok(agg('fish') < agg('tag') - 4, `新手鱼 应明显比紧凶高手被动`);
  assert.ok(agg('fish') < agg('gto') - 4, `新手鱼 应明显比 GTO大师 被动`);
  // 松凶的招牌就是压迫感，它必须是全场最凶的
  assert.ok(agg('lag') > agg('regular'), `松凶玩家(${agg('lag').toFixed(1)}%) 应比常规玩家(${agg('regular').toFixed(1)}%) 更凶`);
  assert.ok(agg('lag') > agg('tag'), `松凶玩家 应比紧凶高手(${agg('tag').toFixed(1)}%) 更凶`);
});

test('the fish is the calling station, the strong levels are not', () => {
  const p = profiles();
  assert.ok(
    p.get('fish').wtsd > p.get('gto').wtsd + 8,
    `新手鱼的 WTSD(${p.get('fish').wtsd.toFixed(1)}%) 应明显高于 GTO大师(${p.get('gto').wtsd.toFixed(1)}%)`,
  );
  assert.ok(
    p.get('fish').wtsd > p.get('tag').wtsd,
    `新手鱼的 WTSD 应高于紧凶高手(${p.get('tag').wtsd.toFixed(1)}%)`,
  );
});

test('leading into the preflop raiser is a tool for the aggressors, not for the fish', () => {
  const p = profiles();
  const donkRate = (level) => {
    const { spots, fired } = p.get(level).donk;
    return spots > 0 ? fired / spots : 0;
  };

  for (const level of TEXAS_LEVELS) {
    assert.ok(p.get(level).donk.spots > 40, `${texasLevelLabel(level)} 的 donk 样本只有 ${p.get(level).donk.spots} 个`);
  }

  // 求解器里 donk 频率接近 0：范围劣势方应当过牌给优势方，抢先开火只会把自己的
  // 范围拆成两半、还让对手白拿位置。所以牌手越懂，越舍不得主动往加注者身上撞。
  // 新手鱼频率最低则是另一码事 —— 它连开火都不会，是被动而不是懂行。
  assert.ok(
    donkRate('fish') < donkRate('gto') - 0.05,
    `新手鱼的领先下注率(${donkRate('fish').toFixed(2)}) 应低于 GTO大师(${donkRate('gto').toFixed(2)})`,
  );
  assert.ok(
    donkRate('fish') < donkRate('lag') - 0.1,
    `新手鱼的领先下注率(${donkRate('fish').toFixed(2)}) 应明显低于松凶玩家(${donkRate('lag').toFixed(2)})`,
  );
  // 松凶会把领先下注当武器用，是全场最爱抢先开火的
  assert.ok(
    donkRate('lag') > donkRate('regular'),
    `松凶玩家 的领先下注率(${donkRate('lag').toFixed(2)}) 应高于常规玩家(${donkRate('regular').toFixed(2)})`,
  );
  // 再怎么说也不能把把都领先下注，那就不是 donk 而是无脑下注了
  for (const level of TEXAS_LEVELS) {
    assert.ok(donkRate(level) < 0.7, `${texasLevelLabel(level)} 的领先下注率 ${donkRate(level).toFixed(2)} 高得不合理`);
  }
});

test('post-flop sizing is varied rather than pinned to one number', () => {
  const p = profiles();
  for (const level of TEXAS_LEVELS) {
    const sizes = p.get(level).postflopSizes;
    const label = texasLevelLabel(level);
    assert.ok(sizes.length > 40, `${label} 的翻后加注样本只有 ${sizes.length} 个`);

    const buckets = new Map();
    for (const ratio of sizes) {
      const key = ratio < 0.45 ? '<0.45'
        : ratio < 0.7 ? '0.45-0.7'
          : ratio < 1.0 ? '0.7-1.0'
            : ratio < 1.5 ? '1.0-1.5' : '>1.5';
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    // 全都挤在一档里 = 一眼看出是机器
    const largest = Math.max(...buckets.values());
    assert.ok(
      largest / sizes.length < 0.75,
      `${label} 有 ${((largest / sizes.length) * 100).toFixed(0)}% 的翻后加注落在同一档，尺度太单一`,
    );
    assert.ok(buckets.size >= 3, `${label} 的翻后尺度只出现了 ${buckets.size} 档，缺乏变化`);
  }
});

test('levels are statistically distinguishable from one another', () => {
  const p = profiles();
  const signature = (level) => {
    const s = p.get(level);
    return [s.vpip, s.pfr, s.agg, s.wtsd, s.threeBet].map((v) => Math.round(v)).join('/');
  };
  const seen = new Set(TEXAS_LEVELS.map(signature));
  assert.equal(seen.size, TEXAS_LEVELS.length, '有两档的画像完全重合，说明档位没有真正区分开');
});
