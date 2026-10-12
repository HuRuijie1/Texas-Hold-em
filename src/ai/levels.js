// ============================================================
// 德州难度等级：五档扑克风格分类
//
// 设计要点：
//   1. 档位之间是**结构性能力差异**（会不会算、看不看位置、用不用频率），
//      而不只是数值调参。旧的三档只是同一套逻辑换阈值。
//   2. 「弱」不等于「随机」。新手鱼的弱势来自可被预测的漏洞
//      （看不准牌力、跟太多、不爱加注、几乎不诈唬），玩家可以读出来并利用；
//      而不是 30% 概率乱推的疯子。
//   3. 权益样本量不用来区分档位：80 样本的标准误约 5.6%，比档位之间的
//      策略差异还大，那样中等 AI 会退化成随机数发生器。所有档位样本给足，
//      差异由 leak + abilities + 决策线承担。
// ============================================================

export const TEXAS_LEVELS = ['fish', 'regular', 'lag', 'tag', 'gto'];

export const TEXAS_LEVEL_LABELS = {
  fish: '新手鱼',
  regular: '常规玩家',
  lag: '松凶玩家',
  tag: '紧凶高手',
  gto: 'GTO大师',
};

/**
 * 旧等级 → 新等级的映射。房间快照里的 botLevel 原值会被保留，
 * 在归一化时走这张表，因此旧存档无需数据迁移。
 * 刻意不在 TEXAS_LEVELS 里暴露这些别名，避免 UI 出现 8 个选项。
 */
export const TEXAS_LEVEL_ALIASES = {
  beginner: 'fish',
  primary: 'fish',
  low: 'fish',
  初级: 'fish',
  intermediate: 'regular',
  mid: 'regular',
  中级: 'regular',
  advanced: 'tag',
  high: 'tag',
  高级: 'tag',
  pro: 'gto',
  expert: 'gto',
};

export const LEVEL_PROFILE = {
  // ---------------- 新手鱼：松而被动，看不准牌力，几乎不诈唬 ----------------
  fish: {
    id: 'fish',
    label: '新手鱼',
    rank: 0,
    think: [180, 250],
    mcSamples: 150,
    budgetMs: 2,
    vpip: 0.55,
    pfr: 0.12,
    threeBet: 0.03,
    cbetBase: 0.38,
    // 领先下注（donk）频率系数：1 = 不做任何抑制，它根本不知道往加注者身上开火是错的。
    // 注意它的绝对 donk 频率仍是全场最低 —— 那是被 noBluffMult 0.15 和整体被动
    // 压下去的，跟"懂行"没关系。别把这两个成因混为一谈。
    donkMult: 1,
    pushFoldMaxBB: 8,
    abilities: {
      position: false, // 不看位置，用最松的范围表
      rangeTable: false, // 假设对手拿随机两张
      potOdds: false,
      blockers: false,
      mixedFreq: false,
      preciseRiver: false,
      pushFold: false,
      allowOverbet: false,
      rangeAdv: false,
    },
    leak: {
      equityNoise: 0.1, // 权益估计上叠加的噪声 σ
      overcall: 0.14, // 跟注阈值系统性下调 → 跟太多
      overfold: -0.05,
      passivity: 0.55, // 加注频率倍率 → VPIP 高但 PFR 低
      noBluffMult: 0.15,
      sizeBias: 0.85,
      temperature: 0.14, // 决策软化温度，越大越摇摆
      multiwayTight: 0.55,
    },
    lines: {
      valueBetLine: 0.7,
      valueRaiseLine: 0.8,
      bluffRaiseLine: 0.3,
      semiBluffFreq: 0.15,
      bluffFreq: 0.03,
      raiseFreq: 0.1,
      trapMax: 0.1,
    },
  },

  // ---------------- 常规玩家：懂位置与底池赔率，偏保守 ----------------
  regular: {
    id: 'regular',
    label: '常规玩家',
    rank: 1,
    think: [155, 220],
    mcSamples: 600,
    budgetMs: 2,
    vpip: 0.32,
    pfr: 0.21,
    threeBet: 0.07,
    cbetBase: 0.55,
    donkMult: 0.5,
    pushFoldMaxBB: 18,
    abilities: {
      position: true,
      rangeTable: true,
      potOdds: true,
      blockers: false,
      mixedFreq: false,
      preciseRiver: true,
      pushFold: true,
      allowOverbet: false,
      rangeAdv: false,
    },
    leak: {
      equityNoise: 0.05,
      // 常规玩家的漏洞是「一知半解」：算得出底池赔率，却扛不住连续施压，
      // 面对持续开火会跟歪。别把它改成过度弃牌 —— 在这群不会跨手读人的 AI 里，
      // 紧就是纯收益（对手不会因为你好欺负就多诈唬），改完它会直接冲到盈利第一。
      overcall: 0.05,
      overfold: -0.02,
      passivity: 0.85,
      noBluffMult: 0.6,
      sizeBias: 0.95,
      temperature: 0.1,
      multiwayTight: 0.7,
    },
    lines: {
      valueBetLine: 0.62,
      valueRaiseLine: 0.7,
      bluffRaiseLine: 0.32,
      semiBluffFreq: 0.35,
      bluffFreq: 0.1,
      raiseFreq: 0.22,
      trapMax: 0.25,
    },
  },

  // ---------------- 松凶玩家：范围宽、频率高、压迫感强 ----------------
  lag: {
    id: 'lag',
    label: '松凶玩家',
    rank: 2,
    think: [135, 195],
    mcSamples: 1200,
    budgetMs: 3,
    vpip: 0.36,
    pfr: 0.31,
    threeBet: 0.11,
    cbetBase: 0.7,
    // 松凶会把领先下注当武器用，所以比紧凶高一些，但仍然远低于随手乱打
    donkMult: 0.62,
    pushFoldMaxBB: 20,
    abilities: {
      position: true,
      rangeTable: true,
      potOdds: true,
      blockers: true,
      mixedFreq: true,
      preciseRiver: true,
      pushFold: true,
      allowOverbet: true,
      rangeAdv: true,
    },
    leak: {
      equityNoise: 0.03,
      overcall: 0.01,
      overfold: 0,
      passivity: 1.15, // 加注更频繁
      // 曾经是 1.4（比基线多诈唬四成），结果松凶在混合桌里是**输钱**的：
      // 对手都按 MDF 正确防守时，无节制的空气诈唬只是纯送。
      // 松凶的压迫感来自宽范围和高频率的开火，不是靠把把瞎诈唬。
      noBluffMult: 1.05, // 略多于基线，维持形象但不失控
      sizeBias: 1.15,
      temperature: 0.075,
      multiwayTight: 0.8,
    },
    lines: {
      valueBetLine: 0.58,
      valueRaiseLine: 0.64,
      bluffRaiseLine: 0.38,
      semiBluffFreq: 0.48,
      bluffFreq: 0.19,
      raiseFreq: 0.34,
      trapMax: 0.3,
    },
  },

  // ---------------- 紧凶高手：范围紧、价值下注精准、少犯错 ----------------
  tag: {
    id: 'tag',
    label: '紧凶高手',
    rank: 3,
    think: [115, 170],
    mcSamples: 2000,
    budgetMs: 3,
    vpip: 0.23,
    pfr: 0.2,
    threeBet: 0.08,
    cbetBase: 0.6,
    donkMult: 0.28,
    pushFoldMaxBB: 20,
    abilities: {
      position: true,
      rangeTable: true,
      potOdds: true,
      blockers: true,
      mixedFreq: true,
      preciseRiver: true,
      pushFold: true,
      allowOverbet: true,
      rangeAdv: true,
    },
    leak: {
      equityNoise: 0.015,
      overcall: -0.01,
      overfold: 0,
      passivity: 0.95,
      noBluffMult: 0.9,
      sizeBias: 1.05,
      temperature: 0.06,
      multiwayTight: 0.85,
    },
    lines: {
      valueBetLine: 0.6,
      valueRaiseLine: 0.68,
      bluffRaiseLine: 0.34,
      semiBluffFreq: 0.42,
      bluffFreq: 0.14,
      raiseFreq: 0.28,
      trapMax: 0.35,
    },
  },

  // ---------------- GTO大师：接近平衡频率，无明显可剥削漏洞 ----------------
  gto: {
    id: 'gto',
    label: 'GTO大师',
    rank: 4,
    think: [100, 150],
    mcSamples: 3000,
    budgetMs: 4,
    vpip: 0.25,
    pfr: 0.22,
    threeBet: 0.09,
    cbetBase: 0.68,
    // 求解器里 donk 频率接近 0，GTO 只保留一点点不可预测性
    donkMult: 0.22,
    pushFoldMaxBB: 20,
    abilities: {
      position: true,
      rangeTable: true,
      potOdds: true,
      blockers: true,
      mixedFreq: true,
      preciseRiver: true,
      pushFold: true,
      allowOverbet: true,
      rangeAdv: true,
    },
    leak: {
      equityNoise: 0,
      overcall: 0,
      overfold: 0,
      passivity: 1,
      noBluffMult: 1,
      sizeBias: 1,
      temperature: 0.05,
      multiwayTight: 0.9,
    },
    lines: {
      valueBetLine: 0.56,
      valueRaiseLine: 0.66,
      bluffRaiseLine: 0.40,
      semiBluffFreq: 0.54,
      bluffFreq: 0.22,
      raiseFreq: 0.34,
      trapMax: 0.3,
    },
  },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 读取数值型环境变量；缺失/非法回退默认值，越界夹紧到合法范围 */
function envNumber(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * 机器人节奏调节（环境变量，默认即最快）：
 *   BOT_THINK_SCALE   思考时长全局倍率，默认 1，合法 [0.1, 10]。
 *                     倍率同时作用于上下限 —— 想变慢设 3~5 即可，无需联动调上限。
 *   BOT_THINK_MIN_MS  scale=1 时的思考时长硬下限，默认 50，合法 [0, 250]
 *   BOT_THINK_MAX_MS  scale=1 时的思考时长硬上限，默认 250，合法 [50, 4500]
 *                     （想恢复改造前的慢节奏设 1500）
 *
 * 惰性读取：ESM import 提升使本模块先于 realtime-app.js 的 loadEnvFile() 求值，
 * 模块级常量读不到 .env 里的值，故推迟到首次调用（发生在引擎 tick 内）时再解析。
 * 测试 import 本模块不会触发读取，使用默认值。
 */
let thinkTuning = null;
export function botThinkTuning() {
  if (!thinkTuning) {
    const scale = envNumber('BOT_THINK_SCALE', 1, 0.1, 10);
    const minRaw = envNumber('BOT_THINK_MIN_MS', 50, 0, 250);
    const maxRaw = envNumber('BOT_THINK_MAX_MS', 250, 50, 4500);
    // 绝对天花板 4500ms 与改造前的引擎上限保持一致；兜底防止 min > max 的病态组合
    const minMs = Math.min(4500, Math.round(minRaw * scale));
    thinkTuning = {
      scale,
      minMs,
      maxMs: Math.max(minMs, Math.min(4500, Math.round(maxRaw * scale))),
    };
  }
  return thinkTuning;
}

/** 归一化到五档之一；未知输入兜底为最弱的 fish */
export function normalizeTexasLevel(level) {
  const value = String(level ?? '').trim().toLowerCase();
  if (TEXAS_LEVELS.includes(value)) return value;
  if (Object.prototype.hasOwnProperty.call(TEXAS_LEVEL_ALIASES, value)) {
    return TEXAS_LEVEL_ALIASES[value];
  }
  return 'fish';
}

/** 引擎与前端使用的入口名（保持与旧实现同签名） */
export function normalizeBotLevel(level) {
  return normalizeTexasLevel(level);
}

export function texasLevelLabel(level) {
  return TEXAS_LEVEL_LABELS[normalizeTexasLevel(level)] ?? TEXAS_LEVEL_LABELS.fish;
}

export function botLevelLabel(level) {
  return texasLevelLabel(level);
}

export function getProfile(level) {
  return LEVEL_PROFILE[normalizeTexasLevel(level)] ?? LEVEL_PROFILE.fish;
}

/** 档位强弱序号，0 最弱。用于测试里的强弱单调性断言 */
export function levelRank(level) {
  return getProfile(level).rank;
}

/**
 * 拟人化思考时长（极限节奏版：单次 100~250ms 量级）。
 * difficulty ∈ [0,1]：0 = 秒回（空气过牌），1 = 长考（大注边缘决策）。
 *
 * 档位区间刻意保留极简阶梯（越强越快）而非拉平：200ms tick 下 20~30ms 的
 * 档位差会被取整吞掉、观感趋同；将来用 BOT_THINK_SCALE 整体调慢时阶梯差
 * 重新放大可感知，结构无需再改。档位间的实力差异由能力/漏洞/频率承担。
 *
 * 节奏可用环境变量调节（见 botThinkTuning）：BOT_THINK_SCALE / _MIN_MS / _MAX_MS。
 */
export function thinkDelay(level, difficulty, persona = null, rng = Math.random) {
  const profile = getProfile(level);
  const [min, max] = profile.think;
  const d = clamp(Number(difficulty) || 0, 0, 1);
  // 保底 0.35：再简单的决策也不会是零延迟，否则像脚本
  const base = min + (max - min) * (0.35 + 0.65 * d);
  const { scale, minMs, maxMs } = botThinkTuning();
  const scaled = base * (persona?.thinkScale ?? 1) * scale;
  const jitter = 0.85 + rng() * 0.3;
  return Math.round(clamp(scaled * jitter, minMs, maxMs));
}
