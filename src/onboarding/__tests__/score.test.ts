import { eraseAdapter } from '../../loop/erase';
import { gomokuAdapter } from '../../reference/gomoku';
import { miniTrickAdapter } from '../../reference/mini-trick';
import { scoreAdapter } from '../score';

const adapter = eraseAdapter(miniTrickAdapter);

describe('scoreAdapter — mini-trick (a conformant adapter)', () => {
  // mini-trick deliberately ships one no-op strategy flag (noopSort) to prove
  // the wave-runner/C6 no-op screen actually rejects no-ops — that caps C6 at
  // 2/3 distinct flags = 67. The default threshold (70) is tuned for adapters
  // without an intentional no-op demo flag, so this call uses a threshold
  // that reflects mini-trick's known ceiling.
  const report = scoreAdapter(adapter, { threshold: 65 });

  it('has zero blockers on every axis', () => {
    for (const axisResult of report.axes) {
      expect(axisResult.blockers).toEqual([]);
    }
  }, 20_000);

  it('is not ready — C7 caps at 60 because its replayFixtures are all self-play, not original-game replays', () => {
    const c7 = report.axes.find((a) => a.axis === 'C7-parity');
    expect(c7?.score).toBe(60);
    expect(report.ready).toBe(false);
  }, 20_000);

  it('flags noopSort as the sole non-distinct strategy flag (C6)', () => {
    const c6 = report.axes.find((a) => a.axis === 'C6-strategy-surface');
    expect(c6?.score).toBe(67);
    expect(c6?.notes.some((note) => note.includes('noopSort'))).toBe(true);
  }, 20_000);
});

describe('scoreAdapter — a broken adapter without hiddenInfoProbe', () => {
  it('scores C3 as a 0-point blocker', () => {
    const { hiddenInfoProbe: _removed, ...withoutProbe } = miniTrickAdapter;
    const broken = eraseAdapter(withoutProbe);
    const report = scoreAdapter(broken, { threshold: 65 });
    const c3 = report.axes.find((a) => a.axis === 'C3-hidden-info');
    expect(c3?.score).toBe(0);
    expect(c3?.blockers.some((b) => b.code === 'C3_NO_PROBE')).toBe(true);
    expect(report.ready).toBe(false);
  });
});

describe('scoreAdapter — a broken adapter that leaks the opponent hand into observations', () => {
  it('scores C3 as a 0-point blocker for the observation leak', () => {
    const leakyAdapter = {
      ...miniTrickAdapter,
      getObservation(state: typeof miniTrickAdapter extends { createInitialState(seed: number): infer S }
        ? S
        : never, player: 0 | 1) {
        const base = miniTrickAdapter.getObservation(state, player);
        const opponent = player === 0 ? 1 : 0;
        return { ...base, opponentHandLeak: state.hands[opponent] };
      },
    };
    const broken = eraseAdapter(leakyAdapter);
    const report = scoreAdapter(broken, { threshold: 65 });
    const c3 = report.axes.find((a) => a.axis === 'C3-hidden-info');
    expect(c3?.score).toBe(0);
    expect(c3?.blockers.some((b) => b.code === 'C3_OBSERVATION_LEAK')).toBe(true);
    expect(report.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A2: spec.perfectInformation (C3 pass / contradiction)
// ---------------------------------------------------------------------------

describe('scoreAdapter — a perfect-information adapter (A2)', () => {
  it('passes C3 with a not-applicable note when perfectInformation is declared and hiddenInfoProbe is absent', () => {
    const { hiddenInfoProbe: _removed, ...withoutProbe } = miniTrickAdapter;
    const perfectInfoAdapter = {
      ...withoutProbe,
      spec: { ...miniTrickAdapter.spec, perfectInformation: true as const },
    };
    const broken = eraseAdapter(perfectInfoAdapter);
    const report = scoreAdapter(broken, { threshold: 65 });
    const c3 = report.axes.find((a) => a.axis === 'C3-hidden-info');
    expect(c3?.score).toBe(100);
    expect(c3?.blockers).toEqual([]);
    expect(c3?.notes.some((note) => note.includes('완전정보 게임'))).toBe(true);
  });

  it('scores C3 as a 0-point blocker when perfectInformation and hiddenInfoProbe contradict each other', () => {
    const contradictoryAdapter = {
      ...miniTrickAdapter,
      spec: { ...miniTrickAdapter.spec, perfectInformation: true as const },
    };
    const broken = eraseAdapter(contradictoryAdapter);
    const report = scoreAdapter(broken, { threshold: 65 });
    const c3 = report.axes.find((a) => a.axis === 'C3-hidden-info');
    expect(c3?.score).toBe(0);
    expect(c3?.blockers.some((b) => b.code === 'C3_PERFECT_INFO_CONTRADICTION')).toBe(true);
    expect(report.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A1: C1 seed-diversity check
// ---------------------------------------------------------------------------

describe('scoreAdapter — a fixed-opening adapter (A1 seed diversity)', () => {
  it('blocks C1 when every seed replays the same random self-play trajectory', () => {
    // Ignores the seed passed to createInitialState entirely — a stand-in for
    // a chess-like adapter with a fixed initial position and no seed-indexed
    // opening diversity.
    const fixedOpeningAdapter = {
      ...miniTrickAdapter,
      createInitialState: (_seed: number) => miniTrickAdapter.createInitialState(1),
    };
    const broken = eraseAdapter(fixedOpeningAdapter);
    const report = scoreAdapter(broken, { threshold: 65 });
    const c1 = report.axes.find((a) => a.axis === 'C1-determinism');
    expect(c1?.blockers.some((b) => b.code === 'C1_SEED_DIVERSITY')).toBe(true);
    expect(
      c1?.blockers.some((b) =>
        b.remediation.includes('시드-인덱스 오프닝 다양성'),
      ),
    ).toBe(true);
    expect(report.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A4: C4 decisions/sec reporting
// ---------------------------------------------------------------------------

describe('scoreAdapter — C4 throughput reporting (A4)', () => {
  it('reports both decisions/sec and games/sec, scoring on decisions/sec', () => {
    const report = scoreAdapter(adapter, { threshold: 65 });
    const c4 = report.axes.find((a) => a.axis === 'C4-throughput');
    expect(c4?.notes.some((note) => note.includes('decisions/sec'))).toBe(true);
    expect(c4?.notes.some((note) => note.includes('games/sec'))).toBe(true);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// G2: solo/co-op games are out of scope for v1 (docs/GAP-ANALYSIS-2.md G2)
// ---------------------------------------------------------------------------

describe('scoreAdapter — a solo (playerCount < 2) adapter (G2)', () => {
  // A minimal, internally-consistent 1-player adapter (its own valid
  // seatingPlan/playerCount pairing) — isolates the G2 check from unrelated
  // playerCount/seatingPlan mismatches that would otherwise crash runMatch
  // before any axis gets to report.
  interface SoloState {
    readonly done: boolean;
  }
  const soloAdapter = eraseAdapter({
    spec: {
      gameId: 'solo-noop',
      playerCount: 1,
      decisionPoints: [{ id: 'noop', description: 'The only decision; ends the game.' }],
      seatingPlan: [[0], [0]] as const,
      maxDecisionsPerGame: 1,
    },
    createInitialState: (_seed: number): SoloState => ({ done: false }),
    currentDecision: (state: SoloState) => (state.done ? null : { player: 0 as const, decisionPoint: 'noop' }),
    getObservation: (_state: SoloState, _player: 0) => ({}),
    getLegalChoices: (_state: SoloState) => ['noop'] as const,
    applyChoice: (_state: SoloState, _choice: 'noop'): SoloState => ({ done: true }),
    getOutcome: (state: SoloState) => (state.done ? { scores: [1], winners: [0 as const] } : null),
    encodeChoice: (choice: 'noop') => choice,
    baselines: {
      random: () => ({ id: 'solo-bot', decide: (_dp: string, _obs: unknown, legal: readonly string[]) => legal[0] as 'noop' }),
      heuristic: () => ({ id: 'solo-bot', decide: (_dp: string, _obs: unknown, legal: readonly string[]) => legal[0] as 'noop' }),
    },
    strategySurface: [],
  });

  it('blocks C0 with a roadmap remediation instead of accepting a non-competitive game', () => {
    const report = scoreAdapter(soloAdapter, { threshold: 65 });
    const c0 = report.axes.find((a) => a.axis === 'C0-contract');
    expect(c0?.blockers.some((b) => b.code === 'C0_SOLO_OR_COOP_UNSUPPORTED')).toBe(true);
    expect(
      c0?.blockers.some((b) => b.remediation.includes('GAP-ANALYSIS-2.md G2')),
    ).toBe(true);
    expect(report.ready).toBe(false);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Z1: C2's illegal-choice spot-check must not false-positive on large legal
// spaces (docs/FIX-BACKLOG.md Z1 — the gomoku onboarding regression).
//
// gomoku's legal-choice space (up to 225 empty cells) is exactly what
// exposed the bug: the spot-check's legalChoicePools collect up to 3 entries
// per game in a single continuous push (one game can fill the whole pool by
// itself), so a pool index does not correspond 1:1 with a distinct gameSeed.
// The old code reconstructed a "target" replay state from
// `seedBase + 2000 + otherIndex`, which is frequently the wrong game/depth
// entirely; with a legal space this large, the reconstructed (wrong) state
// almost always still finds the "foreign" choice legal, so applyChoice never
// throws and the spot-check false-positives a C2_ILLEGAL_CHOICE_ACCEPTED
// blocker even though applyChoice correctly rejects genuinely illegal
// choices. This pinned gomoku's C2 axis at score 0 unconditionally.
// ---------------------------------------------------------------------------

describe('scoreAdapter — C2 illegal-choice spot-check on gomoku (Z1)', () => {
  it('does not false-positive C2_ILLEGAL_CHOICE_ACCEPTED and scores C2 near 100', () => {
    const wideAdapter = eraseAdapter(gomokuAdapter);
    const report = scoreAdapter(wideAdapter, { threshold: 70 });
    const c2 = report.axes.find((a) => a.axis === 'C2-integrity');
    expect(c2?.blockers.some((b) => b.code === 'C2_ILLEGAL_CHOICE_ACCEPTED')).toBe(false);
    expect(c2?.score).toBe(100);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// W4: classifyGame/deriveBlueprint auto-wiring into scoreAdapter, with
// explicit options still taking priority over blueprint-derived defaults.
// ---------------------------------------------------------------------------

describe('scoreAdapter — blueprint auto-wiring (W4)', () => {
  it('applies a blueprint-derived c2Playouts (heavy content -> 500) when no option is given', () => {
    // contentWeight becomes 'heavy' (>=50 declared content ids), which
    // deriveBlueprint maps to c2PlayoutCount 500 instead of the light-content
    // default of 200 — the only classification axis this fixture perturbs
    // relative to mini-trick.
    const heavyContentInventory = Array.from({ length: 60 }, (_, i) => ({
      id: `content-${i}`,
      description: `content ${i}`,
    }));
    const heavyAdapter = eraseAdapter({
      ...miniTrickAdapter,
      contentInventory: heavyContentInventory,
      exercisedContent: () => [] as string[],
    });

    const spy = jest.spyOn(heavyAdapter, 'createInitialState');

    scoreAdapter(heavyAdapter, { threshold: 0, c2Playouts: 200 });
    const explicitCallCount = spy.mock.calls.length;
    spy.mockClear();

    scoreAdapter(heavyAdapter, { threshold: 0 });
    const blueprintCallCount = spy.mock.calls.length;

    // c2Playouts drives one extra playRandomGame (one createInitialState
    // call) per unit; the blueprint-derived 500 must produce exactly 300
    // more calls than the explicit override of 200.
    expect(blueprintCallCount - explicitCallCount).toBe(300);
  }, 30_000);

  it('lets an explicitly-passed option override the blueprint-derived default', () => {
    const heavyContentInventory = Array.from({ length: 60 }, (_, i) => ({
      id: `content-${i}`,
      description: `content ${i}`,
    }));
    const heavyAdapter = eraseAdapter({
      ...miniTrickAdapter,
      contentInventory: heavyContentInventory,
      exercisedContent: () => [] as string[],
    });

    // Compare two explicit c2Playouts values (both override the blueprint's
    // derived 500) — isolates the override's effect on createInitialState
    // call volume from the other axes' unrelated, constant call counts.
    const spy = jest.spyOn(heavyAdapter, 'createInitialState');
    scoreAdapter(heavyAdapter, { threshold: 0, c2Playouts: 7 });
    const lowCallCount = spy.mock.calls.length;
    spy.mockClear();

    scoreAdapter(heavyAdapter, { threshold: 0, c2Playouts: 207 });
    const highCallCount = spy.mock.calls.length;

    expect(highCallCount - lowCallCount).toBe(200);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// O3: C2's applyChoice transition-purity check (OpenSpiel api_test
// absorption) must catch an adapter that mutates its input state in place.
// ---------------------------------------------------------------------------

describe('scoreAdapter — C2 applyChoice purity check (O3)', () => {
  interface MutatingState {
    readonly steps: number[]; // deliberately mutable — the adapter under test pushes into it
  }

  const mutatingAdapter = eraseAdapter({
    spec: {
      gameId: 'o3-mutating-adapter',
      playerCount: 2,
      decisionPoints: [{ id: 'step', description: 'increments a shared step counter; ends after 3' }],
      seatingPlan: [[0, 1], [1, 0]] as const,
      maxDecisionsPerGame: 5,
    },
    createInitialState: (_seed: number): MutatingState => ({ steps: [] }),
    currentDecision: (state: MutatingState) =>
      state.steps.length >= 3 ? null : { player: (state.steps.length % 2) as 0 | 1, decisionPoint: 'step' },
    getObservation: (_state: MutatingState, _player: 0 | 1) => ({}),
    getLegalChoices: (_state: MutatingState) => ['go'] as const,
    applyChoice: (state: MutatingState, _choice: 'go'): MutatingState => {
      // Deliberately mutates the input state in place instead of copying —
      // this is the bug O3's purity check must catch.
      state.steps.push(state.steps.length);
      return state;
    },
    getOutcome: (state: MutatingState) =>
      state.steps.length >= 3 ? { scores: [1, 0], winners: [0 as const] } : null,
    encodeChoice: (choice: 'go') => choice,
    baselines: {
      random: () => ({ id: 'o3-bot', decide: (_dp: string, _obs: unknown, legal: readonly string[]) => legal[0] as 'go' }),
      heuristic: () => ({ id: 'o3-bot', decide: (_dp: string, _obs: unknown, legal: readonly string[]) => legal[0] as 'go' }),
    },
    strategySurface: [],
  });

  it('blocks C2 with C2_APPLYCHOICE_MUTATED_INPUT when applyChoice mutates its input state', () => {
    const report = scoreAdapter(mutatingAdapter, { threshold: 0 });
    const c2 = report.axes.find((a) => a.axis === 'C2-integrity');
    expect(c2?.blockers.some((b) => b.code === 'C2_APPLYCHOICE_MUTATED_INPUT')).toBe(true);
    expect(c2?.score).toBe(0);
  }, 20_000);

  it('does not regress mini-trick (a pure adapter): no C2_APPLYCHOICE_MUTATED_INPUT blocker', () => {
    const report = scoreAdapter(adapter, { threshold: 65 });
    const c2 = report.axes.find((a) => a.axis === 'C2-integrity');
    expect(c2?.blockers.some((b) => b.code === 'C2_APPLYCHOICE_MUTATED_INPUT')).toBe(false);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Z8: scoreC5's head-to-head significance check must compare against the
// game's identityCenter (1/playerCount or 1/teamCount), not a hardcoded 0.5
// — a 2-player coincidence that distorts judgments for 3+ player FFA/team
// games (docs backlog Z8).
// ---------------------------------------------------------------------------

describe('scoreAdapter — Z8 head-to-head significance uses identityCenter, not 0.5', () => {
  // A 3-player FFA fixture whose outcome is fixed at match-creation (no bot
  // decisions at all), so the paired head-to-head win fraction is exactly
  // 0.5 on every seed, deterministically: seatingPlan has 2 permutations,
  // and the game-truth winner is always player 0, so the candidate
  // (occupying seat 0) wins in exactly one of the two permutations.
  //
  // For a 3-player game, identityCenter = 1/3. A heuristic that wins
  // head-to-head exactly half the time is clearly, meaningfully stronger
  // than the 1/3 fair share -- it should NOT be flagged as
  // "not distinct from random". But the pre-fix code compared the bootstrap
  // CI (tightly centered on exactly 0.5) against the literal constant 0.5,
  // which never excludes 0.5 -- so it always judged this case
  // "not significantly different from 0.5" and raised a false
  // C5_HEURISTIC_NOT_DISTINCT blocker. The fix compares against
  // identityCenter (0.333...) instead, which the CI clearly excludes.
  interface FfaState {
    readonly winner: 0 | 1 | 2;
  }
  const ffaAdapter = eraseAdapter({
    spec: {
      gameId: 'z8-ffa-fixed-winner',
      playerCount: 3,
      decisionPoints: [{ id: 'noop', description: 'unused; outcome is fixed at creation' }],
      seatingPlan: [
        [0, 1, 2],
        [1, 0, 2],
      ] as const,
      maxDecisionsPerGame: 1,
    },
    createInitialState: (_seed: number): FfaState => ({ winner: 0 }),
    currentDecision: (_state: FfaState) => null,
    getObservation: (_state: FfaState, _player: number) => ({}),
    getLegalChoices: (_state: FfaState) => [] as const,
    applyChoice: (state: FfaState, _choice: never): FfaState => state,
    getOutcome: (state: FfaState) => ({
      scores: [0, 1, 2].map((p) => (p === state.winner ? 1 : 0)),
      winners: [state.winner],
    }),
    encodeChoice: (choice: never) => String(choice),
    baselines: {
      random: () => ({
        id: 'ffa-random',
        decide: (_dp: string, _obs: unknown, legal: readonly never[]) => legal[0],
      }),
      heuristic: () => ({
        id: 'ffa-heuristic',
        decide: (_dp: string, _obs: unknown, legal: readonly never[]) => legal[0],
      }),
    },
    strategySurface: [],
  });

  it('does not flag C5_HEURISTIC_NOT_DISTINCT for a heuristic winning exactly 50% head-to-head in a 3-player game', () => {
    const report = scoreAdapter(ffaAdapter, {
      threshold: 0,
      c5IdentitySeeds: 3,
      c5HeadToHeadSeeds: 3,
    });
    const c5 = report.axes.find((a) => a.axis === 'C5-baselines');
    expect(c5?.blockers.some((b) => b.code === 'C5_HEURISTIC_NOT_DISTINCT')).toBe(false);
    expect(c5?.notes.some((note) => note.includes('0.333'))).toBe(true);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// M1 (docs/GAP-ANALYSIS-10.md): spec.hiddenTeamStructure lets scoreC5 stop
// comparing measured self-play win rate against 1/playerCount (which has no
// relationship to hidden faction sizes in an Avalon-like game) while keeping
// the seat-bias check active.
// ---------------------------------------------------------------------------

describe('scoreAdapter — M1 hiddenTeamStructure (Avalon-like hidden factions)', () => {
  // 4-player fixture with two unequal-size hidden factions, A={0,1,2} and
  // B={3}, never declared via spec.teams (hidden by construction). No bot
  // decisions occur at all — the winning faction is fixed at
  // createInitialState — so calibrateIdentity's win/lose signal comes
  // entirely from which faction the candidate seat lands in, which
  // SEATING_PLAN rotates through every player. calibrateIdentity has no
  // notion of team ties (it isn't told spec.teams), so a 3-way tied A win
  // scores each A member 0.5 while a solo B win scores player 3 a full 1 —
  // with A winning 2/3 of seeds and B winning 1/3 (chosen so every seat's
  // win rate converges to exactly 1/3, i.e. zero seat bias), the identity
  // mean win rate converges to exactly 1/3, nowhere near the 1/playerCount
  // fallback (0.25) — the self-contradiction M1 fixes.
  interface HiddenTeamState {
    readonly winningFaction: 'A' | 'B';
  }
  type HiddenTeamPlayer = 0 | 1 | 2 | 3;
  const FACTION_A: readonly HiddenTeamPlayer[] = [0, 1, 2];
  const FACTION_B: readonly HiddenTeamPlayer[] = [3];
  const HIDDEN_TEAM_SEATING_PLAN = [
    [0, 1, 2, 3],
    [1, 2, 3, 0],
    [2, 3, 0, 1],
    [3, 0, 1, 2],
  ] as const;

  function hiddenTeamBaselines() {
    return {
      random: () => ({
        id: 'm1-random',
        decide: (_dp: string, _obs: unknown, legal: readonly never[]) => legal[0],
      }),
      heuristic: () => ({
        id: 'm1-heuristic',
        decide: (_dp: string, _obs: unknown, legal: readonly never[]) => legal[0],
      }),
    };
  }

  function makeHiddenTeamAdapter(
    gameId: string,
    winningFactionOf: (seed: number) => 'A' | 'B',
    hiddenTeamStructure?: true,
  ) {
    return eraseAdapter({
      spec: {
        gameId,
        playerCount: 4,
        decisionPoints: [{ id: 'noop', description: 'unused; outcome is fixed at creation' }],
        seatingPlan: HIDDEN_TEAM_SEATING_PLAN,
        maxDecisionsPerGame: 1,
        ...(hiddenTeamStructure === undefined ? {} : { hiddenTeamStructure }),
      },
      createInitialState: (seed: number): HiddenTeamState => ({ winningFaction: winningFactionOf(seed) }),
      currentDecision: (_state: HiddenTeamState) => null,
      getObservation: (_state: HiddenTeamState, _player: number) => ({}),
      getLegalChoices: (_state: HiddenTeamState) => [] as const,
      applyChoice: (state: HiddenTeamState, _choice: never): HiddenTeamState => state,
      getOutcome: (state: HiddenTeamState) => {
        const winners = state.winningFaction === 'A' ? FACTION_A : FACTION_B;
        return {
          scores: [0, 1, 2, 3].map((p) => (winners.includes(p as HiddenTeamPlayer) ? 1 : 0)),
          winners,
        };
      },
      encodeChoice: (choice: never) => String(choice),
      baselines: hiddenTeamBaselines(),
      strategySurface: [],
    });
  }

  it('blocks C5_IDENTITY_NOT_FAIR when hiddenTeamStructure is not declared (regression pin)', () => {
    const adapter = makeHiddenTeamAdapter('m1-fair-undeclared', (seed) => (seed % 3 === 0 ? 'B' : 'A'));
    const report = scoreAdapter(adapter, { threshold: 0, c5IdentitySeeds: 30, c5HeadToHeadSeeds: 3 });
    const c5 = report.axes.find((a) => a.axis === 'C5-baselines');
    expect(c5?.blockers.some((b) => b.code === 'C5_IDENTITY_NOT_FAIR')).toBe(true);
  }, 20_000);

  it('does not block C5_IDENTITY_NOT_FAIR when hiddenTeamStructure is true, despite meanWinRate far from 1/playerCount', () => {
    const adapter = makeHiddenTeamAdapter(
      'm1-fair-declared',
      (seed) => (seed % 3 === 0 ? 'B' : 'A'),
      true,
    );
    const report = scoreAdapter(adapter, { threshold: 0, c5IdentitySeeds: 30, c5HeadToHeadSeeds: 3 });
    const c5 = report.axes.find((a) => a.axis === 'C5-baselines');
    expect(c5?.blockers.some((b) => b.code === 'C5_IDENTITY_NOT_FAIR')).toBe(false);
    expect(c5?.notes.some((note) => note.includes('hiddenTeamStructure'))).toBe(true);
  }, 20_000);

  it('still raises the seat-bias note under hiddenTeamStructure when one faction wins every time', () => {
    // Faction A wins every seed instead of 2/3 of them — players 0/1/2
    // (faction A) end up with a much higher win rate than player 3 (faction
    // B), which is exactly the seat-bias signal C5 must keep catching even
    // when the identity-fairness comparison itself is neutralized by
    // hiddenTeamStructure.
    const adapter = makeHiddenTeamAdapter('m1-biased-declared', () => 'A', true);
    const report = scoreAdapter(adapter, { threshold: 0, c5IdentitySeeds: 20, c5HeadToHeadSeeds: 3 });
    const c5 = report.axes.find((a) => a.axis === 'C5-baselines');
    expect(c5?.blockers.some((b) => b.code === 'C5_IDENTITY_NOT_FAIR')).toBe(false);
    expect(
      c5?.notes.some((note) => note.includes('seat bias') && note.includes('exceeds 0.3')),
    ).toBe(true);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// M2 (docs/GAP-ANALYSIS-10.md): spec.cooperativeStructure lets scoreC5 stop
// comparing measured self-play win rate against 1/playerCount (which has no
// relationship to a rule-driven difficulty curve in a Pandemic-like game,
// where every player is on one team playing against the game itself) while
// keeping the seat-bias check active.
// ---------------------------------------------------------------------------

describe('scoreAdapter — M2 cooperativeStructure (Pandemic-like single-team-vs-game)', () => {
  // 4-player fixture where the single team (all 4 players) wins together with
  // a low, rule-driven probability (20%), never a coin flip. Outcome.winners
  // is either every player (win) or empty (loss) — no bot decisions occur;
  // the outcome is fixed at createInitialState, matching the "difficulty
  // curve decides, not player choice" character of the identity axis here.
  // calibrateIdentity has no notion of "everyone shares one fate" (it just
  // checks winners.includes(candidatePlayer)), so a win credits every seat
  // 0.5 (winners.length > 1) and a loss credits 0 — with a 20% win rate that
  // converges the identity mean win rate to exactly 0.1, nowhere near the
  // 1/playerCount fallback (0.25) — the self-contradiction M2 fixes, and
  // structurally identical to why 1/1 = 1.0 would be equally wrong had
  // `teams` been (incorrectly) declared as a single all-players team.
  interface CoopState {
    readonly won: boolean;
  }
  const COOP_SEATING_PLAN = [
    [0, 1, 2, 3],
    [1, 2, 3, 0],
    [2, 3, 0, 1],
    [3, 0, 1, 2],
  ] as const;
  const ALL_PLAYERS = [0, 1, 2, 3] as const;

  function coopBaselines() {
    return {
      random: () => ({
        id: 'm2-random',
        decide: (_dp: string, _obs: unknown, legal: readonly never[]) => legal[0],
      }),
      heuristic: () => ({
        id: 'm2-heuristic',
        decide: (_dp: string, _obs: unknown, legal: readonly never[]) => legal[0],
      }),
    };
  }

  function makeCoopAdapter(
    gameId: string,
    wonOf: (seed: number) => boolean,
    cooperativeStructure?: true,
  ) {
    return eraseAdapter({
      spec: {
        gameId,
        playerCount: 4,
        decisionPoints: [{ id: 'noop', description: 'unused; outcome is fixed at creation' }],
        seatingPlan: COOP_SEATING_PLAN,
        maxDecisionsPerGame: 1,
        ...(cooperativeStructure === undefined ? {} : { cooperativeStructure }),
      },
      createInitialState: (seed: number): CoopState => ({ won: wonOf(seed) }),
      currentDecision: (_state: CoopState) => null,
      getObservation: (_state: CoopState, _player: number) => ({}),
      getLegalChoices: (_state: CoopState) => [] as const,
      applyChoice: (state: CoopState, _choice: never): CoopState => state,
      getOutcome: (state: CoopState) => ({
        scores: [0, 1, 2, 3].map((_p) => (state.won ? 1 : 0)),
        winners: state.won ? ALL_PLAYERS : [],
      }),
      encodeChoice: (choice: never) => String(choice),
      baselines: coopBaselines(),
      strategySurface: [],
    });
  }

  it('blocks C5_IDENTITY_NOT_FAIR when cooperativeStructure is not declared (regression pin)', () => {
    const adapter = makeCoopAdapter('m2-fair-undeclared', (seed) => seed % 5 === 0);
    const report = scoreAdapter(adapter, { threshold: 0, c5IdentitySeeds: 30, c5HeadToHeadSeeds: 3 });
    const c5 = report.axes.find((a) => a.axis === 'C5-baselines');
    expect(c5?.blockers.some((b) => b.code === 'C5_IDENTITY_NOT_FAIR')).toBe(true);
  }, 20_000);

  it('does not block C5_IDENTITY_NOT_FAIR when cooperativeStructure is true, despite a low measured win rate', () => {
    const adapter = makeCoopAdapter('m2-fair-declared', (seed) => seed % 5 === 0, true);
    const report = scoreAdapter(adapter, { threshold: 0, c5IdentitySeeds: 30, c5HeadToHeadSeeds: 3 });
    const c5 = report.axes.find((a) => a.axis === 'C5-baselines');
    expect(c5?.blockers.some((b) => b.code === 'C5_IDENTITY_NOT_FAIR')).toBe(false);
    expect(c5?.notes.some((note) => note.includes('cooperativeStructure'))).toBe(true);
  }, 20_000);

  it('still raises the seat-bias note under cooperativeStructure when a scoring bug ties win-credit to fixed player ids', () => {
    // Not a realistic coop outcome (a real coop game's winners are always
    // all-or-nothing) — deliberately mirrors M1's fixed-subset trick just to
    // prove C5's seat-bias defense (DESIGN.md §1) is a separate code path
    // from the identity-fairness exemption and stays active regardless.
    const BUGGY_WINNERS = [0, 1, 2] as const;
    const adapter = eraseAdapter({
      spec: {
        gameId: 'm2-biased-declared',
        playerCount: 4,
        decisionPoints: [{ id: 'noop', description: 'unused; outcome is fixed at creation' }],
        seatingPlan: COOP_SEATING_PLAN,
        maxDecisionsPerGame: 1,
        cooperativeStructure: true as const,
      },
      createInitialState: (_seed: number) => ({}),
      currentDecision: (_state: object) => null,
      getObservation: (_state: object, _player: number) => ({}),
      getLegalChoices: (_state: object) => [] as const,
      applyChoice: (state: object, _choice: never): object => state,
      getOutcome: (_state: object) => ({
        scores: [0, 1, 2, 3].map((p) => (BUGGY_WINNERS.includes(p as 0 | 1 | 2) ? 1 : 0)),
        winners: BUGGY_WINNERS,
      }),
      encodeChoice: (choice: never) => String(choice),
      baselines: coopBaselines(),
      strategySurface: [],
    });
    const report = scoreAdapter(adapter, { threshold: 0, c5IdentitySeeds: 20, c5HeadToHeadSeeds: 3 });
    const c5 = report.axes.find((a) => a.axis === 'C5-baselines');
    expect(c5?.blockers.some((b) => b.code === 'C5_IDENTITY_NOT_FAIR')).toBe(false);
    expect(
      c5?.notes.some((note) => note.includes('seat bias') && note.includes('exceeds 0.3')),
    ).toBe(true);
  }, 20_000);
});
