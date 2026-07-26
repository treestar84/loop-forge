/**
 * Wave runner: evaluates a candidate set through the multi-tier promotion
 * pipeline (screen -> smoke -> prune -> holdout; kernel/gates.ts owns tier
 * order and judging). Smoke passing alone is a "screened" verdict, not
 * adoption — only holdout passing promotes a candidate (DESIGN.md §5/§6).
 *
 * Screen and smoke/prune/holdout banks are each consumed exactly once per
 * wave (not once per candidate): every candidate in the wave is measured
 * against the same fixed seed lists, which is what makes their outcomes
 * comparable.
 */

import type { AnyBotFactory, AnyGameAdapter } from '../contract/types';
import {
  bootstrapPairedSeedBlocks,
  type PairedSeedOutcome,
} from '../kernel/paired-stats';
import { canonicalJson, sha256Digest } from '../kernel/digest';
import {
  finalVerdict,
  judgeTier,
  type FinalVerdict,
  type PromotionCriteria,
  type TierId,
  type TierStats,
} from '../kernel/gates';
import { createSprt, type SprtConfig } from '../kernel/sprt';
import type { SeedLedger } from '../kernel/seed-ledger';
import { composeBot } from './compose';
import { computeComparabilityKey } from '../kernel/comparability';
import { runMatch, type MatchDefect } from './match';
import { runPairedBlock } from './paired-match';

export interface WaveSmokeTierConfig {
  readonly bankId: string;
  readonly sprt: SprtConfig;
  readonly maxBlocks: number;
  readonly minBlocks: number;
}

export interface WaveFixedTierConfig {
  readonly bankId: string;
  readonly blocks: number;
}

export interface WaveScreenProbeConfig {
  readonly seeds: readonly number[];
  readonly botSeedBase: number;
}

/**
 * A candidate is one or more strategySurface flags composed in order (C4:
 * bundle candidates for marginal/regression checks). The single-flag `flag`
 * form is kept for backward compatibility; both forms resolve to the same
 * `flags` array internally.
 */
export type WaveCandidateConfig =
  | { readonly flag: string }
  | { readonly flags: readonly string[] };

export function candidateFlags(candidate: WaveCandidateConfig): readonly string[] {
  return 'flags' in candidate ? candidate.flags : [candidate.flag];
}

export interface WaveConfig {
  readonly waveId: string;
  readonly candidates: ReadonlyArray<WaveCandidateConfig>;
  readonly opponent: 'heuristic' | 'random';
  /**
   * Field mix (docs/GAP-ANALYSIS-10.md M4): per-seat opponent composition for
   * multi-player (3+) games, one entry per non-candidate seat slot — length
   * must equal `adapter.spec.playerCount - 1`, checked at the start of
   * `runWave` with a clear throw on mismatch. When set, this takes precedence
   * over `opponent` for every non-candidate seat: slot `i` (0-indexed, the
   * (i+1)-th match seat) is filled by `adapter.baselines[fieldMix[i]]`
   * instead of the single `opponent` factory. Omitted (the default) preserves
   * pre-M4 behavior exactly — every non-candidate seat filled by the single
   * `opponent` factory.
   */
  readonly fieldMix?: ReadonlyArray<'heuristic' | 'random'>;
  readonly ledger: SeedLedger;
  /**
   * ISO timestamp stamped on seed-bank consumption. Caller-injected (app
   * boundary), never derived from the wall clock here — the loop layer is
   * bound by the determinism rule.
   */
  readonly recordedAt: string;
  /**
   * Flags already adopted into the current baseline, composed onto
   * adapter.baselines.heuristic before any candidate flags (C4 marginal
   * check). Defaults to an empty array — a pristine heuristic baseline.
   */
  readonly baselineFlags?: readonly string[];
  /** Identifies the baseline this wave's candidates build on, for comparabilityKey (C3). Defaults to 'unversioned'. */
  readonly baselineVersion?: string;
  readonly tiers: {
    readonly smoke: WaveSmokeTierConfig;
    readonly prune: WaveFixedTierConfig;
    readonly holdout: WaveFixedTierConfig;
    /**
     * O10 (docs/GAP-ANALYSIS-7.md): optional regression gate run after
     * holdout passes, paired against the current baseline composite bot
     * (baselineFactory) rather than the raw heuristic opponentFactory every
     * other tier faces. Catches override-style candidates (e.g. a search
     * flag whose `apply` discards `base`) that beat the raw opponent but are
     * actually weaker than what's already adopted. Omitted entirely
     * preserves pre-O10 behavior byte-for-byte (reportDigest unchanged).
     */
    readonly regression?: WaveFixedTierConfig;
  };
  readonly criteria: PromotionCriteria;
  readonly screenProbe: WaveScreenProbeConfig;
  /**
   * Fraction of a tier's blocks whose drawRate (winFraction===0.5) must be
   * reached before a signal-collapse warning is raised for that tier
   * (docs/GAP-ANALYSIS-2.md X1: paired signal collapse — seat mirroring can
   * cancel strategy signal along with position bias). Defaults to 0.8.
   */
  readonly signalCollapseThreshold?: number;
}

export interface WaveTierStats extends TierStats {
  readonly blocks: number;
  readonly drawRate?: number;
  readonly winRateCI?: { readonly lower: number; readonly upper: number };
}

export interface WaveCandidateResult {
  /** Back-compat single-string label: flags.length===1 ? flags[0] : flags.join('+'). */
  readonly flag: string;
  readonly flags: readonly string[];
  readonly verdict: FinalVerdict;
  readonly tiersPassed: readonly TierId[];
  readonly stats: Partial<Record<TierId, WaveTierStats>>;
  readonly defect?: MatchDefect;
  /**
   * Signal-collapse warnings (docs/GAP-ANALYSIS-2.md X1), one per tier whose
   * drawRate met/exceeded signalCollapseThreshold. Empty when none triggered.
   */
  readonly warnings: readonly string[];
}

export interface WaveReport {
  readonly waveId: string;
  readonly results: readonly WaveCandidateResult[];
  readonly seedConsumption: readonly string[];
  readonly comparabilityKey: string;
  readonly reportDigest: string;
  /** Aggregated signal-collapse warnings across every candidate, prefixed with the candidate's flag label. */
  readonly warnings: readonly string[];
}

const DEFAULT_SIGNAL_COLLAPSE_THRESHOLD = 0.8;

function signalCollapseWarnings(
  stats: Partial<Record<TierId, WaveTierStats>>,
  threshold: number,
): string[] {
  const warnings: string[] = [];
  for (const tier of ['smoke', 'prune', 'holdout'] as const) {
    const tierStats = stats[tier];
    if (tierStats?.drawRate !== undefined && tierStats.drawRate >= threshold) {
      warnings.push(
        `signal collapse at ${tier} (drawRate=${tierStats.drawRate.toFixed(3)}) — ` +
          '미러링이 전략 신호까지 상쇄 중, 오프닝 다양성/불균형 오프닝 필요 (docs/INTERPRETATION.md)',
      );
    }
  }
  return warnings;
}

function hashToInt(label: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

function candidateLabel(flags: readonly string[]): string {
  return flags.length === 1 ? (flags[0] as string) : flags.join('+');
}

/**
 * Build the per-seat factory list for every non-candidate seat. A single
 * `fillFactory` fills every slot unless `fieldMix` is set, in which case each
 * slot gets its own `adapter.baselines[fieldMix[i]]` (docs/GAP-ANALYSIS-10.md
 * M4). Omitted `fieldMix` produces an array where every entry equals
 * `fillFactory` — identical in effect to the pre-M4 single-factory fill.
 */
function buildRestFactories(
  adapter: AnyGameAdapter,
  fieldMix: WaveConfig['fieldMix'],
  fillFactory: AnyBotFactory,
): readonly AnyBotFactory[] {
  const restSlotCount = adapter.spec.playerCount - 1;
  if (fieldMix === undefined) {
    return Array.from({ length: restSlotCount }, () => fillFactory);
  }
  return fieldMix.map((name) => adapter.baselines[name]);
}

/** Trajectory (choiceKeys) for seat-0-bot=seatZeroFactory vs every other seat filled per restFactories[i-1]. */
function runTrajectory(
  adapter: AnyGameAdapter,
  seatZeroFactory: AnyBotFactory,
  restFactories: readonly AnyBotFactory[],
  seed: number,
  botSeedBase: number,
): readonly string[] | { readonly defect: MatchDefect } {
  const botFactories: AnyBotFactory[] = [seatZeroFactory, ...restFactories];
  const botSeeds = botFactories.map((_, index) => botSeedBase + index);
  const seating = adapter.spec.seatingPlan[0];
  if (!seating) {
    throw new Error('runWave: adapter.spec.seatingPlan is empty');
  }
  const result = runMatch(adapter, botFactories, seed, botSeeds, seating);
  if (result.kind === 'defect') {
    return { defect: result.defect };
  }
  return result.choiceKeys;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

/**
 * Behavioral-fingerprint screen: compare the candidate's trajectory against
 * the base bot's trajectory (both facing the same non-candidate-seat
 * opponents) across the probe seeds. Identical trajectories on every seed
 * means the flag is a no-op — it must be screened out before any games are
 * spent on it.
 *
 * `restFactories` fills every non-candidate seat identically for both
 * trajectories — including under a field-mix wave, where it already reflects
 * the wave's fieldMix composition (docs/GAP-ANALYSIS-10.md M4): this is a
 * no-candidate probe, so the field-mix slots stay exactly as configured and
 * only the candidate seat swaps between candidateFactory and baseFactory.
 */
function screenCandidate(
  adapter: AnyGameAdapter,
  candidateFactory: AnyBotFactory,
  baseFactory: AnyBotFactory,
  restFactories: readonly AnyBotFactory[],
  probe: WaveScreenProbeConfig,
): { readonly passed: boolean; readonly defect?: MatchDefect } {
  let behaviorallyDistinct = false;
  for (const seed of probe.seeds) {
    const candidateTrajectory = runTrajectory(
      adapter,
      candidateFactory,
      restFactories,
      seed,
      probe.botSeedBase,
    );
    if ('defect' in candidateTrajectory) {
      return { passed: false, defect: candidateTrajectory.defect };
    }
    const baseTrajectory = runTrajectory(adapter, baseFactory, restFactories, seed, probe.botSeedBase);
    if ('defect' in baseTrajectory) {
      return { passed: false, defect: baseTrajectory.defect };
    }
    if (!arraysEqual(candidateTrajectory, baseTrajectory)) {
      behaviorallyDistinct = true;
    }
  }
  return { passed: behaviorallyDistinct };
}

function drawRateOf(outcomes: readonly PairedSeedOutcome[]): number {
  if (outcomes.length === 0) {
    return 0;
  }
  const draws = outcomes.filter((outcome) => outcome.candidateWinFraction === 0.5).length;
  return draws / outcomes.length;
}

function currentStats(outcomes: readonly PairedSeedOutcome[]): WaveTierStats {
  if (outcomes.length === 0) {
    return { pointWinRate: 0, pointScoreDiff: 0, blocks: 0, drawRate: 0 };
  }
  return {
    pointWinRate: mean(outcomes.map((outcome) => outcome.candidateWinFraction)),
    pointScoreDiff: mean(outcomes.map((outcome) => outcome.candidateScoreDelta)),
    blocks: outcomes.length,
    drawRate: drawRateOf(outcomes),
  };
}

interface TierRunResult {
  readonly passed: boolean;
  readonly stats: WaveTierStats;
  readonly defect?: MatchDefect;
}

/** SPRT-gated smoke tier: consumes seeds in order up to maxBlocks, stopping early on accept/reject. */
function runSmokeTier(
  adapter: AnyGameAdapter,
  candidateFactory: AnyBotFactory,
  restFactories: readonly AnyBotFactory[],
  seeds: readonly number[],
  config: WaveSmokeTierConfig,
): TierRunResult {
  const sprt = createSprt(config.sprt);
  const outcomes: PairedSeedOutcome[] = [];
  let blocksRun = 0;

  for (const seed of seeds) {
    if (blocksRun >= config.maxBlocks) {
      break;
    }
    const result = runPairedBlock(adapter, candidateFactory, restFactories, seed, seed);
    if ('defect' in result) {
      return { passed: false, stats: currentStats(outcomes), defect: result.defect };
    }
    outcomes.push(result);
    sprt.update(result.candidateWinFraction);
    blocksRun += 1;

    if (blocksRun >= config.minBlocks) {
      const verdict = sprt.verdict();
      if (verdict === 'accept') {
        return { passed: true, stats: currentStats(outcomes) };
      }
      if (verdict === 'reject') {
        return { passed: false, stats: currentStats(outcomes) };
      }
    }
  }

  const stats = currentStats(outcomes);
  // maxBlocks exhausted while the SPRT is still undecided: fall back to the
  // point estimate against the null hypothesis (DESIGN.md §6 step 2).
  return { passed: stats.pointWinRate > config.sprt.p0, stats };
}

/** Fixed-N tier (prune/holdout/regression): runs every seed, bootstraps, judges via kernel/gates. */
function runFixedTier(
  tier: 'prune' | 'holdout' | 'regression',
  adapter: AnyGameAdapter,
  candidateFactory: AnyBotFactory,
  restFactories: readonly AnyBotFactory[],
  seeds: readonly number[],
  criteria: PromotionCriteria,
  bootstrapSeed: number,
): TierRunResult {
  const outcomes: PairedSeedOutcome[] = [];
  for (const seed of seeds) {
    const result = runPairedBlock(adapter, candidateFactory, restFactories, seed, seed);
    if ('defect' in result) {
      return { passed: false, stats: currentStats(outcomes), defect: result.defect };
    }
    outcomes.push(result);
  }
  const bootstrap = bootstrapPairedSeedBlocks(outcomes, {
    iterations: 2000,
    confidenceLevel: 0.95,
    seed: bootstrapSeed,
  });
  const stats: WaveTierStats = {
    pointWinRate: bootstrap.pointWinRate,
    pointScoreDiff: bootstrap.pointScoreDiff,
    blocks: outcomes.length,
    drawRate: drawRateOf(outcomes),
    winRateCI: { lower: bootstrap.winRate.lower, upper: bootstrap.winRate.upper },
  };
  return { passed: judgeTier(tier, stats, criteria) === 'pass', stats };
}

function evaluateCandidate(
  adapter: AnyGameAdapter,
  wave: WaveConfig,
  baselineFactory: AnyBotFactory,
  opponentFactory: AnyBotFactory,
  flags: readonly string[],
  smokeSeeds: readonly number[],
  pruneSeeds: readonly number[],
  holdoutSeeds: readonly number[],
  regressionSeeds: readonly number[],
): WaveCandidateResult {
  const flag = candidateLabel(flags);
  const candidateFactory = composeBot(adapter, [...(wave.baselineFlags ?? []), ...flags]);
  const signalCollapseThreshold = wave.signalCollapseThreshold ?? DEFAULT_SIGNAL_COLLAPSE_THRESHOLD;

  // Field mix (docs/GAP-ANALYSIS-10.md M4): when wave.fieldMix is unset both
  // arrays collapse to "every non-candidate seat filled by one factory" —
  // baselineFactory for the screen/regression fill, opponentFactory for
  // smoke/prune/holdout — reproducing pre-M4 behavior exactly.
  const baselineRestFactories = buildRestFactories(adapter, wave.fieldMix, baselineFactory);
  const opponentRestFactories = buildRestFactories(adapter, wave.fieldMix, opponentFactory);

  const tiersPassed: TierId[] = [];
  const stats: Partial<Record<TierId, WaveTierStats>> = {};
  const warnings = (): string[] => signalCollapseWarnings(stats, signalCollapseThreshold);

  // Screen compares against the baseline the candidate was built from (not
  // necessarily the match opponent) — this is what detects a no-op flag.
  const screenResult = screenCandidate(
    adapter,
    candidateFactory,
    baselineFactory,
    baselineRestFactories,
    wave.screenProbe,
  );
  if (screenResult.defect) {
    return { flag, flags, verdict: 'failed', tiersPassed, stats, defect: screenResult.defect, warnings: warnings() };
  }
  if (!screenResult.passed) {
    // No-op flag: rejected at screen, before any games are spent on it.
    const verdict = finalVerdict(tiersPassed, { pointWinRate: 0, pointScoreDiff: 0 }, wave.criteria);
    return { flag, flags, verdict, tiersPassed, stats, warnings: warnings() };
  }
  tiersPassed.push('screen');

  const smokeResult = runSmokeTier(adapter, candidateFactory, opponentRestFactories, smokeSeeds, wave.tiers.smoke);
  stats.smoke = smokeResult.stats;
  if (smokeResult.defect) {
    return { flag, flags, verdict: 'failed', tiersPassed, stats, defect: smokeResult.defect, warnings: warnings() };
  }
  if (!smokeResult.passed) {
    const verdict = finalVerdict(tiersPassed, smokeResult.stats, wave.criteria);
    return { flag, flags, verdict, tiersPassed, stats, warnings: warnings() };
  }
  tiersPassed.push('smoke');

  const pruneResult = runFixedTier(
    'prune',
    adapter,
    candidateFactory,
    opponentRestFactories,
    pruneSeeds,
    wave.criteria,
    hashToInt(`${wave.waveId}:${flag}:prune`),
  );
  stats.prune = pruneResult.stats;
  if (pruneResult.defect) {
    return { flag, flags, verdict: 'failed', tiersPassed, stats, defect: pruneResult.defect, warnings: warnings() };
  }
  if (!pruneResult.passed) {
    const verdict = finalVerdict(tiersPassed, pruneResult.stats, wave.criteria);
    return { flag, flags, verdict, tiersPassed, stats, warnings: warnings() };
  }
  tiersPassed.push('prune');

  const holdoutResult = runFixedTier(
    'holdout',
    adapter,
    candidateFactory,
    opponentRestFactories,
    holdoutSeeds,
    wave.criteria,
    hashToInt(`${wave.waveId}:${flag}:holdout`),
  );
  stats.holdout = holdoutResult.stats;
  if (holdoutResult.defect) {
    return { flag, flags, verdict: 'failed', tiersPassed, stats, defect: holdoutResult.defect, warnings: warnings() };
  }
  if (holdoutResult.passed) {
    tiersPassed.push('holdout');

    // O10 (docs/GAP-ANALYSIS-7.md): only run when configured, so a wave
    // without a regression tier behaves exactly as before. Opponent here is
    // deliberately baselineRestFactories (the current baseline composite bot,
    // field-mix-composed like every other tier), not opponentRestFactories
    // (the raw heuristic every other tier faces) — that substitution is the
    // entire point of this tier: it's the only gate that can catch an
    // override-style candidate that beats the raw opponent but is weaker
    // than what's already adopted.
    if (wave.tiers.regression !== undefined) {
      const regressionResult = runFixedTier(
        'regression',
        adapter,
        candidateFactory,
        baselineRestFactories,
        regressionSeeds,
        wave.criteria,
        hashToInt(`${wave.waveId}:${flag}:regression`),
      );
      stats.regression = regressionResult.stats;
      if (regressionResult.defect) {
        return {
          flag,
          flags,
          verdict: 'failed',
          tiersPassed,
          stats,
          defect: regressionResult.defect,
          warnings: warnings(),
        };
      }
      if (regressionResult.passed) {
        tiersPassed.push('regression');
      } else {
        const threshold = wave.criteria.regressionMinWinRate ?? 0.5;
        const regressionWarning =
          `regression failed vs current baseline (winRate=${regressionResult.stats.pointWinRate.toFixed(3)} < ${threshold.toFixed(3)})`;
        return {
          flag,
          flags,
          verdict: 'near-miss',
          tiersPassed,
          stats,
          warnings: [...warnings(), regressionWarning],
        };
      }
    }
  }

  const verdict = finalVerdict(tiersPassed, holdoutResult.stats, wave.criteria);
  return { flag, flags, verdict, tiersPassed, stats, warnings: warnings() };
}

export function runWave(adapter: AnyGameAdapter, wave: WaveConfig): WaveReport {
  if (wave.fieldMix !== undefined) {
    const expectedLength = adapter.spec.playerCount - 1;
    if (wave.fieldMix.length !== expectedLength) {
      throw new Error(
        `runWave: wave.fieldMix.length (${wave.fieldMix.length}) must equal ` +
          `adapter.spec.playerCount - 1 (${expectedLength})`,
      );
    }
  }

  const consumedAt = wave.recordedAt;
  const seedConsumption: string[] = [];

  wave.ledger.consume(wave.tiers.smoke.bankId, consumedAt);
  seedConsumption.push(wave.tiers.smoke.bankId);
  wave.ledger.consume(wave.tiers.prune.bankId, consumedAt);
  seedConsumption.push(wave.tiers.prune.bankId);
  wave.ledger.consume(wave.tiers.holdout.bankId, consumedAt);
  seedConsumption.push(wave.tiers.holdout.bankId);
  if (wave.tiers.regression !== undefined) {
    wave.ledger.consume(wave.tiers.regression.bankId, consumedAt);
    seedConsumption.push(wave.tiers.regression.bankId);
  }

  const smokeSeeds = wave.ledger.seedsOf(wave.tiers.smoke.bankId);
  const pruneSeeds = wave.ledger
    .seedsOf(wave.tiers.prune.bankId)
    .slice(0, wave.tiers.prune.blocks);
  const holdoutSeeds = wave.ledger
    .seedsOf(wave.tiers.holdout.bankId)
    .slice(0, wave.tiers.holdout.blocks);
  const regressionSeeds =
    wave.tiers.regression !== undefined
      ? wave.ledger.seedsOf(wave.tiers.regression.bankId).slice(0, wave.tiers.regression.blocks)
      : [];

  // The candidate is always composed from adapter.baselines.heuristic plus
  // this wave's already-adopted baselineFlags (C4 marginal check); the match
  // opponent is the raw, unflagged baseline family selected by
  // wave.opponent. With the default empty baselineFlags and opponent
  // 'heuristic', these coincide exactly with pre-C4 behavior.
  const baselineFactory = composeBot(adapter, wave.baselineFlags ?? []);
  const opponentFactory = adapter.baselines[wave.opponent];

  const results = wave.candidates.map((candidateConfig) =>
    evaluateCandidate(
      adapter,
      wave,
      baselineFactory,
      opponentFactory,
      candidateFlags(candidateConfig),
      smokeSeeds,
      pruneSeeds,
      holdoutSeeds,
      regressionSeeds,
    ),
  );

  const specDigest = sha256Digest(canonicalJson(adapter.spec));
  const comparabilityKey = computeComparabilityKey({
    gameId: adapter.spec.gameId,
    specDigest,
    baselineVersion: wave.baselineVersion ?? 'unversioned',
    opponentId: wave.opponent,
    seedBankIds: [
      wave.tiers.smoke.bankId,
      wave.tiers.prune.bankId,
      wave.tiers.holdout.bankId,
      ...(wave.tiers.regression !== undefined ? [wave.tiers.regression.bankId] : []),
    ],
  });

  const reportDigest = sha256Digest({ waveId: wave.waveId, results, seedConsumption, comparabilityKey });

  const warnings = results.flatMap((result) =>
    result.warnings.map((warning) => `[${result.flag}] ${warning}`),
  );

  return { waveId: wave.waveId, results, seedConsumption, comparabilityKey, reportDigest, warnings };
}
