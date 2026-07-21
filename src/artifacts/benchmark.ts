/**
 * Benchmark anchor ladder (C5 / GAP-ANALYSIS.md): score a subject bot against
 * every frozen benchmark anchor via paired blocks, so progress across
 * comparabilityKey-incompatible baseline versions can still be read as
 * "how much better against the same frozen rungs" (INTERPRETATION.md §5).
 */

import type { AnyBotFactory, AnyGameAdapter } from '../contract/types';
import { bootstrapPairedSeedBlocks, type PairedSeedOutcome } from '../kernel/paired-stats';
import type { BaselineRegistry, BenchmarkAnchor } from './baseline-registry';
import { runPairedBlock } from '../loop/paired-match';

export interface LadderSeedBank {
  readonly seeds: readonly number[];
  readonly botSeedBase: number;
}

export interface LadderRungResult {
  readonly anchorId: string;
  readonly anchorKind: BenchmarkAnchor['kind'];
  readonly pointWinRate: number;
  readonly pointScoreDiff: number;
  readonly winRateCI: { readonly lower: number; readonly upper: number };
  readonly blocks: number;
}

export interface LadderResult {
  readonly rungs: readonly LadderRungResult[];
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

/**
 * Run `subject` as the candidate in a paired block against every anchor
 * registered in `registry`, in registration order. Throws if any match
 * defects (a defect is a harness/adapter bug, not a benchmark data point).
 */
export function runBenchmarkLadder(
  adapter: AnyGameAdapter,
  subject: AnyBotFactory,
  anchors: readonly BenchmarkAnchor[],
  registry: BaselineRegistry,
  bank: LadderSeedBank,
): LadderResult {
  const rungs: LadderRungResult[] = anchors.map((anchor) => {
    const anchorFactory = registry.resolveAnchor(adapter, anchor.anchorId);
    const outcomes: PairedSeedOutcome[] = [];
    for (const seed of bank.seeds) {
      const result = runPairedBlock(adapter, subject, anchorFactory, seed, bank.botSeedBase);
      if ('defect' in result) {
        throw new Error(
          `runBenchmarkLadder: defect vs anchor "${anchor.anchorId}" at seed ${seed}: ${result.defect.message}`,
        );
      }
      outcomes.push(result);
    }
    const bootstrap = bootstrapPairedSeedBlocks(outcomes, {
      iterations: 2000,
      confidenceLevel: 0.95,
      seed: hashSeedFor(anchor.anchorId),
    });
    return {
      anchorId: anchor.anchorId,
      anchorKind: anchor.kind,
      pointWinRate: mean(outcomes.map((o) => o.candidateWinFraction)),
      pointScoreDiff: mean(outcomes.map((o) => o.candidateScoreDelta)),
      winRateCI: { lower: bootstrap.winRate.lower, upper: bootstrap.winRate.upper },
      blocks: outcomes.length,
    };
  });
  return { rungs };
}

function hashSeedFor(label: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function renderLadderMarkdown(result: LadderResult): string {
  const lines = ['# Benchmark Ladder', '', '| anchor | kind | winRate | winRate CI | scoreDiff | blocks |', '|---|---|---|---|---|---|'];
  for (const rung of result.rungs) {
    lines.push(
      `| ${rung.anchorId} | ${rung.anchorKind} | ${(rung.pointWinRate * 100).toFixed(1)}% | [${(rung.winRateCI.lower * 100).toFixed(1)}%, ${(rung.winRateCI.upper * 100).toFixed(1)}%] | ${rung.pointScoreDiff.toFixed(3)} | ${rung.blocks} |`,
    );
  }
  return lines.join('\n') + '\n';
}
