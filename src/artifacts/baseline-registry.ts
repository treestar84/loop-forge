/**
 * Baseline registry: versioned, immutable composition of adopted strategy
 * flags into a single baseline bot (tichu harness's `V*_FLAGS` snapshot,
 * generalized). Each version records which flags it composes, in
 * application order, and its parent version — so a wave's "current
 * baseline" always has a lineage back to the game's raw heuristic bot.
 *
 * Benchmark anchors (random / heuristic / a frozen baseline version) are
 * registered here too and are permanently frozen once registered — the
 * absolute-progress ladder (INTERPRETATION.md §5) only means anything if the
 * rungs never move under it (tichu harness's "V49 snapshot is immutable"
 * rule).
 */

import type { AnyBotFactory, AnyGameAdapter } from '../contract/types';

export interface BaselineVersion {
  readonly version: string; // 'v1', 'v2', ...
  /** Flags composed onto adapter.baselines.heuristic, in application order. */
  readonly flags: readonly string[];
  readonly parent: string | null;
  readonly createdAt: string;
  readonly sourceWaveId: string | null;
  readonly notes: string;
  /**
   * Optional source closure digest (source-digest.ts's `computeSourceDigest`)
   * of the files that decided this version's flags' behavior at
   * registration time. Approximation only — a source-file-level closure, not
   * a hermetic build seal; transpiled output and imported library code are
   * out of scope (see source-digest.ts's doc comment for the full
   * rationale). Optional and backward-compatible: existing registry.json
   * files predate this field and load with it simply absent, and existing
   * version records are never backfilled (a digest computed after the fact
   * would not reflect the truth at registration time — docs/GAP-ANALYSIS-8.md
   * §2's honesty requirement).
   */
  readonly sourceDigest?: string;
}

export type BenchmarkAnchorKind = 'random' | 'heuristic' | 'baseline';

export interface BenchmarkAnchor {
  readonly anchorId: string;
  readonly kind: BenchmarkAnchorKind;
  /** Required (and only meaningful) when kind === 'baseline'. */
  readonly baselineVersion?: string;
}

function cloneBaselineVersion(version: BaselineVersion): BaselineVersion {
  return {
    version: version.version,
    flags: [...version.flags],
    parent: version.parent,
    createdAt: version.createdAt,
    sourceWaveId: version.sourceWaveId,
    notes: version.notes,
    ...(version.sourceDigest !== undefined ? { sourceDigest: version.sourceDigest } : {}),
  };
}

function cloneAnchor(anchor: BenchmarkAnchor): BenchmarkAnchor {
  return anchor.baselineVersion !== undefined
    ? { anchorId: anchor.anchorId, kind: anchor.kind, baselineVersion: anchor.baselineVersion }
    : { anchorId: anchor.anchorId, kind: anchor.kind };
}

// Canonical implementation lives in the loop layer (layer rule: artifacts → loop
// is allowed, loop → artifacts is not). Re-exported here for registry consumers.
import { composeBot } from '../loop/compose';
export { composeBot };

export class BaselineRegistry {
  private readonly versions = new Map<string, BaselineVersion>();
  private readonly versionOrder: string[] = [];
  private readonly anchors = new Map<string, BenchmarkAnchor>();
  private readonly anchorOrder: string[] = [];

  register(version: BaselineVersion): BaselineVersion {
    if (this.versions.has(version.version)) {
      throw new Error(`BaselineRegistry: duplicate baseline version "${version.version}"`);
    }
    if (version.parent !== null && !this.versions.has(version.parent)) {
      throw new Error(
        `BaselineRegistry: baseline version "${version.version}" declares unknown parent "${version.parent}"`,
      );
    }
    const stored = cloneBaselineVersion(version);
    this.versions.set(stored.version, stored);
    this.versionOrder.push(stored.version);
    return stored;
  }

  get(version: string): BaselineVersion | undefined {
    const found = this.versions.get(version);
    return found ? cloneBaselineVersion(found) : undefined;
  }

  latest(): BaselineVersion | undefined {
    const lastVersion = this.versionOrder[this.versionOrder.length - 1];
    if (lastVersion === undefined) {
      return undefined;
    }
    return this.get(lastVersion);
  }

  /** Ancestors-to-self chain (oldest first, ending at `version`). */
  lineage(version: string): BaselineVersion[] {
    const found = this.versions.get(version);
    if (!found) {
      throw new Error(`BaselineRegistry: unknown baseline version "${version}"`);
    }
    const chain: BaselineVersion[] = [];
    let current: BaselineVersion | undefined = found;
    while (current) {
      chain.unshift(cloneBaselineVersion(current));
      current = current.parent !== null ? this.versions.get(current.parent) : undefined;
    }
    return chain;
  }

  /**
   * Freeze a benchmark anchor. Re-registering the same anchorId always
   * throws — anchors are permanent once sealed (INTERPRETATION.md §5).
   */
  registerAnchor(anchor: BenchmarkAnchor): BenchmarkAnchor {
    if (this.anchors.has(anchor.anchorId)) {
      throw new Error(`BaselineRegistry: anchor "${anchor.anchorId}" is already frozen and cannot be re-registered`);
    }
    if (anchor.kind === 'baseline') {
      if (anchor.baselineVersion === undefined) {
        throw new Error(
          `BaselineRegistry: anchor "${anchor.anchorId}" has kind "baseline" but no baselineVersion`,
        );
      }
      if (!this.versions.has(anchor.baselineVersion)) {
        throw new Error(
          `BaselineRegistry: anchor "${anchor.anchorId}" references unknown baseline version "${anchor.baselineVersion}"`,
        );
      }
    }
    const stored = cloneAnchor(anchor);
    this.anchors.set(stored.anchorId, stored);
    this.anchorOrder.push(stored.anchorId);
    return stored;
  }

  getAnchor(anchorId: string): BenchmarkAnchor | undefined {
    const found = this.anchors.get(anchorId);
    return found ? cloneAnchor(found) : undefined;
  }

  listAnchors(): BenchmarkAnchor[] {
    return this.anchorOrder.map((id) => cloneAnchor(this.anchors.get(id) as BenchmarkAnchor));
  }

  /** Resolve a frozen anchor into a runnable bot factory for `adapter`. */
  resolveAnchor(adapter: AnyGameAdapter, anchorId: string): AnyBotFactory {
    const anchor = this.anchors.get(anchorId);
    if (!anchor) {
      throw new Error(`BaselineRegistry: unknown anchor "${anchorId}"`);
    }
    if (anchor.kind === 'random') {
      return adapter.baselines.random;
    }
    if (anchor.kind === 'heuristic') {
      return adapter.baselines.heuristic;
    }
    const baselineVersion = this.versions.get(anchor.baselineVersion as string);
    if (!baselineVersion) {
      throw new Error(
        `BaselineRegistry: anchor "${anchorId}" references unknown baseline version "${anchor.baselineVersion}"`,
      );
    }
    return composeBot(adapter, baselineVersion.flags);
  }

  toJSON(): unknown {
    return {
      versionOrder: [...this.versionOrder],
      versions: this.versionOrder.map((version) => this.versions.get(version)),
      anchorOrder: [...this.anchorOrder],
      anchors: this.anchorOrder.map((id) => this.anchors.get(id)),
    };
  }

  static fromJSON(value: unknown): BaselineRegistry {
    if (typeof value !== 'object' || value === null) {
      throw new Error('BaselineRegistry.fromJSON: expected an object');
    }
    const record = value as Record<string, unknown>;
    const versionOrder = record['versionOrder'];
    const versions = record['versions'];
    const anchorOrder = record['anchorOrder'];
    const anchors = record['anchors'];
    if (!Array.isArray(versionOrder) || !Array.isArray(versions)) {
      throw new Error('BaselineRegistry.fromJSON: expected "versionOrder" and "versions" arrays');
    }
    if (versionOrder.length !== versions.length) {
      throw new Error('BaselineRegistry.fromJSON: "versionOrder" and "versions" length mismatch');
    }
    if (!Array.isArray(anchorOrder) || !Array.isArray(anchors)) {
      throw new Error('BaselineRegistry.fromJSON: expected "anchorOrder" and "anchors" arrays');
    }
    if (anchorOrder.length !== anchors.length) {
      throw new Error('BaselineRegistry.fromJSON: "anchorOrder" and "anchors" length mismatch');
    }

    const registry = new BaselineRegistry();
    for (let index = 0; index < versionOrder.length; index += 1) {
      const expectedId = versionOrder[index];
      const parsed = parseBaselineVersion(versions[index]);
      if (parsed.version !== expectedId) {
        throw new Error(
          `BaselineRegistry.fromJSON: versionOrder[${index}] ("${String(expectedId)}") does not match versions[${index}].version ("${parsed.version}")`,
        );
      }
      registry.register(parsed);
    }
    for (let index = 0; index < anchorOrder.length; index += 1) {
      const expectedId = anchorOrder[index];
      const parsed = parseAnchor(anchors[index]);
      if (parsed.anchorId !== expectedId) {
        throw new Error(
          `BaselineRegistry.fromJSON: anchorOrder[${index}] ("${String(expectedId)}") does not match anchors[${index}].anchorId ("${parsed.anchorId}")`,
        );
      }
      registry.registerAnchor(parsed);
    }
    return registry;
  }
}

function parseBaselineVersion(value: unknown): BaselineVersion {
  if (typeof value !== 'object' || value === null) {
    throw new Error('BaselineRegistry.fromJSON: expected a baseline version object');
  }
  const record = value as Record<string, unknown>;
  const version = record['version'];
  const flags = record['flags'];
  const parent = record['parent'];
  const createdAt = record['createdAt'];
  const sourceWaveId = record['sourceWaveId'];
  const notes = record['notes'];
  const sourceDigest = record['sourceDigest'];

  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('BaselineRegistry.fromJSON: version must be a non-empty string');
  }
  if (!Array.isArray(flags) || !flags.every((flag) => typeof flag === 'string')) {
    throw new Error(`BaselineRegistry.fromJSON: version "${version}" flags must be a string array`);
  }
  if (parent !== null && typeof parent !== 'string') {
    throw new Error(`BaselineRegistry.fromJSON: version "${version}" parent must be a string or null`);
  }
  if (typeof createdAt !== 'string') {
    throw new Error(`BaselineRegistry.fromJSON: version "${version}" createdAt must be a string`);
  }
  if (sourceWaveId !== null && typeof sourceWaveId !== 'string') {
    throw new Error(`BaselineRegistry.fromJSON: version "${version}" sourceWaveId must be a string or null`);
  }
  if (typeof notes !== 'string') {
    throw new Error(`BaselineRegistry.fromJSON: version "${version}" notes must be a string`);
  }
  if (sourceDigest !== undefined && typeof sourceDigest !== 'string') {
    throw new Error(`BaselineRegistry.fromJSON: version "${version}" sourceDigest must be a string when present`);
  }
  return {
    version,
    flags: [...(flags as string[])],
    parent,
    createdAt,
    sourceWaveId,
    notes,
    ...(sourceDigest !== undefined ? { sourceDigest } : {}),
  };
}

function parseAnchor(value: unknown): BenchmarkAnchor {
  if (typeof value !== 'object' || value === null) {
    throw new Error('BaselineRegistry.fromJSON: expected an anchor object');
  }
  const record = value as Record<string, unknown>;
  const anchorId = record['anchorId'];
  const kind = record['kind'];
  const baselineVersion = record['baselineVersion'];

  if (typeof anchorId !== 'string' || anchorId.length === 0) {
    throw new Error('BaselineRegistry.fromJSON: anchorId must be a non-empty string');
  }
  if (kind !== 'random' && kind !== 'heuristic' && kind !== 'baseline') {
    throw new Error(`BaselineRegistry.fromJSON: anchor "${anchorId}" kind must be random|heuristic|baseline`);
  }
  if (kind === 'baseline') {
    if (typeof baselineVersion !== 'string' || baselineVersion.length === 0) {
      throw new Error(
        `BaselineRegistry.fromJSON: anchor "${anchorId}" has kind "baseline" but no baselineVersion string`,
      );
    }
    return { anchorId, kind, baselineVersion };
  }
  if (baselineVersion !== undefined) {
    throw new Error(
      `BaselineRegistry.fromJSON: anchor "${anchorId}" has kind "${kind}" and must not declare baselineVersion`,
    );
  }
  return { anchorId, kind };
}
