/**
 * Multi-tier promotion gate: pure judging logic over already-computed
 * statistics. Does not run games. Per DESIGN.md §5: smoke passing alone is
 * not adoption — only holdout passing promotes a candidate into the baseline.
 */

export type TierId = 'screen' | 'smoke' | 'prune' | 'holdout' | 'regression' | 'graduation';

export const TIER_ORDER: readonly TierId[] = [
  'screen',
  'smoke',
  'prune',
  'holdout',
  'graduation',
];

export interface PromotionCriteria {
  readonly minWinRate: number;
  readonly minScoreDiff: number;
  /**
   * Pass threshold for the 'regression' tier (docs/GAP-ANALYSIS-7.md O10):
   * paired win rate of the candidate against the current baseline composite
   * bot (not the raw heuristic opponent every other tier faces). Defaults to
   * 0.5 when unset.
   */
  readonly regressionMinWinRate?: number;
}

export const DEFAULT_CRITERIA: PromotionCriteria = {
  minWinRate: 0.53,
  // minScoreDiff=5 is an uncalibrated cross-game fallback, not a
  // game-specific threshold — it has no relationship to any one game's
  // score scale or identity-self-play noise floor (docs/FIX-BACKLOG.md P6:
  // 3 hidden-info games in a row had winRate 0.90-1.00 candidates screened
  // out purely on this fixed number). The game-calibrated threshold is
  // `deriveBlueprint(...).recommendedMinScoreDiff` (kernel/blueprint.ts) —
  // callers should prefer that over this default whenever calibration data
  // (measureNoiseFloor's scoreDiffStdDev) is available.
  minScoreDiff: 5,
};

export interface TierStats {
  readonly pointWinRate: number;
  readonly pointScoreDiff: number;
}

export type TierJudgement = 'pass' | 'fail';

export function judgeTier(
  _tier: TierId,
  stats: TierStats,
  criteria: PromotionCriteria,
): TierJudgement {
  if (_tier === 'regression') {
    // 0.5 is the meaningful default here: a candidate exactly on par with
    // the champion (paired winRate 0.5) is a lateral swap, not a
    // regression, so it still passes. Only a candidate that is actually
    // *worse* than the current baseline composite bot should fail this
    // tier.
    return stats.pointWinRate >= (criteria.regressionMinWinRate ?? 0.5) ? 'pass' : 'fail';
  }
  if (stats.pointWinRate >= criteria.minWinRate && stats.pointScoreDiff >= criteria.minScoreDiff) {
    return 'pass';
  }
  return 'fail';
}

export type FinalVerdict = 'adopted' | 'screened' | 'near-miss' | 'failed';

export function finalVerdict(
  passedTiers: readonly TierId[],
  lastStats: TierStats,
  criteria: PromotionCriteria,
): FinalVerdict {
  const passed = new Set(passedTiers);

  if (passed.has('holdout')) {
    return 'adopted';
  }

  // P6 (docs/FIX-BACKLOG.md, docs/GAP-ANALYSIS-8.md §2): a candidate that
  // passed smoke — so it is behaviorally distinct AND already cleared the
  // win-rate/score-diff bar once under SPRT — but then fails a later fixed
  // tier (prune/holdout) purely on scoreDiff while still meeting minWinRate
  // is a near-miss, not a plain "screened". This is checked BEFORE the
  // smoke-passed screened fallback below, and does not relax the AND gate
  // itself: judgeTier still requires both winRate and scoreDiff to pass a
  // tier. Only the *label* on this particular failure mode changes, so the
  // scoreDiff-only shortfall surfaces to extractNearMissCandidates instead
  // of being indistinguishable from every other kind of screened failure.
  const isScoreDiffOnlyShortfall =
    lastStats.pointWinRate >= criteria.minWinRate && lastStats.pointScoreDiff < criteria.minScoreDiff;
  if (passed.has('smoke') && isScoreDiffOnlyShortfall) {
    return 'near-miss';
  }
  if (passed.has('smoke')) {
    return 'screened';
  }
  if (isScoreDiffOnlyShortfall) {
    return 'near-miss';
  }
  return 'failed';
}
