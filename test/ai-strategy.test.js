// ============================================================
// 策略层测试
//
// 这里守的是「牌局一定能推进下去」这条底线，以及各档打法的结构性差异。
//
// 最核心的是动作合法性矩阵：AI 吐出的每一个动作，在交给引擎之前都要拿着
// 当时的 availableActions 验一遍。这条最容易出问题也最致命 —— 一个越界的加注
// 额度会让整手牌卡死，而且现场一旦被 applyAction 吞掉就再也查不到了。
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { TEXAS_LEVELS, getProfile, texasLevelLabel } from '../src/ai/levels.js';
import { chooseBotAction, sanitizeAction } from '../src/bot-ai.js';
import {
  BIG_BLIND, STARTING_STACK, createTable, playHand, runTable, validateAction,
} from '../scripts/ai-harness.mjs';

const sixOf = (level) => Array.from({ length: 6 }, () => level);

test('every level emits only legal actions on every street', () => {
  const streetsSeen = new Map();
  const typesSeen = new Map();

  for (const level of TEXAS_LEVELS) {
    const streets = new Set();
    const types = new Set();
    streetsSeen.set(level, streets);
    typesSeen.set(level, types);

    runTable(sixOf(level), 120, {
      onAction: ({ action, legal, street }) => {
        // 非法动作会在这里直接抛错，测试随即失败
        validateAction(action, legal);
        streets.add(street);
        types.add(action.type);
      },
    });
  }

  for (const level of TEXAS_LEVELS) {
    const label = texasLevelLabel(level);
    const streets = streetsSeen.get(level);
    for (const street of ['preflop', 'flop', 'turn', 'river']) {
      assert.ok(streets.has(street), `${label} 在 120 手内没打到 ${street}，覆盖不足`);
    }
    const types = typesSeen.get(level);
    for (const type of ['fold', 'check', 'call', 'raise']) {
      assert.ok(types.has(type), `${label} 在 120 手内没有出现过 ${type}`);
    }
  }
});

test('actions stay legal across shallow, mid and deep stacks', () => {
  const depths = [
    ['短码 15BB', BIG_BLIND * 15],
    ['中码 60BB', BIG_BLIND * 60],
    ['深码 300BB', STARTING_STACK * 3],
  ];
  for (const [label, stack] of depths) {
    for (const level of TEXAS_LEVELS) {
      runTable(sixOf(level), 40, {
        stack,
        onAction: ({ action, legal }) => {
          assert.doesNotThrow(
            () => validateAction(action, legal),
            `${label} / ${texasLevelLabel(level)} 给出了非法动作`,
          );
        },
      });
    }
  }
});

test('a full 9-seat table of 8 bots finishes every hand', () => {
  const levels = Array.from({ length: 8 }, (_, i) => TEXAS_LEVELS[i % TEXAS_LEVELS.length]);
  const { manager, code, statsByToken } = createTable(levels);
  let stuck = 0;

  for (let i = 0; i < 50; i += 1) {
    playHand(manager, code, statsByToken, {
      onAction: ({ action, legal }) => validateAction(action, legal),
    });
    if (manager.getRoom(code).hand?.status === 'running') stuck += 1;
  }

  assert.equal(stuck, 0, `有 ${stuck} 手牌没能推进到终局`);
  // 八个座位都参与过，说明没有谁被永久跳过
  assert.equal(statsByToken.size, 8);
  for (const [token, stats] of statsByToken) {
    assert.ok(stats.hands > 0, `${token} 一手牌都没打到`);
  }
});

test('short stacks shove or fold instead of trapping around', () => {
  // 有效筹码 6BB：这时候再小额加注就是纯粹的浪费，正确打法只有推或弃
  const perLevel = new Map(TEXAS_LEVELS.map((level) => [level, { allin: 0, raise: 0 }]));

  for (const level of TEXAS_LEVELS) {
    runTable(sixOf(level), 150, {
      stack: BIG_BLIND * 6,
      onAction: ({ action, legal, player, street }) => {
        if (street !== 'preflop') return;
        if (action.type !== 'raise' && action.type !== 'allin') return;
        const bucket = perLevel.get(player.botLevel);
        if (!bucket) return;
        // 全下有两种写法：显式 type='allin'（引擎自行用全部筹码），
        // 或者 type='raise' 且额度顶到该筹码能推的上限。两种都要算全下。
        if (action.type === 'allin' || action.amount >= legal.maxRaiseTo) bucket.allin += 1;
        else bucket.raise += 1;
      },
    });
  }

  for (const level of TEXAS_LEVELS) {
    const { allin, raise } = perLevel.get(level);
    const label = texasLevelLabel(level);
    // 新手鱼不认识 push/fold 表（abilities.pushFold=false），短码下会继续小额加注，
    // 这正是它「不会打短码」的设定，不该被当成 bug。
    if (!getProfile(level).abilities.pushFold) {
      assert.ok(allin + raise > 0, `${label} 在 6BB 短码下完全不加注`);
      continue;
    }
    assert.ok(allin > 0, `${label} 在 6BB 短码下从来没有全下过`);
    assert.ok(
      allin > raise,
      `${label} 在 6BB 短码下小额加注(${raise})多于全下(${allin})，说明没用 push/fold 表`,
    );
  }
});

test('the big blind defends more loosely the weaker the level is', () => {
  const perLevel = new Map(TEXAS_LEVELS.map((level) => [level, { faced: 0, defended: 0 }]));

  for (const level of TEXAS_LEVELS) {
    runTable(sixOf(level), 200, {
      onAction: ({ action, legal, player, room }) => {
        if (room.hand?.street !== 'preflop') return;
        if (room.hand.bigBlindSeat !== player.seatIndex) return;
        if (legal.toCall <= 0) return; // 无人加注，大盲可以直接过牌
        const bucket = perLevel.get(player.botLevel);
        if (!bucket) return;
        bucket.faced += 1;
        if (action.type !== 'fold') bucket.defended += 1;
      },
    });
  }

  const rate = (level) => {
    const { faced, defended } = perLevel.get(level);
    return faced > 0 ? defended / faced : 0;
  };

  for (const level of TEXAS_LEVELS) {
    const { faced } = perLevel.get(level);
    assert.ok(faced > 20, `${texasLevelLabel(level)} 的大盲样本只有 ${faced}，不足以判断`);
  }
  // 新手鱼会拿着任意两张牌守大盲；GTO 懂得该弃就弃
  assert.ok(
    rate('fish') > rate('gto') + 0.15,
    `新手鱼的大盲防守率(${rate('fish').toFixed(2)}) 应明显高于 GTO大师(${rate('gto').toFixed(2)})`,
  );
  assert.ok(rate('gto') > 0.2, `GTO大师 也不能把大盲拱手让人，实际 ${rate('gto').toFixed(2)}`);
});

test('sanitizeAction always falls back to something the engine accepts', () => {
  const legal = {
    toCall: 40, canCheck: false, canCall: true, canRaise: false,
    minRaiseTo: 0, maxRaiseTo: 0, isCallOnly: true,
  };
  // 想加注但不能加注 → 退回跟注
  assert.equal(sanitizeAction({ type: 'raise', amount: 999 }, legal).type, 'call');

  const checkOnly = {
    toCall: 0, canCheck: true, canCall: false, canRaise: false,
    minRaiseTo: 0, maxRaiseTo: 0, isCallOnly: false,
  };
  assert.equal(sanitizeAction({ type: 'raise', amount: 999 }, checkOnly).type, 'check');

  // 可以加注时，额度要被夹进 [minRaiseTo, maxRaiseTo]
  const raisable = {
    toCall: 10, canCheck: false, canCall: true, canRaise: true,
    minRaiseTo: 20, maxRaiseTo: 100, isCallOnly: false,
  };
  assert.equal(sanitizeAction({ type: 'raise', amount: 50 }, raisable).amount, 50);
  assert.equal(sanitizeAction({ type: 'raise', amount: 5 }, raisable).amount, 20);
  // 顶到上限就是全下，不能假装还能再加
  assert.equal(sanitizeAction({ type: 'raise', amount: 999 }, raisable).type, 'allin');
  assert.equal(
    sanitizeAction({ type: 'raise', amount: 40 }, { ...raisable, minRaiseTo: 40, maxRaiseTo: 40 }).type,
    'allin',
  );
  // 什么都没有 → 至少能弃牌，绝不会返回 null 让调用方崩掉
  assert.equal(sanitizeAction({ type: 'raise', amount: 999 }, {
    toCall: 10, canCheck: false, canCall: false, canRaise: false,
    minRaiseTo: 0, maxRaiseTo: 0, isCallOnly: true,
  }).type, 'fold');
  // 未知类型/空动作一律收敛到最保守的弃牌，绝不返回 null 让调用方崩掉
  assert.equal(sanitizeAction(null, legal).type, 'fold');
  assert.equal(sanitizeAction({ type: 'nonsense' }, legal).type, 'fold');
});

test('chooseBotAction never throws on a hand with malformed hole cards', () => {
  const levels = Array.from({ length: 6 }, (_, i) => TEXAS_LEVELS[i % TEXAS_LEVELS.length]);
  const { manager, code, statsByToken } = createTable(levels);
  playHand(manager, code, statsByToken);

  const room = manager.getRoom(code);
  const bot = room.players.find((player) => player.isBot);
  // 底牌被污染成非法值，AI 必须照常给出一个合法动作，而不是抛异常拖垮整手牌
  const saved = bot.holeCards;
  bot.holeCards = [999, -1];
  try {
    manager.startHand(code, 'host');
    const fresh = manager.getRoom(code);
    if (fresh.hand?.status === 'running') {
      const seat = fresh.hand.actionQueue[0];
      const actor = fresh.players.find((player) => player.seatIndex === seat);
      if (actor?.isBot) {
        const legal = manager.getRoomView(code, actor.token).hand.availableActions;
        if (legal) {
          const action = chooseBotAction(fresh, actor, legal);
          assert.ok(action && typeof action.type === 'string', 'AI 应当返回带 type 的动作');
        }
      }
    }
  } finally {
    bot.holeCards = saved;
  }
});
