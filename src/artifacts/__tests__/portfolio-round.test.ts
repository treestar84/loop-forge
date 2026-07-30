/**
 * Pure-logic tests for the portfolio round executor (docs/GAP-ANALYSIS-12.md
 * E1). Deliberately exercises only the exported pure helpers
 * (`selectAdvancingFlags`, `buildPromotionPool`) plus `computeBucketOutcomes`
 * via `runPortfolioRound`'s own module — none of these run a single game, so
 * this file stays fast (GAP-12 §0.4's test-time budget). The full
 * probe-filter -> wave -> challenge -> promotion pipeline is exercised
 * end-to-end (with real games) only by the gomoku/dominion round runner
 * scripts under reference/runners/, not here.
 */

import { selectAdvancingFlags, buildPromotionPool, computeBucketOutcomes, type ChallengeTable } from '../portfolio-round';
import { BUCKET_ORDER } from '../portfolio';

describe('selectAdvancingFlags', () => {
  it('advances the top K by agreement rate descending', () => {
    const rows = [
      { flag: 'a', agreementRate: 0.9, msPerGame: 10 },
      { flag: 'b', agreementRate: 0.95, msPerGame: 10 },
      { flag: 'c', agreementRate: 0.5, msPerGame: 10 },
      { flag: 'd', agreementRate: 0.8, msPerGame: 10 },
    ];
    expect(selectAdvancingFlags(rows, 2)).toEqual(new Set(['b', 'a']));
  });

  it('breaks agreement-rate ties by the cheaper msPerGame', () => {
    const rows = [
      { flag: 'expensive', agreementRate: 0.9, msPerGame: 500 },
      { flag: 'cheap', agreementRate: 0.9, msPerGame: 50 },
    ];
    expect(selectAdvancingFlags(rows, 1)).toEqual(new Set(['cheap']));
  });

  it('advances everything when advanceTopK exceeds the candidate count', () => {
    const rows = [
      { flag: 'a', agreementRate: 0.9, msPerGame: 10 },
      { flag: 'b', agreementRate: 0.5, msPerGame: 10 },
    ];
    expect(selectAdvancingFlags(rows, 10)).toEqual(new Set(['a', 'b']));
  });
});

describe('buildPromotionPool', () => {
  const assemblyOf = (flag: string): 'decorator' | 'terminal' | undefined => {
    if (flag === 'champion') return 'terminal';
    if (flag === 'newTerminal') return 'terminal';
    return undefined;
  };
  const challengeScoreOf = (flag: string): number | undefined => (flag === 'newTerminal' ? 0.62 : flag === 'decoratorA' ? undefined : 0.5);

  it('lists lineage flags first, then adopted flags, in input order', () => {
    const pool = buildPromotionPool({
      latestVersionFlags: ['champion'],
      adoptedFlags: ['decoratorA', 'newTerminal'],
      assemblyOf,
      baselineChallengeScore: 0.45,
      challengeScoreOf,
    });
    expect(pool.map((c) => c.flag)).toEqual(['champion', 'decoratorA', 'newTerminal']);
    expect(pool[0]).toEqual({ flag: 'champion', assembly: 'terminal', challengeScore: 0.45 });
    expect(pool[1]).toEqual({ flag: 'decoratorA' }); // no assembly, no challengeScore (both undefined -> omitted)
    expect(pool[2]).toEqual({ flag: 'newTerminal', assembly: 'terminal', challengeScore: 0.62 });
  });

  it('excludes flags present in excludeFromLineage from both the lineage and adopted halves', () => {
    const pool = buildPromotionPool({
      latestVersionFlags: ['opusCloneDominion', 'champion'],
      adoptedFlags: ['opusCloneDominion', 'decoratorA'],
      excludeFromLineage: new Set(['opusCloneDominion']),
      assemblyOf,
      baselineChallengeScore: 0.42,
      challengeScoreOf,
    });
    expect(pool.map((c) => c.flag)).toEqual(['champion', 'decoratorA']);
  });

  it('omits challengeScore/assembly entirely rather than writing undefined', () => {
    const pool = buildPromotionPool({
      latestVersionFlags: [],
      adoptedFlags: ['mystery'],
      assemblyOf: () => undefined,
      baselineChallengeScore: undefined,
      challengeScoreOf: () => undefined,
    });
    expect(pool).toEqual([{ flag: 'mystery' }]);
    expect('assembly' in pool[0]!).toBe(false);
    expect('challengeScore' in pool[0]!).toBe(false);
  });
});

describe('computeBucketOutcomes', () => {
  const candidates = [
    { flag: 'b1a', bucket: 'B1-exploit' as const },
    { flag: 'b1b', bucket: 'B1-exploit' as const },
    { flag: 'b3a', bucket: 'B3-deep' as const },
  ];
  const challengeTable: ChallengeTable = {
    L2: {
      b1a: { winRate: 0.6, blocks: 40, winRateCI: { lower: 0.5, upper: 0.7 } },
      b1b: { winRate: 0.4, blocks: 40, winRateCI: { lower: 0.3, upper: 0.5 } },
      baseline: { winRate: 0.5, blocks: 40, winRateCI: { lower: 0.4, upper: 0.6 } },
    },
  };

  it('counts adopted candidates per bucket and averages challengeDelta vs the round baseline', () => {
    const verdictByFlag = new Map([
      ['b1a', 'adopted' as const],
      ['b1b', 'near-miss' as const],
    ]);
    const outcomes = computeBucketOutcomes(candidates, verdictByFlag, challengeTable, 'L2', 0.5);
    const b1 = outcomes.find((o) => o.bucket === 'B1-exploit');
    expect(b1).toEqual({ bucket: 'B1-exploit', candidates: 2, adopted: 1, challengeDelta: (0.6 - 0.5 + (0.4 - 0.5)) / 2 });

    const b3 = outcomes.find((o) => o.bucket === 'B3-deep');
    // b3a never appears in challengeTable (screened out before challenge) -> 0 candidates measured -> challengeDelta 0.
    expect(b3).toEqual({ bucket: 'B3-deep', candidates: 1, adopted: 0, challengeDelta: 0 });
  });

  it('covers every bucket in BUCKET_ORDER even when a bucket has zero candidates this round', () => {
    const outcomes = computeBucketOutcomes(candidates, new Map(), challengeTable, 'L2', 0.5);
    expect(outcomes.map((o) => o.bucket)).toEqual(BUCKET_ORDER);
    const untouched = outcomes.find((o) => o.bucket === 'B5-imitate');
    expect(untouched).toEqual({ bucket: 'B5-imitate', candidates: 0, adopted: 0, challengeDelta: 0 });
  });

  it('falls back to challengeDelta 0 when primaryAnchorId is undefined (no challenge anchors configured)', () => {
    const outcomes = computeBucketOutcomes(candidates, new Map(), challengeTable, undefined, 0.5);
    expect(outcomes.every((o) => o.challengeDelta === 0)).toBe(true);
  });
});
