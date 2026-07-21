/**
 * Run store: on-disk persistence for every scored/calibrated/wave/benchmark
 * execution (GAP-ANALYSIS.md C1). Each run gets
 * `rootDir/runs/<gameId>/<runId>/` holding a canonical-JSON envelope, its
 * digest, a human-readable Markdown report, and any SVGs. Namespacing by
 * gameId keeps two games from colliding on the same runId (GAP-ANALYSIS-5.md
 * H6). Runs are append-only — re-saving an existing (gameId, runId) pair
 * throws, mirroring the seed ledger's single-reservation philosophy so
 * evidence can't be silently overwritten.
 *
 * Timestamps are the one thing this module never generates itself: kernel
 * and loop code must stay Date.now()-free, and this artifact layer is an app
 * boundary, so every timestamp is a required caller-supplied parameter.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, sha256Digest } from '../kernel/digest';

export type RunKind = 'conformance' | 'calibration' | 'wave' | 'benchmark';

export interface SaveRunSvg {
  readonly name: string;
  readonly content: string;
}

export interface SaveRunInput {
  readonly gameId: string;
  readonly runId: string;
  readonly kind: RunKind;
  readonly recordedAt: string;
  readonly comparabilityKey: string;
  readonly payload: unknown;
  readonly markdown: string;
  readonly svg?: readonly SaveRunSvg[];
}

export interface RunSummary {
  readonly gameId: string;
  readonly runId: string;
  readonly kind: RunKind;
  readonly recordedAt: string;
  readonly comparabilityKey: string;
}

export interface LoadedRun {
  readonly gameId: string;
  readonly runId: string;
  readonly kind: RunKind;
  readonly recordedAt: string;
  readonly comparabilityKey: string;
  readonly payload: unknown;
  readonly markdown: string;
}

interface RunEnvelope {
  readonly gameId: string;
  readonly runId: string;
  readonly kind: RunKind;
  readonly recordedAt: string;
  readonly comparabilityKey: string;
  readonly payload: unknown;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validatePathSegment(label: string, value: string): void {
  if (!RUN_ID_PATTERN.test(value)) {
    throw new Error(
      `RunStore: ${label} "${value}" must match ${RUN_ID_PATTERN.source} (no path separators)`,
    );
  }
}

function validateRunId(runId: string): void {
  validatePathSegment('runId', runId);
}

function validateGameId(gameId: string): void {
  validatePathSegment('gameId', gameId);
}

export class RunStore {
  constructor(private readonly rootDir: string) {}

  private runsDir(): string {
    return join(this.rootDir, 'runs');
  }

  private runDir(gameId: string, runId: string): string {
    return join(this.runsDir(), gameId, runId);
  }

  saveRun(input: SaveRunInput): void {
    validateGameId(input.gameId);
    validateRunId(input.runId);
    const dir = this.runDir(input.gameId, input.runId);
    if (existsSync(dir)) {
      throw new Error(
        `RunStore: run "${input.runId}" already exists for game "${input.gameId}" (runs are append-only)`,
      );
    }

    const envelope: RunEnvelope = {
      gameId: input.gameId,
      runId: input.runId,
      kind: input.kind,
      recordedAt: input.recordedAt,
      comparabilityKey: input.comparabilityKey,
      payload: input.payload,
    };
    const payloadJson = canonicalJson(envelope);
    const digest = sha256Digest(envelope);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'payload.json'), payloadJson, 'utf8');
    writeFileSync(join(dir, 'digest.txt'), digest, 'utf8');
    writeFileSync(join(dir, 'report.md'), input.markdown, 'utf8');
    for (const svg of input.svg ?? []) {
      writeFileSync(join(dir, svg.name), svg.content, 'utf8');
    }
  }

  listRuns(): readonly RunSummary[] {
    const dir = this.runsDir();
    if (!existsSync(dir)) {
      return [];
    }
    const gameIds = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const summaries: RunSummary[] = [];
    for (const gameId of gameIds) {
      const runIds = readdirSync(join(dir, gameId), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      for (const runId of runIds) {
        const envelope = this.readEnvelope(gameId, runId, { verify: false });
        summaries.push({
          gameId: envelope.gameId,
          runId: envelope.runId,
          kind: envelope.kind,
          recordedAt: envelope.recordedAt,
          comparabilityKey: envelope.comparabilityKey,
        });
      }
    }
    return summaries;
  }

  loadRun(gameId: string, runId: string): LoadedRun {
    validateGameId(gameId);
    validateRunId(runId);
    const envelope = this.readEnvelope(gameId, runId, { verify: true });
    const markdown = readFileSync(join(this.runDir(gameId, runId), 'report.md'), 'utf8');
    return {
      gameId: envelope.gameId,
      runId: envelope.runId,
      kind: envelope.kind,
      recordedAt: envelope.recordedAt,
      comparabilityKey: envelope.comparabilityKey,
      payload: envelope.payload,
      markdown,
    };
  }

  private readEnvelope(
    gameId: string,
    runId: string,
    options: { readonly verify: boolean },
  ): RunEnvelope {
    const dir = this.runDir(gameId, runId);
    if (!existsSync(dir)) {
      throw new Error(`RunStore: unknown run "${runId}" for game "${gameId}"`);
    }
    const payloadJson = readFileSync(join(dir, 'payload.json'), 'utf8');
    const envelope = JSON.parse(payloadJson) as RunEnvelope;

    if (options.verify) {
      const expectedDigest = readFileSync(join(dir, 'digest.txt'), 'utf8').trim();
      const actualDigest = sha256Digest(envelope);
      if (actualDigest !== expectedDigest) {
        throw new Error(
          `RunStore: digest mismatch for run "${runId}" (game "${gameId}") — recorded evidence has been tampered with or drifted (expected ${expectedDigest}, got ${actualDigest})`,
        );
      }
    }
    return envelope;
  }
}

// Canonical implementation lives in the kernel (layer rule: the wave runner in
// loop stamps every report with this key; loop → artifacts is forbidden).
export { computeComparabilityKey, type ComparabilityKeyInput } from '../kernel/comparability';
