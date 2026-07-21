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

/**
 * Approximate the standard normal quantile function (probit) using Peter
 * Acklam's rational approximation (max absolute error ~1.15e-9). Used by
 * `recommendBlockCount` so alpha/power are not restricted to a fixed table.
 */
function normalQuantile(p: number): number {
  if (!(p > 0) || !(p < 1)) {
    throw new Error('normalQuantile: p must be in (0,1)');
  }

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  function polyC(q: number): number {
    let value = c[0] as number;
    for (let i = 1; i < c.length; i += 1) {
      value = value * q + (c[i] as number);
    }
    return value;
  }
  function polyD(q: number): number {
    let value = d[0] as number;
    for (let i = 1; i < d.length; i += 1) {
      value = value * q + (d[i] as number);
    }
    return value * q + 1;
  }
  function polyA(r: number): number {
    let value = a[0] as number;
    for (let i = 1; i < a.length; i += 1) {
      value = value * r + (a[i] as number);
    }
    return value;
  }
  function polyB(r: number): number {
    let value = b[0] as number;
    for (let i = 1; i < b.length; i += 1) {
      value = value * r + (b[i] as number);
    }
    return value * r + 1;
  }

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return polyC(q) / polyD(q);
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (polyA(r) * q) / polyB(r);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -polyC(q) / polyD(q);
}

export interface RecommendBlockCountInput {
  /** Empirical noise-floor input: sample stddev of block winFraction (see
   * `measureNoiseFloor`'s `blockStdDev`, loop/calibrate.ts). */
  readonly blockStdDev: number;
  /** The win-rate effect size (e.g. 0.03 for +3%p) the design must be able to
   * distinguish from noise. */
  readonly targetEffect: number;
  /** Two-sided significance level. Defaults to 0.05. */
  readonly alpha?: number;
  /** Statistical power (1 - beta). Defaults to 0.8. */
  readonly power?: number;
}

/**
 * Normal-approximation sample-size calculation: how many paired-seed blocks
 * are needed to detect `targetEffect` at the given `alpha`/`power`, given the
 * observed noise floor `blockStdDev`.
 *
 *   n = ((z_(1-alpha/2) + z_power) * blockStdDev / targetEffect)^2
 *
 * (docs/GAP-ANALYSIS-2.md X3: high-variance games otherwise leave bank-size
 * decisions to guesswork.)
 */
export function recommendBlockCount(input: RecommendBlockCountInput): number {
  const alpha = input.alpha ?? 0.05;
  const power = input.power ?? 0.8;
  if (!(input.blockStdDev > 0)) {
    throw new Error('recommendBlockCount: blockStdDev must be > 0');
  }
  if (!(input.targetEffect > 0)) {
    throw new Error('recommendBlockCount: targetEffect must be > 0');
  }
  if (!(alpha > 0) || !(alpha < 1)) {
    throw new Error('recommendBlockCount: alpha must be in (0,1)');
  }
  if (!(power > 0) || !(power < 1)) {
    throw new Error('recommendBlockCount: power must be in (0,1)');
  }

  const zAlpha = normalQuantile(1 - alpha / 2);
  const zPower = normalQuantile(power);
  const n = ((zAlpha + zPower) * input.blockStdDev) / input.targetEffect;
  return Math.ceil(n * n);
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
