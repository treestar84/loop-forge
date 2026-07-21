/**
 * longAccumulateAdapter — test-only 2-player fixture with a long decision
 * count (120 decisions, 60 per player) whose outcome is the sum of each
 * player's own random draws. Regression fixture for docs/FIX-BACKLOG.md Z2:
 * a bot's cumulative score depends only on its own bot seed (never on
 * gameSeed), so if `calibrateIdentity` reuses one fixed bot-seed pair across
 * every gameSeed (the pre-fix bug), every match plays out identically and
 * meanWinRate freezes at an extreme value no matter how many game seeds are
 * sampled. Deriving an independent bot-seed pair per gameSeed (the fix)
 * varies the trajectory match-to-match, so meanWinRate converges toward 0.5
 * as the sample grows.
 */

import type { BotFactory, GameAdapter, Outcome, PendingDecision, PlayerId } from '../../../contract/types';
import { createRng } from '../../../kernel/rng';

export interface LongAccumulateState {
  readonly turnsTaken: number;
  readonly scores: readonly [number, number];
}

export interface LongAccumulateObservation {
  readonly turnsTaken: number;
}

export type LongAccumulateChoice = number;

const PLAYER_COUNT = 2;
const TOTAL_TURNS = 120;
const LEGAL: readonly LongAccumulateChoice[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function createInitialState(_seed: number): LongAccumulateState {
  return { turnsTaken: 0, scores: [0, 0] };
}

function currentDecision(state: LongAccumulateState): PendingDecision | null {
  if (state.turnsTaken >= TOTAL_TURNS) {
    return null;
  }
  const player = (state.turnsTaken % PLAYER_COUNT) as PlayerId;
  return { player, decisionPoint: 'pick' };
}

function getLegalChoices(_state: LongAccumulateState): readonly LongAccumulateChoice[] {
  return LEGAL;
}

function getObservation(
  state: LongAccumulateState,
  _player: PlayerId,
): LongAccumulateObservation {
  return { turnsTaken: state.turnsTaken };
}

function applyChoice(
  state: LongAccumulateState,
  choice: LongAccumulateChoice,
): LongAccumulateState {
  const player = state.turnsTaken % PLAYER_COUNT;
  const scores: [number, number] =
    player === 0
      ? [state.scores[0] + choice, state.scores[1]]
      : [state.scores[0], state.scores[1] + choice];
  return { turnsTaken: state.turnsTaken + 1, scores };
}

function getOutcome(state: LongAccumulateState): Outcome | null {
  if (currentDecision(state) !== null) {
    return null;
  }
  const [a, b] = state.scores;
  if (a === b) {
    return { scores: state.scores, winners: [0, 1] };
  }
  return { scores: state.scores, winners: a > b ? [0] : [1] };
}

function encodeChoice(choice: LongAccumulateChoice): string {
  return String(choice);
}

/** Draws every choice from an RNG seeded once at bot creation — the bot's
 * whole trajectory (and thus its contribution to the final score) depends
 * only on its own seed, never on gameSeed. */
const seededDrawBot: BotFactory<LongAccumulateObservation, LongAccumulateChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: `long-accumulate-seeded-draw-${seed}`,
    decide(_decisionPoint, _observation, legal) {
      return legal[rng.nextInt(legal.length)] as LongAccumulateChoice;
    },
  };
};

export const longAccumulateAdapter: GameAdapter<
  LongAccumulateState,
  LongAccumulateObservation,
  LongAccumulateChoice
> = {
  spec: {
    gameId: 'long-accumulate',
    playerCount: PLAYER_COUNT,
    decisionPoints: [{ id: 'pick', description: 'Pick a value 0-9 to add to your own score.' }],
    seatingPlan: [
      [0, 1],
      [1, 0],
    ],
    maxDecisionsPerGame: TOTAL_TURNS,
  },
  createInitialState,
  currentDecision,
  getObservation,
  getLegalChoices,
  applyChoice,
  getOutcome,
  encodeChoice,
  baselines: {
    random: seededDrawBot,
    heuristic: seededDrawBot,
  },
  strategySurface: [],
};
