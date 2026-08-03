/**
 * Self-verification for src/onboarding/scaffold.ts (docs/GAP-ANALYSIS-13.md
 * §3 S2). Three things are checked, per the task's own verification plan:
 *
 *   1. Structural validity of generated adapter/runner source — NOT a real
 *      `tsc --noEmit` run. A full `tsc` invocation per archetype (4x) would
 *      need to write each generated file into `src/reference/` (or a
 *      parallel `include` root) and run the whole-project compiler each
 *      time, which is exactly the kind of heavy per-test cost
 *      docs/TROUBLESHOOTING.md §12 warns against accumulating (~30s budget
 *      for the whole suite, already at ~46s before this file). Structural
 *      checks — every GameAdapter-required member present, every declared
 *      import resolvable by name, every TODO marker well-formed — catch the
 *      same class of "didn't generate a complete skeleton" mistake a
 *      compile would, without the cost. The real compiler is run once,
 *      manually, outside the automated suite (docs/GAP-ANALYSIS-13.md §8's
 *      "실전 검증" step) — not repeated on every `npm test`.
 *   2. Every `TODO(onboard)` marker in generated output matches the
 *      `TODO(onboard): §2-<n>` format and names a real G_CONVERT_CHECKLIST
 *      id.
 *   3. `deriveArchetypes` matches §3 S2's table for representative
 *      profiles of each archetype (and their compositions).
 */

import type { GameProfile } from '../profile';
import {
  deriveArchetypes,
  G_CONVERT_CHECKLIST,
  renderAdapterScaffold,
  renderRunnerScaffold,
} from '../scaffold';

function baseProfile(overrides: Partial<GameProfile>): GameProfile {
  return {
    gameId: 'sample-game',
    summary: 'A sample game for scaffold testing.',
    playerCount: 2,
    phases: [{ id: 'main', description: 'Main phase.' }],
    decisionPoints: [{ id: 'move', description: 'Make a move.', hiddenInfoVisible: 'none' }],
    randomnessSources: [],
    hiddenInformation: [],
    outcomeRule: 'Most points wins.',
    existingAiLocations: [],
    uiCouplingNotes: [],
    knownIssues: [],
    ...overrides,
  };
}

const perfectInfoProfile = baseProfile({
  gameId: 'connect-four-clone',
  decisionPoints: [{ id: 'drop', description: 'Drop a disc into a column.', hiddenInfoVisible: 'none' }],
});

const hiddenInfoProfile = baseProfile({
  gameId: 'card-duel',
  hiddenInformation: [
    { id: 'hand', description: 'Hand contents.', hiddenFrom: 'opponent', boundaryExplicit: true },
  ],
});

const multiStepProfile = baseProfile({
  gameId: 'gem-collector',
  decisionPoints: [
    { id: 'takeGems', description: 'Take up to 3 gems.', hiddenInfoVisible: 'none' },
    { id: 'reserveCard', description: 'Reserve a card.', hiddenInfoVisible: 'none' },
    { id: 'purchaseCard', description: 'Purchase a card.', hiddenInfoVisible: 'none' },
  ],
});

const contentHeavyProfile = baseProfile({
  gameId: 'card-battler',
  knownIssues: [
    'Only 40 of 300 cards implemented.',
    'Legendary card effects not yet modeled.',
  ],
});

describe('deriveArchetypes', () => {
  it('perfect-info: empty hiddenInformation -> perfect-info, not hidden-info', () => {
    const result = deriveArchetypes(perfectInfoProfile);
    expect(result.archetypes).toContain('perfect-info');
    expect(result.archetypes).not.toContain('hidden-info');
    expect(result.reasons).toHaveLength(result.archetypes.length);
  });

  it('hidden-info: non-empty hiddenInformation -> hidden-info, not perfect-info', () => {
    const result = deriveArchetypes(hiddenInfoProfile);
    expect(result.archetypes).toContain('hidden-info');
    expect(result.archetypes).not.toContain('perfect-info');
  });

  it('multi-step-turn: 2+ decisionPoints -> multi-step-turn included', () => {
    const result = deriveArchetypes(multiStepProfile);
    expect(result.archetypes).toContain('multi-step-turn');
  });

  it('single decisionPoint does NOT trigger multi-step-turn', () => {
    const result = deriveArchetypes(perfectInfoProfile);
    expect(result.archetypes).not.toContain('multi-step-turn');
  });

  it('content-heavy: non-empty knownIssues -> content-heavy included', () => {
    const result = deriveArchetypes(contentHeavyProfile);
    expect(result.archetypes).toContain('content-heavy');
  });

  it('empty knownIssues does NOT trigger content-heavy', () => {
    const result = deriveArchetypes(perfectInfoProfile);
    expect(result.archetypes).not.toContain('content-heavy');
  });

  it('archetypes compose: a hidden-info + multi-step-turn + content-heavy profile gets all three plus the binary pick', () => {
    const composed = baseProfile({
      gameId: 'composed-game',
      hiddenInformation: [
        { id: 'hand', description: 'Hand.', hiddenFrom: 'opponent', boundaryExplicit: true },
      ],
      decisionPoints: [
        { id: 'a', description: 'A.', hiddenInfoVisible: 'none' },
        { id: 'b', description: 'B.', hiddenInfoVisible: 'none' },
      ],
      knownIssues: ['Some cards unimplemented.'],
    });
    const result = deriveArchetypes(composed);
    expect(new Set(result.archetypes)).toEqual(
      new Set(['hidden-info', 'multi-step-turn', 'content-heavy']),
    );
    expect(result.reasons).toHaveLength(3);
  });

  it('every reason string names the archetype it justifies', () => {
    const result = deriveArchetypes(multiStepProfile);
    result.archetypes.forEach((archetype, i) => {
      expect(result.reasons[i]).toContain(archetype);
    });
  });
});

const TODO_PATTERN = /TODO\(onboard\): (§2-\d+) — [^\n]+/g;

function extractTodoIds(source: string): string[] {
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  const pattern = new RegExp(TODO_PATTERN);
  while ((match = pattern.exec(source)) !== null) {
    ids.push(match[1] as string);
  }
  return ids;
}

describe('renderAdapterScaffold — TODO marker format (grep-ability, §2 checklist)', () => {
  const knownIds = new Set(G_CONVERT_CHECKLIST.map((c) => c.id));

  it.each([
    ['perfect-info', perfectInfoProfile],
    ['hidden-info', hiddenInfoProfile],
    ['multi-step-turn', multiStepProfile],
    ['content-heavy', contentHeavyProfile],
  ] as const)('%s scaffold: has TODO(onboard) markers, all §2-<n> format, all known ids', (_label, profile) => {
    const determination = deriveArchetypes(profile);
    const source = renderAdapterScaffold(profile, determination);

    // Every raw "TODO(onboard):" occurrence (colon required — the header's
    // instructional `grep -rn "TODO(onboard)"` example deliberately omits
    // the colon so it doesn't itself count as a marker) must match the
    // strict format — catches a marker that forgot the "§2-<n> — " suffix.
    const rawOccurrences = source.match(/TODO\(onboard\):/g) ?? [];
    const formatted = source.match(TODO_PATTERN) ?? [];
    expect(formatted.length).toBe(rawOccurrences.length);
    expect(formatted.length).toBeGreaterThan(0);

    const ids = extractTodoIds(source);
    for (const id of ids) {
      expect(knownIds.has(id)).toBe(true);
    }

    // grep-ability: the literal substring a human/CI would grep for.
    expect(source).toContain('TODO(onboard): §2-');
  });

  it('hidden-info archetype adds a §2-9 hiddenInfoProbe marker; perfect-info does not', () => {
    const hiddenSource = renderAdapterScaffold(hiddenInfoProfile, deriveArchetypes(hiddenInfoProfile));
    expect(hiddenSource).toContain('hiddenInfoProbe');
    expect(extractTodoIds(hiddenSource)).toContain('§2-9');

    const perfectSource = renderAdapterScaffold(perfectInfoProfile, deriveArchetypes(perfectInfoProfile));
    expect(perfectSource).not.toContain('const hiddenInfoProbe');
    expect(perfectSource).toContain('perfectInformation: true');
  });

  it('multi-step-turn archetype adds a §2-10 turn-internal-state comment', () => {
    const source = renderAdapterScaffold(multiStepProfile, deriveArchetypes(multiStepProfile));
    expect(extractTodoIds(source)).toContain('§2-10');
    expect(source).toContain('takenThisTurn');
  });

  it('content-heavy archetype adds a contentInventory/exercisedContent comment', () => {
    const source = renderAdapterScaffold(contentHeavyProfile, deriveArchetypes(contentHeavyProfile));
    expect(source).toContain('contentInventory');
    expect(source).toContain('exercisedContent');
  });
});

describe('renderAdapterScaffold — structural completeness (GameAdapter contract shape)', () => {
  const determination = deriveArchetypes(multiStepProfile);
  const source = renderAdapterScaffold(multiStepProfile, determination);

  it('declares every GameAdapter-required top-level member', () => {
    const requiredMembers = [
      'spec:',
      'createInitialState',
      'currentDecision',
      'getObservation',
      'getLegalChoices',
      'applyChoice',
      'getOutcome',
      'encodeChoice',
      'baselines:',
      'strategySurface:',
    ];
    for (const member of requiredMembers) {
      expect(source).toContain(member);
    }
  });

  it('imports only from ../contract/types and ../kernel/rng (reference layer allowance)', () => {
    const importPaths = [...source.matchAll(/from '([^']+)';/g)].map((m) => m[1]);
    expect(importPaths.length).toBeGreaterThan(0);
    for (const path of importPaths) {
      expect(['../contract/types', '../kernel/rng']).toContain(path);
    }
    expect(importPaths).toContain('../contract/types');
  });

  it('exports a <camelCase gameId>Adapter constant', () => {
    expect(source).toMatch(/export const gemCollectorAdapter: GameAdapter</);
  });

  it('embeds the archetype determination reasons in the header comment', () => {
    for (const reason of determination.reasons) {
      expect(source).toContain(reason);
    }
  });
});

describe('renderRunnerScaffold — pipeline-caller shape (~40 lines, no hand-rolled 6-stage logic)', () => {
  const source = renderRunnerScaffold(perfectInfoProfile);

  it('calls runOnboardingPipeline instead of reimplementing its stages', () => {
    expect(source).toContain("from '../../artifacts/onboarding-pipeline'");
    expect(source).toContain('runOnboardingPipeline(');
  });

  it('calls scoreAdapter + evaluateWaveReadiness before the pipeline (conformance gate)', () => {
    expect(source).toContain('scoreAdapter(');
    expect(source).toContain('evaluateWaveReadiness(');
    const conformanceIndex = source.indexOf('scoreAdapter(');
    const pipelineIndex = source.indexOf('runOnboardingPipeline(');
    expect(conformanceIndex).toBeGreaterThan(-1);
    expect(pipelineIndex).toBeGreaterThan(conformanceIndex);
  });

  it('carries no TODO(onboard) markers (all unfilled slots are non-§2 numeric config)', () => {
    expect(source).not.toContain('TODO(onboard)');
  });

  it('is roughly ~40 lines of actual code (generous upper bound, doc comment excluded)', () => {
    const lines = source.split('\n');
    const docCommentEnd = lines.findIndex((line) => line.trim() === '*/');
    const codeLines = lines
      .slice(docCommentEnd + 1)
      .filter((line) => line.trim().length > 0);
    expect(codeLines.length).toBeLessThanOrEqual(70);
  });

  it("references this game's adapter import path", () => {
    expect(source).toContain("from '../connect-four-clone'");
  });
});
