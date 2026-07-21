/**
 * Paired match block: runs one game seed across every seat permutation in
 * spec.seatingPlan (candidate always occupies seat index 0's bot slot), then
 * averages the per-permutation win fraction and score delta. Averaging over
 * the full seating plan for a single shared game seed is what cancels
 * position bias into a single PairedSeedOutcome (DESIGN.md §5/§6).
 */

import type { AnyBotFactory, AnyGameAdapter, PlayerId } from '../contract/types';
import type { PairedSeedOutcome } from '../kernel/paired-stats';
import { runMatch, type MatchDefect } from './match';

export type PairedMatchResult = PairedSeedOutcome | { readonly defect: MatchDefect };

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

export function runPairedBlock(
  adapter: AnyGameAdapter,
  candidate: AnyBotFactory,
  opponent: AnyBotFactory,
  gameSeed: number,
  botSeedBase: number,
): PairedMatchResult {
  const playerCount = adapter.spec.playerCount;
  const botFactories: AnyBotFactory[] = [candidate];
  for (let i = 1; i < playerCount; i += 1) {
    botFactories.push(opponent);
  }
  const botSeeds = botFactories.map((_, index) => botSeedBase + index);

  const seatingPlan = adapter.spec.seatingPlan;
  let winSum = 0;
  let scoreSum = 0;

  for (const seating of seatingPlan) {
    const result = runMatch(adapter, botFactories, gameSeed, botSeeds, seating);
    if (result.kind === 'defect') {
      return { defect: result.defect };
    }

    const candidatePlayer = seating[0];
    if (candidatePlayer === undefined) {
      throw new Error('runPairedBlock: seating permutation is empty');
    }
    const candidateScore = result.outcome.scores[candidatePlayer];
    if (candidateScore === undefined) {
      throw new Error(
        `runPairedBlock: outcome.scores has no entry for player ${candidatePlayer}`,
      );
    }
    const opponentScores = result.outcome.scores.filter(
      (_, index) => index !== candidatePlayer,
    );
    const opponentMean = opponentScores.length > 0 ? mean(opponentScores) : 0;

    const isWinner = result.outcome.winners.includes(candidatePlayer as PlayerId);
    const winFraction = isWinner ? (result.outcome.winners.length > 1 ? 0.5 : 1) : 0;

    winSum += winFraction;
    scoreSum += candidateScore - opponentMean;
  }

  const n = seatingPlan.length;
  return {
    seed: gameSeed,
    candidateWinFraction: winSum / n,
    candidateScoreDelta: scoreSum / n,
  };
}
