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
import {
  GOMOKU_MCTS_HR_CONFIG,
  GOMOKU_MCTS_HR_FLAG,
  GOMOKU_MCTS2_S256_CONFIG,
  GOMOKU_MCTS2_S256_FLAG,
  GOMOKU_MCTS2_S256_HR_CONFIG,
  GOMOKU_MCTS2_S256_HR_FLAG,
  gomokuMctsFlagSpecFor,
} from './shared/gomoku-mcts-flag';
import { computeSourceDigest } from '../../artifacts/source-digest';

const GAME_ID = 'gomoku';

/**
 * Source closure (approximate — see artifacts/source-digest.ts's doc
 * comment) for this game's flag-behavior-relevant code: the adapter itself,
 * search/mcts.ts (this game's flags are all MCTS configs), this game's
 * shared MCTS flag spec, and loop/compose.ts (every registered version's
 * flags are reassembled through composeBot, so a change there can change
 * every version's behavior too). Written for the exact P5 incident this
 * feature targets (see the P5 BEHAVIOR CHANGE NOTICE above): a
 * search/mcts.ts fix silently changed "mcts-s64"'s reassembly behavior with
 * no way to detect it from the version record.
 */
const SOURCE_FILES = [
  join(__dirname, '..', 'gomoku.ts'),
  join(__dirname, '..', '..', 'search', 'mcts.ts'),
  join(__dirname, 'shared', 'gomoku-mcts-flag.ts'),
  join(__dirname, '..', '..', 'loop', 'compose.ts'),
];

/**
 * Simulation budget (docs/GAP-ANALYSIS-7.md O6). Measured with a throughput
 * script (scratch, not checked in): gomoku's cheap per-decision cost
 * (shallow rollouts on a 15x15 board) averaged ~320ms/game at 64 simulations
 * — the whole mcts-wave-1 tiers below stay well under a minute, comfortably
 * inside the 15-minutes-per-game runner budget.
 */
/**
 * P5 BEHAVIOR CHANGE NOTICE (docs/FIX-BACKLOG.md P5): search/mcts.ts's
 * budget<branching-factor fix (reward-aware tie-break + rng-shuffled
 * expansion order) changes what bot "mcts-s64" actually plays even though its
 * flag name/config below are unchanged — see search/mcts.ts's top-of-file
 * comment and shared/gomoku-mcts-flag.ts's GOMOKU_MCTS_CONFIG comment for the
 * full explanation. Registry v3's "mcts-s64" reconstructs to a different bot
 * post-fix than the one that was adopted.
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
  const sourceDigest = computeSourceDigest(SOURCE_FILES);
  const priorLatest = registry.latest();
  // Warn-only, not a block (docs/GAP-ANALYSIS-8.md §2 v1 policy): a source
  // drift since the last registered version means that version's flags may
  // now reassemble differently than when it was adopted (exactly the P5
  // mcts-s64 incident above), but stopping the runner here would make every
  // code fix to search/mcts.ts also block every game's runner —
  // reproducibility status should stay visible, not gate experimentation.
  if (priorLatest?.sourceDigest !== undefined && priorLatest.sourceDigest !== sourceDigest) {
    console.log(
      `   ⚠ source drift detected: registry latest (${priorLatest.version}) was registered with sourceDigest=${priorLatest.sourceDigest}, current source=${sourceDigest} — this version's flags may now reassemble differently than when it was adopted (see artifacts/source-digest.ts).`,
    );
  } else if (priorLatest !== undefined && priorLatest.sourceDigest === undefined) {
    console.log(`   registry latest (${priorLatest.version}) predates sourceDigest tracking — no drift check possible`);
  }

  console.log('3) baseline v1 + anchors (register only if missing)');
  if (registry.get('v1') === undefined) {
    registry.register({
      version: 'v1',
      flags: [],
      parent: null,
      createdAt: now(),
      sourceWaveId: null,
      notes: '순정 heuristic 기준선 (플래그 없음).',
      sourceDigest,
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
        sourceDigest,
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
  // Every MCTS flag spec ever defined by any wave in this file is built here,
  // up front, and threaded into every wave's wired adapter below (not just
  // the wave that introduces it). `composeBot` must resolve every flag named
  // in a wave's `baselineFlags` (which mirrors registry.latest() AT RUN TIME,
  // not at whichever wave originally introduced the flag), so on a re-run —
  // after an earlier session promoted a later wave's candidate into the
  // registry — an earlier wave's adapter would otherwise throw
  // `composeBot: unknown strategy flag "..."` the moment its baseline
  // includes a flag that wave's own adapter never learned about. Discovered
  // via this exact crash on gomoku-wave-3's second run (docs/FIX-BACKLOG.md
  // P5).
  const mctsHrFlagSpecEarly = gomokuMctsFlagSpecFor(adapter, GOMOKU_MCTS_HR_CONFIG, GOMOKU_MCTS_HR_FLAG);
  const mcts2S256FlagSpecEarly = gomokuMctsFlagSpecFor(adapter, GOMOKU_MCTS2_S256_CONFIG, GOMOKU_MCTS2_S256_FLAG);
  const mcts2S256HrFlagSpecEarly = gomokuMctsFlagSpecFor(
    adapter,
    GOMOKU_MCTS2_S256_HR_CONFIG,
    GOMOKU_MCTS2_S256_HR_FLAG,
  );
  const allMctsFlagSpecs = [mctsFlagSpec, mctsHrFlagSpecEarly, mcts2S256FlagSpecEarly, mcts2S256HrFlagSpecEarly];
  const mctsAdapter = withStrategyFlags(adapter, allMctsFlagSpecs);

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
        sourceDigest,
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

  /**
   * 12) mcts-wave-2 (docs/FIX-BACKLOG.md P1) — heuristic-rollout MCTS
   * candidate `mcts-s64-hr`, re-attempting gomoku's search family after
   * docs/BENCHMARK-LEADERBOARD.md "결과 2" found the pure-random-rollout
   * mcts-s64 loses the C-column matchup (Opus bot vs loopforge bot) 100-0.
   * This wave adds a `tiers.regression` block (O10): after holdout passes,
   * the candidate must also beat the CURRENT baseline composite bot
   * (registry.latest()'s flags composed — which, since mcts-s64's apply()
   * discards `base`, resolves to the pure mcts-s64 bot) rather than only the
   * raw heuristic every other tier faces. That is the direct test of whether
   * heuristic rollout is actually stronger than random rollout, not just
   * stronger than the unflagged baseline.
   *
   * Throughput measurement (scratch script, not checked in; mctsBotFactory
   * timed via runMatch, 5 games/config, gomoku 15x15 board):
   *   - mcts-s64 (random rollout, rolloutCount=2) vs heuristic:      ~242ms/game
   *   - mcts-s64-hr (heuristic rollout, rolloutCount=1) vs heuristic: ~166ms/game
   *   - mcts-s64-hr (heuristic rollout, rolloutCount=2) vs heuristic: ~325ms/game
   *   - mcts-s64-hr(rolloutCount=1) vs mcts-s64(baseline) [regression matchup,
   *     BOTH sides run MCTS search — the expensive case]:           ~1,107ms/game
   *   - mcts-s64-hr(rolloutCount=2) vs mcts-s64(baseline) [regression matchup]: ~1,458ms/game
   * rolloutCount=1 was chosen for mcts-s64-hr (GOMOKU_MCTS_HR_CONFIG) precisely
   * because the regression tier's matchup is MCTS-vs-MCTS: at rolloutCount=1,
   * smoke(<=30 blocks=60 games)+prune(15 blocks=30 games)+holdout(15
   * blocks=30 games) against heuristic cost roughly
   * (60+30+30)*166ms ≈ 20s, and the regression tier (40 blocks=80 games)
   * against the mcts-s64 baseline costs roughly 80*1,107ms ≈ 89s — the whole
   * wave stays well under the 30-minute budget (total ≈ 2 minutes) with
   * comfortable headroom, unlike rolloutCount=2's regression cost
   * (80*1,458ms ≈ 117s, still fine, but rolloutCount=1 is the more
   * conservative choice given regression is the dominant cost driver).
   */
  console.log('12) MCTS 후보 웨이브 2 (mcts-wave-2, heuristic-rollout + regression 티어)');
  // Reuse the shared specs (built once, above, alongside every other MCTS
  // flag spec) rather than redefining them — see allMctsFlagSpecs's doc comment.
  const mctsWave2Adapter = withStrategyFlags(adapter, allMctsFlagSpecs);

  const mctsWave2Latest = registry.latest();
  if (mctsWave2Latest === undefined) {
    throw new Error('gomoku runner: registry has no latest baseline before mcts-wave-2');
  }

  const mctsWave2Ledger = new SeedLedger();
  const mctsWave2ReservedAt = now();
  const mctsWave2SmokeMax = 30;
  const mctsWave2PruneBlocks = 15;
  const mctsWave2HoldoutBlocks = 15;
  const mctsWave2RegressionBlocks = 40;
  mctsWave2Ledger.reserve({
    bankId: 'gomoku-mcts2-smoke',
    range: { start: 20000, end: 20000 + mctsWave2SmokeMax - 1 },
    purpose: 'smoke',
    reservedAt: mctsWave2ReservedAt,
  });
  mctsWave2Ledger.reserve({
    bankId: 'gomoku-mcts2-prune',
    range: { start: 21000, end: 21000 + mctsWave2PruneBlocks - 1 },
    purpose: 'prune',
    reservedAt: mctsWave2ReservedAt,
  });
  mctsWave2Ledger.reserve({
    bankId: 'gomoku-mcts2-holdout',
    range: { start: 22000, end: 22000 + mctsWave2HoldoutBlocks - 1 },
    purpose: 'holdout',
    reservedAt: mctsWave2ReservedAt,
  });
  mctsWave2Ledger.reserve({
    bankId: 'gomoku-mcts2-regression',
    range: { start: 23000, end: 23000 + mctsWave2RegressionBlocks - 1 },
    purpose: 'regression',
    reservedAt: mctsWave2ReservedAt,
  });

  const mctsWave2Config = assembleWaveConfig(mctsWave2Adapter, {
    waveId: 'mcts-wave-2',
    candidates: [{ flag: GOMOKU_MCTS_HR_FLAG }],
    opponent: 'heuristic',
    ledger: mctsWave2Ledger,
    recordedAt: now(),
    baselineFlags: mctsWave2Latest.flags,
    baselineVersion: mctsWave2Latest.version,
    tiers: {
      smoke: {
        bankId: 'gomoku-mcts2-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: mctsWave2SmokeMax,
        minBlocks: 5,
      },
      prune: { bankId: 'gomoku-mcts2-prune', blocks: mctsWave2PruneBlocks },
      holdout: { bankId: 'gomoku-mcts2-holdout', blocks: mctsWave2HoldoutBlocks },
      regression: { bankId: 'gomoku-mcts2-regression', blocks: mctsWave2RegressionBlocks },
    },
    screenProbe: { seeds: [1, 2, 3], botSeedBase: 100 },
  });

  const mctsWave2Report = runWave(mctsWave2Adapter, mctsWave2Config);
  for (const result of mctsWave2Report.results) {
    console.log(
      `   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`,
    );
    for (const tier of ['screen', 'smoke', 'prune', 'holdout', 'regression'] as const) {
      const stats = result.stats[tier];
      if (stats) {
        console.log(`     ${tier}: winRate=${stats.pointWinRate.toFixed(3)} blocks=${stats.blocks}`);
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
    runId: mctsWave2Report.waveId,
    kind: 'wave',
    recordedAt: now(),
    comparabilityKey: mctsWave2Report.comparabilityKey,
    payload: mctsWave2Report,
    markdown: `# Wave Report — ${mctsWave2Report.waveId}\n\n${mctsWave2Report.results
      .map((r) => `- ${r.flag}: ${r.verdict} (tiers: ${r.tiersPassed.join('→') || 'none'})`)
      .join('\n')}\n`,
  });

  console.log('13) mcts-wave-2 adoption ledger 기록');
  const mctsWave2Entries: AdoptionEntry[] = mctsWave2Report.results.map((result) => {
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
  const mctsWave2AdoptionRecord = ledger.add({
    waveId: mctsWave2Report.waveId,
    recordedAt: now(),
    comparabilityKey: mctsWave2Report.comparabilityKey,
    baselineVersion: mctsWave2Latest.version,
    opponentId: mctsWave2Config.opponent,
    entries: mctsWave2Entries,
    nextLoopNotes: [],
  });

  console.log('13.5) mcts-wave-2 near-miss 후보 추출');
  const mctsWave2NearMiss = extractNearMissCandidates(mctsWave2AdoptionRecord, mctsWave2Config.criteria);
  if (mctsWave2NearMiss.length === 0) {
    console.log('   근접실패 후보 없음.');
  } else {
    for (const candidate of mctsWave2NearMiss) {
      console.log(
        `   flags=[${candidate.flags.join('+')}] failedAtTier=${candidate.failedAtTier} winRateGap=${candidate.gap.winRateGap.toFixed(4)} scoreDiffGap=${candidate.gap.scoreDiffGap.toFixed(4)}`,
      );
    }
  }
  writeFileSync(
    join(rootDir, 'runs', GAME_ID, 'mcts-wave-2-near-miss.json'),
    JSON.stringify(mctsWave2NearMiss, null, 2),
  );
  console.log(`   저장: runs/${GAME_ID}/mcts-wave-2-near-miss.json`);

  console.log('13.6) mcts-wave-2 채택 플래그 registry 승격');
  const mctsWave2AdoptedFlags = mctsWave2Report.results
    .filter((r) => r.verdict === 'adopted')
    .flatMap((r) => r.flags);
  if (mctsWave2AdoptedFlags.length === 0) {
    console.log('   이번 mcts-wave-2에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('gomoku runner: registry has no latest baseline before mcts-wave-2 promotion step');
    }
    const lineage = registry.lineage(currentLatest.version);
    const alreadyPromoted = lineage.some((version) => version.sourceWaveId === mctsWave2Report.waveId);
    if (alreadyPromoted) {
      console.log('   이 mcts-wave-2는 이미 승격됨 — 스킵');
    } else {
      const nextVersion = registry.register({
        version: `v${lineage.length + 1}`,
        flags: [...currentLatest.flags, ...mctsWave2AdoptedFlags],
        parent: currentLatest.version,
        createdAt: now(),
        sourceWaveId: mctsWave2Report.waveId,
        notes: `mcts-wave-2에서 채택된 플래그 승격: ${mctsWave2AdoptedFlags.join(', ')}`,
        sourceDigest,
      });
      console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
    }
  }

  console.log('14) persist registry/ledger (mcts-wave-2 반영)');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('15) game-summary 재렌더 (mcts-wave-2 반영)');
  const finalSummaryMarkdown2 = renderGameSummaryMarkdown(rootDir, GAME_ID, {
    latestWaveCriteria: mctsWave2Config.criteria,
  });
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'summary.md'), finalSummaryMarkdown2);
  console.log(`   게임 요약: runs/${GAME_ID}/summary.md`);

  /**
   * 16) mcts-wave-3 (docs/FIX-BACKLOG.md P5) — re-attempting gomoku's search
   * family after search/mcts.ts's budget<branching-factor fix (reward-aware
   * final-selection tie-break + rng-shuffled expansion order). mcts-s64-hr
   * (mcts-wave-2) screened out as a behavioral no-op — identical to mcts-s64
   * across all 27 shared moves — because mcts-s64's simulation budget (64)
   * never exceeded gomoku's branching factor (~220 legal moves on an empty
   * 15x15 board), so every simulation just expanded one more untried move
   * and the tree never got deep enough for either the tie-break bug or the
   * FIFO expansion bias to matter... except that they *did* matter, by
   * making the final pick order-dependent when ties happened, which is
   * exactly what produced the no-op (see gomoku-mcts-flag.ts's
   * GOMOKU_MCTS2_S256_CONFIG comment for the branching-factor arithmetic).
   * Two candidates this wave, both simulations=256: `mcts2-s256` (random
   * rollout, matching mcts-s64's evaluator) and `mcts2-s256-hr` (heuristic
   * rollout, matching mcts-s64-hr's evaluator) — both included, not just the
   * hr variant, since the throughput measurement below shows both fit
   * comfortably inside the 30-minute wave budget.
   *
   * Throughput measurement (scratch script, not checked in; nice -n 10,
   * single process, 3 games/matchup, gomoku 15x15 board):
   *   - mcts2-s256      (random rollout)    vs heuristic: ~640ms/game  (578-707ms observed)
   *   - mcts2-s256-hr   (heuristic rollout) vs heuristic: ~664ms/game  (637-681ms observed)
   *   - mcts2-s256      vs mcts-s64 [regression matchup, both run MCTS search,
   *     the expensive case, mcts-s64 post-P5-fix]:                 ~1,306ms/game (975-1,829ms observed)
   *   - mcts2-s256-hr   vs mcts-s64 [regression matchup]:           ~1,914ms/game (1,312-2,371ms observed)
   *
   * Block-count arithmetic (tier sizes below, 1 block = 2 games; per-candidate
   * cost, this wave runs 2 candidates so total wave cost is the sum):
   *   mcts2-s256:    (smoke<=30 blocks=60 games + prune 15 blocks=30 games +
   *                   holdout 15 blocks=30 games) * ~640ms ≈ 77s, plus
   *                  regression 40 blocks=80 games * ~1,306ms(worst ~1,829ms) ≈ 104s(146s worst)
   *                  → ≈ 181s (≈3.0 min), ≈227s (≈3.8 min) worst-case
   *   mcts2-s256-hr: same heuristic-tier cost (~77s) + regression 80 games *
   *                  ~1,914ms(worst ~2,371ms) ≈ 153s(190s worst)
   *                  → ≈ 230s (≈3.8 min), ≈267s (≈4.4 min) worst-case
   *   Wave total ≈ 411s (≈6.9 min), ≈494s (≈8.2 min) worst-case — well under
   *   the 30-minute (1,800s) ceiling with comfortable headroom, so tier sizes
   *   match mcts-wave-2's (smoke<=30, prune=15, holdout=15, regression=40)
   *   rather than shrinking them.
   *
   * New seed banks (gomoku-mcts3-*, ranges 60000-63039) do not overlap any
   * range used by gomoku-runner-*, gomoku-mcts-*, or gomoku-mcts2-* above.
   */
  console.log('16) MCTS 후보 웨이브 3 (mcts-wave-3, P5 수정 후 s256 재도전)');
  // Reuse the shared specs (see allMctsFlagSpecs's doc comment above).
  const mctsWave3Adapter = withStrategyFlags(adapter, allMctsFlagSpecs);

  const mctsWave3Latest = registry.latest();
  if (mctsWave3Latest === undefined) {
    throw new Error('gomoku runner: registry has no latest baseline before mcts-wave-3');
  }

  const mctsWave3Ledger = new SeedLedger();
  const mctsWave3ReservedAt = now();
  const mctsWave3SmokeMax = 30;
  const mctsWave3PruneBlocks = 15;
  const mctsWave3HoldoutBlocks = 15;
  const mctsWave3RegressionBlocks = 40;
  mctsWave3Ledger.reserve({
    bankId: 'gomoku-mcts3-smoke',
    range: { start: 60000, end: 60000 + mctsWave3SmokeMax - 1 },
    purpose: 'smoke',
    reservedAt: mctsWave3ReservedAt,
  });
  mctsWave3Ledger.reserve({
    bankId: 'gomoku-mcts3-prune',
    range: { start: 61000, end: 61000 + mctsWave3PruneBlocks - 1 },
    purpose: 'prune',
    reservedAt: mctsWave3ReservedAt,
  });
  mctsWave3Ledger.reserve({
    bankId: 'gomoku-mcts3-holdout',
    range: { start: 62000, end: 62000 + mctsWave3HoldoutBlocks - 1 },
    purpose: 'holdout',
    reservedAt: mctsWave3ReservedAt,
  });
  mctsWave3Ledger.reserve({
    bankId: 'gomoku-mcts3-regression',
    range: { start: 63000, end: 63000 + mctsWave3RegressionBlocks - 1 },
    purpose: 'regression',
    reservedAt: mctsWave3ReservedAt,
  });

  const mctsWave3Config = assembleWaveConfig(mctsWave3Adapter, {
    waveId: 'mcts-wave-3',
    candidates: [{ flag: GOMOKU_MCTS2_S256_FLAG }, { flag: GOMOKU_MCTS2_S256_HR_FLAG }],
    opponent: 'heuristic',
    ledger: mctsWave3Ledger,
    recordedAt: now(),
    baselineFlags: mctsWave3Latest.flags,
    baselineVersion: mctsWave3Latest.version,
    tiers: {
      smoke: {
        bankId: 'gomoku-mcts3-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: mctsWave3SmokeMax,
        minBlocks: 5,
      },
      prune: { bankId: 'gomoku-mcts3-prune', blocks: mctsWave3PruneBlocks },
      holdout: { bankId: 'gomoku-mcts3-holdout', blocks: mctsWave3HoldoutBlocks },
      regression: { bankId: 'gomoku-mcts3-regression', blocks: mctsWave3RegressionBlocks },
    },
    screenProbe: { seeds: [1, 2, 3], botSeedBase: 100 },
  });

  const mctsWave3Report = runWave(mctsWave3Adapter, mctsWave3Config);
  for (const result of mctsWave3Report.results) {
    console.log(
      `   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`,
    );
    for (const tier of ['screen', 'smoke', 'prune', 'holdout', 'regression'] as const) {
      const stats = result.stats[tier];
      if (stats) {
        console.log(`     ${tier}: winRate=${stats.pointWinRate.toFixed(3)} blocks=${stats.blocks}`);
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
    runId: mctsWave3Report.waveId,
    kind: 'wave',
    recordedAt: now(),
    comparabilityKey: mctsWave3Report.comparabilityKey,
    payload: mctsWave3Report,
    markdown: `# Wave Report — ${mctsWave3Report.waveId}\n\n${mctsWave3Report.results
      .map((r) => `- ${r.flag}: ${r.verdict} (tiers: ${r.tiersPassed.join('→') || 'none'})`)
      .join('\n')}\n`,
  });

  console.log('17) mcts-wave-3 adoption ledger 기록');
  const mctsWave3Entries: AdoptionEntry[] = mctsWave3Report.results.map((result) => {
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
  const mctsWave3AdoptionRecord = ledger.add({
    waveId: mctsWave3Report.waveId,
    recordedAt: now(),
    comparabilityKey: mctsWave3Report.comparabilityKey,
    baselineVersion: mctsWave3Latest.version,
    opponentId: mctsWave3Config.opponent,
    entries: mctsWave3Entries,
    nextLoopNotes: [],
  });

  console.log('17.5) mcts-wave-3 near-miss 후보 추출');
  const mctsWave3NearMiss = extractNearMissCandidates(mctsWave3AdoptionRecord, mctsWave3Config.criteria);
  if (mctsWave3NearMiss.length === 0) {
    console.log('   근접실패 후보 없음.');
  } else {
    for (const candidate of mctsWave3NearMiss) {
      console.log(
        `   flags=[${candidate.flags.join('+')}] failedAtTier=${candidate.failedAtTier} winRateGap=${candidate.gap.winRateGap.toFixed(4)} scoreDiffGap=${candidate.gap.scoreDiffGap.toFixed(4)}`,
      );
    }
  }
  writeFileSync(
    join(rootDir, 'runs', GAME_ID, 'mcts-wave-3-near-miss.json'),
    JSON.stringify(mctsWave3NearMiss, null, 2),
  );
  console.log(`   저장: runs/${GAME_ID}/mcts-wave-3-near-miss.json`);

  console.log('17.6) mcts-wave-3 채택 플래그 registry 승격');
  const mctsWave3AdoptedFlags = mctsWave3Report.results
    .filter((r) => r.verdict === 'adopted')
    .flatMap((r) => r.flags);
  if (mctsWave3AdoptedFlags.length === 0) {
    console.log('   이번 mcts-wave-3에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('gomoku runner: registry has no latest baseline before mcts-wave-3 promotion step');
    }
    const lineage = registry.lineage(currentLatest.version);
    const alreadyPromoted = lineage.some((version) => version.sourceWaveId === mctsWave3Report.waveId);
    if (alreadyPromoted) {
      console.log('   이 mcts-wave-3는 이미 승격됨 — 스킵');
    } else {
      const nextVersion = registry.register({
        version: `v${lineage.length + 1}`,
        flags: [...currentLatest.flags, ...mctsWave3AdoptedFlags],
        parent: currentLatest.version,
        createdAt: now(),
        sourceWaveId: mctsWave3Report.waveId,
        notes: `mcts-wave-3에서 채택된 플래그 승격: ${mctsWave3AdoptedFlags.join(', ')}`,
        sourceDigest,
      });
      console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
    }
  }

  console.log('18) persist registry/ledger (mcts-wave-3 반영)');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('19) game-summary 재렌더 (mcts-wave-3 반영)');
  const finalSummaryMarkdown3 = renderGameSummaryMarkdown(rootDir, GAME_ID, {
    latestWaveCriteria: mctsWave3Config.criteria,
  });
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'summary.md'), finalSummaryMarkdown3);
  console.log(`   게임 요약: runs/${GAME_ID}/summary.md`);
}

main();
