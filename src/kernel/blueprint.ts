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
  /**
   * Game-calibrated `minScoreDiff` gate threshold (docs/FIX-BACKLOG.md P6):
   * "2 sigma of identity noise" — a margin distinguishable from the
   * identity-self-play noise floor, since the gate's purpose is to reject
   * noise, not to demand an arbitrarily-sized margin (INTERPRETATION.md §1's
   * comparabilityKey-scoped-comparison rule applies equally here: a fixed
   * cross-game constant like DEFAULT_CRITERIA.minScoreDiff has no relation
   * to any one game's score scale). See the branches below for exactly how
   * this is derived; `promotionMinScoreDiff` above is left untouched as the
   * uncalibrated fallback for callers that don't pass `scoreDiffStdDev`.
   */
  readonly recommendedMinScoreDiff: number;
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
  /** Identity-noise-floor standard deviation of score-delta (P6, from
   * `measureNoiseFloor`'s `scoreDiffStdDev`) — drives `recommendedMinScoreDiff`. */
  readonly scoreDiffStdDev?: number;
}

/** "Noise floor x this multiplier" — a margin twice the identity-self-play
 * score-delta standard deviation is distinguishable from noise under a
 * normal approximation (docs/FIX-BACKLOG.md P6): the gate's job is to reject
 * noise, not to impose an arbitrary fixed margin. */
const SCORE_DIFF_NOISE_MULTIPLIER = 2;

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
  // Guard blockStdDev>0 before calling recommendBlockCount (found while
  // wiring P6's scoreDiffStdDev through assembleWaveConfig): a collapsed
  // identity-noise-floor measurement (blockStdDev===0, e.g. splendor's
  // seat-mirroring signal collapse) previously reached recommendBlockCount
  // unguarded and threw, even though every runner already has to
  // clamp-fallback around this exact case manually (R5). Falls back to the
  // seed-count defaults above, same as passing no calibration at all.
  if (calibration?.blockStdDev !== undefined && calibration.blockStdDev > 0) {
    const recommended = recommendBlockCount({
      blockStdDev: calibration.blockStdDev,
      targetEffect: RECOMMEND_TARGET_EFFECT,
    });
    c5IdentitySeedCount = recommended;
    c5HeadToHeadSeedCount = recommended;
  }

  // P6: minScoreDiff threshold derivation, in priority order —
  // 1) win-loss-only games never have a meaningful score margin (unchanged
  //    invariant, see promotionMinScoreDiff above).
  // 2) scored + a real (>0) noise-floor measurement -> 2 sigma of that noise.
  // 3) scored + a measurement that collapsed to exactly 0 (deterministic
  //    identity self-play, R5's clamp-fallback pattern) -> threshold 0, but
  //    flagged with a warning since a 0 threshold means the gate can't
  //    distinguish "real margin" from "no margin" for this game.
  // 4) scored + no calibration provided at all -> the uncalibrated
  //    DEFAULT_CRITERIA.minScoreDiff fallback (kernel/gates.ts).
  let recommendedMinScoreDiff: number;
  if (classification.scoreStructure === 'win-loss-only') {
    recommendedMinScoreDiff = 0;
  } else if (calibration?.scoreDiffStdDev !== undefined) {
    if (calibration.scoreDiffStdDev === 0) {
      recommendedMinScoreDiff = 0;
      warnings.push(
        'scoreDiffStdDev=0 — 항등 자기대국 점수차가 완전히 붕괴(결정론적 동점), ' +
          'recommendedMinScoreDiff를 0으로 폴백함(노이즈와 실제 마진을 구별할 수 없음)',
      );
    } else {
      recommendedMinScoreDiff = SCORE_DIFF_NOISE_MULTIPLIER * calibration.scoreDiffStdDev;
    }
  } else {
    recommendedMinScoreDiff = DEFAULT_CRITERIA.minScoreDiff;
  }

  return {
    // FFA(3인 이상) 게임의 identityCenter로 스케일: 2인 게임(identityCenter=0.5)은
    // DEFAULT_CRITERIA.minWinRate(0.53) 그대로 byte-identical 보존되고, FFA
    // 게임은 공정한 몫(identityCenter) 기준으로 +0.03 우세를 요구하도록 이동한다
    // (docs/FIX-BACKLOG.md E11 — 카탄 playerCount=4가 identityCenter=0.25인데도
    // 2인 게임 전제 0.53을 그대로 요구받던 결함).
    promotionMinWinRate: classification.identityCenter + (DEFAULT_CRITERIA.minWinRate - 0.5),
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
    recommendedMinScoreDiff,
    warnings,
  };
}
