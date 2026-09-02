import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeBoard, chooseBotAction, decideBotTurn, derivePersona, detectDraws } from '../src/bot-ai.js';
import { GameManager } from '../src/game-engine.js';

class MemoryStore {
  constructor() {
    this.rooms = new Map();
  }
  saveRoom(room) {
    this.rooms.set(room.code, structuredClone(room));
  }
  loadRoom() {
    return null;
  }
  listRooms() {
    return [];
  }
  deleteRoom(code) {
    this.rooms.delete(code);
  }
  cleanOldRooms() {}
  saveHandHistory() {}
  listHandHistory() {
    return [];
  }
}

test('persona is stable per token and varies across tokens', () => {
  const a1 = derivePersona('bot-token-a');
  const a2 = derivePersona('bot-token-a');
  assert.deepEqual(a1, a2);

  const distinct = new Set();
  for (let i = 0; i < 12; i += 1) {
    const persona = derivePersona(`token-${i}`);
    distinct.add(JSON.stringify(persona));
  }
  assert.ok(distinct.size > 6, `expected varied personas, got ${distinct.size}`);
});

test('detectDraws finds flush draws and straight draws', () => {
  const flush = detectDraws(['AH', 'TH'], ['2H', '7D', '9H']);
  assert.equal(flush.flushDraw, true);

  const oesd = detectDraws(['8D', '9D'], ['6C', '7H', 'KD']);
  assert.equal(oesd.straightDraw, 2);
  assert.equal(oesd.flushDraw, false);

  const none = detectDraws(['2C', '3D'], ['2H', '7D', 'KC']);
  assert.equal(none.flushDraw, false);
});

test('analyzeBoard scores texture', () => {
  const dry = analyzeBoard(['2S', '7D', 'KC']);
  const wet = analyzeBoard(['9H', 'TH', 'JH']);
  assert.ok(wet.wet > dry.wet);
  assert.equal(dry.monotone, false);
  assert.equal(analyzeBoard(['4H', '9H', 'QH']).monotone, true);
  assert.equal(analyzeBoard(['4H', '4D', 'QS']).paired, true);
});

function createBotTable(manager, levels) {
  const created = manager.createRoom({
    token: 'host',
    roomName: 'AI Test',
    playerName: 'Host',
    config: { maxSeats: 6, smallBlind: 5, bigBlind: 10, startingStack: 800 },
  });
  const code = created.room.code;
  manager.seatPlayer(code, 'host', 0);
  levels.forEach((level, index) => {
    manager.addBot(code, 'host', level);
    const room = manager.getRoom(code);
    const bot = room.players.filter((p) => p.isBot).at(-1);
    manager.seatPlayer(code, bot.token, index + 1);
  });
  return code;
}

function validateAction(action, actions) {
  assert.ok(action && typeof action.type === 'string', '动作缺失');
  switch (action.type) {
    case 'fold':
      break;
    case 'check':
      assert.ok(actions.canCheck, '不能过牌时给出了 check');
      break;
    case 'call':
      assert.ok(actions.canCall || actions.canCheck, '无法跟注时给出了 call');
      break;
    case 'allin':
      assert.ok(actions.canRaise || actions.canCall, '全下条件不成立');
      break;
    case 'raise':
      assert.ok(actions.canRaise, '不能加注时给出了 raise');
      assert.ok(Number.isInteger(action.amount), `加注额不是整数: ${action.amount}`);
      assert.ok(
        action.amount >= actions.minRaiseTo && action.amount <= actions.maxRaiseTo,
        `加注额越界: ${action.amount} not in [${actions.minRaiseTo}, ${actions.maxRaiseTo}]`,
      );
      break;
    default:
      assert.fail(`未知动作类型 ${action.type}`);
  }
}

function playBotHandsToCompletion(manager, code, maxSteps = 400) {
  let steps = 0;
  while (steps < maxSteps) {
    steps += 1;
    const room = manager.getRoom(code);
    if (!room.hand || room.hand.status !== 'running') return true;
    const seat = room.hand.actionQueue[0];
    if (seat == null) continue;
    const player = room.players.find((entry) => entry.seatIndex === seat);
    if (!player) continue;

    if (!player.isBot) {
      manager.applyAction(code, player.token, { type: 'fold' });
      continue;
    }

    const view = manager.getRoomView(code, player.token);
    const actions = view.hand.availableActions;
    assert.ok(actions, '轮到 bot 时必须提供可用动作');
    const action = chooseBotAction(room, player, actions);
    validateAction(action, actions);
    manager.applyAction(code, player.token, action);
  }
  return false;
}

test('bots only emit legal actions and hands always terminate', () => {
  const levelSets = [
    ['beginner'],
    ['intermediate', 'advanced'],
    ['advanced', 'intermediate'],
    ['beginner', 'advanced', 'intermediate'],
  ];
  for (const levels of levelSets) {
    const store = new MemoryStore();
    const manager = new GameManager(store);
    const code = createBotTable(manager, levels);
    manager.startHand(code, 'host');
    const finished = playBotHandsToCompletion(manager, code);
    assert.equal(finished, true, `hand did not terminate (levels=${levels.join(',')})`);
    assert.equal(manager.getRoom(code).hand.status, 'finished');
  }
});

test('identical states no longer force identical decisions', () => {
  const baseRoom = {
    code: 'TEST01',
    config: { bigBlind: 10 },
    hand: {
      id: 7,
      street: 'flop',
      board: ['2H', '7D', '9H'],
      pot: 100,
      currentBet: 0,
      preflopAggrSeat: null,
      playerStreetActions: {},
    },
    buttonSeat: 0,
    players: [
      { token: 'villain', inHand: true, folded: false, seatIndex: 1 },
    ],
  };
  const basePlayer = {
    token: 'hero-bot-token',
    holeCards: ['AH', 'TH'],
    stack: 500,
    seatIndex: 0,
    streetContribution: 0,
    actionCount: 3,
    isBot: true,
    botLevel: 'beginner',
    botCreatedAt: 1700000000000,
  };

  // 模拟真实生命周期：bot 存活期间决策序号单调递增，
  // 即使局面完全相同也应产生不同的行动路线。
  const outcomes = new Set();
  for (let i = 1; i <= 60; i += 1) {
    const room = structuredClone(baseRoom);
    const player = structuredClone(basePlayer);
    player.botNonce = i;
    const actions = {
      toCall: 0,
      canCheck: true,
      canCall: false,
      canRaise: true,
      minRaiseTo: 20,
      maxRaiseTo: 500,
      isCallOnly: false,
    };
    const action = chooseBotAction(room, player, actions);
    outcomes.add(action.type === 'raise' ? `raise@${Math.round(action.amount / 50)}` : action.type);
  }
  assert.ok(outcomes.size >= 2, `60 次同局面只出现一种决策: ${[...outcomes].join(',')}`);
});

test('decideBotTurn returns humanized delays within bounds', () => {
  const room = {
    code: 'TEST02',
    config: { bigBlind: 10 },
    hand: {
      id: 3,
      street: 'turn',
      board: ['2H', '7D', '9C', 'KS'],
      pot: 200,
      currentBet: 40,
      preflopAggrSeat: 1,
      playerStreetActions: {},
    },
    buttonSeat: 0,
    players: [{ token: 'villain-2', inHand: true, folded: false, seatIndex: 1 }],
  };
  const player = {
    token: 'delay-bot',
    holeCards: ['QH', 'JH'],
    stack: 600,
    seatIndex: 0,
    streetContribution: 40,
    actionCount: 5,
    isBot: true,
    botLevel: 'advanced',
    botCreatedAt: 1700000000000,
    botNonce: 0,
  };
  const actions = {
    toCall: 40,
    canCheck: false,
    canCall: true,
    canRaise: true,
    minRaiseTo: 80,
    maxRaiseTo: 640,
    isCallOnly: false,
  };
  for (let i = 0; i < 20; i += 1) {
    player.botNonce = i;
    const decision = decideBotTurn(room, player, actions);
    validateAction(decision.action, actions);
    assert.ok(decision.delayMs >= 250 && decision.delayMs <= 4500, `延迟越界: ${decision.delayMs}`);
  }
});
