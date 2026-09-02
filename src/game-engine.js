import { randomUUID } from 'node:crypto';
import {
  bestHandOfSeven,
  compareHandRanks,
  createDeck,
  describeHandRank,
  formatCard,
  seatOrderFrom,
  shuffleDeck,
} from './poker.js';
import { decideBotTurn, normalizeBotLevel, botLevelLabel } from './bot-ai.js';

const DEFAULT_CONFIG = {
  maxSeats: 9,
  startingStack: 2000,
  smallBlind: 10,
  bigBlind: 20,
  actionTimeoutMs: 30000,
  disconnectGraceMs: 120000,
  roomCleanupEnabled: true,
  roomMaxAgeMs: 30 * 60 * 1000,
};

const now = () => Date.now();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export { DEFAULT_CONFIG };

export function makeToken(token) {
  return typeof token === 'string' && token.trim() ? token.trim() : randomUUID();
}

function makeRoomCode(existingCodes) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (existingCodes.has(code));
  return code;
}

function normalizedNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeConfig(config = {}) {
  const normalized = {
    maxSeats: clamp(Math.floor(normalizedNumber(config.maxSeats ?? DEFAULT_CONFIG.maxSeats, DEFAULT_CONFIG.maxSeats)), 2, 9),
    startingStack: clamp(Math.floor(normalizedNumber(config.startingStack ?? DEFAULT_CONFIG.startingStack, DEFAULT_CONFIG.startingStack)), 100, 1000000),
    smallBlind: clamp(Math.floor(normalizedNumber(config.smallBlind ?? DEFAULT_CONFIG.smallBlind, DEFAULT_CONFIG.smallBlind)), 1, 1000000),
    bigBlind: clamp(Math.floor(normalizedNumber(config.bigBlind ?? DEFAULT_CONFIG.bigBlind, DEFAULT_CONFIG.bigBlind)), 2, 1000000),
    actionTimeoutMs: clamp(Math.floor(normalizedNumber(config.actionTimeoutMs ?? DEFAULT_CONFIG.actionTimeoutMs, DEFAULT_CONFIG.actionTimeoutMs)), 5000, 120000),
    disconnectGraceMs: clamp(Math.floor(normalizedNumber(config.disconnectGraceMs ?? DEFAULT_CONFIG.disconnectGraceMs, DEFAULT_CONFIG.disconnectGraceMs)), 10000, 900000),
  };

  if (normalized.smallBlind >= normalized.bigBlind) {
    throw new Error('\u5c0f\u76f2\u5fc5\u987b\u5c0f\u4e8e\u5927\u76f2');
  }

  return normalized;
}

function makePlayer(token, name, stack) {
  return {
    token: makeToken(token),
    name: name?.trim() || '玩家',
    connected: true,
    lastSeenAt: now(),
    disconnectedAt: null,
    seatIndex: null,
    seatJoinHandNo: 1,
    everSeated: false,
    stack,
    totalBuyIn: stack, // 追踪总投入（初始筹码 + 所有补充）
    sitOut: false,
    ready: false,
    isHost: false,
    inHand: false,
    folded: false,
    allIn: false,
    holeCards: [],
    streetContribution: 0,
    handContribution: 0,
    actedAt: null,
    actionCount: 0,
    showdownRank: null,
    isBot: false,
    botLevel: null,
    botCreatedAt: null,
  };
}

function normalizePlayer(player, fallbackStack) {
  return {
    ...makePlayer(player.token, player.name, fallbackStack),
    ...player,
    token: makeToken(player.token),
    name: player.name?.trim() || '玩家',
    connected: Boolean(player.connected),
    lastSeenAt: Number(player.lastSeenAt ?? now()),
    disconnectedAt: player.disconnectedAt == null ? null : Number(player.disconnectedAt),
    seatIndex: player.seatIndex == null ? null : Number(player.seatIndex),
    seatJoinHandNo: Number(player.seatJoinHandNo ?? 1),
    everSeated: Boolean(player.everSeated),
    stack: Number(player.stack ?? fallbackStack),
    totalBuyIn: Number(player.totalBuyIn ?? player.stack ?? fallbackStack),
    sitOut: Boolean(player.sitOut),
    ready: Boolean(player.ready),
    isHost: Boolean(player.isHost),
    inHand: Boolean(player.inHand),
    folded: Boolean(player.folded),
    allIn: Boolean(player.allIn),
    holeCards: Array.isArray(player.holeCards) ? [...player.holeCards] : [],
    streetContribution: Number(player.streetContribution ?? 0),
    handContribution: Number(player.handContribution ?? 0),
    actedAt: player.actedAt == null ? null : Number(player.actedAt),
    actionCount: Number(player.actionCount ?? 0),
    showdownRank: player.showdownRank ?? null,
    isBot: Boolean(player.isBot),
    botLevel: player.botLevel ?? null,
    botCreatedAt: player.botCreatedAt == null ? null : Number(player.botCreatedAt),
    botDecision: null,
  };
}

function normalizeHand(hand, config) {
  if (!hand) return null;
  return {
    id: Number(hand.id ?? 0),
    status: hand.status || 'running',
    street: hand.street || 'preflop',
    deck: Array.isArray(hand.deck) ? [...hand.deck] : shuffleDeck(createDeck()),
    deckIndex: Number(hand.deckIndex ?? 0),
    board: Array.isArray(hand.board) ? [...hand.board] : [],
    pot: Number(hand.pot ?? 0),
    finalPot: Number(hand.finalPot ?? 0),
    buttonSeat: hand.buttonSeat == null ? null : Number(hand.buttonSeat),
    smallBlindSeat: hand.smallBlindSeat == null ? null : Number(hand.smallBlindSeat),
    bigBlindSeat: hand.bigBlindSeat == null ? null : Number(hand.bigBlindSeat),
    currentBet: Number(hand.currentBet ?? 0),
    minRaiseSize: Number(hand.minRaiseSize ?? config.bigBlind),
    lastFullBet: Number(hand.lastFullBet ?? 0),
    actionQueue: Array.isArray(hand.actionQueue) ? hand.actionQueue.map(Number) : [],
    turnDeadlineAt: hand.turnDeadlineAt == null ? null : Number(hand.turnDeadlineAt),
    dealerMessage: hand.dealerMessage || '',
    winners: Array.isArray(hand.winners) ? [...hand.winners] : [],
    sidePots: Array.isArray(hand.sidePots) ? [...hand.sidePots] : [],
    revealed: Boolean(hand.revealed ?? false),
    showOffer: hand.showOffer && typeof hand.showOffer === 'object' ? { ...hand.showOffer } : null,
    shownCards: hand.shownCards && typeof hand.shownCards === 'object' ? { ...hand.shownCards, cards: [...(hand.shownCards.cards ?? [])] } : null,
    callOnlySeats: Array.isArray(hand.callOnlySeats) ? hand.callOnlySeats.map(Number) : [],
    playerStreetActions: hand.playerStreetActions && typeof hand.playerStreetActions === 'object' ? { ...hand.playerStreetActions } : {},
    preflopAggrSeat: hand.preflopAggrSeat == null ? null : Number(hand.preflopAggrSeat),
  };
}

export function hydrateRoom(snapshot) {
  const config = normalizeConfig(snapshot.config);
  return {
    code: snapshot.code,
    name: snapshot.name || `牌桌 ${snapshot.code}`,
    createdAt: Number(snapshot.createdAt ?? now()),
    updatedAt: Number(snapshot.updatedAt ?? snapshot.createdAt ?? now()),
    config,
    handNo: Number(snapshot.handNo ?? 0),
    buttonSeat: snapshot.buttonSeat == null ? null : Number(snapshot.buttonSeat),
    players: Array.isArray(snapshot.players)
      ? snapshot.players.map((player) => normalizePlayer(player, config.startingStack))
      : [],
    departedPlayers: Array.isArray(snapshot.departedPlayers) ? [...snapshot.departedPlayers] : [],
    hand: normalizeHand(snapshot.hand, config),
    log: Array.isArray(snapshot.log) ? [...snapshot.log] : [],
    recentHands: Array.isArray(snapshot.recentHands) ? [...snapshot.recentHands] : [],
    socketMap: {},
  };
}

function stripRuntime(room) {
  const { socketMap, ...snapshot } = room;
  return snapshot;
}

function appendLog(room, type, text) {
  room.log.push({ at: now(), type, text });
  if (room.log.length > 100) {
    room.log.splice(0, room.log.length - 100);
  }
}

function playerAtSeat(room, seatIndex) {
  return room.players.find((player) => player.seatIndex === seatIndex) ?? null;
}

function nextSeat(room, seatIndex, predicate = () => true) {
  if (seatIndex == null) return null;
  for (let offset = 1; offset <= room.config.maxSeats; offset += 1) {
    const candidate = (seatIndex + offset) % room.config.maxSeats;
    const player = playerAtSeat(room, candidate);
    if (player && predicate(player)) {
      return candidate;
    }
  }
  return null;
}

function seatOrderStartingAt(startSeat, maxSeats) {
  if (startSeat == null) return [];
  return Array.from({ length: maxSeats }, (_, offset) => (startSeat + offset) % maxSeats);
}

function minimumFullRaiseTo(room) {
  if (!room.hand) return room.config.bigBlind;
  if (room.hand.lastFullBet > 0) {
    return room.hand.lastFullBet + room.hand.minRaiseSize;
  }
  return room.config.bigBlind;
}

function currentPot(room) {
  return room.players.reduce((sum, player) => sum + player.handContribution, 0);
}

function canJoinNextHand(player) {
  return player.seatIndex !== null && player.stack > 0 && !player.sitOut;
}

function returnToGame(room, player) {
  if (player && player.sitOut) {
    player.sitOut = false;
    appendLog(room, 'system', `${player.name} 回到游戏`);
  }
}

function eligibleReadyPlayers(room) {
  return room.players.filter((player) => player.seatIndex !== null && player.stack > 0 && !player.sitOut && !player.isBot);
}

function allReadyPlayers(room) {
  const players = eligibleReadyPlayers(room);
  return players.length > 0 && players.every((player) => player.ready);
}

function canAct(player) {
  return player.inHand && !player.folded && !player.allIn;
}

function buildActionQueue(room, seatBeforeFirstActor) {
  if (seatBeforeFirstActor == null) return [];
  return seatOrderFrom(seatBeforeFirstActor, room.config.maxSeats)
    .map((seat) => playerAtSeat(room, seat))
    .filter((player) => {
      if (!player || !canAct(player)) return false;
      if (room.hand?.callOnlySeats?.includes(player.seatIndex)) {
        return Math.max(0, room.hand.currentBet - player.streetContribution) > 0;
      }
      return true;
    })
    .map((player) => player.seatIndex);
}

function resetPlayerForHand(player) {
  player.inHand = false;
  player.folded = false;
  player.allIn = false;
  player.ready = false;
  player.holeCards = [];
  player.streetContribution = 0;
  player.handContribution = 0;
  player.actedAt = null;
  player.actionCount = 0;
  player.showdownRank = null;
  player.botDecision = null;
}

function draw(room) {
  return room.hand.deck[room.hand.deckIndex++];
}

function revealNextStreet(room) {
  if (room.hand.street === 'preflop') {
    room.hand.board.push(draw(room), draw(room), draw(room));
    room.hand.street = 'flop';
    appendLog(room, 'board', `翻牌 ${room.hand.board.slice(0, 3).map(formatCard).join(' ')}`);
    return;
  }

  if (room.hand.street === 'flop') {
    room.hand.board.push(draw(room));
    room.hand.street = 'turn';
    appendLog(room, 'board', `转牌 ${formatCard(room.hand.board[3])}`);
    return;
  }

  if (room.hand.street === 'turn') {
    room.hand.board.push(draw(room));
    room.hand.street = 'river';
    appendLog(room, 'board', `河牌 ${formatCard(room.hand.board[4])}`);
  }
}

function revealBoardToRiver(room) {
  while (room.hand.board.length < 5) {
    if (['preflop', 'flop', 'turn'].includes(room.hand.street)) {
      revealNextStreet(room);
      continue;
    }
    room.hand.board.push(draw(room));
  }
}

function postBlind(player, blindAmount) {
  if (!player) return;
  const amount = Math.min(blindAmount, player.stack);
  player.stack -= amount;
  player.streetContribution += amount;
  player.handContribution += amount;
  if (player.stack === 0) {
    player.allIn = true;
  }
}

function commitContribution(room, player, totalStreetContribution) {
  const delta = totalStreetContribution - player.streetContribution;
  if (delta < 0) throw new Error('下注金额无效');
  if (delta > player.stack) throw new Error('筹码不足');
  player.stack -= delta;
  player.streetContribution = totalStreetContribution;
  player.handContribution += delta;
  if (player.stack === 0) {
    player.allIn = true;
  }
  room.hand.pot = currentPot(room);
}

export function distributePots(room) {
  const totalPot = currentPot(room);
  const contributors = room.players.filter((player) => player.handContribution > 0);
  const levels = [...new Set(contributors.map((player) => player.handContribution))].sort((a, b) => a - b);
  const oddChipOrder = seatOrderFrom(room.buttonSeat ?? 0, room.config.maxSeats);
  const livePlayers = room.players.filter((player) => player.inHand && !player.folded);
  const winnings = new Map();
  const sidePots = [];
  let previousLevel = 0;

  for (const player of livePlayers) {
    player.showdownRank = bestHandOfSeven([...player.holeCards, ...room.hand.board]);
  }

  const awardPot = (amount, eligible, level) => {
    if (amount <= 0 || !eligible.length) return;

    let bestRank = eligible[0].showdownRank;
    for (const player of eligible.slice(1)) {
      if (compareHandRanks(player.showdownRank, bestRank) > 0) {
        bestRank = player.showdownRank;
      }
    }

    const winners = eligible
      .filter((player) => compareHandRanks(player.showdownRank, bestRank) === 0)
      .sort((left, right) => oddChipOrder.indexOf(left.seatIndex) - oddChipOrder.indexOf(right.seatIndex));

    const share = Math.floor(amount / winners.length);
    let remainder = amount % winners.length;
    const winnerSummaries = [];

    for (const winner of winners) {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      const won = share + extra;
      winnings.set(winner.token, (winnings.get(winner.token) ?? 0) + won);
      winnerSummaries.push({
        token: winner.token,
        name: winner.name,
        amount: won,
        rank: winner.showdownRank,
        handLabel: describeHandRank(winner.showdownRank),
        holeCards: [...winner.holeCards],
      });
    }

    sidePots.push({ level, amount, winners: winnerSummaries });
  };

  for (const level of levels) {
    const potPlayers = contributors.filter((player) => player.handContribution >= level);
    const amount = (level - previousLevel) * potPlayers.length;
    let eligible = potPlayers.filter((player) => player.inHand && !player.folded);

    if (!eligible.length) eligible = livePlayers;
    awardPot(amount, eligible, level);
    previousLevel = level;
  }

  for (const player of room.players) {
    const won = winnings.get(player.token) ?? 0;
    if (won > 0) player.stack += won;
  }

  const aggregate = new Map();
  for (const winner of sidePots.flatMap((sidePot) => sidePot.winners)) {
    const existing = aggregate.get(winner.token);
    if (existing) {
      existing.amount += winner.amount;
    } else {
      aggregate.set(winner.token, { ...winner });
    }
  }

  room.hand.finalPot = totalPot;
  room.hand.sidePots = sidePots;
  room.hand.winners = [...aggregate.values()];
  return { sidePots, winners: room.hand.winners, totalPot };
}

function persistHand(store, room, details) {
  // 收集所有参与者（包括当前玩家和已离场玩家）的盈亏信息
  const participants = [];

  // 当前在房间的玩家
  for (const player of room.players) {
    if (player.everSeated) {
      participants.push({
        token: player.token,
        name: player.name,
        isBot: player.isBot ?? false,
        stackBefore: (player.handStartStack ?? player.stack),
        stackAfter: player.stack,
        profitLoss: player.stack - (player.handStartStack ?? player.stack),
      });
    }
  }

  // 已离场的玩家（包括破产机器人）
  for (const departed of room.departedPlayers ?? []) {
    participants.push({
      token: departed.token,
      name: departed.name,
      isBot: departed.isBot ?? false,
      stackBefore: departed.handStartStack ?? departed.stack,
      stackAfter: departed.stack,
      profitLoss: departed.stack - (departed.handStartStack ?? departed.stack),
      departed: true,
    });
  }

  store.saveHandHistory(room.code, room.hand.id, {
    handNo: room.hand.id,
    board: [...room.hand.board],
    winners: [...room.hand.winners],
    sidePots: [...room.hand.sidePots],
    logs: [...room.log],
    participants,
    ...details,
  });
}

function finishByFold(room, store) {
  const winner = room.players.find((player) => player.inHand && !player.folded) ?? null;
  if (!winner) return room.hand;

  const won = currentPot(room);
  winner.stack += won;
  room.hand.status = 'finished';
  room.hand.turnDeadlineAt = null;
  room.hand.actionQueue = [];
  room.hand.currentBet = 0;
  room.hand.lastFullBet = 0;
  room.hand.minRaiseSize = room.config.bigBlind;
  room.hand.finalPot = won;
  room.hand.pot = 0;
  room.hand.dealerMessage = winner.name + ' \u8d62\u4e0b\u5e95\u6c60';
  room.hand.winners = [{ token: winner.token, name: winner.name, amount: won, rank: null, handLabel: '\u5f03\u724c\u83b7\u80dc', holeCards: [] }];
  room.hand.sidePots = [];
  room.hand.revealed = false;
  // 弃牌获胜：真人赢家获得一次秀牌机会（机器人从不秀牌）
  room.hand.showOffer = winner.isBot ? null : { token: winner.token, seatIndex: winner.seatIndex };
  room.hand.shownCards = null;
  room.hand.callOnlySeats = [];

  room.recentHands.unshift({
    handNo: room.hand.id,
    board: [...room.hand.board],
    winners: [...room.hand.winners],
    sidePots: [],
    finalPot: won,
    finishedAt: now(),
    byFold: true,
  });
  room.recentHands = room.recentHands.slice(0, 20);
  persistHand(store, room, { byFold: true, finalPot: won });
  return room.hand;
}

function showFoldWinCards(room, token, { showCount, side } = {}) {
  const hand = room.hand;
  if (!hand || hand.status !== 'finished') throw new Error('对局尚未结束');
  if (hand.revealed) throw new Error('摊牌局无需秀牌');
  if (!hand.showOffer || hand.showOffer.token !== token) throw new Error('只有弃牌获胜者可以秀牌');
  if (hand.shownCards) throw new Error('已经秀过牌了');

  const winner = room.players.find((player) => player.token === token);
  if (!winner || !Array.isArray(winner.holeCards) || winner.holeCards.length !== 2) {
    throw new Error('手牌数据异常');
  }
  const count = Number(showCount);
  if (count !== 1 && count !== 2) throw new Error('秀牌数量必须为 1 或 2');
  const cards = count === 2
    ? [...winner.holeCards]
    : [winner.holeCards[Number(side) === 1 ? 1 : 0]];

  hand.shownCards = { token: winner.token, seatIndex: winner.seatIndex, cards };
  hand.winners = hand.winners.map((entry) => (
    entry.token === winner.token ? { ...entry, holeCards: [...cards] } : entry
  ));
  const recent = room.recentHands.find((entry) => entry.handNo === hand.id);
  if (recent) {
    recent.winners = recent.winners.map((entry) => (
      entry.token === winner.token ? { ...entry, holeCards: [...cards] } : entry
    ));
  }
  appendLog(room, 'hand', `${winner.name} 亮出了手牌`);
  return hand;
}

function resolveShowdown(room, store) {
  revealBoardToRiver(room);
  const { totalPot } = distributePots(room);
  room.hand.status = 'finished';
  room.hand.turnDeadlineAt = null;
  room.hand.actionQueue = [];
  room.hand.currentBet = 0;
  room.hand.lastFullBet = 0;
  room.hand.minRaiseSize = room.config.bigBlind;
  room.hand.finalPot = totalPot;
  room.hand.pot = 0;
  room.hand.dealerMessage = '\u644a\u724c';
  room.hand.revealed = true;
  room.hand.callOnlySeats = [];

  room.recentHands.unshift({
    handNo: room.hand.id,
    board: [...room.hand.board],
    winners: [...room.hand.winners],
    sidePots: [...room.hand.sidePots],
    finalPot: totalPot,
    finishedAt: now(),
  });
  room.recentHands = room.recentHands.slice(0, 20);
  persistHand(store, room, { finalPot: totalPot });
  return room.hand;
}

function advanceStreet(room, store) {
  for (const player of room.players) {
    player.streetContribution = 0;
  }
  room.hand.currentBet = 0;
  room.hand.lastFullBet = 0;
  room.hand.minRaiseSize = room.config.bigBlind;
  room.hand.callOnlySeats = [];
  room.hand.playerStreetActions = {};

  if (room.hand.street === 'river') {
    return resolveShowdown(room, store);
  }

  revealNextStreet(room);
  room.hand.actionQueue = buildActionQueue(room, room.buttonSeat);
  room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
  room.hand.dealerMessage = room.hand.actionQueue.length
    ? `${playerAtSeat(room, room.hand.actionQueue[0])?.name ?? '下一位'}行动`
    : '无人可行动';
  room.hand.pot = currentPot(room);
  return room.hand;
}

function applyPlayerAction(room, player, action) {
  const oldCurrentBet = room.hand.currentBet;
  const oldLastFullBet = room.hand.lastFullBet ?? 0;
  const toCall = Math.max(0, oldCurrentBet - player.streetContribution);
  const type = action?.type;
  const amount = Number(action?.amount ?? 0);
  const isCallOnly = room.hand.callOnlySeats.includes(player.seatIndex);
  const oldQueue = [...room.hand.actionQueue];
  const remainingQueue = oldQueue.slice(1);

  const cleanCallOnlySeats = () => {
    room.hand.callOnlySeats = [...new Set(room.hand.callOnlySeats)]
      .filter((seat) => {
        const seatPlayer = playerAtSeat(room, seat);
        return seatPlayer && canAct(seatPlayer) && Math.max(0, room.hand.currentBet - seatPlayer.streetContribution) > 0;
      });
  };

  const consumeCurrentTurn = () => {
    room.hand.actionQueue = remainingQueue;
    room.hand.callOnlySeats = room.hand.callOnlySeats.filter((seat) => seat !== player.seatIndex);
    cleanCallOnlySeats();
  };

  const reopenActionAfterFullRaise = () => {
    room.hand.callOnlySeats = [];
    room.hand.actionQueue = buildActionQueue(room, player.seatIndex)
      .filter((seat) => seat !== player.seatIndex);
  };

  const continueAfterIncompleteRaise = () => {
    const queue = buildActionQueue(room, player.seatIndex)
      .filter((seat) => seat !== player.seatIndex);
    const newCallOnlySeats = queue.filter((seat) => {
      const seatPlayer = playerAtSeat(room, seat);
      return seatPlayer
        && Math.max(0, room.hand.currentBet - seatPlayer.streetContribution) > 0
        && !remainingQueue.includes(seat);
    });
    room.hand.actionQueue = queue;
    room.hand.callOnlySeats = [...new Set([
      ...room.hand.callOnlySeats.filter((seat) => seat !== player.seatIndex),
      ...newCallOnlySeats,
    ])];
    cleanCallOnlySeats();
  };

  const recordAction = (displayType, displayAmount = amount) => {
    player.actedAt = now();
    player.actionCount += 1;
    room.hand.playerStreetActions[player.seatIndex] = {
      type: displayType,
      amount: displayAmount,
      timestamp: now(),
    };
  };

  const applyAggressiveAction = (target, verb) => {
    if (isCallOnly && target > oldCurrentBet) throw new Error('\u8be5\u884c\u52a8\u53ea\u80fd\u8ddf\u6ce8\u6216\u5f03\u724c');
    if (target <= oldCurrentBet) {
      commitContribution(room, player, target);
      consumeCurrentTurn();
      return player.name + ' ' + verb + ' ' + target;
    }

    const maxTarget = player.streetContribution + player.stack;
    const minFullRaiseTo = minimumFullRaiseTo(room);
    if (target > maxTarget) throw new Error('\u7b79\u7801\u4e0d\u8db3');
    if (target < minFullRaiseTo && target !== maxTarget) throw new Error('\u52a0\u6ce8\u4e0d\u8db3\u6700\u5c0f\u52a0\u6ce8\u989d');

    commitContribution(room, player, target);
    room.hand.currentBet = target;

    // 记录翻牌前首个加注者（供 C-bet 逻辑跨街使用）
    if (room.hand.street === 'preflop' && room.hand.preflopAggrSeat == null) {
      room.hand.preflopAggrSeat = player.seatIndex;
    }

    if (target >= minFullRaiseTo) {
      room.hand.lastFullBet = target;
      room.hand.minRaiseSize = target - oldLastFullBet;
      reopenActionAfterFullRaise();
    } else {
      continueAfterIncompleteRaise();
    }

    return player.allIn
      ? player.name + ' \u5168\u4e0b ' + target
      : player.name + ' ' + verb + '\u5230 ' + target;
  };

  let message = '';

  if (type === 'fold') {
    player.folded = true;
    consumeCurrentTurn();
    message = player.name + ' \u5f03\u724c';
    recordAction('fold');
  } else if (type === 'check') {
    if (toCall > 0) throw new Error('\u4e0d\u80fd\u8fc7\u724c');
    consumeCurrentTurn();
    message = player.name + ' \u8fc7\u724c';
    recordAction('check');
  } else if (type === 'call') {
    if (toCall <= 0) throw new Error('\u65e0\u9700\u8ddf\u6ce8');
    const callAmount = Math.min(toCall, player.stack);
    commitContribution(room, player, player.streetContribution + callAmount);
    consumeCurrentTurn();
    message = callAmount < toCall
      ? player.name + ' \u8ddf\u6ce8\u5e76\u5168\u4e0b'
      : player.name + ' \u8ddf\u6ce8';
    recordAction(callAmount < toCall ? 'allin' : 'call', player.streetContribution);
  } else if (type === 'raise') {
    if (isCallOnly) throw new Error('\u8be5\u884c\u52a8\u53ea\u80fd\u8ddf\u6ce8\u6216\u5f03\u724c');
    const target = Number.isFinite(amount) ? Math.floor(amount) : 0;
    if (target <= oldCurrentBet) throw new Error('\u52a0\u6ce8\u91d1\u989d\u4e0d\u8db3');
    message = applyAggressiveAction(target, '\u52a0\u6ce8');
    recordAction(player.allIn ? 'allin' : 'raise', target);
  } else if (type === 'allin') {
    const target = player.streetContribution + player.stack;
    if (target <= player.streetContribution) throw new Error('\u7b79\u7801\u4e0d\u8db3');
    message = applyAggressiveAction(target, '\u5168\u4e0b');
    recordAction('allin', target);
  } else {
    throw new Error('\u672a\u77e5\u884c\u52a8');
  }

  room.hand.dealerMessage = message;
  room.hand.pot = currentPot(room);
  return { message, log: message };
}

function actionOptionsFor(room, player) {
  const toCall = Math.max(0, room.hand.currentBet - player.streetContribution);
  const maxRaiseTo = player.streetContribution + player.stack;
  const minRaiseTo = Math.min(minimumFullRaiseTo(room), maxRaiseTo);
  const isCallOnly = room.hand.callOnlySeats.includes(player.seatIndex);
  return {
    toCall,
    canCheck: toCall === 0,
    canCall: toCall > 0 && player.stack > 0,
    canRaise: !isCallOnly && maxRaiseTo > room.hand.currentBet && maxRaiseTo >= minimumFullRaiseTo(room),
    minRaiseTo,
    maxRaiseTo,
    isCallOnly,
  };
}

function availableActions(room, viewerToken) {
  if (!room.hand || room.hand.status !== 'running') return null;
  const viewer = room.players.find((player) => player.token === viewerToken);
  if (!viewer || room.hand.actionQueue[0] !== viewer.seatIndex || !canAct(viewer)) return null;
  return actionOptionsFor(room, viewer);
}

function buildAvailableActions(room, player) {
  return actionOptionsFor(room, player);
}

function playerView(room, viewerToken, player) {
  const isViewer = player.token === viewerToken;
  const viewer = room.players.find((entry) => entry.token === viewerToken);
  const canManage = viewer?.isHost && !isViewer && !player.isHost;
  // 秀牌后所有人可见该赢家的手牌
  const shown = room.hand?.shownCards ?? null;
  const revealCards = isViewer || room.hand?.revealed || (shown !== null && shown.token === player.token);
  return {
    ...(canManage ? { targetToken: player.token } : {}),
    token: isViewer ? player.token : undefined,
    name: player.name,
    connected: player.connected,
    lastSeenAt: player.lastSeenAt,
    disconnectedAt: player.disconnectedAt,
    seatIndex: player.seatIndex,
    stack: player.stack,
    sitOut: player.sitOut,
    ready: player.ready,
    isHost: player.isHost,
    inHand: player.inHand,
    folded: player.folded,
    allIn: player.allIn,
    streetContribution: player.streetContribution,
    handContribution: player.handContribution,
    holeCards: revealCards ? [...player.holeCards] : (player.inHand ? ['??', '??'] : []),
    handLabel: revealCards && player.showdownRank ? describeHandRank(player.showdownRank) : null,
    isViewer,
    isBot: player.isBot || false,
    botLevel: player.botLevel || null,
  };
}

export function roomSummary(room) {
  return {
    code: room.code,
    name: room.name,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    seatsTaken: room.players.filter((player) => player.seatIndex !== null).length,
    seatsTotal: room.config.maxSeats,
    playersTotal: room.players.length,
    connectedPlayers: room.players.filter((player) => player.connected).length,
    handNo: room.handNo,
    handStatus: room.hand?.status ?? 'idle',
    street: room.hand?.street ?? null,
    pot: room.hand ? (room.hand.status === 'finished' ? (room.hand.finalPot ?? room.hand.pot ?? 0) : (room.hand.pot ?? 0)) : 0,
    boardCount: room.hand?.board?.length ?? 0,
  };
}

export function serializeRoom(room, viewerToken = null) {
  // 找到当前viewer对应的玩家对象
  const selfPlayer = viewerToken ? room.players.find(player => player.token === viewerToken) : null;
  
  return {
    summary: roomSummary(room),
    code: room.code,
    name: room.name,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    config: { ...room.config },
    handNo: room.handNo,
    buttonSeat: room.buttonSeat,
    players: room.players.map((player) => playerView(room, viewerToken, player)),
    self: selfPlayer ? {
      token: selfPlayer.token,
      name: selfPlayer.name,
      connected: selfPlayer.connected,
      lastSeenAt: selfPlayer.lastSeenAt,
      disconnectedAt: selfPlayer.disconnectedAt,
      seatIndex: selfPlayer.seatIndex,
      stack: selfPlayer.stack,
      sitOut: selfPlayer.sitOut,
      ready: selfPlayer.ready,
      isHost: selfPlayer.isHost,
      inHand: selfPlayer.inHand,
      folded: selfPlayer.folded,
      allIn: selfPlayer.allIn,
      streetContribution: selfPlayer.streetContribution,
      handContribution: selfPlayer.handContribution,
      holeCards: selfPlayer.holeCards,
      handLabel: selfPlayer.showdownRank ? describeHandRank(selfPlayer.showdownRank) : null,
      isBot: selfPlayer.isBot || false,
      botLevel: selfPlayer.botLevel || null,
    } : null,
    hand: room.hand ? {
      id: room.hand.id,
      status: room.hand.status,
      street: room.hand.street,
      buttonSeat: room.hand.buttonSeat,
      smallBlindSeat: room.hand.smallBlindSeat,
      bigBlindSeat: room.hand.bigBlindSeat,
      currentBet: room.hand.currentBet,
      minRaiseSize: room.hand.minRaiseSize,
      lastFullBet: room.hand.lastFullBet ?? 0,
      actionSeat: room.hand.actionQueue[0] ?? null,
      actionQueue: [...room.hand.actionQueue],
      turnDeadlineAt: room.hand.turnDeadlineAt,
      board: [...room.hand.board],
      pot: room.hand.pot,
      finalPot: room.hand.finalPot ?? 0,
      dealerMessage: room.hand.dealerMessage,
      winners: [...room.hand.winners],
      sidePots: [...room.hand.sidePots],
      revealed: room.hand.revealed,
      showOffer: room.hand.showOffer && room.hand.showOffer.token === viewerToken
        ? { ...room.hand.showOffer }
        : null,
      shownCards: room.hand.shownCards
        ? { ...room.hand.shownCards, cards: [...room.hand.shownCards.cards] }
        : null,
      playerStreetActions: { ...room.hand.playerStreetActions },
      availableActions: availableActions(room, viewerToken),
    } : null,
    log: [...room.log],
    recentHands: [...room.recentHands],
    viewerToken,
    // 服务端当前时间：客户端用它计算倒计时剩余量，免疫设备时钟偏移
    serverNow: now(),
  };
}

export class GameManager {
  constructor(store, { onUpdate, onHandStart, onClose, config } = {}) {
    this.store = store;
    this.onUpdate = onUpdate ?? (() => {});
    this.onHandStart = onHandStart ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.config = config || DEFAULT_CONFIG;
    this.rooms = new Map();

    for (const snapshot of this.store.listRooms()) {
      try {
        const room = hydrateRoom(snapshot);
        this.rooms.set(room.code, room);
      } catch (error) {
        console.warn(`跳过无法恢复的房间快照: ${snapshot?.code ?? '未知'} (${error.message})`);
      }
    }
  }

  emit(room) {
    room.updatedAt = now();
    this.store.saveRoom(stripRuntime(room));
    this.onUpdate(room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(String(code ?? '').trim().toUpperCase()) ?? null;
  }

  getRoomView(code, viewerToken = null) {
    const room = this.getRoom(code);
    return room ? serializeRoom(room, viewerToken) : null;
  }

  listRooms() {
    return [...this.rooms.values()].map(roomSummary);
  }

  listHandHistory(code, limit = 10) {
    return this.store.listHandHistory(String(code ?? '').trim().toUpperCase(), limit);
  }

  createRoom({ token, roomName, playerName, config = {} }) {
    const roomConfig = normalizeConfig(config);
    const room = {
      code: makeRoomCode(this.rooms),
      name: roomName?.trim() || '私人牌桌',
      createdAt: now(),
      updatedAt: now(),
      config: roomConfig,
      handNo: 0,
      buttonSeat: null,
      players: [],
      departedPlayers: [],
      hand: null,
      log: [],
      recentHands: [],
      socketMap: {},
    };

    const player = makePlayer(token, playerName, roomConfig.startingStack);
    player.isHost = true;
    player.seatIndex = 0;
    player.everSeated = true; // 房主创建房间即落座
    room.players.push(player);
    appendLog(room, 'room', `${player.name} 创建了房间`);
    this.rooms.set(room.code, room);
    this.emit(room);
    return { room, token: player.token };
  }

  joinRoom(code, { token, playerName }) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    const resolvedToken = makeToken(token);
    let player = room.players.find((entry) => entry.token === resolvedToken);

    if (!player) {
      if (room.players.length >= room.config.maxSeats + 12) {
        throw new Error('房间人数已满');
      }
      player = makePlayer(resolvedToken, playerName, room.config.startingStack);
      room.players.push(player);
      appendLog(room, 'room', `${player.name} 加入房间`);
    } else {
      if (playerName?.trim()) player.name = playerName.trim();
      player.connected = true;
      player.disconnectedAt = null;
      player.lastSeenAt = now();
    }

    this.emit(room);
    return { room, token: player.token };
  }

  resumeRoom(code, token) {
    const room = this.getRoom(code);
    if (!room) return null;
    const player = room.players.find((entry) => entry.token === token);
    if (!player) return null;
    player.connected = true;
    player.disconnectedAt = null;
    player.lastSeenAt = now();
    returnToGame(room, player);
    this.emit(room);
    return room;
  }

  connectSocket(code, token, socketId) {
    const room = this.getRoom(code);
    if (!room) return null;
    const player = room.players.find((entry) => entry.token === token);
    if (!player) return null;
    room.socketMap[token] = socketId;
    player.connected = true;
    player.disconnectedAt = null;
    player.lastSeenAt = now();
    returnToGame(room, player);
    this.emit(room);
    return room;
  }

  disconnectSocket(code, token, socketId) {
    const room = this.getRoom(code);
    if (!room) return null;
    if (socketId && room.socketMap[token] !== socketId) return room;
    delete room.socketMap[token];
    const player = room.players.find((entry) => entry.token === token);
    if (player) {
      player.connected = false;
      player.disconnectedAt = now();
      player.lastSeenAt = now();
      this.emit(room);
    }
    return room;
  }

  seatPlayer(code, token, seatIndex) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    const player = room.players.find((entry) => entry.token === token);
    if (!player) throw new Error('玩家不存在');
    if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= room.config.maxSeats) {
      throw new Error('座位无效');
    }
    const existing = playerAtSeat(room, seatIndex);
    if (existing && existing.token !== token) throw new Error('座位已被占用');
    if (room.hand?.status === 'running' && player.seatIndex !== null && player.seatIndex !== seatIndex) {
      throw new Error('本局中不能换座');
    }
    player.seatIndex = seatIndex;
    player.seatJoinHandNo = room.handNo + 1;
    player.everSeated = true;
    player.ready = false;
    returnToGame(room, player);
    appendLog(room, 'seat', `${player.name} 坐到 ${seatIndex + 1} 号位`);
    this.emit(room);
    return room;
  }

  standPlayer(code, token) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    const player = room.players.find((entry) => entry.token === token);
    if (!player) throw new Error('玩家不存在');
    if (room.hand?.status === 'running' && player.inHand) throw new Error('对局进行中不能离座');
    player.seatIndex = null;
    player.seatJoinHandNo = room.handNo + 1;
    player.ready = false;
    appendLog(room, 'seat', `${player.name} 离开座位`);
    this.emit(room);
    return room;
  }

  addBot(code, hostToken, level = 'beginner') {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    const host = room.players.find((entry) => entry.token === hostToken);
    if (!host || !host.isHost) throw new Error('只有房主可以添加机器人');
    if (room.hand?.status === 'running') throw new Error('对局进行中不能添加机器人');

    const botLevel = normalizeBotLevel(level);
    const botToken = makeToken();
    const botName = 'Bot_' + botLevelLabel(botLevel) + '_' + botToken.slice(0, 4);
    const bot = makePlayer(botToken, botName, room.config.startingStack);
    bot.isBot = true;
    bot.botLevel = botLevel;
    bot.botCreatedAt = now();

    const occupiedSeats = new Set(room.players.filter((p) => p.seatIndex !== null).map((p) => p.seatIndex));
    let seatIndex = null;
    for (let i = 0; i < room.config.maxSeats; i++) {
      if (!occupiedSeats.has(i)) { seatIndex = i; break; }
    }
    if (seatIndex === null) throw new Error('没有空座位');
    bot.seatIndex = seatIndex;
    bot.seatJoinHandNo = room.handNo + 1;
    bot.everSeated = true;

    room.players.push(bot);
    appendLog(room, 'room', `${host.name} 添加了机器人 ${botName} (${botLevelLabel(botLevel)}) 在 ${seatIndex + 1} 号位`);
    this.emit(room);
    return room;
  }

  removeMember(code, hostToken, targetToken, { requireBot = false, requireHuman = false } = {}) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');

    const host = room.players.find((player) => player.token === hostToken);
    if (!host || !host.isHost) throw new Error('只有房主可以执行此操作');
    if (room.hand?.status === 'running') throw new Error('对局进行中不能踢人');

    const target = room.players.find((player) => player.token === targetToken);
    if (!target) throw new Error(requireBot ? '机器人不存在' : '目标玩家不存在');
    if (target.token === hostToken) throw new Error('不能踢自己');
    if (target.isHost) throw new Error('不能踢房主');
    if (requireBot && !target.isBot) throw new Error('目标不是机器人');
    if (requireHuman && target.isBot) throw new Error('请使用移除机器人功能');

    // 坐过桌的成员离场时留存快照，结算战报需要覆盖所有进入过的玩家
    if (target.everSeated) {
      const record = {
        token: target.token,
        name: target.name,
        isBot: target.isBot,
        totalBuyIn: target.totalBuyIn,
        stack: target.stack,
        leftAt: now(),
      };
      room.departedPlayers = [
        ...(room.departedPlayers ?? []).filter((entry) => entry.token !== target.token),
        record,
      ];
    }

    room.players = room.players.filter((player) => player.token !== targetToken);
    delete room.socketMap[targetToken];
    const action = target.isBot ? '移除了机器人' : '踢出了';
    appendLog(room, 'room', `${host.name} ${action} ${target.name}`);
    this.emit(room);
    return room;
  }

  removeBot(code, hostToken, botToken) {
    return this.removeMember(code, hostToken, botToken, { requireBot: true });
  }

  kickPlayer(code, hostToken, targetToken) {
    return this.removeMember(code, hostToken, targetToken, { requireHuman: true });
  }

  rebuy(code, token, amount) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    if (room.hand?.status === 'running') throw new Error('对局进行中不能补充筹码');

    const player = room.players.find((entry) => entry.token === token);
    if (!player) throw new Error('玩家不存在');
    if (player.isBot) throw new Error('机器人不能补充筹码');
    if (player.seatIndex === null) throw new Error('请先坐下');

    const rebuyAmount = Math.floor(Number(amount));
    if (!Number.isFinite(rebuyAmount) || rebuyAmount <= 0) {
      throw new Error('补充金额必须是正整数');
    }
    if (rebuyAmount > 1000000) {
      throw new Error('单次补充金额不能超过 1000000');
    }

    player.stack += rebuyAmount;
    player.totalBuyIn += rebuyAmount;
    returnToGame(room, player);
    appendLog(room, 'room', `${player.name} 补充了 ${rebuyAmount} 筹码，当前筹码 ${player.stack}`);

    this.emit(room);
    return room;
  }

  resumePlay(code, token) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    if (room.hand?.status === 'running') throw new Error('对局进行中不能重新入局');

    const player = room.players.find((entry) => entry.token === token);
    if (!player) throw new Error('玩家不存在');
    if (player.isBot) throw new Error('机器人不需要重新入局');
    if (player.seatIndex === null) throw new Error('请先坐下');
    if (player.stack <= 0) throw new Error('筹码不足，请先补充筹码');
    if (!player.sitOut) throw new Error('您已在游戏中');

    player.sitOut = false;
    player.ready = false;
    appendLog(room, 'room', `${player.name} 重新加入游戏`);
    this.emit(room);
    return room;
  }

  toggleReady(code, token) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    if (room.hand?.status === 'running') throw new Error('对局进行中不能准备');

    const player = room.players.find((entry) => entry.token === token);
    if (!player) throw new Error('玩家不存在');
    if (player.isBot) throw new Error('机器人无需准备');
    if (player.seatIndex === null || player.stack <= 0 || player.sitOut) throw new Error('只有可参赛玩家可以准备');

    player.ready = !player.ready;
    appendLog(room, 'room', `${player.name}${player.ready ? ' 已准备' : ' 取消准备'}`);

    if (allReadyPlayers(room)) {
      return this.startHand(code, token);
    }

    this.emit(room);
    return room;
  }

  startHand(code, token) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    if (!room.players.some((player) => player.token === token && player.seatIndex !== null)) {
      throw new Error('只有已坐下玩家可以开局');
    }
    if (room.hand?.status === 'running') throw new Error('对局已经开始');

    const participants = room.players.filter(canJoinNextHand);
    if (participants.length < 2) throw new Error('至少需要两名玩家');

    const readyPlayers = eligibleReadyPlayers(room);
    if (readyPlayers.length > 1 && !allReadyPlayers(room)) {
      throw new Error('还有玩家未准备');
    }

    const bustedBots = room.players.filter((player) => player.isBot && player.seatIndex !== null && player.stack <= 0);
    if (bustedBots.length) {
      for (const bot of bustedBots) {
        appendLog(room, 'room', `自动移除输光的机器人 ${bot.name}`);
        delete room.socketMap[bot.token];
        // 保存到离场记录，确保结算时包含所有玩过的机器人
        if (bot.everSeated) {
          const record = {
            token: bot.token,
            name: bot.name,
            isBot: bot.isBot,
            totalBuyIn: bot.totalBuyIn,
            stack: bot.stack,
            handStartStack: bot.handStartStack,
            leftAt: now(),
          };
          room.departedPlayers = [
            ...(room.departedPlayers ?? []).filter((entry) => entry.token !== bot.token),
            record,
          ];
        }
      }
      room.players = room.players.filter((player) => !bustedBots.includes(player));
    }

    room.handNo += 1;
    room.hand = {
      id: room.handNo,
      status: 'running',
      street: 'preflop',
      deck: shuffleDeck(createDeck()),
      deckIndex: 0,
      board: [],
      pot: 0,
      finalPot: 0,
      buttonSeat: null,
      smallBlindSeat: null,
      bigBlindSeat: null,
      currentBet: 0,
      minRaiseSize: room.config.bigBlind,
      lastFullBet: 0,
      actionQueue: [],
      turnDeadlineAt: null,
      dealerMessage: '',
      winners: [],
      sidePots: [],
      revealed: false,
      showOffer: null,
      shownCards: null,
      callOnlySeats: [],
      playerStreetActions: {},
      preflopAggrSeat: null,
    };

    for (const player of room.players) resetPlayerForHand(player);
    for (const player of participants) {
      player.inHand = true;
      player.handStartStack = player.stack;
    }

    const participantSeats = participants.map((player) => player.seatIndex).sort((a, b) => a - b);
    room.buttonSeat = room.buttonSeat == null
      ? participantSeats[0]
      : (nextSeat(room, room.buttonSeat, canJoinNextHand) ?? participantSeats[0]);

    const smallBlindSeat = participants.length === 2
      ? room.buttonSeat
      : nextSeat(room, room.buttonSeat, canJoinNextHand);
    const bigBlindSeat = nextSeat(room, smallBlindSeat, canJoinNextHand);
    room.hand.buttonSeat = room.buttonSeat;
    room.hand.smallBlindSeat = smallBlindSeat;
    room.hand.bigBlindSeat = bigBlindSeat;

    const dealStartSeat = participants.length === 2 ? bigBlindSeat : smallBlindSeat;
    const dealOrder = seatOrderStartingAt(dealStartSeat, room.config.maxSeats)
      .map((seat) => playerAtSeat(room, seat))
      .filter((player) => player && player.inHand);

    for (let round = 0; round < 2; round += 1) {
      for (const player of dealOrder) {
        player.holeCards.push(draw(room));
      }
    }

    postBlind(playerAtSeat(room, smallBlindSeat), room.config.smallBlind);
    postBlind(playerAtSeat(room, bigBlindSeat), room.config.bigBlind);
    room.hand.currentBet = Math.max(
      playerAtSeat(room, smallBlindSeat)?.streetContribution ?? 0,
      playerAtSeat(room, bigBlindSeat)?.streetContribution ?? 0,
    );
    room.hand.lastFullBet = room.hand.currentBet >= room.config.bigBlind ? room.hand.currentBet : 0;
    room.hand.pot = currentPot(room);
    room.hand.actionQueue = buildActionQueue(room, bigBlindSeat);
    room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
    room.hand.dealerMessage = room.hand.actionQueue.length
      ? `${playerAtSeat(room, room.hand.actionQueue[0])?.name ?? '下一位'}先行动`
      : '无人可行动';

    appendLog(room, 'hand', `第 ${room.handNo} 手牌开始，按钮在 ${room.buttonSeat + 1} 号位`);
    this.resolveHand(room);
    this.emit(room);
    this.onHandStart(room);
    return room;
  }

  applyAction(code, token, action) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    if (!room.hand || room.hand.status !== 'running') throw new Error('当前没有进行中的对局');
    if (!room.hand.actionQueue.length) throw new Error('当前不需要行动');

    const player = room.players.find((entry) => entry.token === token);
    if (!player || !canAct(player)) throw new Error('你不在当前行动列表');
    if (room.hand.actionQueue[0] !== player.seatIndex) throw new Error('还没轮到你');

    const result = applyPlayerAction(room, player, action);
    room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
    appendLog(room, 'action', result.log);
    this.resolveHand(room);
    this.emit(room);
    return room;
  }

  showCards(code, token, options = {}) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    showFoldWinCards(room, token, options);
    this.emit(room);
    return room;
  }

  resolveHand(room) {
    if (!room.hand || room.hand.status !== 'running') return room.hand;

    const livePlayers = room.players.filter((player) => player.inHand && !player.folded);
    if (livePlayers.length === 1) return finishByFold(room, this.store);

    const actors = room.players.filter(canAct);
    if (actors.length === 0) return resolveShowdown(room, this.store);

    if (room.hand.actionQueue.length === 0) {
      if (actors.length <= 1 || room.hand.street === 'river') {
        return resolveShowdown(room, this.store);
      }
      advanceStreet(room, this.store);
      const postStreetActors = room.players.filter(canAct);
      if (postStreetActors.length <= 1) {
        return resolveShowdown(room, this.store);
      }
    }

    room.hand.pot = currentPot(room);
    return room.hand;
  }

  cleanOldRooms() {
    if (!this.store || !this.config.roomCleanupEnabled) return;

    const currentTime = Date.now();
    const cutoffTime = currentTime - this.config.roomMaxAgeMs;
    let cleanedCount = 0;

    for (const [code, room] of this.rooms) {
      const hasConnectedPlayer = room.players.some((player) => player.connected);
      const handRunning = room.hand?.status === 'running';
      if (hasConnectedPlayer || handRunning || room.updatedAt >= cutoffTime) continue;
      this.rooms.delete(code);
      this.store.deleteRoom(code);
      cleanedCount++;
      console.log(`清理房间: ${code} (最后活跃: ${new Date(room.updatedAt).toISOString()})`);
    }

    if (cleanedCount > 0) {
      console.log(`清理完成: 删除了 ${cleanedCount} 个过期房间`);
    }
  }

  tick(time = now()) {
    // Clean up old rooms first
    this.cleanOldRooms();
    
    for (const room of this.rooms.values()) {
      // Check for disconnected players that need auto sit-out
      const disconnectGraceMs = room.config.disconnectGraceMs;
      
      for (const player of room.players) {
        if (player.connected || player.isBot || player.sitOut) continue;
        
        // If player is disconnected and grace period has passed, auto sit-out
        if (player.disconnectedAt && (time - player.disconnectedAt) > disconnectGraceMs) {
          player.sitOut = true;
          appendLog(room, 'system', `${player.name} 因长时间离线自动设为观战状态`);
        }
      }

      if (!room.hand || room.hand.status !== 'running') continue;
      if (!room.hand.turnDeadlineAt) continue;

      const player = playerAtSeat(room, room.hand.actionQueue[0]);
      if (!player || !canAct(player)) {
        room.hand.actionQueue = room.hand.actionQueue.slice(1);
        room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
        this.resolveHand(room);
        this.emit(room);
        continue;
      }

      // Bot auto-play：状态变化才计算一次决策并缓存就绪时间（拟人节奏）
      if (player.isBot) {
        const hand = room.hand;
        const stateKey = `${hand.id}|${hand.street}|${hand.actionQueue[0]}|${hand.currentBet}|${Object.keys(hand.playerStreetActions ?? {}).length}`;
        if (!player.botDecision || player.botDecision.stateKey !== stateKey) {
          const actions = buildAvailableActions(room, player);
          const decision = decideBotTurn(room, player, actions);
          player.botDecision = {
            stateKey,
            action: decision.action,
            readyAt: now() + decision.delayMs,
          };
          // 重置机器人的超时时间，确保机器人的思考时间不占用后续玩家的行动时间
          room.hand.turnDeadlineAt = player.botDecision.readyAt + room.config.actionTimeoutMs;
        }
        if (time < player.botDecision.readyAt) continue;

        const botAction = player.botDecision.action;
        player.botDecision = null;
        applyPlayerAction(room, player, botAction);
        const labels = { check: '过牌', call: '跟注', fold: '弃牌', allin: '全下' };
        const actionLabel = botAction.type === 'raise' ? `加注到 ${botAction.amount}` : (labels[botAction.type] || botAction.type);
        appendLog(room, 'action', `${player.name} [${botLevelLabel(player.botLevel)}] ${actionLabel}`);
        room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
        this.resolveHand(room);
        this.emit(room);
        continue;
      }

      // Human timeout
      if (room.hand.turnDeadlineAt > time) continue;

      const autoAction = player.streetContribution >= room.hand.currentBet ? { type: 'check' } : { type: 'fold' };
      applyPlayerAction(room, player, autoAction);
      appendLog(room, 'timeout', autoAction.type === 'check' ? `${player.name} 超时过牌` : `${player.name} 超时弃牌`);
      room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
      this.resolveHand(room);
      this.emit(room);
    }
  }

  settleRoom(code, hostToken) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');

    const host = room.players.find((player) => player.token === hostToken);
    if (!host || !host.isHost) throw new Error('只有房主可以结算房间');

    if (room.hand?.status === 'running') throw new Error('对局进行中不能结算');

    // 合并"在场成员 + 离场快照"，纯围观（从未坐下）不入报
    const byToken = new Map();
    for (const departed of room.departedPlayers ?? []) {
      byToken.set(departed.token, {
        name: departed.name,
        isBot: Boolean(departed.isBot),
        totalBuyIn: Number(departed.totalBuyIn) || 0,
        currentStack: Number(departed.stack) || 0,
      });
    }
    for (const player of room.players) {
      if (!player.everSeated) continue;
      byToken.set(player.token, {
        name: player.name,
        isBot: player.isBot,
        totalBuyIn: player.totalBuyIn,
        currentStack: player.stack,
      });
    }

    const settlements = [...byToken.values()]
      .map((entry) => ({
        ...entry,
        profitLoss: entry.currentStack - entry.totalBuyIn,
      }))
      .sort((a, b) => b.profitLoss - a.profitLoss);

    appendLog(room, 'room', `房主 ${host.name} 结算了房间`);

    // 通知房间内所有在线玩家后删除房间
    this.onClose(room, { reason: 'settled' });
    this.rooms.delete(code);
    this.store.deleteRoom(code);

    return { settlements, roomName: room.name, settledAt: Date.now() };
  }
}
