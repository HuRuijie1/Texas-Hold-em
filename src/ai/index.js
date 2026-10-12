// ============================================================
// AI 门面：引擎与前端只通过本模块访问 AI 能力
//
// 回滚开关：设置环境变量 AI_LEGACY=1 时，决策逻辑切回 legacy-core.js
// 的旧实现，无需改代码即可降级。
// ============================================================

import {
  chooseBotAction as gtoChooseBotAction,
  decideBotTurn as gtoDecideBotTurn,
} from './strategy.js';
import {
  chooseBotAction as legacyChooseBotAction,
  decideBotTurn as legacyDecideBotTurn,
} from './legacy-core.js';

export const USE_LEGACY = process.env.AI_LEGACY === '1';

export function chooseBotAction(room, player, actions) {
  return USE_LEGACY
    ? legacyChooseBotAction(room, player, actions)
    : gtoChooseBotAction(room, player, actions);
}

export function decideBotTurn(room, player, actions) {
  return USE_LEGACY
    ? legacyDecideBotTurn(room, player, actions)
    : gtoDecideBotTurn(room, player, actions);
}

export { buildBotView } from './view.js';
export { derivePersona } from './persona.js';
export { analyzeBoard, detectDraws } from './board.js';
export { equityVsRange, equityPreflop } from './equity.js';
export { sanitizeAction } from './strategy.js';

export {
  TEXAS_LEVELS as BOT_LEVELS,
  TEXAS_LEVEL_LABELS as BOT_LEVEL_LABELS,
  TEXAS_LEVELS,
  TEXAS_LEVEL_LABELS,
  TEXAS_LEVEL_ALIASES,
  LEVEL_PROFILE,
  botLevelLabel,
  botThinkTuning,
  getProfile,
  levelRank,
  normalizeBotLevel,
  normalizeTexasLevel,
  texasLevelLabel,
  thinkDelay,
} from './levels.js';

// 旧接口保留（引擎不使用，仅供外部脚本与回滚路径）
export { assessStrength, botThinkDelayMs } from './legacy-core.js';
