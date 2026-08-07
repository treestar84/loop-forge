/**
 * Portfolio round executor (docs/GAP-ANALYSIS-12.md E1): extracts the shared
 * probe-filter -> wave -> challenge -> promotion -> reallocation pipeline
 * that every `*-portfolio-roundN.ts` runner (gomoku, dominion) reimplemented
 * from scratch each round — a diff that exceeded the file's own size
 * (GAP-ANALYSIS-12 §0.1). Every function below is a game-neutral port of the
 * logic already in `reference/runners/gomoku-portfolio-round4.ts` and
 * `reference/runners/dominion-portfolio-round3.ts` — no new algorithm.
 *
 * Required deviations from the design spec's literal interface
 * (scratchpad/e1-round-executor-design-spec.md), each forced by something the
 * spec's interface omitted:
 *   - `ProbeFilterOptions` gains `costCheckOpponent`/`costCheckBotSeedBase`:
 *     the cost-check `runHeadToHead` call needs an opponent bot and its own
 *     bot-seed base, distinct from `probeScoreSeedBase`. Both original files
 *     pass the L2 anchor bot here.
 *   - `RoundChallengeOptions` gains `botSeedBase`: `WaveChallengeConfig`
 *     needs a bot-seed base distinct from the challenge game-seed base.
 *   - `RoundWaveOptions` gains `waveId`: `runWave`'s prune/holdout/regression
 *     bootstrap re-sampling seed is `hashToInt(waveId:flag:tier)` — an
 *     auto-derived waveId would silently change winRateCI bounds (and
 *     potentially verdicts) versus the original run, which is exactly the
 *     byte-exact reproduction this extraction must not break.
 *   - `RunPortfolioRoundInput` gains `recordedAt` (ISO timestamp) and
 *     `clockNowMs` (an epoch-ms clock function): this file lives in
 *     `artifacts/`, which is bound by the determinism rule
 *     (`src/__tests__/dependency-rules.test.ts` forbids `Date.now()`/
 *     `new Date()` outside the app boundary) — the probe-filter cost check's
 *     msPerGame measurement and the wave's `recordedAt` stamp must both come
 *     from the app-boundary caller instead.
 *   - The promotion step's challengeScore anchor, and the bucket-outcome
 *     baseline win rate, both use the LAST entry of `challenge.anchors` —
 *     matches both original files (L1 listed first, L2 last, and L2 is
 *     always the one used for challengeScore/promotion judgment).
 *
 * Lives in artifacts/ (not reference/): stays under the determinism rule and
 * the artifacts -> loop/kernel dependency direction (never imports
 * reference/, which carries game knowledge) per the dependency-rules test.
 */

import { writeFileSync } from 'node:fs';

import type { AnyBotFactory, AnyGameAdapter } from '../contract/types';
import type { BlueprintCalibration } from '../kernel/blueprint';
import type { FinalVerdict, PromotionCriteria } from '../kernel/gates';
import type { SprtConfig } from '../kernel/sprt';
import { SeedLedger } from '../kernel/seed-ledger';
import {
  assembleFlags,
  composeBot,
  composeBotChecked,
  type AssembleFlagsCandidate,
  type AssembleFlagsResult,
} from '../loop/compose';
import { runHeadToHead } from '../loop/head-to-head';
import { scoreAgainstProbes, type ProbePosition, type ProbeScore } from '../loop/probe-bank';
import { assembleWaveConfig, type AssembleWaveConfigOverrides } from '../loop/assemble-wave-config';
import { runWave, type WaveChallengeEntry, type WaveReport } from '../loop/wave-runner';
import type { BaselineRegistry } from './baseline-registry';
import {
  BUCKET_ORDER,
  reallocate,
  savePortfolioState,
  type BucketAllocation,
  type BucketId,
  type BucketOutcome,
} from './portfolio';

export interface RoundCandidateSpec {
  readonly flag: string;
  readonly bucket: BucketId;
  readonly assembly?: 'decorator' | 'terminal';
}

export interface ProbeFilterOptions {
  readonly probeBanks: readonly (readonly ProbePosition[])[];
  readonly probeScoreSeedBase: number;
  readonly costCheckN: number;
  readonly costCheckSeedBase: number;
  /** Opponent for the cost-check head-to-head (both original files use the L2 anchor bot). */
  readonly costCheckOpponent: AnyBotFactory;
  readonly costCheckBotSeedBase: number;
  readonly advanceTopK: number;
  /** Informational only (logged on the output row) — never affects which
   * candidates advance. Neither original file's advance logic branches on
   * this; it exists to flag defensive/clone-family candidates whose
   * search-budget cost is a known multiple of the raw heuristic's. */
  readonly costMultiplierFlags?: ReadonlySet<string>;
}

export interface WaveTiersConfig {
  readonly smoke: { readonly sprt: SprtConfig; readonly maxBlocks: number; readonly minBlocks: number };
  readonly prune: { readonly blocks: number };
  readonly holdout: { readonly blocks: number };
  readonly regression?: { readonly blocks: number };
}

export interface RoundWaveOptions {
  /** Must match the original run's waveId byte-for-byte when reproducing a
   * past round — runWave's bootstrap re-sampling seed is derived from it. */
  readonly waveId: string;
  readonly waveSeedBase: number;
  readonly tiers: WaveTiersConfig;
  readonly regressionOpponentFlags: readonly string[];
  readonly comparabilityContext: unknown;
}

export interface RoundChallengeAnchor {
  readonly anchorId: string;
  readonly factory: AnyBotFactory;
}

export interface RoundChallengeOptions {
  /** feedback-role anchors only — holdout anchors must never be passed here
   * (GAP-11 D3); runWave's own guard throws if one slips through. */
  readonly anchors: readonly RoundChallengeAnchor[];
  readonly seedBase: number;
  readonly botSeedBase: number;
  readonly n: number;
}

export interface RoundPromotionOptions {
  readonly latestVersionFlags: readonly string[];
  readonly latestVersionAssembly: Readonly<Record<string, 'decorator' | 'terminal' | undefined>>;
  readonly excludeFromLineage?: ReadonlySet<string>;
  readonly registry: BaselineRegistry;
  readonly notesPrefix: string;
}

export interface RunPortfolioRoundInput {
  readonly gameId: string;
  readonly rootDir: string;
  readonly adapter: AnyGameAdapter;
  readonly candidates: readonly RoundCandidateSpec[];
  readonly probeFilter: ProbeFilterOptions;
  readonly wave: RoundWaveOptions;
  readonly challenge: RoundChallengeOptions;
  readonly promotion: RoundPromotionOptions;
  readonly bucketAllocation: { readonly current: readonly BucketAllocation[] };
  readonly outputPath: string;
  /** ISO timestamp for wave.recordedAt/ledger bookkeeping and the saved
   * JSON's generatedAt — supplied by the app-boundary caller (determinism rule). */
  readonly recordedAt: string;
  /** Epoch-ms clock for the probe-filter cost check's msPerGame measurement
   * — supplied by the app-boundary caller (determinism rule). Pass
   * `Date.now` from reference/runners/*.ts. */
  readonly clockNowMs: () => number;
  /**
   * Screen-tier probe seeds for `assembleWaveConfig`'s behavioral no-op
   * check (GAP-11-ROUNDS.md gomoku round 5, FIX-BACKLOG E8): 3 seeds proved
   * too few to reliably exercise a candidate's differing code path —
   * `mcts17-s256-clone-earlyprior-sched` produced byte-identical trajectories
   * to baseline on seeds [1,2,3] yet scored +8.7pp vs L2 at N=40 and held up
   * at N=200 confirmation, meaning the 3-seed sample simply never hit the
   * position where its schedule diverges. This is an exact trajectory-equality
   * check (`screenCandidate` in loop/wave-runner.ts), not a statistical test,
   * so more seeds strictly increase detection power with no false-positive
   * risk. Optional and defaults to `DEFAULT_SCREEN_PROBE_SEEDS` (8 seeds) —
   * omit to get the improved default; pass the historical `[1, 2, 3]`
   * explicitly only if reproducing a pre-E8 round byte-for-byte.
   */
  readonly screenProbeSeeds?: readonly number[];
}

/** See `RunPortfolioRoundInput.screenProbeSeeds` (FIX-BACKLOG E8). */
export const DEFAULT_SCREEN_PROBE_SEEDS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];

export interface ProbeFilterRow {
  readonly flag: string;
  readonly bucket: BucketId;
  readonly probeScore: ProbeScore;
  readonly msPerGame: number;
  readonly advanced: boolean;
  readonly costMultiplierFlagged: boolean;
}

export interface ChallengeCell {
  readonly winRate: number;
  readonly blocks: number;
  readonly winRateCI: { readonly lower: number; readonly upper: number };
}

export type ChallengeTable = Readonly<Record<string, Readonly<Record<string, ChallengeCell>>>>;

export interface RunPortfolioRoundResult {
  readonly probeFilter: readonly ProbeFilterRow[];
  readonly wave: WaveReport;
  readonly challenge: ChallengeTable;
  readonly adoption: {
    readonly promotedVersion: string | null;
    /** True when assembly retained the parent flags, so no new version was registered. */
    readonly noOp: boolean;
    readonly adoptedFlags: readonly string[];
    readonly assembleFlagsResult: AssembleFlagsResult | null;
  };
  readonly bucketOutcomes: readonly BucketOutcome[];
  /** The PromotionCriteria assembleWaveConfig derived for this wave —
   * exposed so the caller can call extractNearMissCandidates(adoptionRecord,
   * result.criteria) without recomputing classification/blueprint itself
   * (necessary addition; the design spec's result interface omitted it). */
  readonly criteria: PromotionCriteria;
  readonly nextAllocation: readonly BucketAllocation[];
}

function seedsFrom(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

/** Merge probe banks deduped by probeId — same helper shape every prior
 * round file's own `mergeProbeBanks` used, now shared. */
function mergeProbeBanks(banks: readonly (readonly ProbePosition[])[]): readonly ProbePosition[] {
  const seen = new Map<string, ProbePosition>();
  for (const bank of banks) {
    for (const probe of bank) {
      if (!seen.has(probe.probeId)) {
        seen.set(probe.probeId, probe);
      }
    }
  }
  return [...seen.values()];
}

/** Pure ranking/selection at the heart of the probe filter — ranked by
 * agreement rate desc, ties broken by cheaper msPerGame, top `advanceTopK`
 * advance. Exported standalone (no game execution) so it is directly unit
 * testable. */
export function selectAdvancingFlags(
  rows: readonly { readonly flag: string; readonly agreementRate: number; readonly msPerGame: number }[],
  advanceTopK: number,
): ReadonlySet<string> {
  const ranked = [...rows].sort((a, b) => {
    if (b.agreementRate !== a.agreementRate) {
      return b.agreementRate - a.agreementRate;
    }
    return a.msPerGame - b.msPerGame; // tie-break: cheaper wins
  });
  return new Set(ranked.slice(0, advanceTopK).map((row) => row.flag));
}

/** Step 1: score each candidate against the merged probe bank, measure
 * per-game cost via a small head-to-head, then advance only the top K by
 * agreement rate (ties broken by cheaper msPerGame). */
function runProbeFilter(
  adapter: AnyGameAdapter,
  candidates: readonly RoundCandidateSpec[],
  probes: readonly ProbePosition[],
  options: ProbeFilterOptions,
  clockNowMs: () => number,
): readonly ProbeFilterRow[] {
  const costSeeds = seedsFrom(options.costCheckSeedBase, options.costCheckN);
  const rows: Array<Omit<ProbeFilterRow, 'advanced'>> = [];

  for (const candidate of candidates) {
    const bot = composeBot(adapter, [candidate.flag]);
    const probeScore = scoreAgainstProbes(adapter, bot, probes, options.probeScoreSeedBase);

    const t0 = clockNowMs();
    const costResult = runHeadToHead(adapter, bot, options.costCheckOpponent, costSeeds, options.costCheckBotSeedBase);
    const elapsedMs = clockNowMs() - t0;
    const msPerGame = costResult.blocks > 0 ? elapsedMs / costResult.blocks : Infinity;

    rows.push({
      flag: candidate.flag,
      bucket: candidate.bucket,
      probeScore,
      msPerGame,
      costMultiplierFlagged: options.costMultiplierFlags?.has(candidate.flag) ?? false,
    });
  }

  const advancingFlags = selectAdvancingFlags(
    rows.map((row) => ({ flag: row.flag, agreementRate: row.probeScore.agreementRate, msPerGame: row.msPerGame })),
    options.advanceTopK,
  );

  return rows.map((row) => ({ ...row, advanced: advancingFlags.has(row.flag) }));
}

/** Step 2: assemble the wave (smoke/prune/holdout/regression seed banks
 * reserved at fixed 1000-seed-wide offsets from waveSeedBase — the exact
 * convention both original round files used) and run it with the challenge
 * anchors wired in. */
function runRoundWave(
  adapter: AnyGameAdapter,
  gameId: string,
  advancing: readonly ProbeFilterRow[],
  latestVersion: string,
  wave: RoundWaveOptions,
  challenge: RoundChallengeOptions,
  recordedAt: string,
  screenProbeSeeds: readonly number[],
): { readonly report: WaveReport; readonly criteria: PromotionCriteria } {
  const ledger = new SeedLedger();
  const SMOKE_START = wave.waveSeedBase;
  const PRUNE_START = wave.waveSeedBase + 1000;
  const HOLDOUT_START = wave.waveSeedBase + 2000;
  const REGRESSION_START = wave.waveSeedBase + 3000;

  ledger.reserve({
    bankId: `${gameId}-round-smoke`,
    range: { start: SMOKE_START, end: SMOKE_START + wave.tiers.smoke.maxBlocks - 1 },
    purpose: 'smoke',
    reservedAt: recordedAt,
  });
  ledger.reserve({
    bankId: `${gameId}-round-prune`,
    range: { start: PRUNE_START, end: PRUNE_START + wave.tiers.prune.blocks - 1 },
    purpose: 'prune',
    reservedAt: recordedAt,
  });
  ledger.reserve({
    bankId: `${gameId}-round-holdout`,
    range: { start: HOLDOUT_START, end: HOLDOUT_START + wave.tiers.holdout.blocks - 1 },
    purpose: 'holdout',
    reservedAt: recordedAt,
  });
  if (wave.tiers.regression !== undefined) {
    ledger.reserve({
      bankId: `${gameId}-round-regression`,
      range: { start: REGRESSION_START, end: REGRESSION_START + wave.tiers.regression.blocks - 1 },
      purpose: 'regression',
      reservedAt: recordedAt,
    });
  }

  const challengeEntries: readonly WaveChallengeEntry[] = challenge.anchors.map((anchor) => ({
    anchorId: anchor.anchorId,
    factory: anchor.factory,
    role: 'feedback' as const,
  }));

  const ctx = (wave.comparabilityContext ?? {}) as {
    readonly calibration?: BlueprintCalibration;
    readonly overrides?: AssembleWaveConfigOverrides;
  };

  const assembled = assembleWaveConfig(
    adapter,
    {
      waveId: wave.waveId,
      candidates: advancing.map((row) => ({ flag: row.flag })),
      opponent: 'heuristic',
      ledger,
      recordedAt,
      baselineFlags: wave.regressionOpponentFlags,
      baselineVersion: latestVersion,
      tiers: {
        smoke: { bankId: `${gameId}-round-smoke`, sprt: wave.tiers.smoke.sprt, maxBlocks: wave.tiers.smoke.maxBlocks, minBlocks: wave.tiers.smoke.minBlocks },
        prune: { bankId: `${gameId}-round-prune`, blocks: wave.tiers.prune.blocks },
        holdout: { bankId: `${gameId}-round-holdout`, blocks: wave.tiers.holdout.blocks },
        ...(wave.tiers.regression !== undefined
          ? { regression: { bankId: `${gameId}-round-regression`, blocks: wave.tiers.regression.blocks } }
          : {}),
      },
      screenProbe: { seeds: screenProbeSeeds, botSeedBase: 100 },
    },
    ctx.calibration,
    ctx.overrides,
  );

  const waveConfig = {
    ...assembled,
    challenge: {
      entries: challengeEntries,
      seeds: seedsFrom(challenge.seedBase, challenge.n),
      botSeedBase: challenge.botSeedBase,
    },
  };

  return { report: runWave(adapter, waveConfig), criteria: assembled.criteria };
}

function buildChallengeTable(report: WaveReport): ChallengeTable {
  const table: Record<string, Record<string, ChallengeCell>> = {};
  for (const entry of report.challengeResult ?? []) {
    table[entry.anchorId] ??= {};
    (table[entry.anchorId] as Record<string, ChallengeCell>)[entry.subject] = {
      winRate: entry.winRate,
      blocks: entry.blocks,
      winRateCI: entry.winRateCI,
    };
  }
  return table;
}

/** Pure promotion-pool assembly: surviving lineage flags first, then this
 * round's adopted flags, in order, skipping anything in `excludeFromLineage`.
 * `assemblyOf`/`challengeScoreOf` are injected lookups so this needs no
 * adapter or wave report — exported standalone (no game execution) so it is
 * directly unit testable. */
export function buildPromotionPool(input: {
  readonly latestVersionFlags: readonly string[];
  readonly adoptedFlags: readonly string[];
  readonly excludeFromLineage?: ReadonlySet<string> | undefined;
  readonly assemblyOf: (flag: string) => 'decorator' | 'terminal' | undefined;
  readonly baselineChallengeScore: number | undefined;
  readonly challengeScoreOf: (flag: string) => number | undefined;
}): readonly AssembleFlagsCandidate[] {
  const toCandidate = (flag: string, challengeScore: number | undefined): AssembleFlagsCandidate => {
    const assembly = input.assemblyOf(flag);
    return {
      flag,
      ...(assembly !== undefined ? { assembly } : {}),
      ...(challengeScore !== undefined ? { challengeScore } : {}),
    };
  };

  const pool: AssembleFlagsCandidate[] = [];
  for (const flag of input.latestVersionFlags) {
    if (input.excludeFromLineage?.has(flag)) {
      continue;
    }
    pool.push(toCandidate(flag, input.baselineChallengeScore));
  }
  for (const flag of input.adoptedFlags) {
    if (input.excludeFromLineage?.has(flag)) {
      continue;
    }
    pool.push(toCandidate(flag, input.challengeScoreOf(flag)));
  }
  return pool;
}

/** Exact, order-sensitive flag comparison. Application order changes the
 * composed bot, so permutations are promotion changes rather than no-ops. */
export function flagsUnchanged(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((flag, index) => flag === b[index]);
}

/** Final registry action after a promotion pool has been assembled. Exported
 * to keep the no-op branch directly testable without running games. */
export function finalizePromotion(input: {
  readonly registry: BaselineRegistry;
  readonly latestVersion: string;
  readonly latestVersionFlags: readonly string[];
  readonly waveId: string;
  readonly nextVersion: {
    readonly version: string;
    readonly flags: readonly string[];
    readonly parent: string;
    readonly createdAt: string;
    readonly notes: string;
  };
}): { readonly promotedVersion: string; readonly noOp: boolean } {
  if (flagsUnchanged(input.nextVersion.flags, input.latestVersionFlags)) {
    input.registry.recordNoOpWave(input.latestVersion, input.waveId);
    return { promotedVersion: input.latestVersion, noOp: true };
  }
  const registered = input.registry.register({
    ...input.nextVersion,
    sourceWaveId: input.waveId,
  });
  return { promotedVersion: registered.version, noOp: false };
}

/** Step 3: assemble the promotion candidate pool (surviving lineage flags +
 * this round's adopted flags, excluding anything in `excludeFromLineage`),
 * validate with composeBotChecked, and register the new version. */
function runPromotion(
  adapter: AnyGameAdapter,
  report: WaveReport,
  challengeTable: ChallengeTable,
  primaryAnchorId: string | undefined,
  latestVersion: string,
  promotion: RoundPromotionOptions,
  recordedAt: string,
): { promotedVersion: string | null; noOp: boolean; adoptedFlags: readonly string[]; assembleResult: AssembleFlagsResult | null } {
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  const surfaceByFlag = new Map(adapter.strategySurface.map((spec) => [spec.flag, spec]));
  const baselineChallengeScore = primaryAnchorId !== undefined ? challengeTable[primaryAnchorId]?.['baseline']?.winRate : undefined;

  if (adoptedFlags.length === 0) {
    return { promotedVersion: null, noOp: false, adoptedFlags, assembleResult: null };
  }

  const lineage = promotion.registry.lineage(latestVersion);
  const alreadyPromoted = lineage.find((version) => version.sourceWaveId === report.waveId);
  if (alreadyPromoted) {
    return { promotedVersion: alreadyPromoted.version, noOp: false, adoptedFlags, assembleResult: null };
  }

  const pool = buildPromotionPool({
    latestVersionFlags: promotion.latestVersionFlags,
    adoptedFlags,
    excludeFromLineage: promotion.excludeFromLineage,
    assemblyOf: (flag) => surfaceByFlag.get(flag)?.assembly ?? promotion.latestVersionAssembly[flag],
    baselineChallengeScore,
    challengeScoreOf: (flag) => (primaryAnchorId !== undefined ? challengeTable[primaryAnchorId]?.[flag]?.winRate : undefined),
  });

  const assembleResult = assembleFlags(pool);
  const promotionInput = {
    registry: promotion.registry,
    latestVersion,
    latestVersionFlags: promotion.latestVersionFlags,
    waveId: report.waveId,
    nextVersion: {
      version: `v${lineage.length + 1}`,
      flags: assembleResult.flags,
      parent: latestVersion,
      createdAt: recordedAt,
      notes:
        `${promotion.notesPrefix}assembleFlags(ADR-0014)로 승격: pool=[${pool.map((c) => c.flag).join(', ')}], ` +
        `excluded=[${assembleResult.excluded.map((e) => e.flag).join(', ') || '(없음)'}].`,
    },
  };

  // Check immediately after assembly: a no-op needs no composition recheck,
  // because it retains this already-registered version's exact flags.
  if (flagsUnchanged(assembleResult.flags, promotion.latestVersionFlags)) {
    const noOpPromotion = finalizePromotion(promotionInput);
    return { promotedVersion: noOpPromotion.promotedVersion, noOp: true, adoptedFlags, assembleResult };
  }

  composeBotChecked(adapter, assembleResult.flags);
  const nextVersion = finalizePromotion(promotionInput);

  return { promotedVersion: nextVersion.promotedVersion, noOp: nextVersion.noOp, adoptedFlags, assembleResult };
}

/** Step 4: per-bucket candidate/adopted counts and mean challenge delta vs
 * this round's own baseline measurement. */
export function computeBucketOutcomes(
  candidates: readonly RoundCandidateSpec[],
  verdictByFlag: ReadonlyMap<string, FinalVerdict>,
  challengeTable: ChallengeTable,
  primaryAnchorId: string | undefined,
  roundBaselineWinRate: number,
): readonly BucketOutcome[] {
  return BUCKET_ORDER.map((bucket) => {
    const bucketCandidates = candidates.filter((candidate) => candidate.bucket === bucket);
    const adopted = bucketCandidates.filter((candidate) => verdictByFlag.get(candidate.flag) === 'adopted').length;

    const deltas = bucketCandidates
      .map((candidate) => (primaryAnchorId !== undefined ? challengeTable[primaryAnchorId]?.[candidate.flag]?.winRate : undefined))
      .filter((winRate): winRate is number => winRate !== undefined)
      .map((winRate) => winRate - roundBaselineWinRate);
    const challengeDelta = deltas.length > 0 ? deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length : 0;

    return { bucket, candidates: bucketCandidates.length, adopted, challengeDelta };
  });
}

/**
 * Runs DESIGN.md §6.2's 2-5 stages (probe filter -> wave -> challenge ->
 * promotion -> reallocation) for one portfolio round and persists the result
 * to `input.outputPath`. Transcendence confirmation (N=200/L3 holdout) is
 * deliberately excluded — that judgment call belongs to the caller, which
 * inspects `result.wave.challengeResult`/`result.challenge` after this
 * returns (see this file's own doc comment).
 */
export function runPortfolioRound(input: RunPortfolioRoundInput): RunPortfolioRoundResult {
  const latest = input.promotion.registry.latest();
  const latestVersion = latest?.version ?? 'unversioned';

  const mergedProbes = mergeProbeBanks(input.probeFilter.probeBanks);
  const probeFilterRows = runProbeFilter(input.adapter, input.candidates, mergedProbes, input.probeFilter, input.clockNowMs);
  const advancing = probeFilterRows.filter((row) => row.advanced);

  const { report, criteria } = runRoundWave(
    input.adapter,
    input.gameId,
    advancing,
    latestVersion,
    input.wave,
    input.challenge,
    input.recordedAt,
    input.screenProbeSeeds ?? DEFAULT_SCREEN_PROBE_SEEDS,
  );
  const challengeTable = buildChallengeTable(report);
  const primaryAnchorId = input.challenge.anchors[input.challenge.anchors.length - 1]?.anchorId;

  const { promotedVersion, noOp, adoptedFlags, assembleResult } = runPromotion(
    input.adapter,
    report,
    challengeTable,
    primaryAnchorId,
    latestVersion,
    input.promotion,
    input.recordedAt,
  );

  const verdictByFlag = new Map(report.results.map((result) => [result.flag, result.verdict]));
  const roundBaselineWinRate = (primaryAnchorId !== undefined ? challengeTable[primaryAnchorId]?.['baseline']?.winRate : undefined) ?? 0.5;
  const bucketOutcomes = computeBucketOutcomes(input.candidates, verdictByFlag, challengeTable, primaryAnchorId, roundBaselineWinRate);

  const nextAllocation = reallocate(input.bucketAllocation.current, bucketOutcomes);
  savePortfolioState(input.rootDir, input.gameId, nextAllocation);

  const result: RunPortfolioRoundResult = {
    probeFilter: probeFilterRows,
    wave: report,
    challenge: challengeTable,
    adoption: {
      promotedVersion,
      noOp,
      adoptedFlags,
      assembleFlagsResult: assembleResult,
    },
    bucketOutcomes,
    criteria,
    nextAllocation,
  };

  const summary = {
    gameId: input.gameId,
    generatedAt: input.recordedAt,
    probeFilter: probeFilterRows.map((row) => ({
      flag: row.flag,
      bucket: row.bucket,
      agreementRate: row.probeScore.agreementRate,
      probesScored: row.probeScore.probes - row.probeScore.skipped,
      probesSkipped: row.probeScore.skipped,
      msPerGame: row.msPerGame,
      advanced: row.advanced,
      costMultiplierFlagged: row.costMultiplierFlagged,
    })),
    wave: {
      waveId: report.waveId,
      comparabilityKey: report.comparabilityKey,
      results: report.results.map((r) => ({ flag: r.flag, verdict: r.verdict, tiersPassed: r.tiersPassed })),
    },
    challenge: challengeTable,
    adoption: {
      promotedVersion,
      noOp,
      adoptedFlags,
      assembleFlags: assembleResult ? { flags: assembleResult.flags, excluded: assembleResult.excluded } : null,
    },
    bucketOutcomes,
    portfolioAllocation: { previous: input.bucketAllocation.current, next: nextAllocation },
  };
  writeFileSync(input.outputPath, JSON.stringify(summary, null, 2));

  return result;
}
