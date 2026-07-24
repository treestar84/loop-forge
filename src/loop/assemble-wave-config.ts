/**
 * Assembles a WaveConfig by deriving criteria/signalCollapseThreshold from
 * the adapter's classification (kernel/classify.ts -> kernel/blueprint.ts)
 * instead of requiring callers to hand-tune those numbers per game, mirroring
 * the merge pattern onboarding/score.ts already uses for ScoreOptions
 * (caller override > blueprint-derived value > kernel default).
 *
 * Seed banks, tier block counts, and screen probe seeds still need per-game
 * empirical tuning and stay required caller inputs — classification cannot
 * derive them.
 */

import type { AnyGameAdapter } from '../contract/types';
import { classifyGame } from '../kernel/classify';
import { deriveBlueprint, type BlueprintCalibration } from '../kernel/blueprint';
import type { PromotionCriteria } from '../kernel/gates';
import type { SeedLedger } from '../kernel/seed-ledger';
import type { WaveCandidateConfig, WaveConfig, WaveScreenProbeConfig } from './wave-runner';

export interface AssembleWaveConfigInput {
  readonly waveId: string;
  readonly candidates: ReadonlyArray<WaveCandidateConfig>;
  readonly opponent: 'heuristic' | 'random';
  readonly ledger: SeedLedger;
  readonly recordedAt: string;
  readonly tiers: WaveConfig['tiers'];
  readonly screenProbe: WaveScreenProbeConfig;
  readonly baselineFlags?: readonly string[];
  readonly baselineVersion?: string;
}

export interface AssembleWaveConfigOverrides {
  readonly criteria?: PromotionCriteria;
  readonly signalCollapseThreshold?: number;
}

export function assembleWaveConfig(
  adapter: AnyGameAdapter,
  required: AssembleWaveConfigInput,
  calibration?: BlueprintCalibration,
  overrides?: AssembleWaveConfigOverrides,
): WaveConfig {
  const classification = classifyGame(adapter.spec, adapter.contentInventory);
  const blueprint = deriveBlueprint(classification, calibration);

  // P6 (docs/FIX-BACKLOG.md): prefer the calibration-derived threshold
  // (recommendedMinScoreDiff) over the uncalibrated promotionMinScoreDiff
  // fallback whenever calibration data was actually supplied — callers that
  // don't pass `calibration` get byte-identical behavior to before P6, since
  // deriveBlueprint's recommendedMinScoreDiff falls back to the same
  // DEFAULT_CRITERIA.minScoreDiff in that case anyway (kernel/blueprint.ts).
  const criteria: PromotionCriteria =
    overrides?.criteria ?? {
      minWinRate: blueprint.promotionMinWinRate,
      minScoreDiff: blueprint.recommendedMinScoreDiff,
    };
  const signalCollapseThreshold =
    overrides?.signalCollapseThreshold ?? blueprint.signalCollapseThreshold;

  return {
    ...required,
    criteria,
    signalCollapseThreshold,
  };
}
