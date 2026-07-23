/**
 * mini-trick — reference GameAdapter implementation (DESIGN.md §8 item 5).
 *
 * A minimal 2-player trick-taking game used to prove the full onboarding →
 * conformance → loop pipeline end to end:
 *
 *   - Deck: 2 suits (A, B) x ranks 1-8 = 16 cards.
 *   - Deal: 6 cards to each player, 4 cards left face down as a hidden stock.
 *   - 6 tricks: the leader plays any card; the follower must follow suit if
 *     able, otherwise may play anything. Highest rank of the led suit wins
 *     the trick and leads the next one. Player 0 always leads the first
 *     trick — an intentional first-move bias for the C5 baselines axis.
 *   - Outcome: scores = [tricks won by 0, tricks won by 1]; ties (3-3) list
 *     both players as winners.
 *
 * All randomness flows through `createRng`/`shuffled` from ../kernel/rng —
 * no Date.now()/Math.random() anywhere in this file (determinism rule, C1).
 */

import type {
  BotFactory,
  GameAdapter,
  GameBot,
  HiddenInfoProbe,
  Outcome,
  PendingDecision,
  PlayerId,
  ReplayFixture,
  StrategyFlagSpec,
} from '../contract/types';
import { canonicalJson, sha256Digest } from '../kernel/digest';
import { createRng, shuffled } from '../kernel/rng';

export type Suit = 'A' | 'B';

export interface MiniTrickCard {
  readonly suit: Suit;
  readonly rank: number; // 1..8
}

export interface MiniTrickTrickEntry {
  readonly player: PlayerId;
  readonly card: MiniTrickCard;
}

export interface MiniTrickState {
  /** hands[player] = that player's current hand. */
  readonly hands: readonly [
    readonly MiniTrickCard[],
    readonly MiniTrickCard[],
  ];
  /** Face-down cards nobody has been dealt. Never exposed via getObservation. */
  readonly stock: readonly MiniTrickCard[];
  /** Cards played in the trick currently in progress (0, then 1 entries). */
  readonly trick: readonly MiniTrickTrickEntry[];
  /** Who leads the trick currently in progress. */
  readonly leader: PlayerId;
  readonly trickWins: readonly [number, number];
  readonly tricksCompleted: number;
  /**
   * Every completed trick's two plays, in the order they were played, in the
   * order the tricks were completed (docs/GAP-ANALYSIS-7.md §3). In
   * trick-taking games every card played is public information the instant
   * it lands, so retaining this history (rather than discarding it once a
   * trick resolves, as the pre-perfect-recall version of this adapter did)
   * costs no hidden-information leak — it is exactly what a real player
   * watching the table would remember.
   */
  readonly completedTricks: readonly (readonly MiniTrickTrickEntry[])[];
}

export interface MiniTrickObservation {
  readonly self: PlayerId;
  readonly hand: readonly MiniTrickCard[];
  readonly currentTrick: readonly MiniTrickTrickEntry[];
  readonly trickWins: readonly [number, number];
  readonly isLeader: boolean;
  readonly tricksCompleted: number;
  /** Public history of completed tricks — see MiniTrickState.completedTricks. */
  readonly completedTricks: readonly (readonly MiniTrickTrickEntry[])[];
}

export type MiniTrickChoice = MiniTrickCard;

const SUITS: readonly Suit[] = ['A', 'B'];
const RANKS_PER_SUIT = 8;
const HAND_SIZE = 6;
const TOTAL_TRICKS = 6;
const TOTAL_CARDS = SUITS.length * RANKS_PER_SUIT; // 16

function otherPlayer(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

function fullDeck(): MiniTrickCard[] {
  const deck: MiniTrickCard[] = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= RANKS_PER_SUIT; rank += 1) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

function sameCard(a: MiniTrickCard, b: MiniTrickCard): boolean {
  return a.suit === b.suit && a.rank === b.rank;
}

function cardKey(card: MiniTrickCard): string {
  return `${card.suit}${card.rank}`;
}

function removeOne(
  hand: readonly MiniTrickCard[],
  card: MiniTrickCard,
): MiniTrickCard[] {
  const index = hand.findIndex((candidate) => sameCard(candidate, card));
  if (index === -1) {
    throw new Error(`removeOne: card ${cardKey(card)} not found in hand`);
  }
  const result = hand.slice();
  result.splice(index, 1);
  return result;
}

function compareCards(a: MiniTrickCard, b: MiniTrickCard): number {
  if (a.suit !== b.suit) {
    return a.suit < b.suit ? -1 : 1;
  }
  return a.rank - b.rank;
}

// Both helpers break ties by suit so the result depends only on the input
// multiset, never on array order — required for noopSort to be a true no-op.
function lowestRank(cards: readonly MiniTrickCard[]): MiniTrickCard {
  return cards.reduce((min, card) => {
    if (card.rank < min.rank) return card;
    if (card.rank === min.rank && card.suit < min.suit) return card;
    return min;
  });
}

function highestRank(cards: readonly MiniTrickCard[]): MiniTrickCard {
  return cards.reduce((max, card) => {
    if (card.rank > max.rank) return card;
    if (card.rank === max.rank && card.suit < max.suit) return card;
    return max;
  });
}

function createInitialState(seed: number): MiniTrickState {
  const rng = createRng(seed);
  const deck = shuffled(fullDeck(), rng);
  const hand0 = deck.slice(0, HAND_SIZE);
  const hand1 = deck.slice(HAND_SIZE, HAND_SIZE * 2);
  const stock = deck.slice(HAND_SIZE * 2);
  return {
    hands: [hand0, hand1],
    stock,
    trick: [],
    leader: 0,
    trickWins: [0, 0],
    tricksCompleted: 0,
    completedTricks: [],
  };
}

function currentDecision(state: MiniTrickState): PendingDecision | null {
  if (state.tricksCompleted >= TOTAL_TRICKS) {
    return null;
  }
  const player = state.trick.length === 0 ? state.leader : otherPlayer(state.leader);
  return { player, decisionPoint: 'play' };
}

function handOf(state: MiniTrickState, player: PlayerId): readonly MiniTrickCard[] {
  return player === 0 ? state.hands[0] : state.hands[1];
}

function getLegalChoices(state: MiniTrickState): readonly MiniTrickCard[] {
  const decision = currentDecision(state);
  if (!decision) {
    throw new Error('getLegalChoices: game is already over');
  }
  const hand = handOf(state, decision.player);
  if (state.trick.length === 0) {
    return hand.slice();
  }
  const leadEntry = state.trick[0];
  if (!leadEntry) {
    throw new Error('getLegalChoices: trick in progress has no lead entry');
  }
  const leadSuit = leadEntry.card.suit;
  const following = hand.filter((card) => card.suit === leadSuit);
  return following.length > 0 ? following : hand.slice();
}

function getObservation(
  state: MiniTrickState,
  player: PlayerId,
): MiniTrickObservation {
  return {
    self: player,
    hand: handOf(state, player),
    currentTrick: state.trick,
    trickWins: state.trickWins,
    isLeader: state.leader === player,
    tricksCompleted: state.tricksCompleted,
    completedTricks: state.completedTricks,
  };
}

function applyChoice(
  state: MiniTrickState,
  choice: MiniTrickCard,
): MiniTrickState {
  const decision = currentDecision(state);
  if (!decision) {
    throw new Error('applyChoice: game is already over');
  }
  const legal = getLegalChoices(state);
  if (!legal.some((card) => sameCard(card, choice))) {
    throw new Error(
      `applyChoice: ${cardKey(choice)} is not a legal choice (legal: ${legal
        .map(cardKey)
        .join(', ')})`,
    );
  }

  const player = decision.player;
  const newHand = removeOne(handOf(state, player), choice);
  const hands: [readonly MiniTrickCard[], readonly MiniTrickCard[]] =
    player === 0 ? [newHand, state.hands[1]] : [state.hands[0], newHand];
  const trick = [...state.trick, { player, card: choice }];

  if (trick.length < 2) {
    return {
      ...state,
      hands,
      trick,
    };
  }

  const leadEntry = trick[0];
  const followEntry = trick[1];
  if (!leadEntry || !followEntry) {
    throw new Error('applyChoice: resolved trick missing entries');
  }
  const leadSuit = leadEntry.card.suit;
  const followerWins =
    followEntry.card.suit === leadSuit && followEntry.card.rank > leadEntry.card.rank;
  const winner = followerWins ? followEntry.player : leadEntry.player;
  const trickWins: [number, number] =
    winner === 0
      ? [state.trickWins[0] + 1, state.trickWins[1]]
      : [state.trickWins[0], state.trickWins[1] + 1];

  return {
    ...state,
    hands,
    trick: [],
    leader: winner,
    trickWins,
    tricksCompleted: state.tricksCompleted + 1,
    completedTricks: [...state.completedTricks, trick],
  };
}

function getOutcome(state: MiniTrickState): Outcome | null {
  if (currentDecision(state) !== null) {
    return null;
  }
  const [wins0, wins1] = state.trickWins;
  const scores = [wins0, wins1];
  let winners: PlayerId[];
  if (wins0 > wins1) {
    winners = [0];
  } else if (wins1 > wins0) {
    winners = [1];
  } else {
    winners = [0, 1];
  }
  return { scores, winners };
}

function encodeChoice(choice: MiniTrickCard): string {
  return cardKey(choice);
}

/**
 * Information-state key for CFR-family learning (docs/GAP-ANALYSIS-7.md
 * O7-b, absorbed from OpenSpiel's information_state_string). Built from
 * exactly the fields `getObservation` already exposes to the viewing player
 * (their own hand, the running trick-win tally, how many tricks have
 * completed, the trick in progress, and — since perfect recall was closed,
 * see below — the full public history of completed-trick cards) —
 * deliberately the same digest formula `src/learn/mccfr.ts`'s fallback path
 * uses, since a bot's `decide` only ever receives an observation (never a
 * state) and must be able to reconstruct this same key at decision time.
 *
 * Perfect recall now holds: `MiniTrickState.completedTricks` retains every
 * completed trick's cards (all public information the instant they're
 * played — see the field doc on `MiniTrickState.completedTricks`), and
 * `getObservation` exposes that history, so two states that share
 * {hand, trickWins, tricksCompleted, trick} but were reached by a different
 * sequence of completed-trick cards now produce different keys — the gap
 * flagged in docs/GAP-ANALYSIS-7.md §3 ("mini-trick의 state가 완료 트릭의
 * 카드 이력을 버려 현재로선 불가") is closed. This key remains, by
 * construction, a pure function of (decisionPoint, observation) — required
 * so that `policyBotFactory` (which only ever sees an observation at replay
 * time) can reproduce the same key training produced.
 */
function informationStateKey(state: MiniTrickState, player: PlayerId): string {
  return sha256Digest(
    canonicalJson({ decisionPoint: 'play', observation: getObservation(state, player) }),
  );
}

function cardConservationInvariant(state: MiniTrickState): string | null {
  if (state.completedTricks.length !== state.tricksCompleted) {
    return `completedTricks length (${state.completedTricks.length}) does not match tricksCompleted (${state.tricksCompleted})`;
  }
  const completedCardCount = state.completedTricks.reduce((sum, trick) => sum + trick.length, 0);
  const total =
    state.hands[0].length +
    state.hands[1].length +
    state.stock.length +
    state.trick.length +
    completedCardCount;
  return total === TOTAL_CARDS
    ? null
    : `card conservation violated: current+historical total is ${total}, expected ${TOTAL_CARDS}`;
}

// "Visible" here means everywhere a card's identity is known to at least one
// party at the time of the check: own/opponent hands, the stock (known only
// to the dealer/adapter, never a player), the trick in progress, and every
// completed trick's history (public the instant those cards were played —
// see MiniTrickState.completedTricks). Hidden-info integrity is unaffected:
// hands[1]/stock stay opaque to player 0's observation regardless of this
// invariant, which only checks for duplicate card identities across state.
function noDuplicateVisibleCardsInvariant(state: MiniTrickState): string | null {
  const visible = [
    ...state.hands[0],
    ...state.hands[1],
    ...state.stock,
    ...state.trick.map((entry) => entry.card),
    ...state.completedTricks.flatMap((trick) => trick.map((entry) => entry.card)),
  ];
  const seen = new Set<string>();
  for (const card of visible) {
    const key = cardKey(card);
    if (seen.has(key)) {
      return `duplicate card ${key} found among currently visible cards`;
    }
    seen.add(key);
  }
  return null;
}

function arraysOfCardsEqual(
  a: readonly MiniTrickCard[],
  b: readonly MiniTrickCard[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((card, index) => {
    const other = b[index];
    return other !== undefined && sameCard(card, other);
  });
}

const hiddenInfoProbe: HiddenInfoProbe<MiniTrickState> = {
  mutateHidden(state, viewer, rng) {
    const opponent = otherPlayer(viewer);
    const opponentHand = handOf(state, opponent);
    const pool = [...opponentHand, ...state.stock];
    if (pool.length <= 1) {
      // 0 or 1 hidden cards: no reshuffle can change anything meaningful.
      return null;
    }

    let shuffledPool = shuffled(pool, rng);
    if (arraysOfCardsEqual(shuffledPool, pool)) {
      // Force an observable difference (extremely unlikely to be needed).
      const swapped = shuffledPool.slice();
      const first = swapped[0];
      const second = swapped[1];
      if (first !== undefined && second !== undefined) {
        swapped[0] = second;
        swapped[1] = first;
      }
      shuffledPool = swapped;
    }

    const newOpponentHand = shuffledPool.slice(0, opponentHand.length);
    const newStock = shuffledPool.slice(opponentHand.length);
    const hands: [readonly MiniTrickCard[], readonly MiniTrickCard[]] =
      viewer === 0
        ? [state.hands[0], newOpponentHand]
        : [newOpponentHand, state.hands[1]];

    return {
      ...state,
      hands,
      stock: newStock,
    };
  },
};

const randomBaseline: BotFactory<MiniTrickObservation, MiniTrickChoice> = (
  seed,
) => {
  const rng = createRng(seed);
  return {
    id: 'mini-trick-random',
    decide(_decisionPoint, _observation, legal) {
      return legal[rng.nextInt(legal.length)] as MiniTrickChoice;
    },
  };
};

const heuristicBaseline: BotFactory<MiniTrickObservation, MiniTrickChoice> = (
  _seed,
) => {
  return {
    id: 'mini-trick-heuristic',
    decide(_decisionPoint, _observation, legal) {
      return lowestRank(legal);
    },
  };
};

function wrapBotId(bot: GameBot<MiniTrickObservation, MiniTrickChoice>, suffix: string) {
  return `${bot.id}+${suffix}`;
}

/** Strategy flag: effective. When following and able to win, play the cheapest
 * winning card; when unable to win, dump the cheapest card. Leads are
 * delegated to the base bot untouched. */
const winCheapest: StrategyFlagSpec<MiniTrickObservation, MiniTrickChoice> = {
  flag: 'winCheapest',
  description:
    'When following, win as cheaply as possible or dump the lowest rank if unable to win. Leads delegate to base.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot, 'winCheapest'),
        decide(decisionPoint, observation, legal) {
          if (observation.isLeader || observation.currentTrick.length === 0) {
            return bot.decide(decisionPoint, observation, legal);
          }
          const leadEntry = observation.currentTrick[0];
          if (!leadEntry) {
            return bot.decide(decisionPoint, observation, legal);
          }
          const winningCandidates = legal.filter(
            (card) =>
              card.suit === leadEntry.card.suit && card.rank > leadEntry.card.rank,
          );
          if (winningCandidates.length > 0) {
            return lowestRank(winningCandidates);
          }
          return lowestRank(legal);
        },
      };
    };
  },
};

/** Strategy flag: no-op. Sorts the legal list before delegating — the base
 * bot's decision must be order-invariant, so this must select identically to
 * calling the base bot directly. Used to demonstrate behavioral-fingerprint
 * screening rejecting no-ops. */
const noopSort: StrategyFlagSpec<MiniTrickObservation, MiniTrickChoice> = {
  flag: 'noopSort',
  description:
    'Sorts legal choices before delegating to the base bot; does not change behavior.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot, 'noopSort'),
        decide(decisionPoint, observation, legal) {
          const sorted = [...legal].sort(compareCards);
          return bot.decide(decisionPoint, observation, sorted);
        },
      };
    };
  },
};

/** Strategy flag: marginal. When leading, always lead the highest rank card;
 * following is delegated to the base bot. */
const leadHighFirst: StrategyFlagSpec<MiniTrickObservation, MiniTrickChoice> = {
  flag: 'leadHighFirst',
  description: 'When leading, plays the highest rank card. Follows delegate to base.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot, 'leadHighFirst'),
        decide(decisionPoint, observation, legal) {
          if (observation.isLeader && observation.currentTrick.length === 0) {
            return highestRank(legal);
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/**
 * Replay fixtures: random-vs-random self-play, captured once by actually
 * running this adapter (see the generation note in
 * src/reference/__tests__/mini-trick.test.ts) and then hardcoded here. Not
 * hand-simulated.
 */
const replayFixtures: readonly ReplayFixture[] = [
  {
    id: 'mini-trick-seed-11',
    seed: 11,
    choiceKeys: [
      'A2',
      'A6',
      'A1',
      'A3',
      'B4',
      'B3',
      'A7',
      'A5',
      'B5',
      'B6',
      'A4',
      'B2',
    ],
    finalScores: [3, 3],
  },
  {
    id: 'mini-trick-seed-22',
    seed: 22,
    choiceKeys: [
      'B3',
      'B8',
      'A6',
      'A2',
      'B4',
      'B5',
      'B6',
      'A5',
      'A8',
      'A7',
      'B1',
      'A1',
    ],
    finalScores: [4, 2],
  },
  {
    id: 'mini-trick-seed-33',
    seed: 33,
    choiceKeys: [
      'B5',
      'B2',
      'A5',
      'A6',
      'A3',
      'A2',
      'A8',
      'A4',
      'A7',
      'B6',
      'B7',
      'B3',
    ],
    finalScores: [1, 5],
  },
];

export const miniTrickAdapter: GameAdapter<
  MiniTrickState,
  MiniTrickObservation,
  MiniTrickChoice
> = {
  spec: {
    gameId: 'mini-trick',
    playerCount: 2,
    decisionPoints: [
      {
        id: 'play',
        description: 'Play one legal card into the trick currently in progress.',
      },
    ],
    seatingPlan: [
      [0, 1],
      [1, 0],
    ],
    maxDecisionsPerGame: 20,
    // Every game distributes exactly TOTAL_TRICKS (6) trick wins between the
    // two players, so scores[0] + scores[1] is always 6: a constant-sum
    // payoff, equivalent to zero-sum after centering (docs/GAP-ANALYSIS-7.md
    // O7-b). Feeds classifyGame's utilityStructure and mccfr.ts's CFR
    // convergence-guarantee precondition.
    utility: 'zero-sum',
  },
  createInitialState,
  currentDecision,
  getObservation,
  getLegalChoices,
  applyChoice,
  getOutcome,
  encodeChoice,
  invariants: [cardConservationInvariant, noDuplicateVisibleCardsInvariant],
  hiddenInfoProbe,
  replayFixtures,
  informationStateKey,
  baselines: {
    random: randomBaseline,
    heuristic: heuristicBaseline,
  },
  strategySurface: [winCheapest, noopSort, leadHighFirst],
};
