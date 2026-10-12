// ============================================================
// 公平性隔离层
//
// 引擎把**原始 server-side room** 直接交给 AI，AI 技术上能读到：
//   1. 所有对手的 holeCards
//   2. room.hand.deck —— 已洗好的整副牌 + deckIndex
//      后者更危险：读 deck.slice(deckIndex) 就能拿到后面所有街的公共牌
//      和所有人的底牌，而且看起来像"性能优化"而不是作弊。
//
// 因此这里用**白名单逐字段**构造视图，绝不 spread。所有下游代码只碰 view，
// 即使调用方（含测试）传入原始 room，AI 物理上也看不到违规信息。
// ============================================================

import { cardId } from './prng.js';

const STREET_ORDER = { preflop: 0, flop: 1, turn: 2, river: 3 };

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toCardIds(cards) {
  if (!Array.isArray(cards)) return [];
  const ids = [];
  for (const card of cards) {
    if (!card || card === '??') continue;
    const id = cardId(card);
    if (id >= 0) ids.push(id);
  }
  return ids;
}

/** 由座位与庄位推算位置（引擎没有 position 字段） */
function resolvePosition(buttonSeat, activeSeats, heroSeat, street) {
  const n = activeSeats.length;
  if (n <= 1) return 'BTN';
  if (n === 2) {
    // 单挑时 buttonSeat === smallBlindSeat：翻前先行动，翻后后行动
    const isButton = heroSeat === buttonSeat;
    return street === 'preflop' ? (isButton ? 'SB' : 'BB') : (isButton ? 'BTN' : 'BB');
  }

  const buttonIdx = activeSeats.indexOf(buttonSeat);
  const heroIdx = activeSeats.indexOf(heroSeat);
  if (buttonIdx === -1 || heroIdx === -1) return 'MP';

  const dist = (heroIdx - buttonIdx + n) % n;
  if (dist === 0) return 'BTN';
  if (dist === 1) return 'SB';
  if (dist === 2) return 'BB';
  if (dist === 3) return 'UTG';
  if (dist === n - 1) return 'CO';
  if (dist === n - 2) return 'MP';
  return dist <= Math.floor(n / 2) ? 'UTG' : 'MP';
}

/**
 * 构造 AI 唯一可见的局面视图。
 *
 * @param room    引擎传入的原始房间（AI 不应再直接访问它）
 * @param player  引擎传入的 bot 玩家对象
 * @param actions 引擎算好的合法动作集合（toCall 以此为准，不从 room 反算）
 */
export function buildBotView(room, player, actions) {
  const hand = room?.hand ?? {};
  const config = room?.config ?? {};
  const rawPlayers = Array.isArray(room?.players) ? room.players : [];

  const bigBlind = Math.max(1, num(config.bigBlind, 10));
  const street = hand.street ?? 'preflop';
  const board = toCardIds(hand.board);
  const heroSeat = num(player?.seatIndex, -1);
  const heroStack = Math.max(0, num(player?.stack, 0));

  // ---- 对手：只暴露公开信息 ----
  const opponents = [];
  let liveOpponents = 0;
  let maxOppStack = 0;
  for (const entry of rawPlayers) {
    if (!entry) continue;
    if (entry.token != null && player?.token != null && entry.token === player.token) continue;
    if (entry.seatIndex != null && heroSeat >= 0 && entry.seatIndex === heroSeat) continue;
    const inHand = Boolean(entry.inHand);
    const folded = Boolean(entry.folded);
    if (!inHand || folded) continue;

    const stack = Math.max(0, num(entry.stack, 0));
    opponents.push({
      seatIndex: num(entry.seatIndex, -1),
      stack,
      streetContribution: Math.max(0, num(entry.streetContribution, 0)),
      allIn: Boolean(entry.allIn),
      isBot: Boolean(entry.isBot),
      // ⛔ 不含 holeCards / token
    });
    liveOpponents += 1;
    if (stack > maxOppStack) maxOppStack = stack;
  }

  // ---- 本街动作历史 ----
  const streetActions = {};
  const rawStreetActions = hand.playerStreetActions ?? {};
  for (const [seatKey, info] of Object.entries(rawStreetActions)) {
    const seat = Number(seatKey);
    if (!Number.isInteger(seat) || !info) continue;
    streetActions[seat] = {
      type: String(info.type ?? ''),
      amount: num(info.amount, 0),
      timestamp: num(info.timestamp, 0),
    };
  }

  // ---- 位置 ----
  const activeSeats = [];
  for (const entry of rawPlayers) {
    if (entry?.inHand && !entry.folded && entry.seatIndex != null) {
      activeSeats.push(entry.seatIndex);
    }
  }
  if (heroSeat >= 0 && !activeSeats.includes(heroSeat)) activeSeats.push(heroSeat);
  activeSeats.sort((a, b) => a - b);

  const buttonSeat = hand.buttonSeat == null ? num(room?.buttonSeat, -1) : num(hand.buttonSeat, -1);
  const heroPosition = resolvePosition(buttonSeat, activeSeats, heroSeat, street);

  // 是否处于有利位置（语义：后续街是否最后行动）
  // 翻后行动队列由 buildActionQueue(room, buttonSeat) 生成，从庄位下一位起、
  // 庄位收尾。因此按“距庄位的距离”排，行动次序是 1,2,...,n-1,0 —— 庄位最后。
  // 把庄位的次序值记为 n，谁最大谁就是有利位置。
  let isInPosition = false;
  if (activeSeats.length > 1 && buttonSeat >= 0) {
    const buttonIdx = activeSeats.indexOf(buttonSeat);
    const heroIdx = activeSeats.indexOf(heroSeat);
    if (buttonIdx >= 0 && heroIdx >= 0) {
      const n = activeSeats.length;
      const orderRank = (seatIdx) => {
        const d = (seatIdx - buttonIdx + n) % n;
        return d === 0 ? n : d;
      };
      const heroRank = orderRank(heroIdx);
      let maxRank = 0;
      for (let i = 0; i < n; i += 1) {
        const seat = activeSeats[i];
        const seatPlayer = rawPlayers.find((entry) => entry?.seatIndex === seat);
        // 已全下的玩家不再行动，不参与次序竞争
        if (seatPlayer?.allIn) continue;
        if (orderRank(i) > maxRank) maxRank = orderRank(i);
      }
      isInPosition = heroRank > 0 && heroRank === maxRank;
    }
  }

  // ---- 动作集合：完全信任引擎传入的值 ----
  const toCall = Math.max(0, num(actions?.toCall, 0));
  const viewActions = {
    toCall,
    canCheck: actions ? Boolean(actions.canCheck) : toCall === 0,
    canCall: actions ? Boolean(actions.canCall) : toCall > 0,
    canRaise: actions ? Boolean(actions.canRaise) : false,
    minRaiseTo: Math.max(0, Math.round(num(actions?.minRaiseTo, 0))),
    maxRaiseTo: Math.max(0, Math.round(num(actions?.maxRaiseTo, 0))),
    isCallOnly: Boolean(actions?.isCallOnly),
  };

  // ---- 底池与下注几何 ----
  const pot = Math.max(0, num(hand.pot, 0));
  const currentBet = Math.max(0, num(hand.currentBet, 0));
  const lastFullBet = Math.max(0, num(hand.lastFullBet, 0));
  const minRaiseSize = Math.max(0, num(hand.minRaiseSize, bigBlind));

  // 上一注额水平是精确的：加注后 lastFullBet = 本轮注额到，minRaiseSize = 本次增量
  const previousLevel = lastFullBet > 0 ? Math.max(0, lastFullBet - minRaiseSize) : 0;
  const betFacing = Math.max(0, currentBet - previousLevel);

  // 本街开始时的底池 = 当前底池 − 所有人本街已投入（精确）
  // 注意：测试构造的残缺 room 里 hero 可能不在 room.players 中，需单独补上
  let streetInvested = 0;
  let belowPrevious = 0;
  for (const entry of rawPlayers) {
    if (!entry) continue;
    const contributed = Math.max(0, num(entry.streetContribution, 0));
    streetInvested += contributed;
    belowPrevious += Math.min(contributed, previousLevel);
  }
  const heroInRoster = rawPlayers.some((entry) => entry
    && ((entry.token != null && entry.token === player?.token)
      || (heroSeat >= 0 && entry.seatIndex === heroSeat)));
  if (!heroInRoster) {
    const heroContributed = Math.max(0, num(player?.streetContribution, 0));
    streetInvested += heroContributed;
    belowPrevious += Math.min(heroContributed, previousLevel);
  }
  const potBeforeStreet = Math.max(0, pot - streetInvested);
  const potBeforeBet = potBeforeStreet + belowPrevious;

  // ---- 筹码深度 ----
  const effectiveStack = liveOpponents > 0 ? Math.min(heroStack, maxOppStack) : heroStack;
  const effBB = effectiveStack / bigBlind;
  const spr = effectiveStack / Math.max(1, pot);

  // ---- 进攻者识别 ----
  let aggressorSeat = null;
  let aggressorTimestamp = -Infinity;
  for (const [seatKey, info] of Object.entries(streetActions)) {
    const seat = Number(seatKey);
    if (seat === heroSeat) continue;
    if (info.type !== 'raise' && info.type !== 'allin') continue;
    if (info.timestamp >= aggressorTimestamp) {
      aggressorTimestamp = info.timestamp;
      aggressorSeat = seat;
    }
  }

  const wasPreRaiser = hand.preflopAggrSeat != null && num(hand.preflopAggrSeat, -1) === heroSeat;
  const heroIsBigBlind = num(hand.bigBlindSeat, -1) === heroSeat;

  return {
    code: String(room?.code ?? ''),
    gameType: String(room?.gameType ?? 'texas'),
    config: {
      bigBlind,
      smallBlind: Math.max(1, num(config.smallBlind, bigBlind / 2)),
      maxSeats: Math.max(2, num(config.maxSeats, 9)),
      startingStack: Math.max(0, num(config.startingStack, 1000)),
    },
    hand: {
      id: num(hand.id, 0),
      street,
      streetIndex: STREET_ORDER[street] ?? 0,
      board,
      pot,
      currentBet,
      minRaiseSize,
      lastFullBet,
      buttonSeat,
      smallBlindSeat: num(hand.smallBlindSeat, -1),
      bigBlindSeat: num(hand.bigBlindSeat, -1),
      actionQueue: Array.isArray(hand.actionQueue) ? hand.actionQueue.slice() : [],
      callOnlySeats: Array.isArray(hand.callOnlySeats) ? hand.callOnlySeats.slice() : [],
      playerStreetActions: streetActions,
      preflopAggrSeat: hand.preflopAggrSeat == null ? null : num(hand.preflopAggrSeat, -1),
      // ⛔ 不含 deck / deckIndex / sidePots / winners / shownCards / revealed
    },
    hero: {
      token: String(player?.token ?? ''),
      seatIndex: heroSeat,
      stack: heroStack,
      holeCards: toCardIds(player?.holeCards),
      streetContribution: Math.max(0, num(player?.streetContribution, 0)),
      handContribution: Math.max(0, num(player?.handContribution, 0)),
      actionCount: num(player?.actionCount, 0),
      botLevel: String(player?.botLevel ?? ''),
      botNonce: num(player?.botNonce, 0),
    },
    opponents,
    actions: viewActions,
    derived: {
      heroPosition,
      isInPosition,
      liveOpponents,
      effectiveStack,
      effBB,
      spr,
      pot,
      toCall,
      potOdds: toCall > 0 ? toCall / (pot + toCall) : 0,
      betFacing,
      potBeforeBet,
      // 最低防守频率：对手下注 betFacing 进 potBeforeBet 时，为不被无脑诈唬剥削所需的最小防守比例
      mdf: toCall > 0 && betFacing > 0 ? 1 - betFacing / (potBeforeBet + betFacing) : 0,
      // 诈唬盈亏平衡频率
      alpha: toCall > 0 && betFacing > 0 ? betFacing / (potBeforeBet + betFacing) : 0,
      facingRaise: aggressorSeat !== null && toCall > 0,
      aggressorSeat,
      wasPreRaiser,
      heroIsBigBlind,
      isMultiway: liveOpponents >= 2,
      isHeadsUp: liveOpponents === 1,
    },
  };
}
