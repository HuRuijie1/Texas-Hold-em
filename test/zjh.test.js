import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameManager } from '../src/game-engine.js';
import { RoomStore } from '../src/store.js';
import { ZjhManager, hydrateZjhRoom } from '../src/zjh-engine.js';
import {
  compareZjhHands,
  describeZjhHand,
  evaluateZjhHand,
  ZJH_CATEGORY,
} from '../src/zjh.js';
import { estimateZjhStrength } from '../src/zjh-bot.js';

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

  saveHandHistory(code, handNo, summary) {
    if (!this.history.has(code)) this.history.set(code, []);
    this.history.get(code).push({ handNo, summary });
  }

  listHandHistory(code) {
    return (this.history.get(code) || []).map((entry) => structuredClone(entry.summary));
  }
}

// ===== 牌型判定 =====

test('豹子判定与比较：AAA 最大、222 最小', () => {
  const aaa = evaluateZjhHand(['AS', 'AH', 'AD']);
  const kkk = evaluateZjhHand(['KS', 'KH', 'KD']);
  const deuce = evaluateZjhHand(['2S', '2H', '2D']);
  assert.equal(aaa.category, ZJH_CATEGORY.BAO_ZI);
  assert.ok(compareZjhHands(aaa, kkk) > 0);
  assert.ok(compareZjhHands(kkk, deuce) > 0);
});

test('顺金判定：AKQ 最大，A23 是最小顺', () => {
  const akq = evaluateZjhHand(['AS', 'KS', 'QS']);
  const a23 = evaluateZjhHand(['AS', '2S', '3S']);
  const qkaOffsuit = evaluateZjhHand(['AS', 'KH', 'QD']);
  assert.equal(akq.category, ZJH_CATEGORY.SHUN_JIN);
  assert.equal(a23.category, ZJH_CATEGORY.SHUN_JIN);
  assert.ok(compareZjhHands(akq, a23) > 0);
  // 杂色 QKA 是普通顺子，输给任何顺金
  assert.equal(qkaOffsuit.category, ZJH_CATEGORY.SHUN_ZI);
  assert.ok(compareZjhHands(akq, qkaOffsuit) > 0);
});

test('顺子比较：234 大于 A23，QKA 最大', () => {
  const a23 = evaluateZjhHand(['AD', '2S', '3H']);
  const four = evaluateZjhHand(['2D', '3S', '4H']);
  const qka = evaluateZjhHand(['AD', 'KS', 'QH']);
  assert.equal(a23.category, ZJH_CATEGORY.SHUN_ZI);
  assert.ok(compareZjhHands(four, a23) > 0);
  assert.ok(compareZjhHands(qka, four) > 0);
});

test('金花比较：依次比最大牌', () => {
  const ak9 = evaluateZjhHand(['AS', 'KS', '9S']);
  const akj = evaluateZjhHand(['AH', 'KH', 'JH']);
  const kq9 = evaluateZjhHand(['KD', 'QD', '9D']);
  assert.equal(ak9.category, ZJH_CATEGORY.JIN_HUA);
  assert.ok(compareZjhHands(akj, ak9) > 0);
  assert.ok(compareZjhHands(ak9, kq9) > 0);
});

test('对子比较：先比对子点数再比单张', () => {
  const nineKing = evaluateZjhHand(['9S', '9H', 'KD']);
  const nineAce = evaluateZjhHand(['9S', '9D', 'AC']);
  const eightAce = evaluateZjhHand(['8S', '8H', 'AC']);
  assert.equal(nineKing.category, ZJH_CATEGORY.DUI_ZI);
  assert.ok(compareZjhHands(nineAce, nineKing) > 0);
  assert.ok(compareZjhHands(nineKing, eightAce) > 0);
});

test('散牌比较：A 高胜 K 高，次牌决定同首牌', () => {
  const ahigh = evaluateZjhHand(['AS', 'KD', '9H']);
  const khigh = evaluateZjhHand(['KS', 'QD', '9H']);
  const akj = evaluateZjhHand(['AC', 'KD', 'JH']);
  assert.equal(ahigh.category, ZJH_CATEGORY.SAN_PAI);
  assert.ok(compareZjhHands(ahigh, khigh) > 0);
  assert.ok(compareZjhHands(akj, ahigh) > 0);
});

test('完整牌型链与平局', () => {
  const order = [
    ['2S', '2H', '2D'],                    // 豹子
    ['AS', 'KS', 'QS'],                    // 顺金
    ['AH', 'KH', '9H'],                    // 金花
    ['AD', 'KS', 'QH'],                    // 顺子
    ['9S', '9H', 'KD'],                    // 对子
    ['AS', 'KD', '9H'],                    // 散牌
  ];
  for (let i = 0; i < order.length - 1; i += 1) {
    assert.ok(compareZjhHands(evaluateZjhHand(order[i]), evaluateZjhHand(order[i + 1])) > 0);
  }
  // 点数相同花色不同 → 平局
  assert.equal(compareZjhHands(
    evaluateZjhHand(['AS', 'KD', '9H']),
    evaluateZjhHand(['AC', 'KH', '9D']),
  ), 0);
});

test('中文牌型描述', () => {
  assert.equal(describeZjhHand(evaluateZjhHand(['AS', 'AH', 'AD'])), '豹子 AAA');
  assert.equal(describeZjhHand(evaluateZjhHand(['AD', 'KS', 'QH'])), '顺子 A高');
  assert.equal(describeZjhHand(evaluateZjhHand(['AS', '2S', '3S'])), '顺金 3高');
  assert.match(describeZjhHand(evaluateZjhHand(['9S', '9H', 'KD'])), /^对子 9带/);
});

// ===== 引擎流程 =====

function createZjhTable({ humans = 2, maxSeats = 4, config = {} } = {}) {
  const store = new MemoryStore();
  const manager = new ZjhManager(store);
  const created = manager.createRoom({
    token: 'a',
    roomName: 'Test',
    playerName: 'Alice',
    config: { maxSeats, ante: 5, baseStake: 5, startingStack: 500, ...config },
  });
  const code = created.room.code;
  manager.seatPlayer(code, 'a', 0);
  const tokens = ['a'];
  for (let i = 1; i < humans; i += 1) {
    const token = String.fromCharCode(96 + i + 1); // b, c, ...
    manager.joinRoom(code, { token, playerName: `P${i + 1}` });
    manager.seatPlayer(code, token, i);
    tokens.push(token);
  }
  return { manager, store, code, tokens };
}

function readyZjhTable(manager, code) {
  const room = manager.getRoom(code);
  for (const player of room.players.filter((candidate) => candidate.seatIndex !== null && !candidate.isBot && candidate.stack > 0 && !candidate.sitOut)) {
    manager.toggleReady(code, player.token);
  }
}

test('开局：每人 3 张牌、收底注、行动从庄家下家开始', () => {
  const { manager, code } = createZjhTable({ humans: 3 });
  readyZjhTable(manager, code);
  const room = manager.getRoom(code);
  assert.equal(room.hand.status, 'running');
  assert.equal(room.hand.pot, 15); // 3 人 × 底注 5
  for (const player of room.players) {
    assert.equal(player.holeCards.length, 3);
    assert.equal(player.seen, false);
    assert.equal(player.stack, 495);
  }
  assert.ok(room.hand.actionQueue.length >= 2);
  assert.notEqual(room.hand.actionQueue[0], room.hand.dealerSeat);
});

test('闷牌跟注付 1 倍单注，看牌后跟注付 2 倍单注', () => {
  const { manager, code } = createZjhTable({ humans: 2 });
  readyZjhTable(manager, code);
  let room = manager.getRoom(code);
  const first = room.players.find((player) => player.seatIndex === room.hand.actionQueue[0]);

  // 闷跟：底注 5 已扣，再付单注 5
  manager.applyAction(code, first.token, { type: 'call' });
  room = manager.getRoom(code);
  assert.equal(first.stack, 490);
  assert.equal(room.hand.actionQueue.length, 1); // 只剩另一位玩家

  const second = room.players.find((player) => player.seatIndex === room.hand.actionQueue[0]);
  manager.applyAction(code, second.token, { type: 'look' });
  room = manager.getRoom(code);
  assert.equal(second.seen, true);
  assert.equal(room.hand.actionQueue[0], second.seatIndex); // 看牌不消耗回合

  // 看牌跟注：付 2 × 单注 5 = 10
  manager.applyAction(code, second.token, { type: 'call' });
  room = manager.getRoom(code);
  assert.equal(second.stack, 485);
  assert.equal(room.hand.pot, 25);
});

test('加注抬高单注并按闷/看价格支付', () => {
  const { manager, code } = createZjhTable({ humans: 2 });
  readyZjhTable(manager, code);
  let room = manager.getRoom(code);
  const first = room.players.find((player) => player.seatIndex === room.hand.actionQueue[0]);

  // 闷加到单注 15：支付 15
  manager.applyAction(code, first.token, { type: 'raise', amount: 15 });
  room = manager.getRoom(code);
  assert.equal(room.hand.currentStake, 15);
  assert.equal(first.stack, 480);
  assert.equal(room.hand.pot, 25);

  const second = room.players.find((player) => player.seatIndex === room.hand.actionQueue[0]);
  manager.applyAction(code, second.token, { type: 'look' });
  // 看牌跟注：付 2 × 15 = 30
  manager.applyAction(code, second.token, { type: 'call' });
  room = manager.getRoom(code);
  assert.equal(second.stack, 465);
  assert.equal(room.hand.pot, 55);
});

test('全员弃牌：最后剩下者赢池且不摊牌', () => {
  const { manager, code } = createZjhTable({ humans: 3 });
  readyZjhTable(manager, code);
  let room = manager.getRoom(code);
  const potAfterAnte = room.hand.pot;

  for (let i = 0; i < 2; i += 1) {
    room = manager.getRoom(code);
    const actor = room.players.find((player) => player.seatIndex === room.hand.actionQueue[0]);
    manager.applyAction(code, actor.token, { type: 'fold' });
  }

  room = manager.getRoom(code);
  assert.equal(room.hand.status, 'finished');
  assert.equal(room.hand.winners.length, 1);
  assert.equal(room.hand.winners[0].amount, potAfterAnte);
  assert.equal(room.hand.revealed, false);
});

test('比牌：费用为 2 倍单注，点数小者出局，平局发起方输', () => {
  const { manager, code, tokens } = createZjhTable({ humans: 2 });
  readyZjhTable(manager, code);
  let room = manager.getRoom(code);
  const first = room.players.find((player) => player.seatIndex === room.hand.actionQueue[0]);
  const second = room.players.find((player) => player.seatIndex !== first.seatIndex);

  // 指定手牌：first 顺子 K 高，second 散牌 A 高 → second 被比掉
  first.holeCards = ['KS', 'QD', 'JH'];
  second.holeCards = ['AS', 'KD', '9H'];

  manager.applyAction(code, first.token, { type: 'compare', targetSeat: second.seatIndex });
  room = manager.getRoom(code);

  assert.equal(room.hand.status, 'finished');
  assert.equal(second.folded, true);
  assert.equal(room.hand.winners[0].token, first.token);
  // 底注 5 + 比牌费 2×5 = 投入 15；比牌后对手出局、独自赢池（池内 20）
  assert.equal(first.stack, 500 - 5 - 10 + 20);
});

test('比牌平局：发起方判负', () => {
  const { manager, code } = createZjhTable({ humans: 2 });
  readyZjhTable(manager, code);
  let room = manager.getRoom(code);
  const first = room.players.find((player) => player.seatIndex === room.hand.actionQueue[0]);
  const second = room.players.find((player) => player.seatIndex !== first.seatIndex);

  first.holeCards = ['AS', 'KD', '9H'];
  second.holeCards = ['AC', 'KH', '9D'];

  manager.applyAction(code, first.token, { type: 'compare', targetSeat: second.seatIndex });
  room = manager.getRoom(code);
  assert.equal(first.folded, true);
  assert.equal(room.hand.winners[0].token, second.token);
});

test('达到轮数上限强制摊牌，最大牌型获胜并写入历史', () => {
  const { manager, store, code } = createZjhTable({
    humans: 2,
    config: { maxRounds: 3 },
  });
  readyZjhTable(manager, code);
  let room = manager.getRoom(code);
  room.players[0].holeCards = ['AS', 'AH', 'AD'];
  room.players[1].holeCards = ['KS', 'QD', 'JH'];

  let guard = 0;
  while (manager.getRoom(code).hand.status === 'running' && guard < 40) {
    room = manager.getRoom(code);
    if (!room.hand.actionQueue.length) break;
    const actor = room.players.find((player) => player.seatIndex === room.hand.actionQueue[0]);
    manager.applyAction(code, actor.token, { type: 'call' });
    guard += 1;
  }

  room = manager.getRoom(code);
  assert.equal(room.hand.status, 'finished');
  assert.equal(room.hand.revealed, true);
  assert.equal(room.hand.winners[0].token, room.players[0].token);
  assert.equal(room.hand.winners[0].handLabel, '豹子 AAA');
  assert.ok(store.listHandHistory(code).length > 0);
});

test('快照恢复：游戏类型、配置与手牌状态完整', () => {
  const { manager, store, code } = createZjhTable({ humans: 2 });
  readyZjhTable(manager, code);
  let room = manager.getRoom(code);
  const first = room.players.find((player) => player.seatIndex === room.hand.actionQueue[0]);
  manager.applyAction(code, first.token, { type: 'raise', amount: 10 });

  const snapshot = store.listRooms().find((entry) => entry.code === code);
  assert.equal(snapshot.gameType, 'zjh');
  const revived = hydrateZjhRoom(snapshot);
  assert.equal(revived.gameType, 'zjh');
  assert.equal(revived.hand.currentStake, 10);
  assert.equal(revived.players.length, 2);
  assert.equal(revived.players[0].holeCards.length, 3);
});

test('双 manager 分治：德州不加载炸金花房间，反之亦然', () => {
  const store = new MemoryStore();
  const zjh = new ZjhManager(store);
  const created = zjh.createRoom({ token: 'z', roomName: 'ZJH', playerName: 'Zoe', config: {} });
  zjh.joinRoom(created.room.code, { token: 'z2', playerName: 'Zack' });

  const texas = new GameManager(store);
  assert.equal(texas.getRoom(created.room.code), null);
  assert.ok(zjh.getRoom(created.room.code));

  const texasCreated = texas.createRoom({ token: 't', roomName: 'TX', playerName: 'Tom', config: {} });
  assert.equal(zjh.getRoom(texasCreated.room.code), null);
  assert.ok(texas.getRoom(texasCreated.room.code));

  // 房间码全局查重
  assert.equal(zjh.getRoom(texasCreated.room.code), null);
  const codes = new Set([created.room.code, texasCreated.room.code]);
  assert.equal(codes.size, 2);
});

test('序列化视图：他人的牌对闷牌者隐藏，自己的牌始终可见', () => {
  const { manager, code } = createZjhTable({ humans: 2 });
  readyZjhTable(manager, code);
  const view = manager.getRoomView(code, 'a');
  assert.equal(view.gameType, 'zjh');
  const self = view.players.find((player) => player.isViewer);
  const other = view.players.find((player) => !player.isViewer);
  assert.equal(self.holeCards.length, 3);
  assert.deepEqual(other.holeCards, ['??', '??', '??']);
  assert.equal(view.summary.gameType, 'zjh');
});

test('炸金花机器人能自动打完整局', () => {
  const store = new MemoryStore();
  const manager = new ZjhManager(store);
  const created = manager.createRoom({
    token: 'host',
    roomName: 'BotTest',
    playerName: 'Host',
    config: { maxSeats: 4, ante: 5, baseStake: 5, startingStack: 300, maxRounds: 6 },
  });
  const code = created.room.code;
  manager.addBot(code, 'host', 'beginner');
  manager.addBot(code, 'host', 'intermediate');
  manager.addBot(code, 'host', 'advanced');
  manager.seatPlayer(code, 'host', 0);
  manager.startHand(code, 'host');

  let guard = 0;
  while (manager.getRoom(code).hand.status === 'running' && guard < 300) {
    manager.tick(Date.now() + guard * 6000);
    guard += 1;
  }
  assert.equal(manager.getRoom(code).hand.status, 'finished');
  assert.ok(manager.getRoom(code).hand.winners.length >= 1);
});

test('AI 牌力估值随牌型单调', () => {
  const baozi = estimateZjhStrength(['AS', 'AH', 'AD']);
  const shunjin = estimateZjhStrength(['AS', 'KS', 'QS']);
  const jinhua = estimateZjhStrength(['AH', 'KH', '9H']);
  const duizi = estimateZjhStrength(['9S', '9H', 'KD']);
  const sanpai = estimateZjhStrength(['9S', '5H', '3D']);
  assert.ok(baozi > shunjin);
  assert.ok(shunjin > jinhua);
  assert.ok(jinhua > duizi);
  assert.ok(duizi > sanpai);
});

test('快照卫生：动作处理后房间不被挂内部引用，保存的快照剔除 __ 前缀字段', () => {
  const { manager, store, code } = createZjhTable({ humans: 2 });
  readyZjhTable(manager, code);
  const room = manager.getRoom(code);
  const actorSeat = room.hand.actionQueue[0];
  const actor = room.players.find((player) => player.seatIndex === actorSeat);
  manager.applyAction(code, actor.token, { type: 'fold' });

  // 曾经的 bug：applyAction 曾把 this.store 挂到 room.__storeRef，
  // 随快照写入数据库，且每次保存序列化体积翻倍直至 JSON 超限崩溃
  assert.equal(manager.getRoom(code).__storeRef, undefined);

  const saved = store.rooms.get(code);
  assert.ok(saved);
  for (const key of Object.keys(saved)) {
    assert.ok(!key.startsWith('__'), `快照不应包含内部字段 ${key}`);
  }
  assert.ok(JSON.stringify(saved).length < 100_000, '快照体积应保持在正常量级');

  // 即便房间对象被内部引用污染，stripRuntime 也必须把它挡在快照外
  const polluted = manager.getRoom(code);
  polluted.__junk = { blob: 'x'.repeat(10_000) };
  manager.emit(polluted);
  assert.equal(store.rooms.get(code).__junk, undefined);
});

test('真实 RoomStore 连续保存快照体积保持有界（复现 __storeRef 生产事故）', () => {
  // 生产事故机制：RoomStore 的预编译语句会缓存最近一次绑定的快照字符串，
  // 一旦 store 引用被挂进房间，每次保存都会把上一次的快照嵌套进来，体积翻倍，
  // 十几次保存后 JSON 超出 V8 字符串上限（约 512MB），tick 反复报 Invalid string length。
  // 因此该测试必须使用真实 RoomStore 而非内存替身。
  const dbPath = join(tmpdir(), `zjh-snapshot-regression-${process.pid}-${Date.now()}.sqlite`);
  const store = new RoomStore(dbPath);
  try {
    const manager = new ZjhManager(store);
    const created = manager.createRoom({
      token: 'host',
      roomName: 'SnapshotRegression',
      playerName: 'Host',
      config: { maxSeats: 4, ante: 5, baseStake: 5, startingStack: 300, maxRounds: 6 },
    });
    const code = created.room.code;
    manager.addBot(code, 'host', 'beginner');
    manager.addBot(code, 'host', 'intermediate');
    manager.addBot(code, 'host', 'advanced');
    manager.seatPlayer(code, 'host', 0);
    manager.startHand(code, 'host');

    let guard = 0;
    let maxSize = 0;
    while (manager.getRoom(code).hand.status === 'running' && guard < 400) {
      manager.tick(Date.now() + guard * 6000);
      guard += 1;
      const size = JSON.stringify(store.loadRoom(code)).length;
      maxSize = Math.max(maxSize, size);
      assert.ok(size < 200_000, `快照体积失控：第 ${guard} 次保存后达 ${size}B（历史最大 ${maxSize}B）`);
    }
    assert.equal(manager.getRoom(code).hand.status, 'finished');
    assert.ok(maxSize < 200_000, `快照历史最大体积 ${maxSize}B 超出正常量级`);
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  }
});
