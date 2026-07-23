import {
  DEFAULT_CRITERIA,
  TIER_ORDER,
  finalVerdict,
  judgeTier,
  type TierStats,
} from '../gates';

describe('TIER_ORDER', () => {
  it('is the documented pipeline order', () => {
    expect(TIER_ORDER).toEqual(['screen', 'smoke', 'prune', 'holdout', 'graduation']);
  });
});

describe('judgeTier', () => {
  it('passes when both win rate and score diff meet criteria', () => {
    const stats: TierStats = { pointWinRate: 0.6, pointScoreDiff: 10 };
    expect(judgeTier('smoke', stats, DEFAULT_CRITERIA)).toBe('pass');
  });

  it('passes exactly at the boundary', () => {
    const stats: TierStats = { pointWinRate: 0.53, pointScoreDiff: 5 };
    expect(judgeTier('smoke', stats, DEFAULT_CRITERIA)).toBe('pass');
  });

  it('fails just below the win rate boundary', () => {
    const stats: TierStats = { pointWinRate: 0.5299, pointScoreDiff: 10 };
    expect(judgeTier('smoke', stats, DEFAULT_CRITERIA)).toBe('fail');
  });

  it('fails just below the score diff boundary', () => {
    const stats: TierStats = { pointWinRate: 0.6, pointScoreDiff: 4.99 };
    expect(judgeTier('smoke', stats, DEFAULT_CRITERIA)).toBe('fail');
  });
});

// O10 (docs/GAP-ANALYSIS-7.md): regression tier judging ignores scoreDiff
// entirely and uses its own, looser default threshold (0.5) — a candidate
// exactly on par with the current baseline is a lateral swap, not a
// regression.
describe('judgeTier(\'regression\', ...)', () => {
  it('passes when winRate is above the default 0.5 threshold, regardless of scoreDiff', () => {
    const stats: TierStats = { pointWinRate: 0.6, pointScoreDiff: -100 };
    expect(judgeTier('regression', stats, DEFAULT_CRITERIA)).toBe('pass');
  });

  it('passes exactly at winRate 0.5 (candidate on par with the champion is not a regression)', () => {
    const stats: TierStats = { pointWinRate: 0.5, pointScoreDiff: 0 };
    expect(judgeTier('regression', stats, DEFAULT_CRITERIA)).toBe('pass');
  });

  it('fails below winRate 0.5 (candidate is weaker than the current baseline)', () => {
    const stats: TierStats = { pointWinRate: 0.4999, pointScoreDiff: 100 };
    expect(judgeTier('regression', stats, DEFAULT_CRITERIA)).toBe('fail');
  });

  it('honors an explicit regressionMinWinRate override', () => {
    const stats: TierStats = { pointWinRate: 0.55, pointScoreDiff: 0 };
    expect(judgeTier('regression', stats, { ...DEFAULT_CRITERIA, regressionMinWinRate: 0.6 })).toBe(
      'fail',
    );
    expect(judgeTier('regression', stats, { ...DEFAULT_CRITERIA, regressionMinWinRate: 0.5 })).toBe(
      'pass',
    );
  });
});

describe('finalVerdict', () => {
  it('adopted when holdout passed', () => {
    const stats: TierStats = { pointWinRate: 0.6, pointScoreDiff: 10 };
    expect(finalVerdict(['screen', 'smoke', 'prune', 'holdout'], stats, DEFAULT_CRITERIA)).toBe(
      'adopted',
    );
  });

  it('screened when only smoke passed (smoke alone is not adoption)', () => {
    const stats: TierStats = { pointWinRate: 0.6, pointScoreDiff: 10 };
    expect(finalVerdict(['screen', 'smoke'], stats, DEFAULT_CRITERIA)).toBe('screened');
  });

  it('near-miss when win rate clears the bar but score diff falls short', () => {
    const stats: TierStats = { pointWinRate: 0.55, pointScoreDiff: 1 };
    expect(finalVerdict(['screen'], stats, DEFAULT_CRITERIA)).toBe('near-miss');
  });

  it('failed when neither passed nor near-miss', () => {
    const stats: TierStats = { pointWinRate: 0.45, pointScoreDiff: -3 };
    expect(finalVerdict(['screen'], stats, DEFAULT_CRITERIA)).toBe('failed');
  });

  it('failed when no tiers passed at all, even without stats support', () => {
    const stats: TierStats = { pointWinRate: 0.3, pointScoreDiff: -10 };
    expect(finalVerdict([], stats, DEFAULT_CRITERIA)).toBe('failed');
  });
});
