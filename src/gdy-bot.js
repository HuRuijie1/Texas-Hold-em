import {
  describeGdyPlay,
  evaluateGdyPlay,
  gdyBeats,
  gdyRankValue,
  isGdyJoker,
} from './gdy.js';

// ===== 干瞪眼机器人决策 =====
// 策略（从简但合理）：
// - 自由出牌：能一次出完直接赢；否则优先出非炸弹中"最大点数最小"的组合（留 2/炸弹控场），
//   同点数优先出张数更多的；实在没有非炸弹才出炸弹
// - 跟牌：出能压过的最小组合（优先非炸弹）；接不上就过
// - 癞子参与组合按 evaluateGdyPlay 的最有利解释

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// 枚举手牌所有可出的组合，返回 [{ cards, play }]
export function enumerateGdyPlays(cards) {
  const jokers = cards.filter(isGdyJoker);
  const byRank = new Map();
  for (const card of cards) {
    if (isGdyJoker(card)) continue;
    const value = gdyRankValue(card);
    if (!byRank.has(value)) byRank.set(value, []);
    byRank.get(value).push(card);
  }
  const results = [];
  const add = (picked) => {
    const play = evaluateGdyPlay(picked);
    if (play) results.push({ cards: picked, play });
  };

  // 单张
  for (const list of byRank.values()) add([list[0]]);

  // 对子（双癞子不能直接成对）
  for (const list of byRank.values()) {
    if (list.length >= 2) add([list[0], list[1]]);
    else if (list.length === 1 && jokers.length >= 1) add([list[0], jokers[0]]);
  }

  // 三张炸 / 四张炸（癞子补足）
  for (const list of byRank.values()) {
    if (list.length >= 3) add(list.slice(0, 3));
    else if (list.length === 2 && jokers.length >= 1) add([list[0], list[1], jokers[0]]);
    else if (list.length === 1 && jokers.length >= 2) add([list[0], jokers[0], jokers[1]]);
    if (list.length >= 4) add(list.slice(0, 4));
    else if (list.length === 3 && jokers.length >= 1) add([list[0], list[1], list[2], jokers[0]]);
  }

  // 顺子：窗口内缺的点数用癞子补
  const maxSize = Math.min(12, cards.length);
  for (let size = 3; size <= maxSize; size += 1) {
    for (let hi = size + 2; hi <= 14; hi += 1) {
      const picked = [];
      let deficit = 0;
      for (let value = hi - size + 1; value <= hi; value += 1) {
        const list = byRank.get(value);
        if (list && list.length > 0) picked.push(list[0]);
        else deficit += 1;
      }
      if (deficit > jokers.length) continue;
      for (let i = 0; i < deficit; i += 1) picked.push(jokers[i]);
      add(picked);
    }
  }

  // 连对：每点凑一对，癞子可补半对或自组一对
  for (let pairCount = 2; pairCount * 2 <= cards.length && pairCount <= 12; pairCount += 1) {
    for (let hi = pairCount + 2; hi <= 14; hi += 1) {
      const picked = [];
      let deficit = 0;
      for (let value = hi - pairCount + 1; value <= hi; value += 1) {
        const list = byRank.get(value) ?? [];
        const take = Math.min(2, list.length);
        for (let i = 0; i < take; i += 1) picked.push(list[i]);
        deficit += 2 - take;
      }
      if (deficit > jokers.length) continue;
      for (let i = 0; i < deficit; i += 1) picked.push(jokers[i]);
      add(picked);
    }
  }

  return results;
}

// 机器人行动决策：{ action, delayMs }
export function decideGdyBotTurn(room, player) {
  const hand = player.holeCards;
  const lastPlay = room.hand.lastPlay;
  const candidates = enumerateGdyPlays(hand);

  // 跟牌时只有能压过上家的组合才可出（"一次出完"也必须先过这一关）
  const playable = lastPlay
    ? candidates.filter((entry) => gdyBeats(entry.play, lastPlay.play))
    : candidates;
  if (lastPlay && playable.length === 0) {
    return { action: { type: 'pass' }, delayMs: rand(400, 900) };
  }

  // 能一次出完直接赢
  const winning = playable.find((entry) => entry.cards.length === hand.length);
  if (winning) {
    return { action: { type: 'play', cards: winning.cards }, delayMs: rand(600, 1200) };
  }

  if (!lastPlay) {
    // 自由出牌：优先非炸弹（点数最小、同点出更多张），炸弹留到没得选
    const nonBombs = playable.filter((entry) => entry.play.type !== 5);
    if (nonBombs.length > 0) {
      nonBombs.sort((a, b) => a.play.rank - b.play.rank || b.play.size - a.play.size);
      const choice = nonBombs[0];
      return { action: { type: 'play', cards: choice.cards }, delayMs: rand(800, 1600) };
    }
    const bombs = playable.sort((a, b) => a.play.size - b.play.size || a.play.rank - b.play.rank);
    return { action: { type: 'play', cards: bombs[0].cards }, delayMs: rand(800, 1600) };
  }

  // 接牌：优先非炸弹中点数最小的；只能用炸弹时出最小的炸弹
  const nonBombBeaters = playable.filter((entry) => entry.play.type !== 5);
  const choice = nonBombBeaters.length > 0
    ? nonBombBeaters.sort((a, b) => a.play.rank - b.play.rank)[0]
    : playable.sort((a, b) => a.play.size - b.play.size || a.play.rank - b.play.rank)[0];
  return { action: { type: 'play', cards: choice.cards }, delayMs: rand(600, 1400) };
}

// 机器人日志描述（用于行动日志）
export function describeGdyBotAction(action) {
  if (!action) return '';
  if (action.type === 'pass') return '选择过牌';
  if (action.type === 'play') {
    const play = evaluateGdyPlay(action.cards);
    return play ? `打出 ${describeGdyPlay(play)}` : '出牌';
  }
  return action.type;
}
