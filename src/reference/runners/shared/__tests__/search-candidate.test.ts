import type { GameAdapter, GameSpec, PlayerId, Rng } from '../../../../contract/types';
import { eraseAdapter } from '../../../../loop/erase';
import { composeBot } from '../../../../loop/compose';
import type { SearchCandidateRecommendation } from '../../../../kernel/search-blueprint';
import { searchCandidateFlagSpec } from '../search-candidate';

/**
 * Minimal 2-player fixture: pick a digit '0'..'3' at each of 2 decisions,
 * player who picked the higher sum wins. Declares `reconstructState` (a
 * pass-through, since `getObservation` returns the full state) for the
 * tree-search smoke path.
 */
interface FixtureState {
  readonly ply: number;
  readonly sum: number;
}
type FixtureChoice = '0' | '1' | '2' | '3';

const FIXTURE_SPEC: GameSpec = {
  gameId: 'search-candidate-fixture',
  playerCount: 2,
  decisionPoints: [
    { id: 'd0', description: 'decision 0' },
    { id: 'd1', description: 'decision 1' },
  ],
  seatingPlan: [
    [0, 1],
    [1, 0],
  ],
  perfectInformation: true,
  maxDecisionsPerGame: 2,
};

function makeTreeSearchAdapter(): GameAdapter<FixtureState, FixtureState, FixtureChoice> {
  const base: GameAdapter<FixtureState, FixtureState, FixtureChoice> = {
    spec: FIXTURE_SPEC,
    createInitialState: () => ({ ply: 0, sum: 0 }),
    currentDecision: (state) => {
      if (state.ply >= 2) return null;
      const player: PlayerId = state.ply % 2 === 0 ? 0 : 1;
      return { player, decisionPoint: `d${state.ply}` };
    },
    getObservation: (state) => state,
    getLegalChoices: () => ['0', '1', '2', '3'],
    applyChoice: (state, choice) => ({ ply: state.ply + 1, sum: state.sum + Number(choice) }),
    getOutcome: (state) => {
      if (state.ply < 2) return null;
      const winner: PlayerId = state.sum % 2 === 0 ? 0 : 1;
      const scores = [0, 0];
      scores[winner] = 1;
      return { scores, winners: [winner] };
    },
    encodeChoice: (choice) => choice,
    baselines: {
      random: (_seed) => ({ id: 'fixture-random', decide: (_dp, _o, legal) => legal[0] as FixtureChoice }),
      heuristic: (_seed) => ({
        id: 'fixture-heuristic',
        decide: (_dp, _o, legal) => legal[legal.length - 1] as FixtureChoice,
      }),
    },
    strategySurface: [],
  };
  return { ...base, reconstructState: (observation) => observation };
}

function makeIsmctsAdapter(): GameAdapter<FixtureState, FixtureState, FixtureChoice> {
  const base = makeTreeSearchAdapter();
  const { reconstructState: _ignored, ...rest } = base as GameAdapter<FixtureState, FixtureState, FixtureChoice> & {
    reconstructState?: (observation: FixtureState) => FixtureState;
  };
  return {
    ...rest,
    sampleStateFromObservation: (observation: FixtureState, _player: PlayerId, _rng: Rng) => observation,
  };
}

const TREE_SEARCH_RECOMMENDATION: SearchCandidateRecommendation = {
  family: 'tree-search',
  simulations: 16,
  rolloutTier: 'heuristic',
  tacticalPrecheckDepth: 0,
  flagLabel: 'mcts-s16-hr',
  rationale: 'test fixture',
};

const ISMCTS_RECOMMENDATION: SearchCandidateRecommendation = {
  family: 'information-set-tree-search',
  simulations: 16,
  rolloutTier: 'heuristic',
  tacticalPrecheckDepth: 0,
  flagLabel: 'ismcts-s16-hr',
  rationale: 'test fixture',
};

describe('searchCandidateFlagSpec', () => {
  it('builds a valid StrategyFlagSpec for a tree-search recommendation', () => {
    const adapter = eraseAdapter(makeTreeSearchAdapter());
    const spec = searchCandidateFlagSpec(adapter, TREE_SEARCH_RECOMMENDATION);
    expect(spec.flag).toBe('mcts-s16-hr');
    expect(typeof spec.apply).toBe('function');
  });

  it('composes via composeBot and plays one full game to a legal, terminal result', () => {
    const concrete = makeTreeSearchAdapter();
    const adapter = eraseAdapter(concrete);
    const extended = { ...adapter, strategySurface: [searchCandidateFlagSpec(adapter, TREE_SEARCH_RECOMMENDATION)] };
    const factory = composeBot(extended, ['mcts-s16-hr']);
    const bot = factory(1);

    let state = adapter.createInitialState(1);
    for (let i = 0; i < 2; i += 1) {
      const decision = adapter.currentDecision(state);
      expect(decision).not.toBeNull();
      const legal = adapter.getLegalChoices(state);
      const observation = adapter.getObservation(state, (decision as { player: PlayerId }).player);
      const choice = bot.decide((decision as { decisionPoint: string }).decisionPoint, observation, legal);
      expect(legal).toContain(choice);
      state = adapter.applyChoice(state, choice);
    }
    expect(adapter.currentDecision(state)).toBeNull();
    expect(adapter.getOutcome(state)).not.toBeNull();
  });

  it('builds a valid StrategyFlagSpec for an information-set-tree-search recommendation and plays one full game', () => {
    const concrete = makeIsmctsAdapter();
    const adapter = eraseAdapter(concrete);
    const spec = searchCandidateFlagSpec(adapter, ISMCTS_RECOMMENDATION);
    expect(spec.flag).toBe('ismcts-s16-hr');
    const extended = { ...adapter, strategySurface: [spec] };
    const factory = composeBot(extended, ['ismcts-s16-hr']);
    const bot = factory(1);

    let state = adapter.createInitialState(1);
    for (let i = 0; i < 2; i += 1) {
      const decision = adapter.currentDecision(state);
      expect(decision).not.toBeNull();
      const legal = adapter.getLegalChoices(state);
      const observation = adapter.getObservation(state, (decision as { player: PlayerId }).player);
      const choice = bot.decide((decision as { decisionPoint: string }).decisionPoint, observation, legal);
      expect(legal).toContain(choice);
      state = adapter.applyChoice(state, choice);
    }
    expect(adapter.currentDecision(state)).toBeNull();
    expect(adapter.getOutcome(state)).not.toBeNull();
  });

  it('throws a clear error for a counterfactual-regret recommendation (out of scope, needs a trained PolicyTable)', () => {
    const adapter = eraseAdapter(makeTreeSearchAdapter());
    const cfrRecommendation: SearchCandidateRecommendation = {
      family: 'counterfactual-regret',
      simulations: 0,
      rolloutTier: 'heuristic',
      tacticalPrecheckDepth: 0,
      flagLabel: 'mccfr-os-auto',
      rationale: 'test fixture',
    };
    expect(() => searchCandidateFlagSpec(adapter, cfrRecommendation)).toThrow(/counterfactual-regret/);
  });

  it('throws a clear error for a "none" family recommendation', () => {
    const adapter = eraseAdapter(makeTreeSearchAdapter());
    const noneRecommendation: SearchCandidateRecommendation = {
      family: 'none',
      simulations: 0,
      rolloutTier: 'heuristic',
      tacticalPrecheckDepth: 0,
      flagLabel: 'unused',
      rationale: 'test fixture',
    };
    expect(() => searchCandidateFlagSpec(adapter, noneRecommendation)).toThrow(/"none"/);
  });
});
