import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bestHandOfSeven,
  compareHandRanks,
  createDeck,
  evaluateFiveCardHand,
} from '../src/poker.js';
import { categoryOf, evalCards, evalHand } from '../src/ai/fast-eval.js';
import { ALL_CARDS, SUIT_OF, RANK_OF, cardName, makeRng, partialShuffle } from '../src/ai/prng.js';

// ---------- 参照实现：暴力枚举 C(n,5) 取最优 ----------
function bruteBest(cards) {
  let best = null;
  const n = cards.length;
  for (let i = 0; i < n - 4; i += 1) {
    for (let j = i + 1; j < n - 3; j += 1) {
      for (let k = j + 1; k < n - 2; k += 1) {
        for (let l = k + 1; l < n - 1; l += 1) {
          for (let m = l + 1; m < n; m += 1) {
            const rank = evaluateFiveCardHand([cards[i], cards[j], cards[k], cards[l], cards[m]]);
            if (!best || compareHandRanks(rank, best) > 0) best = rank;
          }
        }
      }
    }
  }
  return best;
}

function toStrings(ids) {
  return ids.map(cardName);
}

test('fast-eval 与 poker.js 的牌型类别完全一致（7 张，20000 手）', () => {
  const rng = makeRng('fast-eval', 'category', 2026);
  const deck = [...ALL_CARDS];
  let checked = 0;
  for (let iter = 0; iter < 20000; iter += 1) {
    partialShuffle(deck, rng, 52);
    const seven = deck.slice(0, 7);
    const ref = bestHandOfSeven(toStrings(seven));
    const got = evalCards(seven, 7);
    assert.equal(categoryOf(got), ref.category, `类别不一致: ${toStrings(seven).join(' ')}`);
    checked += 1;
  }
  assert.equal(checked, 20000);
});

test('fast-eval 的排序与 compareHandRanks 完全一致（20000 组对抗）', () => {
  const rng = makeRng('fast-eval', 'ordering', 2026);
  const deck = [...ALL_CARDS];
  for (let iter = 0; iter < 20000; iter += 1) {
    partialShuffle(deck, rng, 52);
    const a = deck.slice(0, 7);
    const b = deck.slice(7, 14);

    const refCmp = compareHandRanks(bestHandOfSeven(toStrings(a)), bestHandOfSeven(toStrings(b)));
    const gotCmp = Math.sign(evalCards(a, 7) - evalCards(b, 7));

    assert.equal(
      gotCmp,
      Math.sign(refCmp),
      `排序不一致: [${toStrings(a).join(' ')}] vs [${toStrings(b).join(' ')}] ref=${refCmp} got=${gotCmp}`,
    );
  }
});

test('fast-eval 支持 5 张与 6 张，结果与暴力枚举一致', () => {
  const rng = makeRng('fast-eval', 'short', 2026);
  const deck = [...ALL_CARDS];
  for (let iter = 0; iter < 8000; iter += 1) {
    partialShuffle(deck, rng, 52);
    for (const size of [5, 6]) {
      const ids = deck.slice(0, size);
      const ref = bruteBest(toStrings(ids));
      assert.equal(categoryOf(evalCards(ids, size)), ref.category, `${size} 张类别不一致`);
    }
  }
});

test('fast-eval 处理边界牌型', () => {
  const score = (names) => evalHand(names);

  // 牌型档次必须严格递增
  const highCard = score(['2S', '5H', '7D', '9C', 'JS']);
  const onePair = score(['2S', '2H', '7D', '9C', 'JS']);
  const twoPair = score(['2S', '2H', '7D', '7C', 'JS']);
  const trips = score(['2S', '2H', '2D', '9C', 'JS']);
  const straight = score(['2S', '3H', '4D', '5C', '6S']);
  const flush = score(['2S', '5S', '7S', '9S', 'JS']);
  const fullHouse = score(['2S', '2H', '2D', '9C', '9S']);
  const quads = score(['2S', '2H', '2D', '2C', 'JS']);
  const straightFlush = score(['2S', '3S', '4S', '5S', '6S']);
  const royal = score(['TS', 'JS', 'QS', 'KS', 'AS']);

  assert.ok(highCard < onePair, '高牌应小于一对');
  assert.ok(onePair < twoPair, '一对应小于两对');
  assert.ok(twoPair < trips, '两对应小于三条');
  assert.ok(trips < straight, '三条应小于顺子');
  assert.ok(straight < flush, '顺子应小于同花');
  assert.ok(flush < fullHouse, '同花应小于葫芦');
  assert.ok(fullHouse < quads, '葫芦应小于四条');
  assert.ok(quads < straightFlush, '四条应小于同花顺');
  assert.ok(straightFlush < royal, '普通同花顺应小于皇家同花顺');

  assert.equal(categoryOf(royal), 8);
  assert.equal(categoryOf(straight), 4);
  assert.equal(categoryOf(flush), 5);

  // 轮子顺 A2345 是最小的顺子：TJQKA 大于它，且它大于任何非顺子
  const wheel = score(['AS', '2H', '3D', '4C', '5S']);
  const broadway = score(['TS', 'JH', 'QD', 'KC', 'AS']);
  assert.equal(categoryOf(wheel), 4, 'A2345 应识别为顺子');
  assert.ok(wheel < broadway, 'A2345 应小于 TJQKA');
  assert.ok(wheel > twoPair, 'A2345 应大于两对');

  // 同花听不能误判：4 张同花 + 1 张杂牌
  assert.equal(categoryOf(score(['2S', '5S', '7S', '9S', 'JH'])), 0, '4 张同花不应算同花');

  // 7 张三对：取最大的两对 + 最大 kicker
  const threePair = evalHand(['KS', 'KH', 'QS', 'QH', 'JS', 'JH', '9C']);
  assert.equal(categoryOf(threePair), 2, '7 张三对应归为两对');
  const bestTwoPair = evalHand(['KS', 'KH', 'QS', 'QH', '9C', '8D', '7S']);
  assert.ok(threePair > bestTwoPair, 'KQ+J kicker 的两对应大于 KQ+9 kicker');

  // 7 张双三条：取最大三条 + 次大三条作葫芦
  const doubleTrips = evalHand(['KS', 'KH', 'KD', 'QS', 'QH', 'QD', '2C']);
  assert.equal(categoryOf(doubleTrips), 6, '双三条应归为葫芦');

  // 四条 + 三条：四条取最大 kicker
  const quadTrips = evalHand(['KS', 'KH', 'KD', 'KC', 'QS', 'QH', 'QD']);
  assert.equal(categoryOf(quadTrips), 7, '四条+三条应归为四条');
});

test('fast-eval 拒绝无效输入', () => {
  assert.equal(evalCards([0, 1, 2, 3], 4), -1, '不足 5 张应返回 -1');
  assert.equal(evalCards([0, 1, 2, 3, 4, 5, 6, 7], 8), -1, '超过 7 张应返回 -1');
  assert.equal(evalCards([0, 1, 2, 3, 99], 5), -1, '非法 id 应返回 -1');
  assert.equal(categoryOf(-1), -1);
});

test('fast-eval 性能：20 万次评估应在 200ms 内完成', () => {
  const rng = makeRng('perf', 'eval');
  const deck = [...ALL_CARDS];
  const samples = [];
  for (let i = 0; i < 400; i += 1) {
    partialShuffle(deck, rng, 52);
    samples.push(deck.slice(0, 7));
  }

  const started = performance.now();
  for (let i = 0; i < 200000; i += 1) {
    evalCards(samples[i % samples.length], 7);
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `20 万次评估耗时 ${elapsed.toFixed(1)}ms，超过 200ms 预算`);
});

test('partialShuffle 从整副牌均匀取样，而非只在尾部打转', () => {
  // 回归测试：曾经的实现只在数组尾部 need 张的区间内洗牌，
  // 导致每次抽样都来自同一小撮固定元素。而牌堆按花色聚集，
  // 尾部全是同一花色，蒙特卡洛结果会严重失真（AA 权益曾算出 2.4%）。
  const rng = makeRng('prng', 'uniformity');
  const deck = [...ALL_CARDS];
  const seen = new Set();
  const counts = new Map();

  for (let i = 0; i < 3000; i += 1) {
    partialShuffle(deck, rng, 7);
    for (const card of deck.slice(0, 7)) {
      seen.add(card);
      counts.set(card, (counts.get(card) ?? 0) + 1);
    }
  }

  assert.equal(seen.size, 52, `3000 次抽样应覆盖全部 52 张牌，实际只覆盖 ${seen.size} 张`);

  // 每张牌被抽中的期望次数 = 3000 * 7 / 52 ≈ 404，允许 ±35% 的偏差
  const expected = (3000 * 7) / 52;
  for (const [card, count] of counts) {
    const ratio = count / expected;
    assert.ok(
      ratio > 0.65 && ratio < 1.35,
      `牌 ${cardName(card)} 被抽中 ${count} 次，偏离期望 ${expected.toFixed(0)} 过多（比值 ${ratio.toFixed(2)}）`,
    );
  }
});

test('卡牌编码与 poker.js 的牌面一一对应', () => {
  const deck = createDeck();
  const ids = deck.map((card) => ALL_CARDS.find((c) => cardName(c) === card));
  assert.equal(ids.length, 52);
  assert.ok(ids.every((id) => Number.isInteger(id)), '每张牌都应能编码');
  assert.equal(new Set(ids).size, 52, '编码不应重复');

  // 花色与点数解析
  for (const id of ids) {
    const name = cardName(id);
    assert.equal(name, deck[ids.indexOf(id)]);
    assert.ok(RANK_OF[id] >= 2 && RANK_OF[id] <= 14);
    assert.ok(SUIT_OF[id] >= 0 && SUIT_OF[id] <= 3);
  }
});
