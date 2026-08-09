/**
 * catan-a8-rejudge2 — second re-judgement of the same 3 existing catan A8
 * cards (`catanScarcityWeightedTrade` round1, `catanPipWeightedBuild`
 * round2, `catanProductionDenialRobber` round3). NOT a new strategy design
 * — all 3 cards are reused exactly as already implemented in catan.ts, and
 * this file is a structural clone of `catan-a8-rejudge.ts`.
 *
 * What this fixes: `catan-a8-rejudge.ts` already fixed the FFA
 * `promotionMinWinRate` bug (docs/FIX-BACKLOG.md E11) and, as a result,
 * improved 2 of the 3 cards from `failed` to `near-miss`. But both
 * near-misses were blocked at the prune tier by the flat, uncalibrated
 * `minScoreDiff=5` cross-game fallback (`DEFAULT_CRITERIA.minScoreDiff` in
 * `kernel/blueprint.ts`). This is NOT a new bug — `catan-a8-rejudge.ts`
 * (lines 191-208) already called `measureNoiseFloor` and computed
 * `noiseFloor.scoreDiffStdDev`/`noiseFloor.blockStdDev`, but its
 * `assembleWaveConfig(adapter, {...})` call (line 241) never passed those
 * numbers as the 3rd `calibration` argument, so `deriveBlueprint` fell
 * through to the "no calibration" branch and used the flat fallback of 5
 * instead of the already-implemented P6 noise-derived
 * `recommendedMinScoreDiff` (2x noise stddev). This file is a pure wiring
 * fix: pass `{ blockStdDev: noiseFloor.blockStdDev, scoreDiffStdDev:
 * noiseFloor.scoreDiffStdDev }` as the 3rd argument.
 *
 * Fresh seed ranges (verified non-overlapping with every literal
 * seed/bank value across catan.ts, catan-benchmark.ts, catan-a8.ts,
 * catan-a8-round2.ts, catan-a8-round3.ts, and catan-a8-rejudge.ts via grep
 * before picking these — catan-a8-rejudge.ts occupies up through holdout
 * bank 1_008_000+clampedBlocks(<=20), i.e. at most 1_008_019; this file
 * starts at 1_010_000, well clear of that):
 *   - throughput check: seeds 1_010_000-1_010_019 (20), botSeedBase
 *     1_010_100 (candidate run) / 1_010_200 (base run) — repeated per
 *     candidate with +1000 offsets to keep each candidate's botSeedBase
 *     distinct.
 *   - calibration identitySeeds: 1_011_000-1_011_099, calibrate-seed 44,
 *     measure-seed 1_012_000.
 *   - screenProbe: seeds 1_013_001-1_013_003, botSeedBase 1_013_100.
 *   - wave smoke/prune/holdout banks: 1_014_000+/1_016_000+/1_018_000+
 *     (2000-wide gaps, comfortably above smokeMaxBlocks<=60 and
 *     clampedBlocks<=20).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { assembleWaveConfig } from '../../loop/assemble-wave-config';
import { runWave } from '../../loop/wave-runner';
import { runHeadToHead } from '../../loop/head-to-head';
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
import { classifyGame } from '../../kernel/classify';
import { eraseAdapter } from '../../loop/erase';
import { computeSourceDigest } from '../../artifacts/source-digest';
import { catanAdapter } from '../catan';

const GAME_ID = 'catan';
const WAVE_ID = 'a8-rejudge2';
const CANDIDATE_FLAGS = [
  'catanScarcityWeightedTrade',
  'catanPipWeightedBuild',
  'catanProductionDenialRobber',
] as const;

const SOURCE_FILES = [join(__dirname, '..', 'catan.ts')];

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
  const adapter = eraseAdapter(catanAdapter);
  const runStore = new RunStore(rootDir);
  const specDigest = sha256Digest(canonicalJson(adapter.spec));
  const classification = classifyGame(catanAdapter.spec);

  console.log(`=== catan-a8-rejudge2 runner (rootDir=${rootDir}) ===`);
  console.log(
    `   identityCenter=${classification.identityCenter} (playerCount=${catanAdapter.spec.playerCount}) — ` +
      're-judging existing 3 A8 cards again, this time with the noise-calibrated minScoreDiff wired in (was missing in rejudge1).',
  );

  console.log('1) G-Score conformance (re-check — no adapter changes expected, pure re-judgement)');
  // Same c3SampleStates override every prior catan A8 runner uses (initial
  // placement alone is 16 empty-hand decisions; the default sampler never
  // reaches a state with anything hidden to mutate without it).
  const conformance = scoreAdapter(adapter, { c3SampleStates: 25 });
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
    runId: 'conformance-a8-rejudge2',
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

  console.log('1.5) C4 처리량 확인 (5배 한도 점검) — 3개 후보 각각 vs base(heuristic), fresh seeds 1010000-1010019');
  const throughputSeeds = Array.from({ length: 20 }, (_, i) => 1_010_000 + i);
  const tBase0 = Date.now();
  runHeadToHead(adapter, catanAdapter.baselines.heuristic, catanAdapter.baselines.heuristic, throughputSeeds, 1_010_200);
  const baseElapsedMs = Date.now() - tBase0;
  console.log(`   base(heuristic vs heuristic): ${baseElapsedMs}ms`);
  CANDIDATE_FLAGS.forEach((flag, index) => {
    const candidateFactory = catanAdapter.strategySurface
      .find((spec) => spec.flag === flag)!
      .apply(catanAdapter.baselines.heuristic);
    const tCand0 = Date.now();
    runHeadToHead(adapter, candidateFactory, catanAdapter.baselines.heuristic, throughputSeeds, 1_010_100 + index * 1000);
    const candidateElapsedMs = Date.now() - tCand0;
    const throughputRatio = baseElapsedMs > 0 ? candidateElapsedMs / baseElapsedMs : 0;
    console.log(
      `   ${flag} vs heuristic: ${candidateElapsedMs}ms — 비율 ${throughputRatio.toFixed(2)}x (5배 한도 ${throughputRatio <= 5 ? '통과' : '초과'})`,
    );
  });

  console.log('2) load registry/ledger from runs/catan/ (already exist from catan.ts/catan-a8*.ts prior runs)');
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
    throw new Error('catan-a8-rejudge2 runner: v1 baseline missing — run catan.ts first');
  }
  console.log(`   regression baseline: v1 (flags=[${v1.flags.join(', ')}])`);

  console.log('2.5) 캘리브레이션 — noise floor 기반 블록 수 산정 (fresh seeds, no overlap with prior catan runners)');
  const identitySeeds = Array.from({ length: 100 }, (_, i) => 1_011_000 + i);
  const noiseFloor = measureNoiseFloor(adapter, catanAdapter.baselines.heuristic, identitySeeds, 1_012_000, {
    iterations: 2000,
    confidenceLevel: 0.95,
    seed: 44,
  });
  console.log(
    `   identity self-play (heuristic vs heuristic, 100 seeds): meanWinRate(seat0)=${noiseFloor.pointWinRate.toFixed(4)}, ` +
      `CI=[${noiseFloor.winRate.lower.toFixed(4)}, ${noiseFloor.winRate.upper.toFixed(4)}] — playerCount=4 so naive expectation is ${(1 / adapter.spec.playerCount).toFixed(4)}.`,
  );
  const recommendedBlocks = noiseFloor.blockStdDev > 0
    ? recommendBlockCount({ blockStdDev: noiseFloor.blockStdDev, targetEffect: 0.05 })
    : 5;
  const clampedBlocks = Math.min(Math.max(recommendedBlocks, 5), 20);
  console.log(
    `   캘리브레이션: blockStdDev=${noiseFloor.blockStdDev.toFixed(4)}, scoreDiffStdDev=${noiseFloor.scoreDiffStdDev.toFixed(4)}, 권장 블록수=${recommendedBlocks}(클램프 후 ${clampedBlocks})`,
  );

  console.log('3) wave — 3개 후보(catanScarcityWeightedTrade/catanPipWeightedBuild/catanProductionDenialRobber) vs v1, screen→smoke→prune→holdout');
  console.log(`   candidates: ${CANDIDATE_FLAGS.join(', ')}`);
  console.log(
    `   보정된 기준: minWinRate은 assembleWaveConfig가 blueprint에서 자동 유도(identityCenter+0.03=${(classification.identityCenter + 0.03).toFixed(2)}), ` +
      `smoke SPRT p0=identityCenter=${classification.identityCenter}, p1=p0+0.1=${(classification.identityCenter + 0.1).toFixed(2)}`,
  );

  const smokeMaxBlocks = clampedBlocks * 3;
  const waveLedger = new SeedLedger();
  const reservedAt = now();
  waveLedger.reserve({
    bankId: 'catan-a8-rejudge2-smoke',
    range: { start: 1_014_000, end: 1_014_000 + smokeMaxBlocks - 1 },
    purpose: 'smoke',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'catan-a8-rejudge2-prune',
    range: { start: 1_016_000, end: 1_016_000 + clampedBlocks - 1 },
    purpose: 'prune',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'catan-a8-rejudge2-holdout',
    range: { start: 1_018_000, end: 1_018_000 + clampedBlocks - 1 },
    purpose: 'holdout',
    reservedAt,
  });

  const smokeP0 = classification.identityCenter;
  const smokeP1 = smokeP0 + 0.1;
  // P6 wiring fix (docs/FIX-BACKLOG.md E11): pass the noise-floor
  // calibration as the 3rd argument so `deriveBlueprint` derives
  // `minScoreDiff` from 2x measured scoreDiffStdDev instead of falling
  // back to the flat cross-game DEFAULT_CRITERIA.minScoreDiff=5. This is
  // the only functional difference from catan-a8-rejudge.ts.
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
        bankId: 'catan-a8-rejudge2-smoke',
        sprt: { p0: smokeP0, p1: smokeP1, alpha: 0.1, beta: 0.1 },
        maxBlocks: smokeMaxBlocks,
        minBlocks: 5,
      },
      prune: { bankId: 'catan-a8-rejudge2-prune', blocks: clampedBlocks },
      holdout: { bankId: 'catan-a8-rejudge2-holdout', blocks: clampedBlocks },
    },
    screenProbe: { seeds: [1_013_001, 1_013_002, 1_013_003], botSeedBase: 1_013_100 },
  }, {
    blockStdDev: noiseFloor.blockStdDev,
    scoreDiffStdDev: noiseFloor.scoreDiffStdDev,
  });
  console.log(
    `   criteria: minWinRate=${waveConfig.criteria.minWinRate} minScoreDiff=${waveConfig.criteria.minScoreDiff} ` +
      `(rejudge1 미보정 고정값은 5였음 — 이번엔 noise stddev 기반 보정값${waveConfig.criteria.minScoreDiff === 5 ? '이지만 우연히 5와 같음' : '으로 달라짐'})`,
  );

  const t0 = Date.now();
  const report = runWave(adapter, waveConfig);
  const elapsedSec = (Date.now() - t0) / 1000;
  let totalGames = 0;
  for (const result of report.results) {
    console.log(`   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`);
    for (const tier of ['screen', 'smoke', 'prune', 'holdout'] as const) {
      const stats = result.stats[tier];
      if (stats) {
        console.log(`     ${tier}: winRate=${stats.pointWinRate.toFixed(3)} scoreDiff=${stats.pointScoreDiff.toFixed(3)} blocks=${stats.blocks}`);
        totalGames += stats.blocks;
      }
    }
    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        console.log(`     ⚠ ${warning}`);
      }
    }
  }
  console.log(`   wave elapsed=${elapsedSec.toFixed(1)}s over ~${totalGames} scored blocks`);

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
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'near-miss-a8-rejudge2.json'), JSON.stringify(nearMiss, null, 2));
  console.log(`   저장: runs/${GAME_ID}/near-miss-a8-rejudge2.json`);

  console.log('4.6) 웨이브 채택 플래그 registry 승격');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (adoptedFlags.length === 0) {
    console.log('   이번 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('catan-a8-rejudge2 runner: registry has no latest baseline before promotion step');
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

  console.log('=== catan-a8-rejudge2 runner complete ===');
}

main();
