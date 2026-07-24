import { classifyGame } from '../classify';
import { deriveBlueprint } from '../blueprint';
import { recommendBlockCount } from '../paired-stats';
import { miniTrickAdapter } from '../../reference/mini-trick';
import { splendorAdapter } from '../../reference/splendor';
import { gomokuAdapter } from '../../reference/gomoku';

describe('deriveBlueprint', () => {
  it('mini-trick: hidden info requires C3, score-based promotion, short-game decision floor', () => {
    const classification = classifyGame(miniTrickAdapter.spec);
    const blueprint = deriveBlueprint(classification);
    expect(blueprint.c3Required).toBe(true);
    expect(blueprint.promotionMinScoreDiff).toBe(5);
    expect(blueprint.benchmarkShowScoreDiff).toBe(true);
    expect(blueprint.sprtNullHypothesis).toBeCloseTo(0.5);
    expect(blueprint.c4MinDecisionsPerSecond).toBe(500);
  });

  it('splendor (assumed FFA): perfect info skips C3, long game relaxes decision floor', () => {
    const ffaSpec = { ...splendorAdapter.spec, playerCount: 4, maxDecisionsPerGame: 190 };
    const classification = classifyGame(ffaSpec);
    const blueprint = deriveBlueprint(classification);
    expect(blueprint.c3Required).toBe(false);
    expect(blueprint.c4MinDecisionsPerSecond).toBe(200);
    expect(blueprint.sprtNullHypothesis).toBeCloseTo(0.25);
  });

  it('gomoku (assumed win-loss-only): score-margin gate collapses to zero, no score-diff benchmark', () => {
    const spec = { ...gomokuAdapter.spec, scoreMargin: 'none' as const };
    const classification = classifyGame(spec);
    const blueprint = deriveBlueprint(classification);
    expect(blueprint.promotionMinScoreDiff).toBe(0);
    expect(blueprint.benchmarkShowScoreDiff).toBe(false);
    expect(blueprint.warnings).toEqual([]);
  });

  it('warns when scoreMargin was not declared and defaulted to scored', () => {
    const classification = classifyGame(miniTrickAdapter.spec);
    const blueprint = deriveBlueprint(classification);
    expect(blueprint.warnings.length).toBeGreaterThan(0);
  });

  it('uses recommendBlockCount for seed counts when calibration is provided', () => {
    const classification = classifyGame(miniTrickAdapter.spec);
    const blockStdDev = 0.12;
    const blueprint = deriveBlueprint(classification, { blockStdDev });
    const expected = recommendBlockCount({ blockStdDev, targetEffect: 0.03 });
    expect(blueprint.c5IdentitySeedCount).toBe(expected);
    expect(blueprint.c5HeadToHeadSeedCount).toBe(expected);
  });

  it('falls back to default seed counts without calibration', () => {
    const classification = classifyGame(miniTrickAdapter.spec);
    const blueprint = deriveBlueprint(classification);
    expect(blueprint.c5IdentitySeedCount).toBe(200);
    expect(blueprint.c5HeadToHeadSeedCount).toBe(300);
  });
});

// P6 (docs/FIX-BACKLOG.md, docs/GAP-ANALYSIS-8.md §2): recommendedMinScoreDiff
// derivation branches.
describe('deriveBlueprint recommendedMinScoreDiff (P6)', () => {
  it('is 0 for win-loss-only games regardless of calibration (unchanged invariant)', () => {
    const spec = { ...gomokuAdapter.spec, scoreMargin: 'none' as const };
    const classification = classifyGame(spec);
    const blueprint = deriveBlueprint(classification, { scoreDiffStdDev: 3 });
    expect(blueprint.recommendedMinScoreDiff).toBe(0);
  });

  it('derives 2x scoreDiffStdDev for a scored game with a real (>0) noise-floor measurement', () => {
    const classification = classifyGame(miniTrickAdapter.spec);
    const blueprint = deriveBlueprint(classification, { scoreDiffStdDev: 1.835 });
    expect(blueprint.recommendedMinScoreDiff).toBeCloseTo(3.67);
  });

  it('falls back to 0 with a warning when scoreDiffStdDev is exactly 0 (deterministic identity collapse)', () => {
    const classification = classifyGame(miniTrickAdapter.spec);
    const blueprint = deriveBlueprint(classification, { scoreDiffStdDev: 0 });
    expect(blueprint.recommendedMinScoreDiff).toBe(0);
    expect(blueprint.warnings.some((w) => w.includes('scoreDiffStdDev=0'))).toBe(true);
  });

  it('falls back to the uncalibrated DEFAULT_CRITERIA.minScoreDiff when no calibration is provided at all', () => {
    const classification = classifyGame(miniTrickAdapter.spec);
    const blueprint = deriveBlueprint(classification);
    expect(blueprint.recommendedMinScoreDiff).toBe(5);
  });

  // Regression (found while wiring P6's scoreDiffStdDev through
  // assembleWaveConfig, docs/FIX-BACKLOG.md P6): a collapsed blockStdDev===0
  // identity-noise-floor measurement passed alongside scoreDiffStdDev must
  // not crash recommendBlockCount — it should fall back to the default seed
  // counts exactly as if no calibration had been passed at all.
  it('does not crash when blockStdDev===0 is provided together with scoreDiffStdDev', () => {
    const classification = classifyGame(miniTrickAdapter.spec);
    expect(() =>
      deriveBlueprint(classification, { blockStdDev: 0, scoreDiffStdDev: 1.835 }),
    ).not.toThrow();
    const blueprint = deriveBlueprint(classification, { blockStdDev: 0, scoreDiffStdDev: 1.835 });
    expect(blueprint.c5IdentitySeedCount).toBe(200);
    expect(blueprint.c5HeadToHeadSeedCount).toBe(300);
    expect(blueprint.recommendedMinScoreDiff).toBeCloseTo(3.67);
  });
});
