/**
 * Onboarding pipeline executor (docs/GAP-ANALYSIS-13.md S1): extracts the
 * 6-stage pipeline every latest-generation per-game runner
 * (`reference/runners/catan.ts`, `reference/runners/gomoku.ts`'s first-wave
 * section) reimplements by hand — noise-floor calibration -> registry/ledger
 * bootstrap -> baseline v1 + anchor registration -> wave assembly -> wave
 * execution -> summary/promotion (near-miss extraction, registry promotion,
 * `renderGameSummaryMarkdown`, `saveRegistry`/`saveLedger`) — into a single
 * game-neutral function, `runOnboardingPipeline(adapter, config)`. Same
 * motivation and same extraction method as GAP-ANALYSIS-12's E1
 * (`artifacts/portfolio-round.ts`): every new game's runner currently starts
 * as a copy of an existing one, and the copied logic is identical apart from
 * game-specific constants (`docs/GAP-ANALYSIS-13.md §0.2`).
 *
 * Required deviations from a literal transcription of catan.ts/gomoku.ts,
 * each forced by something a naive extraction would silently break:
 *
 *   - **G-Score conformance (`scoreAdapter`/`evaluateWaveReadiness`) is
 *     deliberately OUT of this function's scope**, even though
 *     GAP-ANALYSIS-13 §0.2 describes the copied pipeline as starting there.
 *     `src/__tests__/dependency-rules.test.ts` permits `artifacts/` to import
 *     only `contract`/`kernel`/`loop` — never `onboarding/`, where
 *     `scoreAdapter`/`evaluateWaveReadiness`/`renderReportMarkdown` live.
 *     `artifacts/game-summary.ts` hit the exact same wall before this file
 *     did and solved it by duck-typing the onboarding report's shape instead
 *     of importing it (see that file's `ConformanceReportShape`); this file
 *     instead pushes the whole conformance stage back to the caller (an app
 *     boundary under `reference/runners/`, which may import `onboarding/`
 *     freely) and starts at the next stage — noise-floor calibration. Callers
 *     run `scoreAdapter` + `evaluateWaveReadiness` themselves, exactly as
 *     before, and only call `runOnboardingPipeline` once `readiness.proceed`
 *     is true.
 *   - **A single caller-supplied `recordedAt` stands in for every one of
 *     catan.ts/gomoku.ts's many separate `now()` calls** (one per
 *     `saveRunIfAbsent`, per `ledger.reserve`, per `registry.register`, per
 *     `ledger.add`) — this file lives in `artifacts/`, bound by the
 *     determinism rule (no `Date.now()`/`new Date()` outside the app
 *     boundary), and collapsing to one timestamp per pipeline call is exactly
 *     `artifacts/portfolio-round.ts`'s own precedent (see its doc comment).
 *     None of the collapsed timestamps feed `comparabilityKey` or
 *     `reportDigest` (verified against `loop/wave-runner.ts`), so this cannot
 *     change any judgment-relevant output — only the cosmetic ISO strings
 *     stamped on registry/ledger/run records, which necessarily differ
 *     between any two runs (including two runs of the ORIGINAL unrefactored
 *     file) anyway.
 *   - **Wave seed-bank `bankId` strings are caller-supplied, not derived
 *     from `gameId` inside this function**, even though gomoku's bankIds
 *     (`gomoku-runner-smoke`, ...) and catan's wave-A bankIds
 *     (`catan-runner-smoke-a`, ... — the `-a` suffix exists only because
 *     catan's runner also runs an M4 field-mix wave B with its own `-b`
 *     bankIds sharing the same file) both follow a `${gameId}-runner-<tier>`
 *     shape. `bankId` feeds `computeComparabilityKey`'s `seedBankIds` and
 *     therefore both `comparabilityKey` and `reportDigest`
 *     (`loop/wave-runner.ts`) — auto-deriving a bankId that doesn't match a
 *     game's already-persisted history would silently change every future
 *     comparabilityKey for that game. Reproducing a past wave byte-for-byte
 *     requires the exact original bankId strings, so they are config, not
 *     computed.
 *   - **Wave seed-range layout (smoke = 3x the calibrated block count
 *     starting at seed 1, prune = the calibrated block count starting at
 *     seed 1000, holdout = the calibrated block count starting at seed
 *     2000) is NOT configurable** — both catan.ts and gomoku.ts hardcode this
 *     exact convention with no divergence, so it is folded into this
 *     function rather than exposed as one more parameter nobody would ever
 *     vary.
 *   - **The wave's `RunStore.saveRun` persistence (the `runs/<gameId>/
 *     <waveId>/` directory) is INCLUDED** even though GAP-ANALYSIS-13 §3 S1's
 *     one-line stage list only names "near-miss 추출, renderGameSummaryMarkdown,
 *     saveRegistry" explicitly — omitting it would mean a refactored runner
 *     no longer produces a `runs/<gameId>/<waveId>/` run record at all, which
 *     breaks the field-parity check GAP-ANALYSIS-13 §3 S1 itself calls for
 *     ("기존 산출물과 필드 일치 확인"). `RunStore` is already in `artifacts/`
 *     and generates no timestamps of its own (see its own doc comment), so
 *     including it introduces no new determinism exposure.
 *
 * Lives in artifacts/ (not reference/ or onboarding/): stays under the
 * determinism rule and the artifacts -> loop/kernel dependency direction
 * (never imports onboarding/ or reference/, which carry game/process
 * knowledge) per the dependency-rules test.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AnyBotFactory, AnyGameAdapter } from '../contract/types';
import type { BlueprintCalibration } from '../kernel/blueprint';
import type { PromotionCriteria } from '../kernel/gates';
import type { SprtConfig } from '../kernel/sprt';
import { recommendBlockCount, type BootstrapOptions } from '../kernel/paired-stats';
import { SeedLedger } from '../kernel/seed-ledger';
import { measureNoiseFloor, type NoiseFloorResult } from '../loop/calibrate';
import { assembleWaveConfig, type AssembleWaveConfigOverrides } from '../loop/assemble-wave-config';
import { runWave, type WaveReport } from '../loop/wave-runner';
import { extractNearMissCandidates, type AdoptionEntry, type AdoptionRecord } from './adoption-ledger';
import { BaselineRegistry, type BenchmarkAnchor } from './baseline-registry';
import { AdoptionLedger } from './adoption-ledger';
import {
  loadOrCreateLedger,
  loadOrCreateRegistry,
  saveLedger,
  saveRegistry,
} from './game-state';
import { renderGameSummaryMarkdown } from './game-summary';
import { RunStore } from './run-store';

export interface OnboardingNoiseFloorOptions {
  /** Baseline factory played against itself to measure the identity-self-play
   * noise floor (both catan.ts and gomoku.ts pass `adapter.baselines.heuristic`). */
  readonly baselineFactory: AnyBotFactory;
  readonly identitySeeds: readonly number[];
  readonly botSeedBase: number;
  readonly bootstrap: BootstrapOptions;
  /** `recommendBlockCount`'s targetEffect (both callers use 0.05). */
  readonly targetEffect: number;
  /** Fallback block count when `blockStdDev` is 0 (a deterministic baseline
   * bot has zero self-play variance, making the sample-size formula
   * inapplicable) — both callers use 5. */
  readonly zeroStdDevFallbackBlocks: number;
  /** Clamp bounds applied to the recommended block count. catan.ts uses
   * [5, 20]; gomoku.ts uses [5, 30] — genuinely different per game, so this
   * is required config, not a shared default. */
  readonly clamp: { readonly min: number; readonly max: number };
}

export interface OnboardingWaveBankIds {
  readonly smoke: string;
  readonly prune: string;
  readonly holdout: string;
}

export interface OnboardingWaveOptions {
  readonly waveId: string;
  readonly bankIds: OnboardingWaveBankIds;
  readonly opponent: 'heuristic' | 'random';
  readonly smokeSprt: SprtConfig;
  readonly smokeMinBlocks: number;
  readonly screenProbeSeeds: readonly number[];
  readonly screenProbeBotSeedBase: number;
  readonly calibration?: BlueprintCalibration;
  readonly overrides?: AssembleWaveConfigOverrides;
}

export interface OnboardingAnchorSpec {
  readonly anchorId: string;
  readonly kind: BenchmarkAnchor['kind'];
}

export interface OnboardingBaselineOptions {
  /** Notes string stamped on the v1 baseline registration when v1 doesn't
   * exist yet (both callers use a Korean "순정 heuristic 기준선" note). */
  readonly v1Notes: string;
  readonly anchors: readonly OnboardingAnchorSpec[];
}

export interface RunOnboardingPipelineInput {
  readonly gameId: string;
  readonly rootDir: string;
  readonly adapter: AnyGameAdapter;
  /** Source-closure digest for this game's flag-behavior-relevant code
   * (`artifacts/source-digest.ts`'s `computeSourceDigest`), computed by the
   * caller — deciding which files belong to "this game's" source closure is
   * game-specific knowledge that must not leak into this game-neutral
   * function. */
  readonly sourceDigest: string;
  readonly noiseFloor: OnboardingNoiseFloorOptions;
  readonly baseline: OnboardingBaselineOptions;
  readonly wave: OnboardingWaveOptions;
  /** Promotion note prefix used when adopted flags are registered as a new
   * baseline version (both callers use a "웨이브 <id>에서 채택된 플래그
   * 승격: ..." Korean note). */
  readonly promotionNotePrefix: string;
  /** ISO timestamp used for every timestamp this pipeline stamps (registry
   * `createdAt`, ledger `reservedAt`/`recordedAt`, run-store `recordedAt`) —
   * supplied by the app-boundary caller per the determinism rule. See this
   * file's doc comment ("Required deviations") for why one shared timestamp
   * replaces catan.ts/gomoku.ts's many separate `now()` calls. */
  readonly recordedAt: string;
}

export interface OnboardingSourceDrift {
  readonly priorVersion: string;
  readonly priorSourceDigest: string | undefined;
  readonly currentSourceDigest: string;
  /** True iff the prior latest version had a recorded sourceDigest that
   * differs from the current one (an actual drift, not just "predates
   * sourceDigest tracking"). */
  readonly drifted: boolean;
}

export interface OnboardingPromotionResult {
  readonly promotedVersion: string | null;
  readonly adoptedFlags: readonly string[];
  readonly alreadyPromoted: boolean;
}

export interface RunOnboardingPipelineResult {
  readonly noiseFloor: NoiseFloorResult;
  readonly recommendedBlocks: number;
  readonly clampedBlocks: number;
  readonly registry: BaselineRegistry;
  readonly ledger: AdoptionLedger;
  readonly sourceDrift: OnboardingSourceDrift | undefined;
  readonly baselineVersion: string;
  readonly report: WaveReport;
  readonly criteria: PromotionCriteria;
  readonly adoptionRecord: AdoptionRecord;
  readonly nearMiss: ReturnType<typeof extractNearMissCandidates>;
  readonly promotion: OnboardingPromotionResult;
  readonly summaryMarkdown: string;
}

function gameRunPath(rootDir: string, gameId: string, ...segments: readonly string[]): string {
  return join(rootDir, 'runs', gameId, ...segments);
}

/** Step 1.5: identity self-play noise floor -> recommended block count,
 * clamped to the caller's [min, max] range (ported verbatim from
 * catan.ts/gomoku.ts's step "1.5) 캘리브레이션"). */
function runNoiseFloorCalibration(
  adapter: AnyGameAdapter,
  options: OnboardingNoiseFloorOptions,
): { readonly noiseFloor: NoiseFloorResult; readonly recommendedBlocks: number; readonly clampedBlocks: number } {
  const noiseFloor = measureNoiseFloor(
    adapter,
    options.baselineFactory,
    options.identitySeeds,
    options.botSeedBase,
    options.bootstrap,
  );
  const recommendedBlocks =
    noiseFloor.blockStdDev > 0
      ? recommendBlockCount({ blockStdDev: noiseFloor.blockStdDev, targetEffect: options.targetEffect })
      : options.zeroStdDevFallbackBlocks;
  const clampedBlocks = Math.min(Math.max(recommendedBlocks, options.clamp.min), options.clamp.max);
  return { noiseFloor, recommendedBlocks, clampedBlocks };
}

/** Step 2: load-or-create registry/ledger, and report (without acting on) any
 * source drift since the last registered version — ported verbatim from
 * catan.ts/gomoku.ts's step "2)". */
function loadGameStateAndCheckDrift(
  rootDir: string,
  gameId: string,
  sourceDigest: string,
): { readonly registry: BaselineRegistry; readonly ledger: AdoptionLedger; readonly sourceDrift: OnboardingSourceDrift | undefined } {
  const registry = loadOrCreateRegistry(rootDir, gameId);
  const ledger = loadOrCreateLedger(rootDir, gameId);
  const priorLatest = registry.latest();

  let sourceDrift: OnboardingSourceDrift | undefined;
  if (priorLatest !== undefined) {
    sourceDrift = {
      priorVersion: priorLatest.version,
      priorSourceDigest: priorLatest.sourceDigest,
      currentSourceDigest: sourceDigest,
      drifted: priorLatest.sourceDigest !== undefined && priorLatest.sourceDigest !== sourceDigest,
    };
  }

  return { registry, ledger, sourceDrift };
}

/** Step 3: register the pristine v1 baseline + benchmark anchors if they
 * don't already exist — ported verbatim from catan.ts/gomoku.ts's step "3)". */
function bootstrapBaseline(
  registry: BaselineRegistry,
  sourceDigest: string,
  options: OnboardingBaselineOptions,
  recordedAt: string,
): string {
  if (registry.get('v1') === undefined) {
    registry.register({
      version: 'v1',
      flags: [],
      parent: null,
      createdAt: recordedAt,
      sourceWaveId: null,
      notes: options.v1Notes,
      sourceDigest,
    });
  }
  for (const anchor of options.anchors) {
    if (registry.getAnchor(anchor.anchorId) === undefined) {
      registry.registerAnchor({ anchorId: anchor.anchorId, kind: anchor.kind });
    }
  }
  const v1 = registry.get('v1');
  if (v1 === undefined) {
    throw new Error('runOnboardingPipeline: v1 baseline missing after registration step');
  }
  return v1.version;
}

/** Step 4: assemble and run one smoke/prune/holdout wave over the adapter's
 * full strategy surface — ported verbatim from catan.ts/gomoku.ts's step "4)"
 * (single-opponent field; catan.ts's separate M4 field-mix wave B is outside
 * this pipeline's scope, see this file's doc comment). */
function runOnboardingWave(
  adapter: AnyGameAdapter,
  flags: readonly string[],
  clampedBlocks: number,
  baselineFlags: readonly string[],
  baselineVersion: string,
  wave: OnboardingWaveOptions,
  recordedAt: string,
): { readonly report: WaveReport; readonly criteria: PromotionCriteria } {
  const smokeMaxBlocks = clampedBlocks * 3;
  const ledger = new SeedLedger();
  ledger.reserve({ bankId: wave.bankIds.smoke, range: { start: 1, end: smokeMaxBlocks }, purpose: 'smoke', reservedAt: recordedAt });
  ledger.reserve({ bankId: wave.bankIds.prune, range: { start: 1000, end: 999 + clampedBlocks }, purpose: 'prune', reservedAt: recordedAt });
  ledger.reserve({ bankId: wave.bankIds.holdout, range: { start: 2000, end: 1999 + clampedBlocks }, purpose: 'holdout', reservedAt: recordedAt });

  const waveConfig = assembleWaveConfig(
    adapter,
    {
      waveId: wave.waveId,
      candidates: flags.map((flag) => ({ flag })),
      opponent: wave.opponent,
      ledger,
      recordedAt,
      baselineFlags,
      baselineVersion,
      tiers: {
        smoke: { bankId: wave.bankIds.smoke, sprt: wave.smokeSprt, maxBlocks: smokeMaxBlocks, minBlocks: wave.smokeMinBlocks },
        prune: { bankId: wave.bankIds.prune, blocks: clampedBlocks },
        holdout: { bankId: wave.bankIds.holdout, blocks: clampedBlocks },
      },
      screenProbe: { seeds: wave.screenProbeSeeds, botSeedBase: wave.screenProbeBotSeedBase },
    },
    wave.calibration,
    wave.overrides,
  );

  return { report: runWave(adapter, waveConfig), criteria: waveConfig.criteria };
}

/** Builds this wave's AdoptionEntry rows, matching catan.ts/gomoku.ts's
 * `toEntries` — a "screened out before any games" candidate (no tiers passed
 * and no smoke stats) is recorded as verdict "screened-out" with an explicit
 * failureReason instead of whatever raw verdict runWave assigned it. */
function toAdoptionEntries(report: WaveReport): AdoptionEntry[] {
  return report.results.map((result) => {
    const tierStats: AdoptionEntry['tierStats'] = {};
    for (const tier of ['screen', 'smoke', 'prune', 'holdout'] as const) {
      const stats = result.stats[tier];
      if (stats) {
        tierStats[tier] = {
          pointWinRate: stats.pointWinRate,
          pointScoreDiff: stats.pointScoreDiff,
          blocks: stats.blocks,
          ...(stats.drawRate !== undefined ? { drawRate: stats.drawRate } : {}),
          ...(stats.winRateCI !== undefined ? { winRateCI: stats.winRateCI } : {}),
        };
      }
    }
    const isNoOp = result.tiersPassed.length === 0 && result.stats.smoke === undefined;
    return {
      flags: result.flags,
      verdict: isNoOp ? 'screened-out' : result.verdict,
      tierStats,
      ...(isNoOp ? { failureReason: 'behavioral no-op (screened out before any games)' } : {}),
    };
  });
}

/** Step 5.6: promote this wave's adopted flags onto the current baseline
 * lineage, guarding against double-promotion of the same waveId — ported
 * verbatim from catan.ts/gomoku.ts's step "5.6)". */
function promoteAdoptedFlags(
  registry: BaselineRegistry,
  report: WaveReport,
  notePrefix: string,
  recordedAt: string,
  sourceDigest: string,
): OnboardingPromotionResult {
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (adoptedFlags.length === 0) {
    return { promotedVersion: null, adoptedFlags, alreadyPromoted: false };
  }

  const currentLatest = registry.latest();
  if (currentLatest === undefined) {
    throw new Error('runOnboardingPipeline: registry has no latest baseline before promotion step');
  }
  const lineage = registry.lineage(currentLatest.version);
  const alreadyPromoted = lineage.some((version) => version.sourceWaveId === report.waveId);
  if (alreadyPromoted) {
    return { promotedVersion: currentLatest.version, adoptedFlags, alreadyPromoted: true };
  }

  const nextVersion = registry.register({
    version: `v${lineage.length + 1}`,
    flags: [...currentLatest.flags, ...adoptedFlags],
    parent: currentLatest.version,
    createdAt: recordedAt,
    sourceWaveId: report.waveId,
    notes: `${notePrefix}${adoptedFlags.join(', ')}`,
    sourceDigest,
  });
  return { promotedVersion: nextVersion.version, adoptedFlags, alreadyPromoted: false };
}

/**
 * Runs the 6-stage onboarding pipeline (docs/GAP-ANALYSIS-13.md §0.2, §3 S1)
 * — noise-floor calibration -> registry/ledger bootstrap -> baseline v1 +
 * anchor registration -> wave assembly -> wave execution -> summary/promotion
 * — that catan.ts and gomoku.ts's first-wave section each reimplement from
 * scratch, and persists every artifact both runners already persist
 * (`runs/<gameId>/<waveId>/`, `runs/<gameId>/near-miss.json`,
 * `runs/<gameId>/registry.json`, `runs/<gameId>/ledger.json`,
 * `runs/<gameId>/summary.md`). G-Score conformance
 * (`scoreAdapter`/`evaluateWaveReadiness`) is deliberately excluded from this
 * function's scope — see this file's doc comment ("Required deviations") —
 * so callers run that stage themselves before calling this function, and
 * only call it once `evaluateWaveReadiness(...).proceed` is true.
 */
export function runOnboardingPipeline(
  adapter: AnyGameAdapter,
  input: RunOnboardingPipelineInput,
): RunOnboardingPipelineResult {
  const { noiseFloor, recommendedBlocks, clampedBlocks } = runNoiseFloorCalibration(adapter, input.noiseFloor);

  const { registry, ledger, sourceDrift } = loadGameStateAndCheckDrift(input.rootDir, input.gameId, input.sourceDigest);
  const baselineVersion = bootstrapBaseline(registry, input.sourceDigest, input.baseline, input.recordedAt);
  const v1 = registry.get(baselineVersion);
  if (v1 === undefined) {
    throw new Error('runOnboardingPipeline: v1 baseline missing after bootstrap');
  }

  const flags = adapter.strategySurface.map((spec) => spec.flag);
  const { report, criteria } = runOnboardingWave(
    adapter,
    flags,
    clampedBlocks,
    v1.flags,
    v1.version,
    input.wave,
    input.recordedAt,
  );

  const runStore = new RunStore(input.rootDir);
  try {
    runStore.saveRun({
      gameId: input.gameId,
      runId: report.waveId,
      kind: 'wave',
      recordedAt: input.recordedAt,
      comparabilityKey: report.comparabilityKey,
      payload: report,
      markdown: `# Wave Report — ${report.waveId}\n\n${report.results
        .map((r) => `- ${r.flag}: ${r.verdict} (tiers: ${r.tiersPassed.join('→') || 'none'})`)
        .join('\n')}\n`,
    });
  } catch {
    // Append-only run store (RunStore.saveRun throws on a re-recorded runId)
    // — expected when re-running against an already-recorded waveId, exactly
    // as catan.ts/gomoku.ts's saveRunIfAbsent tolerates.
  }

  const adoptionRecord = ledger.add({
    waveId: report.waveId,
    recordedAt: input.recordedAt,
    comparabilityKey: report.comparabilityKey,
    baselineVersion: v1.version,
    opponentId: input.wave.opponent,
    entries: toAdoptionEntries(report),
    nextLoopNotes: [],
  });

  const nearMiss = extractNearMissCandidates(adoptionRecord, criteria);
  writeFileSync(gameRunPath(input.rootDir, input.gameId, 'near-miss.json'), JSON.stringify(nearMiss, null, 2));

  const promotion = promoteAdoptedFlags(registry, report, input.promotionNotePrefix, input.recordedAt, input.sourceDigest);

  saveRegistry(input.rootDir, input.gameId, registry);
  saveLedger(input.rootDir, input.gameId, ledger);

  const summaryMarkdown = renderGameSummaryMarkdown(input.rootDir, input.gameId, { latestWaveCriteria: criteria });
  writeFileSync(gameRunPath(input.rootDir, input.gameId, 'summary.md'), summaryMarkdown);

  return {
    noiseFloor,
    recommendedBlocks,
    clampedBlocks,
    registry,
    ledger,
    sourceDrift,
    baselineVersion: v1.version,
    report,
    criteria,
    adoptionRecord,
    nearMiss,
    promotion,
    summaryMarkdown,
  };
}
