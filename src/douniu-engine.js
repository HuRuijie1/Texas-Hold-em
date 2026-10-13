import { randomUUID } from 'node:crypto';
import {
  compareDnHands,
  createDnDeck,
  describeDnHand,
  dnBestBullPick,
  dnCardPoints,
  dnSpecialRank,
  evaluateDnHand,
  evaluateDnPick,
} from './douniu.js';
import { decideDnBotTurn, decideDnBotBanker, decideDnBotPick } from './douniu-bot.js';
// 斗牛沿用旧三档等级，与德州的五档互不干扰
import { botLevelLabel, normalizeBotLevel } from './legacy-bot-levels.js';

export const DN_DEFAULT_CONFIG = {
  bankerMode: 'banker', // 'banker' 有庄模式 | 'none' 无庄模式
  maxSeats: 6,
  startingStack: 2000,
  baseStake: 10,       // 底分：无庄模式即每家底注；有庄模式为每 1 倍对应的筹码
  maxBetMult: 5,       // 闲家盲注倍数上限（仅有庄模式生效）
  scoreCap: 0,         // 单个庄闲结算封顶，0 = 不封顶（仅有庄模式生效）
  actionTimeoutMs: 30000,
  disconnectGraceMs: 120000,
};

const now = () => Date.now();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeDnBankerMode(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'none' || text === 'nobanker' || text === '无庄' ? 'none' : 'banker';
}

export function makeDnToken(token) {
  return typeof token === 'string' && token.trim() ? token.trim() : randomUUID();
}

function makeDnRoomCode(taken) {
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

function normalizeDnConfig(config = {}) {
  const normalized = {
    bankerMode: normalizeDnBankerMode(config.bankerMode ?? DN_DEFAULT_CONFIG.bankerMode),
    maxSeats: clamp(Math.floor(normalizedNumber(config.maxSeats ?? DN_DEFAULT_CONFIG.maxSeats, DN_DEFAULT_CONFIG.maxSeats)), 2, 9),
    startingStack: clamp(Math.floor(normalizedNumber(config.startingStack ?? DN_DEFAULT_CONFIG.startingStack, DN_DEFAULT_CONFIG.startingStack)), 100, 1000000),
    baseStake: clamp(Math.floor(normalizedNumber(config.baseStake ?? DN_DEFAULT_CONFIG.baseStake, DN_DEFAULT_CONFIG.baseStake)), 1, 1000000),
    maxBetMult: clamp(Math.floor(normalizedNumber(config.maxBetMult ?? DN_DEFAULT_CONFIG.maxBetMult, DN_DEFAULT_CONFIG.maxBetMult)), 1, 10),
    scoreCap: clamp(Math.floor(normalizedNumber(config.scoreCap ?? DN_DEFAULT_CONFIG.scoreCap, DN_DEFAULT_CONFIG.scoreCap)), 0, 1000000),
    actionTimeoutMs: clamp(Math.floor(normalizedNumber(config.actionTimeoutMs ?? DN_DEFAULT_CONFIG.actionTimeoutMs, DN_DEFAULT_CONFIG.actionTimeoutMs)), 5000, 120000),
    disconnectGraceMs: clamp(Math.floor(normalizedNumber(config.disconnectGraceMs ?? DN_DEFAULT_CONFIG.disconnectGraceMs, DN_DEFAULT_CONFIG.disconnectGraceMs)), 10000, 900000),
  };
  return normalized;
}

function makeDnPlayer(token, name, stack) {
  return {
    token: makeDnToken(token),
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
    isBanker: false,      // 斗牛：本局是否为庄家
    stakeMult: 0,         // 斗牛：有庄模式闲家为盲注倍数，庄家固定 0；无庄模式参与者固定 1
    skipped: false,       // 斗牛：闲家放弃本局（不下注不结算）
    holeCards: [],
    handContribution: 0,
    actedAt: null,
    actionCount: 0,
    showdownRank: null,
    bullCards: null,
    isBot: false,
    botLevel: null,
    botCreatedAt: null,
  };
}

function normalizeDnPlayer(player, fallbackStack) {
  return {
    ...makeDnPlayer(player.token, player.name, fallbackStack),
    ...player,
    token: makeDnToken(player.token),
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
    isBanker: Boolean(player.isBanker),
    stakeMult: Number(player.stakeMult ?? 0),
    skipped: Boolean(player.skipped),
    holeCards: Array.isArray(player.holeCards) ? [...player.holeCards] : [],
    handContribution: Number(player.handContribution ?? 0),
    actedAt: player.actedAt == null ? null : Number(player.actedAt),
    actionCount: Number(player.actionCount ?? 0),
    showdownRank: player.showdownRank ?? null,
    bullCards: Array.isArray(player.bullCards) ? [...player.bullCards] : null,
    isBot: Boolean(player.isBot),
    botLevel: player.botLevel ?? null,
    botCreatedAt: player.botCreatedAt == null ? null : Number(player.botCreatedAt),
    botDecision: null,
  };
}

function normalizeDnHand(hand) {
  if (!hand) return null;
  return {
    id: Number(hand.id ?? 0),
    status: hand.status || 'running',
    mode: hand.mode === 'none' ? 'none' : 'banker',
    phase: hand.phase || 'bet',
    deck: Array.isArray(hand.deck) ? [...hand.deck] : [],
    deckIndex: Number(hand.deckIndex ?? 0),
    dealt: Boolean(hand.dealt ?? false),
    dealtAt: hand.dealtAt == null ? null : Number(hand.dealtAt),
    dealOrder: Array.isArray(hand.dealOrder) ? hand.dealOrder.map(Number) : [],
    pot: Number(hand.pot ?? 0),
    finalPot: Number(hand.finalPot ?? 0),
    dealerSeat: hand.dealerSeat == null ? null : Number(hand.dealerSeat),
    bankerSeat: hand.bankerSeat == null ? null : Number(hand.bankerSeat),
    bankerToken: hand.bankerToken == null ? null : String(hand.bankerToken),
    bankerDecision: hand.bankerDecision && typeof hand.bankerDecision === 'object' ? { ...hand.bankerDecision } : null,
    actionQueue: Array.isArray(hand.actionQueue) ? hand.actionQueue.map(Number) : [],
    turnDeadlineAt: hand.turnDeadlineAt == null ? null : Number(hand.turnDeadlineAt),
    dealerMessage: hand.dealerMessage || '',
    winners: Array.isArray(hand.winners) ? [...hand.winners] : [],
    losers: Array.isArray(hand.losers) ? [...hand.losers] : [],
    results: Array.isArray(hand.results) ? [...hand.results] : [],
    revealed: Boolean(hand.revealed ?? false),
    playerStreetActions: hand.playerStreetActions && typeof hand.playerStreetActions === 'object' ? { ...hand.playerStreetActions } : {},
  };
}

export function hydrateDnRoom(snapshot) {
  const config = normalizeDnConfig(snapshot.config);
  const players = Array.isArray(snapshot.players)
    ? snapshot.players.map((player) => normalizeDnPlayer(player, config.startingStack))
    : [];
  let hand = normalizeDnHand(snapshot.hand);

  // ===== 规则升级迁移：旧的「抢庄」流程已移除 =====
  // 抢庄与下注阶段都不会真实扣筹码，因此直接安全取消本局不会丢筹码，
  // 也不必为实现兼容而永久保留两套动作状态机。
  let legacyCancelled = false;
  if (hand && hand.status === 'running' && (hand.phase === 'grab' || hand.phase === 'bet')) {
    legacyCancelled = true;
    for (const player of players) {
      player.inHand = false;
      player.isBanker = false;
      player.stakeMult = 0;
      player.skipped = false;
      player.holeCards = [];
      player.handContribution = 0;
      player.showdownRank = null;
      player.botDecision = null;
    }
    hand = null;
  }

  // 旧快照没有 bankerToken：由上局 bankerSeat 反查，让庄家身份得以延续
  let bankerToken = snapshot.bankerToken == null ? null : String(snapshot.bankerToken);
  if (bankerToken == null && hand?.bankerSeat != null) {
    bankerToken = players.find((player) => player.seatIndex === hand.bankerSeat)?.token ?? null;
  }
  if (config.bankerMode === 'none') bankerToken = null;

  const room = {
    gameType: 'dn',
    code: snapshot.code,
    name: snapshot.name || `斗牛桌 ${snapshot.code}`,
    createdAt: Number(snapshot.createdAt ?? now()),
    updatedAt: Number(snapshot.updatedAt ?? snapshot.createdAt ?? now()),
    config,
    handNo: Number(snapshot.handNo ?? 0),
    dealerSeat: snapshot.dealerSeat == null ? null : Number(snapshot.dealerSeat),
    bankerToken,
    players,
    departedPlayers: Array.isArray(snapshot.departedPlayers) ? [...snapshot.departedPlayers] : [],
    hand,
    log: Array.isArray(snapshot.log) ? [...snapshot.log] : [],
    recentHands: Array.isArray(snapshot.recentHands) ? [...snapshot.recentHands] : [],
    socketMap: {},
  };
  if (legacyCancelled) {
    appendLog(room, 'system', '规则升级：未完成的旧抢庄牌局已安全取消');
  }
  return room;
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

// 无庄模式有真实底池（各家已扣的底注）；有庄模式是庄闲直接划账，
// 这里按「底分 × 闲家倍数」求和，仅作为桌面展示的名义底池
function currentPot(room) {
  const mode = room.hand?.mode ?? room.config.bankerMode;
  if (mode === 'none') {
    return room.players.reduce((sum, player) => sum + player.handContribution, 0);
  }
  return room.players.reduce((sum, player) => (
    player.isBanker ? sum : sum + room.config.baseStake * (player.stakeMult ?? 0)
  ), 0);
}

// ===== 发牌：所有模式都在「庄家与下注确定之后」才发牌 =====
function dealDnCards(room, players) {
  const hand = room.hand;
  if (!hand || hand.dealt) return;
  hand.phase = 'deal';
  hand.dealOrder = players.map((player) => player.seatIndex);
  for (const player of players) player.holeCards = [];
  for (let cardNo = 0; cardNo < 5; cardNo += 1) {
    for (const player of players) {
      player.holeCards.push(draw(room));
    }
  }
  hand.dealt = true;
  hand.dealtAt = now();
}

// 最大余数法：把 budget 按 claim 比例分给各赢家，保证总额恰好等于 budget
function allocateByLargestRemainder(pairs, budget) {
  const total = pairs.reduce((sum, pair) => sum + pair.claim, 0);
  if (total <= 0) {
    for (const pair of pairs) pair.amount = 0;
    return;
  }
  const scale = budget / total;
  for (const pair of pairs) {
    const exact = pair.claim * scale;
    pair.amount = Math.floor(exact);
    pair.remainder = exact - Math.floor(exact);
  }
  let left = budget - pairs.reduce((sum, pair) => sum + pair.amount, 0);
  const ordered = [...pairs].sort((a, b) => (
    (b.remainder - a.remainder) || ((a.punter.seatIndex ?? 0) - (b.punter.seatIndex ?? 0))
  ));
  for (const pair of ordered) {
    if (left <= 0) break;
    pair.amount += 1;
    left -= 1;
  }
}

function resetPlayerForHand(player) {
  player.inHand = false;
  player.folded = false;
  player.allIn = false;
  player.isBanker = false;
  player.stakeMult = 0;
  player.skipped = false;
  player.ready = false;
  player.holeCards = [];
  player.handContribution = 0;
  player.actedAt = null;
  player.actionCount = 0;
  player.showdownRank = null;
  player.bullCards = null;
  player.botDecision = null;
}

function draw(room) {
  return room.hand.deck[room.hand.deckIndex++];
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

function persistDnHand(store, room, details) {
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
    gameType: 'dn',
    winners: [...room.hand.winners],
    logs: [...room.log],
    participants,
    ...details,
  });
}

// 结算条目：与 results 字段保持一致，供结算弹窗直接展示倍数与牌型
function snapshotResultEntry(entry) {
  return {
    token: entry.token,
    name: entry.name,
    seatIndex: entry.seatIndex,
    isBanker: entry.isBanker,
    stakeMult: entry.stakeMult,
    mult: entry.mult,
    handLabel: entry.handLabel,
    holeCards: entry.holeCards,
    bullCards: entry.bullCards ?? null,
  };
}

function pushRecentHand(room, extra = {}) {
  room.recentHands.unshift({
    handNo: room.hand.id,
    winners: [...room.hand.winners],
    finalPot: room.hand.finalPot ?? 0,
    finishedAt: now(),
    ...extra,
  });
  room.recentHands = room.recentHands.slice(0, 20);
}

// ===== 无庄结算：各家统一下底注，摊牌后牌最大者通吃全部底池 =====
function settleNoBankerHand(room, store) {
  const hand = room.hand;
  hand.actionQueue = [];
  hand.turnDeadlineAt = null;
  hand.status = 'finished';
  hand.phase = 'showdown';
  hand.revealed = Boolean(hand.dealt);

  const live = room.players.filter((player) => player.inHand);
  // 选牌阶段已由玩家亲手确定牌型；此处兜底（未选牌/异常时取最优解）
  for (const player of live) {
    if (!player.showdownRank && player.holeCards.length === 5) {
      player.showdownRank = evaluateDnHand(player.holeCards);
    }
  }

  const pot = live.reduce((sum, player) => sum + player.handContribution, 0);
  hand.finalPot = pot;
  hand.pot = 0;

  // 唯一最大者通吃：compareDnHands > 0 则替换；完全相等（正常牌堆不会出现）按发牌顺序靠前者胜
  const orderOf = (seat) => {
    const index = hand.dealOrder.indexOf(seat);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  let winner = live.find((player) => player.showdownRank) ?? null;
  for (const player of live) {
    if (!player.showdownRank) continue;
    if (!winner) { winner = player; continue; }
    const cmp = compareDnHands(player.showdownRank, winner.showdownRank);
    if (cmp > 0 || (cmp === 0 && orderOf(player.seatIndex) < orderOf(winner.seatIndex))) {
      winner = player;
    }
  }

  // ===== 按赢家牌型翻倍：每位输家实际付出 = 底分 × 赢家牌型倍数 =====
  // 各家开局已扣的底注算在这笔钱里，因此这里只收「差额」；
  // 输家筹码不足时最多赔光，赢家拿到的总额相应减少。
  const winnerMult = winner?.showdownRank?.mult ?? 1;
  const cap = room.config.scoreCap;
  const paidTotals = new Map();
  let extraTotal = 0;

  if (winner && pot > 0) {
    for (const player of live) {
      if (player === winner) continue;
      const startStack = player.handStartStack ?? player.stack + player.handContribution;
      let owed = room.config.baseStake * winnerMult;
      if (cap > 0) owed = Math.min(owed, cap);
      // 最多赔光自己开局时的筹码
      owed = Math.min(owed, startStack);
      // 底注已在开局扣除，这里只补差额
      const extra = Math.max(0, Math.min(owed - player.handContribution, player.stack));
      if (extra > 0) {
        player.stack -= extra;
        winner.stack += extra;
        extraTotal += extra;
      }
      paidTotals.set(player.token, player.handContribution + extra);
    }
    winner.stack += pot;
    paidTotals.set(winner.token, winner.handContribution);
  }

  const payout = pot + extraTotal;

  hand.results = live
    .map((player) => {
      const delta = player.stack - (player.handStartStack ?? player.stack);
      return {
        seatIndex: player.seatIndex,
        token: player.token,
        name: player.name,
        isBanker: false,
        stakeMult: player.stakeMult,
        stake: paidTotals.get(player.token) ?? player.handContribution,
        handLabel: player.showdownRank ? describeDnHand(player.showdownRank) : null,
        holeCards: [...player.holeCards],
        bullCards: player.bullCards ? [...player.bullCards] : null,
        mult: player.showdownRank?.mult ?? 1,
        delta,
      };
    })
    .sort((a, b) => b.delta - a.delta);

  hand.winners = hand.results
    .filter((entry) => entry.delta > 0)
    .map((entry) => ({ ...snapshotResultEntry(entry), amount: entry.delta, payout, rank: null }));
  hand.losers = hand.results
    .filter((entry) => entry.delta < 0)
    .map((entry) => ({ ...snapshotResultEntry(entry), amount: -entry.delta, stake: entry.stake, rank: null }));

  hand.finalPot = payout;
  const winnerLabel = winner?.showdownRank ? describeDnHand(winner.showdownRank) : '';
  hand.dealerMessage = winner && pot > 0
    ? `${winner.name} ${winnerLabel} ×${winnerMult} 通吃 ${payout}`
    : '本局无输赢';
  if (winner && pot > 0) {
    appendLog(
      room,
      'settle',
      `${winner.name} ${winnerLabel}（×${winnerMult}）通吃 ${payout}，每位输家付 ${room.config.baseStake * winnerMult}`,
    );
  }

  pushRecentHand(room, { mode: 'none' });
  persistDnHand(store, room, {
    finalPot: payout,
    antePot: pot,
    winnerMult,
    mode: 'none',
  });
  return hand;
}

// ===== 有庄结算：庄家与每位闲家逐一比牌，按「底分 × 闲家倍数 × 赢家牌型倍数」划账 =====
function settleBankerHand(room, store) {
  const hand = room.hand;
  const base = room.config.baseStake;
  const cap = room.config.scoreCap;

  hand.actionQueue = [];
  hand.turnDeadlineAt = null;
  hand.status = 'finished';
  hand.phase = 'showdown';

  const banker = room.players.find((player) => player.token === hand.bankerToken) ?? null;
  const punters = room.players.filter((player) => (
    player.inHand && !player.isBanker && !player.skipped && player.stakeMult > 0
  ));

  // 所有闲家都放弃 → 不发牌、不评估、不转移筹码
  if (!banker || punters.length === 0) {
    hand.revealed = false;
    hand.finalPot = 0;
    hand.pot = 0;
    hand.winners = [];
    hand.losers = [];
    hand.results = room.players
      .filter((player) => player.inHand)
      .map((player) => ({
        seatIndex: player.seatIndex,
        token: player.token,
        name: player.name,
        isBanker: player.isBanker,
        stakeMult: player.stakeMult,
        stake: player.handContribution,
        handLabel: null,
        holeCards: [],
        mult: 1,
        delta: 0,
      }));
    hand.dealerMessage = '所有闲家均已放弃，本局流局';
    appendLog(room, 'hand', '本局流局：所有闲家都放弃了下注');
    pushRecentHand(room, { mode: 'banker', noBets: true });
    persistDnHand(store, room, { finalPot: 0, mode: 'banker', noBets: true });
    return hand;
  }

  // 选牌阶段已由玩家亲手确定牌型；此处兜底（未选牌/异常时取最优解）
  hand.revealed = true;
  for (const player of [banker, ...punters]) {
    if (!player.showdownRank && player.holeCards.length === 5) {
      player.showdownRank = evaluateDnHand(player.holeCards);
    }
  }

  const pairs = punters.map((punter) => {
    const punterWins = compareDnHands(punter.showdownRank, banker.showdownRank) > 0;
    const winnerMult = punterWins ? punter.showdownRank.mult : banker.showdownRank.mult;
    let claim = base * punter.stakeMult * winnerMult;
    if (cap > 0) claim = Math.min(claim, cap);
    // 闲家赔付上限 = 闲家全部筹码
    if (!punterWins) claim = Math.min(claim, punter.stack);
    return { punter, punterWins, claim };
  });

  // 庄家赔付上限 = 庄家全部筹码；不足时按最大余数法分摊，保证恰好付光
  const winnerPairs = pairs.filter((pair) => pair.punterWins);
  const totalClaim = winnerPairs.reduce((sum, pair) => sum + pair.claim, 0);
  allocateByLargestRemainder(winnerPairs, Math.min(totalClaim, banker.stack));

  const deltas = new Map();
  const bump = (player, value) => deltas.set(player.token, (deltas.get(player.token) ?? 0) + value);
  for (const pair of pairs) {
    const amount = pair.punterWins ? pair.amount : pair.claim;
    if (amount <= 0) continue;
    if (pair.punterWins) {
      bump(pair.punter, amount);
      bump(banker, -amount);
    } else {
      bump(pair.punter, -amount);
      bump(banker, amount);
    }
    appendLog(room, 'settle', `${pair.punter.name} ${pair.punterWins ? '胜庄家' : '负于庄家'} ${amount} 筹码`);
  }

  for (const player of room.players) {
    const delta = deltas.get(player.token) ?? 0;
    player.stack = Math.max(0, player.stack + delta);
  }

  hand.results = room.players
    .filter((player) => player.inHand)
    .map((player) => {
      const delta = deltas.get(player.token) ?? 0;
      return {
        seatIndex: player.seatIndex,
        token: player.token,
        name: player.name,
        isBanker: player.isBanker,
        stakeMult: player.stakeMult,
        stake: player.handContribution,
        handLabel: player.showdownRank ? describeDnHand(player.showdownRank) : null,
        holeCards: [...player.holeCards],
        bullCards: player.bullCards ? [...player.bullCards] : null,
        mult: player.showdownRank?.mult ?? 1,
        delta,
      };
    })
    .sort((a, b) => b.delta - a.delta);

  hand.winners = hand.results
    .filter((entry) => entry.delta > 0)
    .map((entry) => ({ ...snapshotResultEntry(entry), amount: entry.delta, rank: null }));
  hand.losers = hand.results
    .filter((entry) => entry.delta < 0)
    .map((entry) => ({ ...snapshotResultEntry(entry), amount: -entry.delta, rank: null }));

  hand.finalPot = hand.results.reduce((sum, entry) => sum + (entry.delta > 0 ? entry.delta : 0), 0);
  hand.pot = 0;
  hand.dealerMessage = hand.winners.length
    ? `${hand.winners.map((winner) => winner.name).join('、')} 共赢 ${hand.finalPot}`
    : '本局无输赢';

  pushRecentHand(room, { mode: 'banker' });
  persistDnHand(store, room, { finalPot: hand.finalPot, mode: 'banker', bankerSeat: hand.bankerSeat });
  return hand;
}

function settleDnHand(room, store) {
  return room.hand.mode === 'none'
    ? settleNoBankerHand(room, store)
    : settleBankerHand(room, store);
}

// 队列推进：盲注阶段只排闲家；选牌阶段排全员（庄家也要选牛牌）
function advanceDn(room, store) {
  const hand = room.hand;
  const alive = (seat) => {
    const player = playerAtSeat(room, seat);
    if (!player || !player.inHand) return false;
    if (hand.phase === 'bet') return !player.skipped && !player.isBanker;
    return true; // pick 阶段：庄家与所有已下注闲家都要选牌
  };

  hand.actionQueue = hand.actionQueue.slice(1).filter(alive);

  if (hand.actionQueue.length > 0) {
    hand.turnDeadlineAt = now() + room.config.actionTimeoutMs;
    return;
  }
  if (hand.phase === 'bet') {
    startPickPhase(room, store);
    return;
  }
  settleDnHand(room, store);
}

// 发牌后进入「选牛牌」阶段：玩家亲手挑出凑整十的三张，或选择没牛
// 两种模式共用：无庄在开局时已收底注并发牌，有庄在闲家盲注完毕后才发牌
function startPickPhase(room, store) {
  const hand = room.hand;

  if (!hand.dealt) {
    if (hand.mode === 'none') {
      const dealOrder = seatOrderFrom(room.dealerSeat, room.config.maxSeats)
        .map((seat) => playerAtSeat(room, seat))
        .filter((player) => player && player.inHand);
      dealDnCards(room, dealOrder);
    } else {
      const banker = room.players.find((player) => player.token === hand.bankerToken) ?? null;
      const punters = room.players.filter((player) => (
        player.inHand && !player.isBanker && !player.skipped && player.stakeMult > 0
      ));
      // 无人下注 → 不发牌，直接流局结算
      if (!banker || punters.length === 0) {
        settleDnHand(room, store);
        return;
      }
      dealDnCards(room, [banker, ...punters]);
    }
  }

  hand.phase = 'pick';
  hand.pot = currentPot(room);

  // 只给庄家与已下注闲家发过牌，选牌队列也只需这些人
  const dealt = room.players.filter((player) => player.inHand && player.holeCards.length === 5);
  hand.actionQueue = dealt.map((player) => player.seatIndex);
  hand.turnDeadlineAt = hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
  hand.dealerMessage = hand.actionQueue.length
    ? `${playerAtSeat(room, hand.actionQueue[0])?.name ?? '下一位'} 请选牛牌`
    : '无人可行动';

  if (hand.actionQueue.length === 0) {
    settleDnHand(room, store);
  }
}

// 校验并记录玩家的选牌：三张必须来自本人手牌且点数之和为 10 的倍数
function applyDnPick(room, player, cards) {
  const hand = room.hand;
  if (!Array.isArray(cards) || cards.length !== 3) {
    throw new Error('请选择 3 张牌');
  }
  if (new Set(cards).size !== 3) {
    throw new Error('不能重复选择同一张牌');
  }
  const hole = new Set(player.holeCards);
  if (cards.some((card) => !hole.has(card))) {
    throw new Error('只能选择自己的手牌');
  }
  // 特殊牌型（五小牛/炸弹/五花牛）与选哪三张无关
  const special = dnSpecialRank(player.holeCards);
  if (!special) {
    const sum = cards.reduce((total, card) => total + dnCardPoints(card), 0);
    if (sum % 10 !== 0) {
      throw new Error('这三张牌凑不出整十，请重新选择');
    }
  }

  player.showdownRank = evaluateDnPick(player.holeCards, cards);
  player.bullCards = special ? null : [...cards];
  const label = describeDnHand(player.showdownRank);
  recordHandAction(room, player, 'pick', 0, { bullCards: player.bullCards });
  hand.dealerMessage = `${player.name} 已选牌：${label}`;
  return `${player.name} 选牌：${label}`;
}

function applyDnPlayerAction(room, player, action, store) {
  const hand = room.hand;
  const type = action?.type;
  let message = '';

  if (hand.phase === 'bet') {
    if (type === 'bet') {
      if (player.isBanker) throw new Error('庄家无需下注');
      const mult = Math.floor(Number(action?.amount ?? 1));
      if (!Number.isFinite(mult) || mult < 1 || mult > room.config.maxBetMult) {
        throw new Error(`下注倍数需在 1~${room.config.maxBetMult} 之间`);
      }
      player.stakeMult = mult;
      message = `${player.name} 盲注 ×${mult}`;
      recordHandAction(room, player, 'bet', mult);
    } else if (type === 'pass') {
      player.skipped = true;
      player.stakeMult = 0;
      player.handContribution = 0;
      message = `${player.name} 放弃本局`;
      recordHandAction(room, player, 'skip');
    } else {
      throw new Error('未知行动');
    }
    hand.pot = currentPot(room);
    if (hand.status === 'running') {
      hand.dealerMessage = message;
    }
    advanceDn(room, store);
    return { message, log: message };
  }

  if (hand.phase === 'pick') {
    if (player.holeCards.length !== 5) throw new Error('你本局未发牌');
    if (type === 'pick') {
      message = applyDnPick(room, player, action.cards);
    } else if (type === 'nobull') {
      player.showdownRank = evaluateDnPick(player.holeCards, null);
      player.bullCards = null;
      const label = describeDnHand(player.showdownRank);
      recordHandAction(room, player, 'nobull', 0);
      message = `${player.name} 选择没牛（${label}）`;
      hand.dealerMessage = `${player.name} 选择没牛`;
    } else {
      throw new Error('未知行动');
    }
    if (hand.status === 'running') {
      hand.dealerMessage = message;
    }
    advanceDn(room, store);
    return { message, log: message };
  }

  throw new Error('当前不是行动阶段');
}

export function dnActionOptions(room, player) {
  const config = room.config;
  const phase = room.hand.phase;
  const base = {
    phase,
    mode: room.hand.mode,
    baseStake: config.baseStake,
    isBanker: player.isBanker,
  };

  if (phase === 'bet') {
    return {
      ...base,
      betOptions: Array.from({ length: config.maxBetMult }, (_, index) => index + 1),
      canBet: true,
      canPass: true,
    };
  }

  if (phase === 'pick') {
    const special = player.holeCards.length === 5 ? dnSpecialRank(player.holeCards) : null;
    return {
      ...base,
      canPick: true,
      canNobull: true,
      isSpecial: Boolean(special),
      specialLabel: special ? describeDnHand(special) : null,
      cardCount: player.holeCards.length,
    };
  }

  return { ...base, canBet: false, canPass: false };
}

function dnPlayerView(room, viewerToken, player) {
  const isViewer = player.token === viewerToken;
  const revealed = room.hand?.revealed || room.hand?.status === 'finished';
  // 自己的 5 张牌始终可见；他人牌面只在摊牌后公开
  const revealCards = revealed || isViewer;
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
    isBanker: player.isBanker,
    stakeMult: player.stakeMult,
    skipped: player.skipped,
    handContribution: player.handContribution,
    // 客户端筹码飞行动画复用字段：无庄用真实底注，有庄用「底分 × 倍数」的名义敞口
    streetContribution: room.hand?.mode === 'none'
      ? player.handContribution
      : room.config.baseStake * (player.stakeMult ?? 0),
    holeCards: revealCards ? [...player.holeCards] : (player.inHand ? ['??', '??', '??', '??', '??'] : []),
    handLabel: revealCards && player.showdownRank ? describeDnHand(player.showdownRank) : null,
    // 自己选的牛牌（仅本人可见，用于高亮与展示选择结果）
    bullCards: isViewer && player.bullCards ? [...player.bullCards] : null,
    pickDone: Boolean(player.showdownRank),
    isViewer,
    isBot: player.isBot || false,
    botLevel: player.botLevel || null,
  };
}

// 当前/下一局的庄家（无庄模式恒为 null）
function dnBankerView(room, viewer) {
  if (room.config.bankerMode !== 'banker') return null;
  const banker = room.players.find((player) => player.token === room.bankerToken) ?? null;
  if (!banker) return null;
  return {
    name: banker.name,
    seatIndex: banker.seatIndex,
    stack: banker.stack,
    connected: banker.connected,
    isBot: banker.isBot || false,
    eligibleForNextHand: canJoinNextHand(banker),
    isViewer: viewer ? viewer.token === banker.token : false,
  };
}

// 庄家续庄/移交操作区：只有「刚结束那局的庄家」在非 running 时可操作，
// targetToken 只下发给有操作权的庄家，避免泄露其他玩家身份
function dnBankerControlView(room, viewer) {
  const hand = room.hand;
  const idle = { canManage: false, decisionPending: false, canKeep: false, decision: null, transferCandidates: [] };
  if (room.config.bankerMode !== 'banker') return idle;
  if (!hand || hand.status !== 'finished' || !hand.bankerToken) return idle;

  const canManage = Boolean(viewer && viewer.token === hand.bankerToken && !hand.bankerDecision);
  if (!canManage) {
    return {
      canManage: false,
      decisionPending: Boolean(hand.bankerDecision),
      canKeep: false,
      decision: hand.bankerDecision ?? null,
      transferCandidates: [],
    };
  }

  return {
    canManage: true,
    decisionPending: false,
    canKeep: canJoinNextHand(viewer),
    decision: null,
    transferCandidates: room.players
      .filter((player) => player.token !== viewer.token && canJoinNextHand(player))
      .map((player) => ({
        targetToken: player.token,
        name: player.name,
        seatIndex: player.seatIndex,
        stack: player.stack,
        connected: player.connected,
        isBot: player.isBot || false,
      })),
  };
}

export function dnRoomSummary(room) {
  return {
    gameType: 'dn',
    bankerMode: room.config.bankerMode,
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

export function serializeDnRoom(room, viewerToken = null) {
  const selfPlayer = viewerToken ? room.players.find((player) => player.token === viewerToken) : null;
  const viewer = selfPlayer;
  return {
    gameType: 'dn',
    summary: dnRoomSummary(room),
    code: room.code,
    name: room.name,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    config: { ...room.config },
    bankerMode: room.config.bankerMode,
    handNo: room.handNo,
    dealerSeat: room.dealerSeat,
    banker: dnBankerView(room, viewer),
    isViewerBanker: Boolean(viewer && room.bankerToken && viewer.token === room.bankerToken),
    bankerControl: dnBankerControlView(room, viewer),
    players: room.players.map((player) => dnPlayerView(room, viewerToken, player)),
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
      isBanker: selfPlayer.isBanker,
      stakeMult: selfPlayer.stakeMult,
      skipped: selfPlayer.skipped,
      handContribution: selfPlayer.handContribution,
      holeCards: [...selfPlayer.holeCards],
      handLabel: selfPlayer.showdownRank ? describeDnHand(selfPlayer.showdownRank) : null,
      isBot: selfPlayer.isBot || false,
      botLevel: selfPlayer.botLevel || null,
    } : null,
    hand: room.hand ? {
      id: room.hand.id,
      status: room.hand.status,
      phase: room.hand.phase,
      mode: room.hand.mode,
      bankerSeat: room.hand.bankerSeat,
      bankerToken: room.hand.bankerToken,
      bankerDecision: room.hand.bankerDecision ?? null,
      dealt: room.hand.dealt,
      dealerSeat: room.hand.dealerSeat,
      actionSeat: room.hand.actionQueue[0] ?? null,
      actionQueue: [...room.hand.actionQueue],
      turnDeadlineAt: room.hand.turnDeadlineAt,
      pot: room.hand.pot,
      finalPot: room.hand.finalPot ?? 0,
      dealerMessage: room.hand.dealerMessage,
      winners: [...room.hand.winners],
      losers: [...room.hand.losers],
      results: [...room.hand.results],
      revealed: room.hand.revealed,
      playerStreetActions: { ...room.hand.playerStreetActions },
      availableActions: (() => {
        if (room.hand.status !== 'running') return null;
        if (!viewer || !viewer.inHand) return null;
        // 盲注阶段庄家不行动；选牌阶段庄家也要选牛牌
        if (room.hand.phase === 'bet' && (viewer.skipped || viewer.isBanker)) return null;
        if (room.hand.actionQueue[0] !== viewer.seatIndex) return null;
        return dnActionOptions(room, viewer);
      })(),
    } : null,
    log: room.log.slice(-30),
    recentHands: [...room.recentHands],
    viewerToken,
    serverNow: now(),
  };
}

export class DnManager {
  constructor(store, { onUpdate, onHandStart, onClose, config, occupiedCodes } = {}) {
    this.store = store;
    this.onUpdate = onUpdate ?? (() => {});
    this.onHandStart = onHandStart ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.config = config || DN_DEFAULT_CONFIG;
    this.occupiedCodes = occupiedCodes ?? (() => new Set());
    this.rooms = new Map();

    for (const snapshot of this.store.listRooms()) {
      if (snapshot.gameType !== 'dn') continue;
      try {
        const room = hydrateDnRoom(snapshot);
        this.rooms.set(room.code, room);
      } catch (error) {
        console.warn(`跳过无法恢复的斗牛房间快照: ${snapshot?.code ?? '未知'} (${error.message})`);
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
    return room ? serializeDnRoom(room, viewerToken) : null;
  }

  listRooms() {
    return [...this.rooms.values()].map(dnRoomSummary);
  }

  listHandHistory(code, limit = 10) {
    return this.store.listHandHistory(String(code ?? '').trim().toUpperCase(), limit);
  }

  createRoom({ token, roomName, playerName, config = {} }) {
    const roomConfig = normalizeDnConfig(config);
    const room = {
      gameType: 'dn',
      code: makeDnRoomCode(this.allTakenCodes()),
      name: roomName?.trim() || '斗牛牌桌',
      createdAt: now(),
      updatedAt: now(),
      config: roomConfig,
      handNo: 0,
      dealerSeat: null,
      bankerToken: null,
      players: [],
      departedPlayers: [],
      hand: null,
      log: [],
      recentHands: [],
      socketMap: {},
    };

    const player = makeDnPlayer(token, playerName, roomConfig.startingStack);
    player.isHost = true;
    player.seatIndex = 0;
    player.everSeated = true;
    room.players.push(player);
    appendLog(room, 'room', `${player.name} 创建了斗牛房间`);
    this.rooms.set(room.code, room);
    this.emit(room);
    return { room, token: player.token };
  }

  joinRoom(code, { token, playerName }) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    const resolvedToken = makeDnToken(token);
    let player = room.players.find((entry) => entry.token === resolvedToken);

    if (!player) {
      if (room.players.length >= room.config.maxSeats + 12) {
        throw new Error('房间人数已满');
      }
      player = makeDnPlayer(resolvedToken, playerName, room.config.startingStack);
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
    const botToken = makeDnToken();
    const botName = 'Bot_' + botLevelLabel(botLevel) + '_' + botToken.slice(0, 4);
    const bot = makeDnPlayer(botToken, botName, room.config.startingStack);
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

    // 先清理输光的机器人，再统计参与者：避免"先算参与者、后移除"导致人数误判
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

    const participants = room.players.filter(canJoinNextHand);
    if (participants.length < 2) throw new Error('至少需要两名玩家');

    const readyPlayers = eligibleReadyPlayers(room);
    if (readyPlayers.length > 1 && !allReadyPlayers(room)) {
      throw new Error('还有玩家未准备');
    }

    room.handNo += 1;
    const mode = room.config.bankerMode;
    room.hand = {
      id: room.handNo,
      status: 'running',
      mode,
      phase: mode === 'none' ? 'ante' : 'bet',
      deck: createDnDeck(),
      deckIndex: 0,
      dealt: false,
      dealtAt: null,
      dealOrder: [],
      pot: 0,
      finalPot: 0,
      dealerSeat: null,
      bankerSeat: null,
      bankerToken: null,
      bankerDecision: null,
      actionQueue: [],
      turnDeadlineAt: null,
      dealerMessage: '',
      winners: [],
      losers: [],
      results: [],
      revealed: false,
      playerStreetActions: {},
    };

    for (const player of room.players) resetPlayerForHand(player);
    const live = room.players.filter(canJoinNextHand);
    for (const player of live) {
      player.inHand = true;
      player.handStartStack = player.stack;
    }

    const participantSeats = live.map((player) => player.seatIndex).sort((a, b) => a - b);
    room.dealerSeat = room.dealerSeat == null
      ? participantSeats[0]
      : (nextSeat(room, room.dealerSeat, canJoinNextHand) ?? participantSeats[0]);
    room.hand.dealerSeat = room.dealerSeat;

    // ===== 无庄：统一强制底注 → 选牌阶段（内部发牌） =====
    if (mode === 'none') {
      room.bankerToken = null;
      for (const player of live) {
        // 筹码不足底注时按剩余筹码 all-in 下底注，仍保留通吃资格
        const contribution = Math.min(room.config.baseStake, player.stack);
        player.stack -= contribution;
        player.stakeMult = 1;
        player.handContribution = contribution;
        room.hand.pot += contribution;
        recordHandAction(room, player, 'ante', contribution);
      }
      appendLog(room, 'hand', `第 ${room.handNo} 局开始（无庄，底注 ${room.config.baseStake}）`);
      startPickPhase(room, this.store);
      appendLog(room, 'hand', room.hand.dealerMessage);
      this.emit(room);
      this.onHandStart(room);
      return room;
    }

    // ===== 有庄：先在发牌前确定庄家 =====
    const previous = room.players.find((player) => player.token === room.bankerToken) ?? null;
    let banker = previous && canJoinNextHand(previous) && previous.inHand ? previous : null;
    if (!banker) {
      banker = live[Math.floor(Math.random() * live.length)];
      if (previous) {
        appendLog(room, 'system', `${previous.name} 无法继续坐庄，随机改由 ${banker.name} 坐庄`);
      }
    }

    banker.isBanker = true;
    banker.stakeMult = 0;
    banker.handContribution = 0;
    room.bankerToken = banker.token;
    room.hand.bankerToken = banker.token;
    room.hand.bankerSeat = banker.seatIndex;

    room.hand.actionQueue = seatOrderFrom(banker.seatIndex, room.config.maxSeats)
      .map((seat) => playerAtSeat(room, seat))
      .filter((player) => player && player.inHand && !player.isBanker)
      .map((player) => player.seatIndex);
    room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
    room.hand.dealerMessage = room.hand.actionQueue.length
      ? `${playerAtSeat(room, room.hand.actionQueue[0])?.name ?? '下一位'} 先盲注`
      : '无人可行动';

    appendLog(room, 'hand', `第 ${room.handNo} 局开始，庄家 ${banker.name}，底分 ${room.config.baseStake}`);
    if (room.hand.actionQueue.length === 0) {
      settleBankerHand(room, this.store);
      appendLog(room, 'hand', room.hand.dealerMessage);
    }
    this.emit(room);
    this.onHandStart(room);
    return room;
  }

  // 本局结束后由庄家决定下一局：续庄（keep）或移交给指定玩家（transfer）
  setBanker(code, token, action = 'keep', targetToken = null) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    if (room.config.bankerMode !== 'banker') throw new Error('无庄模式没有庄家');
    if (room.hand?.status === 'running') throw new Error('对局进行中不能变更庄家');

    const hand = room.hand;
    if (!hand || hand.status !== 'finished') throw new Error('本局结束后才能决定下一局庄家');
    if (!hand.bankerToken) throw new Error('本局没有庄家');
    if (hand.bankerToken !== token) throw new Error('只有本局庄家可以决定下一局庄家');

    const banker = room.players.find((player) => player.token === token);
    if (!banker) throw new Error('庄家已离开房间');
    // 每局只允许成功决定一次，避免重复请求与连续转手
    if (hand.bankerDecision) throw new Error('本局已做过庄家决定');

    if (action === 'transfer') {
      if (!targetToken) throw new Error('请指定移交目标');
      const target = room.players.find((player) => player.token === targetToken);
      if (!target) throw new Error('移交目标不在房间内');
      if (target.token === token) throw new Error('不能移交给自己');
      if (!canJoinNextHand(target)) throw new Error('该玩家无法坐庄（未坐下 / 筹码不足 / 已暂离）');
      room.bankerToken = target.token;
      hand.bankerDecision = {
        action: 'transfer',
        targetSeat: target.seatIndex,
        targetName: target.name,
        decidedAt: now(),
        automatic: false,
      };
      appendLog(room, 'banker', `${banker.name} 将庄家移交给 ${target.name}`);
    } else {
      if (targetToken) throw new Error('续庄不需要指定目标');
      if (!canJoinNextHand(banker)) throw new Error('你当前无法继续坐庄（未坐下 / 筹码不足 / 已暂离）');
      room.bankerToken = banker.token;
      hand.bankerDecision = {
        action: 'keep',
        targetSeat: banker.seatIndex,
        targetName: banker.name,
        decidedAt: now(),
        automatic: false,
      };
      appendLog(room, 'banker', `${banker.name} 续庄`);
    }

    this.emit(room);
    return room;
  }

  applyAction(code, token, action) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    if (!room.hand || room.hand.status !== 'running') throw new Error('当前没有进行中的对局');
    if (!room.hand.actionQueue.length) throw new Error('当前不需要行动');

    const player = room.players.find((entry) => entry.token === token);
    // 盲注阶段庄家不行动；选牌阶段庄家也要选牛牌
    const blocked = room.hand.phase === 'bet' && (player?.isBanker || player?.skipped);
    if (!player || !player.inHand || blocked) throw new Error('你不在当前行动列表');
    if (room.hand.actionQueue[0] !== player.seatIndex) throw new Error('还没轮到你');

    const result = applyDnPlayerAction(room, player, action, this.store);
    if (room.hand.status === 'running') {
      room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
    }
    appendLog(room, 'action', result.log);
    this.emit(room);
    return room;
  }

  cleanOldRooms() {
    if (!this.store) return;
    const cutoffTime = Date.now() - 30 * 60 * 1000;
    let cleanedCount = 0;

    for (const [code, room] of this.rooms) {
      const hasConnectedPlayer = room.players.some((player) => player.connected);
      if (hasConnectedPlayer || room.updatedAt >= cutoffTime) continue;
      this.onClose(room, { reason: 'cleaned' });
      this.rooms.delete(code);
      this.store.deleteRoom(code);
      cleanedCount++;
      console.log(`清理斗牛房间: ${code} (最后活跃: ${new Date(room.updatedAt).toISOString()})`);
    }

    if (cleanedCount > 0) {
      console.log(`清理完成: 删除了 ${cleanedCount} 个过期斗牛房间`);
    }
  }

  // 机器人庄家在牌局结束后自动决定续庄/移交（人类已开新局时该决定会作废，默认续庄）
  maybeBotBankerDecision(room, time) {
    const hand = room.hand;
    if (room.config.bankerMode !== 'banker' || !hand) return;
    if (hand.status !== 'finished' || hand.mode !== 'banker' || !hand.bankerToken) return;

    if (hand.bankerDecision) {
      room.__dnBotBanker = null;
      return;
    }
    const banker = room.players.find((player) => player.token === hand.bankerToken);
    if (!banker || !banker.isBot) return;

    const stateKey = `${hand.id}|${hand.bankerToken}`;
    if (!room.__dnBotBanker || room.__dnBotBanker.stateKey !== stateKey) {
      const candidates = room.players.filter((player) => player.token !== banker.token && canJoinNextHand(player));
      const decision = decideDnBotBanker(room, banker, candidates);
      room.__dnBotBanker = { stateKey, decision, readyAt: now() + decision.delayMs };
    }
    if (time < room.__dnBotBanker.readyAt) return;

    const decision = room.__dnBotBanker.decision;
    room.__dnBotBanker = null;
    try {
      this.setBanker(room.code, banker.token, decision.action, decision.targetToken ?? null);
      const label = decision.action === 'transfer'
        ? `将庄家移交给 ${room.players.find((player) => player.token === decision.targetToken)?.name ?? '下一位'}`
        : '续庄';
      appendLog(room, 'banker', `${banker.name} [${botLevelLabel(banker.botLevel)}] ${label}`);
    } catch (error) {
      // 决定被拒（例如人类已开下一局）时静默放弃，下一局按默认续庄处理
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

      this.maybeBotBankerDecision(room, time);

      if (!room.hand || room.hand.status !== 'running') continue;
      if (!room.hand.turnDeadlineAt) continue;

      const player = playerAtSeat(room, room.hand.actionQueue[0]);
      // 队列里只应留下本局已发牌、未决定的玩家；庄家也要选牌
      if (!player || !player.inHand || (room.hand.phase === 'pick' && player.holeCards.length !== 5)) {
        room.hand.actionQueue = room.hand.actionQueue.slice(1);
        room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
        advanceDn(room, this.store);
        this.emit(room);
        continue;
      }

      if (player.isBot) {
        const hand = room.hand;
        const stateKey = `${hand.id}|${hand.phase}|${hand.actionQueue[0]}|${Object.keys(hand.playerStreetActions ?? {}).length}`;
        if (!player.botDecision || player.botDecision.stateKey !== stateKey) {
          const actions = dnActionOptions(room, player);
          const decision = hand.phase === 'pick'
            ? decideDnBotPick(room, player)
            : decideDnBotTurn(room, player, actions);
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
        applyDnPlayerAction(room, player, botAction, this.store);
        const label = botAction.type === 'bet'
          ? `盲注 ×${botAction.amount}`
          : botAction.type === 'pick'
            ? `选牌（${describeDnHand(player.showdownRank)}）`
            : botAction.type === 'nobull'
              ? '选择没牛'
              : '放弃本局';
        appendLog(room, 'action', `${player.name} [${botLevelLabel(player.botLevel)}] ${label}`);
        if (room.hand.status === 'running') {
          room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
        }
        this.emit(room);
        continue;
      }

      // 人类超时：盲注阶段自动下注最低倍数；选牌阶段自动取最优解
      if (room.hand.turnDeadlineAt > time) continue;

      if (room.hand.phase === 'pick') {
        const best = dnBestBullPick(player.holeCards);
        const autoAction = best ? { type: 'pick', cards: best.bull } : { type: 'nobull' };
        applyDnPlayerAction(room, player, autoAction, this.store);
        appendLog(room, 'timeout', best
          ? `${player.name} 超时自动选牌（${describeDnHand(player.showdownRank)}）`
          : `${player.name} 超时自动按无牛结算`);
      } else {
        applyDnPlayerAction(room, player, { type: 'bet', amount: 1 }, this.store);
        appendLog(room, 'timeout', `${player.name} 超时自动盲注 ×1`);
      }
      if (room.hand.status === 'running') {
        room.hand.turnDeadlineAt = room.hand.actionQueue.length ? now() + room.config.actionTimeoutMs : null;
      }
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

  // root 管理：强制删除房间（无需房主、允许对局进行中），在线成员会收到 room:closed
  rootRemoveRoom(code) {
    const room = this.getRoom(code);
    if (!room) throw new Error('房间不存在');
    appendLog(room, 'room', '管理员强制关闭房间');
    this.onClose(room, { reason: 'admin_removed' });
    this.rooms.delete(room.code);
    this.store.deleteRoom(room.code);
    return { code: room.code, name: room.name };
  }
}
