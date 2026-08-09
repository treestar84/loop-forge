/**
 * catan-a8-rejudge — pure re-judgement of the 3 existing catan A8 cards
 * (`catanScarcityWeightedTrade` round1, `catanPipWeightedBuild` round2,
 * `catanProductionDenialRobber` round3) under the corrected
 * `promotionMinWinRate` (docs/FIX-BACKLOG.md E11, scratchpad/
 * ffa-minwinrate-fix-design-spec.md). This is NOT a new strategy design —
 * all 3 cards are reused exactly as already implemented in catan.ts.
 *
 * Root cause being corrected: `kernel/blueprint.ts`'s `deriveBlueprint`
 * used to return `promotionMinWinRate: DEFAULT_CRITERIA.minWinRate` (a
 * flat 0.53) regardless of playerCount. Catan has playerCount=4, so its
 * fair share (identityCenter) is 0.25 — the old fixed 0.53 demanded more
 * than double the fair share from every catan candidate. All 3 prior
 * rounds (docs/GAP-11-ROUNDS.md "카탄 A8 1/2/3차 시도") judged their
 * candidates against that miscalibrated 0.53 bar and speculated the
 * repeated ~20-25% smoke failures were caused by a structural seat bias
 * (bias=0.485 measured by `measureNoiseFloor`/C5) — that speculation was
 * wrong: `runPairedBlock` (src/loop/paired-match.ts) already averages over
 * all 4 seating rotations declared in `adapter.spec.seatingPlan`, so the
 * seat-position effect is fully cancelled out of every measured win rate
 * (smoke/prune/holdout/regression all go through `runPairedBlock`, see
 * `src/loop/wave-runner.ts` lines 373/410) — the rotation-average
 * methodology statistically erases that bias, it does not mean no real
 * seat bias exists. After the blueprint.ts fix, catan's
 * `promotionMinWinRate` is now `identityCenter + 0.03` = 0.28.
 *
 * Fresh seed ranges (verified non-overlapping with every literal
 * seed/bank value across catan.ts, catan-benchmark.ts, catan-a8.ts,
 * catan-a8-round2.ts, and catan-a8-round3.ts via grep before picking
 * these — catan-a8-round3.ts occupies up through holdout bank
 * 998_000+clampedBlocks(<=20), i.e. at most 998_019; this file starts at
 * 1_000_000, well clear of that):
 *   - throughput check: seeds 1_000_000-1_000_019 (20), botSeedBase
 *     1_000_100 (candidate run) / 1_000_200 (base run) — repeated per
 *     candidate with +1000 offsets to keep each candidate's botSeedBase
 *     distinct.
 *   - calibration identitySeeds: 1_001_000-1_001_099, calibrate-seed 44,
 *     measure-seed 1_002_000.
 *   - screenProbe: seeds 1_003_001-1_003_003, botSeedBase 1_003_100.
 *   - wave smoke/prune/holdout banks: 1_004_000+/1_006_000+/1_008_000+
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
const WAVE_ID = 'a8-rejudge';
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

  console.log(`=== catan-a8-rejudge runner (rootDir=${rootDir}) ===`);
  console.log(
    `   identityCenter=${classification.identityCenter} (playerCount=${catanAdapter.spec.playerCount}) — ` +
      're-judging existing 3 A8 cards under the corrected FFA promotionMinWinRate (E11).',
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
    runId: 'conformance-a8-rejudge',
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

  console.log('1.5) C4 처리량 확인 (5배 한도 점검) — 3개 후보 각각 vs base(heuristic), fresh seeds 1000000-1000019');
  const throughputSeeds = Array.from({ length: 20 }, (_, i) => 1_000_000 + i);
  const tBase0 = Date.now();
  runHeadToHead(adapter, catanAdapter.baselines.heuristic, catanAdapter.baselines.heuristic, throughputSeeds, 1_000_200);
  const baseElapsedMs = Date.now() - tBase0;
  console.log(`   base(heuristic vs heuristic): ${baseElapsedMs}ms`);
  CANDIDATE_FLAGS.forEach((flag, index) => {
    const candidateFactory = catanAdapter.strategySurface
      .find((spec) => spec.flag === flag)!
      .apply(catanAdapter.baselines.heuristic);
    const tCand0 = Date.now();
    runHeadToHead(adapter, candidateFactory, catanAdapter.baselines.heuristic, throughputSeeds, 1_000_100 + index * 1000);
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
    throw new Error('catan-a8-rejudge runner: v1 baseline missing — run catan.ts first');
  }
  console.log(`   regression baseline: v1 (flags=[${v1.flags.join(', ')}])`);

  console.log('2.5) 캘리브레이션 — noise floor 기반 블록 수 산정 (fresh seeds, no overlap with prior catan runners)');
  const identitySeeds = Array.from({ length: 100 }, (_, i) => 1_001_000 + i);
  const noiseFloor = measureNoiseFloor(adapter, catanAdapter.baselines.heuristic, identitySeeds, 1_002_000, {
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
    bankId: 'catan-a8-rejudge-smoke',
    range: { start: 1_004_000, end: 1_004_000 + smokeMaxBlocks - 1 },
    purpose: 'smoke',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'catan-a8-rejudge-prune',
    range: { start: 1_006_000, end: 1_006_000 + clampedBlocks - 1 },
    purpose: 'prune',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'catan-a8-rejudge-holdout',
    range: { start: 1_008_000, end: 1_008_000 + clampedBlocks - 1 },
    purpose: 'holdout',
    reservedAt,
  });

  const smokeP0 = classification.identityCenter;
  const smokeP1 = smokeP0 + 0.1;
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
        bankId: 'catan-a8-rejudge-smoke',
        sprt: { p0: smokeP0, p1: smokeP1, alpha: 0.1, beta: 0.1 },
        maxBlocks: smokeMaxBlocks,
        minBlocks: 5,
      },
      prune: { bankId: 'catan-a8-rejudge-prune', blocks: clampedBlocks },
      holdout: { bankId: 'catan-a8-rejudge-holdout', blocks: clampedBlocks },
    },
    screenProbe: { seeds: [1_003_001, 1_003_002, 1_003_003], botSeedBase: 1_003_100 },
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
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'near-miss-a8-rejudge.json'), JSON.stringify(nearMiss, null, 2));
  console.log(`   저장: runs/${GAME_ID}/near-miss-a8-rejudge.json`);

  console.log('4.6) 웨이브 채택 플래그 registry 승격');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (adoptedFlags.length === 0) {
    console.log('   이번 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('catan-a8-rejudge runner: registry has no latest baseline before promotion step');
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

  console.log('=== catan-a8-rejudge runner complete ===');
}

main();
