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
