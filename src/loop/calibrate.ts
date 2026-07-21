/**
 * Calibration diagnostics: identity self-play (same bot in every seat) and
 * noise-floor measurement. Used both as the C5 conformance axis executor and
 * as a standing diagnostic — the seat-bias sanity check that the +15%p seat
 * bias incident (DESIGN.md §1) made mandatory.
 */

import type { AnyBotFactory, AnyGameAdapter, PlayerId } from '../contract/types';
import {
  bootstrapPairedSeedBlocks,
  type BootstrapOptions,
  type BootstrapResult,
  type PairedSeedOutcome,
} from '../kernel/paired-stats';
import { runMatch } from './match';
import { runPairedBlock } from './paired-match';

export interface IdentityCalibration {
  /** Mean win rate across seating-plan permutations; should be ~0.5. */
  readonly meanWinRate: number;
  /** Win rate for each seatingPlan permutation, in spec.seatingPlan order. */
  readonly seatWinRates: readonly number[];
  /** max(seatWinRates) - min(seatWinRates): the seat-bias signal. */
  readonly bias: number;
  /**
   * Fraction of individual seed x seating matches whose winFraction landed
   * exactly on 0.5 (a tie). High values under identity self-play are the
   * runtime signature of paired signal collapse (docs/GAP-ANALYSIS-2.md X1):
   * seat mirroring cancels position bias, but for extreme first-move-wins
   * games it can cancel strategy signal along with it, so every paired block
   * converges on winFraction=0.5 and no statistic can tell candidates apart.
   * See also wave-runner.ts's per-tier `drawRate`, which is this same
   * quantity computed over paired blocks inside a wave.
   */
  readonly signalCollapseRate: number;
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

/**
 * Play the same bot (self-play) across every seed x seating permutation and
 * report the win rate per permutation plus their spread (bias). A well-formed
 * seatingPlan should average close to 0.5 overall.
 */
export function calibrateIdentity(
  adapter: AnyGameAdapter,
  botFactory: AnyBotFactory,
  seeds: readonly number[],
  botSeedBase: number,
): IdentityCalibration {
  const playerCount = adapter.spec.playerCount;
  const botFactories: AnyBotFactory[] = [];
  for (let i = 0; i < playerCount; i += 1) {
    botFactories.push(botFactory);
  }
  const botSeeds = botFactories.map((_, index) => botSeedBase + index);

  const seatingPlan = adapter.spec.seatingPlan;
  const winSums = seatingPlan.map(() => 0);
  const counts = seatingPlan.map(() => 0);
  let totalBlocks = 0;
  let collapsedBlocks = 0;

  for (const seed of seeds) {
    // Block = this seed's winFraction averaged across every seatingPlan
    // permutation — the same unit runPairedBlock/wave-runner's drawRate use,
    // so signalCollapseRate here is directly comparable to a wave's per-tier
    // drawRate (both ask "did mirroring cancel the signal to exactly 0.5?").
    let blockWinSum = 0;
    seatingPlan.forEach((seating, seatingIndex) => {
      const result = runMatch(adapter, botFactories, seed, botSeeds, seating);
      if (result.kind === 'defect') {
        throw new Error(
          `calibrateIdentity: defect at seed ${seed}, seating index ${seatingIndex}: ${result.defect.message}`,
        );
      }
      const candidatePlayer = seating[0];
      if (candidatePlayer === undefined) {
        throw new Error('calibrateIdentity: seating permutation is empty');
      }
      const isWinner = result.outcome.winners.includes(candidatePlayer as PlayerId);
      const winFraction = isWinner ? (result.outcome.winners.length > 1 ? 0.5 : 1) : 0;
      winSums[seatingIndex] = (winSums[seatingIndex] ?? 0) + winFraction;
      counts[seatingIndex] = (counts[seatingIndex] ?? 0) + 1;
      blockWinSum += winFraction;
    });
    totalBlocks += 1;
    const blockWinFraction = blockWinSum / seatingPlan.length;
    if (blockWinFraction === 0.5) {
      collapsedBlocks += 1;
    }
  }

  const seatWinRates = winSums.map((sum, index) => {
    const count = counts[index] ?? 0;
    return count > 0 ? sum / count : 0;
  });
  const meanWinRate = mean(seatWinRates);
  const bias = Math.max(...seatWinRates) - Math.min(...seatWinRates);
  const signalCollapseRate = totalBlocks > 0 ? collapsedBlocks / totalBlocks : 0;

  return { meanWinRate, seatWinRates, bias, signalCollapseRate };
}

export interface NoiseFloorResult extends BootstrapResult {
  /**
   * Sample standard deviation (n-1) of candidateWinFraction across the paired
   * seed blocks used for this bootstrap — the empirical noise-floor input
   * for `recommendBlockCount` (kernel/paired-stats.ts, docs/GAP-ANALYSIS-2.md
   * X3). Example:
   *
   *   const noise = measureNoiseFloor(adapter, bot, seeds, 1000, {
   *     iterations: 2000, confidenceLevel: 0.95, seed: 42,
   *   });
   *   const blocksNeeded = recommendBlockCount({
   *     blockStdDev: noise.blockStdDev,
   *     targetEffect: 0.03, // detect a +3%p win-rate shift
   *   });
   */
  readonly blockStdDev: number;
}

function sampleStdDev(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const avg = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Measure the statistical noise floor: run identity paired blocks (candidate
 * = opponent = botFactory) across `seeds` and bootstrap the resulting
 * win-fraction/score-delta distribution. The CI width this reports is the
 * bar any real effect must clear to be distinguishable from noise.
 */
export function measureNoiseFloor(
  adapter: AnyGameAdapter,
  botFactory: AnyBotFactory,
  seeds: readonly number[],
  botSeedBase: number,
  options: BootstrapOptions,
): NoiseFloorResult {
  const outcomes: PairedSeedOutcome[] = [];
  for (const seed of seeds) {
    const result = runPairedBlock(adapter, botFactory, botFactory, seed, botSeedBase);
    if ('defect' in result) {
      throw new Error(`measureNoiseFloor: defect at seed ${seed}: ${result.defect.message}`);
    }
    outcomes.push(result);
  }
  const bootstrap = bootstrapPairedSeedBlocks(outcomes, options);
  const blockStdDev = sampleStdDev(outcomes.map((outcome) => outcome.candidateWinFraction));
  return { ...bootstrap, blockStdDev };
}
