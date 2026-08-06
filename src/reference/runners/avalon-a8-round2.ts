/**
 * avalon-a8-round2 — the A8 domain-redesign card's 2nd attempt for avalon,
 * a diagnostic (cause-isolation) round rather than a new design
 * (docs/GAP-11-ROUNDS.md "아발론 A8 첫 채택 시도", scratchpad/avalon-a8-
 * round2-design-spec.md). The 1st attempt's single flag
 * (`avalonSuspicionTracking`) failed smoke at 20.0% (SPRT-rejected), with
 * three candidate root-cause hypotheses recorded but not yet isolated:
 *   ① the mission-team participation penalty (+1.5 on failure) poisons
 *      innocent servants who simply got assigned to a failing team
 *   ② only 5 missions per game is too little signal for the score to
 *      accumulate before it matters
 *   ③ the mechanism is wasted/harmful on merlin, who already has certain
 *      evil-seat information and gains nothing from a derived signal
 * This round fractures the 1st attempt's mechanism into three flags, each
 * isolating exactly one hypothesis (`avalon.ts`'s `computeSuspicionScores`/
 * `isGoodRole`/`avalonSuspicionTracking`, ~lines 790-1050, is reused as-is
 * where unchanged):
 *   - `avalonSuspicionVoteOnly`: drops the participation penalty only ->
 *     isolates ①.
 *   - `avalonSuspicionProposalOnly`: keeps the full score but removes the
 *     vote-rejection decision point entirely (always delegates that
 *     decision to base) -> isolates which decision point the loss came
 *     from, independent of ①/③.
 *   - `avalonSuspicionGoodOnly`: keeps everything else identical but
 *     narrows the good-role gate from merlin+servant to servant-only ->
 *     isolates ③.
 * Hypothesis ② (signal-starvation from only 5 missions) is not directly
 * testable by fracturing this mechanism further — it would require a
 * differently-shaped mechanism (e.g. one that doesn't need many missions
 * to accumulate signal) rather than a sub-flag of this one, so it is left
 * for a future card if all three candidates here fail (see step 4 below).
 *
 * Mirrors avalon-a8.ts's structure (same 6-step shape: conformance ->
 * calibration -> load-or-create registry/ledger -> wave -> adoption ledger
 * -> promotion -> summary) but runs all three candidates in a single wave
 * against the same v1 baseline (registry/ledger already exist from
 * avalon.ts/avalon-a8.ts's prior runs — this file only appends a new wave,
 * it never touches that history).
 *
 * Fresh seed ranges (verified non-overlapping with every literal seed/bank
 * value in avalon.ts, avalon-benchmark.ts, and avalon-a8.ts, the only three
 * pre-existing avalon runner/reference files — grepped before picking
 * these; avalon.ts occupies screenProbe seeds 1-3/botSeedBase 100, smoke
 * bank 1-~90, prune bank 1000-1029, holdout bank 2000-2029, calibration
 * identitySeeds 700_000-700_099/calibrate-seed 42/measure-seed 600_000;
 * avalon-benchmark.ts occupies seeds 50_000-51_999/botSeedBases
 * 800_001-800_003; avalon-a8.ts occupies screenProbe seeds
 * 900_001-900_003/botSeedBase 900_100, calibration identitySeeds
 * 904_000-904_099/calibrate-seed 43/measure-seed 905_000, wave banks
 * 910_000+/920_000+/930_000+ (max 910_089 for smoke at clampedBlocks=30)):
 *   - screenProbe: seeds 950_001-950_003, botSeedBase 950_100.
 *   - calibration identitySeeds: 954_000-954_099, calibrate-seed 44,
 *     measure-seed 955_000.
 *   - wave smoke/prune/holdout banks: 960_000+/970_000+/980_000+.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { assembleWaveConfig } from '../../loop/assemble-wave-config';
import { runWave } from '../../loop/wave-runner';
import { SeedLedger } from '../../kernel/seed-ledger';
import { scoreAdapter } from '../../onboarding/score';
import { renderReportMarkdown } from '../../onboarding/report';
import { evaluateWaveReadiness } from '../../onboarding/wave-readiness';
import { computeComparabilityKey, RunStore } from '../../artifacts/run-store';
import { canonicalJson, sha256Digest } from '../../kernel/digest';
import {
  loadOrCreateLedger,
  loadOrCreateRegistry,
  saveLedger,
  saveRegistry,
} from '../../artifacts/game-state';
import { extractNearMissCandidates, type AdoptionEntry } from '../../artifacts/adoption-ledger';
import { renderGameSummaryMarkdown } from '../../artifacts/game-summary';
import { measureNoiseFloor } from '../../loop/calibrate';
import { recommendBlockCount } from '../../kernel/paired-stats';
import { eraseAdapter } from '../../loop/erase';
import { computeSourceDigest } from '../../artifacts/source-digest';
import { avalonAdapter } from '../avalon';

const GAME_ID = 'avalon';
const WAVE_ID = 'a8-wave-2';
const CANDIDATE_FLAGS = ['avalonSuspicionVoteOnly', 'avalonSuspicionProposalOnly', 'avalonSuspicionGoodOnly'] as const;

const SOURCE_FILES = [join(__dirname, '..', 'avalon.ts')];

function now(): string {
  return new Date().toISOString();
}

function saveRunIfAbsent(runStore: RunStore, input: Parameters<RunStore['saveRun']>[0]): void {
  try {
    runStore.saveRun(input);
    console.log(`  saved runs/${input.gameId}/${input.runId}/`);
  } catch (error) {
    console.log(
      `  skipped runs/${input.gameId}/${input.runId}/ (already recorded: ${(error as Error).message})`,
    );
  }
}

function main(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const adapter = eraseAdapter(avalonAdapter);
  const runStore = new RunStore(rootDir);
  const specDigest = sha256Digest(canonicalJson(adapter.spec));

  console.log(`=== avalon-a8-round2 runner (rootDir=${rootDir}) ===`);

  console.log('1) G-Score conformance (re-check after adding the 3 round-2 candidate flags)');
  const conformance = scoreAdapter(adapter, {});
  console.log(`   score=${conformance.overallScore} ready=${conformance.ready}`);
  for (const axisResult of conformance.axes) {
    console.log(`   ${axisResult.axis}: score=${axisResult.score}`);
    for (const note of axisResult.notes ?? []) {
      console.log(`     note: ${note}`);
    }
    for (const blocker of axisResult.blockers) {
      console.log(`     BLOCKER: ${blocker.code} — ${blocker.message}`);
    }
  }
  saveRunIfAbsent(runStore, {
    gameId: GAME_ID,
    runId: 'conformance-a8-round2',
    kind: 'conformance',
    recordedAt: now(),
    comparabilityKey: computeComparabilityKey({
      gameId: adapter.spec.gameId,
      specDigest,
      baselineVersion: 'n/a',
      opponentId: 'n/a',
      seedBankIds: [],
    }),
    payload: conformance,
    markdown: renderReportMarkdown(conformance),
  });
  const readiness = evaluateWaveReadiness(conformance);
  if (!readiness.proceed) {
    console.log('conformance has non-parity blockers — stopping before wave execution.');
    for (const axisResult of readiness.blockingAxes) {
      console.log(`   ${axisResult.axis}: ${axisResult.blockers.map((b) => b.code).join(', ')}`);
    }
    return;
  }
  for (const warning of readiness.warnings) {
    console.log(`   ⚠ ${warning}`);
  }

  console.log('1.5) 캘리브레이션 — noise floor 기반 블록 수 산정 (fresh seeds, no overlap with avalon.ts/avalon-a8.ts)');
  const identitySeeds = Array.from({ length: 100 }, (_, i) => 954_000 + i);
  const noiseFloor = measureNoiseFloor(adapter, avalonAdapter.baselines.heuristic, identitySeeds, 955_000, {
    iterations: 2000,
    confidenceLevel: 0.95,
    seed: 44,
  });
  console.log(
    `   identity self-play (heuristic vs heuristic, 100 seeds): meanWinRate(seat0)=${noiseFloor.pointWinRate.toFixed(4)}, ` +
      `CI=[${noiseFloor.winRate.lower.toFixed(4)}, ${noiseFloor.winRate.upper.toFixed(4)}]`,
  );
  const recommendedBlocks = noiseFloor.blockStdDev > 0
    ? recommendBlockCount({ blockStdDev: noiseFloor.blockStdDev, targetEffect: 0.05 })
    : 5;
  const clampedBlocks = Math.min(Math.max(recommendedBlocks, 5), 30);
  console.log(
    `   캘리브레이션: blockStdDev=${noiseFloor.blockStdDev.toFixed(4)}, 권장 블록수=${recommendedBlocks}(클램프 후 ${clampedBlocks})`,
  );

  console.log('2) load registry/ledger from runs/avalon/ (already exist from avalon.ts/avalon-a8.ts prior runs)');
  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const ledger = loadOrCreateLedger(rootDir, GAME_ID);
  const sourceDigest = computeSourceDigest(SOURCE_FILES);
  const priorLatest = registry.latest();
  if (priorLatest?.sourceDigest !== undefined && priorLatest.sourceDigest !== sourceDigest) {
    console.log(
      `   ⚠ source drift detected: registry latest (${priorLatest.version}) was registered with sourceDigest=${priorLatest.sourceDigest}, current source=${sourceDigest}.`,
    );
  }
  const v1 = registry.get('v1');
  if (v1 === undefined) {
    throw new Error('avalon-a8-round2 runner: v1 baseline missing — run avalon.ts first');
  }
  console.log(`   regression baseline: v1 (flags=[${v1.flags.join(', ')}])`);

  console.log('3) wave — 3 cause-isolation candidates vs v1, screen→smoke→prune→holdout (single wave)');
  console.log(`   candidates: ${CANDIDATE_FLAGS.join(', ')}`);

  const smokeMaxBlocks = clampedBlocks * 3;
  const waveLedger = new SeedLedger();
  const reservedAt = now();
  waveLedger.reserve({
    bankId: 'avalon-a8-round2-smoke',
    range: { start: 960_000, end: 960_000 + smokeMaxBlocks - 1 },
    purpose: 'smoke',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'avalon-a8-round2-prune',
    range: { start: 970_000, end: 970_000 + clampedBlocks - 1 },
    purpose: 'prune',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'avalon-a8-round2-holdout',
    range: { start: 980_000, end: 980_000 + clampedBlocks - 1 },
    purpose: 'holdout',
    reservedAt,
  });

  const waveConfig = assembleWaveConfig(adapter, {
    waveId: WAVE_ID,
    candidates: CANDIDATE_FLAGS.map((flag) => ({ flag })),
    opponent: 'heuristic',
    ledger: waveLedger,
    recordedAt: now(),
    baselineFlags: v1.flags,
    baselineVersion: v1.version,
    tiers: {
      smoke: {
        bankId: 'avalon-a8-round2-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: smokeMaxBlocks,
        minBlocks: 5,
      },
      prune: { bankId: 'avalon-a8-round2-prune', blocks: clampedBlocks },
      holdout: { bankId: 'avalon-a8-round2-holdout', blocks: clampedBlocks },
    },
    screenProbe: { seeds: [950_001, 950_002, 950_003], botSeedBase: 950_100 },
  });
  console.log(`   criteria: minScoreDiff=${waveConfig.criteria.minScoreDiff} (승/패 전용 게임 — scoreMargin:'none')`);

  const t0 = Date.now();
  const report = runWave(adapter, waveConfig);
  const elapsedSec = (Date.now() - t0) / 1000;
  let totalGames = 0;
  for (const result of report.results) {
    console.log(`   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`);
    for (const tier of ['screen', 'smoke', 'prune', 'holdout'] as const) {
      const stats = result.stats[tier];
      if (stats) {
        console.log(`     ${tier}: winRate=${stats.pointWinRate.toFixed(3)} blocks=${stats.blocks}`);
        totalGames += stats.blocks;
      }
    }
    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        console.log(`     ⚠ ${warning}`);
      }
    }
  }
  const heuristicDecisionsPerSec = conformance.axes.find((a) => a.axis === 'C4-throughput')?.notes?.[0] ?? 'n/a';
  console.log(`   wave elapsed=${elapsedSec.toFixed(1)}s over ~${totalGames} scored blocks; heuristic throughput note: ${heuristicDecisionsPerSec}`);

  saveRunIfAbsent(runStore, {
    gameId: GAME_ID,
    runId: report.waveId,
    kind: 'wave',
    recordedAt: now(),
    comparabilityKey: report.comparabilityKey,
    payload: report,
    markdown: `# Wave Report — ${report.waveId}\n\n${report.results
      .map((r) => `- ${r.flag}: ${r.verdict} (tiers: ${r.tiersPassed.join('→') || 'none'})`)
      .join('\n')}\n`,
  });

  console.log('4) record adoption ledger entry');
  const entries: AdoptionEntry[] = report.results.map((result) => {
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
  const adoptionRecord = ledger.add({
    waveId: report.waveId,
    recordedAt: now(),
    comparabilityKey: report.comparabilityKey,
    baselineVersion: v1.version,
    opponentId: waveConfig.opponent,
    entries,
    nextLoopNotes: [],
  });

  console.log('4.5) near-miss 후보 추출');
  const nearMiss = extractNearMissCandidates(adoptionRecord, waveConfig.criteria);
  if (nearMiss.length === 0) {
    console.log('   근접실패 후보 없음.');
  } else {
    for (const candidate of nearMiss) {
      console.log(
        `   flags=[${candidate.flags.join('+')}] failedAtTier=${candidate.failedAtTier} winRateGap=${candidate.gap.winRateGap.toFixed(4)} scoreDiffGap=${candidate.gap.scoreDiffGap.toFixed(4)}`,
      );
    }
  }
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'near-miss-a8-round2.json'), JSON.stringify(nearMiss, null, 2));
  console.log(`   저장: runs/${GAME_ID}/near-miss-a8-round2.json`);

  console.log('4.6) 웨이브 채택 플래그 registry 승격');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (adoptedFlags.length === 0) {
    console.log('   이번 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('avalon-a8-round2 runner: registry has no latest baseline before promotion step');
    }
    const lineage = registry.lineage(currentLatest.version);
    const alreadyPromoted = lineage.some((version) => version.sourceWaveId === report.waveId);
    if (alreadyPromoted) {
      console.log('   이 웨이브는 이미 승격됨 — 스킵');
    } else {
      const nextVersion = registry.register({
        version: `v${lineage.length + 1}`,
        flags: [...currentLatest.flags, ...adoptedFlags],
        parent: currentLatest.version,
        createdAt: now(),
        sourceWaveId: report.waveId,
        notes: `웨이브 ${report.waveId}에서 채택된 플래그 승격: ${adoptedFlags.join(', ')}`,
        sourceDigest,
      });
      console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
    }
  }

  console.log('5) persist registry/ledger');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('6) game-summary 렌더');
  const summaryMarkdown = renderGameSummaryMarkdown(rootDir, GAME_ID, { latestWaveCriteria: waveConfig.criteria });
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'summary.md'), summaryMarkdown);
  console.log(`   게임 요약: runs/${GAME_ID}/summary.md`);

  console.log('=== avalon-a8-round2 runner complete ===');
}

main();
