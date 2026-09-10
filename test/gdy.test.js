import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GDY_PLAY_TYPE,
  createGdyDeck,
  describeGdyPlay,
  evaluateGdyPlay,
  formatGdyCards,
  gdyBeats,
  gdyCanBeatHand,
} from '../src/gdy.js';
import { GdyManager, GDY_DEFAULT_CONFIG } from '../src/gdy-engine.js';
import { createRealtimeApp } from '../src/realtime-app.js';
import { decideGdyBotTurn, enumerateGdyPlays } from '../src/gdy-bot.js';

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

// ===== 吃牌判定（吃不起 3 秒自动过） =====

test('吃牌判定：顺移一号 / 2 通吃 / 炸弹 / 癞子组合', () => {
  const play = (cards) => evaluateGdyPlay(cards);
  const beat = (hand, last) => gdyCanBeatHand(hand, evaluateGdyPlay(last));

  // 单张：10 只能被 J 或 2 接
  assert.ok(beat(['JH'], ['TH']));
  assert.ok(!beat(['QH', 'KH'], ['TH']));
  assert.ok(beat(['2H'], ['TH']));
  assert.ok(!beat(['AH'], ['2H']));           // 2 之上只有炸弹
  assert.ok(!beat(['RJ', 'BJ'], ['TH']));      // 纯癞子接不了单张

  // 单张接不了但有炸弹
  assert.ok(beat(['3H', '3S', '3D'], ['2H']));
  assert.ok(beat(['5H', 'RJ', 'BJ'], ['TH'])); // 双癞+真牌 = 炸弹

  // 对子：顺移、对 2 通吃、癞子补半对
  assert.ok(beat(['9H', '9S'], ['8H', '8S']));
  assert.ok(beat(['9H', 'RJ'], ['8H', '8S']));
  assert.ok(!beat(['JH', 'JS'], ['8H', '8S']));
  assert.ok(beat(['2H', '2S'], ['AH', 'AS']));
  assert.ok(!beat(['RJ', 'BJ'], ['8H', '8S']));

  // 顺子：567 只能被 678 接（癞子可补缺）
  assert.ok(beat(['6H', '7S', '8D'], ['5H', '6S', '7D']));
  assert.ok(beat(['6H', '7S', 'RJ'], ['5H', '6S', '7D']));
  assert.ok(!beat(['8H', '9S', 'TD'], ['5H', '6S', '7D']));
  assert.ok(beat(['QH', 'KS', 'AD'], ['JH', 'QS', 'KD']));   // QKA 顺移接 JQK
  assert.ok(!beat(['JH', 'QS', 'KD'], ['QH', 'KS', 'AD']));  // 最大顺只能被炸弹接
  assert.ok(beat(['5H', '5S', '5D'], ['QH', 'KS', 'AD']));   // 炸弹可以接最大顺

  // 炸弹对炸弹：先比张数再比点数，同点真牌压制
  assert.ok(beat(['7H', '7S', '7D'], ['5H', '5S', '5D']));
  assert.ok(!beat(['3H', '3S', '3D'], ['5H', '5S', '5D']));
  assert.ok(!beat(['5H', '5S', '5D'], ['5H', '5S', '5D']));
  assert.ok(!beat(['5H', '5S', 'RJ'], ['5H', '5S', '5D']));
  assert.ok(beat(['5H', '5S', '5D'], ['5H', '5S', 'RJ']));  // 真三张压含癞三张
  assert.ok(beat(['5H', '5S', '5D', '5C'], ['9H', '9S', '9D'])); // 四张炸接三张炸
  assert.ok(!beat(['5H', '5S', '5D', 'RJ'], ['5H', '5S', '5D', '5C']));
});

// ===== 机器人 =====

test('枚举手牌组合：全部组合合法且包含预期牌型', () => {
  const plays = enumerateGdyPlays(['3H', '3S', '4D', '5C', 'RJ']);
  for (const entry of plays) {
    assert.ok(evaluateGdyPlay(entry.cards), `组合应合法: ${entry.cards}`);
  }
  // 含：单张、对3、对4、对5、顺子345、癞子顺345/456、炸弹333 等
  const has = (predicate) => plays.some(predicate);
  assert.ok(has((entry) => entry.play.type === GDY_PLAY_TYPE.BOMB && entry.play.rank === 3));
  assert.ok(has((entry) => entry.play.type === GDY_PLAY_TYPE.STRAIGHT && entry.play.rank === 5));
  assert.ok(has((entry) => entry.play.type === GDY_PLAY_TYPE.STRAIGHT && entry.play.rank === 6));
  assert.ok(has((entry) => entry.play.type === GDY_PLAY_TYPE.PAIR && entry.play.rank === 5));
});

test('机器人决策：能赢直接出完、接牌出最小的、接不上过牌', () => {
  const mkRoom = (lastPlay) => ({ hand: { lastPlay } });

  // 自由出牌：剩两张 4,5 → 单张 4（点数最小优先，非炸弹）
  const free = decideGdyBotTurn(mkRoom(null), { holeCards: ['4H', '5S'] });
  assert.equal(free.action.type, 'play');
  assert.deepEqual(free.action.cards, ['4H']);

  // 自由出牌：整手一副顺子 → 直接出完获胜
  const win = decideGdyBotTurn(mkRoom(null), { holeCards: ['3H', '4S', '5D'] });
  assert.equal(win.action.cards.length, 3);

  // 跟牌单张 5：手里 6 / 9 → 出 6（最小）
  const beat = decideGdyBotTurn(mkRoom({ seatIndex: 0, play: evaluateGdyPlay(['5H']), cards: ['5H'] }), { holeCards: ['6H', '9S'] });
  assert.deepEqual(beat.action.cards, ['6H']);

  // 跟牌接不上 → 过
  const pass = decideGdyBotTurn(mkRoom({ seatIndex: 0, play: evaluateGdyPlay(['2H']), cards: ['2H'] }), { holeCards: ['3H', '4S'] });
  assert.equal(pass.action.type, 'pass');

  // 回归：只剩一张接不上的牌时，"一次出完"捷径不得绕过压牌校验（曾导致机器人死循环卡局）
  const lastCard = decideGdyBotTurn(mkRoom({ seatIndex: 0, play: evaluateGdyPlay(['2H']), cards: ['2H'] }), { holeCards: ['KD'] });
  assert.equal(lastCard.action.type, 'pass');

  // 跟牌单张只有炸弹能接 → 出炸弹
  const bomb = decideGdyBotTurn(mkRoom({ seatIndex: 0, play: evaluateGdyPlay(['2H']), cards: ['2H'] }), { holeCards: ['7H', '7S', '7D'] });
  assert.equal(bomb.action.type, 'play');
  assert.equal(bomb.action.cards.length, 3);
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

test('机器人：添加后自动准备、开局并在轮到时自动行动', () => {
  const store = new MemoryStore();
  const manager = new GdyManager(store, { config: { ...GDY_DEFAULT_CONFIG, actionTimeoutMs: 30000 } });
  const created = manager.createRoom({ token: 't1', playerName: '甲' });
  const code = created.room.code;
  manager.addBot(code, 't1', 'beginner');
  const room = manager.getRoom(code);
  const bot = room.players.find((player) => player.isBot);
  assert.ok(bot);
  assert.equal(bot.seatIndex, 1);

  // 固定庄家为机器人（首局默认随机，避免测试随机轮到真人）
  room.dealerSeat = 1;

  // 只有 1 名真人 → 无需准备直接开局
  manager.startHand(code, 't1');
  assert.equal(room.hand.status, 'running');
  // 机器人手牌 5 或 6 张（庄家随机）
  assert.ok(bot.holeCards.length === 5 || bot.holeCards.length === 6);

  // 机器人应在思考延迟（≤1.6 秒）内行动，而不是卡满整个超时时限
  let acted = room.hand.lastPlay !== null || room.hand.status === 'finished';
  for (let i = 1; i <= 4 && !acted; i += 1) {
    manager.tick(Date.now() + i * 1000);
    acted = room.hand.playerStreetActions[bot.seatIndex] != null || room.hand.status === 'finished';
  }
  assert.ok(acted, '机器人应在 ~2 秒内自动行动');
  assert.ok(room.hand.playerStreetActions[bot.seatIndex] != null);

  // 对局进行中不能移除机器人；空房间可以
  assert.throws(() => manager.removeBot(code, 't1', bot.token), /对局进行中/);
  const created2 = manager.createRoom({ token: 't1', playerName: '甲' });
  manager.addBot(created2.room.code, 't1', 'beginner');
  const bot2 = manager.getRoom(created2.room.code).players.find((player) => player.isBot);
  manager.removeBot(created2.room.code, 't1', bot2.token);
  assert.ok(!manager.getRoom(created2.room.code).players.some((player) => player.isBot));
});

test('吃不起：3 秒快速截止并自动过牌', () => {
  const { manager, code } = makeRoom({ actionTimeoutMs: 30000 });
  manager.toggleReady(code, 't1');
  manager.toggleReady(code, 't2');
  const room = manager.getRoom(code);
  const dealerSeat = room.hand.dealerSeat;
  const otherSeat = dealerSeat === 0 ? 1 : 0;
  room.hand.deck = [];
  room.hand.deckIndex = 0;
  playerBySeat(room, dealerSeat).holeCards = ['2H', '3H', '3S', '3D', 'KH', 'KH'];
  playerBySeat(room, otherSeat).holeCards = ['7H', '8S', '9D', 'TC', 'JH'];

  const dealer = dealerSeat === 0 ? 't1' : 't2';
  const other = dealerSeat === 0 ? 't2' : 't1';

  // 庄家出单张 2，对家没有炸弹、没有比 2 大的单张 → 吃不起
  manager.applyAction(code, dealer, { type: 'play', cards: ['2H'] });
  const before = Date.now();
  assert.ok(room.hand.turnDeadlineAt <= before + 3100, '吃不起时限应为 3 秒左右');
  assert.ok(room.hand.turnDeadlineAt >= before + 2500);

  // 视图字段：canBeat=false + timeoutMs=3000，前端倒计时条按 3 秒展示
  const view = manager.getRoomView(code, other);
  assert.equal(view.hand.availableActions.canBeat, false);
  assert.equal(view.hand.availableActions.timeoutMs, 3000);

  // 截止后 tick 自动过牌
  manager.tick(before + 4000);
  assert.equal(room.hand.lastPlay, null);
  assert.equal(room.hand.turnSeat, dealerSeat);
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
