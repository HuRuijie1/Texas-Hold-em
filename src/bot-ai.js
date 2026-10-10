// ============================================================
// 德州扑克 AI —— 对外门面
//
// 本文件不含任何决策逻辑，只做导出转发。引擎（game-engine.js）与前端的
// 导入路径和导出名保持不变，因此 GTO 改造对引擎是零改动的。
//
// 难度等级为五档扑克风格分类：
//   新手鱼 / 常规玩家 / 松凶玩家 / 紧凶高手 / GTO大师
// 旧的 beginner / intermediate / advanced 会自动映射到新档位（见 levels.js）。
//
// 实际实现位于 src/ai/：
//   legacy-core.js  改造前的旧实现（AI_LEGACY=1 可切回）
//   view.js         公平性隔离层
//   levels.js       难度等级与每档策略参数
//   persona.js      人格系统
//   ranges.js       起手牌范围表
//   equity.js       权益计算
//   board.js        牌面分析
//   sizing.js       下注尺度
//   strategy.js     GTO 决策树
// ============================================================

export {
  BOT_LEVELS,
  BOT_LEVEL_LABELS,
  LEVEL_PROFILE,
  TEXAS_LEVELS,
  TEXAS_LEVEL_LABELS,
  USE_LEGACY,
  analyzeBoard,
  assessStrength,
  botLevelLabel,
  botThinkDelayMs,
  buildBotView,
  chooseBotAction,
  decideBotTurn,
  derivePersona,
  detectDraws,
  equityPreflop,
  equityVsRange,
  getProfile,
  levelRank,
  normalizeBotLevel,
  normalizeTexasLevel,
  sanitizeAction,
  texasLevelLabel,
  thinkDelay,
} from './ai/index.js';

export { inferOpponentRange } from './ai/strategy.js';
