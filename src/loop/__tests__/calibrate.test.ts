import { miniTrickAdapter } from '../../reference/mini-trick';
import { calibrateIdentity, measureNoiseFloor } from '../calibrate';
import { eraseAdapter } from '../erase';

const adapter = eraseAdapter(miniTrickAdapter);

describe('calibrateIdentity', () => {
  it('reports a mean win rate close to 0.5 for random self-play over many seeds', () => {
    const seeds = Array.from({ length: 200 }, (_, i) => 20_000 + i);
    const result = calibrateIdentity(adapter, adapter.baselines.random, seeds, 90_000);
    expect(result.meanWinRate).toBeGreaterThan(0.4);
    expect(result.meanWinRate).toBeLessThan(0.6);
    expect(result.seatWinRates).toHaveLength(adapter.spec.seatingPlan.length);
    expect(result.bias).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic for the same seeds', () => {
    const seeds = [1, 2, 3, 4, 5];
    const first = calibrateIdentity(adapter, adapter.baselines.heuristic, seeds, 500);
    const second = calibrateIdentity(adapter, adapter.baselines.heuristic, seeds, 500);
    expect(second).toEqual(first);
  });
});

describe('measureNoiseFloor', () => {
  it('returns a bootstrap result whose CI contains the point estimate', () => {
    const seeds = Array.from({ length: 40 }, (_, i) => 30_000 + i);
    const result = measureNoiseFloor(adapter, adapter.baselines.random, seeds, 400, {
      iterations: 500,
      confidenceLevel: 0.95,
      seed: 999,
    });
    expect(result.winRate.lower).toBeLessThanOrEqual(result.pointWinRate);
    expect(result.winRate.upper).toBeGreaterThanOrEqual(result.pointWinRate);
  });
});
