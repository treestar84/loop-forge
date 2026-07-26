/**
 * Calibration diagnostics: identity self-play (same bot in every seat) and
 * noise-floor measurement. Used both as the C5 conformance axis executor and
 * as a standing diagnostic — the seat-bias sanity check that the +15%p seat
 * bias incident (DESIGN.md §1) made mandatory.
 */

import type { AnyBotFactory, AnyGameAdapter, PlayerId } from '../contract/types';
import { createRng } from '../kernel/rng';
import {
  bootstrapPairedSeedBlocks,
  type BootstrapOptions,
  type BootstrapResult,
  type PairedSeedOutcome,
} from '../kernel/paired-stats';
import { runMatch } from './match';
import { runPairedBlock } from './paired-match';

/**
 * Upper bound (exclusive) for per-seed bot seeds derived from a forked RNG
 * stream — comfortably inside Number.isSafeInteger while giving each
 * gameSeed x seat combination an effectively independent draw.
 */
const BOT_SEED_SPACE = 2 ** 31;

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

  // Each gameSeed gets its own bot-seed stream, forked off botSeedBase by the
  // seed label. Reusing one fixed pair of bot seeds across every gameSeed
  // (the pre-fix behavior) lets a long-decision-count game's RNG sequence
  // freeze into a persistent, compounding bias per seat that never averages
  // out no matter how many seeds are sampled — see docs/FIX-BACKLOG.md Z2.
  const rootRng = createRng(botSeedBase);

  const seatingPlan = adapter.spec.seatingPlan;
  const winSums = seatingPlan.map(() => 0);
  const counts = seatingPlan.map(() => 0);
  let totalBlocks = 0;
  let collapsedBlocks = 0;

  for (const seed of seeds) {
    const seedRng = rootRng.fork(String(seed));
    const botSeeds = botFactories.map(() => seedRng.nextInt(BOT_SEED_SPACE));

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

/**
 * Lightweight self-play pass (docs/FIX-BACKLOG.md G2, docs/GAP-ANALYSIS-9.md
 * §2): walks one game per seed, tallying `getLegalChoices(state).length` at
 * every decision, and returns the mean — the branching-factor signal
 * `kernel/search-blueprint.ts`'s `deriveSearchBlueprint` uses to decide
 * whether a depth-2 tactical precheck (O(legal^2) per decision) stays cheap
 * enough to recommend.
 *
 * Implemented as a separate, independent walk rather than folded into
 * `runMatch`/`runPairedBlock` (which `measureNoiseFloor` below already
 * drives): both of those are shared by every other loop/artifacts consumer,
 * and widening their return shape to carry a legal-choice tally would be a
 * much larger surface to keep in sync than one small extra self-play pass
 * here. The cost is exactly what it looks like — one additional full
 * self-play walk per seed, on top of whatever else the caller already runs
 * over the same seeds.
 */
export function measureAverageLegalChoiceCount(
  adapter: AnyGameAdapter,
  botFactory: AnyBotFactory,
  seeds: readonly number[],
  botSeedBase: number,
): number {
  const seating = adapter.spec.seatingPlan[0];
  if (seating === undefined) {
    throw new Error('measureAverageLegalChoiceCount: spec.seatingPlan is empty');
  }
  const seatToBotIndex = new Map<number, number>();
  seating.forEach((seat, botIndex) => seatToBotIndex.set(seat, botIndex));

  const rootRng = createRng(botSeedBase);
  let totalChoices = 0;
  let totalDecisions = 0;

  for (const seed of seeds) {
    const seedRng = rootRng.fork(String(seed));
    const bots = seating.map(() => botFactory(seedRng.nextInt(BOT_SEED_SPACE)));

    let state = adapter.createInitialState(seed);
    let decisions = 0;
    for (;;) {
      const decision = adapter.currentDecision(state);
      if (decision === null) {
        break;
      }
      decisions += 1;
      if (decisions > adapter.spec.maxDecisionsPerGame) {
        throw new Error(
          `measureAverageLegalChoiceCount: exceeded maxDecisionsPerGame (${adapter.spec.maxDecisionsPerGame}) at seed ${seed}`,
        );
      }
      const legal = adapter.getLegalChoices(state);
      totalChoices += legal.length;
      totalDecisions += 1;

      const botIndex = seatToBotIndex.get(decision.player);
      if (botIndex === undefined) {
        throw new Error(`measureAverageLegalChoiceCount: seating does not cover player ${decision.player}`);
      }
      const bot = bots[botIndex];
      if (!bot) {
        throw new Error(`measureAverageLegalChoiceCount: no bot at index ${botIndex}`);
      }
      const observation = adapter.getObservation(state, decision.player);
      const choice = bot.decide(decision.decisionPoint, observation, legal);
      state = adapter.applyChoice(state, choice);
    }
  }

  return totalDecisions > 0 ? totalChoices / totalDecisions : 0;
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
  /**
   * Sample standard deviation (n-1) of `candidateScoreDelta` across the same
   * identity paired-seed blocks — the noise-floor input for deriving a
   * game-specific `minScoreDiff` gate threshold (docs/FIX-BACKLOG.md P6):
   * a fixed threshold like the DEFAULT_CRITERIA's 5 has no relationship to
   * a given game's score scale or its identity-self-play noise, so it can
   * reject candidates whose score-diff margin is real but small relative to
   * a larger-scoring game's noise. See kernel/blueprint.ts's
   * `recommendedMinScoreDiff` for how this value is turned into a threshold.
   */
  readonly scoreDiffStdDev: number;
  /**
   * Mean `getLegalChoices(state).length` across the same self-play seeds
   * (docs/FIX-BACKLOG.md G2), via `measureAverageLegalChoiceCount` above —
   * the branching-factor input `kernel/search-blueprint.ts`'s
   * `deriveSearchBlueprint` uses for its `tacticalPrecheckDepth` recommendation.
   */
  readonly averageLegalChoiceCount: number;
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
  // Same per-seed bot-seed forking as calibrateIdentity (docs/FIX-BACKLOG.md
  // Z2): a fixed botSeedBase reused across every seed lets a long game's RNG
  // sequence lock into a persistent bias, inflating the measured noise floor
  // instead of reporting the true seed-to-seed spread.
  const rootRng = createRng(botSeedBase);
  const outcomes: PairedSeedOutcome[] = [];
  for (const seed of seeds) {
    const seedBotSeedBase = rootRng.fork(String(seed)).nextInt(BOT_SEED_SPACE);
    const result = runPairedBlock(adapter, botFactory, botFactory, seed, seedBotSeedBase);
    if ('defect' in result) {
      throw new Error(`measureNoiseFloor: defect at seed ${seed}: ${result.defect.message}`);
    }
    outcomes.push(result);
  }
  const bootstrap = bootstrapPairedSeedBlocks(outcomes, options);
  const blockStdDev = sampleStdDev(outcomes.map((outcome) => outcome.candidateWinFraction));
  const scoreDiffStdDev = sampleStdDev(outcomes.map((outcome) => outcome.candidateScoreDelta));
  const averageLegalChoiceCount = measureAverageLegalChoiceCount(adapter, botFactory, seeds, botSeedBase);
  return { ...bootstrap, blockStdDev, scoreDiffStdDev, averageLegalChoiceCount };
}
