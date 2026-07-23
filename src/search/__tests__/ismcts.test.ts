/**
 * Unit tests for SO-ISMCTS (src/search/ismcts.ts, docs/FIX-BACKLOG.md P4).
 * Fixtures are small hidden-information adapters defined in this file, so the
 * information-set tree logic (availability-count UCB1, per-simulation
 * determinization) is exercised in isolation from any real game's rules.
 */

import type { GameAdapter, GameSpec, PlayerId, Rng } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import { eraseAdapter } from '../../loop/erase';
import { ismctsBotFactory, ismctsSearch } from '../ismcts';
import { mctsBotFactory } from '../mcts';

// ---------------------------------------------------------------------------
// Fixture: single-decision hidden-information game. Player 1 secretly holds a
// coin (0 or 1), invisible to player 0's observation. Player 0 (root) picks
// 'a' or 'b':
//   - 'a' always wins for player 0, regardless of the hidden coin.
//   - 'b' wins for player 0 only when the (unknown-to-root) coin is 1.
// 'a' therefore dominates 'b' under every possible determinization — the
// classic case IS-MCTS must get right without ever seeing the coin directly.
// ---------------------------------------------------------------------------

type CoinChoice = 'a' | 'b';

interface CoinState {
  readonly coin: 0 | 1;
  readonly chosen: CoinChoice | null;
}

// The observation reveals nothing at all — every bit of the state (other
// than "no decision has been made yet") is hidden from player 0.
type CoinObservation = Record<string, never>;

const COIN_SPEC: GameSpec = {
  gameId: 'ismcts-coin-fixture',
  playerCount: 2,
  decisionPoints: [{ id: 'd', description: 'player 0 picks a/b' }],
  seatingPlan: [
    [0, 1],
    [1, 0],
  ],
  maxDecisionsPerGame: 1,
};

function makeCoinAdapter(
  withHook: boolean,
): GameAdapter<CoinState, CoinObservation, CoinChoice> {
  const base: GameAdapter<CoinState, CoinObservation, CoinChoice> = {
    spec: COIN_SPEC,
    createInitialState: (seed) => ({ coin: (seed % 2) as 0 | 1, chosen: null }),
    currentDecision: (state) => (state.chosen === null ? { player: 0, decisionPoint: 'd' } : null),
    getObservation: (_state, _player) => ({}) as CoinObservation,
    getLegalChoices: (state) => (state.chosen === null ? (['a', 'b'] as const) : []),
    applyChoice: (state, choice) => ({ ...state, chosen: choice }),
    getOutcome: (state) => {
      if (state.chosen === null) return null;
      const winner: PlayerId = state.chosen === 'a' || state.coin === 1 ? 0 : 1;
      const scores = [0, 0];
      scores[winner] = 1;
      return { scores, winners: [winner] };
    },
    encodeChoice: (choice) => choice,
    baselines: {
      random: (_seed) => ({ id: 'coin-random', decide: (_dp, _o, legal) => legal[0] as CoinChoice }),
      heuristic: (_seed) => ({ id: 'coin-heuristic', decide: (_dp, _o, legal) => legal[0] as CoinChoice }),
    },
    strategySurface: [],
  };
  if (!withHook) {
    return base;
  }
  return {
    ...base,
    sampleStateFromObservation: (_observation: CoinObservation, _player: PlayerId, rng: Rng): CoinState => ({
      coin: rng.nextInt(2) as 0 | 1,
      chosen: null,
    }),
  };
}

const COIN_CONFIG = { simulations: 300, uctC: 1.4, rolloutCount: 1, label: 'test' };

describe('ismctsSearch', () => {
  it('picks the dominant move (a) even though it never observes the hidden coin', () => {
    const adapter = eraseAdapter(makeCoinAdapter(true));
    const observation = {};
    const choice = ismctsSearch(adapter, observation, 0, COIN_CONFIG, createRng(7));
    expect(choice).toBe('a');
  });

  it('is deterministic: same seed and same observation produce the same decision', () => {
    const adapter = eraseAdapter(makeCoinAdapter(true));
    const observation = {};
    const choiceA = ismctsSearch(adapter, observation, 0, COIN_CONFIG, createRng(99));
    const choiceB = ismctsSearch(adapter, observation, 0, COIN_CONFIG, createRng(99));
    expect(choiceA).toEqual(choiceB);
  });

  it('throws a clear error when the adapter does not declare sampleStateFromObservation', () => {
    const adapter = eraseAdapter(makeCoinAdapter(false));
    expect(() => ismctsSearch(adapter, {}, 0, COIN_CONFIG, createRng(1))).toThrow(/sampleStateFromObservation/);
  });
});

describe('ismctsBotFactory', () => {
  it('throws a clear error when the adapter does not declare sampleStateFromObservation', () => {
    const adapter = eraseAdapter(makeCoinAdapter(false));
    expect(() => ismctsBotFactory(adapter, COIN_CONFIG)).toThrow(/sampleStateFromObservation/);
  });

  it('decides deterministically and returns an element of the caller-supplied legal array', () => {
    const concrete = makeCoinAdapter(true);
    const adapter = eraseAdapter(concrete);
    const bot = ismctsBotFactory(adapter, COIN_CONFIG)(42);
    const legal = ['a', 'b'] as const;
    const choice = bot.decide('d', {}, legal);
    expect(choice).toBe('a');
    expect(legal).toContain(choice);

    const bot2 = ismctsBotFactory(adapter, COIN_CONFIG)(42);
    const choice2 = bot2.decide('d', {}, legal);
    expect(choice2).toBe(choice);
  });
});

// Sanity check that mctsBotFactory (the perfect-information sibling) still
// rejects this fixture the same way it always has — ismcts.ts's new export
// from mcts.ts must not have altered mcts.ts's own behavior (docs/FIX-BACKLOG.md
// P4's "mcts.ts 기존 export·동작 불변" requirement).
describe('mcts.ts unaffected by the ismcts.ts export addition', () => {
  it('mctsBotFactory still throws when reconstructState is undeclared', () => {
    const adapter = eraseAdapter(makeCoinAdapter(true));
    expect(() => mctsBotFactory(adapter, { simulations: 10, uctC: 1.4, rolloutCount: 1, label: 'x' })).toThrow(
      /reconstructState/,
    );
  });
});
