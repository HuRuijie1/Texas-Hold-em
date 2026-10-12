// ============================================================
// 人格系统：由 bot token 派生的稳定特质
//
// 同一个 bot 全程行为一致，不同 bot 之间有可辨识的个体差异 —— 这是
// 「像人」而不是「像一台 AI」的关键：玩家应该能感觉到「3 号位那个很凶」。
//
// 人格与等级是正交的两层：等级决定会不会算、算多准；人格决定偏好。
// ============================================================

import { makeRng } from './prng.js';

const MAX_CACHE = 1000;
const personaCache = new Map();

export function derivePersona(token) {
  const key = String(token ?? '');
  if (personaCache.has(key)) return personaCache.get(key);

  const rng = makeRng('persona-v2', key);
  const persona = {
    /** 加注频率与加注尺度倍率 */
    aggression: 0.85 + rng() * 0.3, // 0.85 ~ 1.15
    /** 诈唬频率倍率 */
    bluff: 0.6 + rng() * 0.8, // 0.60 ~ 1.40
    /** 松紧偏移：负值更紧（弃牌阈值上调），正值更松 */
    tightness: (rng() - 0.5) * 0.06, // -0.03 ~ +0.03
    /** 慢打倾向：强牌挖坑的概率基础 */
    trap: rng() * 0.35, // 0 ~ 0.35
    /** 持续下注频率倍率 */
    cbet: 0.75 + rng() * 0.45, // 0.75 ~ 1.20
    /** 思考时长倍率：有人果断有人磨蹭 */
    thinkScale: 0.85 + rng() * 0.4, // 0.85 ~ 1.25
    /** 跟注站倾向：面对大注仍倾向于跟 */
    callStation: rng() * 0.3, // 0 ~ 0.30
    /** 下注尺度倍率 */
    sizeBias: 0.85 + rng() * 0.35, // 0.85 ~ 1.20
    /** 摊牌好奇心：更倾向于看到摊牌而不是早早弃牌 */
    showdownCurious: rng() * 0.25, // 0 ~ 0.25
  };

  // FIFO 淘汰，避免长期运行的房间无限增长（每个条目很小，1000 个足够）
  if (personaCache.size >= MAX_CACHE) {
    const oldest = personaCache.keys().next().value;
    personaCache.delete(oldest);
  }
  personaCache.set(key, persona);
  return persona;
}

export function personaCacheSize() {
  return personaCache.size;
}

/** 供测试清理用 */
export function clearPersonaCache() {
  personaCache.clear();
}
