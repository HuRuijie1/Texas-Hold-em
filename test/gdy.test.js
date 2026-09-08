import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GDY_PLAY_TYPE,
  createGdyDeck,
  describeGdyPlay,
  evaluateGdyPlay,
  formatGdyCards,
  gdyBeats,
} from '../src/gdy.js';
import { GdyManager, GDY_DEFAULT_CONFIG } from '../src/gdy-engine.js';
import { createRealtimeApp } from '../src/realtime-app.js';

class MemoryStore {
  constructor() {
    this.rooms = new Map();
    this.history = new Map();
  }

  saveRoom(room) {
    this.rooms.set(room.code, structuredClone(room));
  }

  listRooms() {
    return [...this.rooms.values()].map((room) => structuredClone(room));
  }

  saveHandHistory(code, _handNo, summary) {
    if (!this.history.has(code)) this.history.set(code, []);
    this.history.get(code).push(structuredClone(summary));
  }

  listHandHistory(code) {
    return [...(this.history.get(code) || [])];
  }

  deleteRoom(code) {
    this.rooms.delete(code);
  }

  close() {}
}

// ===== 牌型判定 =====

test('单张：普通牌可出，癞子不能单独出', () => {
  assert.equal(evaluateGdyPlay(['AS'])?.type, GDY_PLAY_TYPE.SINGLE);
  assert.equal(evaluateGdyPlay(['2H'])?.rank, 15);
  assert.equal(evaluateGdyPlay(['RJ']), null);
  assert.equal(evaluateGdyPlay(['BJ']), null);
  assert.equal(evaluateGdyPlay([]), null);
});

test('对子：真对子、一真一癞可出；杂色不成对；双癞子不能直接出', () => {
  const real = evaluateGdyPlay(['5H', '5S']);
  assert.equal(real.type, GDY_PLAY_TYPE.PAIR);
  assert.equal(real.rank, 5);
  assert.equal(real.wilds, 0);

  const wild = evaluateGdyPlay(['5H', 'RJ']);
  assert.equal(wild.type, GDY_PLAY_TYPE.PAIR);
  assert.equal(wild.rank, 5);
  assert.equal(wild.wilds, 1);

  // 癞子可当 2 组成最大对子
  assert.equal(evaluateGdyPlay(['2H', 'BJ'])?.rank, 15);

  assert.equal(evaluateGdyPlay(['5H', '6S']), null);
  assert.equal(evaluateGdyPlay(['RJ', 'BJ']), null);
});

test('炸弹：真三张 / 两真一癞 / 一真两癞', () => {
  const real = evaluateGdyPlay(['5H', '5S', '5D']);
  assert.equal(real.type, GDY_PLAY_TYPE.BOMB);
  assert.equal(real.wilds, 0);

  const two = evaluateGdyPlay(['5H', '5S', 'RJ']);
  assert.equal(two.type, GDY_PLAY_TYPE.BOMB);
  assert.equal(two.wilds, 1);

  const one = evaluateGdyPlay(['5H', 'RJ', 'BJ']);
  assert.equal(one.type, GDY_PLAY_TYPE.BOMB);
  assert.equal(one.wilds, 2);

  assert.equal(evaluateGdyPlay(['5H', '5S', '6D']), null);
});

test('顺子：3 张起、最大到 A、2 不入顺、癞子补缺', () => {
  assert.equal(evaluateGdyPlay(['3H', '4S', '5D'])?.rank, 5);
  assert.equal(evaluateGdyPlay(['QH', 'KS', 'AD'])?.rank, 14);
  assert.equal(evaluateGdyPlay(['9H', 'TS', 'JD', 'QD', 'KH'])?.rank, 13);
  assert.equal(evaluateGdyPlay(['2H', '3S', '4D']), null);
  assert.equal(evaluateGdyPlay(['3H', '4S', '4D', '5C']), null);

  // 3,4 + 癞子 → 最有利当 5，组成 345
  const wild = evaluateGdyPlay(['3H', '4S', 'RJ']);
  assert.equal(wild.type, GDY_PLAY_TYPE.STRAIGHT);
  assert.equal(wild.hi, 5);

  // Q,K,A + 癞子 → 癞子当 J
  assert.equal(evaluateGdyPlay(['QH', 'KS', 'AD', 'RJ'])?.hi, 14);

  // 间隔过大癞子补不上
  assert.equal(evaluateGdyPlay(['3H', '6S', 'RJ']), null);
});

test('连对：2 对起、癞子可补半对或自组一对、2 不入连对', () => {
  assert.equal(evaluateGdyPlay(['3H', '3S', '4D', '4C'])?.rank, 4);
  assert.equal(evaluateGdyPlay(['QH', 'QS', 'KD', 'KC', 'AH', 'AS'])?.rank, 14);

  const wildHalf = evaluateGdyPlay(['3H', '3S', '4D', 'RJ']);
  assert.equal(wildHalf.type, GDY_PLAY_TYPE.PAIRS);
  assert.equal(wildHalf.hi, 4);
  assert.equal(wildHalf.wilds, 1);

  // 3,3,王,王 按"最有利"原则判为四张炸弹 3（炸弹 > 连对）
  const wildBomb = evaluateGdyPlay(['3H', '3S', 'RJ', 'BJ']);
  assert.equal(wildBomb.type, GDY_PLAY_TYPE.BOMB);
  assert.equal(wildBomb.size, 4);
  assert.equal(wildBomb.rank, 3);

  // 双癞连对：3,4 + 双王 → 3344
  const wildFull = evaluateGdyPlay(['3H', '4S', 'RJ', 'BJ']);
  assert.equal(wildFull.type, GDY_PLAY_TYPE.PAIRS);
  assert.equal(wildFull.hi, 4);
  assert.equal(wildFull.wilds, 2);

  assert.equal(evaluateGdyPlay(['5H', '5S', '7D', '7C']), null);
  assert.equal(evaluateGdyPlay(['2H', '2S', '3D', '3C']), null);
  assert.equal(evaluateGdyPlay(['3H', '3S', '3D', '4C']), null);
});

test('四张同点也是炸弹：真四张 / 三真一癞 / 两真两癞，倍率相关比较', () => {
  const real4 = evaluateGdyPlay(['5H', '5S', '5D', '5C']);
  assert.equal(real4.type, GDY_PLAY_TYPE.BOMB);
  assert.equal(real4.size, 4);
  assert.equal(real4.wilds, 0);

  const wild1 = evaluateGdyPlay(['5H', '5S', '5D', 'RJ']);
  assert.equal(wild1.type, GDY_PLAY_TYPE.BOMB);
  assert.equal(wild1.size, 4);
  assert.equal(wild1.wilds, 1);

  const wild2 = evaluateGdyPlay(['5H', '5S', 'RJ', 'BJ']);
  assert.equal(wild2.type, GDY_PLAY_TYPE.BOMB);
  assert.equal(wild2.size, 4);
  assert.equal(wild2.wilds, 2);

  // 四张炸比三张炸大：5555 吃 999，222 吃不掉 5555
  const bomb3 = evaluateGdyPlay(['9H', '9S', '9D']);
  assert.ok(gdyBeats(real4, bomb3));
  assert.ok(!gdyBeats(bomb3, real4));
  const bomb3big = evaluateGdyPlay(['2H', '2S', '2D']);
  assert.ok(gdyBeats(real4, bomb3big));

  // 四张炸之间：先比点数，同点真牌多者大
  assert.ok(gdyBeats(evaluateGdyPlay(['6H', '6S', '6D', '6C']), real4));
  assert.ok(gdyBeats(real4, wild1));
  assert.ok(gdyBeats(wild1, wild2));
  assert.ok(!gdyBeats(wild2, real4));

  assert.match(describeGdyPlay(real4), /炸弹 5555/);
  // 3 张同点仍是三张炸弹
  assert.equal(evaluateGdyPlay(['5H', '5S', '5D'])?.size, 3);
});

test('三张牌优先判定为炸弹而不是顺子', () => {
  // 5,5,王 既能当"对5加癞子"也能当炸弹，应取炸弹
  assert.equal(evaluateGdyPlay(['5H', '5S', 'RJ'])?.type, GDY_PLAY_TYPE.BOMB);
});

// ===== 比较规则 =====

test('炸弹压一切非炸弹；炸弹之间先比点数', () => {
  const bomb = evaluateGdyPlay(['3H', '3S', '3D']);
  const straight = evaluateGdyPlay(['4H', '5S', '6D']);
  const pair = evaluateGdyPlay(['AH', 'AS']);
  assert.ok(gdyBeats(bomb, straight));
  assert.ok(gdyBeats(bomb, pair));
  assert.ok(!gdyBeats(straight, bomb));

  const bomb2 = evaluateGdyPlay(['2H', '2S', '2D']);
  assert.ok(gdyBeats(bomb2, bomb));

  assert.ok(!gdyBeats(evaluateGdyPlay(['4H', '5S', '6D']), evaluateGdyPlay(['5H', '6S', '7D'])));
  assert.ok(gdyBeats(evaluateGdyPlay(['6H', '7S', '8D']), evaluateGdyPlay(['5H', '6S', '7D'])));
  // 张数不同不能压
  assert.ok(!gdyBeats(evaluateGdyPlay(['6H', '7S', '8D', '9C']), evaluateGdyPlay(['5H', '6S', '7D'])));
});

test('同点数炸弹：真牌越多越大（真三张 > 两真一癞 > 一真两癞）', () => {
  const real = evaluateGdyPlay(['5H', '5S', '5D']);
  const two = evaluateGdyPlay(['5H', '5S', 'RJ']);
  const one = evaluateGdyPlay(['5H', 'RJ', 'BJ']);
  assert.ok(gdyBeats(real, two));
  assert.ok(gdyBeats(two, one));
  assert.ok(!gdyBeats(one, real));
  assert.ok(!gdyBeats(real, real));
});

test('只能按顺序吃：单张/对子/顺子/连对都必须紧邻大一号，2 通吃单张与对子', () => {
  const play = (cards) => evaluateGdyPlay(cards);

  // 单张：10 只能被 J 或 2 吃
  assert.ok(gdyBeats(play(['JH']), play(['TH'])));
  assert.ok(!gdyBeats(play(['QH']), play(['TH'])));
  assert.ok(!gdyBeats(play(['AH']), play(['TH'])));
  assert.ok(gdyBeats(play(['2H']), play(['TH'])));
  assert.ok(gdyBeats(play(['2H']), play(['AH'])));
  assert.ok(!gdyBeats(play(['2D']), play(['2H']))); // 2 不吃 2
  assert.ok(!gdyBeats(play(['AH']), play(['2H']))); // 2 之上只有炸弹

  // 对子：顺移一号，对 2 通吃
  assert.ok(gdyBeats(play(['9H', '9S']), play(['8H', '8S'])));
  assert.ok(!gdyBeats(play(['JH', 'JS']), play(['8H', '8S'])));
  assert.ok(gdyBeats(play(['2H', '2S']), play(['AH', 'AS'])));
  assert.ok(!gdyBeats(play(['2D', '2C']), play(['2H', '2S'])));

  // 顺子：567 只能被 678 吃
  assert.ok(gdyBeats(play(['6H', '7S', '8D']), play(['5H', '6S', '7D'])));
  assert.ok(!gdyBeats(play(['8H', '9S', 'TD']), play(['5H', '6S', '7D'])));
  assert.ok(gdyBeats(play(['QH', 'KS', 'AD']), play(['JH', 'QS', 'KD'])));
  // 最大顺 QKA 只能被炸弹吃（没有"2 顺"存在）

  // 连对：334455 只能被 445566 吃
  assert.ok(gdyBeats(play(['4H', '4S', '5D', '5C', '6H', '6S']), play(['3H', '3S', '4D', '4C', '5H', '5S'])));
  assert.ok(!gdyBeats(play(['5H', '5S', '6D', '6C', '7H', '7S']), play(['3H', '3S', '4D', '4C', '5H', '5S'])));
});

// ===== 描述与格式化 =====

test('中文牌型描述', () => {
  assert.match(describeGdyPlay(evaluateGdyPlay(['5H', '5S', '5D'])), /炸弹 555/);
  assert.match(describeGdyPlay(evaluateGdyPlay(['6H', '7S', '8D'])), /顺子 6~8/);
  assert.match(describeGdyPlay(evaluateGdyPlay(['3H', '3S', '4D', '4C'])), /连对 33~44/);
  assert.match(describeGdyPlay(evaluateGdyPlay(['KH', 'KS'])), /对子 KK/);
  assert.match(describeGdyPlay(evaluateGdyPlay(['5H', '5S', 'RJ'])), /含癞子×1/);
  assert.match(formatGdyCards(['RJ', '3H']), /大王/);
});

test('一副干瞪眼镜共 54 张且含双王', () => {
  const deck = createGdyDeck();
  assert.equal(deck.length, 54);
  assert.equal(deck.filter((card) => card === 'RJ').length, 1);
  assert.equal(deck.filter((card) => card === 'BJ').length, 1);
});

// ===== 引擎流程 =====

function makeRoom(config = {}) {
  const store = new MemoryStore();
  const manager = new GdyManager(store, { config: { ...GDY_DEFAULT_CONFIG, ...config } });
  const created = manager.createRoom({ token: 't1', playerName: '甲', config });
  const code = created.room.code;
  manager.joinRoom(code, { token: 't2', playerName: '乙' });
  manager.seatPlayer(code, 't2', 1);
  return { store, manager, code };
}

function startDeterministic(manager, code, hands) {
  manager.toggleReady(code, 't1');
  manager.toggleReady(code, 't2');
  const room = manager.getRoom(code);
  room.hand.deck = [];
  room.hand.deckIndex = 0;
  for (const [seat, cards] of Object.entries(hands)) {
    playerBySeat(room, Number(seat)).holeCards = [...cards];
  }
  return room;
}

function playerBySeat(room, seat) {
  return room.players.find((player) => player.seatIndex === seat);
}

test('开局发牌：庄家 6 张其余 5 张，牌堆剩余正确', () => {
  const { manager, code } = makeRoom();
  manager.toggleReady(code, 't1');
  manager.toggleReady(code, 't2');
  const room = manager.getRoom(code);
  assert.equal(room.hand.status, 'running');
  assert.equal(playerBySeat(room, room.hand.dealerSeat).holeCards.length, 6);
  const other = room.players.find((player) => player.seatIndex !== room.hand.dealerSeat);
  assert.equal(other.holeCards.length, 5);
  assert.equal(room.hand.deck.length - room.hand.deckIndex, 54 - 11);
});

test('对局流程：炸弹倍率、一圈全过后重获出牌权、先出完获胜', () => {
  const { manager, code } = makeRoom();
  manager.toggleReady(code, 't1');
  manager.toggleReady(code, 't2');
  const room = manager.getRoom(code);
  const dealerSeat = room.hand.dealerSeat;
  const otherSeat = dealerSeat === 0 ? 1 : 0;
  room.hand.deck = [];
  room.hand.deckIndex = 0;
  playerBySeat(room, dealerSeat).holeCards = ['3H', '3S', '3D', '5H', '6H', '7H'];
  playerBySeat(room, otherSeat).holeCards = ['8H', '8S', '9H', '6D', '6C'];

  const dealer = dealerSeat === 0 ? 't1' : 't2';
  const other = dealerSeat === 0 ? 't2' : 't1';

  // 1. 庄家出炸弹 333
  manager.applyAction(code, dealer, { type: 'play', cards: ['3H', '3S', '3D'] });
  assert.equal(room.hand.bombsPlayed, 1);
  assert.equal(2 ** room.hand.bombsPlayed, 2);
  // 2. 另一家干瞪眼 → 庄家重获自由出牌权（牌堆为空不摸）
  manager.applyAction(code, other, { type: 'pass' });
  assert.equal(room.hand.lastPlay, null);
  assert.equal(room.hand.turnSeat, dealerSeat);
  // 3. 顺移接牌链：5 ← 6 ← 7 ← 8，庄家管不上只能过 → 对家重获自由出牌权
  manager.applyAction(code, dealer, { type: 'play', cards: ['5H'] });
  manager.applyAction(code, other, { type: 'play', cards: ['6D'] });
  manager.applyAction(code, dealer, { type: 'play', cards: ['7H'] });
  manager.applyAction(code, other, { type: 'play', cards: ['8H'] });
  manager.applyAction(code, dealer, { type: 'pass' });
  assert.equal(room.hand.turnSeat, otherSeat);
  assert.equal(room.hand.lastPlay, null);
  // 4. 对家自由出 9，庄家管不上只能过
  manager.applyAction(code, other, { type: 'play', cards: ['9H'] });
  manager.applyAction(code, dealer, { type: 'pass' });
  // 5. 对家把剩牌打完获胜；庄家剩 1 张（非 5 张不触发通关），炸弹倍率 ×2
  manager.applyAction(code, other, { type: 'play', cards: ['8S'] });
  manager.applyAction(code, dealer, { type: 'pass' });
  manager.applyAction(code, other, { type: 'play', cards: ['6C'] });
  assert.equal(room.hand.status, 'finished');
  assert.equal(room.hand.winners[0].name, otherSeat === 0 ? '甲' : '乙');

  const loser = room.hand.results[0];
  assert.equal(loser.cardsLeft, 1);
  assert.equal(loser.passThrough, false);
  assert.equal(loser.bombMultiplier, 2);
  assert.equal(loser.loss, 2); // 1 张 × 底分 1 × 炸弹倍率 2
  assert.equal(loser.paid, 2);
  assert.equal(playerBySeat(room, otherSeat).stack, GDY_DEFAULT_CONFIG.startingStack + 2);
  assert.equal(playerBySeat(room, dealerSeat).stack, GDY_DEFAULT_CONFIG.startingStack - 2);
  // 上局赢家连庄
  assert.equal(room.dealerSeat, otherSeat);
});

test('被通关：输家结束时剩 5 张，个人扣分翻倍', () => {
  const { manager, code } = makeRoom();
  manager.toggleReady(code, 't1');
  manager.toggleReady(code, 't2');
  const room = manager.getRoom(code);
  const dealerSeat = room.hand.dealerSeat;
  const otherSeat = dealerSeat === 0 ? 1 : 0;
  room.hand.deck = [];
  room.hand.deckIndex = 0;
  playerBySeat(room, dealerSeat).holeCards = ['3H', '4H', '5H', '6H', '7H', '8H'];
  playerBySeat(room, otherSeat).holeCards = ['AH', 'AS', 'AC', 'AD', '2H'];

  const dealer = dealerSeat === 0 ? 't1' : 't2';
  const other = dealerSeat === 0 ? 't2' : 't1';

  // 庄家逐张出单牌，乙能压但一直选择过（跟牌可主动过）
  for (const card of ['3H', '4H', '5H', '6H', '7H']) {
    manager.applyAction(code, dealer, { type: 'play', cards: [card] });
    manager.applyAction(code, other, { type: 'pass' });
  }
  manager.applyAction(code, dealer, { type: 'play', cards: ['8H'] });
  assert.equal(room.hand.status, 'finished');

  const loser = room.hand.results[0];
  assert.equal(loser.cardsLeft, 5);
  assert.equal(loser.passThrough, true);
  assert.equal(loser.bombMultiplier, 1);
  assert.equal(loser.loss, 10); // 5 张 × 底分 1 × 通关 ×2
  assert.equal(loser.paid, 10);
});

test('单局封顶：扣分不超过 scoreCap', () => {
  const { manager, code } = makeRoom({ scoreCap: 1 });
  manager.toggleReady(code, 't1');
  manager.toggleReady(code, 't2');
  const room = manager.getRoom(code);
  const dealerSeat = room.hand.dealerSeat;
  const otherSeat = dealerSeat === 0 ? 1 : 0;
  room.hand.deck = [];
  room.hand.deckIndex = 0;
  playerBySeat(room, dealerSeat).holeCards = ['3H', '3S', '3D', '5H', '6H', '7H'];
  playerBySeat(room, otherSeat).holeCards = ['8H', '8S', '9H', '6D', '6C'];

  const dealer = dealerSeat === 0 ? 't1' : 't2';
  const other = dealerSeat === 0 ? 't2' : 't1';

  manager.applyAction(code, dealer, { type: 'play', cards: ['3H', '3S', '3D'] });
  manager.applyAction(code, other, { type: 'pass' });
  manager.applyAction(code, dealer, { type: 'play', cards: ['5H'] });
  manager.applyAction(code, other, { type: 'play', cards: ['6D'] });
  manager.applyAction(code, dealer, { type: 'play', cards: ['7H'] });
  manager.applyAction(code, other, { type: 'play', cards: ['8H'] });
  manager.applyAction(code, dealer, { type: 'pass' });
  manager.applyAction(code, other, { type: 'play', cards: ['9H'] });
  manager.applyAction(code, dealer, { type: 'pass' });
  manager.applyAction(code, other, { type: 'play', cards: ['8S'] });
  manager.applyAction(code, dealer, { type: 'pass' });
  manager.applyAction(code, other, { type: 'play', cards: ['6C'] });

  const loser = room.hand.results[0];
  assert.equal(loser.loss, 2); // 1 张 × 底分 1 × 炸弹倍率 2
  assert.equal(loser.capped, true);
  assert.equal(loser.paid, 1);
});

test('自由出牌不能过；压不过上家的牌会被拒绝', () => {
  const { manager, code } = makeRoom();
  manager.toggleReady(code, 't1');
  manager.toggleReady(code, 't2');
  const room = manager.getRoom(code);
  const dealerSeat = room.hand.dealerSeat;
  const otherSeat = dealerSeat === 0 ? 1 : 0;
  room.hand.deck = [];
  room.hand.deckIndex = 0;
  playerBySeat(room, dealerSeat).holeCards = ['3H', '5H', '7H', '9H', 'JH', 'KH'];
  playerBySeat(room, otherSeat).holeCards = ['4H', '6H', '8H', 'TH', 'QH'];

  const dealer = dealerSeat === 0 ? 't1' : 't2';
  const other = dealerSeat === 0 ? 't2' : 't1';

  // 自由出牌者过牌 → 拒绝
  assert.throws(() => manager.applyAction(code, dealer, { type: 'pass' }), /必须出牌/);
  manager.applyAction(code, dealer, { type: 'play', cards: ['KH'] });
  // 对家没有任何大于 K 的单张 → 压不过
  assert.throws(() => manager.applyAction(code, other, { type: 'play', cards: ['4H'] }), /压不过/);
  // 杂色两张不成对 → 无效牌型
  assert.throws(() => manager.applyAction(code, other, { type: 'play', cards: ['8H', 'QH'] }), /不构成有效牌型/);
  // 没轮到的玩家行动 → 拒绝
  assert.throws(() => manager.applyAction(code, dealer, { type: 'pass' }), /还没轮到你/);
  manager.applyAction(code, other, { type: 'pass' });
  assert.equal(room.hand.turnSeat, dealerSeat);
});

test('双王带一张普通牌构成炸弹并计入倍率', () => {
  const { manager, code } = makeRoom();
  manager.toggleReady(code, 't1');
  manager.toggleReady(code, 't2');
  const room = manager.getRoom(code);
  const dealerSeat = room.hand.dealerSeat;
  const otherSeat = dealerSeat === 0 ? 1 : 0;
  room.hand.deck = [];
  room.hand.deckIndex = 0;
  playerBySeat(room, dealerSeat).holeCards = ['5H', 'RJ', 'BJ', '7H', '9H', '2H'];
  playerBySeat(room, otherSeat).holeCards = ['5S', '5D', '5C', '8H', '8S'];

  const dealer = dealerSeat === 0 ? 't1' : 't2';
  const other = dealerSeat === 0 ? 't2' : 't1';

  // 双王+5 = 炸弹5（两癞）；对方真三张 5 同点压过（真牌多者大），倍率累计 ×4
  manager.applyAction(code, dealer, { type: 'play', cards: ['5H', 'RJ', 'BJ'] });
  assert.equal(room.hand.bombsPlayed, 1);
  manager.applyAction(code, other, { type: 'play', cards: ['5S', '5D', '5C'] });
  assert.equal(room.hand.bombsPlayed, 2);
  assert.equal(room.hand.bombsPlayed, 2);
  assert.equal(2 ** room.hand.bombsPlayed, 4);
  // 庄家过牌后对家自由出牌，把对子打完赢下
  manager.applyAction(code, dealer, { type: 'pass' });
  assert.equal(room.hand.turnSeat, otherSeat);
  manager.applyAction(code, other, { type: 'play', cards: ['8H', '8S'] });
  assert.equal(room.hand.status, 'finished');
  assert.equal(room.hand.winners[0].name, otherSeat === 0 ? '甲' : '乙');
  assert.equal(room.hand.results[0].bombMultiplier, 4);
});

test('四张炸弹倍率 ×4，且能接三张炸弹', () => {
  const { manager, code } = makeRoom();
  manager.toggleReady(code, 't1');
  manager.toggleReady(code, 't2');
  const room = manager.getRoom(code);
  const dealerSeat = room.hand.dealerSeat;
  const otherSeat = dealerSeat === 0 ? 1 : 0;
  room.hand.deck = [];
  room.hand.deckIndex = 0;
  playerBySeat(room, dealerSeat).holeCards = ['3H', '3S', '3D', '9H', '9S', '2H'];
  playerBySeat(room, otherSeat).holeCards = ['5H', '5S', '5D', '5C', '8H'];

  const dealer = dealerSeat === 0 ? 't1' : 't2';
  const other = dealerSeat === 0 ? 't2' : 't1';

  // 庄家三张炸 333（倍率 ×2），对家四张炸 5555 接上（倍率再 ×4 → ×8）
  manager.applyAction(code, dealer, { type: 'play', cards: ['3H', '3S', '3D'] });
  assert.equal(room.hand.bombMultiplier, 2);
  manager.applyAction(code, other, { type: 'play', cards: ['5H', '5S', '5D', '5C'] });
  assert.equal(room.hand.bombMultiplier, 8);
  assert.equal(room.hand.bombsPlayed, 2);
  // 庄家管不上只能过，对家自由出 88 打完获胜
  manager.applyAction(code, dealer, { type: 'pass' });
  manager.applyAction(code, other, { type: 'play', cards: ['8H'] });
  assert.equal(room.hand.status, 'finished');
  assert.equal(room.hand.results[0].bombMultiplier, 8);
});

test('超时托管：跟牌超时自动过，自由出牌超时自动出最小单张', () => {
  const { manager, code } = makeRoom({ actionTimeoutMs: 5000 });
  manager.toggleReady(code, 't1');
  manager.toggleReady(code, 't2');
  const room = manager.getRoom(code);
  const dealerSeat = room.hand.dealerSeat;
  const otherSeat = dealerSeat === 0 ? 1 : 0;
  room.hand.deck = [];
  room.hand.deckIndex = 0;
  playerBySeat(room, dealerSeat).holeCards = ['JH', 'QH', 'KH'];
  playerBySeat(room, otherSeat).holeCards = ['3H', '4S', '5D', '6C'];

  // 自由出牌超时：自动出最小单张 JH
  room.hand.turnDeadlineAt = Date.now() - 1;
  manager.tick();
  assert.deepEqual(playerBySeat(room, dealerSeat).holeCards, ['QH', 'KH']);
  assert.equal(room.hand.lastPlay.play.rank, 11);

  // 跟牌超时：自动过 → 庄家重获出牌权
  room.hand.turnDeadlineAt = Date.now() - 1;
  manager.tick();
  assert.equal(room.hand.turnSeat, dealerSeat);
  assert.equal(room.hand.lastPlay, null);
});

test('房间快照视图：他人的牌在局中不可见，结束后亮牌', () => {
  const { manager, code } = makeRoom();
  manager.toggleReady(code, 't1');
  manager.toggleReady(code, 't2');
  const room = manager.getRoom(code);
  const dealerSeat = room.hand.dealerSeat;
  const otherSeat = dealerSeat === 0 ? 1 : 0;
  room.hand.deck = [];
  room.hand.deckIndex = 0;
  playerBySeat(room, dealerSeat).holeCards = ['3H', '3S', '3D', '5H', '6H', '7H'];
  playerBySeat(room, otherSeat).holeCards = ['8H', '8S', '9H', '6D', '6C'];
  const dealerToken = dealerSeat === 0 ? 't1' : 't2';
  const otherToken = dealerSeat === 0 ? 't2' : 't1';
  const dealerName = dealerSeat === 0 ? '甲' : '乙';

  const runningView = manager.getRoomView(code, dealerToken);
  assert.equal(runningView.gameType, 'gdy');
  assert.equal(runningView.self.holeCards.length, 6);
  const opponentView = runningView.players.find((player) => player.name !== dealerName);
  assert.equal(opponentView.holeCards.length, 0);
  assert.equal(opponentView.cardCount, 5);
  assert.ok(runningView.hand.availableActions);

  // 顺移吃牌链走完整局
  manager.applyAction(code, dealerToken, { type: 'play', cards: ['3H', '3S', '3D'] });
  manager.applyAction(code, otherToken, { type: 'pass' });
  manager.applyAction(code, dealerToken, { type: 'play', cards: ['5H'] });
  manager.applyAction(code, otherToken, { type: 'play', cards: ['6D'] });
  manager.applyAction(code, dealerToken, { type: 'play', cards: ['7H'] });
  manager.applyAction(code, otherToken, { type: 'play', cards: ['8H'] });
  manager.applyAction(code, dealerToken, { type: 'pass' });
  manager.applyAction(code, otherToken, { type: 'play', cards: ['9H'] });
  manager.applyAction(code, dealerToken, { type: 'pass' });
  manager.applyAction(code, otherToken, { type: 'play', cards: ['8S'] });
  manager.applyAction(code, dealerToken, { type: 'pass' });
  manager.applyAction(code, otherToken, { type: 'play', cards: ['6C'] });

  const finishedView = manager.getRoomView(code, dealerToken);
  assert.equal(finishedView.hand.status, 'finished');
  assert.ok(finishedView.hand.results.length > 0);
  for (const player of finishedView.players) {
    assert.ok(Array.isArray(player.holeCards));
  }
});

test('干瞪眼房间走独立的持久化与列表', async () => {
  const app = createRealtimeApp({ store: new MemoryStore() });
  await new Promise((resolve) => app.server.listen(0, resolve));
  try {
    const created = app.gdyManager.createRoom({ token: 't1', playerName: '甲' });
    assert.equal(created.room.gameType, 'gdy');
    const port = app.server.address().port;
    const list = await fetch(`http://127.0.0.1:${port}/api/rooms`).then((res) => res.json());
    assert.ok(list.rooms.some((room) => room.code === created.room.code && room.gameType === 'gdy'));
    // 房间码三引擎互查
    assert.equal(app.manager.getRoom(created.room.code), null);
    assert.equal(app.zjhManager.getRoom(created.room.code), null);
    assert.ok(app.gdyManager.getRoom(created.room.code));
  } finally {
    await app.close();
  }
});
