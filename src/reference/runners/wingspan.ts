/**
 * wingspan — per-game execution entrypoint (H5/H7): scores conformance, loads
 * (or bootstraps) this game's BaselineRegistry/AdoptionLedger from
 * `runs/wingspan/`, registers the pristine v1 baseline + benchmark anchors on
 * first run only, runs one small smoke-only wave over wingspan's strategy
 * surface, and persists everything back to disk. Designed to be re-run
 * across sessions: a second run reloads the same registry/ledger instead of
 * starting over, appends its wave's adoption record, and does not attempt to
 * re-register anchors that are already frozen.
 *
 * Every file under reference/runners/ is an app boundary (see
 * src/__tests__/dependency-rules.test.ts's APP_BOUNDARY_PREFIXES) — this is
 * the one place allowed to call `new Date().toISOString()` for this game.
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
import { withStrategyFlags } from '../../loop/compose';
import { wingspanAdapter } from '../wingspan';
import { WINGSPAN_ISMCTS_S256_HR_FLAG, wingspanIsmctsFlagSpec } from './shared/wingspan-ismcts-flag';

const GAME_ID = 'wingspan';

function now(): string {
  return new Date().toISOString();
}

/** RunStore.saveRun throws when a runId already exists (append-only evidence)
 * — expected on the second-and-later run of this entrypoint against the same
 * runId convention, so it's swallowed with a log line rather than crashing. */
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
  const adapter = eraseAdapter(wingspanAdapter);
  const runStore = new RunStore(rootDir);
  const specDigest = sha256Digest(canonicalJson(adapter.spec));

  console.log(`=== wingspan runner (rootDir=${rootDir}) ===`);

  console.log('1) G-Score conformance');
  const conformance = scoreAdapter(adapter, {});
  console.log(`   score=${conformance.overallScore} ready=${conformance.ready}`);
  saveRunIfAbsent(runStore, {
    gameId: GAME_ID,
    runId: 'conformance',
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

  console.log('2) 캘리브레이션 (표본 크기 근거 확보)');
  const identitySeeds = Array.from({ length: 100 }, (_, i) => 900_000 + i);
  const noiseFloor = measureNoiseFloor(adapter, wingspanAdapter.baselines.heuristic, identitySeeds, 800_000, {
    iterations: 2000,
    confidenceLevel: 0.95,
    seed: 123,
  });
  // blockStdDev===0 (또는 recommendBlockCount의 예외)은 signal collapse —
  // 다른 러너에서 이미 관찰된 현상(docs/GAP-ANALYSIS-2.md X1) — 이므로
  // 크래시하지 않고 클램프 하한으로 폴백한다.
  let recommendedBlocks: number | undefined;
  if (noiseFloor.blockStdDev > 0) {
    try {
      recommendedBlocks = recommendBlockCount({ blockStdDev: noiseFloor.blockStdDev, targetEffect: 0.05 });
    } catch {
      recommendedBlocks = undefined;
    }
  }
  const clampedBlocks = Math.min(Math.max(recommendedBlocks ?? 5, 5), 30);
  console.log(
    `   캘리브레이션: blockStdDev=${noiseFloor.blockStdDev.toFixed(4)}, ` +
      (recommendedBlocks === undefined
        ? `권장 블록수=N/A (signal collapse, 클램프 하한 ${clampedBlocks} 사용)`
        : `권장 블록수=${recommendedBlocks}` +
          (clampedBlocks !== recommendedBlocks ? `, 클램프 후=${clampedBlocks}` : '')),
  );

  console.log('3) load-or-create registry/ledger from runs/wingspan/');
  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const ledger = loadOrCreateLedger(rootDir, GAME_ID);

  console.log('4) baseline v1 + anchors (register only if missing)');
  if (registry.get('v1') === undefined) {
    registry.register({
      version: 'v1',
      flags: [],
      parent: null,
      createdAt: now(),
      sourceWaveId: null,
      notes: '순정 heuristic 기준선 (플래그 없음).',
    });
    console.log('   registered v1');
  } else {
    console.log('   v1 already registered — skipped');
  }
  for (const anchorId of ['anchor-random', 'anchor-heuristic'] as const) {
    if (registry.getAnchor(anchorId) === undefined) {
      registry.registerAnchor({ anchorId, kind: anchorId === 'anchor-random' ? 'random' : 'heuristic' });
      console.log(`   registered anchor ${anchorId}`);
    } else {
      console.log(`   anchor ${anchorId} already frozen — skipped`);
    }
  }
  const v1 = registry.get('v1');
  if (v1 === undefined) {
    throw new Error('wingspan runner: v1 baseline missing after registration step');
  }

  console.log('5) small smoke-only wave over strategySurface flags');
  const flags = wingspanAdapter.strategySurface.map((spec) => spec.flag);
  console.log(`   candidates: ${flags.join(', ')}`);

  const waveLedger = new SeedLedger();
  const reservedAt = now();
  const smokeMaxBlocks = clampedBlocks * 3;
  waveLedger.reserve({
    bankId: 'wingspan-runner-smoke',
    range: { start: 1, end: smokeMaxBlocks },
    purpose: 'smoke',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'wingspan-runner-prune',
    range: { start: 1000, end: 999 + clampedBlocks },
    purpose: 'prune',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'wingspan-runner-holdout',
    range: { start: 2000, end: 1999 + clampedBlocks },
    purpose: 'holdout',
    reservedAt,
  });

  const waveConfig = assembleWaveConfig(adapter, {
    waveId: 'runner-wave',
    candidates: flags.map((flag) => ({ flag })),
    opponent: 'heuristic',
    ledger: waveLedger,
    recordedAt: now(),
    baselineFlags: v1.flags,
    baselineVersion: v1.version,
    tiers: {
      smoke: {
        bankId: 'wingspan-runner-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: smokeMaxBlocks,
        minBlocks: 5,
      },
      prune: { bankId: 'wingspan-runner-prune', blocks: clampedBlocks },
      holdout: { bankId: 'wingspan-runner-holdout', blocks: clampedBlocks },
    },
    screenProbe: { seeds: [1, 2, 3], botSeedBase: 100 },
  });

  const report = runWave(adapter, waveConfig);
  for (const result of report.results) {
    console.log(`   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`);
  }

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

  console.log('6) record adoption ledger entry');
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

  console.log('7) near-miss candidate extraction');
  const nearMiss = extractNearMissCandidates(adoptionRecord, waveConfig.criteria);
  if (nearMiss.length === 0) {
    console.log('   근접실패 후보 없음');
  } else {
    for (const candidate of nearMiss) {
      console.log(
        `   flags=${JSON.stringify(candidate.flags)} failedAtTier=${candidate.failedAtTier} winRateGap=${candidate.gap.winRateGap.toFixed(4)} scoreDiffGap=${candidate.gap.scoreDiffGap.toFixed(4)}`,
      );
    }
  }
  writeFileSync(join(rootDir, 'runs', 'wingspan', 'near-miss.json'), JSON.stringify(nearMiss, null, 2));

  console.log('7.5) baseline promotion');
  const adoptedFlags = report.results
    .filter((result) => result.verdict === 'adopted')
    .flatMap((result) => result.flags);
  if (adoptedFlags.length === 0) {
    console.log('   이번 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('registry.latest() returned undefined after v1 registration');
    }
    const lineage = registry.lineage(currentLatest.version);
    const alreadyPromoted = lineage.some((version) => version.sourceWaveId === report.waveId);
    if (alreadyPromoted) {
      console.log('   이 웨이브는 이미 승격됨 — 스킵');
    } else {
      const promoted = registry.register({
        version: `v${lineage.length + 1}`,
        flags: [...currentLatest.flags, ...adoptedFlags],
        parent: currentLatest.version,
        createdAt: now(),
        sourceWaveId: report.waveId,
        notes: `웨이브 ${report.waveId}에서 채택된 플래그 승격: ${adoptedFlags.join(', ')}`,
      });
      console.log(`   승격: ${promoted.version}, flags=${JSON.stringify(promoted.flags)}`);
    }
  }

  console.log('8) persist registry/ledger');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('9) game summary');
  const summaryMarkdown = renderGameSummaryMarkdown(rootDir, GAME_ID, {
    latestWaveCriteria: waveConfig.criteria,
  });
  writeFileSync(join(rootDir, 'runs', 'wingspan', 'summary.md'), summaryMarkdown);
  console.log('   게임 요약: runs/wingspan/summary.md');

  /**
   * 10) ismcts-wave-1 (docs/FIX-BACKLOG.md P4). Wingspan has real hidden
   * information — `getObservation` exposes only `opponentHandCount`, never
   * opponent hand contents, and the shared deck's identities/order are never
   * exposed either (`deckCount` only) — but every bird id is globally
   * unique and appears in exactly one zone for the whole game
   * (`cardConservationInvariant`/`noDuplicateCardsInvariant`,
   * src/reference/wingspan.ts), so `sampleStateFromObservation` reconstructs
   * the single hidden pool (opponent hand + shared deck) directly from the
   * fixed 20-bird `BIRD_IDS` universe minus every known public zone, with no
   * per-instance id scheme needed the way hearthstone's mirrored deck
   * required (see that function's own doc comment for the full design).
   * `ismctsBotFactory` (src/search/ismcts.ts) runs SO-ISMCTS on top of it —
   * same mechanism as every other game's ismcts-wave-1. Single candidate
   * `ismcts-s256-hr` (shared/wingspan-ismcts-flag.ts — see its doc comment
   * for the throughput measurement that picked simulations=256, double
   * hearthstone's picked budget, since this game's short 20-decision-max
   * playouts turned out far cheaper per game than every other onboarded
   * game so far), opponent 'heuristic' like every other wave, plus a
   * regression tier against the CURRENT baseline composite bot
   * (registry.latest() — docs/GAP-ANALYSIS-7.md O10 lesson: a raw-heuristic-
   * only gate can't detect a candidate that is actually weaker than the
   * already-adopted baseline; wingspan's registry has adopted 0 candidates
   * so far per `runs/wingspan/registry.json`'s `versionOrder: ["v1"]`, so as
   * of this wave the baseline composite bot is still plain heuristic — same
   * opponent as every other tier, at the same per-game cost).
   *
   * Wingspan is a 2-player game with `scoreMargin` left undeclared (defaults
   * to 'scored', src/kernel/classify.ts — `getOutcome` reports each player's
   * summed bird points as `scores`, which genuinely is a meaningful margin,
   * just never explicitly opted into via the spec field; `blueprint.ts`
   * flags this as a warning, not a blocker — same undeclared state as
   * hearthstone's ismcts-wave-1 comment) and `utility` left undeclared
   * (defaults to 'general', contract/types.ts) — same "no CFR/UCT
   * convergence guarantee, not a reason to withhold the candidate" reasoning
   * as every other game's ismcts-wave-1 comments; smoke/prune/holdout/
   * regression against `DEFAULT_CRITERIA`'s minScoreDiff=5 gate is what
   * decides, with no search-bot special case. This is exactly the
   * scoreMargin=scored / small-point-scale shape docs/FIX-BACKLOG.md P6
   * flags as prone to screening out a winRate-dominant-but-score-diff-small
   * candidate (splendor's and dominion's ismcts-wave-1 both hit this) — a
   * deliberate observation point for this wave's outcome, not a reason to
   * relax the gate here.
   *
   * Block-count arithmetic (throughput from
   * shared/wingspan-ismcts-flag.ts's doc comment; 1 block = 2 games;
   * ~17.3ms/game observed at s256-hr, rounded up for safety margin against
   * the small 3-seed sample):
   *   smoke      <=30 blocks = 60 games * ~18ms ≈  1.1s
   *   prune        15 blocks = 30 games * ~18ms ≈  0.6s
   *   holdout      15 blocks = 30 games * ~18ms ≈  0.6s
   *   regression   20 blocks = 40 games * ~18ms ≈  0.8s
   *   total ≈ 3.1s — trivially inside the 30-minute wave ceiling.
   *
   * New seed banks (wingspan-ismcts-*, ranges 30000-33019) do not overlap
   * any range used above (wingspan-runner-{smoke,prune,holdout}: 1-90,
   * 1000-1029, 2000-2029) or by wingspan-benchmark.ts (SEED_BASE=50,000+).
   */
  console.log('10) IS-MCTS 후보 웨이브 (ismcts-wave-1)');
  const ismctsFlagSpec = wingspanIsmctsFlagSpec(adapter);
  const ismctsAdapter = withStrategyFlags(adapter, [ismctsFlagSpec]);

  const ismctsLatest = registry.latest();
  if (ismctsLatest === undefined) {
    throw new Error('wingspan runner: registry has no latest baseline before ismcts-wave-1');
  }

  const ismctsLedger = new SeedLedger();
  const ismctsReservedAt = now();
  const ismctsSmokeMax = 30;
  const ismctsPruneBlocks = 15;
  const ismctsHoldoutBlocks = 15;
  const ismctsRegressionBlocks = 20;
  ismctsLedger.reserve({
    bankId: 'wingspan-ismcts-smoke',
    range: { start: 30000, end: 30000 + ismctsSmokeMax - 1 },
    purpose: 'smoke',
    reservedAt: ismctsReservedAt,
  });
  ismctsLedger.reserve({
    bankId: 'wingspan-ismcts-prune',
    range: { start: 31000, end: 31000 + ismctsPruneBlocks - 1 },
    purpose: 'prune',
    reservedAt: ismctsReservedAt,
  });
  ismctsLedger.reserve({
    bankId: 'wingspan-ismcts-holdout',
    range: { start: 32000, end: 32000 + ismctsHoldoutBlocks - 1 },
    purpose: 'holdout',
    reservedAt: ismctsReservedAt,
  });
  ismctsLedger.reserve({
    bankId: 'wingspan-ismcts-regression',
    range: { start: 33000, end: 33000 + ismctsRegressionBlocks - 1 },
    purpose: 'regression',
    reservedAt: ismctsReservedAt,
  });

  const ismctsWaveConfig = assembleWaveConfig(ismctsAdapter, {
    waveId: 'ismcts-wave-1',
    candidates: [{ flag: WINGSPAN_ISMCTS_S256_HR_FLAG }],
    opponent: 'heuristic',
    ledger: ismctsLedger,
    recordedAt: now(),
    baselineFlags: ismctsLatest.flags,
    baselineVersion: ismctsLatest.version,
    tiers: {
      smoke: {
        bankId: 'wingspan-ismcts-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: ismctsSmokeMax,
        minBlocks: 5,
      },
      prune: { bankId: 'wingspan-ismcts-prune', blocks: ismctsPruneBlocks },
      holdout: { bankId: 'wingspan-ismcts-holdout', blocks: ismctsHoldoutBlocks },
      regression: { bankId: 'wingspan-ismcts-regression', blocks: ismctsRegressionBlocks },
    },
    screenProbe: { seeds: [1, 2, 3], botSeedBase: 100 },
  });

  const ismctsReport = runWave(ismctsAdapter, ismctsWaveConfig);
  for (const result of ismctsReport.results) {
    console.log(
      `   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`,
    );
    for (const tier of ['screen', 'smoke', 'prune', 'holdout', 'regression'] as const) {
      const stats = result.stats[tier];
      if (stats) {
        console.log(`     ${tier}: winRate=${stats.pointWinRate.toFixed(3)} blocks=${stats.blocks} scoreDiff=${stats.pointScoreDiff.toFixed(3)}`);
      }
    }
    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        console.log(`     ⚠ ${warning}`);
      }
    }
  }

  saveRunIfAbsent(runStore, {
    gameId: GAME_ID,
    runId: ismctsReport.waveId,
    kind: 'wave',
    recordedAt: now(),
    comparabilityKey: ismctsReport.comparabilityKey,
    payload: ismctsReport,
    markdown: `# Wave Report — ${ismctsReport.waveId}\n\n${ismctsReport.results
      .map((r) => `- ${r.flag}: ${r.verdict} (tiers: ${r.tiersPassed.join('→') || 'none'})`)
      .join('\n')}\n`,
  });

  console.log('11) ismcts-wave-1 adoption ledger 기록');
  const ismctsEntries: AdoptionEntry[] = ismctsReport.results.map((result) => {
    const tierStats: AdoptionEntry['tierStats'] = {};
    for (const tier of ['screen', 'smoke', 'prune', 'holdout', 'regression'] as const) {
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
  const ismctsAdoptionRecord = ledger.add({
    waveId: ismctsReport.waveId,
    recordedAt: now(),
    comparabilityKey: ismctsReport.comparabilityKey,
    baselineVersion: ismctsLatest.version,
    opponentId: ismctsWaveConfig.opponent,
    entries: ismctsEntries,
    nextLoopNotes: [],
  });

  console.log('11.5) ismcts-wave-1 near-miss 후보 추출');
  const ismctsNearMiss = extractNearMissCandidates(ismctsAdoptionRecord, ismctsWaveConfig.criteria);
  if (ismctsNearMiss.length === 0) {
    console.log('   근접실패 후보 없음.');
  } else {
    for (const candidate of ismctsNearMiss) {
      console.log(
        `   flags=[${candidate.flags.join('+')}] failedAtTier=${candidate.failedAtTier} winRateGap=${candidate.gap.winRateGap.toFixed(4)} scoreDiffGap=${candidate.gap.scoreDiffGap.toFixed(4)}`,
      );
    }
  }
  writeFileSync(
    join(rootDir, 'runs', GAME_ID, 'ismcts-wave-1-near-miss.json'),
    JSON.stringify(ismctsNearMiss, null, 2),
  );
  console.log(`   저장: runs/${GAME_ID}/ismcts-wave-1-near-miss.json`);

  console.log('11.6) ismcts-wave-1 채택 플래그 registry 승격');
  const ismctsAdoptedFlags = ismctsReport.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (ismctsAdoptedFlags.length === 0) {
    console.log('   이번 ismcts-wave-1에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('wingspan runner: registry has no latest baseline before ismcts-wave-1 promotion step');
    }
    const lineage = registry.lineage(currentLatest.version);
    const alreadyPromoted = lineage.some((version) => version.sourceWaveId === ismctsReport.waveId);
    if (alreadyPromoted) {
      console.log('   이 ismcts-wave-1은 이미 승격됨 — 스킵');
    } else {
      const nextVersion = registry.register({
        version: `v${lineage.length + 1}`,
        flags: [...currentLatest.flags, ...ismctsAdoptedFlags],
        parent: currentLatest.version,
        createdAt: now(),
        sourceWaveId: ismctsReport.waveId,
        notes: `ismcts-wave-1에서 채택된 플래그 승격: ${ismctsAdoptedFlags.join(', ')}`,
      });
      console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
    }
  }

  console.log('12) persist registry/ledger (ismcts-wave-1 반영)');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('13) game-summary 재렌더 (ismcts-wave-1 반영)');
  const finalSummaryMarkdown = renderGameSummaryMarkdown(rootDir, GAME_ID, {
    latestWaveCriteria: ismctsWaveConfig.criteria,
  });
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'summary.md'), finalSummaryMarkdown, 'utf8');
  console.log(`   게임 요약: runs/${GAME_ID}/summary.md`);
}

main();
