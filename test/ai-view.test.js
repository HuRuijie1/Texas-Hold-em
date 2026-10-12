import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseBotAction } from '../src/bot-ai.js';
import { buildBotView } from '../src/ai/view.js';

function makeRoom(overrides = {}) {
  const deck = ['AS', 'KH', 'QD', 'JC', 'TS', '9H', '8D', '7C', '6S', '5H', '4D', '3C'];
  return {
    code: 'VIEW01',
    gameType: 'texas',
    buttonSeat: 1,
    config: { bigBlind: 10, smallBlind: 5, maxSeats: 6, startingStack: 1000 },
    hand: {
      id: 42,
      street: 'flop',
      board: ['2H', '7D', '9C'],
      pot: 240,
      currentBet: 80,
      lastFullBet: 80,
      minRaiseSize: 80,
      buttonSeat: 1,
      smallBlindSeat: 1,
      bigBlindSeat: 0,
      actionQueue: [0],
      callOnlySeats: [],
      playerStreetActions: { 1: { type: 'raise', amount: 80, timestamp: 1000 } },
      preflopAggrSeat: 1,
      // 故意带上这两个字段：AI 绝不能看到它们
      deck,
      deckIndex: 3,
    },
    players: [
      {
        token: 'hero-bot', seatIndex: 0, stack: 900, holeCards: ['AH', 'TH'],
        streetContribution: 20, handContribution: 60, inHand: true, folded: false,
        isBot: true, botLevel: 'advanced', actionCount: 2,
      },
      {
        token: 'villain', seatIndex: 1, stack: 800, holeCards: ['KS', 'QS'],
        streetContribution: 80, handContribution: 120, inHand: true, folded: false,
        isBot: false, actionCount: 3,
      },
    ],
    ...overrides,
  };
}

const ACTIONS = {
  toCall: 60, canCheck: false, canCall: true, canRaise: true,
  minRaiseTo: 160, maxRaiseTo: 920, isCallOnly: false,
};

test('视图不含整副牌与发牌游标', () => {
  const room = makeRoom();
  const player = room.players[0];
  const view = buildBotView(room, player, ACTIONS);

  assert.ok(!('deck' in view.hand), 'hand 中不应出现 deck');
  assert.ok(!('deckIndex' in view.hand), 'hand 中不应出现 deckIndex');
  assert.ok(!('sidePots' in view.hand), 'hand 中不应出现 sidePots');
  assert.ok(!('winners' in view.hand), 'hand 中不应出现 winners');
  assert.ok(!('shownCards' in view.hand), 'hand 中不应出现 shownCards');
  assert.ok(!('revealed' in view.hand), 'hand 中不应出现 revealed');
});

test('视图不含对手底牌与身份标识', () => {
  const room = makeRoom();
  const view = buildBotView(room, room.players[0], ACTIONS);

  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('KS'), '视图中泄漏了对手底牌 KS');
  assert.ok(!serialized.includes('QS'), '视图中泄漏了对手底牌 QS');
  assert.ok(!serialized.includes('villain'), '视图中泄漏了对手 token');

  assert.equal(view.opponents.length, 1);
  for (const opp of view.opponents) {
    assert.ok(!('holeCards' in opp), '对手条目不应含 holeCards');
    assert.ok(!('token' in opp), '对手条目不应含 token');
  }
});

test('视图保留 hero 自己的底牌与公开局面', () => {
  const room = makeRoom();
  const view = buildBotView(room, room.players[0], ACTIONS);

  assert.equal(view.hero.holeCards.length, 2, 'hero 应能看到自己的两张底牌');
  assert.equal(view.hand.board.length, 3, '公共牌应对 AI 可见');
  assert.equal(view.hand.pot, 240);
  assert.equal(view.opponents[0].stack, 800, '对手筹码是公开信息');
  assert.equal(view.opponents[0].streetContribution, 80, '对手本街投入是公开信息');
});

test('行为级防作弊：仅对手底牌不同，决策分布应保持一致', () => {
  const countsA = new Map();
  const countsB = new Map();

  for (let i = 1; i <= 200; i += 1) {
    const roomA = makeRoom();
    const roomB = makeRoom();
    // 只改动对手底牌：强牌 vs 垃圾牌
    roomB.players[1].holeCards = ['2C', '3D'];

    for (const [room, counts] of [[roomA, countsA], [roomB, countsB]]) {
      const player = structuredClone(room.players[0]);
      player.botNonce = i;
      const action = chooseBotAction(room, player, ACTIONS);
      const key = action.type === 'raise' ? `raise@${Math.round(action.amount / 100)}` : action.type;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const keys = new Set([...countsA.keys(), ...countsB.keys()]);
  let maxDiff = 0;
  for (const key of keys) {
    const a = (countsA.get(key) ?? 0) / 200;
    const b = (countsB.get(key) ?? 0) / 200;
    maxDiff = Math.max(maxDiff, Math.abs(a - b));
  }
  assert.ok(maxDiff < 0.1, `对手底牌影响了 AI 决策，最大频率差 ${maxDiff.toFixed(3)}`);
});

test('行为级防作弊：仅 deck 不同，决策分布应完全一致', () => {
  const countsA = new Map();
  const countsB = new Map();

  for (let i = 1; i <= 200; i += 1) {
    const roomA = makeRoom();
    const roomB = makeRoom();
    roomB.hand.deck = ['2S', '3S', '4S', '5S', '6S', '7S', '8S', '9S', 'TS', 'JS', 'QS', 'KS'];

    for (const [room, counts] of [[roomA, countsA], [roomB, countsB]]) {
      const player = structuredClone(room.players[0]);
      player.botNonce = i;
      const action = chooseBotAction(room, player, ACTIONS);
      const key = action.type === 'raise' ? `raise@${Math.round(action.amount / 100)}` : action.type;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const keys = new Set([...countsA.keys(), ...countsB.keys()]);
  let maxDiff = 0;
  for (const key of keys) {
    const a = (countsA.get(key) ?? 0) / 200;
    const b = (countsB.get(key) ?? 0) / 200;
    maxDiff = Math.max(maxDiff, Math.abs(a - b));
  }
  assert.equal(maxDiff, 0, `deck 内容影响了 AI 决策，最大频率差 ${maxDiff}`);
});

test('视图容忍残缺的 room（测试与重连场景会构造不完整对象）', () => {
  const partialRoom = {
    code: 'TEST01',
    config: { bigBlind: 10 },
    hand: {
      id: 7, street: 'flop', board: ['2H', '7D', '9H'],
      pot: 100, currentBet: 0, preflopAggrSeat: null, playerStreetActions: {},
    },
    buttonSeat: 0,
    players: [{ token: 'villain', inHand: true, folded: false, seatIndex: 1 }],
  };
  const player = {
    token: 'hero-bot-token', holeCards: ['AH', 'TH'], stack: 500,
    seatIndex: 0, streetContribution: 0, isBot: true, botLevel: 'beginner',
  };
  const actions = {
    toCall: 0, canCheck: true, canCall: false, canRaise: true,
    minRaiseTo: 20, maxRaiseTo: 500, isCallOnly: false,
  };

  const view = buildBotView(partialRoom, player, actions);
  assert.equal(view.hand.board.length, 3);
  assert.equal(view.hero.holeCards.length, 2);
  assert.equal(view.derived.liveOpponents, 1);
  assert.ok(view.derived.heroPosition.length > 0);
  assert.ok(Number.isFinite(view.derived.potOdds));
  assert.ok(Number.isFinite(view.derived.spr));
});

test('toCall 以引擎传入的 actions 为准，不从 room 反算', () => {
  // 构造一个 room 与 actions 故意不一致的局面（对应 bot-ai.test.js 的延迟用例）
  const room = makeRoom();
  room.hand.currentBet = 40;
  room.players[0].streetContribution = 40;
  const actions = { ...ACTIONS, toCall: 60, canCheck: false };
  const view = buildBotView(room, room.players[0], actions);

  assert.equal(view.actions.toCall, 60, 'toCall 应取 actions 传入值');
  assert.equal(view.derived.toCall, 60);
  assert.equal(view.actions.canCheck, false, 'canCheck 应取 actions 传入值');
});

test('推导量符合扑克几何：底池赔率、MDF、alpha', () => {
  const room = makeRoom();
  // pot=240，本街 hero 已投 20、对手已投 80 → 本街开始前底池 = 240-100 = 140
  // 对手下注 80 进 140 → MDF = 1 - 80/220 ≈ 0.636，alpha = 80/220 ≈ 0.364
  const view = buildBotView(room, room.players[0], ACTIONS);

  assert.equal(view.derived.potBeforeBet, 140, '本街开始前底池应为 140');
  assert.equal(view.derived.betFacing, 80, '面对的下注额应为 80');
  assert.ok(Math.abs(view.derived.mdf - (1 - 80 / 220)) < 1e-9, 'MDF 应为 1 - 80/220');
  assert.ok(Math.abs(view.derived.alpha - 80 / 220) < 1e-9, 'alpha 应为 80/220');
  assert.ok(Math.abs(view.derived.mdf + view.derived.alpha - 1) < 1e-9, 'MDF + alpha 应等于 1');

  // hero 需跟 60，跟注后总底池 300 → 底池赔率 = 60/300 = 0.2
  assert.ok(Math.abs(view.derived.potOdds - 0.2) < 1e-9, '底池赔率应为 0.2');
});

test('位置与身份识别', () => {
  const room = makeRoom();
  const view = buildBotView(room, room.players[0], ACTIONS);

  assert.equal(view.derived.heroIsBigBlind, true, 'hero 坐在大盲位');
  assert.equal(view.derived.aggressorSeat, 1, '进攻者应是对手');
  assert.equal(view.derived.facingRaise, true, 'hero 正面对加注');
  assert.equal(view.derived.wasPreRaiser, false, 'hero 不是翻前加注者');
  assert.equal(view.derived.isHeadsUp, true);
  assert.equal(view.derived.isMultiway, false);
  // 单挑且 hero 非庄位 → 不利位置
  assert.equal(view.derived.isInPosition, false);
});

test('已弃牌与未参与的玩家不计入存活对手', () => {
  const room = makeRoom();
  room.players.push(
    { token: 'folded', seatIndex: 2, stack: 500, inHand: true, folded: true, streetContribution: 10 },
    { token: 'waiting', seatIndex: 3, stack: 500, inHand: false, folded: false, streetContribution: 0 },
  );
  const view = buildBotView(room, room.players[0], ACTIONS);
  assert.equal(view.opponents.length, 1, '弃牌与未参与者不应计入');
  assert.ok(view.opponents.every((o) => o.seatIndex === 1));
});
