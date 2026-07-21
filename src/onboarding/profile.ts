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
}

export interface GameProfileExistingAiLocation {
  readonly path: string;
  readonly description: string;
}

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
  return {
    id: requireString(obj, 'id', `${path}.id`),
    description: requireString(obj, 'description', `${path}.description`),
    hiddenInfoVisible: requireString(
      obj,
      'hiddenInfoVisible',
      `${path}.hiddenInfoVisible`,
    ),
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
  return {
    id: requireString(obj, 'id', `${path}.id`),
    description: requireString(obj, 'description', `${path}.description`),
    hiddenFrom: requireString(obj, 'hiddenFrom', `${path}.hiddenFrom`),
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
