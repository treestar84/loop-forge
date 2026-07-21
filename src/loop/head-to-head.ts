/**
 * Gate-free head-to-head: run candidate vs opponent across a fixed seed list
 * and report the raw win rate/CI, no screen/smoke/prune/holdout gating. For
 * "just tell me the win rate" comparisons (docs/BENCHMARK-EXPERIMENT.md)
 * where the statistical-gate machinery in wave-runner.ts/calibrate.ts is
 * unwanted overhead.
 */

import type { AnyBotFactory, AnyGameAdapter } from '../contract/types';
import { createRng } from '../kernel/rng';
import {
  bootstrapPairedSeedBlocks,
  type PairedSeedOutcome,
} from '../kernel/paired-stats';
import { runPairedBlock } from './paired-match';

/**
 * Upper bound (exclusive) for per-seed bot seeds derived from a forked RNG
 * stream — same convention as loop/calibrate.ts's BOT_SEED_SPACE.
 */
const BOT_SEED_SPACE = 2 ** 31;

const BOOTSTRAP_ITERATIONS = 2000;
const BOOTSTRAP_CONFIDENCE_LEVEL = 0.95;

export interface HeadToHeadResult {
  readonly blocks: number;
  readonly candidateWinRate: number;
  readonly candidateScoreDelta: number;
  readonly drawRate: number;
  readonly winRateCI: { readonly lower: number; readonly upper: number };
}

/**
 * Run candidate vs opponent across every seed, deriving each seed's bot
 * seeds from botSeedBase via rng.fork(String(seed)) (loop/calibrate.ts's
 * Z2 fix — a fixed bot-seed pair reused across seeds lets a long game's RNG
 * sequence lock into a persistent per-seed bias). Blocks whose match run
 * defects are skipped, not thrown — the run continues over the remaining
 * seeds, unless every seed defects, in which case skipping silently would
 * hide total failure.
 */
export function runHeadToHead(
  adapter: AnyGameAdapter,
  candidate: AnyBotFactory,
  opponent: AnyBotFactory,
  seeds: readonly number[],
  botSeedBase: number,
): HeadToHeadResult {
  if (seeds.length === 0) {
    throw new Error('runHeadToHead: seeds must be non-empty');
  }

  const rootRng = createRng(botSeedBase);
  const outcomes: PairedSeedOutcome[] = [];
  let skipped = 0;

  for (const seed of seeds) {
    const seedBotSeedBase = rootRng.fork(String(seed)).nextInt(BOT_SEED_SPACE);
    const result = runPairedBlock(adapter, candidate, opponent, seed, seedBotSeedBase);
    if ('defect' in result) {
      skipped += 1;
      continue;
    }
    outcomes.push(result);
  }

  if (outcomes.length === 0) {
    throw new Error(
      `runHeadToHead: every block defected (${skipped}/${seeds.length} seeds skipped)`,
    );
  }

  const bootstrap = bootstrapPairedSeedBlocks(outcomes, {
    iterations: BOOTSTRAP_ITERATIONS,
    confidenceLevel: BOOTSTRAP_CONFIDENCE_LEVEL,
    seed: botSeedBase,
  });

  const draws = outcomes.filter((outcome) => outcome.candidateWinFraction === 0.5).length;

  return {
    blocks: outcomes.length,
    candidateWinRate: bootstrap.pointWinRate,
    candidateScoreDelta: bootstrap.pointScoreDiff,
    drawRate: draws / outcomes.length,
    winRateCI: bootstrap.winRate,
  };
}
