/**
 * Source closure digest: an approximate seal over "the code that decided how
 * a baseline version's flags behave", so a baseline registry can flag when a
 * flag's underlying implementation has drifted since the version was
 * registered (docs/GAP-ANALYSIS-8.md §2 — search/mcts.ts's P5 tie-break fix
 * silently changed mcts-s64's reassembly behavior with no way to detect it
 * from the version record, which stored only flag names).
 *
 * Deliberately an *approximation*, not a hermetic build seal: it hashes the
 * TypeScript source files as they sit on disk, not the transpiled output nor
 * the dependency closure of any library those files import (node_modules,
 * the TypeScript/ts-node toolchain, etc.). That's out of scope here — the
 * goal is "did the game-relevant source change", not full build
 * reproducibility, and file-level hashing is enough to catch the P5-style
 * silent-behavior-change case this was built for.
 *
 * The caller supplies the file list rather than this module inferring it
 * (e.g. by walking imports) so that game-specific knowledge — which files
 * are "this game's" adapter, search config, shared flag spec, etc. — stays
 * in the app-boundary runner that already owns that knowledge
 * (reference/runners/*.ts), and never leaks into the artifacts layer. This
 * keeps the layer rule intact (src/__tests__/dependency-rules.test.ts):
 * artifacts stays a generic, game-agnostic persistence/reporting layer that
 * happens to also do file hashing, not a place that knows what "gomoku's
 * source files" are.
 */

import { readFileSync } from 'node:fs';

import { sha256Digest } from '../kernel/digest';

/**
 * Hash of the given files' contents, seals over both file identity and
 * content: sorts paths first (so caller-supplied order never affects the
 * digest), then concatenates `<relPath>\n<content>` per file before sealing
 * with kernel/digest's sha256Digest. Caller is expected to pass paths that
 * are already meaningfully comparable across runs (e.g. all relative to the
 * repo root, or all absolute) — this function does not normalize them.
 */
export function computeSourceDigest(filePaths: readonly string[]): string {
  const sortedPaths = [...filePaths].sort();
  const parts = sortedPaths.map((filePath) => {
    const content = readFileSync(filePath, 'utf8');
    return `${filePath}\n${content}`;
  });
  return sha256Digest(parts.join('\n---\n'));
}
