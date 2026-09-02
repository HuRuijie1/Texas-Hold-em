import { createHash } from 'node:crypto';
import {
  bestHandOfSeven,
  compareHandRanks,
  createDeck,
  cardSuit,
  rankValue,
} from './poker.js';

export const BOT_LEVELS = ['beginner', 'intermediate', 'advanced'];

export const BOT_LEVEL_LABELS = {
  beginner: '初级',
  intermediate: '中级',
  advanced: '高级',
};

// 基础思考区间（毫秒）：实际延迟还会按"决策难度"拉伸
const BOT_THINK_DELAY = {
  beginner: [900, 2200],
  intermediate: [600, 1600],
  advanced: [350, 1100],
};

const POLICY = {
  beginner: {
    fold: 0.42,
    call: 0.5,
    raise: 0.78,
    bluff: 0.05,
    pressureFold: 0.26,
    pressureCall: 0.2,
  },
  intermediate: {
    fold: 0.36,
    call: 0.46,
    raise: 0.72,
    bluff: 0.08,
    pressureFold: 0.3,
    pressureCall: 0.25,
  },
  advanced: {
    fold: 0.31,
    call: 0.42,
    raise: 0.66,
    bluff: 0.12,
    pressureFold: 0.34,
    pressureCall: 0.29,
  },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function seedString(parts) {
  return parts.map((part) => String(part ?? '')).join('|');
}

function seededRandom(...parts) {
  let counter = 0;
  return () => {
    const hash = createHash('sha256')
      .update(`${seedString(parts)}|${counter}`)
      .digest();
    counter += 1;
    return hash.readUInt32BE(0) / 0xffffffff;
  };
}

function seededShuffle(values, rng) {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

export function normalizeBotLevel(level) {
  const value = String(level ?? '').trim().toLowerCase();
  if (BOT_LEVELS.includes(value)) return value;
  if (['初级', 'low', 'beginner'].includes(value)) return 'beginner';
  if (['中级', 'mid', 'intermediate'].includes(value)) return 'intermediate';
  if (['高级', 'high', 'advanced'].includes(value)) return 'advanced';
  return 'beginner';
}

export function botLevelLabel(level) {
  return BOT_LEVEL_LABELS[normalizeBotLevel(level)] ?? BOT_LEVEL_LABELS.beginner;
}

// 兼容保留：固定随机区间的思考时长
export function botThinkDelayMs(level, rng = Math.random) {
  const key = normalizeBotLevel(level);
  const [min, max] = BOT_THINK_DELAY[key] ?? BOT_THINK_DELAY.beginner;
  return Math.round(min + (max - min) * rng());
}

// ============================================================
// 人格系统：每个 bot 由 token 派生稳定特质，全程一致
// ============================================================
const personaCache = new Map();

export function derivePersona(token) {
  const key = String(token ?? '');
  if (personaCache.has(key)) return personaCache.get(key);
  const rng = seededRandom('persona-v1', key);
  const persona = {
    // 激进倾向：影响加注概率与加注尺度
    aggression: 0.85 + rng() * 0.3, // 0.85 ~ 1.15
    // 诈唬频率倍率
    bluff: 0.6 + rng() * 0.8, // 0.6 ~ 1.4
    // 松紧偏移：负值更紧（弃牌阈值上调），正值更松
    tightness: (rng() - 0.5) * 0.06,
    // 慢打倾向：强牌挖坑的概率基础
    trap: rng() * 0.35, // 0 ~ 35%
    // 持续下注（C-bet）频率倍率
    cbarrel: 0.75 + rng() * 0.45,
  };
  personaCache.set(key, persona);
  return persona;
}

// ============================================================
// 牌面纹理与听牌
// ============================================================
export function analyzeBoard(board) {
  if (!board?.length) return { wet: 0, paired: false, monotone: false, connected: false, highCard: 0 };
  const ranks = board.map(rankValue).sort((a, b) => b - a);
  const suits = board.map(cardSuit);
  const suitCounts = {};
  for (const suit of suits) suitCounts[suit] = (suitCounts[suit] ?? 0) + 1;
  const maxSuit = Math.max(0, ...Object.values(suitCounts));
  const paired = new Set(ranks).size < ranks.length;

  const uniq = [...new Set(ranks)].sort((a, b) => a - b);
  let connected = false;
  for (let i = 2; i < uniq.length; i += 1) {
    if (uniq[i] - uniq[i - 2] <= 4) connected = true;
  }
  if (!connected && uniq.length >= 3) {
    for (let i = 1; i < uniq.length; i += 1) {
      if (uniq[i] - uniq[i - 1] === 1) connected = true;
    }
  }
  const highCard = ranks[0] ?? 0;
  const wet = clamp(
    (maxSuit >= 3 ? 1 : maxSuit === 2 ? 0.45 : 0)
      + (connected ? 0.55 : 0)
      + (paired ? -0.35 : 0)
      + (highCard >= 12 ? 0.15 : 0),
    0,
    1.4,
  );
  return { wet, paired, monotone: maxSuit >= 3, connected, highCard };
}

// 听牌检测：flushDraw 同花听；straightDraw 0=无 1=卡顺听 2=两端顺听（近似）
export function detectDraws(holeCards, board) {
  const hole = holeCards ?? [];
  if (!hole.length || !board?.length) return { flushDraw: false, straightDraw: 0 };

  const all = [...hole, ...board];
  const bySuit = {};
  for (const card of all) {
    const suit = cardSuit(card);
    (bySuit[suit] ??= []).push(card);
  }
  let flushDraw = false;
  for (const cards of Object.values(bySuit)) {
    if (cards.length === 4 && cards.some((card) => hole.includes(card))) flushDraw = true;
  }

  const values = new Set(all.map(rankValue));
  if (values.has(14)) values.add(1);
  let straightDraw = 0;
  const windows = [];
  for (let start = 2; start <= 10; start += 1) windows.push([start, start + 4]);
  windows.push([1, 5]); // A-5 轮子
  for (const [lo, hi] of windows) {
    let count = 0;
    for (let v = lo; v <= hi; v += 1) if (values.has(v)) count += 1;
    if (count === 4) straightDraw = Math.max(straightDraw, 2);
    else if (count === 3) straightDraw = Math.max(straightDraw, 1);
  }

  return { flushDraw, straightDraw };
}

// ============================================================
// 牌力评估
// ============================================================
function hasKnownCards(room, player) {
  return [...player.holeCards, ...(room.hand?.board ?? [])].filter(Boolean);
}

function preflopStrength(cards) {
  if (cards.length !== 2) return 0.5;
  const [first, second] = cards;
  const r1 = rankValue(first);
  const r2 = rankValue(second);
  const high = Math.max(r1, r2);
  const low = Math.min(r1, r2);
  const suited = cardSuit(first) === cardSuit(second);
  const gap = high - low;
  let score = (high + low) / 30;

  if (r1 === r2) score += 0.28 + high / 80;
  if (suited) score += 0.08;
  if (gap === 1) score += 0.06;
  else if (gap === 2) score += 0.04;
  else if (gap === 3) score += 0.02;
  if (high >= 11) score += 0.05;
  if (high >= 13 && low >= 10) score += 0.06;
  if (high <= 7 && low <= 7 && r1 !== r2) score -= 0.12;

  return clamp(score, 0.02, 0.98);
}

function madeHandStrength(room, player) {
  const cards = hasKnownCards(room, player);
  if (cards.length < 5) return preflopStrength(player.holeCards);

  const rank = bestHandOfSeven(cards);
  const baseByCategory = [0.2, 0.33, 0.47, 0.61, 0.72, 0.81, 0.9, 0.97, 1];
  const first = rank.kickers[0] ?? 0;
  const second = rank.kickers[1] ?? 0;
  const kickerBonus = (first / 14) * 0.05 + (second / 14) * 0.02;
  return clamp((baseByCategory[rank.category] ?? 0.2) + kickerBonus, 0.02, 0.99);
}

// 综合评估：成牌 + 听牌权益 + 牌面纹理修正
export function assessStrength(room, player) {
  const boardLen = room.hand?.board?.length ?? 0;
  const made = madeHandStrength(room, player);

  if (boardLen < 3) {
    // 翻牌前：位置修正（越靠后越宽松）
    const pos = getPlayerPosition(room, player);
    const multipliers = { early: 0.9, middle: 1.0, late: 1.12, button: 1.18 };
    return clamp(made * (multipliers[pos] ?? 1), 0.02, 0.99);
  }

  const texture = analyzeBoard(room.hand.board);
  const draws = detectDraws(player.holeCards, room.hand.board);
  let strength = made;

  // 中等成牌在湿润面贬值
  if (made < 0.62) strength -= Math.max(0, texture.wet - 0.5) * 0.15;
  // 一对在配对面也贬值
  if (made >= 0.45 && made < 0.62 && texture.paired) strength -= 0.05;
  // 听牌权益
  if (draws.flushDraw) strength += 0.16;
  if (draws.straightDraw === 2) strength += 0.12;
  else if (draws.straightDraw === 1) strength += 0.07;

  return clamp(strength, 0.02, 0.99);
}

function getPlayerPosition(room, player) {
  if (!room.buttonSeat && room.buttonSeat !== 0) return 'middle';
  const activePlayers = room.players.filter((p) => p.inHand && !p.folded);
  if (activePlayers.length < 2) return 'button';

  const total = activePlayers.length;
  const seats = activePlayers.map((p) => p.seatIndex).sort((a, b) => a - b);
  const buttonIdx = seats.indexOf(room.buttonSeat);
  if (buttonIdx === -1) return 'middle';
  const playerIdx = seats.indexOf(player.seatIndex);
  if (playerIdx === -1) return 'middle';

  const distance = (playerIdx - buttonIdx + total) % total;
  if (distance === 0) return 'button';
  if (distance <= 2) return 'late';
  if (distance <= 4) return 'middle';
  return 'early';
}

// ============================================================
// 对手情境
// ============================================================
function opponentContext(room, player) {
  const live = room.players.filter(
    (entry) => entry.inHand && !entry.folded && entry.token !== player.token,
  );
  const hand = room.hand;
  const toCall = Math.max(0, hand.currentBet - player.streetContribution);
  const pot = Math.max(1, hand.pot);

  // 本街是否已有对手加注（playerStreetActions 记录了本街动作）
  let aggressorSeat = null;
  for (const [seatKey, info] of Object.entries(hand.playerStreetActions ?? {})) {
    if ((info.type === 'raise' || info.type === 'allin') && Number(seatKey) !== player.seatIndex) {
      aggressorSeat = Number(seatKey);
    }
  }
  // 翻牌前的首个加注者（引擎在 applyPlayerAction 中记录，跨街保留）
  const wasPreRaiser = hand.preflopAggrSeat === player.seatIndex && hand.board?.length === 3;

  return {
    count: live.length,
    toCall,
    pressure: toCall / (pot + toCall),
    facingRaise: aggressorSeat !== null && toCall > 0,
    wasPreRaiser,
    potRatio: toCall / pot,
  };
}

// ============================================================
// 蒙特卡洛权益（面对下注时收紧对手抽样范围，不再假设对手拿随机两张）
// ============================================================
function estimateEquity(room, player, { samples = 32, oppCutoff = 0 } = {}) {
  const opponents = room.players.filter(
    (entry) => entry.inHand && !entry.folded && entry.token !== player.token,
  );
  if (!opponents.length) return 1;

  const known = new Set(hasKnownCards(room, player));
  const board = [...(room.hand?.board ?? [])];
  const boardNeed = Math.max(0, 5 - board.length);
  const liveBoard = board.slice(0, 5);
  let wins = 0;
  let ties = 0;

  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
    const rng = seededRandom(
      room.code,
      room.hand?.id ?? 0,
      player.token,
      'mc',
      sampleIndex,
    );
    const deck = createDeck().filter((card) => !known.has(card));
    seededShuffle(deck, rng);

    const sampledBoard = [...liveBoard, ...deck.slice(0, boardNeed)];
    let cursor = boardNeed;
    const heroRank = bestHandOfSeven([...player.holeCards, ...sampledBoard]);
    let bestOpponent = null;

    for (const _opponent of opponents) {
      const oppCards = deck.slice(cursor, cursor + 2);
      cursor += 2;
      if (oppCards.length < 2) break;
      // 收紧范围：面对加注时，弱起手牌不参与对抗统计
      if (oppCutoff > 0 && preflopStrength(oppCards) < oppCutoff) continue;
      const opponentRank = bestHandOfSeven([...oppCards, ...sampledBoard]);
      if (!bestOpponent || compareHandRanks(opponentRank, bestOpponent) > 0) {
        bestOpponent = opponentRank;
      }
    }

    if (!bestOpponent) {
      wins += 1;
      continue;
    }

    const comparison = compareHandRanks(heroRank, bestOpponent);
    if (comparison > 0) wins += 1;
    else if (comparison === 0) ties += 1;
  }

  return clamp((wins + ties * 0.5) / samples, 0, 1);
}

// ============================================================
// 拟人化下注尺度：现实阶梯 + 取整，而非精确映射牌力
// ============================================================
const SIZE_LADDER = [
  { f: 0.33, weight: 2 },
  { f: 0.5, weight: 3 },
  { f: 0.66, weight: 3 },
  { f: 0.8, weight: 2 },
  { f: 1.0, weight: 1 },
  { f: 1.6, weight: 0.6 },
];

function pickSizeFraction(rng, persona, kind) {
  const entries = SIZE_LADDER.map(({ f, weight }) => {
    let w = weight;
    if (kind === 'value') w *= 0.5 + f; // 值注偏向大尺度
    if (kind === 'protect') w *= 1.2 - Math.abs(f - 0.66);
    if (kind === 'block' || kind === 'bluff') w *= 1.3 - f * 0.8; // 阻断/诈唬偏小
    w *= 0.9 + persona.aggression * 0.2;
    return { f, w: Math.max(w, 0.01) };
  });
  const total = entries.reduce((sum, entry) => sum + entry.w, 0);
  let roll = rng() * total;
  for (const entry of entries) {
    roll -= entry.w;
    if (roll <= 0) return entry.f;
  }
  return 0.5;
}

function buildRaiseTarget(room, actions, fraction) {
  const hand = room.hand;
  const potBase = Math.max(0, (hand.pot ?? 0) + actions.toCall);
  const bb = room.config.bigBlind;
  const raw = hand.currentBet + potBase * fraction;
  // 取整到半个大盲的整数倍，像人一样下"整数"（奇数大盲时按整盲取整避免碎筹码）
  const grid = bb % 2 === 0 ? bb / 2 : bb;
  const rounded = Math.max(actions.minRaiseTo, Math.round(raw / grid) * grid);
  return Math.round(clamp(rounded, actions.minRaiseTo, actions.maxRaiseTo));
}

// 边界软化：阈值附近的决策按比例混合，而不是硬切换
function mixProb(value, threshold, band = 0.04) {
  return clamp((value - (threshold - band)) / (band * 2), 0, 1);
}

// ============================================================
// 决策核心
// ============================================================
function coreDecide(room, player, actions) {
  const level = normalizeBotLevel(player.botLevel);
  const policy = POLICY[level] ?? POLICY.beginner;
  const persona = derivePersona(player.token);
  const bb = room.config.bigBlind;
  const stackInBB = player.stack / bb;

  // 打破确定性：会话盐值 + 每次自增的决策序号
  player.botNonce = (player.botNonce ?? 0) + 1;
  const rng = seededRandom(
    room.code,
    room.hand?.id ?? 0,
    player.token,
    actions.toCall,
    actions.minRaiseTo,
    actions.maxRaiseTo,
    room.hand?.street ?? '',
    room.hand?.board?.length ?? 0,
    player.actionCount ?? 0,
    player.botCreatedAt ?? 0,
    player.botNonce,
  );

  const ctx = opponentContext(room, player);
  let strength = assessStrength(room, player);

  // 高级/中级 AI 叠加蒙特卡洛权益；面对加注时收紧对手范围
  if (level !== 'beginner') {
    const samples = level === 'advanced' ? 120 : 48;
    const oppCutoff = ctx.facingRaise ? (ctx.pressure > 0.4 ? 0.58 : 0.52) : 0;
    const equity = estimateEquity(room, player, { samples, oppCutoff });
    const weight = level === 'advanced' ? 0.55 : 0.35;
    strength = clamp(weight * equity + (1 - weight) * strength, 0, 1);
  }

  // 多人底池收缩：中等牌力随人数衰减
  if (ctx.count >= 2 && strength > 0.4 && strength < 0.72) {
    strength -= (ctx.count - 1) * 0.035;
  }
  // 人格松紧
  strength = clamp(strength + persona.tightness, 0.02, 0.99);

  const texture = analyzeBoard(room.hand.board);
  const draws = detectDraws(player.holeCards, room.hand.board);
  const thresholds = {
    fold: policy.fold + persona.tightness,
    call: policy.call,
    raise: policy.raise,
    pressureFold: policy.pressureFold,
    pressureCall: policy.pressureCall,
  };

  const tryBet = (kind, freq) => {
    if (!actions.canRaise || rng() > freq) return null;
    const fraction = pickSizeFraction(rng, persona, kind);
    return { type: 'raise', amount: buildRaiseTarget(room, actions, fraction) };
  };

  // ---------- 短码 ----------
  if (stackInBB < 15 && actions.canRaise) {
    if (strength >= 0.68 && rng() > 0.3) return { action: { type: 'allin' }, difficulty: 0.3 };
    if (strength < 0.3 && mixProb(strength, 0.3, 0.03) < rng()) {
      return { action: { type: 'fold' }, difficulty: 0.15 };
    }
  }

  // ---------- 可以过牌 ----------
  if (actions.canCheck) {
    // 慢打陷阱：超强牌 + 干燥面，按人格概率挖坑
    if (
      strength >= 0.86
      && texture.wet < 0.7
      && rng() < persona.trap
      && stackInBB > 10
    ) {
      return { action: { type: 'check' }, difficulty: 0.15, slowPlay: true };
    }
    // C-bet：翻牌前加注者被让牌后按牌面干燥度持续施压
    if (ctx.wasPreRaiser && ctx.count <= 2) {
      const dryBoost = clamp(0.9 - texture.wet * 0.5, 0.3, 0.95);
      const cbet = tryBet('protect', (0.35 + 0.4 * dryBoost) * persona.cbarrel * persona.aggression * 0.6);
      if (cbet) return { action: cbet, difficulty: 0.35 };
    }
    // 半诈唬：听牌被让牌时主动开火
    if (strength < 0.55 && (draws.flushDraw || draws.straightDraw === 2)) {
      const semi = tryBet('bluff', 0.3 * persona.bluff * persona.aggression);
      if (semi) return { action: semi, difficulty: 0.5 };
    }
    // 空气牌偶发诈唬（高级为主）
    if (level !== 'beginner' && strength < 0.45 && rng() < policy.bluff * persona.bluff) {
      const bluff = tryBet('bluff', 0.85);
      if (bluff) return { action: bluff, difficulty: 0.65 };
    }
    // 强牌正常值注（慢打没触发时）
    const valueP = mixProb(strength, thresholds.raise - 0.02, 0.05) * persona.aggression;
    if (rng() < valueP) {
      const value = tryBet('value', 0.9);
      if (value) return { action: value, difficulty: 0.3 };
    }
    // 秒速过牌的空气牌
    const snap = strength < 0.35 && rng() < 0.18;
    return { action: { type: 'check' }, difficulty: snap ? 0.02 : 0.2 };
  }

  // ---------- 面对下注 ----------
  // 弃牌闸门（压力过大且牌力不足，边界软化）
  const foldP = mixProb(ctx.pressure, thresholds.pressureFold, 0.05)
    * mixProb(thresholds.fold - strength + 0.5, 0.5, 0.08);
  if (rng() < foldP) return { action: { type: 'fold' }, difficulty: 0.35 };

  // 短码极强牌直接推
  if (strength >= 0.93 && player.stack <= bb * 3) {
    return { action: { type: 'allin' }, difficulty: 0.25 };
  }

  // 加注闸门（边界软化 × 人格激进）
  const raiseP = mixProb(strength, thresholds.raise, 0.05) * persona.aggression;
  if (actions.canRaise && rng() < raiseP) {
    // 慢打型玩家偶尔只是跟注埋伏
    if (strength >= 0.88 && ctx.pressure < 0.45 && rng() < persona.trap * 0.7) {
      return { action: { type: 'call' }, difficulty: 0.4, slowPlay: true };
    }
    const kind = strength >= 0.82 ? 'value' : draws.flushDraw || draws.straightDraw === 2 ? 'protect' : 'bluff';
    const fraction = pickSizeFraction(rng, persona, kind);
    return { action: { type: 'raise', amount: buildRaiseTarget(room, actions, fraction) }, difficulty: 0.45 };
  }

  // 跟注：底池赔率 vs 权益（中级以上用数学）
  const potOdds = ctx.pressure;
  if (level !== 'beginner' && strength >= potOdds && actions.canCall) {
    return { action: { type: 'call' }, difficulty: 0.3 };
  }
  const callP = Math.max(mixProb(strength, thresholds.call, 0.06), 1 - mixProb(ctx.pressure, thresholds.pressureCall, 0.05));
  if (actions.canCall && rng() < callP) {
    return { action: { type: 'call' }, difficulty: 0.4 };
  }

  // 最后手段
  return { action: actions.canCall ? { type: 'call' } : { type: 'fold' }, difficulty: 0.5 };
}

// 兼容旧接口：只返回动作
export function chooseBotAction(room, player, actions) {
  return coreDecide(room, player, actions).action;
}

// 新接口：动作 + 拟人化的思考时长
export function decideBotTurn(room, player, actions) {
  const decision = coreDecide(room, player, actions);
  const level = normalizeBotLevel(player.botLevel);
  const [min, max] = BOT_THINK_DELAY[level] ?? BOT_THINK_DELAY.beginner;

  // 难度 → 时长映射：分差越小/压力越大拖得越久；空气过牌秒回
  const base = min + (max - min) * decision.difficulty;
  const jitter = 0.85 + Math.random() * 0.3;
  let delayMs = Math.round(base * jitter);
  if (decision.slowPlay) delayMs += 400 + Math.round(Math.random() * 900); // 挖坑要"想很久"

  return {
    action: decision.action,
    delayMs: clamp(delayMs, 250, 4500),
  };
}
