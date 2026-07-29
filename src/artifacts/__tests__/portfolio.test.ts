import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUCKET_ORDER,
  INITIAL_ALLOCATION,
  loadPortfolioState,
  reallocate,
  savePortfolioState,
  type BucketOutcome,
} from '../portfolio';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'loop-forge-portfolio-'));
}

function sumShares(allocation: readonly { readonly share: number }[]): number {
  return allocation.reduce((total, entry) => total + entry.share, 0);
}

describe('INITIAL_ALLOCATION', () => {
  it('sums to 1 and covers every bucket exactly once', () => {
    expect(sumShares(INITIAL_ALLOCATION)).toBeCloseTo(1, 9);
    expect(INITIAL_ALLOCATION.map((entry) => entry.bucket).sort()).toEqual([...BUCKET_ORDER].sort());
  });
});

describe('reallocate', () => {
  it('reallocates proportionally to measured yield when no bucket falls below the floor', () => {
    const outcomes: readonly BucketOutcome[] = [
      { bucket: 'B1-exploit', candidates: 10, adopted: 2, challengeDelta: 0.1 },
      { bucket: 'B2-opponent', candidates: 10, adopted: 5, challengeDelta: 0 },
      { bucket: 'B3-deep', candidates: 4, adopted: 0, challengeDelta: 0.2 },
      { bucket: 'B4-explore', candidates: 8, adopted: 1, challengeDelta: 0 },
      { bucket: 'B5-imitate', candidates: 2, adopted: 0, challengeDelta: -0.5 },
    ];

    const next = reallocate(INITIAL_ALLOCATION, outcomes);
    const byBucket = new Map(next.map((entry) => [entry.bucket, entry.share]));

    expect(sumShares(next)).toBeCloseTo(1, 9);
    // B1 yield=0.15, B2=0.25, B3=0.10, B4=0.0625, B5=0 (negative delta clipped) -> total 0.5625.
    expect(byBucket.get('B1-exploit')).toBeCloseTo(0.253333, 5);
    expect(byBucket.get('B2-opponent')).toBeCloseTo(0.422222, 5);
    expect(byBucket.get('B3-deep')).toBeCloseTo(0.168889, 5);
    expect(byBucket.get('B4-explore')).toBeCloseTo(0.105556, 5);
    // B5 had 0 yield -> would get 0 share, floored to 0.05 instead.
    expect(byBucket.get('B5-imitate')).toBeCloseTo(0.05, 9);
  });

  it('guarantees the floor for every zero-yield bucket, cascading the clamp across multiple buckets', () => {
    const outcomes: readonly BucketOutcome[] = [
      { bucket: 'B1-exploit', candidates: 100, adopted: 100, challengeDelta: 1 },
      { bucket: 'B2-opponent', candidates: 1, adopted: 0, challengeDelta: 0 },
      { bucket: 'B3-deep', candidates: 1, adopted: 0, challengeDelta: 0 },
      { bucket: 'B4-explore', candidates: 1, adopted: 0, challengeDelta: 0 },
      { bucket: 'B5-imitate', candidates: 1, adopted: 0, challengeDelta: 0 },
    ];

    const next = reallocate(INITIAL_ALLOCATION, outcomes, { floor: 0.05 });
    const byBucket = new Map(next.map((entry) => [entry.bucket, entry.share]));

    expect(sumShares(next)).toBeCloseTo(1, 9);
    expect(byBucket.get('B1-exploit')).toBeCloseTo(0.8, 9);
    for (const bucket of ['B2-opponent', 'B3-deep', 'B4-explore', 'B5-imitate'] as const) {
      expect(byBucket.get(bucket)).toBeCloseTo(0.05, 9);
    }
    for (const entry of next) {
      expect(entry.share).toBeGreaterThanOrEqual(0.05 - 1e-9);
    }
  });

  it('is deterministic: identical inputs produce byte-identical output', () => {
    const outcomes: readonly BucketOutcome[] = [
      { bucket: 'B1-exploit', candidates: 12, adopted: 3, challengeDelta: 0.05 },
      { bucket: 'B2-opponent', candidates: 6, adopted: 1, challengeDelta: 0.02 },
      { bucket: 'B3-deep', candidates: 3, adopted: 1, challengeDelta: 0 },
      { bucket: 'B4-explore', candidates: 9, adopted: 2, challengeDelta: 0.01 },
      { bucket: 'B5-imitate', candidates: 4, adopted: 0, challengeDelta: 0 },
    ];

    const first = reallocate(INITIAL_ALLOCATION, outcomes);
    const second = reallocate(INITIAL_ALLOCATION, outcomes);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('keeps the current allocation unchanged when every bucket has zero yield', () => {
    const outcomes: readonly BucketOutcome[] = BUCKET_ORDER.map((bucket) => ({
      bucket,
      candidates: 0,
      adopted: 0,
      challengeDelta: 0,
    }));

    const next = reallocate(INITIAL_ALLOCATION, outcomes);
    expect(next).toEqual(INITIAL_ALLOCATION);
  });

  it('normalizes to exactly 1 regardless of the input allocation shares (only bucket set/order matters)', () => {
    const skewedCurrent = BUCKET_ORDER.map((bucket) => ({ bucket, share: 1 / BUCKET_ORDER.length }));
    const outcomes: readonly BucketOutcome[] = [
      { bucket: 'B1-exploit', candidates: 5, adopted: 5, challengeDelta: 0 },
      { bucket: 'B2-opponent', candidates: 5, adopted: 0, challengeDelta: 0 },
      { bucket: 'B3-deep', candidates: 5, adopted: 0, challengeDelta: 0 },
      { bucket: 'B4-explore', candidates: 5, adopted: 0, challengeDelta: 0 },
      { bucket: 'B5-imitate', candidates: 5, adopted: 0, challengeDelta: 0 },
    ];
    const next = reallocate(skewedCurrent, outcomes);
    expect(sumShares(next)).toBeCloseTo(1, 9);
  });
});

describe('savePortfolioState / loadPortfolioState', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns undefined when no state has been saved yet', () => {
    expect(loadPortfolioState(root, 'new-game')).toBeUndefined();
  });

  it('round-trips a saved allocation exactly', () => {
    savePortfolioState(root, 'roundtrip-game', INITIAL_ALLOCATION);
    const loaded = loadPortfolioState(root, 'roundtrip-game');
    expect(loaded).toEqual(INITIAL_ALLOCATION);
  });

  it('detects tampering: mutating the stored allocation without updating its digest throws', () => {
    savePortfolioState(root, 'tampered-game', INITIAL_ALLOCATION);
    const path = join(root, 'runs', 'tampered-game', 'portfolio-state.json');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { allocation: unknown; digest: string };
    const tampered = {
      ...raw,
      allocation: [{ bucket: 'B1-exploit', share: 0.99 }, ...(raw.allocation as unknown[]).slice(1)],
    };
    writeFileSync(path, JSON.stringify(tampered), 'utf8');

    expect(() => loadPortfolioState(root, 'tampered-game')).toThrow(/digest mismatch/);
  });
});
