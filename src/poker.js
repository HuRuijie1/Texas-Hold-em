import { randomInt } from 'node:crypto';

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS = ['S', 'H', 'D', 'C'];
const RANK_VALUE = Object.fromEntries(RANKS.map((rank, index) => [rank, index + 2]));
const VALUE_RANK = Object.fromEntries(RANKS.map((rank, index) => [index + 2, rank]));
const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const CATEGORY_NAME = [
  '高牌',
  '一对',
  '两对',
  '三条',
  '顺子',
  '同花',
  '葫芦',
  '四条',
  '同花顺',
];

export function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(`${rank}${suit}`);
    }
  }
  return deck;
}

export function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function rankValue(card) {
  return RANK_VALUE[card[0]];
}

export function cardSuit(card) {
  return card[1];
}

export function formatCard(card) {
  if (!card) return '';
  return `${card[0]}${SUIT_SYMBOL[card[1]] ?? card[1]}`;
}

export function formatCards(cards) {
  return cards.map(formatCard);
}

export function compareHandRanks(a, b) {
  if (a.category !== b.category) {
    return a.category - b.category;
  }
  const length = Math.max(a.kickers.length, b.kickers.length);
  for (let i = 0; i < length; i += 1) {
    const left = a.kickers[i] ?? 0;
    const right = b.kickers[i] ?? 0;
    if (left !== right) {
      return left - right;
    }
  }
  return 0;
}

function highestStraight(ranks) {
  const values = [...new Set(ranks)];
  if (values.includes(14)) {
    values.push(1);
  }
  values.sort((a, b) => a - b);

  let best = 0;
  let run = 1;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] === values[i - 1] + 1) {
      run += 1;
      if (run >= 5) {
        best = values[i];
      }
    } else if (values[i] !== values[i - 1]) {
      run = 1;
    }
  }
  return best || null;
}

function countsByRank(ranks) {
  const counts = new Map();
  for (const rank of ranks) {
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
}

function topKickers(ranks, excluded, limit) {
  return ranks.filter((rank) => !excluded.has(rank)).sort((a, b) => b - a).slice(0, limit);
}

export function evaluateFiveCardHand(cards) {
  const ranks = cards.map(rankValue).sort((a, b) => b - a);
  const suits = cards.map(cardSuit);
  const flush = suits.every((suit) => suit === suits[0]);
  const straight = highestStraight(ranks);
  const groups = countsByRank(ranks);

  if (flush && straight) {
    return {
      category: 8,
      kickers: [straight],
      cards,
    };
  }

  if (groups[0].count === 4) {
    const quad = groups[0].rank;
    const kicker = topKickers(ranks, new Set([quad]), 1)[0];
    return { category: 7, kickers: [quad, kicker], cards };
  }

  if (groups[0].count === 3 && groups[1].count === 2) {
    return {
      category: 6,
      kickers: [groups[0].rank, groups[1].rank],
      cards,
    };
  }

  if (flush) {
    return { category: 5, kickers: ranks, cards };
  }

  if (straight) {
    return { category: 4, kickers: [straight], cards };
  }

  if (groups[0].count === 3) {
    const trips = groups[0].rank;
    const kickers = topKickers(ranks, new Set([trips]), 2);
    return { category: 3, kickers: [trips, ...kickers], cards };
  }

  if (groups[0].count === 2 && groups[1].count === 2) {
    const pairs = [groups[0].rank, groups[1].rank].sort((a, b) => b - a);
    const kicker = topKickers(ranks, new Set(pairs), 1)[0];
    return { category: 2, kickers: [...pairs, kicker], cards };
  }

  if (groups[0].count === 2) {
    const pair = groups[0].rank;
    const kickers = topKickers(ranks, new Set([pair]), 3);
    return { category: 1, kickers: [pair, ...kickers], cards };
  }

  return { category: 0, kickers: ranks, cards };
}

export function bestHandOfSeven(cards) {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error('bestHandOfSeven expects 5 to 7 cards');
  }

  let best = null;
  let bestCards = null;

  for (let i = 0; i < cards.length - 4; i += 1) {
    for (let j = i + 1; j < cards.length - 3; j += 1) {
      for (let k = j + 1; k < cards.length - 2; k += 1) {
        for (let l = k + 1; l < cards.length - 1; l += 1) {
          for (let m = l + 1; m < cards.length; m += 1) {
            const combo = [cards[i], cards[j], cards[k], cards[l], cards[m]];
            const rank = evaluateFiveCardHand(combo);
            if (!best || compareHandRanks(rank, best) > 0) {
              best = rank;
              bestCards = combo;
            }
          }
        }
      }
    }
  }

  return { ...best, cards: bestCards };
}

export function describeHandRank(rank) {
  if (!rank) return '';
  const label = CATEGORY_NAME[rank.category] ?? '牌型';
  const [first, second] = rank.kickers;
  const face = (value) => VALUE_RANK[value] ?? `${value}`;
  switch (rank.category) {
    case 8:
      return `${label} ${face(first)}高`;
    case 7:
      return `${label} ${face(first)}`;
    case 6:
      return `${label} ${face(first)}带${face(second)}`;
    case 5:
      return `${label} ${face(first)}高`;
    case 4:
      return `${label} ${face(first)}高`;
    case 3:
      return `${label} ${face(first)}`;
    case 2:
      return `${label} ${face(first)}和${face(second)}`;
    case 1:
      return `${label} ${face(first)}`;
    default:
      return `${label} ${face(first)}`;
  }
}

export function seatOrderFrom(startSeat, maxSeats) {
  const order = [];
  for (let i = 1; i <= maxSeats; i += 1) {
    order.push((startSeat + i) % maxSeats);
  }
  return order;
}

export function rankToFace(value) {
  return VALUE_RANK[value] ?? `${value}`;
}
