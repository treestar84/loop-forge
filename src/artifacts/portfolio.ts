/**
 * Portfolio allocation (docs/GAP-ANALYSIS-11.md D5): tracks per-bucket
 * candidate-generation shares across big-loop rounds and reallocates them
 * from measured yield instead of a fixed percentage — the Optuna-style
 * exploration/exploitation budget DESIGN.md §7 references, actually wired
 * up. `runs/<gameId>/portfolio-state.json` persists the current allocation
 * between rounds with a sealed digest (run-store.ts's/game-state.ts's
 * single-source-of-truth-on-disk pattern), so a corrupted or hand-edited
 * file is detected rather than silently trusted.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, sha256Digest } from '../kernel/digest';

export type BucketId = 'B1-exploit' | 'B2-opponent' | 'B3-deep' | 'B4-explore' | 'B5-imitate';

/** Fixed iteration order — every allocation array below is produced/consumed
 * in this order so reallocate's water-filling pass is deterministic. */
export const BUCKET_ORDER: readonly BucketId[] = [
  'B1-exploit',
  'B2-opponent',
  'B3-deep',
  'B4-explore',
  'B5-imitate',
];

export interface BucketAllocation {
  readonly bucket: BucketId;
  readonly share: number;
}

export interface BucketOutcome {
  readonly bucket: BucketId;
  readonly candidates: number;
  readonly adopted: number;
  readonly challengeDelta: number;
}

/** First-round preset (docs/GAP-ANALYSIS-11.md D5 table): 25/25/15/25/10. */
export const INITIAL_ALLOCATION: readonly BucketAllocation[] = [
  { bucket: 'B1-exploit', share: 0.25 },
  { bucket: 'B2-opponent', share: 0.25 },
  { bucket: 'B3-deep', share: 0.15 },
  { bucket: 'B4-explore', share: 0.25 },
  { bucket: 'B5-imitate', share: 0.1 },
];

const DEFAULT_FLOOR = 0.05;

function cloneAllocation(allocation: readonly BucketAllocation[]): readonly BucketAllocation[] {
  return allocation.map((entry) => ({ ...entry }));
}

/** Bucket yield = 0.5 * adoptionRate + 0.5 * max(0, challengeDelta)
 * (docs/GAP-ANALYSIS-11.md D5 "확정" rule). A bucket with 0 candidates this
 * round contributes 0 yield rather than dividing by zero — it neither wins
 * nor loses share from evidence it didn't produce. */
function bucketYield(outcome: BucketOutcome | undefined): number {
  if (outcome === undefined || outcome.candidates <= 0) {
    return 0;
  }
  const adoptionRate = outcome.adopted / outcome.candidates;
  const deltaTerm = Math.max(0, outcome.challengeDelta);
  return 0.5 * adoptionRate + 0.5 * deltaTerm;
}

/** Water-filling floor allocation: normalizes `rawShares` (parallel to
 * `buckets`) to sum to 1, then repeatedly clamps any bucket under `floor` to
 * exactly `floor` and renormalizes the rest of the remaining budget among
 * the still-unclamped buckets — so a clamp can never push another bucket
 * below the floor in a later pass. Terminates because each pass either
 * clamps at least one more bucket or stops. */
function waterFillFloor(
  buckets: readonly BucketId[],
  rawShares: readonly number[],
  floor: number,
): Map<BucketId, number> {
  const fixed = new Map<BucketId, number>();
  let remainingBuckets = buckets.map((bucket, index) => ({ bucket, raw: rawShares[index] ?? 0 }));
  let remainingBudget = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const sumRaw = remainingBuckets.reduce((total, entry) => total + entry.raw, 0);
    const tentative = remainingBuckets.map((entry) => ({
      bucket: entry.bucket,
      raw: entry.raw,
      share:
        sumRaw > 0
          ? (entry.raw / sumRaw) * remainingBudget
          : remainingBudget / remainingBuckets.length,
    }));

    const EPSILON = 1e-12;
    const belowFloor = tentative.filter((entry) => entry.share < floor - EPSILON);
    if (belowFloor.length === 0) {
      for (const entry of tentative) {
        fixed.set(entry.bucket, entry.share);
      }
      break;
    }

    for (const entry of belowFloor) {
      fixed.set(entry.bucket, floor);
      remainingBudget -= floor;
    }
    const clampedIds = new Set(belowFloor.map((entry) => entry.bucket));
    remainingBuckets = remainingBuckets.filter((entry) => !clampedIds.has(entry.bucket));

    if (remainingBuckets.length === 0) {
      // floor * bucketCount > 1 — cannot happen with the fixed 5-bucket,
      // 0.05-floor default, but stay defensive for a caller-supplied floor.
      break;
    }
  }

  return fixed;
}

/** Reallocates bucket shares from last round's measured yield
 * (docs/GAP-ANALYSIS-11.md D5): yield-proportional shares, each bucket
 * floored at `options.floor` (default 0.05) with the deficit redistributed
 * proportionally among the buckets still above floor, renormalized to sum
 * to 1. If every bucket's yield is 0 (no evidence this round), `current` is
 * returned unchanged — there is nothing to learn from yet. */
export function reallocate(
  current: readonly BucketAllocation[],
  outcomes: readonly BucketOutcome[],
  options?: { readonly floor?: number },
): readonly BucketAllocation[] {
  const floor = options?.floor ?? DEFAULT_FLOOR;
  const outcomeByBucket = new Map(outcomes.map((outcome) => [outcome.bucket, outcome]));

  const buckets = current.map((entry) => entry.bucket);
  const yields = buckets.map((bucket) => bucketYield(outcomeByBucket.get(bucket)));
  const totalYield = yields.reduce((total, value) => total + value, 0);

  if (totalYield <= 0) {
    return cloneAllocation(current);
  }

  const rawShares = yields.map((value) => value / totalYield);
  const finalShares = waterFillFloor(buckets, rawShares, floor);

  // Normalize away floating-point drift so shares sum to exactly 1.
  const unnormalized = buckets.map((bucket) => finalShares.get(bucket) ?? 0);
  const sum = unnormalized.reduce((total, value) => total + value, 0);
  const normalized = sum > 0 ? unnormalized.map((value) => value / sum) : unnormalized;

  return buckets.map((bucket, index) => ({ bucket, share: normalized[index] ?? 0 }));
}

// --- Persistence ---------------------------------------------------------

interface PortfolioStateFile {
  readonly allocation: readonly BucketAllocation[];
  readonly digest: string;
}

function gameDir(rootDir: string, gameId: string): string {
  return join(rootDir, 'runs', gameId);
}

function portfolioStatePath(rootDir: string, gameId: string): string {
  return join(gameDir(rootDir, gameId), 'portfolio-state.json');
}

export function savePortfolioState(
  rootDir: string,
  gameId: string,
  allocation: readonly BucketAllocation[],
): void {
  const dir = gameDir(rootDir, gameId);
  mkdirSync(dir, { recursive: true });
  const digest = sha256Digest(allocation);
  const file: PortfolioStateFile = { allocation: cloneAllocation(allocation), digest };
  writeFileSync(portfolioStatePath(rootDir, gameId), canonicalJson(file), 'utf8');
}

/** Returns `undefined` if no state has been saved yet for this game (first
 * round). Throws if the on-disk allocation's digest no longer matches its
 * stored digest — a hand edit or corruption, not a trustworthy prior. */
export function loadPortfolioState(
  rootDir: string,
  gameId: string,
): readonly BucketAllocation[] | undefined {
  const path = portfolioStatePath(rootDir, gameId);
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as PortfolioStateFile;
  const expectedDigest = sha256Digest(parsed.allocation);
  if (expectedDigest !== parsed.digest) {
    throw new Error(
      `loadPortfolioState: digest mismatch for game "${gameId}" — portfolio-state.json has been tampered with or corrupted (expected ${expectedDigest}, got ${parsed.digest})`,
    );
  }
  return cloneAllocation(parsed.allocation);
}
