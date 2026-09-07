import { randomUUID } from 'node:crypto';
import {
  compareZjhHands,
  createZjhDeck,
  describeZjhHand,
  evaluateZjhHand,
} from './zjh.js';
import { decideZjhBotTurn } from './zjh-bot.js';
import { botLevelLabel, normalizeBotLevel } from './bot-ai.js';

export const ZJH_DEFAULT_CONFIG = {
  maxSeats: 6,
  startingStack: 2000,
  ante: 10,        // 底注：开局每家强制投入
  baseStake: 10,   // 初始单注
  raiseStep: 10,   // 加注步长（客户端滑条刻度）
  stakeCap: 0,     // 单注封顶，0 = 不封顶
  maxRounds: 15,   // 轮数上限：达到后强制全场摊牌
  actionTimeoutMs: 30000,
  disconnectGraceMs: 120000,
};

const now = () => Date.now();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function makeZjhToken(token) {
  return typeof token === 'string' && token.trim() ? token.trim() : randomUUID();
}

function makeZjhRoomCode(taken) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (taken.has(code));
  return code;
}

function normalizedNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeZjhConfig(config = {}) {
  const normalized = {
    maxSeats: clamp(Math.floor(normalizedNumber(config.maxSeats ?? ZJH_DEFAULT_CONFIG.maxSeats, ZJH_DEFAULT_CONFIG.maxSeats)), 2, 9),
    startingStack: clamp(Math.floor(normalizedNumber(config.startingStack ?? ZJH_DEFAULT_CONFIG.startingStack, ZJH_DEFAULT_CONFIG.startingStack)), 100, 1000000),
    ante: clamp(Math.floor(normalizedNumber(config.ante ?? ZJH_DEFAULT_CONFIG.ante, ZJH_DEFAULT_CONFIG.ante)), 1, 1000000),
    baseStake: clamp(Math.floor(normalizedNumber(config.baseStake ?? ZJH_DEFAULT_CONFIG.baseStake, ZJH_DEFAULT_CONFIG.baseStake)), 1, 1000000),
    raiseStep: clamp(Math.floor(normalizedNumber(config.raiseStep ?? ZJH_DEFAULT_CONFIG.raiseStep, ZJH_DEFAULT_CONFIG.raiseStep)), 1, 1000000),
    stakeCap: clamp(Math.floor(normalizedNumber(config.stakeCap ?? ZJH_DEFAULT_CONFIG.stakeCap, ZJH_DEFAULT_CONFIG.stakeCap)), 0, 1000000),
    maxRounds: clamp(Math.floor(normalizedNumber(config.maxRounds ?? ZJH_DEFAULT_CONFIG.maxRounds, ZJH_DEFAULT_CONFIG.maxRounds)), 3, 60),
    actionTimeoutMs: clamp(Math.floor(normalizedNumber(config.actionTimeoutMs ?? ZJH_DEFAULT_CONFIG.actionTimeoutMs, ZJH_DEFAULT_CONFIG.actionTimeoutMs)), 5000, 120000),
    disconnectGraceMs: clamp(Math.floor(normalizedNumber(config.disconnectGraceMs ?? ZJH_DEFAULT_CONFIG.disconnectGraceMs, ZJH_DEFAULT_CONFIG.disconnectGraceMs)), 10000, 900000),
  };

  if (normalized.baseStake < normalized.ante) {
    throw new Error('单注不能小于底注');
  }
  if (normalized.stakeCap > 0 && normalized.stakeCap < normalized.baseStake) {
    throw new Error('单注封顶不能小于初始单注');
  }
  return normalized;
}

function makeZjhPlayer(token, name, stack) {
  return {
    token: makeZjhToken(token),
    name: name?.trim() || '玩家',
    connected: true,
    lastSeenAt: now(),
    disconnectedAt: null,
    seatIndex: null,
    seatJoinHandNo: 1,
    everSeated: false,
    stack,
    totalBuyIn: stack,
    sitOut: false,
    ready: false,
    isHost: false,
    inHand: false,
    folded: false,
    allIn: false,
    seen: false,          // 炸金花：是否已看牌（false = 闷牌）
    holeCards: [],
    handContribution: 0,
    actedAt: null,
    actionCount: 0,
    showdownRank: null,
    isBot: false,
    botLevel: null,
    botCreatedAt: null,
  };
}

function normalizeZjhPlayer(player, fallbackStack) {
  return {
    ...makeZjhPlayer(player.token, player.name, fallbackStack),
    ...player,
    token: makeZjhToken(player.token),
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
    seen: Boolean(player.seen),
    holeCards: Array.isArray(player.holeCards) ? [...player.holeCards] : [],
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

function normalizeZjhHand(hand) {
  if (!hand) return null;
  return {
    id: Number(hand.id ?? 0),
    status: hand.status || 'running',
    deck: Array.isArray(hand.deck) ? [...hand.deck] : [],
    deckIndex: Number(hand.deckIndex ?? 0),
    pot: Number(hand.pot ?? 0),
    finalPot: Number(hand.finalPot ?? 0),
    currentStake: Number(hand.currentStake ?? 0),
    round: Number(hand.round ?? 0),
    maxRounds: Number(hand.maxRounds ?? ZJH_DEFAULT_CONFIG.maxRounds),
    dealerSeat: hand.dealerSeat == null ? null : Number(hand.dealerSeat),
    actionQueue: Array.isArray(hand.actionQueue) ? hand.actionQueue.map(Number) : [],
    turnDeadlineAt: hand.turnDeadlineAt == null ? null : Number(hand.turnDeadlineAt),
    dealerMessage: hand.dealerMessage || '',
    winners: Array.isArray(hand.winners) ? [...hand.winners] : [],
    revealed: Boolean(hand.revealed ?? false),
    forcedShowdown: Boolean(hand.forcedShowdown ?? false),
    // 比牌互看记录：{ [viewerToken]: Set(座位号) }，序列化时转数组
    compareSeen: hand.compareSeen && typeof hand.compareSeen === 'object'
      ? Object.fromEntries(Object.entries(hand.compareSeen).map(([key, seats]) => [key, (Array.isArray(seats) ? seats : []).map(Number)]))
      : {},
    playerStreetActions: hand.playerStreetActions && typeof hand.playerStreetActions === 'object' ? { ...hand.playerStreetActions } : {},
  };
}

export function hydrateZjhRoom(snapshot) {
  const config = normalizeZjhConfig(snapshot.config);
  return {
    gameType: 'zjh',
    code: snapshot.code,
    name: snapshot.name || `炸金花桌 ${snapshot.code}`,
    createdAt: Number(snapshot.createdAt ?? now()),
    updatedAt: Number(snapshot.updatedAt ?? snapshot.createdAt ?? now()),
    config,
    handNo: Number(snapshot.handNo ?? 0),
    dealerSeat: snapshot.dealerSeat == null ? null : Number(snapshot.dealerSeat),
    players: Array.isArray(snapshot.players)
      ? snapshot.players.map((player) => normalizeZjhPlayer(player, config.startingStack))
      : [],
    departedPlayers: Array.isArray(snapshot.departedPlayers) ? [...snapshot.departedPlayers] : [],
    hand: normalizeZjhHand(snapshot.hand),
    log: Array.isArray(snapshot.log) ? [...snapshot.log] : [],
    recentHands: Array.isArray(snapshot.recentHands) ? [...snapshot.recentHands] : [],
    socketMap: {},
  };
}

function stripRuntime(room) {
  // socketMap 是运行时套接字映射；__ 前缀是内部引用（如误挂到 room 上的
  // store 引用），一旦序列化进快照会让每次保存体积翻倍直至撑爆数据库
  const { socketMap, ...snapshot } = room;
  for (const key of Object.keys(snapshot)) {
    if (key.startsWith('__')) delete snapshot[key];
  }
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

function seatOrderFrom(startSeat, maxSeats) {
  const order = [];
  for (let i = 1; i <= maxSeats; i += 1) {
    order.push((startSeat + i) % maxSeats);
  }
  return order;
}

function canActZjh(player) {
  return player.inHand && !player.folded && !player.allIn && player.stack > 0;
}

function activePlayers(room) {
  return room.players.filter((player) => player.inHand && !player.folded);
}

function canJoinNextHand(player) {
  return player.seatIndex !== null && player.stack > 0 && !player.sitOut;
}

function eligibleReadyPlayers(room) {
  return room.players.filter((player) => player.seatIndex !== null && player.stack > 0 && !player.sitOut && !player.isBot);
}

function allReadyPlayers(room) {
  const players = eligibleReadyPlayers(room);
  return players.length > 0 && players.every((player) => player.ready);
}

function returnToGame(room, player) {
  if (player && player.sitOut) {
    player.sitOut = false;
    appendLog(room, 'system', `${player.name} 回到游戏`);
  }
}

function currentPot(room) {
  return room.players.reduce((sum, player) => sum + player.handContribution, 0);
}

function resetPlayerForHand(player) {
  player.inHand = false;
  player.folded = false;
  player.allIn = false;
  player.seen = false;
  player.ready = false;
  player.holeCards = [];
  player.handContribution = 0;
  player.actedAt = null;
  player.actionCount = 0;
  player.showdownRank = null;
  player.botDecision = null;
}

function draw(room) {
  return room.hand.deck[room.hand.deckIndex++];
}

// 单注成本：看牌玩家按 2 倍单注支付（闷牌半价）
function stakeCost(room, player) {
  return (player.seen ? 2 : 1) * room.hand.currentStake;
}

function compareCost(room) {
  return 2 * room.hand.currentStake;
}

function commitChips(room, player, amount) {
  const actual = Math.min(amount, player.stack);
  player.stack -= actual;
  player.handContribution += actual;
  if (player.stack === 0) {
    player.allIn = true;
  }
  room.hand.pot = currentPot(room);
  return actual;
}

function buildZjhQueue(room, startSeat) {
  if (startSeat == null) return [];
  return seatOrderFrom(startSeat, room.config.maxSeats)
    .map((seat) => playerAtSeat(room, seat))
    .filter((player) => player && canActZjh(player))
    .map((player) => player.seatIndex);
}

function recordHandAction(room, player, type, amount = 0, extra = {}) {
  player.actedAt = now();
  player.actionCount += 1;
  room.hand.playerStreetActions[player.seatIndex] = {
    type,
    amount,
    timestamp: now(),
    ...extra,
  };
}

function markCompareSeen(room, seatA, seatB) {
  const seen = room.hand.compareSeen;
  for (const [viewerToken, player] of room.players.filter((entry) => [seatA, seatB].includes(entry.seatIndex)).map((entry) => [entry.token, entry])) {
    const seats = new Set(seen[viewerToken] ?? []);
    seats.add(seatA === player.seatIndex ? seatB : seatA);
    seats.add(player.seatIndex);
    seen[viewerToken] = [...seats];
  }
}

function finishZjhByFold(room, store) {
  const winner = activePlayers(room)[0] ?? null;
  if (!winner) return room.hand;

  const won = currentPot(room);
  winner.stack += won;
  room.hand.status = 'finished';
  room.hand.turnDeadlineAt = null;
  room.hand.actionQueue = [];
  room.hand.finalPot = won;
  room.hand.pot = 0;
  room.hand.dealerMessage = winner.name + ' 收下底池';
  room.hand.winners = [{
    token: winner.token,
    name: winner.name,
    amount: won,
    rank: null,
    handLabel: '其余玩家均已弃牌',
    holeCards: [],
  }];
  room.hand.revealed = false;

  room.recentHands.unshift({
    handNo: room.hand.id,
    winners: [...room.hand.winners],
    finalPot: won,
    finishedAt: now(),
    byFold: true,
  });
  room.recentHands = room.recentHands.slice(0, 20);
  persistZjhHand(store, room, { byFold: true, finalPot: won });
  return room.hand;
}

// 强制/常规摊牌：所有未弃牌玩家比牌，最大牌型赢池，平分时按庄家下家顺位分奇数筹码
function resolveZjhShowdown(room, store, { forced = false } = {}) {
  const live = activePlayers(room);
  for (const player of live) {
    player.showdownRank = evaluateZjhHand(player.holeCards);
  }

  const totalPot = currentPot(room);
  let best = live[0].showdownRank;
  for (const player of live.slice(1)) {
    if (compareZjhHands(player.showdownRank, best) > 0) best = player.showdownRank;
  }
  const winners = live.filter((player) => compareZjhHands(player.showdownRank, best) === 0);
  const oddChipOrder = seatOrderFrom(room.hand.dealerSeat ?? 0, room.config.maxSeats);
  winners.sort((left, right) => oddChipOrder.indexOf(left.seatIndex) - oddChipOrder.indexOf(right.seatIndex));

  const share = Math.floor(totalPot / winners.length);
  let remainder = totalPot % winners.length;
  const winnerSummaries = winners.map((winner) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    const won = share + extra;
    winner.stack += won;
    return {
      token: winner.token,
      name: winner.name,
      amount: won,
      rank: winner.showdownRank,
      handLabel: describeZjhHand(winner.showdownRank),
      holeCards: [...winner.holeCards],
    };
  });

  room.hand.status = 'finished';
  room.hand.turnDeadlineAt = null;
  room.hand.actionQueue = [];
  room.hand.finalPot = totalPot;
  room.hand.pot = 0;
  room.hand.dealerMessage = forced ? '轮数已满，强制摊牌' : '摊牌';
  room.hand.winners = winnerSummaries;
  room.hand.revealed = true;
  room.hand.forcedShowdown = forced;

  room.recentHands.unshift({
    handNo: room.hand.id,
    winners: [...room.hand.winners],
    finalPot: totalPot,
    finishedAt: now(),
    forcedShowdown: forced,
  });
  room.recentHands = room.recentHands.slice(0, 20);
  persistZjhHand(store, room, { finalPot: totalPot, forcedShowdown: forced });
  return room.hand;
}

function persistZjhHand(store, room, details) {
  const participants = [];
  for (const player of room.players) {
    if (player.everSeated) {
      participants.push({
        token: player.token,
        name: player.name,
        isBot: player.isBot ?? false,
        stackBefore: player.handStartStack ?? player.stack,
        stackAfter: player.stack,
        profitLoss: player.stack - (player.handStartStack ?? player.stack),
      });
    }
  }
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
    gameType: 'zjh',
    winners: [...room.hand.winners],
    logs: [...room.log],
    participants,
    ...details,
  });
}

// 比牌：发起方与目标互看，点数小的一方（平局发起方）立即出局
function applyCompare(room, initiator, targetSeat) {
  const target = playerAtSeat(room, Number(targetSeat));
  if (!target || !target.inHand || target.folded) throw new Error('比牌目标无效');
  if (target.seatIndex === initiator.seatIndex) throw new Error('不能与自己比牌');

  commitChips(room, initiator, compareCost(room));
  recordHandAction(room, initiator, 'compare', compareCost(room), { target: target.seatIndex });

  initiator.showdownRank = evaluateZjhHand(initiator.holeCards);
  target.showdownRank = evaluateZjhHand(target.holeCards);
  const cmp = compareZjhHands(initiator.showdownRank, target.showdownRank);
  const loser = cmp > 0 ? target : initiator; // 发起方大 → 目标出局；平局判发起方输
  const winner = cmp > 0 ? initiator : target;
  loser.folded = true;
  markCompareSeen(room, initiator.seatIndex, target.seatIndex);

  const message = cmp === 0
    ? `${initiator.name} 与 ${target.name} 比牌，平局判发起方输，${loser.name} 出局`
    : `${initiator.name} 与 ${target.name} 比牌，${winner.name} 胜，${loser.name} 出局`;
  recordHandAction(room, loser, 'compared', 0, { winner: winner.seatIndex });
  appendLog(room, 'action', message);
  return message;
}

function advanceZjhQueue(room, store) {
  const hand = room.hand;
  hand.actionQueue = hand.actionQueue
    .slice(1)
    .filter((seat) => {
      const player = playerAtSeat(room, seat);
      return player && canActZjh(player);
    });

  if (hand.actionQueue.length > 0) {
    hand.turnDeadlineAt = now() + room.config.actionTimeoutMs;
    return;
  }

  const live = activePlayers(room);
  if (live.length <= 1) return;

  const actors = live.filter(canActZjh);
  if (actors.length <= 1) {
    resolveZjhShowdown(room, store);
    return;
  }

  hand.round += 1;
  if (hand.round >= hand.maxRounds) {
    appendLog(room, 'hand', `已进行 ${hand.maxRounds} 轮，强制摊牌`);
    resolveZjhShowdown(room, store, { forced: true });
    return;
  }

  hand.actionQueue = buildZjhQueue(room, hand.dealerSeat);
  hand.turnDeadlineAt = hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
}

function applyZjhPlayerAction(room, player, action, store) {
  const hand = room.hand;
  const type = action?.type;
  let message = '';
  const consumeTurn = () => advanceZjhQueue(room, store);

  if (type === 'look') {
    if (player.seen) throw new Error('已经看过牌了');
    player.seen = true;
    message = player.name + ' 看牌';
    recordHandAction(room, player, 'look');
    hand.turnDeadlineAt = now() + room.config.actionTimeoutMs; // 看牌不消耗回合，刷新思考时间
  } else if (type === 'fold') {
    player.folded = true;
    message = player.name + ' 弃牌';
    recordHandAction(room, player, 'fold');
    consumeTurn();
  } else if (type === 'call') {
    const cost = stakeCost(room, player);
    const paid = commitChips(room, player, cost);
    message = player.seen
      ? `${player.name} 跟注 ${paid}`
      : `${player.name} 闷跟 ${paid}`;
    recordHandAction(room, player, 'call', paid);
    consumeTurn();
  } else if (type === 'raise') {
    const newStake = Math.floor(Number(action?.amount ?? 0));
    if (!Number.isFinite(newStake) || newStake <= hand.currentStake) throw new Error('加注后的单注必须高于当前单注');
    if (room.config.stakeCap > 0 && newStake > room.config.stakeCap) throw new Error('超过单注封顶');
    hand.currentStake = newStake;
    const cost = stakeCost(room, player);
    const paid = commitChips(room, player, cost);
    message = `${player.name} ${player.seen ? '' : '闷'}加注，单注抬到 ${newStake}，投入 ${paid}`;
    recordHandAction(room, player, 'raise', paid, { stake: newStake });
    consumeTurn();
  } else if (type === 'compare') {
    if (action?.targetSeat == null) throw new Error('请选择比牌目标');
    message = applyCompare(room, player, action.targetSeat);
    consumeTurn();
  } else {
    throw new Error('未知行动');
  }

  // 比牌/摊牌可能已在本行动内结束本局，不再覆盖结算消息
  if (hand.status === 'running') {
    hand.dealerMessage = message;
  }
  hand.pot = currentPot(room);
  return { message, log: message };
}

export function zjhActionOptions(room, player) {
  const stake = room.hand.currentStake;
  const callCost = Math.min(stakeCost(room, player), player.stack);
  const liveOpponents = activePlayers(room).filter((entry) => entry.seatIndex !== player.seatIndex);
  const cap = room.config.stakeCap;
  const affordableMaxStake = player.seen ? Math.floor(player.stack / 2) : player.stack;
  const minStake = stake + room.config.raiseStep;
  const maxStake = cap > 0 ? Math.min(cap, affordableMaxStake) : affordableMaxStake;
  const compareCostNow = Math.min(compareCost(room), player.stack);

  return {
    currentStake: stake,
    seen: player.seen,
    callCost,
    canCall: player.stack > 0,
    canLook: !player.seen,
    canFold: true,
    canRaise: maxStake >= minStake,
    minStake,
    maxStake,
    raiseStep: room.config.raiseStep,
    canCompare: liveOpponents.length >= 1 && player.stack > 0,
    compareCost: compareCostNow,
    targets: liveOpponents.map((entry) => ({ seatIndex: entry.seatIndex, name: entry.name })),
  };
}

function zjhPlayerView(room, viewerToken, player) {
  const isViewer = player.token === viewerToken;
  const compareSeenSeats = room.hand?.compareSeen?.[viewerToken] ?? [];
  const showdownReveal = room.hand?.revealed && player.inHand && !player.folded;
  // 自己的牌也要等「看牌」后才可见（闷牌阶段只发背面）
  const revealCards = showdownReveal || compareSeenSeats.includes(player.seatIndex) || (isViewer && player.seen);
  return {
    ...(room.players.find((entry) => entry.token === viewerToken)?.isHost && !isViewer && !player.isHost
      ? { targetToken: player.token }
      : {}),
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
    seen: player.seen,
    handContribution: player.handContribution,
    streetContribution: player.handContribution, // 客户端筹码飞行动画复用字段
    holeCards: revealCards ? [...player.holeCards] : (player.inHand ? ['??', '??', '??'] : []),
    handLabel: revealCards && player.showdownRank ? describeZjhHand(player.showdownRank) : null,
    isViewer,
    isBot: player.isBot || false,
    botLevel: player.botLevel || null,
  };
}

export function zjhRoomSummary(room) {
  return {
    gameType: 'zjh',
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
    pot: room.hand ? (room.hand.status === 'finished' ? (room.hand.finalPot ?? 0) : (room.hand.pot ?? 0)) : 0,
  };
}

// 自己的手牌：闷牌阶段只发背面，看牌/被亮牌/摊牌后才发真实牌面
function selfHoleCards(room, player) {
  if (!player.inHand) return [...player.holeCards];
  const compareSeen = room.hand?.compareSeen?.[player.token]?.includes(player.seatIndex);
  if (player.seen || compareSeen || room.hand?.revealed) return [...player.holeCards];
  return ['??', '??', '??'];
}

export function serializeZjhRoom(room, viewerToken = null) {
  const selfPlayer = viewerToken ? room.players.find((player) => player.token === viewerToken) : null;
  const viewer = selfPlayer;
  return {
    gameType: 'zjh',
    summary: zjhRoomSummary(room),
    code: room.code,
    name: room.name,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    config: { ...room.config },
    handNo: room.handNo,
    dealerSeat: room.dealerSeat,
    players: room.players.map((player) => zjhPlayerView(room, viewerToken, player)),
    self: selfPlayer ? {
      token: selfPlayer.token,
      name: selfPlayer.name,
      connected: selfPlayer.connected,
      seatIndex: selfPlayer.seatIndex,
      stack: selfPlayer.stack,
      sitOut: selfPlayer.sitOut,
      ready: selfPlayer.ready,
      isHost: selfPlayer.isHost,
      inHand: selfPlayer.inHand,
      folded: selfPlayer.folded,
      allIn: selfPlayer.allIn,
      seen: selfPlayer.seen,
      handContribution: selfPlayer.handContribution,
      holeCards: selfHoleCards(room, selfPlayer),
      handLabel: selfPlayer.showdownRank ? describeZjhHand(selfPlayer.showdownRank) : null,
      isBot: selfPlayer.isBot || false,
      botLevel: selfPlayer.botLevel || null,
    } : null,
    hand: room.hand ? {
      id: room.hand.id,
      status: room.hand.status,
      currentStake: room.hand.currentStake,
      round: room.hand.round,
      maxRounds: room.hand.maxRounds,
      dealerSeat: room.hand.dealerSeat,
      actionSeat: room.hand.actionQueue[0] ?? null,
      actionQueue: [...room.hand.actionQueue],
      turnDeadlineAt: room.hand.turnDeadlineAt,
      pot: room.hand.pot,
      finalPot: room.hand.finalPot ?? 0,
      dealerMessage: room.hand.dealerMessage,
      winners: [...room.hand.winners],
      revealed: room.hand.revealed,
      forcedShowdown: room.hand.forcedShowdown,
      playerStreetActions: { ...room.hand.playerStreetActions },
      availableActions: (() => {
        if (room.hand.status !== 'running') return null;
        if (!viewer || room.hand.actionQueue[0] !== viewer.seatIndex || !canActZjh(viewer)) return null;
        return zjhActionOptions(room, viewer);
      })(),
    } : null,
    log: [...room.log],
    recentHands: [...room.recentHands],
    viewerToken,
    serverNow: now(),
  };
}

export class ZjhManager {
  constructor(store, { onUpdate, onHandStart, onClose, config, occupiedCodes } = {}) {
    this.store = store;
    this.onUpdate = onUpdate ?? (() => {});
    this.onHandStart = onHandStart ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.config = config || ZJH_DEFAULT_CONFIG;
    this.occupiedCodes = occupiedCodes ?? (() => new Set());
    this.rooms = new Map();

    for (const snapshot of this.store.listRooms()) {
      if (snapshot.gameType !== 'zjh') continue;
      try {
        const room = hydrateZjhRoom(snapshot);
        this.rooms.set(room.code, room);
      } catch (error) {
        console.warn(`跳过无法恢复的炸金花房间快照: ${snapshot?.code ?? '未知'} (${error.message})`);
      }
    }
  }

  emit(room) {
    room.updatedAt = now();
    this.store.saveRoom(stripRuntime(room));
    this.onUpdate(room);
    return room;
  }

  allTakenCodes() {
    return new Set([...this.rooms.keys(), ...this.occupiedCodes()]);
  }

  getRoom(code) {
    return this.rooms.get(String(code ?? '').trim().toUpperCase()) ?? null;
  }

  getRoomView(code, viewerToken = null) {
    const room = this.getRoom(code);
    return room ? serializeZjhRoom(room, viewerToken) : null;
  }

  listRooms() {
    return [...this.rooms.values()].map(zjhRoomSummary);
  }

  listHandHistory(code, limit = 10) {
    return this.store.listHandHistory(String(code ?? '').trim().toUpperCase(), limit);
  }

  createRoom({ token, roomName, playerName, config = {} }) {
    const roomConfig = normalizeZjhConfig(config);
    const room = {
      gameType: 'zjh',
      code: makeZjhRoomCode(this.allTakenCodes()),
      name: roomName?.trim() || '炸金花牌桌',
      createdAt: now(),
      updatedAt: now(),
      config: roomConfig,
      handNo: 0,
      dealerSeat: null,
      players: [],
      departedPlayers: [],
      hand: null,
      log: [],
      recentHands: [],
      socketMap: {},
    };

    const player = makeZjhPlayer(token, playerName, roomConfig.startingStack);
    player.isHost = true;
    player.seatIndex = 0;
    player.everSeated = true;
    room.players.push(player);
    appendLog(room, 'room', `${player.name} 创建了炸金花房间`);
    this.rooms.set(room.code, room);
    this.emit(room);
    return { room, token: player.token };
  }

  joinRoom(code, { token, playerName }) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    const resolvedToken = makeZjhToken(token);
    let player = room.players.find((entry) => entry.token === resolvedToken);

    if (!player) {
      if (room.players.length >= room.config.maxSeats + 12) {
        throw new Error('房间人数已满');
      }
      player = makeZjhPlayer(resolvedToken, playerName, room.config.startingStack);
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
    const botToken = makeZjhToken();
    const botName = 'Bot_' + botLevelLabel(botLevel) + '_' + botToken.slice(0, 4);
    const bot = makeZjhPlayer(botToken, botName, room.config.startingStack);
    bot.isBot = true;
    bot.botLevel = botLevel;
    bot.botCreatedAt = now();

    const occupiedSeats = new Set(room.players.filter((entry) => entry.seatIndex !== null).map((entry) => entry.seatIndex));
    let seatIndex = null;
    for (let i = 0; i < room.config.maxSeats; i += 1) {
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
      deck: createZjhDeck(),
      deckIndex: 0,
      pot: 0,
      finalPot: 0,
      currentStake: room.config.baseStake,
      round: 0,
      maxRounds: room.config.maxRounds,
      dealerSeat: null,
      actionQueue: [],
      turnDeadlineAt: null,
      dealerMessage: '',
      winners: [],
      revealed: false,
      forcedShowdown: false,
      compareSeen: {},
      playerStreetActions: {},
    };

    for (const player of room.players) resetPlayerForHand(player);
    for (const player of participants) {
      player.inHand = true;
      player.handStartStack = player.stack;
    }

    const participantSeats = participants.map((player) => player.seatIndex).sort((a, b) => a - b);
    room.dealerSeat = room.dealerSeat == null
      ? participantSeats[0]
      : (nextSeat(room, room.dealerSeat, canJoinNextHand) ?? participantSeats[0]);
    room.hand.dealerSeat = room.dealerSeat;

    // 发牌：每家 3 张
    const dealOrder = seatOrderFrom(room.dealerSeat, room.config.maxSeats)
      .map((seat) => playerAtSeat(room, seat))
      .filter((player) => player && player.inHand);
    for (let cardNo = 0; cardNo < 3; cardNo += 1) {
      for (const player of dealOrder) {
        player.holeCards.push(draw(room));
      }
    }

    // 全员下底注
    for (const player of dealOrder) {
      commitChips(room, player, room.config.ante);
    }
    room.hand.pot = currentPot(room);

    // 行动从庄家下家开始
    room.hand.actionQueue = buildZjhQueue(room, room.dealerSeat);
    room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
    room.hand.dealerMessage = room.hand.actionQueue.length
      ? `${playerAtSeat(room, room.hand.actionQueue[0])?.name ?? '下一位'}先行动`
      : '无人可行动';

    appendLog(room, 'hand', `第 ${room.handNo} 局开始，庄家在 ${room.dealerSeat + 1} 号位，底注 ${room.config.ante}`);
    this.resolveZjhHand(room);
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
    if (!player || !canActZjh(player)) throw new Error('你不在当前行动列表');
    if (room.hand.actionQueue[0] !== player.seatIndex) throw new Error('还没轮到你');

    const result = applyZjhPlayerAction(room, player, action, this.store);
    room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
    appendLog(room, 'action', result.log);
    this.resolveZjhHand(room);
    this.emit(room);
    return room;
  }

  resolveZjhHand(room) {
    if (!room.hand || room.hand.status !== 'running') return room.hand;

    const live = activePlayers(room);
    if (live.length === 1) return finishZjhByFold(room, this.store);

    if (room.hand.actionQueue.length === 0) {
      const actors = live.filter(canActZjh);
      if (actors.length <= 1) {
        // 剩余玩家无法继续下注（全下）→ 直接摊牌
        return resolveZjhShowdown(room, this.store);
      }
      room.hand.round += 1;
      if (room.hand.round >= room.hand.maxRounds) {
        appendLog(room, 'hand', `已进行 ${room.hand.maxRounds} 轮，强制摊牌`);
        return resolveZjhShowdown(room, this.store, { forced: true });
      }
      room.hand.actionQueue = buildZjhQueue(room, room.hand.dealerSeat);
    }

    room.hand.pot = currentPot(room);
    return room.hand;
  }

  cleanOldRooms() {
    if (!this.store) return;
    const cutoffTime = Date.now() - 30 * 60 * 1000;
    let cleanedCount = 0;

    for (const [code, room] of this.rooms) {
      const hasConnectedPlayer = room.players.some((player) => player.connected);
      const handRunning = room.hand?.status === 'running';
      if (hasConnectedPlayer || handRunning || room.updatedAt >= cutoffTime) continue;
      this.rooms.delete(code);
      this.store.deleteRoom(code);
      cleanedCount++;
      console.log(`清理炸金花房间: ${code} (最后活跃: ${new Date(room.updatedAt).toISOString()})`);
    }

    if (cleanedCount > 0) {
      console.log(`清理完成: 删除了 ${cleanedCount} 个过期炸金花房间`);
    }
  }

  tick(time = now()) {
    this.cleanOldRooms();

    for (const room of this.rooms.values()) {
      const disconnectGraceMs = room.config.disconnectGraceMs;

      for (const player of room.players) {
        if (player.connected || player.isBot || player.sitOut) continue;
        if (player.disconnectedAt && (time - player.disconnectedAt) > disconnectGraceMs) {
          player.sitOut = true;
          appendLog(room, 'system', `${player.name} 因长时间离线自动设为观战状态`);
        }
      }

      if (!room.hand || room.hand.status !== 'running') continue;
      if (!room.hand.turnDeadlineAt) continue;

      const player = playerAtSeat(room, room.hand.actionQueue[0]);
      if (!player || !canActZjh(player)) {
        room.hand.actionQueue = room.hand.actionQueue.slice(1);
        room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
        this.resolveZjhHand(room);
        this.emit(room);
        continue;
      }

      if (player.isBot) {
        const hand = room.hand;
        const stateKey = `${hand.id}|${hand.round}|${hand.actionQueue[0]}|${hand.currentStake}|${player.seen ? 'S' : 'B'}|${Object.keys(hand.playerStreetActions ?? {}).length}`;
        if (!player.botDecision || player.botDecision.stateKey !== stateKey) {
          const actions = zjhActionOptions(room, player);
          const decision = decideZjhBotTurn(room, player, actions);
          player.botDecision = {
            stateKey,
            action: decision.action,
            readyAt: now() + decision.delayMs,
          };
          room.hand.turnDeadlineAt = player.botDecision.readyAt + room.config.actionTimeoutMs;
        }
        if (time < player.botDecision.readyAt) continue;

        const botAction = player.botDecision.action;
        player.botDecision = null;
        applyZjhPlayerAction(room, player, botAction, this.store);
        const labels = { look: '看牌', call: '跟注', fold: '弃牌', compare: '比牌' };
        const actionLabel = botAction.type === 'raise'
          ? `加注到单注 ${botAction.amount}`
          : (labels[botAction.type] || botAction.type);
        appendLog(room, 'action', `${player.name} [${botLevelLabel(player.botLevel)}] ${actionLabel}`);
        room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
        this.resolveZjhHand(room);
        this.emit(room);
        continue;
      }

      // Human timeout：超时自动跟注（不足则全下），无筹码则弃牌
      if (room.hand.turnDeadlineAt > time) continue;

      const autoAction = player.stack > 0 ? { type: 'call' } : { type: 'fold' };
      applyZjhPlayerAction(room, player, autoAction, this.store);
      appendLog(room, 'timeout', autoAction.type === 'call' ? `${player.name} 超时自动跟注` : `${player.name} 超时弃牌`);
      room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
      this.resolveZjhHand(room);
      this.emit(room);
    }
  }

  settleRoom(code, hostToken) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');

    const host = room.players.find((player) => player.token === hostToken);
    if (!host || !host.isHost) throw new Error('只有房主可以结算房间');
    if (room.hand?.status === 'running') throw new Error('对局进行中不能结算');

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

    this.onClose(room, { reason: 'settled' });
    this.rooms.delete(code);
    this.store.deleteRoom(code);

    return { settlements, roomName: room.name, settledAt: Date.now() };
  }
}
