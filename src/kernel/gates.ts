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
  if (passed.has('smoke')) {
    return 'screened';
  }
  if (lastStats.pointWinRate >= criteria.minWinRate && lastStats.pointScoreDiff < criteria.minScoreDiff) {
    return 'near-miss';
  }
  return 'failed';
}
