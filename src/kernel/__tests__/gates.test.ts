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
