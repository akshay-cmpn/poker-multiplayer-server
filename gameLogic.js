// Card and deck utilities
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

const HAND_RANKINGS = {
  HIGH_CARD: 1,
  PAIR: 2,
  TWO_PAIR: 3,
  THREE_OF_A_KIND: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  FOUR_OF_A_KIND: 8,
  STRAIGHT_FLUSH: 9,
  ROYAL_FLUSH: 10,
};

export function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, faceUp: false });
    }
  }
  return deck;
}

export function shuffleDeck(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function dealCards(deck, count) {
  const cards = deck.slice(0, count);
  const remainingDeck = deck.slice(count);
  return { cards, remainingDeck };
}

// Hand evaluation
function sortByRank(cards) {
  return [...cards].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);
}

function groupBySuit(cards) {
  const groups = new Map();
  for (const card of cards) {
    const existing = groups.get(card.suit) || [];
    groups.set(card.suit, [...existing, card]);
  }
  return groups;
}

function groupByRank(cards) {
  const groups = new Map();
  for (const card of cards) {
    const existing = groups.get(card.rank) || [];
    groups.set(card.rank, [...existing, card]);
  }
  return groups;
}

function findFlush(cards) {
  const bySuit = groupBySuit(cards);
  for (const [, suited] of bySuit) {
    if (suited.length >= 5) {
      return sortByRank(suited).slice(0, 5);
    }
  }
  return null;
}

function findStraight(cards) {
  const uniqueRanks = new Map();
  for (const card of cards) {
    const value = RANK_VALUES[card.rank];
    if (!uniqueRanks.has(value)) {
      uniqueRanks.set(value, card);
    }
  }

  const ace = cards.find(c => c.rank === 'A');
  if (ace) {
    uniqueRanks.set(1, ace);
  }

  const values = Array.from(uniqueRanks.keys()).sort((a, b) => b - a);

  for (let i = 0; i <= values.length - 5; i++) {
    const sequence = [];
    let isSequence = true;

    for (let j = 0; j < 5; j++) {
      const expectedValue = values[i] - j;
      if (values[i + j] !== expectedValue) {
        isSequence = false;
        break;
      }
      sequence.push(uniqueRanks.get(expectedValue));
    }

    if (isSequence) {
      return sequence;
    }
  }

  return null;
}

function findStraightFlush(cards) {
  const bySuit = groupBySuit(cards);
  for (const [, suited] of bySuit) {
    if (suited.length >= 5) {
      const straight = findStraight(suited);
      if (straight) {
        return straight;
      }
    }
  }
  return null;
}

export function evaluateHand(holeCards, communityCards) {
  const allCards = [...holeCards, ...communityCards];
  const sorted = sortByRank(allCards);
  const byRank = groupByRank(allCards);

  const straightFlush = findStraightFlush(allCards);
  if (straightFlush) {
    const isRoyal = RANK_VALUES[straightFlush[0].rank] === 14;
    return {
      rank: isRoyal ? HAND_RANKINGS.ROYAL_FLUSH : HAND_RANKINGS.STRAIGHT_FLUSH,
      name: isRoyal ? 'Royal Flush' : 'Straight Flush',
      cards: straightFlush,
      kickers: [],
    };
  }

  const pairs = [];
  const threes = [];
  const fours = [];

  for (const [, group] of byRank) {
    if (group.length === 4) fours.push(group);
    else if (group.length === 3) threes.push(group);
    else if (group.length === 2) pairs.push(group);
  }

  pairs.sort((a, b) => RANK_VALUES[b[0].rank] - RANK_VALUES[a[0].rank]);
  threes.sort((a, b) => RANK_VALUES[b[0].rank] - RANK_VALUES[a[0].rank]);
  fours.sort((a, b) => RANK_VALUES[b[0].rank] - RANK_VALUES[a[0].rank]);

  if (fours.length > 0) {
    const kickers = sorted.filter(c => c.rank !== fours[0][0].rank).slice(0, 1);
    return {
      rank: HAND_RANKINGS.FOUR_OF_A_KIND,
      name: 'Four of a Kind',
      cards: fours[0],
      kickers,
    };
  }

  if (threes.length > 0 && (pairs.length > 0 || threes.length > 1)) {
    const tripCards = threes[0];
    const pairCards = threes.length > 1 ? threes[1].slice(0, 2) : pairs[0];
    return {
      rank: HAND_RANKINGS.FULL_HOUSE,
      name: 'Full House',
      cards: [...tripCards, ...pairCards],
      kickers: [],
    };
  }

  const flush = findFlush(allCards);
  if (flush) {
    return {
      rank: HAND_RANKINGS.FLUSH,
      name: 'Flush',
      cards: flush,
      kickers: [],
    };
  }

  const straight = findStraight(allCards);
  if (straight) {
    return {
      rank: HAND_RANKINGS.STRAIGHT,
      name: 'Straight',
      cards: straight,
      kickers: [],
    };
  }

  if (threes.length > 0) {
    const kickers = sorted.filter(c => c.rank !== threes[0][0].rank).slice(0, 2);
    return {
      rank: HAND_RANKINGS.THREE_OF_A_KIND,
      name: 'Three of a Kind',
      cards: threes[0],
      kickers,
    };
  }

  if (pairs.length >= 2) {
    const usedRanks = [pairs[0][0].rank, pairs[1][0].rank];
    const kickers = sorted.filter(c => !usedRanks.includes(c.rank)).slice(0, 1);
    return {
      rank: HAND_RANKINGS.TWO_PAIR,
      name: 'Two Pair',
      cards: [...pairs[0], ...pairs[1]],
      kickers,
    };
  }

  if (pairs.length === 1) {
    const kickers = sorted.filter(c => c.rank !== pairs[0][0].rank).slice(0, 3);
    return {
      rank: HAND_RANKINGS.PAIR,
      name: 'Pair',
      cards: pairs[0],
      kickers,
    };
  }

  return {
    rank: HAND_RANKINGS.HIGH_CARD,
    name: 'High Card',
    cards: sorted.slice(0, 1),
    kickers: sorted.slice(1, 5),
  };
}

export function compareHands(hand1, hand2) {
  if (hand1.rank !== hand2.rank) {
    return hand1.rank - hand2.rank;
  }

  for (let i = 0; i < hand1.cards.length && i < hand2.cards.length; i++) {
    const diff = RANK_VALUES[hand1.cards[i].rank] - RANK_VALUES[hand2.cards[i].rank];
    if (diff !== 0) return diff;
  }

  for (let i = 0; i < hand1.kickers.length && i < hand2.kickers.length; i++) {
    const diff = RANK_VALUES[hand1.kickers[i].rank] - RANK_VALUES[hand2.kickers[i].rank];
    if (diff !== 0) return diff;
  }

  return 0;
}
