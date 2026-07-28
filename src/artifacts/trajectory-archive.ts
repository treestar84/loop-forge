/**
 * Trajectory/probe-bank persistence (docs/GAP-ANALYSIS-11.md D4). Trajectory
 * archives are JSONL (one match per line) — determinism means
 * `(gameSeed, seats, choices)` alone reproduces a whole match byte-for-byte
 * by replay, so "아카이브는 가볍게, 분석은 재생으로": no need for a
 * structured store, a flat append-friendly line format is enough. Probe
 * banks are small and read-mostly, so they're a single sealed JSON file
 * instead.
 *
 * fs usage is confined to this file within the artifacts layer, matching the
 * existing game-state.ts/run-store.ts style.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { sha256Digest } from '../kernel/digest';
import type { MatchTrajectoryRecord } from '../loop/paired-match';
import type { ProbePosition } from '../loop/probe-bank';

/**
 * Write `records` as JSONL to `<dir>/trajectories.jsonl` (creating `dir` if
 * needed) and return the file's path.
 */
export function saveTrajectories(
  dir: string,
  records: readonly MatchTrajectoryRecord[],
): string {
  const filePath = `${dir}/trajectories.jsonl`;
  mkdirSync(dir, { recursive: true });
  const lines = records.map((record) => JSON.stringify(record));
  writeFileSync(filePath, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
  return filePath;
}

/** Read a JSONL trajectory archive written by saveTrajectories. Blank
 * trailing lines (from the file's terminal newline) are ignored. */
export function loadTrajectories(file: string): MatchTrajectoryRecord[] {
  const content = readFileSync(file, 'utf8');
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MatchTrajectoryRecord);
}

interface SealedProbeBank {
  readonly probes: readonly ProbePosition[];
  readonly seal: string;
}

function probeBankSeal(probes: readonly ProbePosition[]): string {
  return sha256Digest(probes);
}

/**
 * Write a probe bank as a single JSON file, sealed with a sha256 digest over
 * `probes` (kernel/digest's canonical-JSON scheme) so a later load can
 * detect accidental hand-editing or truncation. Returns the file path.
 */
export function saveProbeBank(file: string, probes: readonly ProbePosition[]): string {
  mkdirSync(dirname(file), { recursive: true });
  const sealed: SealedProbeBank = { probes, seal: probeBankSeal(probes) };
  writeFileSync(file, JSON.stringify(sealed, null, 2), 'utf8');
  return file;
}

/** Load a probe bank written by saveProbeBank, throwing if its seal no
 * longer matches its contents. */
export function loadProbeBank(file: string): readonly ProbePosition[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as SealedProbeBank;
  const expectedSeal = probeBankSeal(parsed.probes);
  if (parsed.seal !== expectedSeal) {
    throw new Error(
      `loadProbeBank: seal mismatch for "${file}" (expected ${expectedSeal}, found ${parsed.seal}) — file may be corrupted or hand-edited`,
    );
  }
  return parsed.probes;
}
