import assert from 'node:assert/strict';
import test from 'node:test';
import { DnManager, hydrateDnRoom } from '../src/douniu-engine.js';
import {
  compareDnHands,
  describeDnHand,
  dnBullCandidates,
  dnCardPoints,
  dnCardRank,
  evaluateDnHand,
  evaluateDnPick,
  estimateDnStrength,
  DN_CATEGORY,
} from '../src/douniu.js';

class MemoryStore {
  constructor() {
    this.rooms = new Map();
    this.history = new Map();
  }

  saveRoom(room) {
    this.rooms.set(room.code, structuredClone(room));
  }

  loadRoom() {
    return null;
  }

  listRooms() {
    return [...this.rooms.values()].map((room) => structuredClone(room));
  }

  deleteRoom(code) {
    this.rooms.delete(code);
  }

  cleanOldRooms() {}

  cleanOldHistory() {}

  saveHandHistory(code, handNo, summary) {
    if (!this.history.has(code)) this.history.set(code, []);
    this.history.get(code).push({ handNo, summary });
  }

  listHandHistory(code) {
    return (this.history.get(code) || []).map((entry) => structuredClone(entry.summary));
  }

  close() {}
}

// ===== 点数换算 =====

test('点数换算：A=1，J/Q/K/T=10，2~9 为面值', () => {
  assert.equal(dnCardPoints('AS'), 1);
  assert.equal(dnCardPoints('5H'), 5);
  assert.equal(dnCardPoints('TS'), 10);
  assert.equal(dnCardPoints('JS'), 10);
  assert.equal(dnCardPoints('QH'), 10);
  assert.equal(dnCardPoints('KD'), 10);
  assert.equal(dnCardRank('AS'), 1);
  assert.equal(dnCardRank('TS'), 10);
  assert.equal(dnCardRank('JS'), 11);
  assert.equal(dnCardRank('QS'), 12);
  assert.equal(dnCardRank('KS'), 13);
});

// ===== 牌型判定 =====

test('常规牛：三张凑整十，剩余两张个位即牛数', () => {
  const niu7 = evaluateDnHand(['KS', '6H', '4D', '3C', '4S']);
  assert.equal(niu7.category, 7);
  assert.equal(niu7.niu, 7);
  assert.equal(niu7.mult, 2); // 牛7~牛9 为 2 倍

  const niu1 = evaluateDnHand(['KS', 'KH', 'QS', '2H', '9D']);
  assert.equal(niu1.category, 1);
  assert.equal(niu1.mult, 1);
});

test('牛牛：剩余两张个位为 0', () => {
  const rank = evaluateDnHand(['KS', 'KH', 'KD', '5C', '5D']);
  assert.equal(rank.category, DN_CATEGORY.NIU_NIU);
  assert.equal(rank.niu, 10);
  assert.equal(rank.mult, 3);
  assert.equal(rank.bullCards.length, 3);
  assert.equal(rank.niuCards.length, 2);
});

test('无牛：任意三张都凑不出整十', () => {
  const rank = evaluateDnHand(['AS', '2H', '3D', '4C', '9S']);
  assert.equal(rank.category, DN_CATEGORY.NONE);
  assert.equal(rank.niu, 0);
  assert.equal(rank.mult, 1);
  assert.equal(rank.bullCards, null);
});

test('五小牛：五张点数总和小于 10', () => {
  const rank = evaluateDnHand(['AS', 'AH', '2H', '2D', '3C']);
  assert.equal(rank.category, DN_CATEGORY.WU_XIAO);
  assert.equal(rank.mult, 7);
});

test('炸弹：四张同点数', () => {
  const rank = evaluateDnHand(['KS', 'KH', 'KD', 'KC', '5D']);
  assert.equal(rank.category, DN_CATEGORY.BOMB);
  assert.equal(rank.bombRank, 13);
  assert.equal(rank.mult, 6);
});

test('五花牛：五张全为 J/Q/K', () => {
  const rank = evaluateDnHand(['KS', 'KH', 'QD', 'QC', 'JS']);
  assert.equal(rank.category, DN_CATEGORY.WU_HUA);
  assert.equal(rank.mult, 5);
});

test('手牌必须为 5 张', () => {
  assert.throws(() => evaluateDnHand(['AS', 'AH']), /5 张/);
});

// ===== 大小比较 =====

test('牌型链：五小牛 > 炸弹 > 五花牛 > 牛牛 > 牛9 > ... > 牛1 > 无牛', () => {
  const order = [
    ['AS', 'AH', '2H', '2D', '3C'],
    ['KS', 'KH', 'KD', 'KC', '5D'],
    ['KS', 'KH', 'QD', 'QC', 'JS'],
    ['KS', 'KH', 'KD', '5C', '5D'],
    ['QS', 'QH', 'QD', '5C', '4D'],
    ['KS', '6H', '4D', '3C', '4S'],
    ['KS', 'KH', 'QS', '2H', '9D'],
    ['AS', '2H', '3D', '4C', '9S'],
  ];
  for (let i = 0; i < order.length - 1; i += 1) {
    assert.ok(
      compareDnHands(evaluateDnHand(order[i]), evaluateDnHand(order[i + 1])) > 0,
      `${order[i]} 应大于 ${order[i + 1]}`,
    );
  }
});

test('同牌型先比最大牌点数，再比花色', () => {
  const kingHigh = evaluateDnHand(['KS', 'KH', 'KD', '5C', '5D']);
  const queenHigh = evaluateDnHand(['QS', 'QH', 'QD', '5C', '5D']);
  assert.ok(compareDnHands(kingHigh, queenHigh) > 0);

  const spade = evaluateDnHand(['KS', 'KH', 'KD', '5C', '5D']);
  const heart = evaluateDnHand(['KH', 'KD', 'KC', '5S', '5H']);
  assert.equal(spade.maxRank, heart.maxRank);
  assert.ok(compareDnHands(spade, heart) > 0);
});

test('炸弹之间比四张同点的点数', () => {
  assert.ok(compareDnHands(
    evaluateDnHand(['KS', 'KH', 'KD', 'KC', '5D']),
    evaluateDnHand(['QS', 'QH', 'QD', 'QC', '5D']),
  ) > 0);
});

test('牌力估值：特殊牌型最高，无牛最低', () => {
  const none = estimateDnStrength(['AS', '2H', '3D', '4C', '9S']);
  const niu7 = estimateDnStrength(['KS', '6H', '4D', '3C', '4S']);
  const niuNiu = estimateDnStrength(['KS', 'KH', 'KD', '5C', '5D']);
  const bomb = estimateDnStrength(['KS', 'KH', 'KD', 'KC', '5D']);
  assert.ok(bomb > niuNiu);
  assert.ok(niuNiu > niu7);
  assert.ok(niu7 > none);
  assert.equal(estimateDnStrength(['??', '??', '??', '??', '??']), 0.35);
});

test('中文牌型描述', () => {
  assert.equal(describeDnHand(evaluateDnHand(['KS', 'KH', 'KD', '5C', '5D'])), '牛牛 K高');
  assert.equal(describeDnHand(evaluateDnHand(['KS', '6H', '4D', '3C', '4S'])), '牛7 K高');
  assert.equal(describeDnHand(evaluateDnHand(['AS', '2H', '3D', '4C', '9S'])), '无牛 9高');
  assert.equal(describeDnHand(evaluateDnHand(['KS', 'KH', 'KD', 'KC', '5D'])), '炸弹 K');
  assert.equal(describeDnHand(evaluateDnHand(['KS', 'KH', 'QD', 'QC', 'JS'])), '五花牛');
  assert.equal(describeDnHand(evaluateDnHand(['AS', 'AH', '2H', '2D', '3C'])), '五小牛 3高');
});

// ===== 引擎辅助 =====

function createDnTable({ humans = 2, maxSeats = 4, config = {} } = {}) {
  const store = new MemoryStore();
  const manager = new DnManager(store);
  const created = manager.createRoom({
    token: 'a',
    roomName: 'Test',
    playerName: 'Alice',
    config: { maxSeats, baseStake: 10, startingStack: 1000, ...config },
  });
  const code = created.room.code;
  manager.seatPlayer(code, 'a', 0);
  const tokens = ['a'];
  for (let i = 1; i < humans; i += 1) {
    const token = String.fromCharCode(97 + i); // b, c, ...
    manager.joinRoom(code, { token, playerName: `P${i + 1}` });
    manager.seatPlayer(code, token, i);
    tokens.push(token);
  }
  return { manager, store, code, tokens };
}

function readyDnTable(manager, code) {
  const room = manager.getRoom(code);
  for (const player of room.players.filter((c) => c.seatIndex !== null && !c.isBot && c.stack > 0 && !c.sitOut)) {
    manager.toggleReady(code, player.token);
  }
}

function playerAt(room, seat) {
  return room.players.find((player) => player.seatIndex === seat);
}

// 发牌延后到「庄家与下注确定之后」，确定性用例改为预设牌堆。
// 发牌是「每轮各家一张」交错进行的，因此必须按真实发牌顺序写入：
//   无庄 = 发牌圈顺序；有庄 = [庄家, ...room.players 中的闲家]
function stackDeck(room, order, handsBySeat) {
  const deck = [];
  for (let cardNo = 0; cardNo < 5; cardNo += 1) {
    for (const seat of order) deck.push(handsBySeat[seat][cardNo]);
  }
  room.hand.deck = deck;
  room.hand.deckIndex = 0;
}

// 有庄模式的真实发牌顺序：庄家先拿，其余按 room.players 顺序
function bankerDealOrder(room, bankerSeat) {
  return [
    bankerSeat,
    ...room.players.filter((player) => player.seatIndex !== bankerSeat).map((player) => player.seatIndex),
  ];
}

// 无庄模式的真实发牌顺序：从起手庄位下家起按座位圈
function noneDealOrder(room) {
  const seats = [...Array(room.config.maxSeats).keys()];
  const start = room.dealerSeat ?? 0;
  const order = [];
  for (let i = 1; i <= seats.length; i += 1) order.push((start + i) % seats.length);
  return order.filter((seat) => room.players.some((player) => player.seatIndex === seat));
}

// 让指定 token 完成选牌：优先提交最优三张，无牛则提交没牛
function pickFor(manager, code, token) {
  const view = manager.getRoomView(code, token);
  if (!view.hand?.availableActions?.canPick) return false;
  const me = view.players.find((player) => player.isViewer);
  const combos = dnBullCandidates(me.holeCards);
  if (combos.length) {
    manager.applyAction(code, token, { type: 'pick', cards: combos[0] });
  } else {
    manager.applyAction(code, token, { type: 'nobull' });
  }
  return true;
}

// 把牌局推进到终局：反复让"轮到的玩家"选牌
function finishPicks(manager, code) {
  for (let i = 0; i < 12; i += 1) {
    const room = manager.getRoom(code);
    if (!room.hand || room.hand.status !== 'running') return;
    const seat = room.hand.actionQueue[0];
    if (seat == null) return;
    const player = playerAt(room, seat);
    if (!player) return;
    pickFor(manager, code, player.token);
  }
}

// ===== 引擎：配置与快照迁移 =====

test('bankerMode 非法值回退为有庄，且不再出现 maxGrabMult', () => {
  const { manager, code } = createDnTable({ config: { bankerMode: '乱七八糟' } });
  const room = manager.getRoom(code);
  assert.equal(room.config.bankerMode, 'banker');
  assert.equal('maxGrabMult' in room.config, false);

  const none = createDnTable({ config: { bankerMode: 'none' } });
  assert.equal(none.manager.getRoom(none.code).config.bankerMode, 'none');
});

test('旧快照迁移：无 bankerMode 视为有庄；未完成的旧抢庄局安全取消', () => {
  const room = hydrateDnRoom({
    gameType: 'dn',
    code: 'LEGACY',
    name: '旧房',
    config: { maxSeats: 4, baseStake: 10, startingStack: 1000, maxGrabMult: 4 },
    handNo: 3,
    dealerSeat: 0,
    players: [
      { token: 'a', name: 'A', seatIndex: 0, stack: 900, inHand: true, holeCards: ['AS', 'AH', 'AD', 'AC', '2S'] },
      { token: 'b', name: 'B', seatIndex: 1, stack: 1100, inHand: true, holeCards: ['KS', 'KH', 'KD', 'KC', '5D'] },
    ],
    hand: { id: 3, status: 'running', phase: 'grab', grabs: { 0: { mult: 2, order: 0 } } },
  });
  assert.equal(room.config.bankerMode, 'banker');
  assert.equal('maxGrabMult' in room.config, false);
  // 进行中的旧局被安全取消且筹码不变
  assert.equal(room.hand, null);
  assert.equal(room.players[0].stack, 900);
  assert.equal(room.players[1].stack, 1100);
  assert.equal(room.players[0].holeCards.length, 0);
  assert.ok(room.log.some((entry) => String(entry.text).includes('规则升级')));
});

test('旧快照迁移：已结束的旧局保留庄家身份供下一局延续', () => {
  const room = hydrateDnRoom({
    gameType: 'dn',
    code: 'OLD2',
    config: { maxSeats: 4 },
    handNo: 5,
    players: [
      { token: 'a', name: 'A', seatIndex: 0, stack: 1000 },
      { token: 'b', name: 'B', seatIndex: 1, stack: 1000 },
    ],
    hand: { id: 5, status: 'finished', phase: 'showdown', bankerSeat: 1 },
  });
  assert.equal(room.bankerToken, 'b');
});

// ===== 引擎：有庄模式 =====

test('有庄开局：发牌前确定庄家，全员手牌为空，进入盲注阶段', () => {
  const { manager, code } = createDnTable({ humans: 3 });
  readyDnTable(manager, code);
  const room = manager.getRoom(code);
  assert.equal(room.hand.status, 'running');
  assert.equal(room.hand.mode, 'banker');
  assert.equal(room.hand.phase, 'bet');
  assert.notEqual(room.hand.bankerSeat, null);
  assert.equal(room.bankerToken, playerAt(room, room.hand.bankerSeat).token);
  for (const player of room.players) {
    assert.equal(player.holeCards.length, 0, '下注完成前不应发牌');
  }
  // 庄家不进入行动队列
  assert.equal(room.hand.actionQueue.length, 2);
  assert.ok(!room.hand.actionQueue.includes(room.hand.bankerSeat));

  const view = manager.getRoomView(code, 'a');
  assert.equal(view.bankerMode, 'banker');
  assert.equal(view.banker.seatIndex, room.hand.bankerSeat);
  // 视图里他人牌面是 '??' 占位，不能出现任何真实牌
  for (const player of view.players) {
    if (player.isViewer) {
      assert.equal(player.holeCards.length, 0);
    } else {
      assert.ok(player.holeCards.every((card) => card === '??'));
    }
  }
});

test('有庄首局庄家来自可参赛玩家', () => {
  const { manager, code } = createDnTable({ humans: 3 });
  readyDnTable(manager, code);
  const room = manager.getRoom(code);
  const banker = playerAt(room, room.hand.bankerSeat);
  assert.ok(banker.seatIndex !== null && banker.stack > 0 && !banker.sitOut);
});

test('有庄完整一局：结算 = 底分 × 闲家倍数 × 赢家牌型倍数', () => {
  const { manager, code } = createDnTable({ humans: 2 });
  readyDnTable(manager, code);
  let room = manager.getRoom(code);

  const banker = playerAt(room, room.hand.bankerSeat);
  const punter = room.players.find((player) => player.seatIndex !== banker.seatIndex);
  // 闲家拿牛牛(3 倍)，庄家拿无牛(1 倍)
  stackDeck(room, bankerDealOrder(room, banker.seatIndex), {
    [banker.seatIndex]: ['AS', '2H', '3D', '4C', '9S'],
    [punter.seatIndex]: ['KS', 'KH', 'KD', '5C', '5D'],
  });

  manager.applyAction(code, punter.token, { type: 'bet', amount: 2 });
  room = manager.getRoom(code);
  // 下注完毕 → 发牌 → 选牌阶段，此时尚未结算
  assert.equal(room.hand.phase, 'pick');
  assert.equal(room.hand.dealt, true);
  assert.equal(punter.holeCards.length, 5);
  assert.equal(banker.holeCards.length, 5);

  // 只有部分人选完牌 → 仍未结算
  const firstInQueue = playerAt(room, room.hand.actionQueue[0]);
  pickFor(manager, code, firstInQueue.token);
  room = manager.getRoom(code);
  assert.equal(room.hand.status, 'running');
  assert.equal(room.hand.phase, 'pick');

  // 全员选完 → 结算
  finishPicks(manager, code);
  room = manager.getRoom(code);

  assert.equal(room.hand.status, 'finished');
  assert.equal(room.hand.revealed, true);
  // 10 × 2（闲家倍数）× 3（牛牛）= 60
  const winner = room.hand.winners.find((entry) => entry.token === punter.token);
  assert.ok(winner, '牛牛应战胜无牛');
  assert.equal(winner.amount, 60);
  assert.equal(punter.stack, 1060);
  assert.equal(banker.stack, 940);
  assert.equal(room.players.reduce((sum, p) => sum + p.stack, 0), 2000);
  // 结算公式里不再存在庄家倍数
  assert.equal('bankerMult' in room.hand, false);
});

test('有庄：闲家全部放弃 → 不发牌、不评估、筹码不变', () => {
  const { manager, code } = createDnTable({ humans: 2 });
  readyDnTable(manager, code);
  let room = manager.getRoom(code);
  const punter = playerAt(room, room.hand.actionQueue[0]);

  manager.applyAction(code, punter.token, { type: 'pass' });
  room = manager.getRoom(code);

  assert.equal(room.hand.status, 'finished');
  assert.equal(room.hand.revealed, false);
  assert.equal(room.hand.finalPot, 0);
  assert.equal(room.hand.winners.length, 0);
  for (const player of room.players) {
    assert.equal(player.holeCards.length, 0);
    assert.equal(player.stack, 1000);
  }
  assert.match(room.hand.dealerMessage, /流局/);
});

test('有庄：发牌只给庄家与已下注闲家', () => {
  const { manager, code } = createDnTable({ humans: 3 });
  readyDnTable(manager, code);
  let room = manager.getRoom(code);
  const banker = playerAt(room, room.hand.bankerSeat);
  const [first, second] = room.hand.actionQueue.map((seat) => playerAt(room, seat));

  manager.applyAction(code, first.token, { type: 'pass' });
  room = manager.getRoom(code);
  manager.applyAction(code, second.token, { type: 'bet', amount: 1 });
  room = manager.getRoom(code);

  // 下注完毕 → 发牌并进入选牌阶段
  assert.equal(room.hand.phase, 'pick');
  assert.equal(first.holeCards.length, 0, '放弃者不发牌');
  assert.equal(second.holeCards.length, 5);
  assert.equal(banker.holeCards.length, 5);
  // 放弃者不在选牌队列里
  assert.ok(!room.hand.actionQueue.includes(first.seatIndex));
});

test('有庄：闲家赔付封顶到自身筹码', () => {
  const { manager, code } = createDnTable({ humans: 2 });
  readyDnTable(manager, code);
  let room = manager.getRoom(code);
  const banker = playerAt(room, room.hand.bankerSeat);
  const punter = room.players.find((player) => player.seatIndex !== banker.seatIndex);
  // 闲家无牛输给庄家五小牛（7 倍）
  stackDeck(room, bankerDealOrder(room, banker.seatIndex), {
    [banker.seatIndex]: ['AS', 'AH', '2H', '2D', '3C'],
    [punter.seatIndex]: ['TS', '2H', '3D', '4C', '9S'],
  });
  punter.stack = 30;

  manager.applyAction(code, punter.token, { type: 'bet', amount: 5 });
  room = manager.getRoom(code);
  assert.equal(room.hand.phase, 'pick');
  finishPicks(manager, code);
  room = manager.getRoom(code);

  // 10 × 5 × 7 = 350，但闲家只有 30
  assert.equal(punter.stack, 0);
  assert.equal(banker.stack, 1030);
});

test('有庄：庄家筹码不足按最大余数法分摊，恰好付光且守恒', () => {
  const { manager, code } = createDnTable({ humans: 3 });
  readyDnTable(manager, code);
  let room = manager.getRoom(code);

  const banker = playerAt(room, room.hand.bankerSeat);
  const punters = room.hand.actionQueue.map((seat) => playerAt(room, seat));
  stackDeck(room, bankerDealOrder(room, banker.seatIndex), {
    [banker.seatIndex]: ['AS', '2H', '3D', '4C', '9S'],
    [punters[0].seatIndex]: ['KS', 'KH', 'KD', '5C', '5D'],
    [punters[1].seatIndex]: ['QS', 'QH', 'QD', '5C', '5D'],
  });
  banker.stack = 70;

  for (const punter of punters) {
    manager.applyAction(code, punter.token, { type: 'bet', amount: 5 });
    room = manager.getRoom(code);
  }
  assert.equal(room.hand.phase, 'pick');
  finishPicks(manager, code);
  room = manager.getRoom(code);

  assert.equal(room.hand.status, 'finished');
  // 每家应得 10 × 5 × 3 = 150，合计 300；庄家只有 70 → 均分 35
  assert.equal(banker.stack, 0);
  const gains = punters.map((punter) => punter.stack - 1000).sort((a, b) => a - b);
  assert.deepEqual(gains, [35, 35]);
  assert.equal(room.players.reduce((sum, p) => sum + p.stack, 0), 1000 + 1000 + 70);
});

test('有庄：scoreCap 只作用于单个庄闲结算', () => {
  const { manager, code } = createDnTable({ humans: 2, config: { scoreCap: 25 } });
  readyDnTable(manager, code);
  let room = manager.getRoom(code);
  const banker = playerAt(room, room.hand.bankerSeat);
  const punter = room.players.find((player) => player.seatIndex !== banker.seatIndex);
  stackDeck(room, bankerDealOrder(room, banker.seatIndex), {
    [banker.seatIndex]: ['AS', '2H', '3D', '4C', '9S'],
    [punter.seatIndex]: ['KS', 'KH', 'KD', '5C', '5D'],
  });

  manager.applyAction(code, punter.token, { type: 'bet', amount: 5 });
  room = manager.getRoom(code);
  finishPicks(manager, code);
  room = manager.getRoom(code);

  // 10 × 5 × 3 = 150 → 封顶 25
  assert.equal(room.hand.winners[0].amount, 25);
  assert.equal(punter.stack, 1025);
  assert.equal(banker.stack, 975);
});

// ===== 引擎：庄家续庄 / 移交 =====

function finishedBankerTable(humans = 3) {
  const table = createDnTable({ humans });
  readyDnTable(table.manager, table.code);
  let room = table.manager.getRoom(table.code);
  // 所有闲家放弃 → 本局立即结束，进入可决定庄家的状态
  for (const seat of [...room.hand.actionQueue]) {
    table.manager.applyAction(table.code, playerAt(room, seat).token, { type: 'pass' });
    room = table.manager.getRoom(table.code);
  }
  return { ...table, room };
}

test('默认不操作 → 下一局续庄', () => {
  const { manager, code, room } = finishedBankerTable();
  const bankerToken = room.bankerToken;
  readyDnTable(manager, code);
  const next = manager.getRoom(code);
  assert.equal(next.bankerToken, bankerToken);
  assert.equal(next.hand.bankerSeat, next.players.find((p) => p.token === bankerToken).seatIndex);
});

test('setBanker keep：显式续庄成功', () => {
  const { manager, code, room } = finishedBankerTable();
  const bankerToken = room.bankerToken;
  manager.setBanker(code, bankerToken, 'keep');
  const updated = manager.getRoom(code);
  assert.equal(updated.bankerToken, bankerToken);
  assert.equal(updated.hand.bankerDecision.action, 'keep');
  assert.ok(updated.log.some((entry) => String(entry.text).includes('续庄')));
});

test('setBanker transfer：移交给指定玩家，下一局按目标当前座位坐庄', () => {
  const { manager, code, room } = finishedBankerTable();
  const bankerToken = room.bankerToken;
  const target = room.players.find((player) => player.token !== bankerToken);

  manager.setBanker(code, bankerToken, 'transfer', target.token);
  const updated = manager.getRoom(code);
  assert.equal(updated.bankerToken, target.token);
  assert.equal(updated.hand.bankerDecision.action, 'transfer');
  assert.equal(updated.hand.bankerDecision.targetSeat, target.seatIndex);

  // 目标换座后仍以 token 身份继承庄家
  const freeSeat = [...Array(updated.config.maxSeats).keys()].find((seat) => (
    !updated.players.some((player) => player.seatIndex === seat)
  ));
  if (freeSeat !== undefined) {
    manager.seatPlayer(code, target.token, freeSeat);
    readyDnTable(manager, code);
    const next = manager.getRoom(code);
    assert.equal(next.bankerToken, target.token);
    assert.equal(next.hand.bankerSeat, freeSeat);
  }
});

test('setBanker 越权与非法目标全部被拒', () => {
  const { manager, code, room } = finishedBankerTable();
  const bankerToken = room.bankerToken;
  const other = room.players.find((player) => player.token !== bankerToken);

  assert.throws(() => manager.setBanker(code, other.token, 'keep'), /只有本局庄家/);
  assert.throws(() => manager.setBanker(code, bankerToken, 'transfer', bankerToken), /不能移交给自己/);
  assert.throws(() => manager.setBanker(code, bankerToken, 'transfer'), /请指定移交目标/);
  assert.throws(() => manager.setBanker(code, bankerToken, 'transfer', '不存在的人'), /不在房间内/);
  assert.throws(() => manager.setBanker(code, bankerToken, 'keep', other.token), /续庄不需要指定目标/);
});

test('setBanker：每局只允许成功决定一次', () => {
  const { manager, code, room } = finishedBankerTable();
  const bankerToken = room.bankerToken;
  const target = room.players.find((player) => player.token !== bankerToken);
  manager.setBanker(code, bankerToken, 'transfer', target.token);
  assert.throws(() => manager.setBanker(code, bankerToken, 'keep'), /已做过庄家决定/);
  assert.equal(manager.getRoom(code).bankerToken, target.token);
});

test('setBanker：对局进行中不能变更庄家；无庄模式没有庄家', () => {
  const running = createDnTable({ humans: 2 });
  readyDnTable(running.manager, running.code);
  const runningRoom = running.manager.getRoom(running.code);
  assert.throws(
    () => running.manager.setBanker(running.code, runningRoom.bankerToken, 'keep'),
    /对局进行中/,
  );

  const none = createDnTable({ humans: 2, config: { bankerMode: 'none' } });
  readyDnTable(none.manager, none.code);
  let noneRoom = none.manager.getRoom(none.code);
  // 无庄模式先收底注并发牌，进入选牌阶段
  assert.equal(noneRoom.hand.status, 'running');
  assert.equal(noneRoom.hand.phase, 'pick');
  finishPicks(none.manager, none.code);
  noneRoom = none.manager.getRoom(none.code);
  assert.equal(noneRoom.hand.status, 'finished');
  assert.throws(() => none.manager.setBanker(none.code, noneRoom.players[0].token, 'keep'), /无庄模式/);
});

test('庄家离座 → 下一局随机回退到合法玩家', () => {
  const { manager, code, room } = finishedBankerTable();
  const banker = room.players.find((player) => player.token === room.bankerToken);

  manager.standPlayer(code, banker.token);
  readyDnTable(manager, code);
  const next = manager.getRoom(code);
  assert.notEqual(next.bankerToken, banker.token);
  const fallback = next.players.find((player) => player.token === next.bankerToken);
  assert.ok(fallback.seatIndex !== null && fallback.stack > 0 && !fallback.sitOut);
});

test('序列化：targetToken 只下发给有操作权的庄家', () => {
  const { manager, code, room } = finishedBankerTable();
  const bankerToken = room.bankerToken;
  const other = room.players.find((player) => player.token !== bankerToken);

  const bankerView = manager.getRoomView(code, bankerToken);
  assert.equal(bankerView.bankerControl.canManage, true);
  assert.ok(bankerView.bankerControl.transferCandidates.length > 0);
  assert.ok(bankerView.bankerControl.transferCandidates[0].targetToken);
  assert.equal(bankerView.isViewerBanker, true);

  const otherView = manager.getRoomView(code, other.token);
  assert.equal(otherView.bankerControl.canManage, false);
  assert.deepEqual(otherView.bankerControl.transferCandidates, []);
  assert.equal(otherView.isViewerBanker, false);
});

// ===== 引擎：无庄模式 =====

test('无庄：强制底注 → 选牌 → 唯一赢家通吃底池', () => {
  const { manager, code } = createDnTable({ humans: 3, config: { bankerMode: 'none' } });
  readyDnTable(manager, code);
  const room = manager.getRoom(code);

  // 开局即收底注并发牌，进入选牌阶段（不再"开局即结算"）
  assert.equal(room.hand.status, 'running');
  assert.equal(room.hand.phase, 'pick');
  assert.equal(room.hand.mode, 'none');
  assert.equal(room.bankerToken, null);
  for (const player of room.players) {
    assert.equal(player.holeCards.length, 5);
    assert.equal(player.handContribution, 10);
    assert.equal(player.stakeMult, 1);
  }
  assert.equal(room.hand.pot, 30);

  finishPicks(manager, code);
  const done = manager.getRoom(code);
  assert.equal(done.hand.status, 'finished');
  assert.equal(done.hand.winners.length, 1);
  const winner = done.hand.winners[0];
  // 无庄同样按赢家牌型翻倍：每位输家付「底分 × 赢家倍数」
  // 3 人 → 2 个输家，赢家净赢 = 2 × 10 × mult
  assert.equal(winner.amount, 2 * 10 * winner.mult);
  // 通吃总额 = 底池 30 + 各家补的差额
  assert.equal(done.hand.finalPot, 30 + 2 * (10 * winner.mult - 10));
  assert.equal(done.hand.losers.length, 2);
  for (const loser of done.hand.losers) {
    assert.equal(loser.amount, 10 * winner.mult);
  }
  assert.equal(done.players.reduce((sum, p) => sum + p.stack, 0), 3000);
});

test('无庄：赢家就是牌最大的人', () => {
  const { manager, code } = createDnTable({ humans: 3, config: { bankerMode: 'none' } });
  readyDnTable(manager, code);
  const room = manager.getRoom(code);
  const best = room.players
    .map((player) => ({ seatIndex: player.seatIndex, rank: evaluateDnHand(player.holeCards) }))
    .reduce((top, item) => (compareDnHands(item.rank, top.rank) > 0 ? item : top));
  finishPicks(manager, code);
  assert.equal(manager.getRoom(code).hand.winners[0].seatIndex, best.seatIndex);
});

test('无庄：筹码不足底注时按剩余筹码 all-in，仍可通吃', () => {
  const { manager, code } = createDnTable({ humans: 2, config: { bankerMode: 'none' } });
  const room0 = manager.getRoom(code);
  playerAt(room0, 0).stack = 4;
  readyDnTable(manager, code);
  const room = manager.getRoom(code);

  const seat0 = playerAt(room, 0);
  assert.equal(seat0.stakeMult, 1);
  assert.equal(seat0.handContribution, 4);
  assert.equal(room.hand.pot, 14); // 4 + 10
  finishPicks(manager, code);
  const done = manager.getRoom(code);
  assert.equal(done.hand.winners.length, 1);
  assert.equal(done.players.reduce((sum, p) => sum + p.stack, 0), 1004);
});

test('无庄：scoreCap 限制每位输家的支付', () => {
  const { manager, code } = createDnTable({ humans: 3, config: { bankerMode: 'none', scoreCap: 15 } });
  readyDnTable(manager, code);
  // 赢家拿牛牛（×3），本应每人付 30，封顶 15
  playerAt(manager.getRoom(code), 0).holeCards = ['KS', 'KH', 'KD', '5C', '5D'];
  playerAt(manager.getRoom(code), 1).holeCards = ['AS', '2H', '3D', '4C', '9S'];
  playerAt(manager.getRoom(code), 2).holeCards = ['2S', '3H', '4D', '6C', '9S'];
  finishPicks(manager, code);
  const room = manager.getRoom(code);

  assert.equal(room.hand.winners[0].seatIndex, 0);
  assert.equal(room.hand.winners[0].mult, 3);
  // 封顶 15：底注 10 已扣，再补 5
  for (const loser of room.hand.losers) {
    assert.equal(loser.amount, 15);
  }
  assert.equal(room.hand.winners[0].amount, 30); // 2 × 15
  assert.equal(room.players.reduce((sum, p) => sum + p.stack, 0), 3000);
});

// ===== 无庄：按赢家牌型翻倍（确定性牌面） =====

// 直接指定三家手牌：seat0 牛牛(×3)，另两家无牛
function seedNoneHands(manager, code) {
  const room = manager.getRoom(code);
  playerAt(room, 0).holeCards = ['KS', 'KH', 'KD', '5C', '5D'];
  playerAt(room, 1).holeCards = ['AS', '2H', '3D', '4C', '9S'];
  playerAt(room, 2).holeCards = ['2S', '3H', '4D', '6C', '9S'];
}

test('无庄：赢家按牌型倍数向每位输家收取（牛牛 ×3）', () => {
  const { manager, code } = createDnTable({ humans: 3, config: { bankerMode: 'none' } });
  readyDnTable(manager, code);
  seedNoneHands(manager, code);
  finishPicks(manager, code);

  const room = manager.getRoom(code);
  const [p0, p1, p2] = [0, 1, 2].map((seat) => playerAt(room, seat));

  assert.equal(room.hand.winners.length, 1);
  const winner = room.hand.winners[0];
  assert.equal(winner.seatIndex, 0);
  assert.equal(winner.mult, 3);
  assert.equal(winner.handLabel, '牛牛 K高');

  // 每位输家付 底分10 × 3 = 30（底注 10 + 补差 20）
  assert.equal(p1.stack, 970);
  assert.equal(p2.stack, 970);
  // 赢家：自己底注 10 回到手里，另收 2 × 30
  assert.equal(p0.stack, 1060);
  assert.equal(winner.amount, 60);
  assert.equal(room.hand.finalPot, 70); // 底池 30 + 补差 40
  assert.equal(room.players.reduce((sum, p) => sum + p.stack, 0), 3000);
  assert.match(room.hand.dealerMessage, /×3/);
});

test('无庄：输家筹码不足时最多赔光（按倍数应付但只剩一点）', () => {
  const { manager, code } = createDnTable({ humans: 3, config: { bankerMode: 'none' } });
  // 必须在开局前改筹码：handStartStack 在开局时固定
  playerAt(manager.getRoom(code), 1).stack = 15;
  readyDnTable(manager, code);
  seedNoneHands(manager, code);
  finishPicks(manager, code);

  const room = manager.getRoom(code);
  const p1 = playerAt(room, 1);
  // 应付 底分10 × 3 = 30，但开局只有 15 → 底注扣 10，再补 5，赔光
  assert.equal(p1.stack, 0);
  const entry1 = room.hand.results.find((entry) => entry.seatIndex === 1);
  assert.equal(entry1.delta, -15);
  assert.equal(entry1.stake, 15);
  assert.equal(room.players.reduce((sum, p) => sum + p.stack, 0), 1000 * 2 + 15);
});

// ===== 引擎：超时与机器人 =====

test('有庄：人类超时自动盲注 ×1', () => {
  const { manager, code } = createDnTable({ humans: 2, config: { actionTimeoutMs: 5000 } });
  readyDnTable(manager, code);
  let room = manager.getRoom(code);
  const punter = playerAt(room, room.hand.actionQueue[0]);

  manager.tick(Date.now() + 20000);
  room = manager.getRoom(code);

  assert.equal(punter.stakeMult, 1);
  assert.ok(room.log.some((entry) => String(entry.text).includes('超时自动盲注')));
});

test('有庄：机器人盲注前看不到牌，仍能打完整局', () => {
  const store = new MemoryStore();
  const manager = new DnManager(store);
  const created = manager.createRoom({
    token: 'a',
    roomName: 'Bot',
    playerName: 'Alice',
    config: { maxSeats: 3, baseStake: 10, startingStack: 1000 },
  });
  const code = created.room.code;
  manager.addBot(code, 'a', 'beginner');
  manager.addBot(code, 'a', 'advanced');
  manager.toggleReady(code, 'a');
  let room = manager.getRoom(code);
  assert.equal(room.hand.status, 'running');
  assert.equal(room.hand.phase, 'bet');
  for (const player of room.players) {
    assert.equal(player.holeCards.length, 0, '盲注阶段机器人也看不到牌');
  }

  for (let i = 0; i < 300 && room.hand?.status === 'running'; i += 1) {
    manager.tick(Date.now() + i * 10000);
    room = manager.getRoom(code);
  }
  assert.equal(room.hand.status, 'finished');
  assert.equal(room.hand.revealed, true);
  assert.equal(room.players.reduce((sum, p) => sum + p.stack, 0), 3000);
});

test('无庄：机器人也能完成整局', () => {
  const store = new MemoryStore();
  const manager = new DnManager(store);
  const created = manager.createRoom({
    token: 'a',
    roomName: 'BotNone',
    playerName: 'Alice',
    config: { maxSeats: 3, bankerMode: 'none', baseStake: 10, startingStack: 1000 },
  });
  const code = created.room.code;
  manager.addBot(code, 'a', 'intermediate');
  manager.addBot(code, 'a', 'advanced');
  manager.toggleReady(code, 'a');
  let room = manager.getRoom(code);
  assert.equal(room.hand.status, 'running');
  assert.equal(room.hand.phase, 'pick');

  for (let i = 0; i < 200 && room.hand?.status === 'running'; i += 1) {
    manager.tick(Date.now() + i * 10000);
    room = manager.getRoom(code);
  }
  assert.equal(room.hand.status, 'finished');
  assert.equal(room.hand.winners.length, 1);
  assert.equal(room.players.reduce((sum, p) => sum + p.stack, 0), 3000);
});

// ===== 选牛牌阶段（欢乐斗牛式互动） =====

test('选牌：非法组合被拒（必须凑成整十 / 不能重复 / 只能选自己的牌）', () => {
  const { manager, code } = createDnTable({ humans: 2, config: { bankerMode: 'none' } });
  readyDnTable(manager, code);
  const room = manager.getRoom(code);
  const seat = room.hand.actionQueue[0];
  const player = playerAt(room, seat);
  const cards = player.holeCards;

  assert.throws(() => manager.applyAction(code, player.token, { type: 'pick', cards: cards.slice(0, 2) }), /3 张/);
  assert.throws(() => manager.applyAction(code, player.token, { type: 'pick', cards: [cards[0], cards[0], cards[1]] }), /重复/);
  assert.throws(() => manager.applyAction(code, player.token, { type: 'pick', cards: [cards[0], cards[1], 'XX'] }), /自己的手牌/);

  // 找出一个凑不出整十的组合（若无则跳过）
  const bad = (() => {
    for (let i = 0; i < 3; i += 1) {
      for (let j = i + 1; j < 4; j += 1) {
        for (let k = j + 1; k < 5; k += 1) {
          const combo = [cards[i], cards[j], cards[k]];
          if (combo.reduce((s, c) => s + dnCardPoints(c), 0) % 10 !== 0) return combo;
        }
      }
    }
    return null;
  })();
  if (bad) {
    assert.throws(
      () => manager.applyAction(code, player.token, { type: 'pick', cards: bad }),
      /凑不出整十/,
    );
  }
  // 被拒后仍在选牌阶段
  assert.equal(manager.getRoom(code).hand.phase, 'pick');
});

test('选牌：按玩家选择评估，选错按无牛结算', () => {
  const hand = ['KS', '6H', '4D', '3C', '4S'];
  // 合法选牌：10+6+4=20 → 剩 3+4=7 → 牛7
  assert.equal(evaluateDnPick(hand, ['KS', '6H', '4D']).niu, 7);
  // 非法选牌（10+6+3=19）→ 保守按无牛
  assert.equal(evaluateDnPick(hand, ['KS', '6H', '3C']).category, DN_CATEGORY.NONE);
  // 选择没牛 → 无牛
  assert.equal(evaluateDnPick(hand, null).category, DN_CATEGORY.NONE);
  // 特殊牌型无视选牌结果
  assert.equal(evaluateDnPick(['AS', 'AH', '2H', '2D', '3C'], ['AS', 'AH', '2H']).category, DN_CATEGORY.WU_XIAO);
  assert.equal(evaluateDnPick(['KS', 'KH', 'KD', 'KC', '5D'], ['KS', 'KH', 'KD']).category, DN_CATEGORY.BOMB);
  assert.equal(evaluateDnPick(['KS', 'KH', 'QD', 'QC', 'JS'], ['KS', 'QD', 'JS']).category, DN_CATEGORY.WU_HUA);
});

test('选牌：提交后本人立即可见牌型，他人仍隐藏', () => {
  const { manager, code } = createDnTable({ humans: 2, config: { bankerMode: 'none' } });
  readyDnTable(manager, code);
  const room = manager.getRoom(code);
  const seat = room.hand.actionQueue[0];
  const player = playerAt(room, seat);
  const other = room.players.find((p) => p.token !== player.token);

  pickFor(manager, code, player.token);

  const selfView = manager.getRoomView(code, player.token);
  const me = selfView.players.find((p) => p.isViewer);
  assert.equal(me.pickDone, true);
  assert.ok(me.handLabel, '选牌后本人应看到牌型');
  // 有牛时高亮牛牌；没牛时为 null
  const combos = dnBullCandidates(player.holeCards);
  if (combos.length) {
    assert.equal(me.bullCards.length, 3);
    assert.deepEqual([...me.bullCards].sort(), [...combos[0]].sort());
  } else {
    assert.equal(me.bullCards, null);
  }

  // 他人视角：看不到牌型与牛牌（视图对非本人会隐藏 token，用座位号定位）
  const otherView = manager.getRoomView(code, other.token);
  const them = otherView.players.find((p) => p.seatIndex === player.seatIndex);
  assert.equal(them.pickDone, true);
  assert.equal(them.handLabel, null);
  assert.equal(them.bullCards, null);
  assert.ok(them.holeCards.every((card) => card === '??'));
});

test('选牌：结果里带 bullCards 供结算高亮', () => {
  const { manager, code } = createDnTable({ humans: 2, config: { bankerMode: 'none' } });
  readyDnTable(manager, code);
  finishPicks(manager, code);
  const room = manager.getRoom(code);
  assert.equal(room.hand.status, 'finished');
  for (const entry of room.hand.results) {
    assert.ok(Array.isArray(entry.holeCards));
    // 有牛 → bullCards 为 3 张；没牛 → null
    if (entry.handLabel && entry.handLabel !== '无牛 9高' && entry.handLabel.startsWith('无牛')) {
      assert.equal(entry.bullCards, null);
    }
    if (entry.bullCards) assert.equal(entry.bullCards.length, 3);
  }
});

test('选牌：庄家也要选牛牌', () => {
  const { manager, code } = createDnTable({ humans: 3 });
  readyDnTable(manager, code);
  let room = manager.getRoom(code);
  const banker = playerAt(room, room.hand.bankerSeat);

  // 所有闲家下注
  for (const seat of [...room.hand.actionQueue]) {
    manager.applyAction(code, playerAt(room, seat).token, { type: 'bet', amount: 1 });
    room = manager.getRoom(code);
  }
  // 选牌队列应包含庄家
  assert.ok(room.hand.actionQueue.includes(banker.seatIndex), '庄家必须参与选牌');

  finishPicks(manager, code);
  room = manager.getRoom(code);
  assert.equal(room.hand.status, 'finished');
  assert.equal(banker.showdownRank !== null, true);
  // 庄家的牌型由自己选牌决定
  assert.ok(banker.holeCards.length === 5);
});

test('选牌：超时自动取最优解', () => {
  const { manager, code } = createDnTable({ humans: 2, config: { bankerMode: 'none', actionTimeoutMs: 5000 } });
  readyDnTable(manager, code);
  let room = manager.getRoom(code);
  const seat = room.hand.actionQueue[0];
  const player = playerAt(room, seat);

  manager.tick(Date.now() + 20000);
  room = manager.getRoom(code);

  assert.ok(player.showdownRank, '超时应自动完成选牌');
  const combos = dnBullCandidates(player.holeCards);
  if (combos.length) {
    // 自动选的是最优解 → 与自动评估一致
    assert.equal(
      describeDnHand(player.showdownRank),
      describeDnHand(evaluateDnHand(player.holeCards)),
    );
  } else {
    assert.equal(player.showdownRank.category, DN_CATEGORY.NONE);
  }
  assert.ok(room.log.some((entry) => /超时自动/.test(String(entry.text))));
});
