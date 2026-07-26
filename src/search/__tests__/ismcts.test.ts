/**
 * Unit tests for SO-ISMCTS (src/search/ismcts.ts, docs/FIX-BACKLOG.md P4).
 * Fixtures are small hidden-information adapters defined in this file, so the
 * information-set tree logic (availability-count UCB1, per-simulation
 * determinization) is exercised in isolation from any real game's rules.
 */

import type { AnyBotFactory, GameAdapter, GameSpec, PlayerId, Rng } from '../../contract/types';
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

// ---------------------------------------------------------------------------
// Fixture: near-miss loop, near-miss retry round (docs/GAP-ANALYSIS-8.md
// §4.5/§4.6, DESIGN.md §6.1) — `rolloutFactory` for SO-ISMCTS, mirroring
// `search/mcts.ts`'s `rolloutFactory` fixture (the "corridor" multi-ply
// setup) but with the coin's ply/sum revealed and a hidden coin that only
// `sampleStateFromObservation` resamples per determinization, so the fixture
// actually needs IS-MCTS (not plain MCTS) while still being deep enough
// (budget < branching factor) for the rollout evaluator to matter.
// `ismctsSearch`/`ismctsBotFactory` never take a bespoke `IsmctsConfig` —
// they reuse `MctsConfig` (and `evaluate`) from `search/mcts.ts` verbatim
// (see this file's top-of-file doc comment), so `rolloutFactory` already
// flows through with zero code changes to `ismcts.ts`; these tests pin that.
// ---------------------------------------------------------------------------

const HC_ROOT_BRANCH = 3;
const HC_DEPTH = 3;
const HC_BRANCH = 4;

type HiddenCorridorChoice = string; // 'r0'..'rN' at root, '0'..'BRANCH-1' afterward

interface HiddenCorridorState {
  readonly ply: number; // 0 = root, 1..DEPTH = corridor steps, DEPTH+1 = terminal
  readonly sum: number;
  readonly coin: 0 | 1; // hidden from player 0's observation
}

interface HiddenCorridorObservation {
  readonly ply: number;
  readonly sum: number;
}

const HC_SPEC: GameSpec = {
  gameId: 'ismcts-hidden-corridor-fixture',
  playerCount: 2,
  decisionPoints: Array.from({ length: HC_DEPTH + 1 }, (_, i) => ({ id: `d${i}`, description: `decision ${i}` })),
  seatingPlan: [
    [0, 1],
    [1, 0],
  ],
  maxDecisionsPerGame: HC_DEPTH + 1,
};

function makeHiddenCorridorAdapter(
  heuristicPick: (legal: readonly HiddenCorridorChoice[]) => HiddenCorridorChoice,
): GameAdapter<HiddenCorridorState, HiddenCorridorObservation, HiddenCorridorChoice> {
  return {
    spec: HC_SPEC,
    createInitialState: (seed) => ({ ply: 0, sum: 0, coin: (seed % 2) as 0 | 1 }),
    currentDecision: (state) => {
      if (state.ply > HC_DEPTH) return null;
      const player: PlayerId = state.ply % 2 === 0 ? 0 : 1;
      return { player, decisionPoint: `d${state.ply}` };
    },
    getObservation: (state) => ({ ply: state.ply, sum: state.sum }),
    getLegalChoices: (state) => {
      if (state.ply === 0) return Array.from({ length: HC_ROOT_BRANCH }, (_, i) => `r${i}`);
      return Array.from({ length: HC_BRANCH }, (_, i) => String(i));
    },
    applyChoice: (state, choice) => {
      const digit = state.ply === 0 ? Number(choice.slice(1)) : Number(choice);
      return { ...state, ply: state.ply + 1, sum: state.sum + digit };
    },
    getOutcome: (state) => {
      if (state.ply <= HC_DEPTH) return null;
      const winner: PlayerId = (state.sum + state.coin) % 2 === 0 ? 0 : 1;
      const scores = [0, 0];
      scores[winner] = 1;
      return { scores, winners: [winner] };
    },
    encodeChoice: (choice) => choice,
    baselines: {
      random: (_seed) => ({ id: 'hc-random', decide: (_dp, _o, legal) => legal[0] as HiddenCorridorChoice }),
      heuristic: (_seed) => ({ id: 'hc-heuristic', decide: (_dp, _o, legal) => heuristicPick(legal) }),
    },
    strategySurface: [],
    sampleStateFromObservation: (observation, _player, rng) => ({
      ply: observation.ply,
      sum: observation.sum,
      coin: rng.nextInt(2) as 0 | 1,
    }),
  };
}

const HC_CONFIG_BASE = { simulations: 60, uctC: 1.4, rolloutCount: 3, label: 'hidden-corridor' };
const HC_SEED = 3;

describe('ismctsSearch rolloutFactory', () => {
  it('leaves existing decisions unchanged when rolloutFactory is not supplied (regression pin)', () => {
    const adapter = eraseAdapter(makeHiddenCorridorAdapter((legal) => legal[legal.length - 1] as HiddenCorridorChoice));
    const observation = { ply: 0, sum: 0 };

    const withoutFactory = ismctsSearch(adapter, observation, 0, HC_CONFIG_BASE, createRng(HC_SEED));
    const explicitRandomPolicy = ismctsSearch(
      adapter,
      observation,
      0,
      { ...HC_CONFIG_BASE, rolloutPolicy: 'random' },
      createRng(HC_SEED),
    );
    expect(withoutFactory).toBe(explicitRandomPolicy);
  });

  it('is deterministic and returns a legal choice when rolloutFactory is supplied', () => {
    const adapter = eraseAdapter(makeHiddenCorridorAdapter((legal) => legal[legal.length - 1] as HiddenCorridorChoice));
    const observation = { ply: 0, sum: 0 };
    const legalRootChoices = adapter.getLegalChoices(adapter.createInitialState(HC_SEED));

    // Opposite policy from the heuristic fixture's highest-digit pick, so a
    // changed decision is provably from the factory, not an accidental match
    // with the adapter's own heuristic baseline.
    const lowestDigitFactory: AnyBotFactory = (_seed) => ({
      id: 'hc-lowest-digit',
      decide: (_dp, _observation, legal) => legal[0] as HiddenCorridorChoice,
    });

    const choiceA = ismctsSearch(
      adapter,
      observation,
      0,
      { ...HC_CONFIG_BASE, rolloutFactory: lowestDigitFactory },
      createRng(HC_SEED),
    );
    const choiceB = ismctsSearch(
      adapter,
      observation,
      0,
      { ...HC_CONFIG_BASE, rolloutFactory: lowestDigitFactory },
      createRng(HC_SEED),
    );

    expect(choiceA).toEqual(choiceB);
    expect(legalRootChoices).toContain(choiceA);
  });

  it('takes precedence over rolloutPolicy when both are supplied', () => {
    const adapter = eraseAdapter(makeHiddenCorridorAdapter((legal) => legal[legal.length - 1] as HiddenCorridorChoice));
    const observation = { ply: 0, sum: 0 };

    const lowestDigitFactory: AnyBotFactory = (_seed) => ({
      id: 'hc-lowest-digit',
      decide: (_dp, _observation, legal) => legal[0] as HiddenCorridorChoice,
    });

    const factoryOnlyChoice = ismctsSearch(
      adapter,
      observation,
      0,
      { ...HC_CONFIG_BASE, rolloutFactory: lowestDigitFactory },
      createRng(HC_SEED),
    );
    const factoryPlusHeuristicPolicyChoice = ismctsSearch(
      adapter,
      observation,
      0,
      { ...HC_CONFIG_BASE, rolloutPolicy: 'heuristic', rolloutFactory: lowestDigitFactory },
      createRng(HC_SEED),
    );

    expect(factoryPlusHeuristicPolicyChoice).toBe(factoryOnlyChoice);
  });
});

describe('ismctsBotFactory rolloutFactory', () => {
  it('decides deterministically and returns an element of the caller-supplied legal array', () => {
    const concrete = makeHiddenCorridorAdapter((legal) => legal[legal.length - 1] as HiddenCorridorChoice);
    const adapter = eraseAdapter(concrete);
    const lowestDigitFactory: AnyBotFactory = (_seed) => ({
      id: 'hc-lowest-digit',
      decide: (_dp, _observation, legal) => legal[0] as HiddenCorridorChoice,
    });
    const legal = Array.from({ length: HC_ROOT_BRANCH }, (_, i) => `r${i}`);

    const bot = ismctsBotFactory(adapter, { ...HC_CONFIG_BASE, rolloutFactory: lowestDigitFactory })(11);
    const choice = bot.decide('d0', { ply: 0, sum: 0 }, legal);
    expect(legal).toContain(choice);

    const bot2 = ismctsBotFactory(adapter, { ...HC_CONFIG_BASE, rolloutFactory: lowestDigitFactory })(11);
    const choice2 = bot2.decide('d0', { ply: 0, sum: 0 }, legal);
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
