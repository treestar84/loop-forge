/**
 * Pipeline blueprint assembly: turns a GameClassification into the concrete
 * threshold/sample-size values the loop engine and onboarding scorer need,
 * so game-specific tuning lives in one place instead of being hand-copied
 * into demo.ts per game (docs/HANDOFF-2026-07-21.md).
 */

import type { GameClassification } from './classify';
import { DEFAULT_CRITERIA } from './gates';
import { recommendBlockCount } from './paired-stats';

export interface PipelineBlueprint {
  readonly promotionMinWinRate: number;
  readonly promotionMinScoreDiff: number;
  readonly sprtNullHypothesis: number;
  readonly signalCollapseThreshold: number;
  readonly c2PlayoutCount: number;
  readonly c4MinDecisionsPerSecond: number;
  readonly c5IdentitySeedCount: number;
  readonly c5HeadToHeadSeedCount: number;
  readonly c3Required: boolean;
  readonly contentCoverageRequired: boolean;
  readonly benchmarkShowScoreDiff: boolean;
  readonly warnings: readonly string[];
}

const DEFAULT_SIGNAL_COLLAPSE_THRESHOLD = 0.8;

const C2_PLAYOUT_COUNT_LIGHT = 200;
const C2_PLAYOUT_COUNT_HEAVY = 500;

const C4_MIN_DECISIONS_PER_SECOND_DEFAULT = 500;
const C4_MIN_DECISIONS_PER_SECOND_LONG = 200;

const C5_IDENTITY_SEED_COUNT_DEFAULT = 200;
const C5_HEAD_TO_HEAD_SEED_COUNT_DEFAULT = 300;

/** Target effect / power inputs for variance-based seed recommendations. */
const RECOMMEND_TARGET_EFFECT = 0.03;

export interface BlueprintCalibration {
  readonly blockStdDev?: number;
}

export function deriveBlueprint(
  classification: GameClassification,
  calibration?: BlueprintCalibration,
): PipelineBlueprint {
  const warnings: string[] = [];
  if (classification.scoreStructure === 'scored' && !classification.scoreMarginDeclared) {
    warnings.push(
      "scoreMargin 미선언 — 'scored' 기본 적용됨, 승/패 전용이면 명시하라",
    );
  }

  const c2PlayoutCount =
    classification.contentWeight === 'heavy'
      ? C2_PLAYOUT_COUNT_HEAVY
      : C2_PLAYOUT_COUNT_LIGHT;

  const c4MinDecisionsPerSecond =
    classification.decisionMagnitude === 'long'
      ? C4_MIN_DECISIONS_PER_SECOND_LONG
      : C4_MIN_DECISIONS_PER_SECOND_DEFAULT;

  let c5IdentitySeedCount = C5_IDENTITY_SEED_COUNT_DEFAULT;
  let c5HeadToHeadSeedCount = C5_HEAD_TO_HEAD_SEED_COUNT_DEFAULT;
  if (calibration?.blockStdDev !== undefined) {
    const recommended = recommendBlockCount({
      blockStdDev: calibration.blockStdDev,
      targetEffect: RECOMMEND_TARGET_EFFECT,
    });
    c5IdentitySeedCount = recommended;
    c5HeadToHeadSeedCount = recommended;
  }

  return {
    promotionMinWinRate: DEFAULT_CRITERIA.minWinRate,
    promotionMinScoreDiff:
      classification.scoreStructure === 'win-loss-only' ? 0 : DEFAULT_CRITERIA.minScoreDiff,
    sprtNullHypothesis: classification.identityCenter,
    signalCollapseThreshold: DEFAULT_SIGNAL_COLLAPSE_THRESHOLD,
    c2PlayoutCount,
    c4MinDecisionsPerSecond,
    c5IdentitySeedCount,
    c5HeadToHeadSeedCount,
    c3Required: classification.informationStructure === 'hidden',
    contentCoverageRequired: classification.contentWeight !== 'none',
    benchmarkShowScoreDiff: classification.scoreStructure !== 'win-loss-only',
    warnings,
  };
}
