/**
 * Unit tests for the UCT MCTS port (src/search/mcts.ts, docs/GAP-ANALYSIS-7.md
 * O5). Fixtures are small adapters defined in this file rather than the real
 * reference games, so the tree-search logic is exercised in isolation from
 * game-specific rules.
 */

import type { AnyBotFactory, GameAdapter, GameSpec, PlayerId } from '../../contract/types';
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

// ---------------------------------------------------------------------------
// Fixture: rolloutPolicy (docs/FIX-BACKLOG.md P1). A "corridor" game: player 0
// picks one of ROOT_BRANCH root options, then DEPTH more alternating
// (player1, player0, …) decisions each with BRANCH digit options follow.
// Terminal winner is player 0 iff the sum of every chosen digit (root choice
// index included) is even. The corridor is intentionally too wide/deep to
// fully expand within the simulation budgets used below, so the root
// decision is shaped by rollout-evaluator quality, not just tree search —
// exactly the scenario where swapping the evaluator (OpenSpiel's
// evaluator-replacement pattern) can change the final decision.
// ---------------------------------------------------------------------------

const ROOT_BRANCH = 3;
const CORRIDOR_DEPTH = 4;
const CORRIDOR_BRANCH = 4;

type CorridorChoice = string; // 'r0'..'rN' at root, '0'..'BRANCH-1' afterward

interface CorridorState {
  readonly ply: number; // 0 = root, 1..DEPTH = corridor steps, DEPTH+1 = terminal
  readonly sum: number;
}

const CORRIDOR_SPEC: GameSpec = {
  gameId: 'mcts-corridor-fixture',
  playerCount: 2,
  decisionPoints: Array.from({ length: CORRIDOR_DEPTH + 1 }, (_, i) => ({
    id: `d${i}`,
    description: `decision ${i}`,
  })),
  seatingPlan: [
    [0, 1],
    [1, 0],
  ],
  perfectInformation: true,
  maxDecisionsPerGame: CORRIDOR_DEPTH + 1,
};

function makeCorridorAdapter(
  heuristicPick: (legal: readonly CorridorChoice[]) => CorridorChoice,
): GameAdapter<CorridorState, CorridorState, CorridorChoice> {
  const base: GameAdapter<CorridorState, CorridorState, CorridorChoice> = {
    spec: CORRIDOR_SPEC,
    createInitialState: () => ({ ply: 0, sum: 0 }),
    currentDecision: (state) => {
      if (state.ply > CORRIDOR_DEPTH) return null;
      const player: PlayerId = state.ply % 2 === 0 ? 0 : 1;
      return { player, decisionPoint: `d${state.ply}` };
    },
    getObservation: (state) => state,
    getLegalChoices: (state) => {
      if (state.ply === 0) return Array.from({ length: ROOT_BRANCH }, (_, i) => `r${i}`);
      return Array.from({ length: CORRIDOR_BRANCH }, (_, i) => String(i));
    },
    applyChoice: (state, choice) => {
      const digit = state.ply === 0 ? Number(choice.slice(1)) : Number(choice);
      return { ply: state.ply + 1, sum: state.sum + digit };
    },
    getOutcome: (state) => {
      if (state.ply <= CORRIDOR_DEPTH) return null;
      const winner: PlayerId = state.sum % 2 === 0 ? 0 : 1;
      const scores = [0, 0];
      scores[winner] = 1;
      return { scores, winners: [winner] };
    },
    encodeChoice: (choice) => choice,
    baselines: {
      random: (_seed) => ({ id: 'corridor-random', decide: (_dp, _o, legal) => legal[0] as CorridorChoice }),
      heuristic: (_seed) => ({ id: 'corridor-heuristic', decide: (_dp, _o, legal) => heuristicPick(legal) }),
    },
    strategySurface: [],
  };
  return { ...base, reconstructState: (observation) => observation };
}

const CORRIDOR_CONFIG_BASE = { simulations: 80, uctC: 1.4, rolloutCount: 3, label: 'corridor' };
const CORRIDOR_SEED = 1;

describe('mctsSearch rolloutPolicy', () => {
  it('defaults to the pre-existing random-rollout behavior when omitted', () => {
    const adapter = eraseAdapter(makeCorridorAdapter((legal) => legal[legal.length - 1] as CorridorChoice));
    const rootState = adapter.createInitialState(CORRIDOR_SEED);

    const defaulted = mctsSearch(adapter, rootState, CORRIDOR_CONFIG_BASE, createRng(CORRIDOR_SEED));
    const explicitRandom = mctsSearch(
      adapter,
      rootState,
      { ...CORRIDOR_CONFIG_BASE, rolloutPolicy: 'random' },
      createRng(CORRIDOR_SEED),
    );
    expect(defaulted).toBe(explicitRandom);
  });

  it("is deterministic and returns a legal choice when rolloutPolicy is 'heuristic'", () => {
    const adapter = eraseAdapter(makeCorridorAdapter((legal) => legal[legal.length - 1] as CorridorChoice));
    const rootState = adapter.createInitialState(CORRIDOR_SEED);
    const legalRootChoices = adapter.getLegalChoices(rootState);

    const choiceA = mctsSearch(
      adapter,
      rootState,
      { ...CORRIDOR_CONFIG_BASE, rolloutPolicy: 'heuristic' },
      createRng(CORRIDOR_SEED),
    );
    const choiceB = mctsSearch(
      adapter,
      rootState,
      { ...CORRIDOR_CONFIG_BASE, rolloutPolicy: 'heuristic' },
      createRng(CORRIDOR_SEED),
    );

    expect(choiceA).toEqual(choiceB);
    expect(legalRootChoices).toContain(choiceA);
  });

  it('can steer mctsSearch to a different root decision than random rollout on the same seed/config', () => {
    // Heuristic rollout always plays the highest-digit option — a fixed,
    // deterministic policy — while random rollout draws uniformly. Neither
    // ROOT_BRANCH=3/DEPTH=4/BRANCH=4's corridor nor simulations=80 is large
    // enough to fully expand the tree, so the two evaluators disagree.
    const adapter = eraseAdapter(makeCorridorAdapter((legal) => legal[legal.length - 1] as CorridorChoice));
    const rootState = adapter.createInitialState(CORRIDOR_SEED);

    const randomChoice = mctsSearch(
      adapter,
      rootState,
      { ...CORRIDOR_CONFIG_BASE, rolloutPolicy: 'random' },
      createRng(CORRIDOR_SEED),
    );
    const heuristicChoice = mctsSearch(
      adapter,
      rootState,
      { ...CORRIDOR_CONFIG_BASE, rolloutPolicy: 'heuristic' },
      createRng(CORRIDOR_SEED),
    );

    // Values below reflect P5's fixed tie-break/expansion order
    // (docs/FIX-BACKLOG.md P5) — re-pinned after the fix, not weakened.
    expect(randomChoice).toBe('r1');
    expect(heuristicChoice).toBe('r2');
    expect(randomChoice).not.toBe(heuristicChoice);
  });
});

// ---------------------------------------------------------------------------
// Fixture: docs/GAP-ANALYSIS-8.md gomoku C-column retry — `rolloutFactory`,
// a rollout-policy override that lets a caller-supplied bot factory (not
// just `adapter.baselines.heuristic`) drive every rollout decision. Reuses
// the corridor fixture above so the same "budget too small to fully expand"
// setup exercises whether a rolloutFactory bot can steer the root decision
// the same way `rolloutPolicy: 'heuristic'` already does.
// ---------------------------------------------------------------------------

describe('mctsSearch rolloutFactory', () => {
  it('leaves existing decisions unchanged when rolloutFactory is not supplied', () => {
    // Same config/seed as the rolloutPolicy 'random' test above, just
    // re-asserted here as a direct regression pin: an MctsConfig with
    // rolloutFactory omitted must reproduce the pre-existing decision
    // exactly (P1's random-rollout path), since resolveRolloutBot only
    // consults rolloutFactory when it is explicitly set.
    const adapter = eraseAdapter(makeCorridorAdapter((legal) => legal[legal.length - 1] as CorridorChoice));
    const rootState = adapter.createInitialState(CORRIDOR_SEED);

    const withoutFactory = mctsSearch(adapter, rootState, CORRIDOR_CONFIG_BASE, createRng(CORRIDOR_SEED));
    const explicitRandomPolicy = mctsSearch(
      adapter,
      rootState,
      { ...CORRIDOR_CONFIG_BASE, rolloutPolicy: 'random' },
      createRng(CORRIDOR_SEED),
    );
    expect(withoutFactory).toBe(explicitRandomPolicy);
    expect(withoutFactory).toBe('r1'); // pinned in the rolloutPolicy suite above
  });

  it('is deterministic and returns a legal choice when rolloutFactory is supplied', () => {
    const adapter = eraseAdapter(makeCorridorAdapter((legal) => legal[legal.length - 1] as CorridorChoice));
    const rootState = adapter.createInitialState(CORRIDOR_SEED);
    const legalRootChoices = adapter.getLegalChoices(rootState);

    // A rollout factory independent of adapter.baselines.heuristic — always
    // takes the lowest-digit option (the opposite policy from the
    // heuristic-rollout fixture's highest-digit pick), so this is provably
    // driving rollouts via the factory rather than falling back to the
    // adapter's own heuristic baseline.
    const lowestDigitFactory: AnyBotFactory = (_seed) => ({
      id: 'corridor-lowest-digit',
      decide: (_dp, _observation, legal) => legal[0] as CorridorChoice,
    });

    const choiceA = mctsSearch(
      adapter,
      rootState,
      { ...CORRIDOR_CONFIG_BASE, rolloutFactory: lowestDigitFactory },
      createRng(CORRIDOR_SEED),
    );
    const choiceB = mctsSearch(
      adapter,
      rootState,
      { ...CORRIDOR_CONFIG_BASE, rolloutFactory: lowestDigitFactory },
      createRng(CORRIDOR_SEED),
    );

    expect(choiceA).toEqual(choiceB);
    expect(legalRootChoices).toContain(choiceA);
  });

  it('takes precedence over rolloutPolicy when both are supplied', () => {
    const adapter = eraseAdapter(makeCorridorAdapter((legal) => legal[legal.length - 1] as CorridorChoice));
    const rootState = adapter.createInitialState(CORRIDOR_SEED);

    // Two calls that differ only in whether rolloutPolicy: 'heuristic' is
    // also present alongside rolloutFactory — if rolloutFactory truly takes
    // precedence (rolloutPolicy ignored once rolloutFactory is set), both
    // must resolve to the exact same rollout bot and so the exact same
    // decision. If rolloutPolicy still had any effect, adding
    // rolloutPolicy: 'heuristic' on top could change which bot drives
    // rollouts and so change the result.
    const lowestDigitFactory: AnyBotFactory = (_seed) => ({
      id: 'corridor-lowest-digit',
      decide: (_dp, _observation, legal) => legal[0] as CorridorChoice,
    });

    const factoryOnlyChoice = mctsSearch(
      adapter,
      rootState,
      { ...CORRIDOR_CONFIG_BASE, rolloutFactory: lowestDigitFactory },
      createRng(CORRIDOR_SEED),
    );
    const factoryPlusHeuristicPolicyChoice = mctsSearch(
      adapter,
      rootState,
      { ...CORRIDOR_CONFIG_BASE, rolloutPolicy: 'heuristic', rolloutFactory: lowestDigitFactory },
      createRng(CORRIDOR_SEED),
    );

    expect(factoryPlusHeuristicPolicyChoice).toBe(factoryOnlyChoice);
  });
});

// ---------------------------------------------------------------------------
// Fixture: docs/FIX-BACKLOG.md P5 regression coverage. A single-decision,
// 2-player game where the root choice is immediately terminal, so each
// expanded child gets exactly one rollout with a choice-determined,
// non-random outcome. `simulations` is deliberately smaller than the branch
// count, so only some root children ever get expanded — exactly the
// "budget < branching factor" pathology the P5 fix targets, and the exact
// scenario where the pre-fix code's FIFO expansion + reward-blind tie-break
// silently discarded information.
// ---------------------------------------------------------------------------

type TieChoice = 'w' | 'x' | 'y' | 'z';

interface TieState {
  readonly chosen: TieChoice | null;
}

// Per-choice reward for player 0 (the mover who creates each root child),
// derived from `Outcome.winners` via `rewardOf`: 'w' -> 1 (sole winner),
// 'x'/'z' -> 0.5 (co-win with player 1), 'y' -> 0 (player 1 wins alone).
// 'x' and 'z' are an intentional reward tie so the encodeChoice-key fallback
// still gets exercised when both members of a tied pair are the ones that
// happen to get expanded.
const TIE_WINNERS: Record<TieChoice, readonly PlayerId[]> = {
  w: [0],
  x: [0, 1],
  y: [1],
  z: [0, 1],
};

const TIE_SPEC: GameSpec = {
  gameId: 'mcts-tie-break-fixture',
  playerCount: 2,
  decisionPoints: [{ id: 'p0', description: 'player 0 picks w/x/y/z' }],
  seatingPlan: [
    [0, 1],
    [1, 0],
  ],
  perfectInformation: true,
  maxDecisionsPerGame: 1,
};

function makeTieAdapter(): GameAdapter<TieState, TieState, TieChoice> {
  const base: GameAdapter<TieState, TieState, TieChoice> = {
    spec: TIE_SPEC,
    createInitialState: () => ({ chosen: null }),
    currentDecision: (state) => (state.chosen === null ? { player: 0, decisionPoint: 'p0' } : null),
    getObservation: (state) => state,
    getLegalChoices: () => ['w', 'x', 'y', 'z'],
    applyChoice: (_state, choice) => ({ chosen: choice }),
    getOutcome: (state) => {
      if (state.chosen === null) return null;
      const winners = TIE_WINNERS[state.chosen];
      const scores = [0, 0];
      for (const winner of winners) scores[winner] = 1;
      return { scores, winners };
    },
    encodeChoice: (choice) => choice,
    baselines: {
      random: (_seed) => ({ id: 'tie-random', decide: (_dp, _o, legal) => legal[0] as TieChoice }),
      heuristic: (_seed) => ({ id: 'tie-heuristic', decide: (_dp, _o, legal) => legal[0] as TieChoice }),
    },
    strategySurface: [],
  };
  return { ...base, reconstructState: (observation) => observation };
}

describe('mctsSearch final-selection tie-break (docs/FIX-BACKLOG.md P5)', () => {
  it('breaks an equal-visit-count tie by total reward, not by encodeChoice key alone', () => {
    // simulations=2 with 4 legal root choices guarantees exactly two children
    // get expanded (one per simulation, each with exactly one rollout), so
    // every expanded child ends the search with exploreCount=1 — a forced
    // exact tie on visit count. Before the P5 fix, the final pick fell
    // straight to the lower encodeChoice key among whichever two children got
    // expanded; after the fix it must prefer the higher-reward one instead.
    const adapter = eraseAdapter(makeTieAdapter());
    const rootState = adapter.createInitialState(1);
    const config = { simulations: 2, uctC: 1.4, rolloutCount: 1, label: 'tie' };

    // Seed 5's shuffle expands {w, x} first — 'w' (reward 1) beats 'x'
    // (reward 0.5) in total reward despite 'w' > 'x' by encodeChoice key,
    // which is exactly the case the pre-fix key-only tie-break got backwards
    // (it would have picked 'x' for having the lower key).
    const choice = mctsSearch(adapter, rootState, config, createRng(5));
    expect(choice).toBe('w');
  });

  it('falls through to the encodeChoice key only when total reward is also tied', () => {
    // Seed 1's shuffle expands the {x, z} pair, whose rewards are both 0.5
    // by construction — the key fallback is the only thing left to break the
    // tie, and 'x' < 'z' lexicographically.
    const adapter = eraseAdapter(makeTieAdapter());
    const rootState = adapter.createInitialState(1);
    const config = { simulations: 2, uctC: 1.4, rolloutCount: 1, label: 'tie' };

    const choice = mctsSearch(adapter, rootState, config, createRng(1));
    expect(choice).toBe('x');
  });
});

describe('mctsSearch expansion order (docs/FIX-BACKLOG.md P5)', () => {
  it('is deterministic for a fixed rng seed', () => {
    const adapter = eraseAdapter(makeTieAdapter());
    const rootState = adapter.createInitialState(1);
    const config = { simulations: 2, uctC: 1.4, rolloutCount: 1, label: 'tie' };

    const first = mctsSearch(adapter, rootState, config, createRng(42));
    const second = mctsSearch(adapter, rootState, config, createRng(42));
    expect(first).toBe(second);
  });

  it('changes which children get expanded (and so the final pick) when the rng seed changes', () => {
    // Same config, same budget-below-branching-factor setup as the tie-break
    // tests above, but here the point is that the *set* of expanded children
    // — not just how ties among them are broken — depends on the rng seed.
    // Before P5, expansion order was fixed by getLegalChoices (FIFO), so this
    // pair of seeds would have produced the same result regardless of seed.
    const adapter = eraseAdapter(makeTieAdapter());
    const rootState = adapter.createInitialState(1);
    const config = { simulations: 2, uctC: 1.4, rolloutCount: 1, label: 'tie' };

    const choiceSeed5 = mctsSearch(adapter, rootState, config, createRng(5));
    const choiceSeed1 = mctsSearch(adapter, rootState, config, createRng(1));
    expect(choiceSeed5).not.toBe(choiceSeed1);
  });
});
