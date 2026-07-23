/**
 * Unit tests for the UCT MCTS port (src/search/mcts.ts, docs/GAP-ANALYSIS-7.md
 * O5). Fixtures are small adapters defined in this file rather than the real
 * reference games, so the tree-search logic is exercised in isolation from
 * game-specific rules.
 */

import type { GameAdapter, GameSpec, PlayerId } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import { eraseAdapter } from '../../loop/erase';
import { mctsBotFactory, mctsSearch } from '../mcts';

// ---------------------------------------------------------------------------
// Fixture: a 2-ply tactical toy game. Player 0 picks 'a' | 'b' | 'c'; player 1
// then picks 'x' | 'y'. Player 0 wins iff they picked 'c', regardless of what
// player 1 does — a clean "there is an immediate winning move" fixture: MCTS
// must find that 'c' dominates 'a'/'b' even though it requires rolling out
// through a second decision layer.
// ---------------------------------------------------------------------------

type TacticalChoice = 'a' | 'b' | 'c' | 'x' | 'y';

interface TacticalState {
  readonly ply: 0 | 1 | 2;
  readonly p0Choice: 'a' | 'b' | 'c' | null;
}

type TacticalObservation = TacticalState;

const TACTICAL_SPEC: GameSpec = {
  gameId: 'mcts-tactical-fixture',
  playerCount: 2,
  decisionPoints: [
    { id: 'p0', description: 'player 0 picks a/b/c' },
    { id: 'p1', description: 'player 1 picks x/y' },
  ],
  seatingPlan: [
    [0, 1],
    [1, 0],
  ],
  perfectInformation: true,
  maxDecisionsPerGame: 2,
};

function makeTacticalAdapter(
  withReconstruct: boolean,
): GameAdapter<TacticalState, TacticalObservation, TacticalChoice> {
  const base: GameAdapter<TacticalState, TacticalObservation, TacticalChoice> = {
    spec: TACTICAL_SPEC,
    createInitialState: () => ({ ply: 0, p0Choice: null }),
    currentDecision: (state) => {
      if (state.ply === 0) return { player: 0, decisionPoint: 'p0' };
      if (state.ply === 1) return { player: 1, decisionPoint: 'p1' };
      return null;
    },
    getObservation: (state) => state,
    getLegalChoices: (state) => (state.ply === 0 ? ['a', 'b', 'c'] : ['x', 'y']),
    applyChoice: (state, choice) => {
      if (state.ply === 0) {
        return { ply: 1, p0Choice: choice as 'a' | 'b' | 'c' };
      }
      return { ply: 2, p0Choice: state.p0Choice };
    },
    getOutcome: (state) => {
      if (state.ply !== 2) return null;
      const winner: PlayerId = state.p0Choice === 'c' ? 0 : 1;
      const scores = [0, 0];
      scores[winner] = 1;
      return { scores, winners: [winner] };
    },
    encodeChoice: (choice) => choice,
    baselines: {
      random: (_seed) => ({ id: 'tactical-random', decide: (_dp, _o, legal) => legal[0] as TacticalChoice }),
      heuristic: (_seed) => ({ id: 'tactical-heuristic', decide: (_dp, _o, legal) => legal[0] as TacticalChoice }),
    },
    strategySurface: [],
  };
  if (withReconstruct) {
    return { ...base, reconstructState: (observation) => observation };
  }
  return base;
}

const SEARCH_CONFIG = { simulations: 200, uctC: 1.4, rolloutCount: 4, label: 'test' };

describe('mctsSearch', () => {
  it('picks the tactical winning move (c) at the root regardless of the opponent reply', () => {
    const adapter = eraseAdapter(makeTacticalAdapter(true));
    const rootState = adapter.createInitialState(1);
    const rng = createRng(7);
    const choice = mctsSearch(adapter, rootState, SEARCH_CONFIG, rng);
    expect(choice).toBe('c');
  });

  it('is deterministic: same seed and same observation produce the same decision', () => {
    const concrete = makeTacticalAdapter(true);
    const adapter = eraseAdapter(concrete);
    const observation = concrete.getObservation(concrete.createInitialState(1), 0);

    const botA = mctsBotFactory(adapter, SEARCH_CONFIG)(99);
    const botB = mctsBotFactory(adapter, SEARCH_CONFIG)(99);

    const legal = concrete.getLegalChoices(concrete.createInitialState(1));
    const decisionA = botA.decide('p0', observation, legal);
    const decisionB = botB.decide('p0', observation, legal);
    expect(decisionA).toEqual(decisionB);
    expect(decisionA).toBe('c');
  });
});

describe('mctsBotFactory', () => {
  it('throws a clear error when the adapter does not declare reconstructState', () => {
    const adapter = eraseAdapter(makeTacticalAdapter(false));
    expect(() => mctsBotFactory(adapter, SEARCH_CONFIG)).toThrow(/reconstructState/);
  });
});
