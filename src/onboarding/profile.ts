/**
 * GameProfile — the G-Profile stage artifact (DESIGN.md §3).
 *
 * A structured inventory of a game project produced by a human or coding
 * agent reading the game's source: phase structure, decision points,
 * randomness sources, hidden information boundaries, outcome rule, existing
 * AI locations, and UI/network coupling notes. `parseGameProfile` is a
 * strict validator over `unknown` input (e.g. parsed JSON) that throws with
 * a field-specific message on the first violation found.
 */

export interface GameProfilePhase {
  readonly id: string;
  readonly description: string;
}

export interface GameProfileDecisionPoint {
  readonly id: string;
  readonly description: string;
  /** What hidden information (if any) is visible to the decider at this point. */
  readonly hiddenInfoVisible: string;
  /**
   * P3 (GAP-ANALYSIS-13 §2.5): whether this decision point's action space is
   * a finite enumerable set of choices (representable by `getLegalChoices`)
   * as opposed to free-text/continuous input. Optional — omitted is scored
   * conservatively (treated as non-enumerable) since undeclared decision
   * points are the more common failure mode (free-form negotiation, etc.).
   */
  readonly enumerable?: boolean;
}

export interface GameProfileRandomnessSource {
  readonly id: string;
  readonly description: string;
  readonly seedable: boolean;
}

export interface GameProfileHiddenInformation {
  readonly id: string;
  readonly description: string;
  readonly hiddenFrom: string;
  /**
   * P4 (GAP-ANALYSIS-13 §2.5): whether `hiddenFrom` names a concrete,
   * specific boundary (a player role, "all opponents", etc.) rather than a
   * vague placeholder. Optional — omitted is scored conservatively (treated
   * as not explicit).
   */
  readonly boundaryExplicit?: boolean;
}

export interface GameProfileExistingAiLocation {
  readonly path: string;
  readonly description: string;
}

/**
 * P1 scope gate answers (GAP-ANALYSIS-13 §2.5, ONBOARDING-GUIDE.md §0's
 * excluded-family table). Each flag maps 1:1 to one excluded row; omitted
 * defaults to "in scope" (`true`) since most games never need to declare
 * this — only a profile for an excluded genre sets one to `false`.
 */
export type ReferenceImplementationCompleteness =
  | 'full-code'
  | 'partial'
  | 'document-only';

export type UiCouplingSeverity = 'none' | 'low' | 'medium' | 'high';

export interface GameProfile {
  readonly gameId: string;
  /** One-line description of the game. */
  readonly summary: string;
  readonly playerCount: number;
  readonly phases: readonly GameProfilePhase[];
  readonly decisionPoints: readonly GameProfileDecisionPoint[];
  readonly randomnessSources: readonly GameProfileRandomnessSource[];
  readonly hiddenInformation: readonly GameProfileHiddenInformation[];
  readonly outcomeRule: string;
  readonly existingAiLocations: readonly GameProfileExistingAiLocation[];
  readonly uiCouplingNotes: readonly string[];
  readonly knownIssues: readonly string[];

  /** P1 gate — 실시간·신체(덱스터리티) 게임 제외 질문. Default: true. */
  readonly turnBased?: boolean;
  /** P1 gate — 1인/협력 게임 제외 질문. Default: true. */
  readonly competitive?: boolean;
  /** P1 gate — 레거시/캠페인(게임 간 영속 상태) 제외 질문. Default: true. */
  readonly independentGames?: boolean;
  /** P1 gate — 자유 대화 협상(구조화 불가능한 행동 공간) 제외 질문. Default: true. */
  readonly decisionsStructurable?: boolean;

  /**
   * P5 (GAP-ANALYSIS-13 §2.5): a non-empty description of the game's finite
   * termination guarantee (turn cap, no-progress draw rule, etc.), verified
   * against the source rather than assumed from `outcomeRule`. Optional —
   * omitted is scored conservatively as "no guarantee verified" (GAP-4 Z7).
   */
  readonly terminationGuarantee?: string;

  /**
   * P6 (GAP-ANALYSIS-13 §2.5): overall severity of rule/UI coupling implied
   * by `uiCouplingNotes`. Optional — if notes are non-empty and this is
   * omitted, scored conservatively as 'high'.
   */
  readonly uiCouplingSeverity?: UiCouplingSeverity;

  /**
   * P7 (GAP-ANALYSIS-13 §2.5): how complete the reference implementation is.
   * Optional — omitted is scored conservatively as 'document-only'.
   */
  readonly referenceImplementation?: ReferenceImplementationCompleteness;
}

class ProfileValidationError extends Error {}

function fail(field: string, reason: string): never {
  throw new ProfileValidationError(
    `GameProfile field "${field}" is invalid: ${reason}`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `field` is the property key to read off `container`; `path` is the
 * (possibly nested, e.g. "decisionPoints[0].id") name reported on failure.
 * They differ only for nested objects — top-level callers pass the same
 * string for both.
 */
function requireString(
  container: Record<string, unknown>,
  field: string,
  path: string = field,
): string {
  const value = container[field];
  if (typeof value !== 'string' || value.length === 0) {
    fail(path, `expected a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value as string;
}

function requireNumber(
  container: Record<string, unknown>,
  field: string,
  path: string = field,
): number {
  const value = container[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, `expected a finite number, got ${JSON.stringify(value)}`);
  }
  return value as number;
}

function requireBoolean(
  container: Record<string, unknown>,
  field: string,
  path: string = field,
): boolean {
  const value = container[field];
  if (typeof value !== 'boolean') {
    fail(path, `expected a boolean, got ${JSON.stringify(value)}`);
  }
  return value as boolean;
}

function requireArray(
  container: Record<string, unknown>,
  field: string,
  path: string = field,
): unknown[] {
  const value = container[field];
  if (!Array.isArray(value)) {
    fail(path, `expected an array, got ${JSON.stringify(value)}`);
  }
  return value as unknown[];
}

/** Optional boolean field: undefined if absent, validated if present. */
function optionalBoolean(
  container: Record<string, unknown>,
  field: string,
  path: string = field,
): boolean | undefined {
  const value = container[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    fail(path, `expected a boolean or undefined, got ${JSON.stringify(value)}`);
  }
  return value as boolean;
}

/** Optional non-empty-string field: undefined if absent, validated if present. */
function optionalString(
  container: Record<string, unknown>,
  field: string,
  path: string = field,
): string | undefined {
  const value = container[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    fail(path, `expected a non-empty string or undefined, got ${JSON.stringify(value)}`);
  }
  return value as string;
}

/** Optional field restricted to a fixed set of string literals. */
function optionalEnum<T extends string>(
  container: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  path: string = field,
): T | undefined {
  const value = container[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(
      path,
      `expected one of ${JSON.stringify(allowed)} or undefined, got ${JSON.stringify(value)}`,
    );
  }
  return value as T;
}

function requireStringArray(
  container: Record<string, unknown>,
  field: string,
): string[] {
  const array = requireArray(container, field);
  return array.map((item, index) => {
    if (typeof item !== 'string') {
      fail(`${field}[${index}]`, `expected a string, got ${JSON.stringify(item)}`);
    }
    return item as string;
  });
}

function parsePhase(value: unknown, index: number): GameProfilePhase {
  const path = `phases[${index}]`;
  if (!isPlainObject(value)) {
    fail(path, `expected an object, got ${JSON.stringify(value)}`);
  }
  const obj = value as Record<string, unknown>;
  return {
    id: requireString(obj, 'id', `${path}.id`),
    description: requireString(obj, 'description', `${path}.description`),
  };
}

function parseDecisionPoint(
  value: unknown,
  index: number,
): GameProfileDecisionPoint {
  const path = `decisionPoints[${index}]`;
  if (!isPlainObject(value)) {
    fail(path, `expected an object, got ${JSON.stringify(value)}`);
  }
  const obj = value as Record<string, unknown>;
  const enumerable = optionalBoolean(obj, 'enumerable', `${path}.enumerable`);
  return {
    id: requireString(obj, 'id', `${path}.id`),
    description: requireString(obj, 'description', `${path}.description`),
    hiddenInfoVisible: requireString(
      obj,
      'hiddenInfoVisible',
      `${path}.hiddenInfoVisible`,
    ),
    ...(enumerable !== undefined ? { enumerable } : {}),
  };
}

function parseRandomnessSource(
  value: unknown,
  index: number,
): GameProfileRandomnessSource {
  const path = `randomnessSources[${index}]`;
  if (!isPlainObject(value)) {
    fail(path, `expected an object, got ${JSON.stringify(value)}`);
  }
  const obj = value as Record<string, unknown>;
  return {
    id: requireString(obj, 'id', `${path}.id`),
    description: requireString(obj, 'description', `${path}.description`),
    seedable: requireBoolean(obj, 'seedable', `${path}.seedable`),
  };
}

function parseHiddenInformation(
  value: unknown,
  index: number,
): GameProfileHiddenInformation {
  const path = `hiddenInformation[${index}]`;
  if (!isPlainObject(value)) {
    fail(path, `expected an object, got ${JSON.stringify(value)}`);
  }
  const obj = value as Record<string, unknown>;
  const boundaryExplicit = optionalBoolean(
    obj,
    'boundaryExplicit',
    `${path}.boundaryExplicit`,
  );
  return {
    id: requireString(obj, 'id', `${path}.id`),
    description: requireString(obj, 'description', `${path}.description`),
    hiddenFrom: requireString(obj, 'hiddenFrom', `${path}.hiddenFrom`),
    ...(boundaryExplicit !== undefined ? { boundaryExplicit } : {}),
  };
}

function parseExistingAiLocation(
  value: unknown,
  index: number,
): GameProfileExistingAiLocation {
  const path = `existingAiLocations[${index}]`;
  if (!isPlainObject(value)) {
    fail(path, `expected an object, got ${JSON.stringify(value)}`);
  }
  const obj = value as Record<string, unknown>;
  return {
    path: requireString(obj, 'path', `${path}.path`),
    description: requireString(obj, 'description', `${path}.description`),
  };
}

/**
 * Strictly validate `value` as a GameProfile. Throws with a message naming
 * the offending field and why on the first violation found. Empty arrays are
 * permitted for every list field.
 */
export function parseGameProfile(value: unknown): GameProfile {
  if (!isPlainObject(value)) {
    fail('<root>', `expected an object, got ${JSON.stringify(value)}`);
  }
  const obj = value as Record<string, unknown>;

  const gameId = requireString(obj, 'gameId');
  const summary = requireString(obj, 'summary');
  const playerCount = requireNumber(obj, 'playerCount');
  if (!Number.isInteger(playerCount) || playerCount < 1) {
    fail('playerCount', `expected a positive integer, got ${playerCount}`);
  }

  const phases = requireArray(obj, 'phases').map((item, index) =>
    parsePhase(item, index),
  );
  const decisionPoints = requireArray(obj, 'decisionPoints').map((item, index) =>
    parseDecisionPoint(item, index),
  );
  const randomnessSources = requireArray(obj, 'randomnessSources').map(
    (item, index) => parseRandomnessSource(item, index),
  );
  const hiddenInformation = requireArray(obj, 'hiddenInformation').map(
    (item, index) => parseHiddenInformation(item, index),
  );
  const outcomeRule = requireString(obj, 'outcomeRule');
  const existingAiLocations = requireArray(obj, 'existingAiLocations').map(
    (item, index) => parseExistingAiLocation(item, index),
  );
  const uiCouplingNotes = requireStringArray(obj, 'uiCouplingNotes');
  const knownIssues = requireStringArray(obj, 'knownIssues');

  const turnBased = optionalBoolean(obj, 'turnBased');
  const competitive = optionalBoolean(obj, 'competitive');
  const independentGames = optionalBoolean(obj, 'independentGames');
  const decisionsStructurable = optionalBoolean(obj, 'decisionsStructurable');
  const terminationGuarantee = optionalString(obj, 'terminationGuarantee');
  const uiCouplingSeverity = optionalEnum(obj, 'uiCouplingSeverity', [
    'none',
    'low',
    'medium',
    'high',
  ] as const);
  const referenceImplementation = optionalEnum(obj, 'referenceImplementation', [
    'full-code',
    'partial',
    'document-only',
  ] as const);

  return {
    gameId,
    summary,
    playerCount,
    phases,
    decisionPoints,
    randomnessSources,
    hiddenInformation,
    outcomeRule,
    existingAiLocations,
    uiCouplingNotes,
    knownIssues,
    ...(turnBased !== undefined ? { turnBased } : {}),
    ...(competitive !== undefined ? { competitive } : {}),
    ...(independentGames !== undefined ? { independentGames } : {}),
    ...(decisionsStructurable !== undefined ? { decisionsStructurable } : {}),
    ...(terminationGuarantee !== undefined ? { terminationGuarantee } : {}),
    ...(uiCouplingSeverity !== undefined ? { uiCouplingSeverity } : {}),
    ...(referenceImplementation !== undefined ? { referenceImplementation } : {}),
  };
}

/**
 * Warnings for an otherwise-valid profile. A `randomnessSources` entry with
 * `seedable: false` does not make the profile invalid, but it does mean C1
 * (determinism) cannot be satisfied for that source, so it's surfaced here.
 */
export function profileWarnings(profile: GameProfile): string[] {
  const warnings: string[] = [];
  for (const source of profile.randomnessSources) {
    if (!source.seedable) {
      warnings.push(
        `randomnessSources: "${source.id}" is not seedable (${source.description}) — ` +
          `determinism (C1) cannot be guaranteed while this source is in use.`,
      );
    }
  }
  return warnings;
}
