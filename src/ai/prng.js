// ============================================================
// 确定性随机源与卡牌编码
//
// 替换 bot-ai.js 里基于 SHA-256 的 seededRandom：实测每次调用 1.297µs，
// 而 mulberry32 只有 0.0055µs（236 倍）。MC 采样每个样本要洗约 45 张牌，
// 换掉后单样本从 53.8µs 降到 0.28µs，为大样本权益计算腾出预算。
// ============================================================

const RANK_CHAR = '23456789TJQKA';
const SUIT_CHAR = 'SHDC';

/**
 * 卡牌内部编码：0..51
 * 与 poker.js 的 createDeck() 顺序一致（花色外层、点数内层），
 * 便于在必要时与引擎侧结构对齐。
 */
export function cardId(card) {
  const rank = RANK_CHAR.indexOf(card[0]);
  const suit = SUIT_CHAR.indexOf(card[1]);
  if (rank < 0 || suit < 0) return -1;
  return suit * 13 + rank;
}

export function cardName(id) {
  if (!Number.isInteger(id) || id < 0 || id > 51) return '';
  return RANK_CHAR[id % 13] + SUIT_CHAR[(id / 13) | 0];
}

export function isCardId(value) {
  return Number.isInteger(value) && value >= 0 && value <= 51;
}

/** RANK_OF[id] → 2..14 */
export const RANK_OF = new Int8Array(52);
/** SUIT_OF[id] → 0..3 */
export const SUIT_OF = new Int8Array(52);
/** RANK_BIT[id] → 1 << rank（点数位掩码，bit 2..14） */
export const RANK_BIT = new Int32Array(52);

for (let i = 0; i < 52; i += 1) {
  const rank = (i % 13) + 2;
  RANK_OF[i] = rank;
  SUIT_OF[i] = (i / 13) | 0;
  RANK_BIT[i] = 1 << rank;
}

/** 整副牌的 id 数组（只读语义，调用方不要原地修改） */
export const ALL_CARDS = Array.from({ length: 52 }, (_, i) => i);

// ============================================================
// 伪随机数
// ============================================================

/** xmur3：把任意字符串散列成 32-bit 种子 */
export function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32：快、无状态泄漏、周期足够长 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 由任意可字符串化的素材构造独立随机源 */
export function makeRng(...parts) {
  return mulberry32(hashSeed(parts.map((part) => String(part ?? '')).join('|')));
}

/**
 * 随机抽取 need 张牌并把它们放到数组**前部**（部分 Fisher-Yates）。
 * 调用方取 cards.slice(0, need) 即为不重复的随机样本。
 *
 * 注意：不能只在数组尾部区间内洗牌 —— 那样每次抽样都来自同一小撮固定元素，
 * 而牌堆尾部的牌是按花色聚集的，会让蒙特卡洛结果严重失真。
 * need === cards.length 时等价于完整洗牌。
 */
export function partialShuffle(cards, rng, need) {
  const n = cards.length;
  const k = Math.max(0, Math.min(Math.trunc(need), n));
  for (let i = 0; i < k; i += 1) {
    const j = i + Math.floor(rng() * (n - i));
    const tmp = cards[i];
    cards[i] = cards[j];
    cards[j] = tmp;
  }
  return cards;
}

export function shuffleInPlace(cards, rng) {
  return partialShuffle(cards, rng, cards.length);
}

/** 标准正态噪声（Box-Muller），用于给弱档 AI 的权益估计加噪 */
export function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function pickIndex(rng, length) {
  return Math.min(length - 1, Math.floor(rng() * length));
}
