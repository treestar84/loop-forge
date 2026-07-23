/**
 * strengthDeclareAdapter — test-only 2-player fixture for O10 regression-gate
 * tests (docs/GAP-ANALYSIS-7.md O10). Each player declares a fixed
 * {strength, tag} pair (ignoring observation/seed entirely); the higher
 * `strength` wins, equal `strength` ties. `tag` never affects the outcome —
 * it exists only so two bots with identical `strength` still encode to
 * different choiceKeys, letting wave-runner's screen tier accept a candidate
 * that is behaviorally distinct yet outcome-equal to another bot (the
 * "candidate == champion" regression-tier tie case).
 *
 * This directly models the omok v3 override bug: a strategySurface flag
 * whose `apply` ignores the `base` factory it's given and returns a fixed
 * bot instead, discarding whatever baseline flags were already composed in.
 */

import type {
  BotFactory,
  GameAdapter,
  Outcome,
  PendingDecision,
  PlayerId,
  StrategyFlagSpec,
} from '../../../contract/types';

export interface StrengthChoice {
  readonly strength: number;
  readonly tag: string;
}

export interface StrengthDeclareState {
  readonly declared: readonly [StrengthChoice | null, StrengthChoice | null];
  readonly turnsTaken: number;
}

export interface StrengthDeclareObservation {
  readonly turnsTaken: number;
}

const PLAYER_COUNT = 2;
const TOTAL_TURNS = 2;

const LEGAL_CHOICES: readonly StrengthChoice[] = [0, 1, 2, 3].flatMap((strength) =>
  ['base', 'strong', 'override', 'twin'].map((tag) => ({ strength, tag })),
);

function createInitialState(_seed: number): StrengthDeclareState {
  return { declared: [null, null], turnsTaken: 0 };
}

function currentDecision(state: StrengthDeclareState): PendingDecision | null {
  if (state.turnsTaken >= TOTAL_TURNS) {
    return null;
  }
  const player = (state.turnsTaken % PLAYER_COUNT) as PlayerId;
  return { player, decisionPoint: 'declare' };
}

function getLegalChoices(_state: StrengthDeclareState): readonly StrengthChoice[] {
  return LEGAL_CHOICES;
}

function getObservation(
  state: StrengthDeclareState,
  _player: PlayerId,
): StrengthDeclareObservation {
  return { turnsTaken: state.turnsTaken };
}

function applyChoice(
  state: StrengthDeclareState,
  choice: StrengthChoice,
): StrengthDeclareState {
  const player = state.turnsTaken % PLAYER_COUNT;
  const declared: [StrengthChoice | null, StrengthChoice | null] = [...state.declared];
  declared[player] = choice;
  return { declared, turnsTaken: state.turnsTaken + 1 };
}

function getOutcome(state: StrengthDeclareState): Outcome | null {
  if (currentDecision(state) !== null) {
    return null;
  }
  const [d0, d1] = state.declared;
  if (d0 === null || d1 === null) {
    throw new Error('strengthDeclareAdapter: getOutcome called before both players declared');
  }
  const scores = [d0.strength, d1.strength];
  if (d0.strength > d1.strength) {
    return { scores, winners: [0] };
  }
  if (d0.strength < d1.strength) {
    return { scores, winners: [1] };
  }
  return { scores, winners: [0, 1] };
}

function encodeChoice(choice: StrengthChoice): string {
  return `${choice.strength}:${choice.tag}`;
}

function fixedBot(
  strength: number,
  tag: string,
  id: string,
): BotFactory<StrengthDeclareObservation, StrengthChoice> {
  return (_seed) => ({
    id,
    decide(_decisionPoint, _observation, _legal) {
      return { strength, tag };
    },
  });
}

const heuristicBot = fixedBot(1, 'base', 'strength-declare-heuristic');
const randomBot = fixedBot(1, 'base', 'strength-declare-random');

/** Champion-building flag: declares strength 3. Ignoring `base` here is
 * ordinary (this is the fixture's only way to express "always strength 3"),
 * not the bug under test. */
const strong: StrategyFlagSpec<StrengthDeclareObservation, StrengthChoice> = {
  flag: 'strong',
  description: 'Always declares strength 3, regardless of base.',
  apply(_base) {
    return fixedBot(3, 'strong', 'strength-declare+strong');
  },
};

/** Override-bug flag: discards whatever `base` it's given (e.g. a champion
 * already built from `strong`) and always declares strength 2 instead —
 * weaker than the champion but still stronger than the raw heuristic
 * (strength 1), so it clears every raw-opponent gate yet regresses. */
const override: StrategyFlagSpec<StrengthDeclareObservation, StrengthChoice> = {
  flag: 'override',
  description: 'Discards base and always declares strength 2 (simulates the omok v3 override bug).',
  apply(_base) {
    return fixedBot(2, 'override', 'strength-declare+override');
  },
};

/** Same strength as `strong` (3) but a different tag, so it is behaviorally
 * distinct from the champion at screen time (different choiceKeys) while
 * tying it exactly in outcome (equal strength) — the "candidate == champion"
 * regression-tier case. */
const twin: StrategyFlagSpec<StrengthDeclareObservation, StrengthChoice> = {
  flag: 'twin',
  description: 'Always declares strength 3 with a distinct tag (ties the champion in outcome).',
  apply(_base) {
    return fixedBot(3, 'twin', 'strength-declare+twin');
  },
};

export const strengthDeclareAdapter: GameAdapter<
  StrengthDeclareState,
  StrengthDeclareObservation,
  StrengthChoice
> = {
  spec: {
    gameId: 'strength-declare',
    playerCount: PLAYER_COUNT,
    decisionPoints: [{ id: 'declare', description: 'Declare a fixed strength/tag pair.' }],
    seatingPlan: [
      [0, 1],
      [1, 0],
    ],
    perfectInformation: true,
    maxDecisionsPerGame: TOTAL_TURNS,
    scoreMargin: 'scored',
    utility: 'zero-sum',
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
    heuristic: heuristicBot,
  },
  strategySurface: [strong, override, twin],
};
