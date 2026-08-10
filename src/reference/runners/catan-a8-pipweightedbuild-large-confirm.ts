/**
 * catan-a8-pipweightedbuild-large-confirm — E9 원칙(docs/TROUBLESHOOTING.md
 * §13) 적용: 재판정 2차(`catan-a8-rejudge2.ts`, 커밋 `a8c9496`)에서
 * `catanPipWeightedBuild`가 카탄 사상 처음 holdout까지 도달했지만
 * holdout이 5블록뿐인 극소 표본에서 25.0% vs minWinRate 28.0%로 근소하게
 * 근접실패(`screened`)했다. E9 원칙은 "문턱 근처 근접실패는 재설계 전에
 * 표본을 5~10배 키워 먼저 재확인하라"고 말한다 — 오목 v9가 이 원칙으로
 * 실제 초월을 확정했고, 하스스톤 v4는 반대로 진짜 열세였음이 드러났다.
 * 이 파일은 **새 설계가 아니다**: `catanPipWeightedBuild` 단일 후보만,
 * `catan-a8-rejudge2.ts`의 웨이브 구조(assembleWaveConfig+runWave)를 그대로
 * 복제해서 prune/holdout 블록 수만 5→50(10배)으로 증폭한다. 다른 2개 카드
 * (`catanScarcityWeightedTrade`, `catanProductionDenialRobber`)는 이미
 * 명백히 실패했으므로 이번 재확증에서 제외한다.
 *
 * `catan-a8-rejudge2.ts`가 고친 배선(assembleWaveConfig 3번째 인자로
 * calibration을 넘기는 것)을 이번에도 반드시 유지한다 — 빠뜨리면
 * minScoreDiff가 다시 flat fallback(5)으로 떨어진다.
 *
 * prune/holdout은 `recommendBlockCount`의 클램프(Math.min(Math.max(x,5),20))
 * 로직을 적용하지 않고 50을 직접 하드코딩한다(브리프 지시). smoke는 기존과
 * 비슷하게(clampedBlocks 로직 유지) — smoke는 이미 35.0%로 여유 있게
 * 통과했으므로 증폭 불필요.
 *
 * Fresh seed ranges (기존 catan*.ts 전체 grep 확인 — catan-a8-rejudge2.ts가
 * 최상단 1_010_000-1_018_019까지 점유; 이 파일은 1_020_000부터 시작해
 * 완전히 겹치지 않음):
 *   - throughput check: seeds 1_020_000-1_020_019 (20), botSeedBase
 *     1_020_100(candidate)/1_020_200(base).
 *   - calibration identitySeeds: 1_021_000-1_021_099, calibrate-seed 44,
 *     measure-seed 1_022_000.
 *   - screenProbe: seeds 1_023_001-1_023_003, botSeedBase 1_023_100.
 *   - wave smoke bank: 1_024_000+ (smokeMaxBlocks<=60).
 *   - wave prune bank: 1_026_000+ (blocks=50 하드코딩, 최대 1_026_049).
 *   - wave holdout bank: 1_028_000+ (blocks=50 하드코딩, 최대 1_028_049,
 *     prune 뱅크와 충분히 떨어져 있어 겹치지 않음).
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
const WAVE_ID = 'a8-pipweightedbuild-large-confirm';
const CANDIDATE_FLAGS = ['catanPipWeightedBuild'] as const;
const LARGE_BLOCKS = 50;

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

  console.log(`=== catan-a8-pipweightedbuild-large-confirm runner (rootDir=${rootDir}) ===`);
  console.log(
    `   identityCenter=${classification.identityCenter} (playerCount=${catanAdapter.spec.playerCount}) — ` +
      'E9 원칙 재확증: catanPipWeightedBuild 단일 후보, prune/holdout 블록 수 5→50(10배) 증폭. 재판정 2차 근접실패(holdout 25.0% vs 문턱 28.0%, 5블록뿐)를 큰 표본으로 재확인한다.',
  );

  console.log('1) G-Score conformance (재확인 — 어댑터 변경 없음, 순수 재측정)');
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
    runId: 'conformance-a8-pipweightedbuild-large-confirm',
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

  console.log('1.5) C4 처리량 확인 (5배 한도 점검) — catanPipWeightedBuild vs base(heuristic), fresh seeds 1020000-1020019');
  const throughputSeeds = Array.from({ length: 20 }, (_, i) => 1_020_000 + i);
  const tBase0 = Date.now();
  runHeadToHead(adapter, catanAdapter.baselines.heuristic, catanAdapter.baselines.heuristic, throughputSeeds, 1_020_200);
  const baseElapsedMs = Date.now() - tBase0;
  console.log(`   base(heuristic vs heuristic): ${baseElapsedMs}ms`);
  CANDIDATE_FLAGS.forEach((flag, index) => {
    const candidateFactory = catanAdapter.strategySurface
      .find((spec) => spec.flag === flag)!
      .apply(catanAdapter.baselines.heuristic);
    const tCand0 = Date.now();
    runHeadToHead(adapter, candidateFactory, catanAdapter.baselines.heuristic, throughputSeeds, 1_020_100 + index * 1000);
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
    throw new Error('catan-a8-pipweightedbuild-large-confirm runner: v1 baseline missing — run catan.ts first');
  }
  console.log(`   regression baseline: v1 (flags=[${v1.flags.join(', ')}])`);

  console.log('2.5) 캘리브레이션 — noise floor 기반 블록 수 산정 (fresh seeds, no overlap with prior catan runners)');
  const identitySeeds = Array.from({ length: 100 }, (_, i) => 1_021_000 + i);
  const noiseFloor = measureNoiseFloor(adapter, catanAdapter.baselines.heuristic, identitySeeds, 1_022_000, {
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
    `   캘리브레이션: blockStdDev=${noiseFloor.blockStdDev.toFixed(4)}, scoreDiffStdDev=${noiseFloor.scoreDiffStdDev.toFixed(4)}, 권장 블록수=${recommendedBlocks}(smoke 클램프 후 ${clampedBlocks}, prune/holdout은 E9 재확증이라 클램프 미적용, 하드코딩 ${LARGE_BLOCKS})`,
  );

  console.log('3) wave — catanPipWeightedBuild 단일 후보 vs v1, screen→smoke→prune→holdout (prune/holdout 블록 수 50, E9 대규모 재확증)');
  console.log(`   candidates: ${CANDIDATE_FLAGS.join(', ')}`);
  console.log(
    `   보정된 기준: minWinRate은 assembleWaveConfig가 blueprint에서 자동 유도(identityCenter+0.03=${(classification.identityCenter + 0.03).toFixed(2)}), ` +
      `smoke SPRT p0=identityCenter=${classification.identityCenter}, p1=p0+0.1=${(classification.identityCenter + 0.1).toFixed(2)}`,
  );

  const smokeMaxBlocks = clampedBlocks * 3;
  const waveLedger = new SeedLedger();
  const reservedAt = now();
  waveLedger.reserve({
    bankId: 'catan-a8-pipweightedbuild-large-confirm-smoke',
    range: { start: 1_024_000, end: 1_024_000 + smokeMaxBlocks - 1 },
    purpose: 'smoke',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'catan-a8-pipweightedbuild-large-confirm-prune',
    range: { start: 1_026_000, end: 1_026_000 + LARGE_BLOCKS - 1 },
    purpose: 'prune',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'catan-a8-pipweightedbuild-large-confirm-holdout',
    range: { start: 1_028_000, end: 1_028_000 + LARGE_BLOCKS - 1 },
    purpose: 'holdout',
    reservedAt,
  });

  const smokeP0 = classification.identityCenter;
  const smokeP1 = smokeP0 + 0.1;
  // P6 wiring fix (docs/FIX-BACKLOG.md E11), carried over from
  // catan-a8-rejudge2.ts: pass the noise-floor calibration as the 3rd
  // argument so `deriveBlueprint` derives `minScoreDiff` from 2x measured
  // scoreDiffStdDev instead of falling back to the flat cross-game
  // DEFAULT_CRITERIA.minScoreDiff=5.
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
        bankId: 'catan-a8-pipweightedbuild-large-confirm-smoke',
        sprt: { p0: smokeP0, p1: smokeP1, alpha: 0.1, beta: 0.1 },
        maxBlocks: smokeMaxBlocks,
        minBlocks: 5,
      },
      prune: { bankId: 'catan-a8-pipweightedbuild-large-confirm-prune', blocks: LARGE_BLOCKS },
      holdout: { bankId: 'catan-a8-pipweightedbuild-large-confirm-holdout', blocks: LARGE_BLOCKS },
    },
    screenProbe: { seeds: [1_023_001, 1_023_002, 1_023_003], botSeedBase: 1_023_100 },
  }, {
    blockStdDev: noiseFloor.blockStdDev,
    scoreDiffStdDev: noiseFloor.scoreDiffStdDev,
  });
  console.log(
    `   criteria: minWinRate=${waveConfig.criteria.minWinRate} minScoreDiff=${waveConfig.criteria.minScoreDiff}`,
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
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'near-miss-a8-pipweightedbuild-large-confirm.json'), JSON.stringify(nearMiss, null, 2));
  console.log(`   저장: runs/${GAME_ID}/near-miss-a8-pipweightedbuild-large-confirm.json`);

  console.log('4.6) 웨이브 채택 플래그 registry 승격');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (adoptedFlags.length === 0) {
    console.log('   이번 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('catan-a8-pipweightedbuild-large-confirm runner: registry has no latest baseline before promotion step');
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

  console.log('=== catan-a8-pipweightedbuild-large-confirm runner complete ===');
}

main();
