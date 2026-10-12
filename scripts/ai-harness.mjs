// ============================================================
// AI 模拟骨架（测试与测量台共用）
//
// 跑一桌全 bot 牌局需要的东西集中在这里：内存版房间存储、开桌、打一手牌、
// 动作合法性校验、行为指标聚合。
//
// 放在 scripts/ 而不是 test/ 是有意的：node --test 会把 test/ 目录下的每一个
// .js 都当成测试文件执行，共享骨架混进去会污染套件结果。
//
// 之所以要共用一份：MemoryStore / createTable / playHand 之前在 bot-ai.test.js
// 和 sim-ai-behavior.mjs 里各写了一遍，改一处漏一处。现在测试里断言的行为和
// 测量台里量出来的行为跑的是同一套模拟，不会出现"测试绿但实测跑偏"。
// ============================================================

import { GameManager } from '../src/game-engine.js';
import { chooseBotAction } from '../src/bot-ai.js';
import { TEXAS_LEVELS } from '../src/ai/levels.js';

export const BIG_BLIND = 10;
export const STARTING_STACK = 1000;

/** 内存版房间存储：只用来跑牌，不落盘 */
export class MemoryStore {
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

export function blankStats() {
  return {
    hands: 0,
    vpip: 0,
    pfr: 0,
    facedOpen: 0,
    threeBet: 0,
    cbetOpps: 0,
    cbet: 0,
    sawFlop: 0,
    showdown: 0,
    bets: 0,
    calls: 0,
    checks: 0,
    folds: 0,
    chips: 0,
    postflopSizes: [],
    actionCounts: new Map(),
  };
}

/**
 * 开一桌全 bot 的牌局。
 * createRoom 会自动把房主落到 0 号位，所以多留一个座位给它并让它观战。
 */
export function createTable(levelList, { bigBlind = BIG_BLIND, stack = STARTING_STACK } = {}) {
  const manager = new GameManager(new MemoryStore());
  const created = manager.createRoom({
    token: 'host',
    roomName: 'ai-test',
    playerName: 'Host',
    config: {
      maxSeats: levelList.length + 1,
      smallBlind: bigBlind / 2,
      bigBlind,
      startingStack: stack,
    },
  });
  const code = created.room.code;

  const host = manager.getRoom(code).players.find((player) => player.token === 'host');
  if (host) host.sitOut = true; // 房主只用于控制，不参与牌局

  for (const level of levelList) manager.addBot(code, 'host', level);

  const statsByToken = new Map();
  for (const player of manager.getRoom(code).players) {
    if (player.isBot) statsByToken.set(player.token, blankStats());
  }
  return { manager, code, statsByToken };
}

/**
 * 打一手牌，顺便把行为指标累计进 statsByToken。
 * 每手开局都把筹码重置回 stack，这样 chips 累计出来是干净的单手期望（bb/手）。
 */
export function playHand(manager, code, statsByToken, { stack = STARTING_STACK, onAction } = {}) {
  const before = manager.getRoom(code);
  for (const player of before.players) {
    if (!player.isBot) continue;
    player.stack = stack;
    player.totalBuyIn = stack;
  }

  manager.startHand(code, 'host');
  const room0 = manager.getRoom(code);
  if (!room0.hand || room0.hand.status !== 'running') return [];

  const log = [];
  let steps = 0;

  while (steps < 500) {
    steps += 1;
    const room = manager.getRoom(code);
    if (!room.hand || room.hand.status !== 'running') break;
    const seat = room.hand.actionQueue[0];
    if (seat == null) break;
    const player = room.players.find((entry) => entry.seatIndex === seat);
    if (!player || !player.isBot) break;

    const legal = manager.getRoomView(code, player.token).hand.availableActions;
    if (!legal) break;

    const street = room.hand.street;
    const raisesBefore = Object.values(room.hand.playerStreetActions ?? {})
      .filter((info) => info.type === 'raise' || info.type === 'allin').length;
    const pot = room.hand.pot;

    const startedAt = performance.now();
    const action = chooseBotAction(room, player, legal);
    const elapsedMs = performance.now() - startedAt;
    // 交给调用方在「动作还没进引擎」的这一刻校验合法性：
    // 一旦非法动作被 applyAction 吞掉，现场就没了，只能看到牌局卡死。
    if (onAction) onAction({ action, legal, player, room, street });
    log.push({
      token: player.token,
      street,
      type: action.type,
      amount: action.amount ?? 0,
      raisesBefore,
      pot,
      elapsedMs,
    });
    manager.applyAction(code, player.token, action);
  }

  recordHand(log, manager.getRoom(code), statsByToken, { stack });
  return log;
}

/** 把一手牌的流水折算成行为指标 */
function recordHand(log, end, statsByToken, { stack = STARTING_STACK } = {}) {
  const reachedFlop = (end.hand?.board?.length ?? 0) >= 3;
  const revealed = Boolean(end.hand?.revealed);

  // 翻前首个加注者：C-bet 的定义依赖它
  let firstPreflopRaiser = null;
  for (const entry of log) {
    if (entry.street === 'preflop' && (entry.type === 'raise' || entry.type === 'allin')) {
      firstPreflopRaiser = entry.token;
      break;
    }
  }

  for (const [token, stats] of statsByToken) {
    const mine = log.filter((entry) => entry.token === token);
    if (!mine.length) continue;
    const preflop = mine.filter((entry) => entry.street === 'preflop');
    stats.hands += 1;

    for (const entry of mine) {
      const key = entry.type === 'raise' || entry.type === 'allin' ? 'bet/raise' : entry.type;
      stats.actionCounts.set(key, (stats.actionCounts.get(key) ?? 0) + 1);
      if (entry.type === 'raise' || entry.type === 'allin') {
        stats.bets += 1;
        if (entry.street !== 'preflop' && entry.pot > 0) {
          stats.postflopSizes.push(entry.amount / entry.pot);
        }
      } else if (entry.type === 'call') stats.calls += 1;
      else if (entry.type === 'check') stats.checks += 1;
      else stats.folds += 1;
    }

    if (preflop.some((e) => e.type === 'call' || e.type === 'raise' || e.type === 'allin')) {
      stats.vpip += 1;
    }
    if (preflop.some((e) => e.type === 'raise' || e.type === 'allin')) stats.pfr += 1;

    // 3bet：本人在「已有加注」的局面下选择加注
    if (preflop.some((e) => e.raisesBefore >= 1)) {
      stats.facedOpen += 1;
      if (preflop.some((e) => (e.type === 'raise' || e.type === 'allin') && e.raisesBefore >= 1)) {
        stats.threeBet += 1;
      }
    }

    const foldedPreflop = preflop.some((e) => e.type === 'fold');
    if (reachedFlop && !foldedPreflop) stats.sawFlop += 1;

    const player = end.players.find((entry) => entry.token === token);
    if (revealed && player && !player.folded) stats.showdown += 1;
    stats.chips += (player?.stack ?? stack) - stack;

    // C-bet：翻前加注者在翻牌的第一个动作是不是开火
    if (reachedFlop && firstPreflopRaiser === token) {
      const flopActions = mine.filter((entry) => entry.street === 'flop');
      if (flopActions.length) {
        stats.cbetOpps += 1;
        if (flopActions[0].type === 'raise' || flopActions[0].type === 'allin') stats.cbet += 1;
      }
    }
  }
}

export function pct(value, total) {
  return total > 0 ? (value / total) * 100 : 0;
}

/** 把多个座位的 stats 合并成一份 */
export function aggregateStats(statsByToken) {
  const total = { ...blankStats(), actionCounts: new Map(), postflopSizes: [] };
  for (const stats of statsByToken.values()) {
    for (const key of Object.keys(total)) {
      if (key === 'actionCounts' || key === 'postflopSizes') continue;
      total[key] += stats[key];
    }
    for (const [key, value] of stats.actionCounts) {
      total.actionCounts.set(key, (total.actionCounts.get(key) ?? 0) + value);
    }
    total.postflopSizes.push(...stats.postflopSizes);
  }
  const aggressive = total.bets;
  const totalActions = aggressive + total.calls + total.checks + total.folds;
  return {
    vpip: pct(total.vpip, total.hands),
    pfr: pct(total.pfr, total.hands),
    threeBet: pct(total.threeBet, total.facedOpen),
    cbet: pct(total.cbet, total.cbetOpps),
    wtsd: pct(total.showdown, total.sawFlop),
    agg: pct(aggressive, totalActions),
    bbPerHand: total.chips / Math.max(1, total.hands) / BIG_BLIND,
    postflopSizes: total.postflopSizes,
    actionCounts: total.actionCounts,
    hands: total.hands,
    // 原始计数：百分比会把样本量差异藏起来，排查"这个指标是不是只有几十个样本"
    // 的时候必须看裸计数，否则容易对着噪声调参。
    raw: {
      hands: total.hands,
      vpip: total.vpip,
      pfr: total.pfr,
      facedOpen: total.facedOpen,
      threeBet: total.threeBet,
      cbet: total.cbet,
      cbetOpps: total.cbetOpps,
      sawFlop: total.sawFlop,
    },
  };
}

/**
 * 校验 bot 给出的动作是否合法。不合法就直接抛错，测试里当断言用。
 *
 * 这是最容易出问题也最值得死守的一条：AI 一旦吐出引擎不接受的动作，
 * 轻则该手卡死，重则整桌推进不下去。
 */
export function validateAction(action, legal) {
  if (!action || typeof action.type !== 'string') {
    throw new Error(`action must have a string type, got ${JSON.stringify(action)}`);
  }
  const { type } = action;
  if (!['fold', 'check', 'call', 'raise', 'allin'].includes(type)) {
    throw new Error(`unknown action type: ${type}`);
  }
  if (type === 'check' && !legal.canCheck) {
    throw new Error(`cannot check when toCall=${legal.toCall}`);
  }
  if (type === 'call' && !legal.canCall) {
    throw new Error(`cannot call when toCall=${legal.toCall} stack allows=${legal.canCall}`);
  }
  if (type === 'raise' || type === 'allin') {
    if (!legal.canRaise) throw new Error(`cannot raise: canRaise=false (callOnly=${legal.isCallOnly})`);
    if (legal.maxRaiseTo <= 0) throw new Error('cannot raise with no chips left');
    // allin 不需要 amount：引擎直接用「已投入 + 全部筹码」当额度
    if (type === 'allin') return true;
    const amount = action.amount;
    if (!Number.isFinite(amount)) throw new Error(`raise amount must be a finite number, got ${amount}`);
    if (amount < legal.minRaiseTo && amount !== legal.maxRaiseTo) {
      throw new Error(`raise to ${amount} is below minRaiseTo ${legal.minRaiseTo} and is not an all-in (${legal.maxRaiseTo})`);
    }
    if (amount > legal.maxRaiseTo) {
      throw new Error(`raise to ${amount} exceeds maxRaiseTo ${legal.maxRaiseTo}`);
    }
  }
  return true;
}

/** 跑一桌：levelList 每个座位一个档位 */
export function runTable(levelList, hands, options = {}) {
  const { manager, code, statsByToken } = createTable(levelList, options);
  for (let i = 0; i < hands; i += 1) playHand(manager, code, statsByToken, options);
  return { manager, code, statsByToken };
}

/**
 * 混合桌盈利：各档各占一个座位，并轮转 N 次让每档在每个座位都打同样多手。
 *
 * 不轮转的话会混进位置偏差 —— 永远坐 BTN 的档位白捡一个位置优势，
 * 测出来的"强弱"有一半是座位好。
 *
 * 注意这里衡量的是「谁最能从弱手身上榨钱」，不等于「谁最难被打败」：
 * 剥削性打法（松凶）在有鱼的局里天然比平衡的 GTO 赚得多。
 */
export function runMixedTable(hands, options = {}) {
  const rounds = TEXAS_LEVELS.length;
  const total = new Map(TEXAS_LEVELS.map((level) => [level, { chips: 0, hands: 0 }]));

  for (let round = 0; round < rounds; round += 1) {
    const levelList = TEXAS_LEVELS.map((_, i) => TEXAS_LEVELS[(i + round) % rounds]);
    const { manager, code, statsByToken } = createTable(levelList, options);
    for (let i = 0; i < hands; i += 1) playHand(manager, code, statsByToken, options);

    const tokenToLevel = new Map();
    for (const player of manager.getRoom(code).players) {
      if (player.isBot) tokenToLevel.set(player.token, player.botLevel);
    }
    for (const [token, stats] of statsByToken) {
      const bucket = total.get(tokenToLevel.get(token));
      if (!bucket) continue;
      bucket.chips += stats.chips;
      bucket.hands += stats.hands;
    }
  }

  return new Map([...total].map(([level, bucket]) => [
    level,
    bucket.chips / Math.max(1, bucket.hands) / BIG_BLIND,
  ]));
}
