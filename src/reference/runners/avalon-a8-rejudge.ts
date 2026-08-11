/**
 * avalon-a8-rejudge — hiddenTeamStructure baseline diagnosis + rejudgement
 * for the 4 existing avalon suspicion-tracking candidates
 * (`avalonSuspicionTracking` round1, `avalonSuspicionVoteOnly` /
 * `avalonSuspicionProposalOnly` / `avalonSuspicionGoodOnly` round2 —
 * scratchpad/avalon-identity-center-fix-design-spec.md). NOT a new strategy
 * design — all 4 flags are reused exactly as already implemented in
 * avalon.ts.
 *
 * Root cause being diagnosed (different from catan's E11 fix, not a
 * re-application of it): `kernel/classify.ts`'s `classifyGame` computes
 * `identityCenter = spec.teams ? 1/teams.length : 1/playerCount`, which
 * never accounts for `spec.hiddenTeamStructure`. Avalon
 * (`hiddenTeamStructure: true`, no static `spec.teams` — factions are
 * hidden, so they can't be declared statically) gets
 * `identityCenter = 1/5 = 0.2`. But `src/onboarding/score.ts`'s `scoreC5`
 * already knows this is wrong for hiddenTeamStructure/cooperativeStructure
 * games — faction sizes are asymmetric and not statically knowable — and
 * substitutes the *measured* random-identity-self-play `meanWinRate`
 * (0.237, per `runs/avalon/conformance/payload.json`) as the fairness
 * center instead of naive 1/N. `kernel/blueprint.ts`'s
 * `promotionMinWinRate` calculation never inherited that exemption — until
 * this round's step 1 (`BlueprintCalibration.measuredIdentityCenter`,
 * `deriveBlueprint`) added an explicit override so callers can plug in a
 * measured baseline instead of the naive `classification.identityCenter`.
 *
 * Critically, the *right* measurement here is not C5's random-identity
 * baseline (0.237) either — `promotionMinWinRate`'s actual question is "if
 * a candidate behaves identically to the current champion (v1 = heuristic),
 * what fraction would it score against itself?", which must always be
 * measured via a **heuristic**-identity self-play, exactly as catan's
 * successful `catan-a8-rejudge2.ts` did (`measureNoiseFloor(adapter,
 * catanAdapter.baselines.heuristic, ...)` — catan's heuristic-identity rate
 * happened to equal 1/playerCount only because catan is symmetric). This
 * runner measures avalon's heuristic-identity self-play win rate fresh and
 * compares it side-by-side against both naive 1/5=0.2 and C5's
 * random-identity 0.237 to show all three diverge.
 *
 * Fresh seed ranges (verified non-overlapping with every literal seed/bank
 * value across avalon.ts, avalon-benchmark.ts, avalon-a8.ts, and
 * avalon-a8-round2.ts via grep before picking these — avalon-a8-round2.ts
 * occupies up through holdout bank 980_000+clampedBlocks(<=30), i.e. at
 * most 980_029; this file starts at 2_000_000, well clear of that):
 *   - heuristic-identity calibration: identitySeeds 2_001_000-2_001_099,
 *     calibrate-seed 44, measure-seed 2_002_000.
 *   - screenProbe: seeds 2_003_001-2_003_003, botSeedBase 2_003_100.
 *   - wave smoke/prune/holdout banks: 2_004_000+/2_006_000+/2_008_000+
 *     (2000-wide gaps, comfortably above smokeMaxBlocks<=90 and
 *     clampedBlocks<=30).
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
import { classifyGame } from '../../kernel/classify';
import { eraseAdapter } from '../../loop/erase';
import { computeSourceDigest } from '../../artifacts/source-digest';
import { avalonAdapter } from '../avalon';

const GAME_ID = 'avalon';
const WAVE_ID = 'a8-rejudge';
const CANDIDATE_FLAGS = [
  'avalonSuspicionTracking',
  'avalonSuspicionVoteOnly',
  'avalonSuspicionProposalOnly',
  'avalonSuspicionGoodOnly',
] as const;

const SOURCE_FILES = [join(__dirname, '..', 'avalon.ts')];

// C5's random-identity measured meanWinRate (runs/avalon/conformance/payload.json,
// docs/GAP-11-ROUNDS.md), quoted here only for the side-by-side comparison —
// this is NOT what gets fed into deriveBlueprint below.
const C5_RANDOM_IDENTITY_MEAN_WIN_RATE = 0.237;

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
  const classification = classifyGame(avalonAdapter.spec);

  console.log(`=== avalon-a8-rejudge runner (rootDir=${rootDir}) ===`);
  console.log(
    `   classification.identityCenter=${classification.identityCenter} (naive 1/playerCount, playerCount=${avalonAdapter.spec.playerCount}) — ` +
      'hiddenTeamStructure:true means this naive value is NOT a fair baseline (scoreC5 already knows this). ' +
      're-judging the 4 existing suspicion-tracking A8 candidates under a measured heuristic-identity baseline instead.',
  );

  console.log('1) G-Score conformance (re-check — no adapter changes expected, pure re-judgement)');
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

  console.log('2) load registry/ledger from runs/avalon/ (already exist from avalon.ts prior run)');
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
    throw new Error('avalon-a8-rejudge runner: v1 baseline missing — run avalon.ts first');
  }
  console.log(`   regression baseline: v1 (flags=[${v1.flags.join(', ')}])`);

  console.log('2.5) 캘리브레이션 — heuristic 항등 자기대국 실측 (random 항등도, naive 1/N도 아님)');
  const identitySeeds = Array.from({ length: 100 }, (_, i) => 2_001_000 + i);
  const noiseFloor = measureNoiseFloor(adapter, avalonAdapter.baselines.heuristic, identitySeeds, 2_002_000, {
    iterations: 2000,
    confidenceLevel: 0.95,
    seed: 44,
  });
  const measuredIdentityCenter = noiseFloor.pointWinRate;
  console.log(
    `   heuristic-identity self-play (heuristic vs heuristic, 100 seeds): pointWinRate(seat0)=${measuredIdentityCenter.toFixed(4)}, ` +
      `CI=[${noiseFloor.winRate.lower.toFixed(4)}, ${noiseFloor.winRate.upper.toFixed(4)}], blockStdDev=${noiseFloor.blockStdDev.toFixed(4)}, scoreDiffStdDev=${noiseFloor.scoreDiffStdDev.toFixed(4)}`,
  );
  console.log('   세 기준값 비교:');
  console.log(`     - naive 1/playerCount            = ${(1 / avalonAdapter.spec.playerCount).toFixed(4)} (틀린 기준 — hiddenTeamStructure 무시)`);
  console.log(`     - C5 random-identity meanWinRate  = ${C5_RANDOM_IDENTITY_MEAN_WIN_RATE.toFixed(4)} (scoreC5의 공정성 중심값 — random 항등, promotion 기준으로는 부적절)`);
  console.log(`     - heuristic-identity pointWinRate  = ${measuredIdentityCenter.toFixed(4)} (이번 러너가 실측 — promotionMinWinRate에 실제로 쓰일 값)`);

  const recommendedBlocks = noiseFloor.blockStdDev > 0
    ? recommendBlockCount({ blockStdDev: noiseFloor.blockStdDev, targetEffect: 0.05 })
    : 5;
  const clampedBlocks = Math.min(Math.max(recommendedBlocks, 5), 30);
  console.log(`   캘리브레이션: 권장 블록수=${recommendedBlocks}(클램프 후 ${clampedBlocks})`);

  console.log('3) wave — 4개 후보(avalonSuspicionTracking/VoteOnly/ProposalOnly/GoodOnly) vs v1, screen→smoke→prune→holdout');
  console.log(`   candidates: ${CANDIDATE_FLAGS.join(', ')}`);
  const promotionMinWinRate = measuredIdentityCenter + 0.03;
  console.log(
    `   보정된 기준: minWinRate은 assembleWaveConfig가 blueprint에서 자동 유도(measuredIdentityCenter+0.03=${promotionMinWinRate.toFixed(4)}), ` +
      `smoke SPRT p0=measuredIdentityCenter=${measuredIdentityCenter.toFixed(4)}, p1=p0+0.1=${(measuredIdentityCenter + 0.1).toFixed(4)}`,
  );

  const smokeMaxBlocks = clampedBlocks * 3;
  const waveLedger = new SeedLedger();
  const reservedAt = now();
  waveLedger.reserve({
    bankId: 'avalon-a8-rejudge-smoke',
    range: { start: 2_004_000, end: 2_004_000 + smokeMaxBlocks - 1 },
    purpose: 'smoke',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'avalon-a8-rejudge-prune',
    range: { start: 2_006_000, end: 2_006_000 + clampedBlocks - 1 },
    purpose: 'prune',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'avalon-a8-rejudge-holdout',
    range: { start: 2_008_000, end: 2_008_000 + clampedBlocks - 1 },
    purpose: 'holdout',
    reservedAt,
  });

  const smokeP0 = measuredIdentityCenter;
  const smokeP1 = smokeP0 + 0.1;
  const waveConfig = assembleWaveConfig(
    adapter,
    {
      waveId: WAVE_ID,
      candidates: CANDIDATE_FLAGS.map((flag) => ({ flag })),
      opponent: 'heuristic',
      ledger: waveLedger,
      recordedAt: now(),
      baselineFlags: v1.flags,
      baselineVersion: v1.version,
      tiers: {
        smoke: {
          bankId: 'avalon-a8-rejudge-smoke',
          sprt: { p0: smokeP0, p1: smokeP1, alpha: 0.1, beta: 0.1 },
          maxBlocks: smokeMaxBlocks,
          minBlocks: 5,
        },
        prune: { bankId: 'avalon-a8-rejudge-prune', blocks: clampedBlocks },
        holdout: { bankId: 'avalon-a8-rejudge-holdout', blocks: clampedBlocks },
      },
      screenProbe: { seeds: [2_003_001, 2_003_002, 2_003_003], botSeedBase: 2_003_100 },
    },
    {
      // Step 1's override — measured heuristic-identity win rate drives
      // promotionMinWinRate instead of the naive classification.identityCenter
      // (0.2), plus the same noise-floor calibration catan's rejudge2 wired
      // through for minScoreDiff (avalon is win-loss-only so this collapses
      // to 0 either way, but wired for parity with the catan pattern per
      // the design brief's "don't repeat catan's wiring gap" instruction).
      measuredIdentityCenter,
      blockStdDev: noiseFloor.blockStdDev,
      scoreDiffStdDev: noiseFloor.scoreDiffStdDev,
    },
  );
  console.log(
    `   criteria: minWinRate=${waveConfig.criteria.minWinRate} minScoreDiff=${waveConfig.criteria.minScoreDiff} (승/패 전용 게임 — scoreMargin:'none')`,
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
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'near-miss-a8-rejudge.json'), JSON.stringify(nearMiss, null, 2));
  console.log(`   저장: runs/${GAME_ID}/near-miss-a8-rejudge.json`);

  console.log('4.6) 웨이브 채택 플래그 registry 승격');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (adoptedFlags.length === 0) {
    console.log('   이번 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('avalon-a8-rejudge runner: registry has no latest baseline before promotion step');
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

  console.log('=== avalon-a8-rejudge runner complete ===');
}

main();
