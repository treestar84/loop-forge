/**
 * Unit tests for the UCT MCTS port (src/search/mcts.ts, docs/GAP-ANALYSIS-7.md
 * O5). Fixtures are small adapters defined in this file rather than the real
 * reference games, so the tree-search logic is exercised in isolation from
 * game-specific rules.
 */

import type { AnyBotFactory, GameAdapter, GameSpec, PlayerId } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import { eraseAdapter } from '../../loop/erase';
import { applyPriorWeightSchedule, mctsBotFactory, mctsSearch, validateMctsOptions, type MctsConfig } from '../mcts';

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

// ---------------------------------------------------------------------------
// Fixture: docs/GAP-ANALYSIS-8.md §4.6 tactical precheck (game-neutral
// "immediate win / immediate must-block"). A 5-slot claiming game: players
// alternately claim one of 5 slots; a player wins the instant they own both
// slots of either winning pair ([0,1] or [2,3]) — slot 4 belongs to no pair
// and can never win anything, pure filler. `initialOwners` seeds who (if
// anyone) already owns which slot before the search root, letting each test
// construct a specific tactical shape without playing the game out move by
// move.
// ---------------------------------------------------------------------------

type PrecheckOwner = PlayerId | null;
type PrecheckChoice = number; // slot index 0..4

interface PrecheckState {
  readonly owners: readonly PrecheckOwner[];
}

const PRECHECK_PAIRS: readonly (readonly [number, number])[] = [
  [0, 1],
  [2, 3],
];

const PRECHECK_SPEC: GameSpec = {
  gameId: 'mcts-tactical-precheck-fixture',
  playerCount: 2,
  decisionPoints: [{ id: 'pick', description: 'claim a slot' }],
  seatingPlan: [
    [0, 1],
    [1, 0],
  ],
  perfectInformation: true,
  maxDecisionsPerGame: 5,
};

function precheckWinner(owners: readonly PrecheckOwner[]): PlayerId | null {
  for (const [a, b] of PRECHECK_PAIRS) {
    const ownerA = owners[a] as PrecheckOwner;
    if (ownerA !== null && ownerA === owners[b]) return ownerA;
  }
  return null;
}

function precheckTerminal(owners: readonly PrecheckOwner[]): boolean {
  return precheckWinner(owners) !== null || owners.every((o) => o !== null);
}

function makePrecheckAdapter(
  initialOwners: readonly PrecheckOwner[],
): GameAdapter<PrecheckState, PrecheckState, PrecheckChoice> {
  const base: GameAdapter<PrecheckState, PrecheckState, PrecheckChoice> = {
    spec: PRECHECK_SPEC,
    createInitialState: () => ({ owners: initialOwners }),
    currentDecision: (state) => {
      if (precheckTerminal(state.owners)) return null;
      const claimed = state.owners.filter((o) => o !== null).length;
      return { player: (claimed % 2) as PlayerId, decisionPoint: 'pick' };
    },
    getObservation: (state) => state,
    getLegalChoices: (state) =>
      state.owners.flatMap((o, i) => (o === null ? [i] : [])),
    applyChoice: (state, choice) => {
      const claimed = state.owners.filter((o) => o !== null).length;
      const mover = (claimed % 2) as PlayerId;
      const owners = state.owners.slice();
      owners[choice] = mover;
      return { owners };
    },
    getOutcome: (state) => {
      if (!precheckTerminal(state.owners)) return null;
      const winner = precheckWinner(state.owners);
      const scores = [0, 0];
      const winners: PlayerId[] = winner === null ? [] : [winner];
      if (winner !== null) scores[winner] = 1;
      return { scores, winners };
    },
    encodeChoice: (choice) => String(choice),
    baselines: {
      random: (_seed) => ({ id: 'precheck-random', decide: (_dp, _o, legal) => legal[0] as PrecheckChoice }),
      heuristic: (_seed) => ({ id: 'precheck-heuristic', decide: (_dp, _o, legal) => legal[0] as PrecheckChoice }),
    },
    strategySurface: [],
  };
  return { ...base, reconstructState: (observation) => observation };
}

const PRECHECK_BASE_CONFIG = { simulations: 50, uctC: 1.4, rolloutCount: 2, label: 'precheck' };

describe('mctsSearch tacticalDepth (docs/GAP-ANALYSIS-8.md §4.6)', () => {
  it('tacticalDepth omitted reproduces the exact same decision as an explicit 0 (regression pin)', () => {
    // slot1 already owned by player 1 (a live trap on pair [0,1]), slot4 by
    // player 0 (filler) — a position where tacticalDepth would matter if it
    // were active, so this proves the omitted/0 path truly ignores it.
    const adapter = eraseAdapter(makePrecheckAdapter([null, 0, null, null, 1]));
    const rootState = adapter.createInitialState(1);

    const omitted = mctsSearch(adapter, rootState, PRECHECK_BASE_CONFIG, createRng(11));
    const explicitZero = mctsSearch(adapter, rootState, { ...PRECHECK_BASE_CONFIG, tacticalDepth: 0 }, createRng(11));
    expect(omitted).toBe(explicitZero);
  });

  it('depth=1 returns an immediate winning move without running any simulation', () => {
    // slot0 already owned by player 0; slot1 (its pair partner) is open —
    // taking it wins on the spot. slot4 owned by player 1 is filler to make
    // the claimed count even (player 0's turn).
    const adapter = eraseAdapter(makePrecheckAdapter([0, null, null, null, 1]));
    const rootState = adapter.createInitialState(1);
    // simulations: 0 means the ordinary MCTS loop would throw
    // ("root produced no children after search") since no child is ever
    // expanded — reaching a real return value here proves the win was
    // returned before the simulation loop ran at all.
    const config = { simulations: 0, uctC: 1.4, rolloutCount: 1, label: 'precheck-win', tacticalDepth: 1 as const };

    const choice = mctsSearch(adapter, rootState, config, createRng(3));
    expect(choice).toBe(1);
  });

  it('without tacticalDepth, simulations=0 throws (contrast for the depth=1 test above)', () => {
    const adapter = eraseAdapter(makePrecheckAdapter([0, null, null, null, 1]));
    const rootState = adapter.createInitialState(1);
    const config = { simulations: 0, uctC: 1.4, rolloutCount: 1, label: 'precheck-no-tactic' };

    expect(() => mctsSearch(adapter, rootState, config, createRng(3))).toThrow(/no children/);
  });

  it('depth=2 excludes every root choice that hands the opponent an immediate win', () => {
    // slot1 owned by player 1 (a live trap on pair [0,1]: whoever completes
    // it next wins), slot4 owned by player 0 (filler). Legal = [0,2,3].
    // Only slot0 defuses the trap (takes the pair's other half); slot2 and
    // slot3 both leave slot0 open for player 1 to complete the pair next —
    // provably unsafe regardless of everything else in the position.
    const adapter = eraseAdapter(makePrecheckAdapter([null, 1, null, null, 0]));
    const rootState = adapter.createInitialState(1);
    const config = { ...PRECHECK_BASE_CONFIG, tacticalDepth: 2 as const };

    for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
      const choice = mctsSearch(adapter, rootState, config, createRng(seed));
      expect(choice).toBe(0);
    }
  });

  it('is deterministic: same seed and config reproduce the same depth=2 decision', () => {
    const adapter = eraseAdapter(makePrecheckAdapter([null, 1, null, null, 0]));
    const rootState = adapter.createInitialState(1);
    const config = { ...PRECHECK_BASE_CONFIG, tacticalDepth: 2 as const };

    const first = mctsSearch(adapter, rootState, config, createRng(9));
    const second = mctsSearch(adapter, rootState, config, createRng(9));
    expect(first).toBe(second);
  });

  it('falls back to the full legal set when every choice is unsafe (no forced-loss narrowing)', () => {
    // slot1 owned by player 1 AND slot3 owned by player 1 — both pairs are
    // one move away from a player-1 win, and player 0 only has one move
    // (slot4 is the only unclaimed slot besides 0 and 2, both of which are
    // each individually unsafe) so no matter what player 0 picks, player 1
    // wins next turn either way. depth=2 must not crash or produce an empty
    // candidate set — it must fall back to the ordinary (unfiltered) search.
    const adapter = eraseAdapter(makePrecheckAdapter([null, 1, null, 1, null]));
    const rootState = adapter.createInitialState(1);
    const config = { ...PRECHECK_BASE_CONFIG, tacticalDepth: 2 as const };

    const legal = adapter.getLegalChoices(rootState);
    const choice = mctsSearch(adapter, rootState, config, createRng(4));
    expect(legal).toContain(choice);
  });

  it('tacticalBranchCap large enough to cover every legal choice matches the uncapped depth=2 result', () => {
    const adapter = eraseAdapter(makePrecheckAdapter([null, 1, null, null, 0]));
    const rootState = adapter.createInitialState(1);
    const uncapped = { ...PRECHECK_BASE_CONFIG, tacticalDepth: 2 as const };
    const capped = { ...uncapped, tacticalBranchCap: 100 };

    const uncappedChoice = mctsSearch(adapter, rootState, uncapped, createRng(2));
    const cappedChoice = mctsSearch(adapter, rootState, capped, createRng(2));
    expect(cappedChoice).toBe(uncappedChoice);
  });

  it('tacticalBranchCap narrower than the legal set still returns a legal, deterministic choice', () => {
    const adapter = eraseAdapter(makePrecheckAdapter([null, 1, null, null, 0]));
    const rootState = adapter.createInitialState(1);
    const legal = adapter.getLegalChoices(rootState);
    const config = { ...PRECHECK_BASE_CONFIG, tacticalDepth: 2 as const, tacticalBranchCap: 1 };

    const first = mctsSearch(adapter, rootState, config, createRng(6));
    const second = mctsSearch(adapter, rootState, config, createRng(6));
    expect(first).toBe(second);
    expect(legal).toContain(first);
  });
});

// ---------------------------------------------------------------------------
// Fixture: rootOverride (docs/GAP-ANALYSIS-8.md gomoku C-column retry —
// "shallow MCTS dilutes a deterministic tactical signal"). Reuses the
// tactical-precheck fixture above so the same slot-claiming geometry can
// double as an override-injection target.
// ---------------------------------------------------------------------------

describe('mctsSearch rootOverride', () => {
  it('a config with rootOverride omitted reproduces the exact same pinned decision as before this field existed (regression)', () => {
    // Same fixture/seed/config as the tacticalDepth depth=2 test above, whose
    // pinned expectation (choice 0) predates rootOverride's existence — this
    // re-pins it after adding the new (unused-here) field to MctsConfig,
    // proving the field is truly additive.
    const adapter = eraseAdapter(makePrecheckAdapter([null, 1, null, null, 0]));
    const rootState = adapter.createInitialState(1);
    const config = { ...PRECHECK_BASE_CONFIG, tacticalDepth: 2 as const };

    const choice = mctsSearch(adapter, rootState, config, createRng(1));
    expect(choice).toBe(0);
  });

  it('a non-null rootOverride short-circuits the search entirely — works even with simulations=0', () => {
    const adapter = eraseAdapter(makePrecheckAdapter([null, null, null, null, null]));
    const rootState = adapter.createInitialState(1);
    // simulations: 0 means the ordinary MCTS loop would throw ("root produced
    // no children after search") since no child is ever expanded — reaching
    // a real return value here proves rootOverride's choice was returned
    // before the simulation loop ran at all (no simulation ever happens).
    const config = {
      simulations: 0,
      uctC: 1.4,
      rolloutCount: 1,
      label: 'root-override-shortcircuit',
      rootOverride: () => 2,
    };

    const choice = mctsSearch(adapter, rootState, config, createRng(3));
    expect(choice).toBe(2);
  });

  it('a null-returning rootOverride falls through to ordinary MCTS, unaffected', () => {
    const adapter = eraseAdapter(makePrecheckAdapter([null, null, null, null, null]));
    const rootState = adapter.createInitialState(1);

    const withNullOverride = mctsSearch(
      adapter,
      rootState,
      { ...PRECHECK_BASE_CONFIG, rootOverride: () => null },
      createRng(11),
    );
    const withoutOverride = mctsSearch(adapter, rootState, PRECHECK_BASE_CONFIG, createRng(11));
    expect(withNullOverride).toBe(withoutOverride);
  });

  it("tacticalDepth's immediate-win check takes priority over rootOverride when both would fire", () => {
    // slot0 already owned by player 0; slot1 (its pair partner) is open —
    // taking it wins on the spot (same geometry as the tacticalDepth depth=1
    // test above). rootOverride deliberately returns a *different* legal
    // choice (slot2) to prove the immediate win wins the race, not the override.
    const adapter = eraseAdapter(makePrecheckAdapter([0, null, null, null, 1]));
    const rootState = adapter.createInitialState(1);
    const config = {
      simulations: 0,
      uctC: 1.4,
      rolloutCount: 1,
      label: 'precheck-win-vs-override',
      tacticalDepth: 1 as const,
      rootOverride: () => 2,
    };

    const choice = mctsSearch(adapter, rootState, config, createRng(3));
    expect(choice).toBe(1);
  });

  it('is deterministic: same seed and config reproduce the same rootOverride-driven decision', () => {
    const adapter = eraseAdapter(makePrecheckAdapter([null, null, null, null, null]));
    const rootState = adapter.createInitialState(1);
    const config = {
      simulations: 0,
      uctC: 1.4,
      rolloutCount: 1,
      label: 'root-override-deterministic',
      rootOverride: () => 3,
    };

    const first = mctsSearch(adapter, rootState, config, createRng(9));
    const second = mctsSearch(adapter, rootState, config, createRng(9));
    expect(first).toBe(second);
    expect(first).toBe(3);
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

// ---------------------------------------------------------------------------
// Fixture: docs/GAP-ANALYSIS-11.md D2/ADR-0011 tree prior (`priorWeight`/
// `priorSource`). A single-decision 3-arm bandit whose true reward ordering
// (best=1 > other=0.5 co-win > lure=0) is deliberately *inverted* by
// `choiceEvaluator`'s scores (lure=100 > other=0 > best=-100) — a candidate
// picked purely to prove the prior can override plain UCT statistics early
// (small `simulations`) and that the override fades as visits accumulate
// (large `simulations`, "progressive bias" decaying via the `1/(1+n)`
// denominator in MctsConfig.priorWeight's UCB term).
// ---------------------------------------------------------------------------

type BanditChoice = 'best' | 'lure' | 'other';

interface BanditState {
  readonly chosen: BanditChoice | null;
}

const BANDIT_WINNERS: Record<BanditChoice, readonly PlayerId[]> = {
  best: [0],
  other: [0, 1],
  lure: [1],
};

const BANDIT_SPEC: GameSpec = {
  gameId: 'mcts-prior-bandit-fixture',
  playerCount: 2,
  decisionPoints: [{ id: 'pick', description: 'pick best/lure/other' }],
  seatingPlan: [
    [0, 1],
    [1, 0],
  ],
  perfectInformation: true,
  maxDecisionsPerGame: 1,
};

function makeBanditAdapter(withEvaluator: boolean): GameAdapter<BanditState, BanditState, BanditChoice> {
  const base: GameAdapter<BanditState, BanditState, BanditChoice> = {
    spec: BANDIT_SPEC,
    createInitialState: () => ({ chosen: null }),
    currentDecision: (state) => (state.chosen === null ? { player: 0, decisionPoint: 'pick' } : null),
    getObservation: (state) => state,
    getLegalChoices: () => ['best', 'lure', 'other'],
    applyChoice: (_state, choice) => ({ chosen: choice }),
    getOutcome: (state) => {
      if (state.chosen === null) return null;
      const winners = BANDIT_WINNERS[state.chosen];
      const scores = [0, 0];
      for (const winner of winners) scores[winner] = 1;
      return { scores, winners };
    },
    encodeChoice: (choice) => choice,
    baselines: {
      random: (_seed) => ({ id: 'bandit-random', decide: (_dp, _o, legal) => legal[0] as BanditChoice }),
      heuristic: (_seed) => ({ id: 'bandit-heuristic', decide: (_dp, _o, legal) => legal[0] as BanditChoice }),
    },
    strategySurface: [],
  };
  if (!withEvaluator) {
    return { ...base, reconstructState: (observation) => observation };
  }
  return {
    ...base,
    reconstructState: (observation) => observation,
    choiceEvaluator: (_state, _player, choices) =>
      (choices as readonly BanditChoice[]).map((choice) =>
        choice === 'lure' ? 100 : choice === 'other' ? 0 : -100,
      ),
  };
}

const BANDIT_SEED = 1;

describe('mctsSearch priorWeight/priorSource (docs/GAP-ANALYSIS-11.md D2, ADR-0011)', () => {
  it('priorWeight unset/0 reproduces the exact pre-prior decision (regression pin)', () => {
    const adapter = eraseAdapter(makeBanditAdapter(true));
    const rootState = adapter.createInitialState(BANDIT_SEED);
    const config = { simulations: 20, uctC: 1.4, rolloutCount: 1, label: 'bandit' };

    const omitted = mctsSearch(adapter, rootState, config, createRng(BANDIT_SEED));
    const explicitZero = mctsSearch(adapter, rootState, { ...config, priorWeight: 0 }, createRng(BANDIT_SEED));
    expect(omitted).toBe(explicitZero);
    expect(omitted).toBe('best'); // true reward ordering wins when the prior is inactive
  });

  it('biases early visits toward the evaluator-favored (but truly worse) choice at a small simulation budget', () => {
    const adapter = eraseAdapter(makeBanditAdapter(true));
    const rootState = adapter.createInitialState(BANDIT_SEED);
    const config = { simulations: 20, uctC: 1.4, rolloutCount: 1, label: 'bandit', priorWeight: 50 };

    const choice = mctsSearch(adapter, rootState, config, createRng(BANDIT_SEED));
    expect(choice).toBe('lure');
  });

  it('progressive bias decays: at a large simulation budget the true reward reasserts despite the same strong prior', () => {
    const adapter = eraseAdapter(makeBanditAdapter(true));
    const rootState = adapter.createInitialState(BANDIT_SEED);
    const config = { simulations: 2000, uctC: 1.4, rolloutCount: 1, label: 'bandit', priorWeight: 50 };

    const choice = mctsSearch(adapter, rootState, config, createRng(BANDIT_SEED));
    expect(choice).toBe('best'); // same result as priorWeight unset at scale — the prior no longer decides
  });

  it('is deterministic: same seed and config reproduce the same prior-biased decision', () => {
    const adapter = eraseAdapter(makeBanditAdapter(true));
    const rootState = adapter.createInitialState(BANDIT_SEED);
    const config = { simulations: 20, uctC: 1.4, rolloutCount: 1, label: 'bandit', priorWeight: 50 };

    const first = mctsSearch(adapter, rootState, config, createRng(9));
    const second = mctsSearch(adapter, rootState, config, createRng(9));
    expect(first).toBe(second);
  });

  it('throws a clear error when priorWeight is active but the adapter declares no choiceEvaluator', () => {
    const adapter = eraseAdapter(makeBanditAdapter(false));
    const rootState = adapter.createInitialState(BANDIT_SEED);
    const config = { simulations: 20, uctC: 1.4, rolloutCount: 1, label: 'bandit', priorWeight: 50 };

    expect(() => mctsSearch(adapter, rootState, config, createRng(BANDIT_SEED))).toThrow(/choiceEvaluator/);
  });

  it('throws the same clear error when priorSource is explicitly set without an adapter-declared choiceEvaluator', () => {
    const adapter = eraseAdapter(makeBanditAdapter(false));
    const rootState = adapter.createInitialState(BANDIT_SEED);
    const config = {
      simulations: 20,
      uctC: 1.4,
      rolloutCount: 1,
      label: 'bandit',
      priorWeight: 1,
      priorSource: 'choiceEvaluator' as const,
    };

    expect(() => mctsSearch(adapter, rootState, config, createRng(BANDIT_SEED))).toThrow(/choiceEvaluator/);
  });
});

// The same lure-inverted evaluator as the adapter's `choiceEvaluator` above,
// supplied instead as a `MctsConfig.priorEvaluator` function value — proves
// direct injection biases the search the same way `priorSource:
// 'choiceEvaluator'` does, and does so even on an adapter that declares no
// `choiceEvaluator` at all (docs/GAP-ANALYSIS-11.md Phase 3-B B3).
const BANDIT_PRIOR_EVALUATOR = (_state: unknown, _player: PlayerId, choices: readonly unknown[]): readonly number[] =>
  (choices as readonly BanditChoice[]).map((choice) => (choice === 'lure' ? 100 : choice === 'other' ? 0 : -100));

describe('mctsSearch priorEvaluator (docs/GAP-ANALYSIS-11.md Phase 3-B B3)', () => {
  it('priorEvaluator unset reproduces the exact pre-prior decision (regression pin)', () => {
    const adapter = eraseAdapter(makeBanditAdapter(false));
    const rootState = adapter.createInitialState(BANDIT_SEED);
    const config = { simulations: 20, uctC: 1.4, rolloutCount: 1, label: 'bandit' };

    const omitted = mctsSearch(adapter, rootState, config, createRng(BANDIT_SEED));
    const explicitZeroWeight = mctsSearch(adapter, rootState, { ...config, priorWeight: 0 }, createRng(BANDIT_SEED));
    expect(omitted).toBe(explicitZeroWeight);
    expect(omitted).toBe('best');
  });

  it('biases early visits toward the injected-evaluator-favored (but truly worse) choice, with no adapter choiceEvaluator declared', () => {
    const adapter = eraseAdapter(makeBanditAdapter(false));
    const rootState = adapter.createInitialState(BANDIT_SEED);
    const config = {
      simulations: 20,
      uctC: 1.4,
      rolloutCount: 1,
      label: 'bandit',
      priorWeight: 50,
      priorEvaluator: BANDIT_PRIOR_EVALUATOR,
    };

    const choice = mctsSearch(adapter, rootState, config, createRng(BANDIT_SEED));
    expect(choice).toBe('lure');
  });

  it('progressive bias decays at a large simulation budget, same as the choiceEvaluator path', () => {
    const adapter = eraseAdapter(makeBanditAdapter(false));
    const rootState = adapter.createInitialState(BANDIT_SEED);
    const config = {
      simulations: 2000,
      uctC: 1.4,
      rolloutCount: 1,
      label: 'bandit',
      priorWeight: 50,
      priorEvaluator: BANDIT_PRIOR_EVALUATOR,
    };

    const choice = mctsSearch(adapter, rootState, config, createRng(BANDIT_SEED));
    expect(choice).toBe('best');
  });

  it('takes precedence over the adapter-declared choiceEvaluator when both are present', () => {
    // The adapter's own choiceEvaluator (makeBanditAdapter(true)) also inverts toward
    // "lure", so this alone would not distinguish precedence — supply a priorEvaluator
    // that inverts toward "other" instead and confirm that wins, not "lure".
    const adapter = eraseAdapter(makeBanditAdapter(true));
    const rootState = adapter.createInitialState(BANDIT_SEED);
    const otherFavoringEvaluator = (
      _state: unknown,
      _player: PlayerId,
      choices: readonly unknown[],
    ): readonly number[] =>
      (choices as readonly BanditChoice[]).map((choice) => (choice === 'other' ? 100 : choice === 'lure' ? 0 : -100));
    const config = {
      simulations: 20,
      uctC: 1.4,
      rolloutCount: 1,
      label: 'bandit',
      priorWeight: 50,
      priorEvaluator: otherFavoringEvaluator,
    };

    const choice = mctsSearch(adapter, rootState, config, createRng(BANDIT_SEED));
    expect(choice).toBe('other');
  });
});

describe('applyPriorWeightSchedule / priorWeightSchedule (docs/GAP-ANALYSIS-11.md Phase 4-B B3 처치 2)', () => {
  const BASE_CONFIG: MctsConfig = { simulations: 20, uctC: 1.4, rolloutCount: 1, label: 'sched', priorWeight: 16 };

  it('returns the exact same config object (by reference) when priorWeightSchedule is unset — regression pin', () => {
    expect(applyPriorWeightSchedule(BASE_CONFIG, 0)).toBe(BASE_CONFIG);
    expect(applyPriorWeightSchedule(BASE_CONFIG, 7)).toBe(BASE_CONFIG);
  });

  it('substitutes priorWeight from the schedule, leaving every other field untouched', () => {
    const config: MctsConfig = { ...BASE_CONFIG, priorWeightSchedule: (decisionIndex) => (decisionIndex < 12 ? 48 : 16) };
    const early = applyPriorWeightSchedule(config, 0);
    const late = applyPriorWeightSchedule(config, 12);
    expect(early.priorWeight).toBe(48);
    expect(late.priorWeight).toBe(16);
    expect(early.label).toBe('sched');
    expect(early.simulations).toBe(20);
  });

  it('mctsBotFactory calls the schedule with a per-instance, incrementing decisionIndex across successive decide() calls', () => {
    const adapter = eraseAdapter(makeTacticalAdapter(true));
    const observation = { ply: 0 as const, p0Choice: null };
    const legal = ['a', 'b', 'c'];
    const seenIndices: number[] = [];
    const config: MctsConfig = {
      simulations: 5,
      uctC: 1.4,
      rolloutCount: 1,
      label: 'sched-bot',
      priorWeight: 0,
      priorWeightSchedule: (decisionIndex) => {
        seenIndices.push(decisionIndex);
        return 0;
      },
    };
    const bot = mctsBotFactory(adapter, config)(1);
    bot.decide('p0', observation, legal);
    bot.decide('p0', observation, legal);
    bot.decide('p0', observation, legal);
    expect(seenIndices).toEqual([0, 1, 2]);
  });
});

describe('validateMctsOptions (docs/FIX-BACKLOG.md E5 option-combination contract)', () => {
  const BASE_CONFIG: MctsConfig = { simulations: 20, uctC: 1.4, rolloutCount: 1, label: 'options' };
  const DIRECT_EVALUATOR: NonNullable<MctsConfig['priorEvaluator']> = () => [0];

  it('accepts a baseline config with no optional controls', () => {
    expect(validateMctsOptions(BASE_CONFIG)).toEqual({ errors: [], warnings: [] });
  });

  it('accepts an explicit adapter prior source with an active prior weight', () => {
    expect(validateMctsOptions({ ...BASE_CONFIG, priorWeight: 8, priorSource: 'choiceEvaluator' })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('accepts rolloutFactory plus rolloutPolicy because the documented factory precedence is intentional', () => {
    const rolloutFactory: AnyBotFactory = () => ({ id: 'rollout', decide: () => 'choice' });
    expect(validateMctsOptions({ ...BASE_CONFIG, rolloutPolicy: 'heuristic', rolloutFactory })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('warns that a weight without an explicit source/evaluator uses the runtime implicit choiceEvaluator source', () => {
    expect(validateMctsOptions({ ...BASE_CONFIG, priorWeight: 8 }).warnings).toEqual([
      "priorWeight uses the implicit priorSource 'choiceEvaluator'; mctsSearch/ismctsSearch will throw if the adapter lacks choiceEvaluator",
    ]);
  });

  it('rejects an unknown priorSource even when it entered through untyped configuration', () => {
    const config = { ...BASE_CONFIG, priorSource: 'other' } as unknown as MctsConfig;
    expect(validateMctsOptions(config).errors).toEqual(["unknown priorSource \"other\"; v1 supports only 'choiceEvaluator'"]);
  });

  it('warns that a standalone schedule depends on its runtime values and the implicit adapter evaluator', () => {
    expect(validateMctsOptions({ ...BASE_CONFIG, priorWeightSchedule: () => 8 }).warnings).toEqual([
      "priorWeightSchedule may activate the implicit priorSource 'choiceEvaluator'; its returned weights and adapter availability are runtime-dependent",
    ]);
  });

  it('warns when tacticalBranchCap is configured for a tactical depth where it is ignored', () => {
    expect(validateMctsOptions({ ...BASE_CONFIG, tacticalDepth: 1, tacticalBranchCap: 10 }).warnings).toEqual([
      'tacticalBranchCap is ignored unless tacticalDepth is 2',
    ]);
  });

  it('warns when priorSource is inert without a fixed positive weight or schedule', () => {
    expect(validateMctsOptions({ ...BASE_CONFIG, priorSource: 'choiceEvaluator' }).warnings).toEqual([
      'priorSource is ignored because priorWeight is not positive and priorWeightSchedule is unset',
    ]);
  });

  it('warns when priorEvaluator is inert without a fixed positive weight or schedule', () => {
    expect(validateMctsOptions({ ...BASE_CONFIG, priorEvaluator: DIRECT_EVALUATOR }).warnings).toEqual([
      'priorEvaluator is ignored because priorWeight is not positive and priorWeightSchedule is unset',
    ]);
  });
});
