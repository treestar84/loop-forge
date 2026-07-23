/**
 * Pure game classification: derives structural categories from a GameSpec
 * (and optional content inventory) so the kernel can assemble pipeline
 * configuration instead of requiring every adapter author to hand-tune
 * constants in demo.ts. No randomness, no time — classification must be a
 * pure function of its inputs (see docs/HANDOFF-2026-07-21.md §5).
 */

import type { GameSpec } from '../contract/types';

export type MatchStructure = 'two-player' | 'team' | 'ffa';
export type InformationStructure = 'perfect' | 'hidden';
export type ScoreStructure = 'win-loss-only' | 'scored';
export type ContentWeight = 'none' | 'light' | 'heavy';
export type DecisionMagnitude = 'short' | 'long';
export type UtilityStructure = 'zero-sum' | 'general';

export interface GameClassification {
  readonly matchStructure: MatchStructure;
  readonly identityCenter: number; // 1/teamCount or 1/playerCount
  readonly informationStructure: InformationStructure;
  readonly scoreStructure: ScoreStructure;
  readonly contentWeight: ContentWeight;
  readonly decisionMagnitude: DecisionMagnitude;
  /** Whether spec.scoreMargin was explicitly declared (vs. defaulted). */
  readonly scoreMarginDeclared: boolean;
  /** 'zero-sum' only when spec.utility is explicitly declared as such — never
   * inferred from playerCount/win-loss shape, even for a 2-player game. */
  readonly utilityStructure: UtilityStructure;
  /** Whether spec.utility was explicitly declared (vs. defaulted to 'general'). */
  readonly utilityDeclared: boolean;
}

/** Content inventory length at or above which contentWeight is 'heavy'. */
export const CONTENT_WEIGHT_HEAVY_THRESHOLD = 50;

/** maxDecisionsPerGame at or above which decisionMagnitude is 'long' —
 * empirically, sample-size problems in wave-runner appeared around ~80
 * decisions/game (docs/HANDOFF-2026-07-21.md). */
export const DECISION_MAGNITUDE_LONG_THRESHOLD = 80;

function classifyMatchStructure(spec: GameSpec): MatchStructure {
  if (spec.teams) {
    return 'team';
  }
  return spec.playerCount === 2 ? 'two-player' : 'ffa';
}

function classifyContentWeight(
  contentInventory?: ReadonlyArray<{ id: string }>,
): ContentWeight {
  const count = contentInventory?.length ?? 0;
  if (count === 0) {
    return 'none';
  }
  return count >= CONTENT_WEIGHT_HEAVY_THRESHOLD ? 'heavy' : 'light';
}

export function classifyGame(
  spec: GameSpec,
  contentInventory?: ReadonlyArray<{ id: string }>,
): GameClassification {
  const identityCenter = spec.teams
    ? 1 / spec.teams.length
    : 1 / spec.playerCount;

  return {
    matchStructure: classifyMatchStructure(spec),
    identityCenter,
    informationStructure: spec.perfectInformation === true ? 'perfect' : 'hidden',
    scoreStructure: spec.scoreMargin === 'none' ? 'win-loss-only' : 'scored',
    contentWeight: classifyContentWeight(contentInventory),
    decisionMagnitude:
      spec.maxDecisionsPerGame >= DECISION_MAGNITUDE_LONG_THRESHOLD ? 'long' : 'short',
    scoreMarginDeclared: spec.scoreMargin !== undefined,
    utilityStructure: spec.utility === 'zero-sum' ? 'zero-sum' : 'general',
    utilityDeclared: spec.utility !== undefined,
  };
}
