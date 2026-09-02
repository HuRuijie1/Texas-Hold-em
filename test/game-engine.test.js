import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeck, shuffleDeck, bestHandOfSeven } from '../src/poker.js';
import { GameManager } from '../src/game-engine.js';

class MemoryStore {
  constructor() {
    this.rooms = new Map();
    this.history = new Map();
    this.deletedRooms = [];
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
    if (this.rooms.has(code)) this.deletedRooms.push(code);
    this.rooms.delete(code);
  }

  cleanOldRooms() {}

  saveHandHistory(code, handNo, summary) {
    if (!this.history.has(code)) this.history.set(code, []);
    this.history.get(code).push({ handNo, summary });
  }

  listHandHistory(code) {
    return (this.history.get(code) || []).map((entry) => structuredClone(entry.summary));
  }
}

function readyTable(manager, code) {
  const room = manager.getRoom(code);
  for (const player of room.players.filter((candidate) => candidate.seatIndex !== null && !candidate.isBot && candidate.stack > 0 && !candidate.sitOut)) {
    manager.toggleReady(code, player.token);
  }
}

function createTable() {
  const store = new MemoryStore();
  const manager = new GameManager(store);
  const created = manager.createRoom({ token: 'a', roomName: 'Test', playerName: 'Alice', config: { maxSeats: 6, smallBlind: 5, bigBlind: 10, startingStack: 1000 } });
  manager.joinRoom(created.room.code, { token: 'b', playerName: 'Bob' });
  manager.seatPlayer(created.room.code, 'a', 0);
  manager.seatPlayer(created.room.code, 'b', 1);
  return { manager, store, code: created.room.code };
}

test('deck contains 52 unique cards', () => {
  const deck = createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
  assert.equal(shuffleDeck([...deck]).length, 52);
});

test('best hand ranking identifies a flush', () => {
  const rank = bestHandOfSeven(['AS', 'KS', 'QS', 'JS', '9S', '2D', '3C']);
  assert.equal(rank.category, 5);
});

test('starting a hand posts blinds and queues action', () => {
  const { manager, code } = createTable();
  readyTable(manager, code);
  const room = manager.getRoom(code);
  assert.equal(room.hand.status, 'running');
  assert.equal(room.hand.pot, 15);
  assert.equal(room.hand.actionQueue.length > 0, true);
});

test('fold closes hand and awards pot', () => {
  const { manager, code } = createTable();
  readyTable(manager, code);
  const room = manager.getRoom(code);
  const actor = room.players.find((player) => player.seatIndex === room.hand.actionQueue[0]);
  manager.applyAction(code, actor.token, { type: 'fold' });
  assert.equal(manager.getRoom(code).hand.status, 'finished');
});

test('showdown stores history', () => {
  const { manager, store, code } = createTable();
  readyTable(manager, code);
  const room = manager.getRoom(code);
  room.players.forEach((player) => {
    if (player.token === 'a' || player.token === 'b') {
      player.stack = 0;
      player.allIn = true;
      player.inHand = true;
      player.streetContribution = 100;
      player.handContribution = 100;
      player.holeCards = ['AS', 'AD'];
    }
  });
  room.hand.board = ['KS', 'QS', 'JS', 'TS', '9D'];
  room.hand.actionQueue = [];
  manager.resolveHand(room);
  assert.equal(manager.getRoom(code).hand.status, 'finished');
  assert.equal(store.listHandHistory(code).length > 0, true);
});

function createFourTable() {
  const store = new MemoryStore();
  const manager = new GameManager(store);
  const created = manager.createRoom({
    token: 'a',
    roomName: 'Test',
    playerName: 'Alice',
    config: { maxSeats: 4, smallBlind: 5, bigBlind: 10, startingStack: 100 },
  });
  manager.joinRoom(created.room.code, { token: 'b', playerName: 'Bob' });
  manager.joinRoom(created.room.code, { token: 'c', playerName: 'Carol' });
  manager.joinRoom(created.room.code, { token: 'd', playerName: 'Dave' });
  manager.seatPlayer(created.room.code, 'a', 0);
  manager.seatPlayer(created.room.code, 'b', 1);
  manager.seatPlayer(created.room.code, 'c', 2);
  manager.seatPlayer(created.room.code, 'd', 3);
  return { manager, store, code: created.room.code };
}

function createThreeTable() {
  const store = new MemoryStore();
  const manager = new GameManager(store);
  const created = manager.createRoom({
    token: 'a',
    roomName: 'Test',
    playerName: 'Alice',
    config: { maxSeats: 6, smallBlind: 5, bigBlind: 10, startingStack: 100 },
  });
  manager.joinRoom(created.room.code, { token: 'b', playerName: 'Bob' });
  manager.joinRoom(created.room.code, { token: 'c', playerName: 'Carol' });
  manager.seatPlayer(created.room.code, 'a', 0);
  manager.seatPlayer(created.room.code, 'b', 1);
  manager.seatPlayer(created.room.code, 'c', 2);
  return { manager, store, code: created.room.code };
}

function playerByToken(room, token) {
  return room.players.find((player) => player.token === token);
}

function playerBySeat(room, seatIndex) {
  return room.players.find((player) => player.seatIndex === seatIndex);
}

test('heads-up deals from the big blind and starts postflop action at the big blind', () => {
  const { manager, code } = createTable();
  readyTable(manager, code);
  const room = manager.getRoom(code);
  const deck = room.hand.deck;

  assert.equal(room.hand.buttonSeat, 0);
  assert.equal(room.hand.smallBlindSeat, 0);
  assert.equal(room.hand.bigBlindSeat, 1);
  assert.deepEqual(playerBySeat(room, 1).holeCards, [deck[0], deck[2]]);
  assert.deepEqual(playerBySeat(room, 0).holeCards, [deck[1], deck[3]]);
  assert.deepEqual(room.hand.actionQueue, [0, 1]);

  manager.applyAction(code, 'a', { type: 'call' });
  manager.applyAction(code, 'b', { type: 'check' });

  const afterFlop = manager.getRoom(code);
  assert.equal(afterFlop.hand.street, 'flop');
  assert.equal(afterFlop.hand.actionQueue[0], afterFlop.hand.bigBlindSeat);
});

test('rejects blind configurations that are not small-blind below big-blind', () => {
  const manager = new GameManager(new MemoryStore());
  assert.throws(
    () => manager.createRoom({
      token: 'a',
      roomName: 'Invalid',
      playerName: 'Alice',
      config: { smallBlind: 10, bigBlind: 10 },
    }),
    /小盲必须小于大盲/,
  );
  assert.throws(
    () => manager.createRoom({
      token: 'a',
      roomName: 'Invalid',
      playerName: 'Alice',
      config: { smallBlind: 20, bigBlind: 10 },
    }),
    /小盲必须小于大盲/,
  );
});

test('action timeout is configurable at room creation and clamped', () => {
  const manager = new GameManager(new MemoryStore());

  const custom = manager.createRoom({
    token: 'a',
    roomName: 'Slow',
    playerName: 'Alice',
    config: { actionTimeoutMs: 45000 },
  });
  assert.equal(custom.room.config.actionTimeoutMs, 45000);

  const tooFast = manager.createRoom({
    token: 'b',
    roomName: 'Fast',
    playerName: 'Bob',
    config: { actionTimeoutMs: 1000 },
  });
  assert.equal(tooFast.room.config.actionTimeoutMs, 5000);

  const tooSlow = manager.createRoom({
    token: 'c',
    roomName: 'Glacial',
    playerName: 'Carol',
    config: { actionTimeoutMs: 999999 },
  });
  assert.equal(tooSlow.room.config.actionTimeoutMs, 120000);

  const defaulted = manager.createRoom({ token: 'd', roomName: 'Default', playerName: 'Dave' });
  assert.equal(defaulted.room.config.actionTimeoutMs, 30000);
});

test('settlement covers departed seated players and skips pure observers', () => {
  const store = new MemoryStore();
  const manager = new GameManager(store);
  const created = manager.createRoom({
    token: 'a',
    roomName: 'Report',
    playerName: 'Alice',
    config: { maxSeats: 4, smallBlind: 5, bigBlind: 10, startingStack: 1000 },
  });
  const code = created.room.code;
  manager.joinRoom(code, { token: 'b', playerName: 'Bob' });
  manager.joinRoom(code, { token: 'e', playerName: 'Observer' }); // 纯围观，从未坐下
  manager.seatPlayer(code, 'a', 0);
  manager.seatPlayer(code, 'b', 1);

  // Bob 赢了筹码后被踢
  const beforeKick = manager.getRoom(code);
  playerByToken(beforeKick, 'b').stack += 300;
  manager.kickPlayer(code, 'a', 'b');

  // 移除一个输钱的机器人
  const withBot = manager.addBot(code, 'a', 'beginner');
  const bot = withBot.players.find((player) => player.isBot);
  bot.stack -= 50;
  manager.removeBot(code, 'a', bot.token);

  // 房主自己也亏了
  const beforeSettle = manager.getRoom(code);
  playerByToken(beforeSettle, 'a').stack -= 250;

  const result = manager.settleRoom(code, 'a');
  assert.equal(result.roomName, 'Report');
  assert.equal(result.settlements.length, 3); // Alice + 离场 Bob + 离场 Bot，围观者不入报

  const byName = Object.fromEntries(result.settlements.map((entry) => [entry.name, entry]));
  assert.ok(byName.Bob, '被踢的玩家必须出现在战报');
  assert.equal(byName.Bob.profitLoss, 300);
  const botEntry = result.settlements.find((entry) => entry.isBot);
  assert.ok(botEntry, '离场机器人必须出现在战报');
  assert.equal(botEntry.profitLoss, -50);
  assert.ok(byName.Alice);
  assert.equal(byName.Alice.profitLoss, -250);
});

test('rejoined players dedupe into a single settlement row', () => {
  const store = new MemoryStore();
  const manager = new GameManager(store);
  const created = manager.createRoom({
    token: 'a',
    roomName: 'Dedupe',
    playerName: 'Alice',
    config: { maxSeats: 4, smallBlind: 5, bigBlind: 10, startingStack: 1000 },
  });
  const code = created.room.code;
  manager.joinRoom(code, { token: 'b', playerName: 'Bob' });
  manager.seatPlayer(code, 'a', 0);
  manager.seatPlayer(code, 'b', 1);

  manager.kickPlayer(code, 'a', 'b'); // 离场快照：1000
  manager.joinRoom(code, { token: 'b', playerName: 'Bob' }); // 重进，全新对象
  manager.seatPlayer(code, 'b', 1);

  const room = manager.getRoom(code);
  playerByToken(room, 'b').stack -= 200;

  const result = manager.settleRoom(code, 'a');
  const bobRows = result.settlements.filter((entry) => entry.name === 'Bob');
  assert.equal(bobRows.length, 1);
  assert.equal(bobRows[0].profitLoss, -200); // 以在场最新数据为准
});

test('auto-removed busted bots appear in settlement', () => {
  const store = new MemoryStore();
  const manager = new GameManager(store);
  const created = manager.createRoom({
    token: 'a',
    roomName: 'BotBust',
    playerName: 'Alice',
    config: { maxSeats: 4, smallBlind: 5, bigBlind: 10, startingStack: 1000 },
  });
  const code = created.room.code;

  // 添加两个机器人
  const withBot1 = manager.addBot(code, 'a', 'beginner');
  const bot1 = withBot1.players.find((p) => p.isBot);
  const withBot2 = manager.addBot(code, 'a', 'intermediate');
  const bot2 = withBot2.players.find((p) => p.isBot && p.token !== bot1.token);

  manager.seatPlayer(code, 'a', 0);
  manager.seatPlayer(code, bot1.token, 1);
  manager.seatPlayer(code, bot2.token, 2);

  // 模拟bot1输光筹码
  const room = manager.getRoom(code);
  playerByToken(room, bot1.token).stack = 0;

  // 开始新一局会自动清理破产机器人（Alice准备后，bot2足够凑齐2人）
  manager.toggleReady(code, 'a');

  // 验证破产机器人已被移除
  const afterReady = manager.getRoom(code);
  assert.equal(afterReady.players.some((p) => p.token === bot1.token), false, '破产机器人应该被移除');
  assert.equal(afterReady.players.some((p) => p.token === bot2.token), true, 'bot2应该还在');

  // 等待牌局结束（直接通过fold结束）
  const alice = afterReady.players.find((p) => p.token === 'a');
  if (alice.inHand && afterReady.hand?.status === 'running') {
    manager.applyAction(code, 'a', { type: 'fold' });
  }

  // 结算房间
  const result = manager.settleRoom(code, 'a');

  // 验证破产机器人出现在结算中
  const botEntry = result.settlements.find((s) => s.isBot && s.name === bot1.name);
  assert.ok(botEntry, '破产的机器人必须出现在结算中');
  assert.equal(botEntry.profitLoss, -1000, '破产机器人亏损应为全部本金');
});

test('short all-in raises do not reopen betting for prior actors but do allow an unacted player to raise', () => {
  const first = createFourTable();
  const firstRoom = first.manager.getRoom(first.code);
  playerByToken(firstRoom, 'c').stack = 45;
  readyTable(first.manager, first.code);

  first.manager.applyAction(first.code, 'd', { type: 'call' });
  first.manager.applyAction(first.code, 'a', { type: 'raise', amount: 40 });
  first.manager.applyAction(first.code, 'b', { type: 'call' });
  first.manager.applyAction(first.code, 'c', { type: 'allin' });

  let room = first.manager.getRoom(first.code);
  assert.equal(room.hand.currentBet, 45);
  assert.deepEqual([...room.hand.callOnlySeats].sort((a, b) => a - b), [0, 1]);
  assert.equal(room.hand.actionQueue[0], 3);
  assert.equal(first.manager.getRoomView(first.code, 'd').hand.availableActions.canRaise, true);

  first.manager.applyAction(first.code, 'd', { type: 'call' });
  room = first.manager.getRoom(first.code);
  assert.equal(room.hand.actionQueue[0], 0);
  assert.equal(first.manager.getRoomView(first.code, 'a').hand.availableActions.isCallOnly, true);
  assert.equal(first.manager.getRoomView(first.code, 'a').hand.availableActions.canRaise, false);
  assert.throws(
    () => first.manager.applyAction(first.code, 'a', { type: 'raise', amount: 60 }),
    /只能跟注或弃牌/,
  );

  const second = createFourTable();
  const secondRoom = second.manager.getRoom(second.code);
  playerByToken(secondRoom, 'c').stack = 45;
  readyTable(second.manager, second.code);
  second.manager.applyAction(second.code, 'd', { type: 'call' });
  second.manager.applyAction(second.code, 'a', { type: 'raise', amount: 40 });
  second.manager.applyAction(second.code, 'b', { type: 'call' });
  second.manager.applyAction(second.code, 'c', { type: 'allin' });
  second.manager.applyAction(second.code, 'd', { type: 'raise', amount: 70 });

  room = second.manager.getRoom(second.code);
  assert.deepEqual(room.hand.callOnlySeats, []);
  assert.deepEqual(room.hand.actionQueue, [0, 1]);
  assert.equal(second.manager.getRoomView(second.code, 'a').hand.availableActions.canRaise, true);
});
test('distributes multiway side pots, including dead-money tiers, without losing chips', () => {
  const { manager, code } = createFourTable();
  readyTable(manager, code);
  const room = manager.getRoom(code);
  const contributions = { a: 50, b: 100, c: 150, d: 200 };
  const holeCards = {
    a: ['AS', 'AH'],
    b: ['KS', 'QS'],
    c: ['TS', '8S'],
    d: ['3S', '4S'],
  };

  room.hand.board = ['2C', '7D', '9H', 'JC', 'KD'];
  room.hand.street = 'river';
  room.hand.actionQueue = [];
  for (const [token, contribution] of Object.entries(contributions)) {
    const player = playerByToken(room, token);
    player.stack = 0;
    player.inHand = true;
    player.folded = token === 'd';
    player.allIn = true;
    player.streetContribution = contribution;
    player.handContribution = contribution;
    player.holeCards = holeCards[token];
  }
  room.hand.pot = Object.values(contributions).reduce((sum, amount) => sum + amount, 0);

  manager.resolveHand(room);
  const finished = manager.getRoom(code);
  const sidePotTotal = finished.hand.sidePots.reduce((sum, sidePot) => sum + sidePot.amount, 0);
  const winnerTotal = finished.hand.winners.reduce((sum, winner) => sum + winner.amount, 0);
  const stackTotal = finished.players.reduce((sum, player) => sum + player.stack, 0);

  assert.equal(finished.hand.status, 'finished');
  assert.equal(finished.hand.finalPot, 500);
  assert.equal(finished.hand.pot, 0);
  assert.equal(sidePotTotal, 500);
  assert.equal(winnerTotal, 500);
  assert.equal(stackTotal, 500);
  assert.ok(finished.hand.sidePots.at(-1).winners.length > 0);
});

test('showdown preserves the full chip count after a heads-up all-in', () => {
  const { manager, code } = createTable();
  readyTable(manager, code);
  const room = manager.getRoom(code);
  const initialChips = room.players.reduce((sum, player) => sum + player.stack, 0) + room.hand.pot;

  manager.applyAction(code, 'a', { type: 'call' });
  manager.applyAction(code, 'b', { type: 'allin' });
  manager.applyAction(code, 'a', { type: 'allin' });

  const finished = manager.getRoom(code);
  const stackTotal = finished.players.reduce((sum, player) => sum + player.stack, 0);
  const winnerTotal = finished.hand.winners.reduce((sum, winner) => sum + winner.amount, 0);
  assert.equal(finished.hand.status, 'finished');
  assert.equal(finished.hand.finalPot, initialChips);
  assert.equal(finished.hand.pot, 0);
  assert.equal(stackTotal, initialChips);
  assert.equal(winnerTotal, initialChips);
});

test('rotates the button to the next eligible seat when the old button leaves', () => {
  const { manager, code } = createThreeTable();
  readyTable(manager, code);
  assert.equal(manager.getRoom(code).hand.buttonSeat, 0);

  manager.applyAction(code, 'a', { type: 'fold' });
  manager.applyAction(code, 'b', { type: 'fold' });
  assert.equal(manager.getRoom(code).hand.status, 'finished');

  manager.standPlayer(code, 'a');
  readyTable(manager, code);
  const nextHand = manager.getRoom(code).hand;
  assert.equal(nextHand.buttonSeat, 1);
  assert.equal(nextHand.smallBlindSeat, 1);
  assert.equal(nextHand.bigBlindSeat, 2);
});
test('host can kick a seated human and the token can rejoin', () => {
  const { manager, code } = createTable();

  const removed = manager.kickPlayer(code, 'a', 'b');
  assert.equal(removed.players.some((player) => player.token === 'b'), false);
  assert.equal(removed.players.some((player) => player.seatIndex === 1), false);
  assert.match(removed.log.at(-1).text, /踢出了 Bob/);

  const rejoined = manager.joinRoom(code, { token: 'b', playerName: 'Bob Again' });
  assert.equal(rejoined.token, 'b');
  assert.equal(rejoined.room.players.find((player) => player.token === 'b').seatIndex, null);
});

test('host can kick an unseated human and remove a bot', () => {
  const { manager, code } = createTable();
  manager.standPlayer(code, 'b');
  manager.kickPlayer(code, 'a', 'b');
  assert.equal(manager.getRoom(code).players.some((player) => player.token === 'b'), false);

  const roomWithBot = manager.addBot(code, 'a', 'beginner');
  const bot = roomWithBot.players.find((player) => player.isBot);
  assert.ok(bot);
  manager.removeBot(code, 'a', bot.token);
  assert.equal(manager.getRoom(code).players.some((player) => player.token === bot.token), false);
});

test('only the host can remove members and protected targets cannot be removed', () => {
  const { manager, code } = createTable();

  assert.throws(() => manager.kickPlayer(code, 'b', 'a'), /只有房主/);
  assert.throws(() => manager.kickPlayer(code, 'a', 'a'), /不能踢自己/);

  manager.getRoom(code).players.find((player) => player.token === 'b').isHost = true;
  assert.throws(() => manager.kickPlayer(code, 'a', 'b'), /不能踢房主/);
});

test('member removal is rejected while a hand is running', () => {
  const { manager, code } = createTable();
  readyTable(manager, code);

  assert.throws(() => manager.kickPlayer(code, 'a', 'b'), /对局进行中不能踢人/);
  assert.equal(manager.getRoom(code).players.some((player) => player.token === 'b'), true);
});

test('disconnected players auto sit out after grace and can return on resume', () => {
  const { manager, code } = createTable();
  let room = manager.getRoom(code);
  const bob = playerByToken(room, 'b');
  bob.connected = false;
  bob.disconnectedAt = Date.now() - 200000;

  manager.tick(Date.now());
  room = manager.getRoom(code);
  assert.equal(playerByToken(room, 'b').sitOut, true);

  manager.resumeRoom(code, 'b');
  room = manager.getRoom(code);
  const resumed = playerByToken(room, 'b');
  assert.equal(resumed.sitOut, false);
  assert.equal(resumed.connected, true);
});

test('human timeout folds when facing a bet and awards the pot', () => {
  const { manager, code } = createTable();
  readyTable(manager, code);
  let room = manager.getRoom(code);
  const actorSeat = room.hand.actionQueue[0];
  room.hand.turnDeadlineAt = Date.now() - 1;

  manager.tick(Date.now() + 1);
  room = manager.getRoom(code);

  assert.equal(playerBySeat(room, actorSeat).folded, true);
  assert.equal(room.hand.status, 'finished');
});

test('settleRoom notifies listeners and removes the room everywhere', () => {
  const store = new MemoryStore();
  const closed = [];
  const manager = new GameManager(store, {
    onClose: (room, info) => closed.push({ code: room.code, reason: info.reason }),
  });
  const created = manager.createRoom({
    token: 'a',
    roomName: 'Settle',
    playerName: 'Alice',
    config: { smallBlind: 5, bigBlind: 10 },
  });

  const result = manager.settleRoom(created.room.code, 'a');

  assert.equal(result.settlements.length, 1);
  assert.deepEqual(closed, [{ code: created.room.code, reason: 'settled' }]);
  assert.equal(manager.getRoom(created.room.code), null);
  assert.ok(store.deletedRooms.includes(created.room.code));
});

test('player can resume play after being set to sitOut', () => {
  const store = new MemoryStore();
  const manager = new GameManager(store);
  const created = manager.createRoom({
    token: 'a',
    roomName: 'Resume',
    playerName: 'Alice',
    config: { smallBlind: 5, bigBlind: 10, startingStack: 1000 },
  });
  const code = created.room.code;
  manager.joinRoom(code, { token: 'b', playerName: 'Bob' });
  manager.seatPlayer(code, 'a', 0);
  manager.seatPlayer(code, 'b', 1);

  // 模拟玩家被设置为观战状态
  const room = manager.getRoom(code);
  const alice = playerByToken(room, 'a');
  alice.sitOut = true;

  // 验证玩家处于观战状态
  assert.equal(alice.sitOut, true);

  // 玩家重新入局
  const resumed = manager.resumePlay(code, 'a');
  const aliceAfter = playerByToken(resumed, 'a');

  assert.equal(aliceAfter.sitOut, false, '玩家应该不再处于观战状态');
  assert.equal(aliceAfter.ready, false, '重新入局后需要重新准备');

  // 验证错误情况
  assert.throws(() => manager.resumePlay(code, 'a'), /您已在游戏中/);
  assert.throws(() => manager.resumePlay(code, 'b'), /您已在游戏中/);

  // 未坐下的玩家不能重新入局
  manager.joinRoom(code, { token: 'c', playerName: 'Carol' });
  assert.throws(() => manager.resumePlay(code, 'c'), /请先坐下/);
});

test('short big blind keeps min raise anchored to the big blind', () => {
  const { manager, code } = createTable();
  const roomBefore = manager.getRoom(code);
  playerByToken(roomBefore, 'b').stack = 8;
  readyTable(manager, code);

  let room = manager.getRoom(code);
  assert.equal(room.hand.smallBlindSeat, 0);
  assert.equal(room.hand.bigBlindSeat, 1);
  assert.equal(room.hand.currentBet, 8);
  assert.equal(playerBySeat(room, 1).allIn, true);

  const actions = manager.getRoomView(code, 'a').hand.availableActions;
  assert.equal(actions.toCall, 3);
  assert.equal(actions.minRaiseTo, 10);

  assert.throws(
    () => manager.applyAction(code, 'a', { type: 'raise', amount: 9 }),
    /加注不足最小加注额/,
  );

  manager.applyAction(code, 'a', { type: 'raise', amount: 10 });
  room = manager.getRoom(code);
  // 唯一的非全下玩家完成下注后无人再能回应，直接跑完公共牌摊牌
  assert.equal(playerBySeat(room, 0).handContribution, 10);
  assert.equal(room.hand.board.length, 5);
  assert.equal(room.hand.finalPot, 18);
  assert.equal(room.hand.status, 'finished');
});

test('splits an odd pot across tiers without losing chips', () => {
  const { manager, code } = createThreeTable();
  readyTable(manager, code);
  const room = manager.getRoom(code);
  room.hand.board = ['2C', '7D', '9H', 'JC', 'KD'];
  room.hand.street = 'river';
  room.hand.actionQueue = [];

  const setup = [
    { token: 'a', contribution: 100, hole: ['AS', 'AD'], folded: false },
    { token: 'b', contribution: 100, hole: ['AH', 'AC'], folded: false },
    { token: 'c', contribution: 1, hole: ['2H', '3D'], folded: true },
  ];
  for (const item of setup) {
    const player = playerByToken(room, item.token);
    player.stack = 0;
    player.inHand = true;
    player.folded = item.folded;
    player.allIn = !item.folded;
    player.streetContribution = item.contribution;
    player.handContribution = item.contribution;
    player.holeCards = item.hole;
  }
  room.hand.pot = 201;

  manager.resolveHand(room);
  const finished = manager.getRoom(code);
  const stackTotal = finished.players.reduce((sum, player) => sum + player.stack, 0);

  assert.equal(finished.hand.status, 'finished');
  assert.equal(finished.hand.finalPot, 201);
  assert.equal(stackTotal, 201);
  assert.deepEqual(
    finished.hand.sidePots.map((sidePot) => [sidePot.level, sidePot.amount]),
    [[1, 3], [100, 198]],
  );

  const amountsByToken = Object.fromEntries(
    finished.hand.winners.map((winner) => [winner.token, winner.amount]),
  );
  assert.equal(amountsByToken.b, 101);
  assert.equal(amountsByToken.a, 100);
});
