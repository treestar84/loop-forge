/**
 * Loss mining (docs/GAP-ANALYSIS-11.md D4, stage 2): replay a candidate's
 * lost games and ask an anchor bot what it would have done at each of the
 * candidate's own decision points, surfacing the exact ply where the two
 * diverge. Game-neutral — only encodeChoice/applyChoice/getObservation/
 * getLegalChoices/currentDecision are used, so this works for any adapter.
 *
 * Determinism note: replay starts from adapter.createInitialState(gameSeed)
 * and applies the recorded choices verbatim, exactly reproducing the
 * original match (paired-match.ts's MatchTrajectoryRecord doc comment).
 * counterfactual replay — substituting the anchor's choice back into the
 * game to see how the *outcome* would have changed — is out of scope here
 * and left for a v2 (docs/GAP-ANALYSIS-11.md D4 §3 stage 2 only asks for
 * divergence detection, not outcome counterfactuals).
 *
 * Per-decision anchor derivation (GAP-11 Phase 1-E finding): the anchor bot
 * queried at a given decisionIndex is rebuilt fresh from a seed forked on
 * `${gameSeed}:${decisionIndex}` (loop/calibrate.ts's Z2 convention extended
 * to decision granularity), rather than built once per game and reused
 * across every decision. A single per-game anchor instance would carry
 * internal RNG state (used for e.g. tie-breaking) forward across decisions,
 * so its choice at decisionIndex i would depend on how many prior ties it
 * had already resolved earlier in that same game — a probe bank built from
 * such a report could then never be replayed in isolation (probe-bank.ts's
 * scoreAgainstProbes only replays a *prefix* to reach one decision, it does
 * not re-simulate the anchor's entire decision history up to that point).
 * Deriving the anchor per (gameSeed, decisionIndex) instead makes each
 * decision's anchor choice reproducible standalone: mining and probe
 * scoring must share this exact derivation (same root seed, same fork key
 * format) for scoreAgainstProbes to ever measure the anchor's own
 * agreement rate at 1.0 (docs/GAP-ANALYSIS-11.md Phase 1-E).
 */

import type { AnyBotFactory, AnyGameAdapter } from '../contract/types';
import { createRng } from '../kernel/rng';
import type { MatchTrajectoryRecord } from './paired-match';

/** Same convention as loop/calibrate.ts's/head-to-head.ts's BOT_SEED_SPACE. */
const BOT_SEED_SPACE = 2 ** 31;

export interface LossDivergence {
  readonly gameSeed: number;
  /** Index into the record's choices/deciders arrays where the divergence occurred. */
  readonly decisionIndex: number;
  readonly decisionPointId: string;
  readonly candidateChoiceKey: string;
  readonly anchorChoiceKey: string;
}

export interface LossReport {
  readonly totalGames: number;
  readonly candidateLosses: number;
  readonly divergences: readonly LossDivergence[];
  readonly mismatchRateByDecisionPoint: Readonly<
    Record<string, { readonly decisions: number; readonly mismatches: number }>
  >;
  /** Bucketed (width 10) distribution of each lost game's first divergence
   * decisionIndex, e.g. key "0-9" for decisionIndex in [0, 9]. Games with no
   * divergence (candidate always agreed with the anchor, or the game
   * defected mid-replay) are not counted here. */
  readonly firstDivergenceDepthHistogram: Readonly<Record<string, number>>;
}

function depthBucket(decisionIndex: number): string {
  const bucketStart = Math.floor(decisionIndex / 10) * 10;
  return `${bucketStart}-${bucketStart + 9}`;
}

function isCandidateLoss(record: MatchTrajectoryRecord): boolean {
  return record.outcome.winner !== null && record.outcome.winner !== record.candidateSeat;
}

/**
 * Mine divergences between the candidate's actual choices and what
 * `anchorFactory` would have chosen at the same decision points, over every
 * *lost* game in `records` (winning/drawing games are skipped entirely —
 * they carry no loss signal). Replay is deterministic: the anchor bot
 * queried at each candidate decision is rebuilt from a seed derived from
 * `options.anchorSeedBase` forked by `${gameSeed}:${decisionIndex}` (see the
 * file doc comment's "per-decision anchor derivation" note), so re-running
 * with the same inputs reproduces an identical LossReport.
 *
 * A game whose replay hits an illegal/unencodable recorded choice or an
 * unexpected early terminal state is skipped (counted in totalGames/
 * candidateLosses only, contributing no divergences) rather than thrown —
 * archived trajectories are trusted data, but replay is still defensive
 * against a future encodeChoice change silently breaking comparability.
 */
export function mineLosses(
  adapter: AnyGameAdapter,
  records: readonly MatchTrajectoryRecord[],
  anchorFactory: AnyBotFactory,
  options: { readonly anchorSeedBase: number; readonly maxDivergencesPerGame?: number },
): LossReport {
  const maxDivergencesPerGame = options.maxDivergencesPerGame ?? Infinity;
  const rootRng = createRng(options.anchorSeedBase);

  const divergences: LossDivergence[] = [];
  const mismatchRateByDecisionPoint: Record<
    string,
    { decisions: number; mismatches: number }
  > = {};
  const firstDivergenceDepthHistogram: Record<string, number> = {};

  let candidateLosses = 0;

  for (const record of records) {
    if (!isCandidateLoss(record)) {
      continue;
    }
    candidateLosses += 1;

    let state = adapter.createInitialState(record.gameSeed);
    let recordDivergences = 0;
    let firstDivergenceDepth: number | null = null;

    for (let decisionIndex = 0; decisionIndex < record.choices.length; decisionIndex += 1) {
      const decision = adapter.currentDecision(state);
      if (!decision) {
        // Recorded a choice past what this replay considers the game's end —
        // trust breakdown between record and adapter; skip the rest.
        break;
      }
      const legal = adapter.getLegalChoices(state);
      if (legal.length === 0) {
        break;
      }

      const candidateChoiceKey = record.choices[decisionIndex] as string;
      const decider = record.deciders[decisionIndex];

      if (decider === record.candidateSeat) {
        const anchorSeed = rootRng
          .fork(`${record.gameSeed}:${decisionIndex}`)
          .nextInt(BOT_SEED_SPACE);
        const anchor = anchorFactory(anchorSeed);
        const observation = adapter.getObservation(state, decision.player);
        let anchorChoice: unknown;
        try {
          anchorChoice = anchor.decide(decision.decisionPoint, observation, legal);
        } catch {
          break;
        }
        const anchorChoiceKey = adapter.encodeChoice(anchorChoice);

        const dpId = decision.decisionPoint;
        const dpStats = mismatchRateByDecisionPoint[dpId] ?? { decisions: 0, mismatches: 0 };
        const decisions = dpStats.decisions + 1;
        const mismatches = dpStats.mismatches + (anchorChoiceKey !== candidateChoiceKey ? 1 : 0);
        mismatchRateByDecisionPoint[dpId] = { decisions, mismatches };

        if (anchorChoiceKey !== candidateChoiceKey) {
          if (firstDivergenceDepth === null) {
            firstDivergenceDepth = decisionIndex;
          }
          if (recordDivergences < maxDivergencesPerGame) {
            divergences.push({
              gameSeed: record.gameSeed,
              decisionIndex,
              decisionPointId: dpId,
              candidateChoiceKey,
              anchorChoiceKey,
            });
            recordDivergences += 1;
          }
        }
      }

      const matched = legal.find(
        (candidate) => adapter.encodeChoice(candidate) === candidateChoiceKey,
      );
      if (matched === undefined) {
        break;
      }
      state = adapter.applyChoice(state, matched);
    }

    if (firstDivergenceDepth !== null) {
      const bucket = depthBucket(firstDivergenceDepth);
      firstDivergenceDepthHistogram[bucket] = (firstDivergenceDepthHistogram[bucket] ?? 0) + 1;
    }
  }

  return {
    totalGames: records.length,
    candidateLosses,
    divergences,
    mismatchRateByDecisionPoint,
    firstDivergenceDepthHistogram,
  };
}
