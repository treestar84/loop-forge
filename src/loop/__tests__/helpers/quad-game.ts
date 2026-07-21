/**
 * quad-game — test-only 4-player fixture (B2: multi-seat verification).
 *
 * Not a GameAdapter meant for onboarding; exists purely to exercise
 * runPairedBlock/calibrateIdentity's 3-4 player and team-aware code paths
 * with something simpler than mini-trick (which is 2-player only).
 *
 * Rules: 12 unique-rank cards (1..12) are shuffled and dealt 3 each to 4
 * players. Across 3 rounds, every player reveals their next card in a fixed
 * turn order (player 0, 1, 2, 3 each round) — there is exactly one legal
 * choice at every decision point, so bot strategy cannot affect the outcome;
 * only the seeded deal decides the result. After all cards are revealed:
 *
 *   - Free-for-all variant (`quadGameFreeForAll`): scores[p] = sum of p's
 *     revealed cards; winners = the player(s) with the highest sum.
 *   - Teamed variant (`quadGameTeamed`, teams: [[0,2],[1,3]]): scores[p] =
 *     p's team's summed total (Outcome's "team games repeat the team score"
 *     convention); winners = every member of the highest-total team(s).
 *
 * All randomness flows through createRng/shuffled (../../kernel/rng) — no
 * Date.now()/Math.random() anywhere in this file (C1 determinism rule).
 */

import type {
  BotFactory,
  GameAdapter,
  Outcome,
  PendingDecision,
  PlayerId,
} from '../../../contract/types';
import { createRng, shuffled } from '../../../kernel/rng';

const PLAYER_COUNT = 4;
const CARDS_PER_PLAYER = 3;
const TOTAL_CARDS = PLAYER_COUNT * CARDS_PER_PLAYER; // 12
const TURN_ORDER: readonly PlayerId[] = [0, 1, 2, 3];

export interface QuadGameState {
  /** hands[player] = that player's still-unrevealed cards, in reveal order. */
  readonly hands: readonly (readonly number[])[];
  /** revealed[player] = cards that player has revealed so far. */
  readonly revealed: readonly (readonly number[])[];
  readonly turnsTaken: number;
}

export interface QuadGameObservation {
  readonly self: PlayerId;
  readonly ownHand: readonly number[];
  readonly revealed: readonly (readonly number[])[];
  readonly turnsTaken: number;
}

export type QuadGameChoice = number; // the card value being revealed

function fullDeck(): number[] {
  return Array.from({ length: TOTAL_CARDS }, (_, i) => i + 1);
}

function createInitialState(seed: number): QuadGameState {
  const rng = createRng(seed);
  const deck = shuffled(fullDeck(), rng);
  const hands: number[][] = [];
  for (let p = 0; p < PLAYER_COUNT; p += 1) {
    hands.push(deck.slice(p * CARDS_PER_PLAYER, (p + 1) * CARDS_PER_PLAYER));
  }
  return {
    hands,
    revealed: hands.map(() => []),
    turnsTaken: 0,
  };
}

function currentDecision(state: QuadGameState): PendingDecision | null {
  if (state.turnsTaken >= TOTAL_CARDS) {
    return null;
  }
  const player = TURN_ORDER[state.turnsTaken % PLAYER_COUNT] as PlayerId;
  return { player, decisionPoint: 'reveal' };
}

function getLegalChoices(state: QuadGameState): readonly QuadGameChoice[] {
  const decision = currentDecision(state);
  if (!decision) {
    throw new Error('getLegalChoices: game is already over');
  }
  const hand = state.hands[decision.player];
  if (!hand || hand.length === 0) {
    throw new Error(`getLegalChoices: player ${decision.player} has no cards left`);
  }
  // Exactly one legal choice: the next card in reveal order.
  return [hand[0] as number];
}

function getObservation(state: QuadGameState, player: PlayerId): QuadGameObservation {
  return {
    self: player,
    ownHand: state.hands[player] ?? [],
    revealed: state.revealed,
    turnsTaken: state.turnsTaken,
  };
}

function applyChoice(state: QuadGameState, choice: QuadGameChoice): QuadGameState {
  const decision = currentDecision(state);
  if (!decision) {
    throw new Error('applyChoice: game is already over');
  }
  const legal = getLegalChoices(state);
  if (!legal.includes(choice)) {
    throw new Error(`applyChoice: ${choice} is not a legal choice (legal: ${legal.join(', ')})`);
  }
  const player = decision.player;
  const hands = state.hands.map((hand, index) => (index === player ? hand.slice(1) : hand));
  const revealed = state.revealed.map((cards, index) =>
    index === player ? [...cards, choice] : cards,
  );
  return { hands, revealed, turnsTaken: state.turnsTaken + 1 };
}

function playerSum(state: QuadGameState, player: PlayerId): number {
  return (state.revealed[player] ?? []).reduce((sum, card) => sum + card, 0);
}

function getOutcomeFreeForAll(state: QuadGameState): Outcome | null {
  if (currentDecision(state) !== null) {
    return null;
  }
  const scores = TURN_ORDER.map((player) => playerSum(state, player));
  const max = Math.max(...scores);
  const winners = TURN_ORDER.filter((player) => scores[player] === max);
  return { scores, winners };
}

const TEAMS: readonly (readonly PlayerId[])[] = [
  [0, 2],
  [1, 3],
];

function getOutcomeTeamed(state: QuadGameState): Outcome | null {
  if (currentDecision(state) !== null) {
    return null;
  }
  const teamTotals = TEAMS.map((team) =>
    team.reduce((sum, player) => sum + playerSum(state, player), 0),
  );
  const maxTotal = Math.max(...teamTotals);
  const winningTeamIndices = teamTotals
    .map((total, index) => (total === maxTotal ? index : -1))
    .filter((index) => index !== -1);
  const winners = winningTeamIndices.flatMap((teamIndex) => TEAMS[teamIndex] ?? []);
  const scores = TURN_ORDER.map((player) => {
    const teamIndex = TEAMS.findIndex((team) => team.includes(player));
    return teamTotals[teamIndex] ?? 0;
  });
  return { scores, winners };
}

function encodeChoice(choice: QuadGameChoice): string {
  return `card${choice}`;
}

function cardConservationInvariant(state: QuadGameState): string | null {
  const seen = new Set<number>();
  for (const hand of state.hands) {
    for (const card of hand) seen.add(card);
  }
  for (const cards of state.revealed) {
    for (const card of cards) seen.add(card);
  }
  return seen.size === TOTAL_CARDS
    ? null
    : `card conservation violated: ${seen.size} distinct cards visible, expected ${TOTAL_CARDS}`;
}

const identityBot: BotFactory<QuadGameObservation, QuadGameChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'quad-game-identity',
    decide(_decisionPoint, _observation, legal) {
      // legal always has exactly one element, so random vs heuristic behave
      // identically here — the deal alone determines the outcome.
      return legal[rng.nextInt(legal.length)] as QuadGameChoice;
    },
  };
};

// Rotations covering the candidate (bot slot 0) at every seat, satisfying
// the seatingPlan coverage requirement (C0) for a 4-player game.
const SEATING_PLAN = [
  [0, 1, 2, 3],
  [1, 2, 3, 0],
  [2, 3, 0, 1],
  [3, 0, 1, 2],
] as const;

/** Free-for-all variant: no team declaration. */
export const quadGameFreeForAll: GameAdapter<
  QuadGameState,
  QuadGameObservation,
  QuadGameChoice
> = {
  spec: {
    gameId: 'quad-game-ffa',
    playerCount: PLAYER_COUNT,
    decisionPoints: [{ id: 'reveal', description: 'Reveal the next card in hand.' }],
    seatingPlan: SEATING_PLAN,
    maxDecisionsPerGame: TOTAL_CARDS,
  },
  createInitialState,
  currentDecision,
  getObservation,
  getLegalChoices,
  applyChoice,
  getOutcome: getOutcomeFreeForAll,
  encodeChoice,
  invariants: [cardConservationInvariant],
  baselines: {
    random: identityBot,
    heuristic: identityBot,
  },
  strategySurface: [],
};

/** Teamed variant: teams: [[0,2],[1,3]]. */
export const quadGameTeamed: GameAdapter<
  QuadGameState,
  QuadGameObservation,
  QuadGameChoice
> = {
  spec: {
    gameId: 'quad-game-teamed',
    playerCount: PLAYER_COUNT,
    teams: TEAMS,
    decisionPoints: [{ id: 'reveal', description: 'Reveal the next card in hand.' }],
    seatingPlan: SEATING_PLAN,
    maxDecisionsPerGame: TOTAL_CARDS,
  },
  createInitialState,
  currentDecision,
  getObservation,
  getLegalChoices,
  applyChoice,
  getOutcome: getOutcomeTeamed,
  encodeChoice,
  invariants: [cardConservationInvariant],
  baselines: {
    random: identityBot,
    heuristic: identityBot,
  },
  strategySurface: [],
};
