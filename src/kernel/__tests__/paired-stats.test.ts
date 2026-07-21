import { bootstrapPairedSeedBlocks, recommendBlockCount, type PairedSeedOutcome } from '../paired-stats';

function makeOutcomes(): PairedSeedOutcome[] {
  const outcomes: PairedSeedOutcome[] = [];
  for (let seed = 0; seed < 40; seed += 1) {
    outcomes.push({
      seed,
      candidateWinFraction: 0.5 + ((seed % 5) - 2) * 0.03,
      candidateScoreDelta: (seed % 7) - 3,
    });
  }
  return outcomes;
}

describe('bootstrapPairedSeedBlocks', () => {
  it('is deterministic for a given seed', () => {
    const outcomes = makeOutcomes();
    const options = { iterations: 500, confidenceLevel: 0.95, seed: 42 };
    const first = bootstrapPairedSeedBlocks(outcomes, options);
    const second = bootstrapPairedSeedBlocks(outcomes, options);
    expect(second).toEqual(first);
  });

  it('produces different CIs for a different bootstrap seed (sanity, not required identical)', () => {
    const outcomes = makeOutcomes();
    const a = bootstrapPairedSeedBlocks(outcomes, { iterations: 500, confidenceLevel: 0.95, seed: 1 });
    const b = bootstrapPairedSeedBlocks(outcomes, { iterations: 500, confidenceLevel: 0.95, seed: 2 });
    // Point estimates are independent of bootstrap seed.
    expect(a.pointWinRate).toBeCloseTo(b.pointWinRate, 10);
    expect(a.pointScoreDiff).toBeCloseTo(b.pointScoreDiff, 10);
  });

  it('confidence interval contains the point estimate', () => {
    const outcomes = makeOutcomes();
    const result = bootstrapPairedSeedBlocks(outcomes, {
      iterations: 1000,
      confidenceLevel: 0.95,
      seed: 7,
    });
    expect(result.winRate.lower).toBeLessThanOrEqual(result.pointWinRate);
    expect(result.winRate.upper).toBeGreaterThanOrEqual(result.pointWinRate);
    expect(result.scoreDiff.lower).toBeLessThanOrEqual(result.pointScoreDiff);
    expect(result.scoreDiff.upper).toBeGreaterThanOrEqual(result.pointScoreDiff);
  });

  it('narrows toward zero variance when all outcomes are identical', () => {
    const outcomes: PairedSeedOutcome[] = Array.from({ length: 10 }, (_, seed) => ({
      seed,
      candidateWinFraction: 0.6,
      candidateScoreDelta: 8,
    }));
    const result = bootstrapPairedSeedBlocks(outcomes, {
      iterations: 500,
      confidenceLevel: 0.95,
      seed: 3,
    });
    expect(result.winRate.lower).toBeCloseTo(0.6, 10);
    expect(result.winRate.upper).toBeCloseTo(0.6, 10);
    expect(result.pointWinRate).toBeCloseTo(0.6, 10);
  });

  it('rejects empty outcomes', () => {
    expect(() =>
      bootstrapPairedSeedBlocks([], { iterations: 100, confidenceLevel: 0.95, seed: 1 }),
    ).toThrow();
  });

  it('rejects duplicate seeds', () => {
    const outcomes: PairedSeedOutcome[] = [
      { seed: 1, candidateWinFraction: 0.5, candidateScoreDelta: 0 },
      { seed: 1, candidateWinFraction: 0.6, candidateScoreDelta: 1 },
    ];
    expect(() =>
      bootstrapPairedSeedBlocks(outcomes, { iterations: 100, confidenceLevel: 0.95, seed: 1 }),
    ).toThrow();
  });

  it('rejects NaN outcomes and out-of-range win fractions', () => {
    expect(() =>
      bootstrapPairedSeedBlocks(
        [{ seed: 1, candidateWinFraction: Number.NaN, candidateScoreDelta: 0 }],
        { iterations: 100, confidenceLevel: 0.95, seed: 1 },
      ),
    ).toThrow();
    expect(() =>
      bootstrapPairedSeedBlocks(
        [{ seed: 1, candidateWinFraction: 1.5, candidateScoreDelta: 0 }],
        { iterations: 100, confidenceLevel: 0.95, seed: 1 },
      ),
    ).toThrow();
  });

  it('rejects invalid options', () => {
    const outcomes = makeOutcomes();
    expect(() =>
      bootstrapPairedSeedBlocks(outcomes, { iterations: 0, confidenceLevel: 0.95, seed: 1 }),
    ).toThrow();
    expect(() =>
      bootstrapPairedSeedBlocks(outcomes, { iterations: 100, confidenceLevel: 1, seed: 1 }),
    ).toThrow();
    expect(() =>
      bootstrapPairedSeedBlocks(outcomes, { iterations: 100, confidenceLevel: 0.95, seed: 1.5 }),
    ).toThrow();
  });
});

describe('recommendBlockCount', () => {
  it('matches the standard 0.05/0.8 sample-size formula for a known input', () => {
    // n = ((1.95996 + 0.84162) * 0.5 / 0.03)^2 ~= 2180.6 -> ceil to 2181.
    const n = recommendBlockCount({ blockStdDev: 0.5, targetEffect: 0.03 });
    expect(n).toBe(2181);
  });

  it('requires more blocks for a noisier game (larger blockStdDev)', () => {
    const quiet = recommendBlockCount({ blockStdDev: 0.1, targetEffect: 0.03 });
    const noisy = recommendBlockCount({ blockStdDev: 0.5, targetEffect: 0.03 });
    expect(noisy).toBeGreaterThan(quiet);
  });

  it('requires fewer blocks for a larger target effect', () => {
    const smallEffect = recommendBlockCount({ blockStdDev: 0.3, targetEffect: 0.02 });
    const largeEffect = recommendBlockCount({ blockStdDev: 0.3, targetEffect: 0.1 });
    expect(largeEffect).toBeLessThan(smallEffect);
  });

  it('requires more blocks for higher power at the same alpha', () => {
    const lowPower = recommendBlockCount({ blockStdDev: 0.3, targetEffect: 0.03, power: 0.8 });
    const highPower = recommendBlockCount({ blockStdDev: 0.3, targetEffect: 0.03, power: 0.95 });
    expect(highPower).toBeGreaterThan(lowPower);
  });

  it('returns a positive integer', () => {
    const n = recommendBlockCount({ blockStdDev: 0.25, targetEffect: 0.05 });
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
  });

  it('rejects non-positive blockStdDev/targetEffect and out-of-range alpha/power', () => {
    expect(() => recommendBlockCount({ blockStdDev: 0, targetEffect: 0.03 })).toThrow();
    expect(() => recommendBlockCount({ blockStdDev: 0.3, targetEffect: 0 })).toThrow();
    expect(() =>
      recommendBlockCount({ blockStdDev: 0.3, targetEffect: 0.03, alpha: 0 }),
    ).toThrow();
    expect(() =>
      recommendBlockCount({ blockStdDev: 0.3, targetEffect: 0.03, power: 1 }),
    ).toThrow();
  });
});
