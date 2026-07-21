/**
 * Multi-tier promotion gate: pure judging logic over already-computed
 * statistics. Does not run games. Per DESIGN.md §5: smoke passing alone is
 * not adoption — only holdout passing promotes a candidate into the baseline.
 */

export type TierId = 'screen' | 'smoke' | 'prune' | 'holdout' | 'graduation';

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
