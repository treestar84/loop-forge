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

import type { AnyBotFactory, AnyGameAdapter, StrategyFlagSpec } from '../contract/types';
import {
  bootstrapPairedSeedBlocks,
  type PairedSeedOutcome,
} from '../kernel/paired-stats';
import { sha256Digest } from '../kernel/digest';
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

export interface WaveConfig {
  readonly waveId: string;
  /** Flags looked up in adapter.strategySurface by name. */
  readonly candidates: ReadonlyArray<{ readonly flag: string }>;
  readonly opponent: 'heuristic' | 'random';
  readonly ledger: SeedLedger;
  readonly tiers: {
    readonly smoke: WaveSmokeTierConfig;
    readonly prune: WaveFixedTierConfig;
    readonly holdout: WaveFixedTierConfig;
  };
  readonly criteria: PromotionCriteria;
  readonly screenProbe: WaveScreenProbeConfig;
}

export interface WaveCandidateResult {
  readonly flag: string;
  readonly verdict: FinalVerdict;
  readonly tiersPassed: readonly TierId[];
  readonly stats: Partial<Record<TierId, TierStats>>;
  readonly defect?: MatchDefect;
}

export interface WaveReport {
  readonly waveId: string;
  readonly results: readonly WaveCandidateResult[];
  readonly seedConsumption: readonly string[];
  readonly reportDigest: string;
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

function findFlagSpec(
  adapter: AnyGameAdapter,
  flag: string,
): StrategyFlagSpec<unknown, unknown> {
  const found = adapter.strategySurface.find((candidate) => candidate.flag === flag);
  if (!found) {
    throw new Error(`runWave: strategy flag "${flag}" not found in adapter.strategySurface`);
  }
  return found;
}

/** Trajectory (choiceKeys) for seat-0-bot=seatZeroFactory vs every other seat=restFactory. */
function runTrajectory(
  adapter: AnyGameAdapter,
  seatZeroFactory: AnyBotFactory,
  restFactory: AnyBotFactory,
  seed: number,
  botSeedBase: number,
): readonly string[] | { readonly defect: MatchDefect } {
  const playerCount = adapter.spec.playerCount;
  const botFactories: AnyBotFactory[] = [seatZeroFactory];
  for (let i = 1; i < playerCount; i += 1) {
    botFactories.push(restFactory);
  }
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
 * the base bot's trajectory (both facing the same base-bot opponents) across
 * the probe seeds. Identical trajectories on every seed means the flag is a
 * no-op — it must be screened out before any games are spent on it.
 */
function screenCandidate(
  adapter: AnyGameAdapter,
  candidateFactory: AnyBotFactory,
  baseFactory: AnyBotFactory,
  probe: WaveScreenProbeConfig,
): { readonly passed: boolean; readonly defect?: MatchDefect } {
  let behaviorallyDistinct = false;
  for (const seed of probe.seeds) {
    const candidateTrajectory = runTrajectory(
      adapter,
      candidateFactory,
      baseFactory,
      seed,
      probe.botSeedBase,
    );
    if ('defect' in candidateTrajectory) {
      return { passed: false, defect: candidateTrajectory.defect };
    }
    const baseTrajectory = runTrajectory(adapter, baseFactory, baseFactory, seed, probe.botSeedBase);
    if ('defect' in baseTrajectory) {
      return { passed: false, defect: baseTrajectory.defect };
    }
    if (!arraysEqual(candidateTrajectory, baseTrajectory)) {
      behaviorallyDistinct = true;
    }
  }
  return { passed: behaviorallyDistinct };
}

function currentStats(outcomes: readonly PairedSeedOutcome[]): TierStats {
  if (outcomes.length === 0) {
    return { pointWinRate: 0, pointScoreDiff: 0 };
  }
  return {
    pointWinRate: mean(outcomes.map((outcome) => outcome.candidateWinFraction)),
    pointScoreDiff: mean(outcomes.map((outcome) => outcome.candidateScoreDelta)),
  };
}

interface TierRunResult {
  readonly passed: boolean;
  readonly stats: TierStats;
  readonly defect?: MatchDefect;
}

/** SPRT-gated smoke tier: consumes seeds in order up to maxBlocks, stopping early on accept/reject. */
function runSmokeTier(
  adapter: AnyGameAdapter,
  candidateFactory: AnyBotFactory,
  baseFactory: AnyBotFactory,
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
    const result = runPairedBlock(adapter, candidateFactory, baseFactory, seed, seed);
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

/** Fixed-N tier (prune/holdout): runs every seed, bootstraps, judges via kernel/gates. */
function runFixedTier(
  tier: 'prune' | 'holdout',
  adapter: AnyGameAdapter,
  candidateFactory: AnyBotFactory,
  baseFactory: AnyBotFactory,
  seeds: readonly number[],
  criteria: PromotionCriteria,
  bootstrapSeed: number,
): TierRunResult {
  const outcomes: PairedSeedOutcome[] = [];
  for (const seed of seeds) {
    const result = runPairedBlock(adapter, candidateFactory, baseFactory, seed, seed);
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
  const stats: TierStats = {
    pointWinRate: bootstrap.pointWinRate,
    pointScoreDiff: bootstrap.pointScoreDiff,
  };
  return { passed: judgeTier(tier, stats, criteria) === 'pass', stats };
}

function evaluateCandidate(
  adapter: AnyGameAdapter,
  wave: WaveConfig,
  baseFactory: AnyBotFactory,
  flag: string,
  smokeSeeds: readonly number[],
  pruneSeeds: readonly number[],
  holdoutSeeds: readonly number[],
): WaveCandidateResult {
  const flagSpec = findFlagSpec(adapter, flag);
  const candidateFactory = flagSpec.apply(baseFactory);

  const tiersPassed: TierId[] = [];
  const stats: Partial<Record<TierId, TierStats>> = {};

  const screenResult = screenCandidate(adapter, candidateFactory, baseFactory, wave.screenProbe);
  if (screenResult.defect) {
    return { flag, verdict: 'failed', tiersPassed, stats, defect: screenResult.defect };
  }
  if (!screenResult.passed) {
    // No-op flag: rejected at screen, before any games are spent on it.
    const verdict = finalVerdict(tiersPassed, { pointWinRate: 0, pointScoreDiff: 0 }, wave.criteria);
    return { flag, verdict, tiersPassed, stats };
  }
  tiersPassed.push('screen');

  const smokeResult = runSmokeTier(adapter, candidateFactory, baseFactory, smokeSeeds, wave.tiers.smoke);
  stats.smoke = smokeResult.stats;
  if (smokeResult.defect) {
    return { flag, verdict: 'failed', tiersPassed, stats, defect: smokeResult.defect };
  }
  if (!smokeResult.passed) {
    const verdict = finalVerdict(tiersPassed, smokeResult.stats, wave.criteria);
    return { flag, verdict, tiersPassed, stats };
  }
  tiersPassed.push('smoke');

  const pruneResult = runFixedTier(
    'prune',
    adapter,
    candidateFactory,
    baseFactory,
    pruneSeeds,
    wave.criteria,
    hashToInt(`${wave.waveId}:${flag}:prune`),
  );
  stats.prune = pruneResult.stats;
  if (pruneResult.defect) {
    return { flag, verdict: 'failed', tiersPassed, stats, defect: pruneResult.defect };
  }
  if (!pruneResult.passed) {
    const verdict = finalVerdict(tiersPassed, pruneResult.stats, wave.criteria);
    return { flag, verdict, tiersPassed, stats };
  }
  tiersPassed.push('prune');

  const holdoutResult = runFixedTier(
    'holdout',
    adapter,
    candidateFactory,
    baseFactory,
    holdoutSeeds,
    wave.criteria,
    hashToInt(`${wave.waveId}:${flag}:holdout`),
  );
  stats.holdout = holdoutResult.stats;
  if (holdoutResult.defect) {
    return { flag, verdict: 'failed', tiersPassed, stats, defect: holdoutResult.defect };
  }
  if (holdoutResult.passed) {
    tiersPassed.push('holdout');
  }

  const verdict = finalVerdict(tiersPassed, holdoutResult.stats, wave.criteria);
  return { flag, verdict, tiersPassed, stats };
}

export function runWave(adapter: AnyGameAdapter, wave: WaveConfig): WaveReport {
  const consumedAt = new Date().toISOString();
  const seedConsumption: string[] = [];

  wave.ledger.consume(wave.tiers.smoke.bankId, consumedAt);
  seedConsumption.push(wave.tiers.smoke.bankId);
  wave.ledger.consume(wave.tiers.prune.bankId, consumedAt);
  seedConsumption.push(wave.tiers.prune.bankId);
  wave.ledger.consume(wave.tiers.holdout.bankId, consumedAt);
  seedConsumption.push(wave.tiers.holdout.bankId);

  const smokeSeeds = wave.ledger.seedsOf(wave.tiers.smoke.bankId);
  const pruneSeeds = wave.ledger
    .seedsOf(wave.tiers.prune.bankId)
    .slice(0, wave.tiers.prune.blocks);
  const holdoutSeeds = wave.ledger
    .seedsOf(wave.tiers.holdout.bankId)
    .slice(0, wave.tiers.holdout.blocks);

  const baseFactory = adapter.baselines[wave.opponent];

  const results = wave.candidates.map((candidateConfig) =>
    evaluateCandidate(
      adapter,
      wave,
      baseFactory,
      candidateConfig.flag,
      smokeSeeds,
      pruneSeeds,
      holdoutSeeds,
    ),
  );

  const reportDigest = sha256Digest({ waveId: wave.waveId, results, seedConsumption });

  return { waveId: wave.waveId, results, seedConsumption, reportDigest };
}
