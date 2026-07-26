/**
 * fieldMixAdapter — test-only 4-player fixture for M4 field-mix wave tests
 * (docs/GAP-ANALYSIS-10.md M4: WaveConfig.fieldMix).
 *
 * Only player 0 (always the candidate seat, since seatingPlan[0] is the
 * identity permutation) ever makes a decision — a single 'declare' choice
 * between 'a'/'b' that never affects the outcome, which is fixed at
 * createInitialState (player 0 always wins). The other three seats are never
 * asked to decide at all, but their bot factories are still constructed by
 * runMatch — enough to prove which `adapter.baselines[...]` factory occupies
 * which non-candidate slot without needing their decisions to matter.
 *
 * strategySurface's sole flag ('noop') returns `base` unchanged, so screen
 * always rejects it as a behavioral no-op — exactly what a fieldMix
 * slot-placement test wants: evaluateCandidate stops right after the screen
 * tier, so the only factory invocations are the two screen trajectories
 * (candidate vs base), keeping bot-construction call counts small and exact.
 */

import type {
  BotFactory,
  GameAdapter,
  Outcome,
  PendingDecision,
  PlayerId,
  StrategyFlagSpec,
} from '../../../contract/types';

export interface FieldMixState {
  readonly turnsTaken: number;
}

export interface FieldMixObservation {
  readonly turnsTaken: number;
}

export type FieldMixChoice = 'a' | 'b';

const PLAYER_COUNT = 4;
const LEGAL: readonly FieldMixChoice[] = ['a', 'b'];

function createInitialState(_seed: number): FieldMixState {
  return { turnsTaken: 0 };
}

function currentDecision(state: FieldMixState): PendingDecision | null {
  if (state.turnsTaken >= 1) {
    return null;
  }
  return { player: 0 as PlayerId, decisionPoint: 'declare' };
}

function getLegalChoices(_state: FieldMixState): readonly FieldMixChoice[] {
  return LEGAL;
}

function getObservation(state: FieldMixState, _player: PlayerId): FieldMixObservation {
  return { turnsTaken: state.turnsTaken };
}

function applyChoice(state: FieldMixState, _choice: FieldMixChoice): FieldMixState {
  return { turnsTaken: state.turnsTaken + 1 };
}

function getOutcome(state: FieldMixState): Outcome | null {
  if (currentDecision(state) !== null) {
    return null;
  }
  // Player 0 (the candidate seat) always wins, regardless of any decision.
  return { scores: [1, 0, 0, 0], winners: [0] };
}

function encodeChoice(choice: FieldMixChoice): string {
  return choice;
}

const alwaysABot: BotFactory<FieldMixObservation, FieldMixChoice> = () => ({
  id: 'field-mix-heuristic',
  decide(_decisionPoint, _observation, _legal) {
    return 'a';
  },
});

const alwaysBBot: BotFactory<FieldMixObservation, FieldMixChoice> = () => ({
  id: 'field-mix-random',
  decide(_decisionPoint, _observation, _legal) {
    return 'b';
  },
});

/** Behavioral no-op: returns `base` unchanged, so screen always rejects it. */
const noop: StrategyFlagSpec<FieldMixObservation, FieldMixChoice> = {
  flag: 'noop',
  description: 'Returns base unchanged; always screened out as a no-op.',
  apply(base) {
    return base;
  },
};

const SEATING_PLAN = [
  [0, 1, 2, 3],
  [1, 2, 3, 0],
  [2, 3, 0, 1],
  [3, 0, 1, 2],
] as const;

export const fieldMixAdapter: GameAdapter<FieldMixState, FieldMixObservation, FieldMixChoice> = {
  spec: {
    gameId: 'field-mix-fixture',
    playerCount: PLAYER_COUNT,
    decisionPoints: [{ id: 'declare', description: 'Choose "a" or "b"; never affects the outcome.' }],
    seatingPlan: SEATING_PLAN,
    maxDecisionsPerGame: 1,
  },
  createInitialState,
  currentDecision,
  getObservation,
  getLegalChoices,
  applyChoice,
  getOutcome,
  encodeChoice,
  baselines: {
    random: alwaysBBot,
    heuristic: alwaysABot,
  },
  strategySurface: [noop],
};
