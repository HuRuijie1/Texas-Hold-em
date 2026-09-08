import { randomUUID } from 'node:crypto';
import {
  GDY_PLAY_TYPE,
  createGdyDeck,
  describeGdyPlay,
  evaluateGdyPlay,
  formatGdyCards,
  gdyBeats,
  gdyRankValue,
  isGdyJoker,
} from './gdy.js';

export const GDY_DEFAULT_CONFIG = {
  maxSeats: 5,       // 座位数（2-5 人玩，一副 54 张牌）
  startingStack: 200,
  baseScore: 1,      // 底分：输家每剩一张牌扣 baseScore 分
  scoreCap: 100,     // 单局单人封顶扣分，0 = 不封顶
  actionTimeoutMs: 30000,
  disconnectGraceMs: 120000,
};

const now = () => Date.now();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function makeGdyToken(token) {
  return typeof token === 'string' && token.trim() ? token.trim() : randomUUID();
}

function makeGdyRoomCode(taken) {
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

function normalizeGdyConfig(config = {}) {
  const normalized = {
    maxSeats: clamp(Math.floor(normalizedNumber(config.maxSeats ?? GDY_DEFAULT_CONFIG.maxSeats, GDY_DEFAULT_CONFIG.maxSeats)), 2, 5),
    startingStack: clamp(Math.floor(normalizedNumber(config.startingStack ?? GDY_DEFAULT_CONFIG.startingStack, GDY_DEFAULT_CONFIG.startingStack)), 50, 1000000),
    baseScore: clamp(Math.floor(normalizedNumber(config.baseScore ?? GDY_DEFAULT_CONFIG.baseScore, GDY_DEFAULT_CONFIG.baseScore)), 1, 1000000),
    scoreCap: clamp(Math.floor(normalizedNumber(config.scoreCap ?? GDY_DEFAULT_CONFIG.scoreCap, GDY_DEFAULT_CONFIG.scoreCap)), 0, 1000000),
    actionTimeoutMs: clamp(Math.floor(normalizedNumber(config.actionTimeoutMs ?? GDY_DEFAULT_CONFIG.actionTimeoutMs, GDY_DEFAULT_CONFIG.actionTimeoutMs)), 5000, 120000),
    disconnectGraceMs: clamp(Math.floor(normalizedNumber(config.disconnectGraceMs ?? GDY_DEFAULT_CONFIG.disconnectGraceMs, GDY_DEFAULT_CONFIG.disconnectGraceMs)), 10000, 900000),
  };
  return normalized;
}

function makeGdyPlayer(token, name, stack) {
  return {
    token: makeGdyToken(token),
    name: name?.trim() || '玩家',
    connected: true,
    lastSeenAt: now(),
    disconnectedAt: null,
    seatIndex: null,
    seatJoinHandNo: 1,
    everSeated: false,
    stack,
    totalBuyIn: stack,
    handStartStack: stack,
    sitOut: false,
    ready: false,
    isHost: false,
    inHand: false,
    holeCards: [],
    isBot: false,
  };
}

function normalizeGdyPlayer(player, fallbackStack) {
  return {
    ...makeGdyPlayer(player.token, player.name, fallbackStack),
    ...player,
    token: makeGdyToken(player.token),
    name: player.name?.trim() || '玩家',
    connected: Boolean(player.connected),
    lastSeenAt: Number(player.lastSeenAt ?? now()),
    disconnectedAt: player.disconnectedAt == null ? null : Number(player.disconnectedAt),
    seatIndex: player.seatIndex == null ? null : Number(player.seatIndex),
    seatJoinHandNo: Number(player.seatJoinHandNo ?? 1),
    everSeated: Boolean(player.everSeated),
    stack: Number(player.stack ?? fallbackStack),
    totalBuyIn: Number(player.totalBuyIn ?? player.stack ?? fallbackStack),
    handStartStack: Number(player.handStartStack ?? player.stack ?? fallbackStack),
    sitOut: Boolean(player.sitOut),
    ready: Boolean(player.ready),
    isHost: Boolean(player.isHost),
    inHand: Boolean(player.inHand),
    holeCards: Array.isArray(player.holeCards) ? [...player.holeCards] : [],
    isBot: Boolean(player.isBot),
  };
}

function normalizeGdyHand(hand) {
  if (!hand) return null;
  const lastPlay = hand.lastPlay && typeof hand.lastPlay === 'object'
    ? {
        seatIndex: Number(hand.lastPlay.seatIndex),
        play: hand.lastPlay.play ?? null,
        cards: Array.isArray(hand.lastPlay.cards) ? [...hand.lastPlay.cards] : [],
      }
    : null;
  return {
    id: Number(hand.id ?? 0),
    status: hand.status || 'running',
    deck: Array.isArray(hand.deck) ? [...hand.deck] : [],
    deckIndex: Number(hand.deckIndex ?? 0),
    dealerSeat: hand.dealerSeat == null ? null : Number(hand.dealerSeat),
    turnSeat: hand.turnSeat == null ? null : Number(hand.turnSeat),
    lastPlay,
    passedSeats: Array.isArray(hand.passedSeats) ? hand.passedSeats.map(Number) : [],
    bombsPlayed: Number(hand.bombsPlayed ?? 0),
    bombMultiplier: Number(hand.bombMultiplier ?? 2 ** Number(hand.bombsPlayed ?? 0)),
    turnDeadlineAt: hand.turnDeadlineAt == null ? null : Number(hand.turnDeadlineAt),
    dealerMessage: hand.dealerMessage || '',
    winners: Array.isArray(hand.winners) ? [...hand.winners] : [],
    results: Array.isArray(hand.results) ? [...hand.results] : [],
    playerStreetActions: hand.playerStreetActions && typeof hand.playerStreetActions === 'object'
      ? { ...hand.playerStreetActions }
      : {},
  };
}

export function hydrateGdyRoom(snapshot) {
  const config = normalizeGdyConfig(snapshot.config);
  return {
    gameType: 'gdy',
    code: snapshot.code,
    name: snapshot.name || `干瞪眼桌 ${snapshot.code}`,
    createdAt: Number(snapshot.createdAt ?? now()),
    updatedAt: Number(snapshot.updatedAt ?? snapshot.createdAt ?? now()),
    config,
    handNo: Number(snapshot.handNo ?? 0),
    dealerSeat: snapshot.dealerSeat == null ? null : Number(snapshot.dealerSeat),
    players: Array.isArray(snapshot.players)
      ? snapshot.players.map((player) => normalizeGdyPlayer(player, config.startingStack))
      : [],
    departedPlayers: Array.isArray(snapshot.departedPlayers) ? [...snapshot.departedPlayers] : [],
    hand: normalizeGdyHand(snapshot.hand),
    log: Array.isArray(snapshot.log) ? [...snapshot.log] : [],
    recentHands: Array.isArray(snapshot.recentHands) ? [...snapshot.recentHands] : [],
    socketMap: {},
  };
}

function stripRuntime(room) {
  // socketMap 是运行时套接字映射；__ 前缀是内部引用，不进快照
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

function inHandPlayers(room) {
  return room.players.filter((player) => player.inHand);
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

function nextGdySeat(room, seatIndex) {
  if (seatIndex == null) return null;
  for (let offset = 1; offset <= room.config.maxSeats; offset += 1) {
    const candidate = (seatIndex + offset) % room.config.maxSeats;
    const player = playerAtSeat(room, candidate);
    if (player && player.inHand) return candidate;
  }
  return null;
}

// 手上是否还有可打出的牌：癞子不能单独出，纯癞子手牌无牌可出
function hasAnyGdyPlay(player) {
  return player.holeCards.some((card) => !isGdyJoker(card));
}

function resetPlayerForHand(player) {
  player.inHand = false;
  player.ready = false;
  player.holeCards = [];
}

function recordHandAction(room, player, type, amount = 0, extra = {}) {
  room.hand.playerStreetActions[player.seatIndex] = {
    type,
    amount,
    timestamp: now(),
    ...extra,
  };
}

// 从手牌中移除所选的牌（同一副牌中每张牌唯一，按牌面匹配即可）
function removeCardsFromHand(player, cards) {
  for (const card of cards) {
    const index = player.holeCards.indexOf(card);
    if (index === -1) {
      return false;
    }
    player.holeCards.splice(index, 1);
  }
  return true;
}

// 轮转推进：一圈全过 → 出牌最大者摸 1 张并重获自由出牌权；
// 否则轮到下一位 inHand 玩家（自由出牌者若只剩癞子则跳过）
function proceedAfterAction(room) {
  const hand = room.hand;
  if (hand.status !== 'running') return;

  if (hand.lastPlay) {
    const others = inHandPlayers(room).filter((player) => player.seatIndex !== hand.lastPlay.seatIndex);
    const allPassed = others.length > 0 && others.every((player) => hand.passedSeats.includes(player.seatIndex));
    if (allPassed) {
      const leader = playerAtSeat(room, hand.lastPlay.seatIndex);
      hand.lastPlay = null;
      hand.passedSeats = [];
      hand.turnSeat = leader.seatIndex;
      if (hand.deckIndex < hand.deck.length) {
        leader.holeCards.push(hand.deck[hand.deckIndex++]);
        appendLog(room, 'draw', `${leader.name} 一圈最大，获得出牌权并摸 1 张`);
      } else {
        appendLog(room, 'draw', `${leader.name} 一圈最大，获得出牌权（牌堆已空）`);
      }
      hand.turnDeadlineAt = now() + room.config.actionTimeoutMs;
      return;
    }
  }

  let seat = hand.turnSeat;
  for (let guard = 0; guard < room.config.maxSeats; guard += 1) {
    seat = nextGdySeat(room, seat);
    if (seat == null) break;
    const next = playerAtSeat(room, seat);
    if (!next || !next.inHand) continue;
    if (hand.lastPlay == null && !hasAnyGdyPlay(next)) {
      appendLog(room, 'system', `${next.name} 只剩癞子无法出牌，跳过`);
      continue;
    }
    hand.turnSeat = seat;
    hand.turnDeadlineAt = now() + room.config.actionTimeoutMs;
    return;
  }
}

// 结算：赢家得所有输家实际扣分之和。
// 倍率：全局炸弹倍率 2^本局打出的炸弹数；被通关（结束时恰好剩 5 张）的输家个人再 ×2；封顶截断。
function finishGdyHand(room, store, winner, winLabel) {
  const hand = room.hand;
  hand.status = 'finished';
  hand.turnSeat = null;
  hand.turnDeadlineAt = null;
  hand.passedSeats = [];

  const bombMultiplier = hand.bombMultiplier ?? 2 ** hand.bombsPlayed;
  let totalGain = 0;
  const results = [];
  for (const player of inHandPlayers(room)) {
    if (player.seatIndex === winner.seatIndex) continue;
    const cardsLeft = player.holeCards.length;
    const passThrough = cardsLeft === 5;
    const loss = cardsLeft * room.config.baseScore * bombMultiplier * (passThrough ? 2 : 1);
    let capped = false;
    let owed = loss;
    if (room.config.scoreCap > 0 && owed > room.config.scoreCap) {
      owed = room.config.scoreCap;
      capped = true;
    }
    const paid = Math.min(owed, player.stack);
    player.stack -= paid;
    totalGain += paid;
    results.push({
      seatIndex: player.seatIndex,
      name: player.name,
      cardsLeft,
      passThrough,
      bombMultiplier,
      passThroughMultiplier: passThrough ? 2 : 1,
      loss,
      paid,
      capped,
      holeCards: [...player.holeCards],
    });
  }
  winner.stack += totalGain;

  hand.winners = [{
    token: winner.token,
    name: winner.name,
    amount: totalGain,
    handLabel: `干瞪眼 · 先出完（${winLabel}）`,
    holeCards: [],
  }];
  hand.results = results;
  room.dealerSeat = winner.seatIndex; // 上局赢家连庄

  appendLog(room, 'hand', `${winner.name} 先出完获胜，赢家 +${totalGain}`);
  for (const result of results) {
    const tags = [`剩 ${result.cardsLeft} 张`];
    if (result.bombMultiplier > 1) tags.push(`炸弹倍率×${result.bombMultiplier}`);
    if (result.passThrough) tags.push('被通关×2');
    if (result.capped) tags.push(`封顶${room.config.scoreCap}`);
    if (result.paid < result.loss) tags.push(`筹码不足实扣${result.paid}`);
    appendLog(room, 'hand', `${result.name} ${tags.join(' ')}，扣 ${result.paid}`);
  }

  room.recentHands.unshift({
    handNo: hand.id,
    winners: [...hand.winners],
    results: results.map((result) => ({ ...result, holeCards: [...result.holeCards] })),
    bombsPlayed: hand.bombsPlayed,
    finishedAt: now(),
  });
  room.recentHands = room.recentHands.slice(0, 20);
  persistGdyHand(store, room, { bombsPlayed: hand.bombsPlayed });
  return hand;
}

function applyGdyPlayerAction(room, player, action, store) {
  const hand = room.hand;
  if (hand.turnSeat !== player.seatIndex) throw new Error('还没轮到你');
  const type = action?.type;

  if (type === 'pass') {
    if (hand.lastPlay == null) throw new Error('轮到你自由出牌，必须出牌');
    hand.passedSeats.push(player.seatIndex);
    recordHandAction(room, player, 'pass', 0, { label: '干瞪眼' });
    const message = `${player.name} 干瞪眼（过）`;
    appendLog(room, 'action', message);
    proceedAfterAction(room);
    return { message, log: message };
  }

  if (type === 'play') {
    const cards = action?.cards;
    if (!Array.isArray(cards) || cards.length === 0) throw new Error('请选择要出的牌');
    if (new Set(cards).size !== cards.length) throw new Error('所选的牌有重复');
    const play = evaluateGdyPlay(cards);
    if (!play) throw new Error('所选的牌不构成有效牌型');
    if (hand.lastPlay && !gdyBeats(play, hand.lastPlay.play)) throw new Error('压不过上家的牌');
    if (!removeCardsFromHand(player, cards)) throw new Error('手牌不包含所选的牌');

    if (play.type === GDY_PLAY_TYPE.BOMB) {
      // 三张炸弹倍率 ×2，四张炸弹 ×4，逐个累乘
      const factor = play.size >= 4 ? 4 : 2;
      hand.bombsPlayed += 1;
      hand.bombMultiplier = (hand.bombMultiplier ?? 1) * factor;
      appendLog(room, 'action', `${player.name} 打出${play.size >= 4 ? '四张炸弹' : '炸弹'}，本局倍率升至 ×${hand.bombMultiplier}`);
    }
    const label = describeGdyPlay(play);
    hand.lastPlay = { seatIndex: player.seatIndex, play, cards: [...cards] };
    hand.passedSeats = [];
    recordHandAction(room, player, 'play', cards.length, { label });
    const message = `${player.name} 出 ${label}（${formatGdyCards(cards)}）`;
    appendLog(room, 'action', message);

    if (player.holeCards.length === 0) {
      finishGdyHand(room, store, player, label);
      return { message, log: message };
    }
    proceedAfterAction(room);
    return { message, log: message };
  }

  throw new Error('未知行动');
}

export function gdyActionOptions(room, player) {
  const lastPlay = room.hand.lastPlay;
  return {
    freePlay: lastPlay == null,
    mustPlay: lastPlay == null,
    canPass: lastPlay != null,
    handSize: player.holeCards.length,
    lastPlay: lastPlay
      ? {
          seatIndex: lastPlay.seatIndex,
          name: playerAtSeat(room, lastPlay.seatIndex)?.name ?? '',
          cards: [...lastPlay.cards],
          label: describeGdyPlay(lastPlay.play),
        }
      : null,
  };
}

function persistGdyHand(store, room, details) {
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
    gameType: 'gdy',
    winners: [...room.hand.winners],
    results: room.hand.results.map((result) => ({ ...result, holeCards: [...result.holeCards] })),
    bombsPlayed: room.hand.bombsPlayed,
    logs: [...room.log],
    participants,
    ...details,
  });
}

function gdyPlayerView(room, viewerToken, player) {
  const isViewer = player.token === viewerToken;
  const revealCards = isViewer || room.hand?.status === 'finished';
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
    cardCount: player.holeCards.length,
    holeCards: revealCards ? [...player.holeCards] : [],
    isViewer,
  };
}

export function gdyRoomSummary(room) {
  return {
    gameType: 'gdy',
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
  };
}

export function serializeGdyRoom(room, viewerToken = null) {
  const selfPlayer = viewerToken ? room.players.find((player) => player.token === viewerToken) : null;
  const hand = room.hand;
  const lastPlay = hand?.lastPlay
    ? {
        seatIndex: hand.lastPlay.seatIndex,
        name: playerAtSeat(room, hand.lastPlay.seatIndex)?.name ?? '',
        cards: [...hand.lastPlay.cards],
        label: describeGdyPlay(hand.lastPlay.play),
      }
    : null;
  return {
    gameType: 'gdy',
    summary: gdyRoomSummary(room),
    code: room.code,
    name: room.name,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    config: { ...room.config },
    handNo: room.handNo,
    dealerSeat: room.dealerSeat,
    players: room.players.map((player) => gdyPlayerView(room, viewerToken, player)),
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
      holeCards: [...selfPlayer.holeCards],
      isViewer: true,
    } : null,
    hand: hand ? {
      id: hand.id,
      status: hand.status,
      dealerSeat: hand.dealerSeat,
      turnSeat: hand.turnSeat,
      drawPileLeft: hand.deck.length - hand.deckIndex,
      bombsPlayed: hand.bombsPlayed,
      multiplier: hand.bombMultiplier ?? 2 ** hand.bombsPlayed,
      lastPlay,
      turnDeadlineAt: hand.turnDeadlineAt,
      dealerMessage: hand.dealerMessage,
      winners: [...(hand.winners ?? [])],
      results: [...(hand.results ?? [])],
      playerStreetActions: { ...hand.playerStreetActions },
      availableActions: (() => {
        if (hand.status !== 'running') return null;
        if (!selfPlayer || hand.turnSeat !== selfPlayer.seatIndex || !selfPlayer.inHand) return null;
        return gdyActionOptions(room, selfPlayer);
      })(),
    } : null,
    log: [...room.log],
    recentHands: [...room.recentHands],
    viewerToken,
    serverNow: now(),
  };
}

export class GdyManager {
  constructor(store, { onUpdate, onHandStart, onClose, config, occupiedCodes } = {}) {
    this.store = store;
    this.onUpdate = onUpdate ?? (() => {});
    this.onHandStart = onHandStart ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.config = config || GDY_DEFAULT_CONFIG;
    this.occupiedCodes = occupiedCodes ?? (() => new Set());
    this.rooms = new Map();

    for (const snapshot of this.store.listRooms()) {
      if (snapshot.gameType !== 'gdy') continue;
      try {
        const room = hydrateGdyRoom(snapshot);
        this.rooms.set(room.code, room);
      } catch (error) {
        console.warn(`跳过无法恢复的干瞪眼房间快照: ${snapshot?.code ?? '未知'} (${error.message})`);
      }
    }
  }

  emit(room) {
    room.updatedAt = now();
    this.store.saveRoom(stripRuntime(room));
    try {
      this.onUpdate(room);
    } catch (error) {
      console.error('emit onUpdate error:', error);
    }
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
    return room ? serializeGdyRoom(room, viewerToken) : null;
  }

  listRooms() {
    return [...this.rooms.values()].map(gdyRoomSummary);
  }

  listHandHistory(code, limit = 10) {
    return this.store.listHandHistory(String(code ?? '').trim().toUpperCase(), limit);
  }

  createRoom({ token, roomName, playerName, config = {} }) {
    const roomConfig = normalizeGdyConfig(config);
    const room = {
      gameType: 'gdy',
      code: makeGdyRoomCode(this.allTakenCodes()),
      name: roomName?.trim() || '干瞪眼牌桌',
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

    const player = makeGdyPlayer(token, playerName, roomConfig.startingStack);
    player.isHost = true;
    player.seatIndex = 0;
    player.everSeated = true;
    room.players.push(player);
    appendLog(room, 'room', `${player.name} 创建了干瞪眼房间`);
    this.rooms.set(room.code, room);
    this.emit(room);
    return { room, token: player.token };
  }

  joinRoom(code, { token, playerName }) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    const resolvedToken = makeGdyToken(token);
    let player = room.players.find((entry) => entry.token === resolvedToken);

    if (!player) {
      if (room.players.length >= room.config.maxSeats + 12) {
        throw new Error('房间人数已满');
      }
      player = makeGdyPlayer(resolvedToken, playerName, room.config.startingStack);
      room.players.push(player);
      appendLog(room, 'room', `${player.name} 加入房间`);
    } else {
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

  addBot() {
    throw new Error('干瞪眼暂不支持机器人');
  }

  removeBot() {
    throw new Error('干瞪眼没有机器人');
  }

  removeMember(code, hostToken, targetToken) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');

    const host = room.players.find((player) => player.token === hostToken);
    if (!host || !host.isHost) throw new Error('只有房主可以执行此操作');
    if (room.hand?.status === 'running') throw new Error('对局进行中不能踢人');

    const target = room.players.find((player) => player.token === targetToken);
    if (!target) throw new Error('目标玩家不存在');
    if (target.token === hostToken) throw new Error('不能踢自己');
    if (target.isHost) throw new Error('不能踢房主');

    if (target.everSeated) {
      const record = {
        token: target.token,
        name: target.name,
        isBot: false,
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
    appendLog(room, 'room', `${host.name} 踢出了 ${target.name}`);
    this.emit(room);
    return room;
  }

  kickPlayer(code, hostToken, targetToken) {
    return this.removeMember(code, hostToken, targetToken);
  }

  rebuy(code, token, amount) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    if (room.hand?.status === 'running') throw new Error('对局进行中不能补充筹码');
    const player = room.players.find((entry) => entry.token === token);
    if (!player) throw new Error('玩家不存在');
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
    if (player.seatIndex === null || player.stack <= 0 || player.sitOut) throw new Error('只有可参赛玩家可以准备');

    player.ready = !player.ready;
    appendLog(room, 'room', `${player.name}${player.ready ? ' 已准备' : ' 取消准备'}`);

    if (allReadyPlayers(room)) {
      return this.startHand(code, token);
    }

    this.emit(room);
    return room;
  }

  // 庄家：上局赢家连庄；首局（或赢家已离场）在参与者中随机
  resolveGdyDealer(room, participants) {
    if (room.dealerSeat != null) {
      const previous = playerAtSeat(room, room.dealerSeat);
      if (previous && participants.includes(previous)) {
        return room.dealerSeat;
      }
      appendLog(room, 'hand', '上局庄家已离场，随机选择庄家');
    }
    const chosen = participants[Math.floor(Math.random() * participants.length)];
    return chosen.seatIndex;
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

    room.handNo += 1;
    const dealerSeat = this.resolveGdyDealer(room, participants);
    room.dealerSeat = dealerSeat;
    const dealer = playerAtSeat(room, dealerSeat);

    room.hand = {
      id: room.handNo,
      status: 'running',
      deck: createGdyDeck(),
      deckIndex: 0,
      dealerSeat,
      turnSeat: dealerSeat,
      lastPlay: null,
      passedSeats: [],
      bombsPlayed: 0,
      bombMultiplier: 1,
      turnDeadlineAt: now() + room.config.actionTimeoutMs,
      dealerMessage: '',
      winners: [],
      results: [],
      playerStreetActions: {},
    };

    for (const player of room.players) resetPlayerForHand(player);
    for (const player of participants) {
      player.inHand = true;
      player.handStartStack = player.stack;
    }

    // 发牌：庄家 6 张，其余每人 5 张
    for (let cardNo = 0; cardNo < 5; cardNo += 1) {
      for (const player of participants) {
        player.holeCards.push(room.hand.deck[room.hand.deckIndex++]);
      }
    }
    dealer.holeCards.push(room.hand.deck[room.hand.deckIndex++]);

    room.hand.dealerMessage = `${dealer.name} 是庄家（6 张），请出牌`;
    appendLog(room, 'hand', `第 ${room.handNo} 局开始，庄家 ${dealer.name}（6 张），其余每人 5 张，底分 ${room.config.baseScore}`);
    this.emit(room);
    this.onHandStart(room);
    return room;
  }

  applyAction(code, token, action) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    if (!room.hand || room.hand.status !== 'running') throw new Error('当前没有进行中的对局');
    const player = room.players.find((entry) => entry.token === token);
    if (!player) throw new Error('玩家不存在');

    const result = applyGdyPlayerAction(room, player, action, this.store);
    if (room.hand.status === 'running' && !room.hand.turnDeadlineAt) {
      room.hand.turnDeadlineAt = now() + room.config.actionTimeoutMs;
    }
    // 行动日志已在 applyGdyPlayerAction 内记录（含炸弹倍率提示），此处不重复
    this.emit(room);
    return room;
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
      console.log(`清理干瞪眼房间: ${code} (最后活跃: ${new Date(room.updatedAt).toISOString()})`);
    }

    if (cleanedCount > 0) {
      console.log(`清理完成: 删除了 ${cleanedCount} 个过期干瞪眼房间`);
    }
  }

  tick(time = now()) {
    this.cleanOldRooms();

    for (const room of this.rooms.values()) {
      const disconnectGraceMs = room.config.disconnectGraceMs;

      for (const player of room.players) {
        if (player.connected || player.sitOut) continue;
        if (player.disconnectedAt && (time - player.disconnectedAt) > disconnectGraceMs) {
          player.sitOut = true;
          appendLog(room, 'system', `${player.name} 因长时间离线自动设为观战状态`);
        }
      }

      if (!room.hand || room.hand.status !== 'running') continue;
      if (!room.hand.turnDeadlineAt || room.hand.turnDeadlineAt > time) continue;

      const player = playerAtSeat(room, room.hand.turnSeat);
      if (!player || !player.inHand) {
        // 状态异常兜底：推进轮转避免卡局
        proceedAfterAction(room);
        this.emit(room);
        continue;
      }

      if (room.hand.lastPlay == null) {
        // 自由出牌超时：自动出最小的单张；只剩癞子则跳过
        if (!hasAnyGdyPlay(player)) {
          appendLog(room, 'timeout', `${player.name} 只剩癞子无法出牌，跳过`);
          proceedAfterAction(room);
          this.emit(room);
          continue;
        }
        const smallest = player.holeCards
          .filter((card) => !isGdyJoker(card))
          .sort((a, b) => gdyRankValue(a) - gdyRankValue(b))[0];
        applyGdyPlayerAction(room, player, { type: 'play', cards: [smallest] }, this.store);
        appendLog(room, 'timeout', `${player.name} 超时自动出牌`);
        this.emit(room);
        continue;
      }

      // 跟牌超时：自动过
      applyGdyPlayerAction(room, player, { type: 'pass' }, this.store);
      appendLog(room, 'timeout', `${player.name} 超时自动过`);
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
        isBot: false,
        totalBuyIn: Number(departed.totalBuyIn) || 0,
        currentStack: Number(departed.stack) || 0,
      });
    }
    for (const player of room.players) {
      if (!player.everSeated) continue;
      byToken.set(player.token, {
        name: player.name,
        isBot: false,
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
