/**
 * Paired-seed statistics: percentile bootstrap over seed blocks.
 *
 * Each PairedSeedOutcome already averages a seed's seat-mirrored pair, so the
 * seed itself is the resampling unit — this is what cancels position bias
 * instead of letting it leak into the variance estimate.
 */

import { createRng } from './rng';

export interface PairedSeedOutcome {
  readonly seed: number;
  /** 0..1, seat-mirrored pair average. */
  readonly candidateWinFraction: number;
  readonly candidateScoreDelta: number;
}

export interface BootstrapOptions {
  readonly iterations: number;
  readonly confidenceLevel: number;
  readonly seed: number;
}

export interface ConfidenceInterval {
  readonly lower: number;
  readonly upper: number;
}

export interface BootstrapResult {
  readonly pointWinRate: number;
  readonly pointScoreDiff: number;
  readonly winRate: ConfidenceInterval;
  readonly scoreDiff: ConfidenceInterval;
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  const n = sortedValues.length;
  if (n === 1) {
    return sortedValues[0] as number;
  }
  const position = fraction * (n - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sortedValues[lowerIndex] as number;
  const upperValue = sortedValues[upperIndex] as number;
  if (lowerIndex === upperIndex) {
    return lowerValue;
  }
  const weight = position - lowerIndex;
  return lowerValue + (upperValue - lowerValue) * weight;
}

function validateOutcomes(outcomes: readonly PairedSeedOutcome[]): void {
  if (outcomes.length === 0) {
    throw new Error('bootstrapPairedSeedBlocks: outcomes must be non-empty');
  }
  const seenSeeds = new Set<number>();
  for (const outcome of outcomes) {
    if (seenSeeds.has(outcome.seed)) {
      throw new Error(`bootstrapPairedSeedBlocks: duplicate seed ${outcome.seed}`);
    }
    seenSeeds.add(outcome.seed);
    if (Number.isNaN(outcome.candidateWinFraction) || Number.isNaN(outcome.candidateScoreDelta)) {
      throw new Error(`bootstrapPairedSeedBlocks: NaN outcome for seed ${outcome.seed}`);
    }
    if (outcome.candidateWinFraction < 0 || outcome.candidateWinFraction > 1) {
      throw new Error(
        `bootstrapPairedSeedBlocks: candidateWinFraction out of [0,1] for seed ${outcome.seed}`,
      );
    }
  }
}

function validateOptions(options: BootstrapOptions): void {
  if (!Number.isInteger(options.iterations) || options.iterations <= 0) {
    throw new Error('bootstrapPairedSeedBlocks: iterations must be a positive integer');
  }
  if (options.confidenceLevel <= 0 || options.confidenceLevel >= 1) {
    throw new Error('bootstrapPairedSeedBlocks: confidenceLevel must be in (0,1)');
  }
  if (!Number.isInteger(options.seed)) {
    throw new Error('bootstrapPairedSeedBlocks: seed must be an integer');
  }
}

export function bootstrapPairedSeedBlocks(
  outcomes: readonly PairedSeedOutcome[],
  options: BootstrapOptions,
): BootstrapResult {
  validateOutcomes(outcomes);
  validateOptions(options);

  const pointWinRate = mean(outcomes.map((outcome) => outcome.candidateWinFraction));
  const pointScoreDiff = mean(outcomes.map((outcome) => outcome.candidateScoreDelta));

  const rng = createRng(options.seed);
  const n = outcomes.length;
  const winRateSamples: number[] = [];
  const scoreDiffSamples: number[] = [];

  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    let winSum = 0;
    let scoreSum = 0;
    for (let draw = 0; draw < n; draw += 1) {
      const index = rng.nextInt(n);
      const picked = outcomes[index] as PairedSeedOutcome;
      winSum += picked.candidateWinFraction;
      scoreSum += picked.candidateScoreDelta;
    }
    winRateSamples.push(winSum / n);
    scoreDiffSamples.push(scoreSum / n);
  }

  winRateSamples.sort((a, b) => a - b);
  scoreDiffSamples.sort((a, b) => a - b);

  const tail = (1 - options.confidenceLevel) / 2;

  return {
    pointWinRate,
    pointScoreDiff,
    winRate: {
      lower: percentile(winRateSamples, tail),
      upper: percentile(winRateSamples, 1 - tail),
    },
    scoreDiff: {
      lower: percentile(scoreDiffSamples, tail),
      upper: percentile(scoreDiffSamples, 1 - tail),
    },
  };
}
