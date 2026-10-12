// ============================================================
// GTO 决策树
//
// 与旧实现的根本区别：
//   旧：算一个「牌力分数」，拿去比阈值 → check/call/raise
//   新：算「对建模后对手范围的真实权益」，再按 GTO **频率**选动作
//       —— 同一个局面会按概率分布产生不同动作（可混合、不可被读死）
//
// 关键 GTO 量：
//   potOdds = toCall / (pot + toCall)        跟注的数学门槛
//   mdf     = 1 - bet / (pot + bet)          最低防守频率，防止被无脑诈唬剥削
//   alpha   = bet / (pot + bet)              诈唬的盈亏平衡频率
// ============================================================

import { gaussian, makeRng } from './prng.js';
import { buildBotView } from './view.js';
import { botThinkTuning, getProfile, normalizeTexasLevel, thinkDelay } from './levels.js';
import { derivePersona } from './persona.js';
import {
  analyzeBoard, blockerScore, detectDraws, nutAdvantage, rangeAdvantage,
} from './board.js';
import { equityVsRange } from './equity.js';
import {
  buildRaiseTarget, fourBetSizeBB, gtoSize, openSizeBB, threeBetSizeBB,
} from './sizing.js';
import {
  FULL_RANGE, bbDefendRange, coldCallRange, depthBand, fourBetRange,
  handIndexFromIds, limpRange, polarizedRange, pushRange, rangeFromPercent,
  rfiRange, threeBetRange, vsThreeBetCallRange,
} from './ranges.js';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-clamp(x, -20, 20)));
}

// 跟注者范围：中等偏弱。会 3bet/加注的强牌被降权（保留 25% 代表慢打）
const CALLER_RANGE = (() => {
  const broad = rangeFromPercent(72);
  const premium = rangeFromPercent(14);
  const table = new Uint8Array(169);
  for (let i = 0; i < 169; i += 1) {
    table[i] = premium[i] > 0 ? Math.min(broad[i], 25) : broad[i];
  }
  return table;
})();

/** 面对连续下注后的跟注范围（更窄更强） */
const CALLED_TWICE_RANGE = rangeFromPercent(48);

/**
 * 翻后主动开火的范围：极化（坚果 + 诈唬，中间留空），且越到后街越窄。
 *
 * 这里不能用翻前公开加注范围代替 —— 那是 17%~57% 的宽范围，拿它当翻后下注范围
 * 会把对手想成「什么都下注」，hero 于是高估自己的中等牌力一路跟到摊牌，
 * WTSD 能飙到 70%（真实 6 人桌是 25%~35%）。
 */
const BET_RANGE = {
  flop: polarizedRange(26, 22, 65),
  turn: polarizedRange(22, 20, 60),
  river: polarizedRange(20, 24, 55),
};

/** 越过已有下注再加注：比普通开火强得多，诈唬占比也低得多 */
const RAISE_RANGE = polarizedRange(20, 10, 50);

// ============================================================
// 动作合法性兜底
// ============================================================

/**
 * 把决策收敛到引擎一定接受的动作。
 * 这是「牌局一定能终止」的最后一道保险 —— 所有出口都经过这里。
 */
export function sanitizeAction(action, actions) {
  const canCheck = Boolean(actions?.canCheck);
  const canCall = Boolean(actions?.canCall);
  const canRaise = Boolean(actions?.canRaise);
  const type = action?.type;

  if (type === 'check') {
    if (canCheck) return { type: 'check' };
    return canCall ? { type: 'call' } : { type: 'fold' };
  }

  if (type === 'call') {
    if (canCall) return { type: 'call' };
    return canCheck ? { type: 'check' } : { type: 'fold' };
  }

  if (type === 'allin') {
    if (canRaise || canCall) return { type: 'allin' };
    return canCheck ? { type: 'check' } : { type: 'fold' };
  }

  if (type === 'raise') {
    if (!canRaise) {
      return canCall ? { type: 'call' } : (canCheck ? { type: 'check' } : { type: 'fold' });
    }
    const min = Math.max(0, Math.round(actions.minRaiseTo));
    const max = Math.max(min, Math.round(actions.maxRaiseTo));
    // min === max 说明加注必然是全下，直接推更自然，也避免边界抖动
    if (max <= min) return { type: 'allin' };
    const amount = Math.round(clamp(Number(action.amount) || min, min, max));
    if (amount >= max) return { type: 'allin' };
    return { type: 'raise', amount };
  }

  // fold 或任何未知类型
  return canCheck ? { type: 'check' } : { type: 'fold' };
}

// ============================================================
// 对手范围推断
// ============================================================

function opponentPosition(view, opponent) {
  const button = view.hand.buttonSeat;
  if (button < 0 || opponent.seatIndex == null) return 'BTN';
  const n = Math.max(2, view.config.maxSeats);
  const dist = (opponent.seatIndex - button + n) % n;
  if (dist === 0) return 'BTN';
  if (dist === 1) return 'SB';
  if (dist === 2) return 'BB';
  if (dist === n - 1) return 'CO';
  return dist <= 3 ? 'UTG' : 'MP';
}

/**
 * 由对手的公开动作推断其持牌范围。
 * 只用公开信息：本街动作、翻前加注者、座位。
 */
export function inferOpponentRange(view, opponent) {
  const streetAction = view.hand.playerStreetActions?.[opponent.seatIndex];
  const position = opponentPosition(view, opponent);
  const wasPreflopAggressor = view.hand.preflopAggrSeat === opponent.seatIndex;

  if (streetAction?.type === 'raise' || streetAction?.type === 'allin') {
    // 本街主动开火：极化范围，越到后街越窄。
    // 本街出现两次以上加注说明这是「越过下注再加注」，比普通开火强得多。
    if (countRaises(view) >= 2) return RAISE_RANGE;
    return BET_RANGE[view.hand.street] ?? BET_RANGE.flop;
  }
  if (wasPreflopAggressor) {
    return rfiRange('regular', position) ?? FULL_RANGE;
  }
  if (streetAction?.type === 'call') {
    return wasPreflopAggressor ? CALLED_TWICE_RANGE : CALLER_RANGE;
  }
  // 过牌/未行动：宽范围（过牌会略微降低强度，但这里不做过度推断）
  return CALLER_RANGE;
}

function buildOpponentRanges(view, profile) {
  if (!profile.abilities.rangeTable) {
    // 新手鱼不会建模对手，把对手当成随机两张牌
    return view.opponents.map(() => FULL_RANGE);
  }
  return view.opponents.map((opponent) => inferOpponentRange(view, opponent));
}

// ============================================================
// 翻前
// ============================================================

function countRaises(view) {
  let count = 0;
  for (const info of Object.values(view.hand.playerStreetActions ?? {})) {
    if (info.type === 'raise' || info.type === 'allin') count += 1;
  }
  return count;
}

function decidePreflop(view, profile, persona, rng) {
  const A = view.actions;
  const d = view.derived;
  const level = profile.id;
  const hero = view.hero;

  if (hero.holeCards.length !== 2) {
    return { action: A.canCheck ? { type: 'check' } : { type: 'fold' }, difficulty: 0.2, tags: ['no-cards'] };
  }

  const index = handIndexFromIds(hero.holeCards[0], hero.holeCards[1]);
  // 不具备位置感知的档位一律按最松的位置处理
  const position = profile.abilities.position ? d.heroPosition : 'BTN';
  const bb = view.config.bigBlind;
  const raises = countRaises(view);
  const aggression = persona.aggression;
  const passivity = profile.leak.passivity;

  const openRaise = (sizeBB) => ({
    action: {
      type: 'raise',
      amount: Math.round(bb * sizeBB * persona.sizeBias * profile.leak.sizeBias),
    },
    difficulty: 0.35,
    tags: ['preflop-open'],
  });

  // ---------- 无人加注 ----------
  if (raises === 0) {
    const rfi = rfiRange(level, position);
    const raiseWeight = (rfi ? rfi[index] : 0) * aggression * passivity;
    if (A.canRaise && rng() * 100 < raiseWeight) {
      return openRaise(openSizeBB(position));
    }

    if (A.toCall === 0) {
      return { action: { type: 'check' }, difficulty: 0.15, tags: ['preflop-check'] };
    }

    // 需要跟注（大盲面对跛入）：跛入范围 + 鱼的过度跟注
    const limp = limpRange(level, position);
    const callWeight = (limp ? limp[index] : 0) * (1 + profile.leak.overcall * 4);
    if (A.canCall && rng() * 100 < callWeight) {
      return { action: { type: 'call' }, difficulty: 0.2, tags: ['preflop-limp'] };
    }
    return {
      action: A.canCheck ? { type: 'check' } : { type: 'fold' },
      difficulty: 0.3,
      tags: ['preflop-fold'],
    };
  }

  // ---------- 大盲面对单次加注（偷盲防守） ----------
  if (raises === 1 && d.heroIsBigBlind) {
    const defend = bbDefendRange(level);
    const three = threeBetRange(level, 'BB');
    const defendW = defend ? defend[index] : 0;
    const threeW = (three ? three[index] : 0) * aggression;
    const roll = rng() * 100;
    if (A.canRaise && roll < threeW) {
      return {
        action: {
          type: 'raise',
          amount: Math.round(bb * threeBetSizeBB(2.5) * persona.sizeBias * profile.leak.sizeBias),
        },
        difficulty: 0.45,
        tags: ['bb-3bet'],
      };
    }
    if (roll < Math.max(defendW, threeW) && (A.canCall || A.canCheck)) {
      return {
        action: A.canCall ? { type: 'call' } : { type: 'check' },
        difficulty: 0.35,
        tags: ['bb-defend'],
      };
    }
    return { action: { type: 'fold' }, difficulty: 0.25, tags: ['bb-fold'] };
  }

  // ---------- 面对单次加注 ----------
  if (raises === 1) {
    const three = threeBetRange(level, position);
    const call = coldCallRange(level, position);
    const threeW = (three ? three[index] : 0) * aggression;
    const callW = (call ? call[index] : 0)
      * (1 + profile.leak.overcall * 4)
      * (1 + persona.callStation * 0.5);
    const roll = rng() * 100;
    if (A.canRaise && roll < threeW) {
      return {
        action: {
          type: 'raise',
          amount: Math.round(bb * threeBetSizeBB(openSizeBB(position)) * persona.sizeBias * profile.leak.sizeBias),
        },
        difficulty: 0.5,
        tags: ['3bet'],
      };
    }
    if (roll < threeW + callW && (A.canCall || A.canCheck)) {
      return {
        action: A.canCall ? { type: 'call' } : { type: 'check' },
        difficulty: 0.3,
        tags: ['cold-call'],
      };
    }
    return { action: { type: 'fold' }, difficulty: 0.25, tags: ['fold-vs-open'] };
  }

  // ---------- 面对 3bet 及以上 ----------
  const four = fourBetRange(level);
  const vsCall = vsThreeBetCallRange(level);
  const fourW = (four ? four[index] : 0) * aggression;
  const callW = (vsCall ? vsCall[index] : 0) * (1 + profile.leak.overcall * 4);
  const roll = rng() * 100;
  if (A.canRaise && roll < fourW) {
    return {
      action: {
        type: 'raise',
        amount: Math.round(bb * fourBetSizeBB(9) * persona.sizeBias * profile.leak.sizeBias),
      },
      difficulty: 0.6,
      tags: ['4bet'],
    };
  }
  if (roll < fourW + callW && (A.canCall || A.canCheck)) {
    return {
      action: A.canCall ? { type: 'call' } : { type: 'check' },
      difficulty: 0.4,
      tags: ['call-vs-3bet'],
    };
  }
  return { action: { type: 'fold' }, difficulty: 0.3, tags: ['fold-vs-3bet'] };
}

// ============================================================
// 短码推 / 弃
// ============================================================

function decidePushFold(view, profile, persona, rng) {
  const A = view.actions;
  const d = view.derived;
  const hero = view.hero;
  if (hero.holeCards.length !== 2) return null;

  const index = handIndexFromIds(hero.holeCards[0], hero.holeCards[1]);
  const table = pushRange(profile.id, depthBand(d.effBB));
  const weight = table ? table[index] : 0;
  const facing = d.facingRaise;

  // 面对加注时收紧到表内较强的部分
  const threshold = facing ? 0.55 : 1;

  if (rng() * 100 < weight * threshold * persona.aggression) {
    return { action: { type: 'allin' }, difficulty: 0.3, tags: ['push-fold-shove'] };
  }
  if (facing) {
    // 短码面对加注，不推就只能弃（没有中间余地）
    return {
      action: A.canCheck ? { type: 'check' } : { type: 'fold' },
      difficulty: 0.25,
      tags: ['push-fold-give-up'],
    };
  }
  return null;
}

// ============================================================
// 翻后
// ============================================================

function decidePostflop(view, profile, persona, rng) {
  const A = view.actions;
  const d = view.derived;
  const hero = view.hero;
  const board = view.hand.board;

  if (hero.holeCards.length !== 2) {
    return { action: A.canCheck ? { type: 'check' } : { type: 'fold' }, difficulty: 0.2, tags: ['no-cards'] };
  }

  const info = analyzeBoard(board);
  const draws = detectDraws(hero.holeCards, board);

  // ---- 权益（对建模后的对手范围）----
  const oppRanges = buildOpponentRanges(view, profile);
  let equity = equityVsRange({ hero: hero.holeCards, board, oppRanges, profile, rng });
  // 弱档位"看不准牌力"：给权益估计叠加噪声
  if (profile.leak.equityNoise > 0) equity += gaussian(rng) * profile.leak.equityNoise;
  equity = clamp(equity, 0, 1);

  const lines = profile.lines;
  const leak = profile.leak;
  const isMultiway = d.isMultiway;

  // 决策难度：越接近阈值、底池越大、多人底池 → 想得越久
  const difficulty = clamp(
    0.35
      + (isMultiway ? 0.15 : 0)
      + (d.potOdds > 0.35 ? 0.25 : 0)
      + (Math.abs(equity - 0.5) < 0.12 ? 0.25 : 0),
    0,
    1,
  );

  // ---- 下注构造器 ----
  const makeBet = (kind, extra = 0) => {
    if (!A.canRaise) return null;
    const adv = profile.abilities.rangeAdv ? rangeAdvantage(board, d.isInPosition) : 0;
    const nut = profile.abilities.blockers ? nutAdvantage(board, hero.holeCards) : 0;
    const fraction = gtoSize(kind, {
      street: view.hand.street,
      isInPosition: d.isInPosition,
      texture: info.texture,
      isMultiway,
      allowOverbet: profile.abilities.allowOverbet,
      rangeAdvantage: adv,
      nutAdvantage: nut,
      spr: d.spr,
      sizeBias: persona.sizeBias * leak.sizeBias,
      rng,
    });
    return {
      action: { type: 'raise', amount: buildRaiseTarget(view, fraction) },
      difficulty: clamp(difficulty + extra, 0, 1),
      tags: [`bet-${kind}`],
    };
  };

  // ---------- 面对下注 ----------
  if (A.toCall > 0) {
    const potOdds = d.potOdds;
    const mdf = d.mdf;

    // 光够底池赔率只是「打平」。翻牌/转牌跟进去，后面还有街要打，
    // 会再挨一至两注（反向隐含赔率），所以真实门槛要高于底池赔率 ——
    // 这也是真人不会每手 marginal 牌都跟到底的原因。河牌没有后续街，不加惩罚。
    const futureStreetPenalty = view.hand.street === 'flop' ? 0.07
      : view.hand.street === 'turn' ? 0.04
        : 0;

    // 跟注门槛：底池赔率 + 反向隐含赔率 + 档位漏洞 + 人格松紧
    const callThreshold = clamp(
      potOdds + futureStreetPenalty - leak.overcall + leak.overfold + persona.tightness,
      0.02,
      0.95,
    );
    let pCall = sigmoid((equity - callThreshold) / leak.temperature);
    pCall *= 1 + persona.callStation * 0.5;
    pCall = clamp(pCall, 0, 0.97);

    // 加注：极化的（超强牌 或 有阻断牌的弱牌），中间牌跟注
    const nutBlocker = profile.abilities.blockers
      ? blockerScore(hero.holeCards, board, 'bluff')
      : 0;
    const isValueRaise = equity >= lines.valueRaiseLine;
    const isBluffRaise = equity <= lines.bluffRaiseLine && nutBlocker > 0.45;

    let pRaise = 0;
    if (A.canRaise) {
      if (isValueRaise) {
        pRaise = lines.raiseFreq * persona.aggression * leak.passivity * 1.4;
      } else if (isBluffRaise) {
        pRaise = lines.raiseFreq * persona.bluff * leak.noBluffMult * 0.5;
      } else if (draws.flushDrawType === 2 || draws.straightDrawType >= 2) {
        pRaise = lines.semiBluffFreq * 0.35 * persona.bluff * leak.noBluffMult;
      }
      if (isMultiway) pRaise *= 0.45;
      pRaise *= d.isInPosition ? 1.15 : 0.85;
    }
    pRaise = clamp(pRaise, 0, 0.9);

    // 频率化混合：总防守频率不应低于 MDF，否则会被无脑诈唬打爆
    if (profile.abilities.mixedFreq && mdf > 0) {
      const defense = pCall + pRaise;
      if (defense < mdf) {
        const scale = mdf / Math.max(defense, 0.02);
        pCall = Math.min(0.97, pCall * scale);
      }
    }

    let pFold = Math.max(0, 1 - pCall - pRaise);
    const sum = pRaise + pCall + pFold || 1;
    const pR = pRaise / sum;
    const pC = pCall / sum;

    const roll = rng();
    if (A.canRaise && roll < pR) {
      // 超强牌偶尔只是跟注埋伏
      if (isValueRaise && d.potOdds < 0.45 && rng() < Math.min(persona.trap, lines.trapMax) * 0.7) {
        return { action: { type: 'call' }, difficulty: 0.45, slowPlay: true, tags: ['slow-play'] };
      }
      const kind = isValueRaise ? 'value' : 'bluff';
      const bet = makeBet(kind, 0.1);
      if (bet) return bet;
      return { action: { type: 'call' }, difficulty: 0.4, tags: ['call-fallback'] };
    }

    if (roll < pR + pC) {
      return { action: { type: 'call' }, difficulty: 0.4, tags: ['call'] };
    }
    return { action: { type: 'fold' }, difficulty: 0.35, tags: ['fold'] };
  }

  // ---------- 可以过牌 ----------
  // 慢打陷阱：超强牌在干燥面挖坑
  if (
    equity >= 0.84
    && info.wet < 0.75
    && d.effBB > 8
    && rng() < Math.min(persona.trap, lines.trapMax)
  ) {
    return { action: { type: 'check' }, difficulty: 0.2, slowPlay: true, tags: ['trap'] };
  }

  // 领先下注（donk）识别：翻前加注者还在局中、本街尚无人下注，hero 却抢先开火。
  // 求解器里这个频率接近 0 —— 范围劣势方应当过牌给优势方，靠过牌-跟注 / 过牌-加注来防守，
  // 抢先开火只会把自己的范围拆成两半、还让对手白拿位置。
  // 不懂这点的档位随手就打，懂的档位主动把频率压下去，这正是强弱的分水岭。
  const raiserSeat = view.hand.preflopAggrSeat;
  const isDonkSpot = raiserSeat != null
    && raiserSeat !== hero.seatIndex
    && view.opponents.some((o) => o.seatIndex === raiserSeat);
  const donkMult = isDonkSpot ? profile.donkMult : 1;

  // 持续下注（翻牌）/ 后续开火（转牌、河牌）：翻前加注者握有范围优势
  if (d.wasPreRaiser) {
    const isFlop = view.hand.street === 'flop';
    const adv = profile.abilities.rangeAdv ? rangeAdvantage(board, d.isInPosition) : 0;
    let base = profile.cbetBase;
    if (info.texture === 'dry') base += 0.18;
    else if (info.texture === 'wet') base -= 0.08;
    base += adv * 0.25;
    let pFire = clamp(base * persona.cbet * persona.aggression, 0, 0.95);
    // 多人底池要收敛，但懂频率的档位仍会保持压迫（松凶靠的就是多人底池里的持续施压）
    if (isMultiway) pFire *= profile.abilities.mixedFreq ? 0.9 : 0.7;
    // 后街是「继续开火」而不是持续下注，频率降一档；没开火也不要直接过牌，
    // 交给下面的线路，这样河牌超池和薄价值对加注者依然可达。
    if (!isFlop) pFire *= 0.7;

    if (rng() < pFire) {
      const kind = equity > 0.62
        ? 'value'
        : (draws.flushDrawType === 2 || draws.straightDrawType >= 2) ? 'protect' : 'range';
      const bet = makeBet(kind, 0.05);
      if (bet) return { ...bet, tags: [...bet.tags, isFlop ? 'cbet' : 'barrel'] };
    }
    // 翻牌没开火就过牌；后街继续往下走
    if (isFlop) return { action: { type: 'check' }, difficulty: 0.2, tags: ['check-behind'] };
  }

  // 半诈唬：听牌主动开火
  if (draws.flushDrawType === 2 || draws.straightDrawType >= 2) {
    if (rng() < lines.semiBluffFreq * persona.bluff * leak.noBluffMult * donkMult) {
      const bet = makeBet('protect', 0.15);
      if (bet) return bet;
    }
  }

  // 空气诈唬（新手鱼几乎不做）
  if (rng() < lines.bluffFreq * persona.bluff * leak.noBluffMult * donkMult) {
    const bet = makeBet('bluff', 0.25);
    if (bet) return bet;
  }

  // 价值下注
  if (equity > lines.valueBetLine) {
    // 河牌有坚果优势时可以考虑超池
    const nut = profile.abilities.blockers ? nutAdvantage(board, hero.holeCards) : 0;
    const kind = profile.abilities.allowOverbet
      && view.hand.street === 'river'
      && nut > 0.25
      && equity > 0.82
      && d.spr <= 2.5
      ? 'overbet'
      : 'value';
    // 强牌在 donk 位也不想白白错过一条街，所以只打折而不是彻底压死
    if (rng() < (isDonkSpot ? Math.max(donkMult, 0.6) : 1)) {
      const bet = makeBet(kind, 0);
      if (bet) return bet;
    }
  }

  // 阻挡注（弱牌小注试探）
  if (equity > 0.35 && equity < 0.5 && view.hand.street !== 'river' && rng() < 0.12 * persona.aggression * donkMult) {
    const bet = makeBet('range', 0.2);
    if (bet) return bet;
  }

  return {
    action: { type: 'check' },
    difficulty: equity < 0.3 ? 0.1 : 0.25,
    tags: ['check'],
  };
}

// ============================================================
// 入口
// ============================================================

export function decideTexas(view, level, persona, rng) {
  const profile = getProfile(level);
  const A = view.actions;
  const d = view.derived;

  // 短码：push/fold 优先（≤6BB 时不做小尺度加注，那是最典型的鱼的错误）
  if (profile.abilities.pushFold && d.effBB <= profile.pushFoldMaxBB && A.canRaise) {
    const pushed = decidePushFold(view, profile, persona, rng);
    if (pushed) return pushed;
    if (d.effBB <= 6) {
      // 极短码：要么推要么弃
      return {
        action: A.toCall > 0 ? { type: 'fold' } : { type: 'check' },
        difficulty: 0.2,
        tags: ['short-stack-give-up'],
      };
    }
  }

  if (view.hand.street === 'preflop') return decidePreflop(view, profile, persona, rng);
  return decidePostflop(view, profile, persona, rng);
}

function buildDecisionRng(view, level) {
  return makeRng(
    'gto-v1',
    view.code,
    view.hand.id,
    view.hand.street,
    view.hand.board.length,
    view.hero.token,
    view.hero.botNonce,
    view.hero.actionCount,
    level,
    // botNonce 在房间重载后会归零，混入时间低位保证不会退化成确定性
    Math.floor(Date.now() / 1000),
  );
}

/** 只返回动作（兼容旧接口，测试直接使用） */
export function chooseBotAction(room, player, actions) {
  player.botNonce = (player.botNonce ?? 0) + 1;
  const view = buildBotView(room, player, actions);
  const level = normalizeTexasLevel(player?.botLevel);
  const persona = derivePersona(player?.token);
  const rng = buildDecisionRng(view, level);
  const decision = decideTexas(view, level, persona, rng);
  return sanitizeAction(decision.action, view.actions);
}

/** 动作 + 拟人化思考时长（引擎使用的入口） */
export function decideBotTurn(room, player, actions) {
  player.botNonce = (player.botNonce ?? 0) + 1;
  const view = buildBotView(room, player, actions);
  const level = normalizeTexasLevel(player?.botLevel);
  const persona = derivePersona(player?.token);
  const rng = buildDecisionRng(view, level);

  const decision = decideTexas(view, level, persona, rng);
  const action = sanitizeAction(decision.action, view.actions);

  // 极限节奏：不再为慢打（强牌挖坑）额外延长思考，slowPlay 字段保留作信息标签
  const { minMs, maxMs } = botThinkTuning();
  const delayMs = thinkDelay(level, decision.difficulty ?? 0.3, persona);

  return {
    action,
    delayMs: clamp(Math.round(delayMs), minMs, maxMs),
  };
}
