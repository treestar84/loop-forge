/**
 * gomoku — per-game execution entrypoint (H5/H7): scores conformance, loads
 * (or bootstraps) this game's BaselineRegistry/AdoptionLedger from
 * `runs/gomoku/`, registers the pristine v1 baseline + benchmark anchors on
 * first run only, runs one small smoke-only wave over gomoku's strategy
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
import { mctsBotFactory, type MctsConfig } from '../../search/mcts';
import type { StrategyFlagSpec } from '../../contract/types';
import { gomokuAdapter } from '../gomoku';

const GAME_ID = 'gomoku';

/**
 * Simulation budget (docs/GAP-ANALYSIS-7.md O6). Measured with a throughput
 * script (scratch, not checked in): gomoku's cheap per-decision cost
 * (shallow rollouts on a 15x15 board) averaged ~320ms/game at 64 simulations
 * — the whole mcts-wave-1 tiers below stay well under a minute, comfortably
 * inside the 15-minutes-per-game runner budget.
 */
const GOMOKU_MCTS_CONFIG: MctsConfig = { simulations: 64, uctC: 1.4, rolloutCount: 2, label: 's64' };
const MCTS_FLAG = 'mcts-s64';

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
  const adapter = eraseAdapter(gomokuAdapter);
  const runStore = new RunStore(rootDir);
  const specDigest = sha256Digest(canonicalJson(adapter.spec));

  console.log(`=== gomoku runner (rootDir=${rootDir}) ===`);

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

  console.log('1.5) 캘리브레이션 — noise floor 기반 블록 수 산정');
  const identitySeeds = Array.from({ length: 100 }, (_, i) => 700_000 + i);
  const noiseFloor = measureNoiseFloor(adapter, gomokuAdapter.baselines.heuristic, identitySeeds, 600_000, {
    iterations: 2000,
    confidenceLevel: 0.95,
    seed: 42,
  });
  // heuristic 봇이 결정론적이면(오목 heuristic이 그렇다) identity self-play의
  // winFraction 분산이 정확히 0이 되어 recommendBlockCount가 계산 불가 —
  // 이 경우 표본 크기 근거를 낼 수 없으므로 클램프 하한(5)으로 대체한다.
  const recommendedBlocks = noiseFloor.blockStdDev > 0
    ? recommendBlockCount({ blockStdDev: noiseFloor.blockStdDev, targetEffect: 0.05 })
    : 5;
  const clampedBlocks = Math.min(Math.max(recommendedBlocks, 5), 30);
  console.log(
    `   캘리브레이션: blockStdDev=${noiseFloor.blockStdDev.toFixed(4)}, 권장 블록수=${recommendedBlocks}(클램프 후 ${clampedBlocks})`,
  );

  console.log('2) load-or-create registry/ledger from runs/gomoku/');
  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const ledger = loadOrCreateLedger(rootDir, GAME_ID);

  console.log('3) baseline v1 + anchors (register only if missing)');
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
    throw new Error('gomoku runner: v1 baseline missing after registration step');
  }

  console.log('4) small smoke-only wave over strategySurface flags');
  const flags = gomokuAdapter.strategySurface.map((spec) => spec.flag);
  console.log(`   candidates: ${flags.join(', ')}`);

  const smokeMaxBlocks = clampedBlocks * 3;
  const waveLedger = new SeedLedger();
  const reservedAt = now();
  waveLedger.reserve({
    bankId: 'gomoku-runner-smoke',
    range: { start: 1, end: smokeMaxBlocks },
    purpose: 'smoke',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'gomoku-runner-prune',
    range: { start: 1000, end: 999 + clampedBlocks },
    purpose: 'prune',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'gomoku-runner-holdout',
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
        bankId: 'gomoku-runner-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: smokeMaxBlocks,
        minBlocks: 5,
      },
      prune: { bankId: 'gomoku-runner-prune', blocks: clampedBlocks },
      holdout: { bankId: 'gomoku-runner-holdout', blocks: clampedBlocks },
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

  console.log('5) record adoption ledger entry');
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

  console.log('5.5) near-miss 후보 추출');
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
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'near-miss.json'), JSON.stringify(nearMiss, null, 2));
  console.log(`   저장: runs/${GAME_ID}/near-miss.json`);

  console.log('5.6) 웨이브 채택 플래그 registry 승격');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (adoptedFlags.length === 0) {
    console.log('   이번 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('gomoku runner: registry has no latest baseline before promotion step');
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
      });
      console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
    }
  }

  console.log('6) persist registry/ledger');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('7) game-summary 렌더');
  const summaryMarkdown = renderGameSummaryMarkdown(rootDir, GAME_ID, { latestWaveCriteria: waveConfig.criteria });
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'summary.md'), summaryMarkdown);
  console.log(`   게임 요약: runs/${GAME_ID}/summary.md`);

  console.log('8) MCTS 후보 웨이브 (mcts-wave-1)');
  // withStrategyFlags extends the adapter's strategySurface without touching
  // gomokuAdapter itself (loop layer helper, O4) — the mcts flag's apply()
  // ignores whatever base bot composeBot would otherwise thread through it,
  // since an MCTS candidate builds its decision from search, not by
  // modulating a base bot's choice (see src/search/mcts.ts's doc comment on
  // mctsBotFactory).
  const mctsFlagSpec: StrategyFlagSpec<unknown, unknown> = {
    flag: MCTS_FLAG,
    description: 'UCT MCTS search candidate (docs/GAP-ANALYSIS-7.md O5/O6); ignores the base bot entirely.',
    apply: () => mctsBotFactory(adapter, GOMOKU_MCTS_CONFIG),
  };
  const mctsAdapter = withStrategyFlags(adapter, [mctsFlagSpec]);

  const mctsLatest = registry.latest();
  if (mctsLatest === undefined) {
    throw new Error('gomoku runner: registry has no latest baseline before the MCTS wave');
  }

  const mctsLedger = new SeedLedger();
  const mctsReservedAt = now();
  const mctsSmokeMax = 30;
  const mctsPruneBlocks = 15;
  const mctsHoldoutBlocks = 15;
  mctsLedger.reserve({
    bankId: 'gomoku-mcts-smoke',
    range: { start: 8000, end: 8000 + mctsSmokeMax - 1 },
    purpose: 'smoke',
    reservedAt: mctsReservedAt,
  });
  mctsLedger.reserve({
    bankId: 'gomoku-mcts-prune',
    range: { start: 9000, end: 9000 + mctsPruneBlocks - 1 },
    purpose: 'prune',
    reservedAt: mctsReservedAt,
  });
  mctsLedger.reserve({
    bankId: 'gomoku-mcts-holdout',
    range: { start: 10000, end: 10000 + mctsHoldoutBlocks - 1 },
    purpose: 'holdout',
    reservedAt: mctsReservedAt,
  });

  const mctsWaveConfig = assembleWaveConfig(mctsAdapter, {
    waveId: 'mcts-wave-1',
    candidates: [{ flag: MCTS_FLAG }],
    opponent: 'heuristic',
    ledger: mctsLedger,
    recordedAt: now(),
    baselineFlags: mctsLatest.flags,
    baselineVersion: mctsLatest.version,
    tiers: {
      smoke: {
        bankId: 'gomoku-mcts-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: mctsSmokeMax,
        minBlocks: 5,
      },
      prune: { bankId: 'gomoku-mcts-prune', blocks: mctsPruneBlocks },
      holdout: { bankId: 'gomoku-mcts-holdout', blocks: mctsHoldoutBlocks },
    },
    screenProbe: { seeds: [1, 2, 3], botSeedBase: 100 },
  });

  const mctsReport = runWave(mctsAdapter, mctsWaveConfig);
  for (const result of mctsReport.results) {
    console.log(`   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`);
    for (const tier of ['screen', 'smoke', 'prune', 'holdout'] as const) {
      const stats = result.stats[tier];
      if (stats) {
        console.log(`     ${tier}: winRate=${stats.pointWinRate.toFixed(3)} blocks=${stats.blocks}`);
      }
    }
  }

  saveRunIfAbsent(runStore, {
    gameId: GAME_ID,
    runId: mctsReport.waveId,
    kind: 'wave',
    recordedAt: now(),
    comparabilityKey: mctsReport.comparabilityKey,
    payload: mctsReport,
    markdown: `# Wave Report — ${mctsReport.waveId}\n\n${mctsReport.results
      .map((r) => `- ${r.flag}: ${r.verdict} (tiers: ${r.tiersPassed.join('→') || 'none'})`)
      .join('\n')}\n`,
  });

  console.log('9) MCTS 웨이브 adoption ledger 기록');
  const mctsEntries: AdoptionEntry[] = mctsReport.results.map((result) => {
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
  const mctsAdoptionRecord = ledger.add({
    waveId: mctsReport.waveId,
    recordedAt: now(),
    comparabilityKey: mctsReport.comparabilityKey,
    baselineVersion: mctsLatest.version,
    opponentId: mctsWaveConfig.opponent,
    entries: mctsEntries,
    nextLoopNotes: [],
  });

  console.log('9.5) MCTS near-miss 후보 추출');
  const mctsNearMiss = extractNearMissCandidates(mctsAdoptionRecord, mctsWaveConfig.criteria);
  if (mctsNearMiss.length === 0) {
    console.log('   근접실패 후보 없음.');
  } else {
    for (const candidate of mctsNearMiss) {
      console.log(
        `   flags=[${candidate.flags.join('+')}] failedAtTier=${candidate.failedAtTier} winRateGap=${candidate.gap.winRateGap.toFixed(4)} scoreDiffGap=${candidate.gap.scoreDiffGap.toFixed(4)}`,
      );
    }
  }
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'mcts-near-miss.json'), JSON.stringify(mctsNearMiss, null, 2));
  console.log(`   저장: runs/${GAME_ID}/mcts-near-miss.json`);

  console.log('9.6) MCTS 웨이브 채택 플래그 registry 승격');
  const mctsAdoptedFlags = mctsReport.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (mctsAdoptedFlags.length === 0) {
    console.log('   이번 MCTS 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('gomoku runner: registry has no latest baseline before MCTS promotion step');
    }
    const lineage = registry.lineage(currentLatest.version);
    const alreadyPromoted = lineage.some((version) => version.sourceWaveId === mctsReport.waveId);
    if (alreadyPromoted) {
      console.log('   이 MCTS 웨이브는 이미 승격됨 — 스킵');
    } else {
      const nextVersion = registry.register({
        version: `v${lineage.length + 1}`,
        flags: [...currentLatest.flags, ...mctsAdoptedFlags],
        parent: currentLatest.version,
        createdAt: now(),
        sourceWaveId: mctsReport.waveId,
        notes: `MCTS 웨이브 ${mctsReport.waveId}에서 채택된 플래그 승격: ${mctsAdoptedFlags.join(', ')}`,
      });
      console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
    }
  }

  console.log('10) persist registry/ledger (MCTS 웨이브 반영)');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('11) game-summary 재렌더 (MCTS 웨이브 반영)');
  const finalSummaryMarkdown = renderGameSummaryMarkdown(rootDir, GAME_ID, {
    latestWaveCriteria: mctsWaveConfig.criteria,
  });
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'summary.md'), finalSummaryMarkdown);
  console.log(`   게임 요약: runs/${GAME_ID}/summary.md`);
}

main();
