/**
 * catan-a8-round3 — the A8 domain-redesign card's third live wave for catan
 * (docs/GAP-11-ROUNDS.md "카탄 A8 3차 시도(로버 결정지점)", scratchpad/
 * catan-a8-round3-design-spec.md). Mirrors catan-a8-round2.ts's structure
 * exactly (conformance -> throughput check -> load-or-create registry/ledger
 * -> calibration -> wave -> adoption ledger -> promotion -> summary) but
 * scoped to just the new `catanProductionDenialRobber` flag against the
 * existing v1 baseline (regression=v1, flags=[] — neither round 1's
 * `catanScarcityWeightedTrade` nor round 2's `catanPipWeightedBuild` were
 * ever promoted, so v1 is still the latest registered baseline; this file
 * only appends a new wave, it never touches prior history). Unlike rounds
 * 1-2 (both on build/bankTrade), this card targets `moveRobberAndSteal` — a
 * decision point no prior catan A8 card has touched.
 *
 * Fresh seed ranges (verified non-overlapping with every literal seed/bank
 * value in catan.ts, catan-benchmark.ts, catan-a8.ts, and
 * catan-a8-round2.ts via grep before picking these — catan-a8-round2.ts
 * occupies up through holdout bank 980_000+clampedBlocks(<=20), i.e. at most
 * 980_019; this file starts at 990_000, well clear of that):
 *   - throughput check: seeds 990_000-990_019 (20), botSeedBase 990_100
 *     (candidate run) / 990_200 (base run).
 *   - calibration identitySeeds: 991_000-991_099, calibrate-seed 44,
 *     measure-seed 992_000.
 *   - screenProbe: seeds 993_001-993_003, botSeedBase 993_100.
 *   - wave smoke/prune/holdout banks: 994_000+/996_000+/998_000+ (2000-wide
 *     gaps, comfortably above smokeMaxBlocks<=60 and clampedBlocks<=20).
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
import { eraseAdapter } from '../../loop/erase';
import { computeSourceDigest } from '../../artifacts/source-digest';
import { catanAdapter } from '../catan';

const GAME_ID = 'catan';
const WAVE_ID = 'a8-wave-3';
const CANDIDATE_FLAG = 'catanProductionDenialRobber';

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

  console.log(`=== catan-a8-round3 runner (rootDir=${rootDir}) ===`);

  console.log('1) G-Score conformance (re-check after adding catanProductionDenialRobber — C6 in particular)');
  // Same c3SampleStates override catan.ts's/catan-a8.ts's/catan-a8-round2.ts's
  // own runner uses (initial placement alone is 16 empty-hand decisions; the
  // default sampler never reaches a state with anything hidden to mutate
  // without it).
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
    runId: 'conformance-a8-round3',
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

  console.log('1.5) C4 처리량 확인 (5배 한도 점검) — candidate vs base(heuristic), fresh seeds 990000-990019');
  const throughputSeeds = Array.from({ length: 20 }, (_, i) => 990_000 + i);
  const candidateFactory = catanAdapter.strategySurface
    .find((spec) => spec.flag === CANDIDATE_FLAG)!
    .apply(catanAdapter.baselines.heuristic);
  const tBase0 = Date.now();
  runHeadToHead(adapter, catanAdapter.baselines.heuristic, catanAdapter.baselines.heuristic, throughputSeeds, 990_200);
  const baseElapsedMs = Date.now() - tBase0;
  const tCand0 = Date.now();
  runHeadToHead(adapter, candidateFactory, catanAdapter.baselines.heuristic, throughputSeeds, 990_100);
  const candidateElapsedMs = Date.now() - tCand0;
  const throughputRatio = baseElapsedMs > 0 ? candidateElapsedMs / baseElapsedMs : 0;
  console.log(`   base(heuristic vs heuristic): ${baseElapsedMs}ms`);
  console.log(`   catanProductionDenialRobber vs heuristic: ${candidateElapsedMs}ms`);
  console.log(`   비율: ${throughputRatio.toFixed(2)}x (5배 한도 ${throughputRatio <= 5 ? '통과' : '초과'})`);

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
    throw new Error('catan-a8-round3 runner: v1 baseline missing — run catan.ts first');
  }
  console.log(`   regression baseline: v1 (flags=[${v1.flags.join(', ')}])`);

  console.log('2.5) 캘리브레이션 — noise floor 기반 블록 수 산정 (fresh seeds, no overlap with prior catan runners)');
  const identitySeeds = Array.from({ length: 100 }, (_, i) => 991_000 + i);
  const noiseFloor = measureNoiseFloor(adapter, catanAdapter.baselines.heuristic, identitySeeds, 992_000, {
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
    `   캘리브레이션: blockStdDev=${noiseFloor.blockStdDev.toFixed(4)}, 권장 블록수=${recommendedBlocks}(클램프 후 ${clampedBlocks})`,
  );

  console.log('3) wave — single candidate catanProductionDenialRobber vs v1, screen→smoke→prune→holdout');
  console.log(`   candidate: ${CANDIDATE_FLAG}`);

  const smokeMaxBlocks = clampedBlocks * 3;
  const waveLedger = new SeedLedger();
  const reservedAt = now();
  waveLedger.reserve({
    bankId: 'catan-a8-round3-smoke',
    range: { start: 994_000, end: 994_000 + smokeMaxBlocks - 1 },
    purpose: 'smoke',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'catan-a8-round3-prune',
    range: { start: 996_000, end: 996_000 + clampedBlocks - 1 },
    purpose: 'prune',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'catan-a8-round3-holdout',
    range: { start: 998_000, end: 998_000 + clampedBlocks - 1 },
    purpose: 'holdout',
    reservedAt,
  });

  const waveConfig = assembleWaveConfig(adapter, {
    waveId: WAVE_ID,
    candidates: [{ flag: CANDIDATE_FLAG }],
    opponent: 'heuristic',
    ledger: waveLedger,
    recordedAt: now(),
    baselineFlags: v1.flags,
    baselineVersion: v1.version,
    tiers: {
      smoke: {
        bankId: 'catan-a8-round3-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: smokeMaxBlocks,
        minBlocks: 5,
      },
      prune: { bankId: 'catan-a8-round3-prune', blocks: clampedBlocks },
      holdout: { bankId: 'catan-a8-round3-holdout', blocks: clampedBlocks },
    },
    screenProbe: { seeds: [993_001, 993_002, 993_003], botSeedBase: 993_100 },
  });
  console.log(`   criteria: minWinRate=${waveConfig.criteria.minWinRate} minScoreDiff=${waveConfig.criteria.minScoreDiff}`);

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
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'near-miss-a8-round3.json'), JSON.stringify(nearMiss, null, 2));
  console.log(`   저장: runs/${GAME_ID}/near-miss-a8-round3.json`);

  console.log('4.6) 웨이브 채택 플래그 registry 승격');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (adoptedFlags.length === 0) {
    console.log('   이번 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('catan-a8-round3 runner: registry has no latest baseline before promotion step');
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

  console.log('=== catan-a8-round3 runner complete ===');
}

main();
