/**
 * firstMoverWinsAdapter — test-only 2-player fixture demonstrating extreme
 * paired signal collapse (docs/GAP-ANALYSIS-2.md X1, the omok/gomoku case).
 *
 * PlayerId 0 always wins, unconditionally — the choice made at each of the
 * two decision points ('a' or 'b') is recorded but never affects the outcome.
 * Averaging a seed's block across the mirrored seatingPlan ([[0,1],[1,0]])
 * therefore always lands on exactly 0.5 (1 when the candidate occupies
 * PlayerId 0, 0 when it occupies PlayerId 1): position bias cancels, but so
 * does every strategy difference, which is exactly the failure mode
 * signalCollapseRate/drawRate exist to surface. The two-choice legal set
 * (rather than a single no-op) lets a strategySurface flag still produce a
 * behaviorally distinct trajectory — enough to pass wave-runner's screen —
 * while the game outcome itself never depends on it.
 */

import type {
  BotFactory,
  GameAdapter,
  Outcome,
  PendingDecision,
  PlayerId,
  StrategyFlagSpec,
} from '../../../contract/types';

export interface FirstMoverWinsState {
  readonly turnsTaken: number;
}

export interface FirstMoverWinsObservation {
  readonly turnsTaken: number;
}

export type FirstMoverWinsChoice = 'a' | 'b';

const PLAYER_COUNT = 2;
const TOTAL_TURNS = 2;
const LEGAL: readonly FirstMoverWinsChoice[] = ['a', 'b'];

function createInitialState(_seed: number): FirstMoverWinsState {
  return { turnsTaken: 0 };
}

function currentDecision(state: FirstMoverWinsState): PendingDecision | null {
  if (state.turnsTaken >= TOTAL_TURNS) {
    return null;
  }
  const player = (state.turnsTaken % PLAYER_COUNT) as PlayerId;
  return { player, decisionPoint: 'choose' };
}

function getLegalChoices(_state: FirstMoverWinsState): readonly FirstMoverWinsChoice[] {
  return LEGAL;
}

function getObservation(state: FirstMoverWinsState, _player: PlayerId): FirstMoverWinsObservation {
  return { turnsTaken: state.turnsTaken };
}

function applyChoice(state: FirstMoverWinsState, _choice: FirstMoverWinsChoice): FirstMoverWinsState {
  return { turnsTaken: state.turnsTaken + 1 };
}

function getOutcome(state: FirstMoverWinsState): Outcome | null {
  if (currentDecision(state) !== null) {
    return null;
  }
  // PlayerId 0 always wins, regardless of any decision made.
  return { scores: [1, 0], winners: [0] };
}

function encodeChoice(choice: FirstMoverWinsChoice): string {
  return choice;
}

const alwaysABot: BotFactory<FirstMoverWinsObservation, FirstMoverWinsChoice> = () => ({
  id: 'first-mover-wins-always-a',
  decide(_decisionPoint, _observation, _legal) {
    return 'a';
  },
});

const randomBot: BotFactory<FirstMoverWinsObservation, FirstMoverWinsChoice> = (seed) => {
  // Deterministic alternation keyed off the seed; the choice never affects
  // the outcome, only the recorded trajectory.
  return {
    id: 'first-mover-wins-random',
    decide(_decisionPoint, _observation, legal) {
      return legal[seed % legal.length] as FirstMoverWinsChoice;
    },
  };
};

/** Always picks 'b' — behaviorally distinct from the always-'a' baseline
 * (so wave-runner's screen accepts it) while never changing the outcome
 * (so every smoke/prune/holdout block still collapses to winFraction=0.5). */
const pickB: StrategyFlagSpec<FirstMoverWinsObservation, FirstMoverWinsChoice> = {
  flag: 'pickB',
  description: 'Always choose "b" instead of delegating to the base bot.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: `${bot.id}+pickB`,
        decide(_decisionPoint, _observation, _legal) {
          return 'b';
        },
      };
    };
  },
};

export const firstMoverWinsAdapter: GameAdapter<
  FirstMoverWinsState,
  FirstMoverWinsObservation,
  FirstMoverWinsChoice
> = {
  spec: {
    gameId: 'first-mover-wins',
    playerCount: PLAYER_COUNT,
    decisionPoints: [{ id: 'choose', description: 'Choose "a" or "b"; never affects the outcome.' }],
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
    random: randomBot,
    heuristic: alwaysABot,
  },
  strategySurface: [pickB],
};
