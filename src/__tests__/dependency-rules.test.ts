/**
 * Mechanical enforcement of the layer dependency rules (DESIGN.md §1) and the
 * determinism rule. Rules that exist only as prose get broken as the codebase
 * grows — this test makes every violation a red build.
 *
 * Allowed import edges (directory → directories it may import from):
 *   contract   → (nothing)
 *   kernel     → contract
 *   loop       → contract, kernel
 *   onboarding → contract, kernel, loop
 *   artifacts  → contract, kernel, loop
 *   reference  → contract, kernel        (the reference GAME must stay a pure adapter)
 *   search     → contract, kernel        (MCTS/UCT — docs/GAP-ANALYSIS-7.md O5; runners import it directly, adapters never do)
 *   learn      → contract, kernel        (MCCFR — docs/GAP-ANALYSIS-7.md O7; runners import it directly, adapters never do)
 *
 * reference/demo.ts is the app boundary and exempt (it wires every layer).
 * Any file under reference/runners/ is also an app boundary — per-game
 * execution entrypoints (H5/H7) that wire every layer and persist state, one
 * per gameId, without requiring a new literal exemption per game.
 * Test files (__tests__) are exempt from layer rules but not from determinism.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..');

const LAYER_ALLOWED: Record<string, readonly string[]> = {
  contract: [],
  kernel: ['contract'],
  loop: ['contract', 'kernel'],
  onboarding: ['contract', 'kernel', 'loop'],
  artifacts: ['contract', 'kernel', 'loop'],
  reference: ['contract', 'kernel'],
  search: ['contract', 'kernel'],
  learn: ['contract', 'kernel'],
};

const APP_BOUNDARY_FILES = new Set(['reference/demo.ts']);
const APP_BOUNDARY_PREFIXES = ['reference/runners/'];

function isAppBoundary(relPath: string): boolean {
  return APP_BOUNDARY_FILES.has(relPath) || APP_BOUNDARY_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/** Files allowed to use wall-clock/system randomness (app boundary only). */
const DETERMINISM_EXEMPT = new Set(['reference/demo.ts']);

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function relative(file: string): string {
  return path.relative(SRC, file).split(path.sep).join('/');
}

function layerOf(relPath: string): string | null {
  const top = relPath.split('/')[0];
  return top !== undefined && top in LAYER_ALLOWED ? top : null;
}

function isTestFile(relPath: string): boolean {
  return relPath.includes('__tests__/');
}

function importedLayers(file: string): Array<{ line: string; layer: string }> {
  const source = fs.readFileSync(file, 'utf8');
  const results: Array<{ line: string; layer: string }> = [];
  const importPattern = /(?:import|export)[^'"]*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(source)) !== null) {
    const spec = match[1];
    if (spec === undefined || !spec.startsWith('.')) continue;
    const resolved = relative(path.resolve(path.dirname(file), spec));
    const layer = layerOf(resolved);
    if (layer !== null) results.push({ line: match[0], layer });
  }
  return results;
}

const allFiles = walk(SRC).map(relative);

describe('layer dependency rules (DESIGN.md)', () => {
  const productionFiles = allFiles.filter(
    (file) => !isTestFile(file) && !isAppBoundary(file) && layerOf(file) !== null,
  );

  it.each(productionFiles)('%s imports only from allowed layers', (relPath) => {
    const ownLayer = layerOf(relPath) as string;
    const allowed = new Set([ownLayer, ...(LAYER_ALLOWED[ownLayer] ?? [])]);
    const violations = importedLayers(path.join(SRC, relPath)).filter(
      (imported) => !allowed.has(imported.layer),
    );
    expect(violations).toEqual([]);
  });

  it('no layer above contract imports from reference (game knowledge must not leak up)', () => {
    const nonReference = allFiles.filter(
      (file) => !isTestFile(file) && layerOf(file) !== null && layerOf(file) !== 'reference',
    );
    for (const relPath of nonReference) {
      const violations = importedLayers(path.join(SRC, relPath)).filter(
        (imported) => imported.layer === 'reference',
      );
      expect({ file: relPath, violations }).toEqual({ file: relPath, violations: [] });
    }
  });
});

describe('determinism rule (no wall clock / system randomness outside the app boundary)', () => {
  const checkedFiles = allFiles.filter(
    (file) =>
      !DETERMINISM_EXEMPT.has(file) &&
      !APP_BOUNDARY_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
      !isTestFile(file),
  );

  it.each(checkedFiles)('%s does not call Date.now or Math.random', (relPath) => {
    const source = fs.readFileSync(path.join(SRC, relPath), 'utf8');
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      // Strip string literals so remediation/guide text mentioning the banned
      // APIs does not trip the check — only actual code calls should match.
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    expect(stripped).not.toMatch(/\bDate\.now\s*\(/);
    expect(stripped).not.toMatch(/\bMath\.random\s*\(/);
    expect(stripped).not.toMatch(/new Date\s*\(\s*\)/);
  });
});
