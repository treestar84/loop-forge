/**
 * G-Score conformance battery (DESIGN.md §4): axes C0-contract .. C7-parity.
 * Each axis is scored 0-100 with blockers (fatal) and notes (informational).
 * `buildReport` (report.ts) takes the minimum axis score as the overall
 * score — a single weak axis makes the whole loop meaningless, so this
 * module never averages across axes itself.
 */

import type {
  AnyBotFactory,
  AnyGameAdapter,
  PlayerId,
  SeatingPermutation,
} from '../contract/types';
import { createRng } from '../kernel/rng';
import { canonicalJson } from '../kernel/digest';
import { calibrateIdentity } from '../loop/calibrate';
import { runMatch, type MatchResult } from '../loop/match';
import { runPairedBlock } from '../loop/paired-match';
import { bootstrapPairedSeedBlocks, type PairedSeedOutcome } from '../kernel/paired-stats';
import { buildReport, type AxisBlocker, type AxisResult, type ConformanceReport } from './report';

export interface ScoreOptions {
  readonly threshold?: number;
  readonly seedBase?: number;
  readonly c1SeedCount?: number;
  readonly c2Playouts?: number;
  readonly c3SampleStates?: number;
  readonly c4SampleGames?: number;
  readonly c4MinGamesPerSecond?: number;
  readonly c4TargetGamesPerSecond?: number;
  readonly c5IdentitySeeds?: number;
  readonly c5HeadToHeadSeeds?: number;
  readonly c6ProbeSeeds?: number;
}

const DEFAULTS: Required<ScoreOptions> = {
  threshold: 70,
  seedBase: 10_000,
  c1SeedCount: 5,
  c2Playouts: 200,
  c3SampleStates: 5,
  c4SampleGames: 60,
  c4MinGamesPerSecond: 20,
  c4TargetGamesPerSecond: 200,
  c5IdentitySeeds: 200,
  c5HeadToHeadSeeds: 300,
  c6ProbeSeeds: 5,
};

function axis(
  id: AxisResult['axis'],
  score: number,
  blockers: readonly AxisBlocker[],
  notes: readonly string[],
): AxisResult {
  return { axis: id, score, blockers, notes };
}

function firstSeating(adapter: AnyGameAdapter): SeatingPermutation {
  const seating = adapter.spec.seatingPlan[0];
  if (!seating) {
    throw new Error('scoreAdapter: adapter.spec.seatingPlan is empty');
  }
  return seating;
}

function buildRandomBotFactories(adapter: AnyGameAdapter): AnyBotFactory[] {
  return Array.from({ length: adapter.spec.playerCount }, () => adapter.baselines.random);
}

function playRandomGame(adapter: AnyGameAdapter, gameSeed: number, botSeedBase: number): MatchResult {
  const botFactories = buildRandomBotFactories(adapter);
  const botSeeds = botFactories.map((_, index) => botSeedBase + index);
  return runMatch(adapter, botFactories, gameSeed, botSeeds, firstSeating(adapter));
}

// ---------------------------------------------------------------------------
// C0 — contract validity
// ---------------------------------------------------------------------------

function scoreC0(adapter: AnyGameAdapter): AxisResult {
  const blockers: AxisBlocker[] = [];
  const notes: string[] = [];
  const spec = adapter.spec;

  if (!Number.isInteger(spec.playerCount) || spec.playerCount < 1) {
    blockers.push({
      code: 'C0_PLAYER_COUNT',
      message: `spec.playerCount must be a positive integer, got ${spec.playerCount}`,
      remediation: 'Set spec.playerCount to the number of seats in the game.',
    });
  }
  if (spec.decisionPoints.length === 0) {
    blockers.push({
      code: 'C0_NO_DECISION_POINTS',
      message: 'spec.decisionPoints is empty',
      remediation: 'Declare at least one DecisionPointSpec for the game.',
    });
  }
  if (spec.seatingPlan.length < 2) {
    blockers.push({
      code: 'C0_SEATING_PLAN_TOO_SHORT',
      message: `spec.seatingPlan has ${spec.seatingPlan.length} permutation(s), need at least 2`,
      remediation: 'Add seat permutations so position bias can cancel in paired statistics.',
    });
  } else {
    const wrongLength = spec.seatingPlan.some(
      (permutation) => permutation.length !== spec.playerCount,
    );
    if (wrongLength) {
      blockers.push({
        code: 'C0_SEATING_PLAN_LENGTH',
        message: 'a seatingPlan permutation does not have length spec.playerCount',
        remediation: 'Every seatingPlan permutation must assign a seat to every bot slot.',
      });
    }
    const seatsCoveredForCandidate = new Set(
      spec.seatingPlan.map((permutation) => permutation[0]),
    );
    if (seatsCoveredForCandidate.size !== spec.playerCount) {
      blockers.push({
        code: 'C0_SEATING_PLAN_COVERAGE',
        message: 'seatingPlan permutations do not cover every seat for the candidate (index 0)',
        remediation: 'Include a permutation with seating[0] equal to each PlayerId.',
      });
    }
  }
  if (!Number.isInteger(spec.maxDecisionsPerGame) || spec.maxDecisionsPerGame <= 0) {
    blockers.push({
      code: 'C0_MAX_DECISIONS',
      message: `spec.maxDecisionsPerGame must be a positive integer, got ${spec.maxDecisionsPerGame}`,
      remediation: 'Set a finite hard cap on decisions per game.',
    });
  }
  if (typeof adapter.baselines?.random !== 'function' || typeof adapter.baselines?.heuristic !== 'function') {
    blockers.push({
      code: 'C0_BASELINES_MISSING',
      message: 'adapter.baselines.random/heuristic must both be BotFactory functions',
      remediation: 'Implement both a random and a heuristic baseline bot factory.',
    });
  }
  if (!Array.isArray(adapter.strategySurface)) {
    blockers.push({
      code: 'C0_STRATEGY_SURFACE_MISSING',
      message: 'adapter.strategySurface must be an array (may be empty)',
      remediation: 'Declare strategySurface: [] at minimum, or add StrategyFlagSpec entries.',
    });
  }

  if (blockers.length === 0) {
    notes.push('contract shape valid: decision points, seating plan, baselines, strategy surface present.');
  }

  return axis('C0-contract', blockers.length === 0 ? 100 : 0, blockers, notes);
}

// ---------------------------------------------------------------------------
// C1 — determinism
// ---------------------------------------------------------------------------

function scoreC1(adapter: AnyGameAdapter, options: Required<ScoreOptions>): AxisResult {
  const blockers: AxisBlocker[] = [];
  const notes: string[] = [];

  for (let i = 0; i < options.c1SeedCount; i += 1) {
    const gameSeed = options.seedBase + i;
    const botSeedBase = options.seedBase + 1000 + i;
    const first = playRandomGame(adapter, gameSeed, botSeedBase);
    const second = playRandomGame(adapter, gameSeed, botSeedBase);

    if (first.kind === 'defect' || second.kind === 'defect') {
      // Defects are C2's concern; C1 only judges reproducibility. Skip this
      // seed's determinism comparison but do not double-penalize here.
      continue;
    }
    const sameTrajectory =
      first.choiceKeys.length === second.choiceKeys.length &&
      first.choiceKeys.every((key, index) => key === second.choiceKeys[index]);
    const sameOutcome = canonicalJson(first.outcome) === canonicalJson(second.outcome);
    if (!sameTrajectory || !sameOutcome) {
      blockers.push({
        code: 'C1_NONDETERMINISTIC',
        message: `seed ${gameSeed} produced different trajectories/outcomes on repeated runs`,
        remediation:
          'Ensure createInitialState/applyChoice/bots never use Date.now(), Math.random(), or external I/O.',
      });
    }
  }

  if (blockers.length === 0) {
    notes.push(`${options.c1SeedCount} seed(s) replayed identically twice.`);
  }

  return axis('C1-determinism', blockers.length === 0 ? 100 : 0, blockers, notes);
}

// ---------------------------------------------------------------------------
// C2 — rule integrity
// ---------------------------------------------------------------------------

function scoreC2(adapter: AnyGameAdapter, options: Required<ScoreOptions>): AxisResult {
  const blockers: AxisBlocker[] = [];
  const notes: string[] = [];
  let defectCount = 0;
  let illegalChoiceRejectionChecked = false;

  const legalChoicePools: unknown[][] = [];

  for (let i = 0; i < options.c2Playouts; i += 1) {
    const gameSeed = options.seedBase + 2000 + i;
    const botSeedBase = options.seedBase + 3000 + i;
    const result = playRandomGame(adapter, gameSeed, botSeedBase);
    if (result.kind === 'defect') {
      defectCount += 1;
      continue;
    }
    // Collect a few legal-choice pools (from replaying) for the illegal-choice
    // spot-check below.
    if (legalChoicePools.length < 5) {
      let state = adapter.createInitialState(gameSeed);
      for (let step = 0; step < 3; step += 1) {
        const decision = adapter.currentDecision(state);
        if (!decision) break;
        const legal = adapter.getLegalChoices(state);
        legalChoicePools.push(legal.slice());
        state = adapter.applyChoice(state, legal[0]);
      }
    }
  }

  if (defectCount > 0) {
    blockers.push({
      code: 'C2_DEFECTS',
      message: `${defectCount}/${options.c2Playouts} random playouts produced an adapter/bot defect`,
      remediation:
        'Fix illegal-choice/empty-legal/invariant/max-decisions defects surfaced by loop/match.ts.',
    });
  }

  // Illegal-choice rejection spot-check: find a choice, from one legal pool,
  // whose encoded key is absent from another pool's legal set, and confirm
  // applyChoice throws when offered against that other pool's state.
  outer: for (let poolIndex = 0; poolIndex < legalChoicePools.length; poolIndex += 1) {
    const donorPool = legalChoicePools[poolIndex];
    if (!donorPool) continue;
    for (let otherIndex = 0; otherIndex < legalChoicePools.length; otherIndex += 1) {
      if (otherIndex === poolIndex) continue;
      const targetPool = legalChoicePools[otherIndex];
      if (!targetPool) continue;
      const targetKeys = new Set(targetPool.map((choice) => adapter.encodeChoice(choice)));
      const foreignChoice = donorPool.find(
        (choice) => !targetKeys.has(adapter.encodeChoice(choice)),
      );
      if (foreignChoice === undefined) continue;

      // Replay a fresh state matching targetPool's seed to attempt the foreign choice.
      const targetGameSeed = options.seedBase + 2000 + otherIndex;
      let targetState = adapter.createInitialState(targetGameSeed);
      let matchedDepth = -1;
      for (let step = 0; step <= otherIndex && step < 3; step += 1) {
        const decision = adapter.currentDecision(targetState);
        if (!decision) break;
        matchedDepth = step;
        if (step === otherIndex % 3) break;
        const legal = adapter.getLegalChoices(targetState);
        targetState = adapter.applyChoice(targetState, legal[0]);
      }
      if (matchedDepth === -1) continue;

      let threw = false;
      try {
        adapter.applyChoice(targetState, foreignChoice);
      } catch {
        threw = true;
      }
      illegalChoiceRejectionChecked = true;
      if (!threw) {
        blockers.push({
          code: 'C2_ILLEGAL_CHOICE_ACCEPTED',
          message: 'applyChoice accepted a choice not present in getLegalChoices for that state',
          remediation: 'applyChoice must throw on any choice not returned by getLegalChoices(state).',
        });
      }
      break outer;
    }
  }

  if (!illegalChoiceRejectionChecked) {
    notes.push(
      'could not synthesize a cross-state illegal choice to spot-check applyChoice rejection; no penalty applied.',
    );
  } else if (blockers.every((b) => b.code !== 'C2_ILLEGAL_CHOICE_ACCEPTED')) {
    notes.push('illegal-choice rejection spot-check passed.');
  }

  if (defectCount === 0) {
    notes.push(`${options.c2Playouts} random playouts completed with zero defects.`);
  }

  return axis('C2-integrity', blockers.length === 0 ? 100 : 0, blockers, notes);
}

// ---------------------------------------------------------------------------
// C3 — hidden information
// ---------------------------------------------------------------------------

function scoreC3(adapter: AnyGameAdapter, options: Required<ScoreOptions>): AxisResult {
  const notes: string[] = [];

  if (!adapter.hiddenInfoProbe) {
    return axis('C3-hidden-info', 0, [
      {
        code: 'C3_NO_PROBE',
        message: 'adapter.hiddenInfoProbe is not implemented',
        remediation:
          'Implement HiddenInfoProbe.mutateHidden so observation invariance to hidden-info mutation can be verified.',
      },
    ], notes);
  }

  const probe = adapter.hiddenInfoProbe;
  const blockers: AxisBlocker[] = [];
  let anyMutationApplied = false;

  for (let i = 0; i < options.c3SampleStates; i += 1) {
    const gameSeed = options.seedBase + 4000 + i;
    let state = adapter.createInitialState(gameSeed);
    // Walk a few random steps so states are not always the initial deal.
    for (let step = 0; step < i; step += 1) {
      const decision = adapter.currentDecision(state);
      if (!decision) break;
      const legal = adapter.getLegalChoices(state);
      state = adapter.applyChoice(state, legal[0]);
    }
    const decision = adapter.currentDecision(state);
    const viewer: PlayerId = decision ? decision.player : 0;

    const before = adapter.getObservation(state, viewer);
    const rng = createRng(options.seedBase + 5000 + i);
    const mutated = probe.mutateHidden(state, viewer, rng);
    if (mutated === null) {
      continue;
    }
    anyMutationApplied = true;
    const after = adapter.getObservation(mutated, viewer);
    if (canonicalJson(before) !== canonicalJson(after)) {
      blockers.push({
        code: 'C3_OBSERVATION_LEAK',
        message: `mutating hidden information changed viewer ${viewer}'s observation at seed ${gameSeed}`,
        remediation: 'getObservation must depend only on information the viewer is allowed to see.',
      });
    }
  }

  if (!anyMutationApplied) {
    blockers.push({
      code: 'C3_PROBE_NEVER_MUTATED',
      message: 'hiddenInfoProbe.mutateHidden returned null for every sampled state',
      remediation: 'mutateHidden should return a mutated state whenever hidden information exists for the viewer.',
    });
  } else {
    notes.push('hiddenInfoProbe mutated hidden information without changing the viewer observation.');
  }

  return axis('C3-hidden-info', blockers.length === 0 ? 100 : 0, blockers, notes);
}

// ---------------------------------------------------------------------------
// C4 — throughput
// ---------------------------------------------------------------------------

function scoreC4(adapter: AnyGameAdapter, options: Required<ScoreOptions>): AxisResult {
  const notes: string[] = [];
  const blockers: AxisBlocker[] = [];

  const start = process.hrtime.bigint();
  let completed = 0;
  for (let i = 0; i < options.c4SampleGames; i += 1) {
    const gameSeed = options.seedBase + 6000 + i;
    const botSeedBase = options.seedBase + 7000 + i;
    const result = playRandomGame(adapter, gameSeed, botSeedBase);
    if (result.kind === 'completed') {
      completed += 1;
    }
  }
  const elapsedNanos = process.hrtime.bigint() - start;
  const elapsedSeconds = Number(elapsedNanos) / 1_000_000_000;
  const gamesPerSecond = elapsedSeconds > 0 ? completed / elapsedSeconds : Infinity;

  notes.push(`measured ${gamesPerSecond.toFixed(1)} games/sec over ${options.c4SampleGames} sampled games.`);

  if (gamesPerSecond < options.c4MinGamesPerSecond) {
    blockers.push({
      code: 'C4_THROUGHPUT_TOO_LOW',
      message: `throughput ${gamesPerSecond.toFixed(1)} games/sec is below the hard floor of ${options.c4MinGamesPerSecond}`,
      remediation: 'Profile and optimize createInitialState/applyChoice/getLegalChoices for the hot loop.',
    });
    return axis('C4-throughput', 0, blockers, notes);
  }

  const ratio = Math.min(1, gamesPerSecond / options.c4TargetGamesPerSecond);
  const score = Math.round(ratio * 100);
  return axis('C4-throughput', score, blockers, notes);
}

// ---------------------------------------------------------------------------
// C5 — baseline ecosystem
// ---------------------------------------------------------------------------

function scoreC5(adapter: AnyGameAdapter, options: Required<ScoreOptions>): AxisResult {
  const blockers: AxisBlocker[] = [];
  const notes: string[] = [];

  const identitySeeds = Array.from({ length: options.c5IdentitySeeds }, (_, i) => options.seedBase + 8000 + i);
  const identity = calibrateIdentity(adapter, adapter.baselines.random, identitySeeds, options.seedBase + 9000);

  notes.push(
    `identity calibration: meanWinRate=${identity.meanWinRate.toFixed(3)}, ` +
      `seatWinRates=[${identity.seatWinRates.map((r) => r.toFixed(3)).join(', ')}], bias=${identity.bias.toFixed(3)}`,
  );

  if (Math.abs(identity.meanWinRate - 0.5) > 0.05) {
    blockers.push({
      code: 'C5_IDENTITY_NOT_FAIR',
      message: `random self-play mean win rate ${identity.meanWinRate.toFixed(3)} is not within 0.5+/-0.05`,
      remediation: 'Check seatingPlan coverage and outcome/scoring symmetry for a fair game.',
    });
  }
  if (identity.bias > 0.3) {
    notes.push(
      `seat bias ${identity.bias.toFixed(3)} exceeds 0.3 — investigate first-move/seat advantage before trusting paired stats.`,
    );
  }

  const headToHeadSeeds = Array.from(
    { length: options.c5HeadToHeadSeeds },
    (_, i) => options.seedBase + 10_000 + i,
  );
  const outcomes: PairedSeedOutcome[] = [];
  for (const seed of headToHeadSeeds) {
    const result = runPairedBlock(adapter, adapter.baselines.heuristic, adapter.baselines.random, seed, seed);
    if ('defect' in result) {
      blockers.push({
        code: 'C5_HEAD_TO_HEAD_DEFECT',
        message: `heuristic-vs-random paired block hit a defect at seed ${seed}: ${result.defect.message}`,
        remediation: 'Fix the underlying adapter/bot defect before baselines can be trusted.',
      });
      break;
    }
    outcomes.push(result);
  }

  if (outcomes.length > 0) {
    const bootstrap = bootstrapPairedSeedBlocks(outcomes, {
      iterations: 2000,
      confidenceLevel: 0.95,
      seed: options.seedBase + 11_000,
    });
    const significantlyDifferent = bootstrap.winRate.lower > 0.5 || bootstrap.winRate.upper < 0.5;
    notes.push(
      `heuristic vs random: pointWinRate=${bootstrap.pointWinRate.toFixed(3)}, ` +
        `CI=[${bootstrap.winRate.lower.toFixed(3)}, ${bootstrap.winRate.upper.toFixed(3)}]` +
        (significantlyDifferent ? '' : ' (not significantly different from 0.5)'),
    );
    if (!significantlyDifferent) {
      blockers.push({
        code: 'C5_HEURISTIC_NOT_DISTINCT',
        message: 'heuristic baseline win rate against random is not significantly different from 0.5',
        remediation: 'The heuristic baseline should play distinctly from random (stronger or weaker, but not equivalent).',
      });
    } else if (bootstrap.pointWinRate < 0.5) {
      notes.push('heuristic is significantly weaker than random for this game — direction noted, not penalized.');
    }
  }

  return axis('C5-baselines', blockers.length === 0 ? 100 : 0, blockers, notes);
}

// ---------------------------------------------------------------------------
// C6 — strategy surface
// ---------------------------------------------------------------------------

function scoreC6(adapter: AnyGameAdapter, options: Required<ScoreOptions>): AxisResult {
  const notes: string[] = [];

  if (adapter.strategySurface.length === 0) {
    return axis('C6-strategy-surface', 0, [
      {
        code: 'C6_EMPTY_STRATEGY_SURFACE',
        message: 'adapter.strategySurface is empty',
        remediation: 'Add at least one StrategyFlagSpec candidate-injection point.',
      },
    ], notes);
  }

  const probeSeeds = Array.from({ length: options.c6ProbeSeeds }, (_, i) => options.seedBase + 12_000 + i);
  const baseFactory = adapter.baselines.heuristic;
  const playerCount = adapter.spec.playerCount;
  const seating = firstSeating(adapter);

  let distinctCount = 0;
  const flagNotes: string[] = [];

  for (const flagSpec of adapter.strategySurface) {
    const variantFactory = flagSpec.apply(baseFactory);
    let distinct = false;
    for (const seed of probeSeeds) {
      const variantFactories: AnyBotFactory[] = [variantFactory];
      const baseFactories: AnyBotFactory[] = [baseFactory];
      for (let i = 1; i < playerCount; i += 1) {
        variantFactories.push(baseFactory);
        baseFactories.push(baseFactory);
      }
      const botSeeds = variantFactories.map((_, index) => seed + index);
      const variantResult = runMatch(adapter, variantFactories, seed, botSeeds, seating);
      const baseResult = runMatch(adapter, baseFactories, seed, botSeeds, seating);
      if (variantResult.kind === 'defect' || baseResult.kind === 'defect') {
        continue;
      }
      const same =
        variantResult.choiceKeys.length === baseResult.choiceKeys.length &&
        variantResult.choiceKeys.every((key, index) => key === baseResult.choiceKeys[index]);
      if (!same) {
        distinct = true;
        break;
      }
    }
    if (distinct) {
      distinctCount += 1;
    } else {
      flagNotes.push(`"${flagSpec.flag}" produced no observable behavior change across probe seeds (no-op).`);
    }
  }

  const fraction = distinctCount / adapter.strategySurface.length;
  notes.push(
    `${distinctCount}/${adapter.strategySurface.length} strategySurface flag(s) are behaviorally distinct.`,
  );
  notes.push(...flagNotes);

  const blockers: AxisBlocker[] =
    distinctCount === 0
      ? [
          {
            code: 'C6_ALL_NOOP',
            message: 'every strategySurface flag is a behavioral no-op on the probe seeds',
            remediation: 'Fix strategy flags so their apply() wrapper changes at least one decision.',
          },
        ]
      : [];

  return axis('C6-strategy-surface', Math.round(fraction * 100), blockers, notes);
}

// ---------------------------------------------------------------------------
// C7 — parity
// ---------------------------------------------------------------------------

function scoreC7(adapter: AnyGameAdapter): AxisResult {
  const notes: string[] = [];

  if (!adapter.replayFixtures || adapter.replayFixtures.length === 0) {
    return axis('C7-parity', 0, [
      {
        code: 'C7_NO_FIXTURES',
        message: 'adapter.replayFixtures is missing or empty',
        remediation: 'Capture real-game replay fixtures (choiceKeys + finalScores) to prove parity.',
      },
    ], notes);
  }

  const blockers: AxisBlocker[] = [];
  let passed = 0;

  for (const fixture of adapter.replayFixtures) {
    let state = adapter.createInitialState(fixture.seed);
    let ok = true;
    for (const choiceKey of fixture.choiceKeys) {
      const decision = adapter.currentDecision(state);
      if (!decision) {
        ok = false;
        break;
      }
      const legal = adapter.getLegalChoices(state);
      const matching = legal.find((choice) => adapter.encodeChoice(choice) === choiceKey);
      if (matching === undefined) {
        ok = false;
        break;
      }
      try {
        state = adapter.applyChoice(state, matching);
      } catch {
        ok = false;
        break;
      }
    }
    const outcome = ok ? adapter.getOutcome(state) : null;
    const scoresMatch =
      outcome !== null &&
      outcome.scores.length === fixture.finalScores.length &&
      outcome.scores.every((score, index) => score === fixture.finalScores[index]);

    if (ok && scoresMatch) {
      passed += 1;
    } else {
      blockers.push({
        code: 'C7_FIXTURE_MISMATCH',
        message: `replay fixture "${fixture.id}" did not replay to its recorded finalScores`,
        remediation: 'Verify the fixture was captured from this adapter version and choiceKeys/encodeChoice agree.',
      });
    }
  }

  notes.push(`${passed}/${adapter.replayFixtures.length} replay fixture(s) replayed to their recorded outcome.`);

  const score = Math.round((passed / adapter.replayFixtures.length) * 100);
  return axis('C7-parity', score, blockers, notes);
}

// ---------------------------------------------------------------------------

export function scoreAdapter(
  adapter: AnyGameAdapter,
  options: ScoreOptions = {},
): ConformanceReport {
  const resolved: Required<ScoreOptions> = { ...DEFAULTS, ...options };

  const axes: AxisResult[] = [
    scoreC0(adapter),
    scoreC1(adapter, resolved),
    scoreC2(adapter, resolved),
    scoreC3(adapter, resolved),
    scoreC4(adapter, resolved),
    scoreC5(adapter, resolved),
    scoreC6(adapter, resolved),
    scoreC7(adapter),
  ];

  return buildReport(adapter.spec.gameId, axes, resolved.threshold);
}
