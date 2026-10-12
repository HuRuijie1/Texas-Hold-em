// ============================================================
// 旧版三档难度（炸金花 / 干瞪眼专用 + 德州旧存档兼容）
//
// 德州已经改用五档扑克风格等级（见 src/ai/levels.js）。
// 炸金花与干瞪眼的 AI 没有做 GTO 改造，继续用这套三档枚举。
//
// 隔离保证：本模块的 normalizeBotLevel 只认三个旧 id，
// 收到任何未知值（包括新的 'gto'）一律兜底为 'beginner'，
// 因此即使漏改某个 import 也永远不会抛错。
// ============================================================

export const BOT_LEVELS = ['beginner', 'intermediate', 'advanced'];

export const BOT_LEVEL_LABELS = {
  beginner: '初级',
  intermediate: '中级',
  advanced: '高级',
};

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
