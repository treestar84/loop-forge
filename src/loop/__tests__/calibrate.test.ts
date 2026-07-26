import { miniTrickAdapter } from '../../reference/mini-trick';
import { calibrateIdentity, measureAverageLegalChoiceCount, measureNoiseFloor } from '../calibrate';
import { eraseAdapter } from '../erase';
import { firstMoverWinsAdapter } from './helpers/first-mover-wins-game';
import { longAccumulateAdapter } from './helpers/long-accumulate-game';

const adapter = eraseAdapter(miniTrickAdapter);
const collapseAdapter = eraseAdapter(firstMoverWinsAdapter);
const longAdapter = eraseAdapter(longAccumulateAdapter);

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

  it('reports a low signalCollapseRate for a game whose outcome depends on real decisions (mini-trick)', () => {
    // N=200 (not 50) so the assertion reflects the game's actual collapse
    // behavior rather than which handful of seeds happened to land on 0.5 —
    // per-seed bot-seed forking (Z2 fix) legitimately shifts individual draws
    // seed-by-seed, so a small sample is too noisy to pin to a tight bound.
    const seeds = Array.from({ length: 200 }, (_, i) => 60_000 + i);
    const result = calibrateIdentity(adapter, adapter.baselines.random, seeds, 90_000);
    // Well below the deterministic always-collapse case (rate=1.0, see the
    // X1 describe block below), demonstrating real decisions still matter.
    expect(result.signalCollapseRate).toBeLessThan(0.7);
  });
});

// X1 (docs/GAP-ANALYSIS-2.md): paired signal collapse — seat mirroring cancels
// position bias, but for a game where PlayerId 0 always wins unconditionally
// it cancels every strategy signal too, so every block's winFraction lands
// exactly on 0.5.
describe('calibrateIdentity signalCollapseRate (X1: paired signal collapse)', () => {
  it('reports signalCollapseRate=1.0 for a deterministic always-first-mover-wins game', () => {
    const seeds = [1, 2, 3, 4, 5];
    const result = calibrateIdentity(
      collapseAdapter,
      collapseAdapter.baselines.random,
      seeds,
      100,
    );
    expect(result.signalCollapseRate).toBe(1);
  });
});

// Z2 (docs/FIX-BACKLOG.md): calibrateIdentity must derive an independent
// bot-seed pair per gameSeed. Reusing one fixed pair across every gameSeed
// (the pre-fix bug) makes a long-decision game replay the exact same
// trajectory every match — since the bot's choices depend only on its own
// seed, never on gameSeed — so meanWinRate freezes at whatever that one
// fixed seed pair happens to produce and never approaches 0.5, no matter how
// large the sample gets.
describe('calibrateIdentity per-gameSeed bot-seed forking (Z2)', () => {
  it('converges meanWinRate toward 0.5 for a long-decision game as the seed sample grows', () => {
    const botSeedBase = 19_000; // one of the seeds that visibly diverged in the real splendor incident
    const small = calibrateIdentity(
      longAdapter,
      longAdapter.baselines.random,
      Array.from({ length: 200 }, (_, i) => 1_000 + i),
      botSeedBase,
    );
    const large = calibrateIdentity(
      longAdapter,
      longAdapter.baselines.random,
      Array.from({ length: 2_000 }, (_, i) => 1_000 + i),
      botSeedBase,
    );
    expect(small.meanWinRate).toBeGreaterThan(0.35);
    expect(small.meanWinRate).toBeLessThan(0.65);
    expect(large.meanWinRate).toBeGreaterThan(0.4);
    expect(large.meanWinRate).toBeLessThan(0.6);
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

  it('reports a non-negative blockStdDev usable by recommendBlockCount (X3)', () => {
    const seeds = Array.from({ length: 40 }, (_, i) => 30_000 + i);
    const result = measureNoiseFloor(adapter, adapter.baselines.random, seeds, 400, {
      iterations: 500,
      confidenceLevel: 0.95,
      seed: 999,
    });
    expect(result.blockStdDev).toBeGreaterThanOrEqual(0);
  });

  // P6 (docs/FIX-BACKLOG.md): scoreDiffStdDev is the calibration input
  // deriveBlueprint's recommendedMinScoreDiff (kernel/blueprint.ts) consumes.
  it('reports a non-negative scoreDiffStdDev, deterministic for the same seeds', () => {
    const seeds = Array.from({ length: 40 }, (_, i) => 30_000 + i);
    const first = measureNoiseFloor(adapter, adapter.baselines.random, seeds, 400, {
      iterations: 500,
      confidenceLevel: 0.95,
      seed: 999,
    });
    const second = measureNoiseFloor(adapter, adapter.baselines.random, seeds, 400, {
      iterations: 500,
      confidenceLevel: 0.95,
      seed: 999,
    });
    expect(first.scoreDiffStdDev).toBeGreaterThanOrEqual(0);
    expect(second.scoreDiffStdDev).toBe(first.scoreDiffStdDev);
  });

  // G2 (docs/FIX-BACKLOG.md, docs/GAP-ANALYSIS-9.md §2): averageLegalChoiceCount
  // is the branching-factor signal kernel/search-blueprint.ts's
  // deriveSearchBlueprint consumes for its tacticalPrecheckDepth recommendation.
  it('reports averageLegalChoiceCount matching the fixture game every decision it makes (2 legal choices/decision)', () => {
    const seeds = Array.from({ length: 10 }, (_, i) => 30_000 + i);
    const result = measureNoiseFloor(collapseAdapter, collapseAdapter.baselines.random, seeds, 400, {
      iterations: 200,
      confidenceLevel: 0.95,
      seed: 999,
    });
    expect(result.averageLegalChoiceCount).toBe(2);
  });
});

describe('measureAverageLegalChoiceCount', () => {
  it('returns the exact known average for a fixture with a fixed legal-choice count (firstMoverWins: 2)', () => {
    const seeds = Array.from({ length: 20 }, (_, i) => 1_000 + i);
    const result = measureAverageLegalChoiceCount(collapseAdapter, collapseAdapter.baselines.random, seeds, 500);
    expect(result).toBe(2);
  });

  it('returns the exact known average for a fixture with a fixed legal-choice count (longAccumulate: 10)', () => {
    const seeds = Array.from({ length: 5 }, (_, i) => 2_000 + i);
    const result = measureAverageLegalChoiceCount(longAdapter, longAdapter.baselines.random, seeds, 500);
    expect(result).toBe(10);
  });

  it('is deterministic for the same seeds', () => {
    const seeds = [1, 2, 3, 4, 5];
    const first = measureAverageLegalChoiceCount(adapter, adapter.baselines.heuristic, seeds, 700);
    const second = measureAverageLegalChoiceCount(adapter, adapter.baselines.heuristic, seeds, 700);
    expect(second).toBe(first);
  });
});
