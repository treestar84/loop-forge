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

/** Find the team (a set of PlayerIds) containing `player`, or null when the
 * game has no team declaration or the player is not in any declared team. */
function teamOf(
  teams: AnyGameAdapter['spec']['teams'],
  player: PlayerId,
): readonly PlayerId[] | null {
  if (!teams) {
    return null;
  }
  return teams.find((team) => team.includes(player)) ?? null;
}

export function runPairedBlock(
  adapter: AnyGameAdapter,
  candidate: AnyBotFactory,
  /**
   * A single factory fills every non-candidate seat (pre-M4 behavior,
   * unchanged). An array (docs/GAP-ANALYSIS-10.md M4: field mix) supplies one
   * factory per non-candidate seat individually — its length must equal
   * `playerCount - 1`.
   */
  opponent: AnyBotFactory | readonly AnyBotFactory[],
  gameSeed: number,
  botSeedBase: number,
): PairedMatchResult {
  const playerCount = adapter.spec.playerCount;
  const opponents = Array.isArray(opponent) ? opponent : null;
  if (opponents && opponents.length !== playerCount - 1) {
    throw new Error(
      `runPairedBlock: opponent array length (${opponents.length}) must equal playerCount - 1 (${playerCount - 1})`,
    );
  }
  const botFactories: AnyBotFactory[] = [candidate];
  for (let i = 1; i < playerCount; i += 1) {
    botFactories.push(opponents ? (opponents[i - 1] as AnyBotFactory) : (opponent as AnyBotFactory));
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
    const candidateTeam = teamOf(adapter.spec.teams, candidatePlayer as PlayerId);

    let winFraction: number;
    let scoreDelta: number;

    if (candidateTeam) {
      // B3: team-aware statistics. winFraction: 1 when every winner is a
      // candidate teammate, 0.5 when the winner set is mixed (candidate's
      // team + non-teammates), 0 when the candidate's team did not win at
      // all. scoreDelta: candidate team's mean score minus the mean of every
      // other team's players (never the candidate's own teammates).
      const winners = result.outcome.winners;
      const candidateTeamWon = winners.some((winner) => candidateTeam.includes(winner));
      const allWinnersAreTeammates =
        winners.length > 0 && winners.every((winner) => candidateTeam.includes(winner));
      winFraction = allWinnersAreTeammates ? 1 : candidateTeamWon ? 0.5 : 0;

      const teammateScores = candidateTeam.map((player) => {
        const score = result.outcome.scores[player];
        if (score === undefined) {
          throw new Error(`runPairedBlock: outcome.scores has no entry for player ${player}`);
        }
        return score;
      });
      const opponentScores = result.outcome.scores.filter(
        (_, index) => !candidateTeam.includes(index as PlayerId),
      );
      const opponentMean = opponentScores.length > 0 ? mean(opponentScores) : 0;
      scoreDelta = mean(teammateScores) - opponentMean;
    } else {
      const opponentScores = result.outcome.scores.filter(
        (_, index) => index !== candidatePlayer,
      );
      const opponentMean = opponentScores.length > 0 ? mean(opponentScores) : 0;

      const isWinner = result.outcome.winners.includes(candidatePlayer as PlayerId);
      winFraction = isWinner ? (result.outcome.winners.length > 1 ? 0.5 : 1) : 0;
      scoreDelta = candidateScore - opponentMean;
    }

    winSum += winFraction;
    scoreSum += scoreDelta;
  }

  const n = seatingPlan.length;
  return {
    seed: gameSeed,
    candidateWinFraction: winSum / n,
    candidateScoreDelta: scoreSum / n,
  };
}
