/**
 * janggi — per-game execution entrypoint (H5/H7): scores conformance, loads
 * (or bootstraps) this game's BaselineRegistry/AdoptionLedger from
 * `runs/janggi/`, registers the pristine v1 baseline + benchmark anchors on
 * first run only, runs one small smoke-only wave over janggi's strategy
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
import { janggiAdapter } from '../janggi';
import { JANGGI_MCTS2_S128_HR_CONFIG, JANGGI_MCTS2_S128_HR_FLAG, janggiMctsFlagSpecFor } from './shared/janggi-mcts-flag';
import { computeSourceDigest } from '../../artifacts/source-digest';

const GAME_ID = 'janggi';

/**
 * Source closure (approximate — see artifacts/source-digest.ts's doc
 * comment) for this game's flag-behavior-relevant code: the adapter itself,
 * search/mcts.ts (this game's flags are all MCTS configs), this game's
 * shared MCTS flag spec, and loop/compose.ts (every registered version's
 * flags are reassembled through composeBot, so a change there can change
 * every version's behavior too).
 */
const SOURCE_FILES = [
  join(__dirname, '..', 'janggi.ts'),
  join(__dirname, '..', '..', 'search', 'mcts.ts'),
  join(__dirname, 'shared', 'janggi-mcts-flag.ts'),
  join(__dirname, '..', '..', 'loop', 'compose.ts'),
];

/**
 * Simulation budget (docs/GAP-ANALYSIS-7.md O6). Measured with a throughput
 * script (scratch, not checked in): janggi's move generation is much more
 * expensive per node than gomoku's (full-board attack scans for every
 * candidate move, both in tree traversal and in each random rollout step),
 * averaging ~18s/game at only 16 simulations. This budget plus the small
 * tier sizes below keeps the whole mcts-wave-1 well under the
 * 15-minutes-per-game runner ceiling; rolloutCount is trimmed to 1 (from
 * mcts.ts's typical default) specifically because rollout steps re-run the
 * same expensive legal-move generation to the ply cap.
 */
const JANGGI_MCTS_CONFIG: MctsConfig = { simulations: 16, uctC: 1.4, rolloutCount: 1, label: 's16' };
const MCTS_FLAG = 'mcts-s16';

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
  const adapter = eraseAdapter(janggiAdapter);
  const runStore = new RunStore(rootDir);
  const specDigest = sha256Digest(canonicalJson(adapter.spec));

  console.log(`=== janggi runner (rootDir=${rootDir}) ===`);

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

  console.log('2) calibration — noise floor & recommended block count');
  const identitySeeds = Array.from({ length: 100 }, (_, i) => 900_000 + i);
  const calibrationBotSeedBase = 800_000;
  const noiseFloor = measureNoiseFloor(
    adapter,
    janggiAdapter.baselines.heuristic,
    identitySeeds,
    calibrationBotSeedBase,
    { iterations: 2000, confidenceLevel: 0.95, seed: 123 },
  );
  const targetEffect = 0.05;
  const recommendedBlocks = recommendBlockCount({
    blockStdDev: noiseFloor.blockStdDev,
    targetEffect,
  });
  const clampedBlocks = Math.min(Math.max(recommendedBlocks, 5), 30);
  const clampNote = clampedBlocks === recommendedBlocks ? '' : ' (클램프됨)';
  console.log(
    `   캘리브레이션: blockStdDev=${noiseFloor.blockStdDev.toFixed(4)}, 권장 블록수=${recommendedBlocks}, 클램프 후 블록수=${clampedBlocks}${clampNote}`,
  );

  console.log('3) load-or-create registry/ledger from runs/janggi/');
  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const ledger = loadOrCreateLedger(rootDir, GAME_ID);
  const sourceDigest = computeSourceDigest(SOURCE_FILES);
  const priorLatest = registry.latest();
  // Warn-only, not a block (docs/GAP-ANALYSIS-8.md §2 v1 policy): a source
  // drift since the last registered version means that version's flags may
  // now reassemble differently than when it was adopted (the P5 mcts-s64
  // reassembly-change incident this feature was built to surface), but
  // stopping the runner here would make every code fix to search/mcts.ts
  // also block every game's runner — reproducibility status should stay
  // visible, not gate experimentation.
  if (priorLatest?.sourceDigest !== undefined && priorLatest.sourceDigest !== sourceDigest) {
    console.log(
      `   ⚠ source drift detected: registry latest (${priorLatest.version}) was registered with sourceDigest=${priorLatest.sourceDigest}, current source=${sourceDigest} — this version's flags may now reassemble differently than when it was adopted (see artifacts/source-digest.ts).`,
    );
  } else if (priorLatest !== undefined && priorLatest.sourceDigest === undefined) {
    console.log(`   registry latest (${priorLatest.version}) predates sourceDigest tracking — no drift check possible`);
  }

  console.log('4) baseline v1 + anchors (register only if missing)');
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
    throw new Error('janggi runner: v1 baseline missing after registration step');
  }

  console.log('5) small smoke-only wave over strategySurface flags');
  const flags = janggiAdapter.strategySurface.map((spec) => spec.flag);
  console.log(`   candidates: ${flags.join(', ')}`);

  const waveLedger = new SeedLedger();
  const reservedAt = now();
  const smokeMaxBlocks = clampedBlocks * 3;
  waveLedger.reserve({
    bankId: 'janggi-runner-smoke',
    range: { start: 1, end: smokeMaxBlocks },
    purpose: 'smoke',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'janggi-runner-prune',
    range: { start: 1000, end: 1000 + clampedBlocks - 1 },
    purpose: 'prune',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'janggi-runner-holdout',
    range: { start: 2000, end: 2000 + clampedBlocks - 1 },
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
        bankId: 'janggi-runner-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: smokeMaxBlocks,
        minBlocks: 5,
      },
      prune: { bankId: 'janggi-runner-prune', blocks: clampedBlocks },
      holdout: { bankId: 'janggi-runner-holdout', blocks: clampedBlocks },
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

  console.log('6b) promote adopted flags to a new registry version');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (adoptedFlags.length === 0) {
    console.log('   이번 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('janggi runner: registry has no latest version to promote from');
    }
    const lineage = registry.lineage(currentLatest.version);
    const alreadyPromoted = lineage.some((v) => v.sourceWaveId === report.waveId);
    if (alreadyPromoted) {
      console.log('   이 웨이브는 이미 승격됨 — 스킵');
    } else {
      const newVersion = registry.register({
        version: `v${lineage.length + 1}`,
        flags: [...currentLatest.flags, ...adoptedFlags],
        parent: currentLatest.version,
        createdAt: now(),
        sourceWaveId: report.waveId,
        notes: `웨이브 ${report.waveId}에서 채택된 플래그 승격: ${adoptedFlags.join(', ')}`,
        sourceDigest,
      });
      console.log(`   승격: ${newVersion.version}, flags=[${newVersion.flags.join(', ')}]`);
    }
  }

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
  writeFileSync(join(rootDir, 'runs', 'janggi', 'near-miss.json'), JSON.stringify(nearMiss, null, 2));

  console.log('8) persist registry/ledger');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('9) game summary');
  const summaryMarkdown = renderGameSummaryMarkdown(rootDir, GAME_ID, {
    latestWaveCriteria: waveConfig.criteria,
  });
  writeFileSync(join(rootDir, 'runs', 'janggi', 'summary.md'), summaryMarkdown);
  console.log('   게임 요약: runs/janggi/summary.md');

  console.log('10) MCTS 후보 웨이브 (mcts-wave-1)');
  // withStrategyFlags extends the adapter's strategySurface without touching
  // janggiAdapter itself (loop layer helper, O4) — the mcts flag's apply()
  // ignores whatever base bot composeBot would otherwise thread through it,
  // since an MCTS candidate builds its decision from search, not by
  // modulating a base bot's choice (see src/search/mcts.ts's doc comment on
  // mctsBotFactory).
  const mctsFlagSpec: StrategyFlagSpec<unknown, unknown> = {
    flag: MCTS_FLAG,
    description: 'UCT MCTS search candidate (docs/GAP-ANALYSIS-7.md O5/O6); ignores the base bot entirely.',
    apply: () => mctsBotFactory(adapter, JANGGI_MCTS_CONFIG),
  };
  const mctsAdapter = withStrategyFlags(adapter, [mctsFlagSpec]);

  const mctsLatest = registry.latest();
  if (mctsLatest === undefined) {
    throw new Error('janggi runner: registry has no latest baseline before the MCTS wave');
  }

  const mctsLedger = new SeedLedger();
  const mctsReservedAt = now();
  // Small tier sizes (docs/GAP-ANALYSIS-7.md O6): at ~18s/game and 2
  // games/block, even the full smoke+prune+holdout budget below stays under
  // (8+6+6)*2*20s ≈ 13min, inside the 15-minutes-per-game ceiling — and SPRT
  // typically stops smoke well before maxBlocks.
  const mctsSmokeMax = 8;
  const mctsPruneBlocks = 6;
  const mctsHoldoutBlocks = 6;
  mctsLedger.reserve({
    bankId: 'janggi-mcts-smoke',
    range: { start: 8000, end: 8000 + mctsSmokeMax - 1 },
    purpose: 'smoke',
    reservedAt: mctsReservedAt,
  });
  mctsLedger.reserve({
    bankId: 'janggi-mcts-prune',
    range: { start: 9000, end: 9000 + mctsPruneBlocks - 1 },
    purpose: 'prune',
    reservedAt: mctsReservedAt,
  });
  mctsLedger.reserve({
    bankId: 'janggi-mcts-holdout',
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
        bankId: 'janggi-mcts-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: mctsSmokeMax,
        minBlocks: 4,
      },
      prune: { bankId: 'janggi-mcts-prune', blocks: mctsPruneBlocks },
      holdout: { bankId: 'janggi-mcts-holdout', blocks: mctsHoldoutBlocks },
    },
    screenProbe: { seeds: [1, 2], botSeedBase: 100 },
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

  console.log('11) MCTS 웨이브 adoption ledger 기록');
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

  console.log('12) MCTS near-miss 후보 추출');
  const mctsNearMiss = extractNearMissCandidates(mctsAdoptionRecord, mctsWaveConfig.criteria);
  if (mctsNearMiss.length === 0) {
    console.log('   근접실패 후보 없음');
  } else {
    for (const candidate of mctsNearMiss) {
      console.log(
        `   flags=${JSON.stringify(candidate.flags)} failedAtTier=${candidate.failedAtTier} winRateGap=${candidate.gap.winRateGap.toFixed(4)} scoreDiffGap=${candidate.gap.scoreDiffGap.toFixed(4)}`,
      );
    }
  }
  writeFileSync(join(rootDir, 'runs', 'janggi', 'mcts-near-miss.json'), JSON.stringify(mctsNearMiss, null, 2));

  console.log('13) MCTS 웨이브 채택 플래그 registry 승격');
  const mctsAdoptedFlags = mctsReport.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (mctsAdoptedFlags.length === 0) {
    console.log('   이번 MCTS 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('janggi runner: registry has no latest version to promote from (MCTS wave)');
    }
    const lineage = registry.lineage(currentLatest.version);
    const alreadyPromoted = lineage.some((v) => v.sourceWaveId === mctsReport.waveId);
    if (alreadyPromoted) {
      console.log('   이 MCTS 웨이브는 이미 승격됨 — 스킵');
    } else {
      const newVersion = registry.register({
        version: `v${lineage.length + 1}`,
        flags: [...currentLatest.flags, ...mctsAdoptedFlags],
        parent: currentLatest.version,
        createdAt: now(),
        sourceWaveId: mctsReport.waveId,
        notes: `MCTS 웨이브 ${mctsReport.waveId}에서 채택된 플래그 승격: ${mctsAdoptedFlags.join(', ')}`,
        sourceDigest,
      });
      console.log(`   승격: ${newVersion.version}, flags=[${newVersion.flags.join(', ')}]`);
    }
  }

  console.log('14) persist registry/ledger (MCTS 웨이브 반영)');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('15) game-summary 재렌더 (MCTS 웨이브 반영)');
  const finalSummaryMarkdown = renderGameSummaryMarkdown(rootDir, GAME_ID, {
    latestWaveCriteria: mctsWaveConfig.criteria,
  });
  writeFileSync(join(rootDir, 'runs', 'janggi', 'summary.md'), finalSummaryMarkdown);
  console.log('   게임 요약: runs/janggi/summary.md');

  /**
   * 16) mcts-wave-2 (docs/FIX-BACKLOG.md P2/P5) — re-attempting janggi's
   * search family now that both blockers behind mcts-wave-1's smoke 0.000
   * failure are addressed: P2 optimized move generation/check detection
   * (~950x speedup, ~18.7ms/game random self-play measured post-fix, vs
   * ~17.8s/game pre-fix), and P5 fixed search/mcts.ts's
   * budget<branching-factor tie-break/expansion pathology. New candidate
   * `mcts2-s128-hr` (heuristic rollout, simulations=128 — see
   * shared/janggi-mcts-flag.ts's JANGGI_MCTS2_S128_HR_CONFIG comment for the
   * full throughput+branching-factor measurement and rationale for choosing
   * 128 over 64).
   *
   * `tiers.regression` is included for gate consistency with every other
   * search-candidate wave in this codebase (O10), even though — since
   * registry v1 carries zero strategy flags — the regression tier's
   * baseline-composite bot resolves to the exact same raw
   * `baselines.heuristic` opponent every other tier already faces. That
   * duplication is expected for a v1 baseline (there is no adopted
   * override yet to regress against) and will stop being a duplicate the
   * moment any janggi candidate is promoted past v1.
   *
   * Tier-size budget arithmetic (1 block = 2 games; all four tiers face the
   * same ~14.6s/game average cost class, 12.4-18.3s observed range, since
   * regression's opponent is also raw heuristic per the note above):
   *   smoke (maxBlocks=8, SPRT may stop earlier) + prune (6) + holdout (6)
   *   + regression (6) = 26 blocks max = 52 games
   *   52 games * ~14.6s avg ≈ 759s (≈12.7 min), 52 * ~18.3s worst ≈ 952s
   *   (≈15.9 min) — comfortably under the 30-minute wave ceiling even at the
   *   observed worst-case per-game cost.
   *
   * New seed banks (janggi-mcts2-*, ranges 30000-33005) do not overlap any
   * range used by janggi-runner-*, janggi-mcts-* (mcts-wave-1, ranges
   * 1-90/1000-1029/2000-2029/8000-10005), or janggi-benchmark.ts's fixed
   * seeds (50000-51999) / botSeedBase values (700001-700003, 800000,
   * 900000-900099).
   */
  console.log('16) MCTS 후보 웨이브 2 (mcts-wave-2, P2 최적화 + P5 수정 후 s128-hr 재도전)');
  const mctsWave2FlagSpec = janggiMctsFlagSpecFor(adapter, JANGGI_MCTS2_S128_HR_CONFIG, JANGGI_MCTS2_S128_HR_FLAG);
  const mctsWave2Adapter = withStrategyFlags(adapter, [mctsWave2FlagSpec]);

  const mctsWave2Latest = registry.latest();
  if (mctsWave2Latest === undefined) {
    throw new Error('janggi runner: registry has no latest baseline before mcts-wave-2');
  }

  const mctsWave2Ledger = new SeedLedger();
  const mctsWave2ReservedAt = now();
  const mctsWave2SmokeMax = 8;
  const mctsWave2PruneBlocks = 6;
  const mctsWave2HoldoutBlocks = 6;
  const mctsWave2RegressionBlocks = 6;
  mctsWave2Ledger.reserve({
    bankId: 'janggi-mcts2-smoke',
    range: { start: 30000, end: 30000 + mctsWave2SmokeMax - 1 },
    purpose: 'smoke',
    reservedAt: mctsWave2ReservedAt,
  });
  mctsWave2Ledger.reserve({
    bankId: 'janggi-mcts2-prune',
    range: { start: 31000, end: 31000 + mctsWave2PruneBlocks - 1 },
    purpose: 'prune',
    reservedAt: mctsWave2ReservedAt,
  });
  mctsWave2Ledger.reserve({
    bankId: 'janggi-mcts2-holdout',
    range: { start: 32000, end: 32000 + mctsWave2HoldoutBlocks - 1 },
    purpose: 'holdout',
    reservedAt: mctsWave2ReservedAt,
  });
  mctsWave2Ledger.reserve({
    bankId: 'janggi-mcts2-regression',
    range: { start: 33000, end: 33000 + mctsWave2RegressionBlocks - 1 },
    purpose: 'regression',
    reservedAt: mctsWave2ReservedAt,
  });

  const mctsWave2Config = assembleWaveConfig(mctsWave2Adapter, {
    waveId: 'mcts-wave-2',
    candidates: [{ flag: JANGGI_MCTS2_S128_HR_FLAG }],
    opponent: 'heuristic',
    ledger: mctsWave2Ledger,
    recordedAt: now(),
    baselineFlags: mctsWave2Latest.flags,
    baselineVersion: mctsWave2Latest.version,
    tiers: {
      smoke: {
        bankId: 'janggi-mcts2-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: mctsWave2SmokeMax,
        minBlocks: 4,
      },
      prune: { bankId: 'janggi-mcts2-prune', blocks: mctsWave2PruneBlocks },
      holdout: { bankId: 'janggi-mcts2-holdout', blocks: mctsWave2HoldoutBlocks },
      regression: { bankId: 'janggi-mcts2-regression', blocks: mctsWave2RegressionBlocks },
    },
    screenProbe: { seeds: [1, 2], botSeedBase: 100 },
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

  console.log('17) mcts-wave-2 adoption ledger 기록');
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

  console.log('17.5) mcts-wave-2 near-miss 후보 추출');
  const mctsWave2NearMiss = extractNearMissCandidates(mctsWave2AdoptionRecord, mctsWave2Config.criteria);
  if (mctsWave2NearMiss.length === 0) {
    console.log('   근접실패 후보 없음');
  } else {
    for (const candidate of mctsWave2NearMiss) {
      console.log(
        `   flags=${JSON.stringify(candidate.flags)} failedAtTier=${candidate.failedAtTier} winRateGap=${candidate.gap.winRateGap.toFixed(4)} scoreDiffGap=${candidate.gap.scoreDiffGap.toFixed(4)}`,
      );
    }
  }
  writeFileSync(
    join(rootDir, 'runs', 'janggi', 'mcts-wave-2-near-miss.json'),
    JSON.stringify(mctsWave2NearMiss, null, 2),
  );

  console.log('17.6) mcts-wave-2 채택 플래그 registry 승격');
  const mctsWave2AdoptedFlags = mctsWave2Report.results
    .filter((r) => r.verdict === 'adopted')
    .flatMap((r) => r.flags);
  if (mctsWave2AdoptedFlags.length === 0) {
    console.log('   이번 mcts-wave-2에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('janggi runner: registry has no latest version to promote from (mcts-wave-2)');
    }
    const lineage = registry.lineage(currentLatest.version);
    const alreadyPromoted = lineage.some((v) => v.sourceWaveId === mctsWave2Report.waveId);
    if (alreadyPromoted) {
      console.log('   이 mcts-wave-2는 이미 승격됨 — 스킵');
    } else {
      const newVersion = registry.register({
        version: `v${lineage.length + 1}`,
        flags: [...currentLatest.flags, ...mctsWave2AdoptedFlags],
        parent: currentLatest.version,
        createdAt: now(),
        sourceWaveId: mctsWave2Report.waveId,
        notes: `mcts-wave-2에서 채택된 플래그 승격: ${mctsWave2AdoptedFlags.join(', ')}`,
        sourceDigest,
      });
      console.log(`   승격: ${newVersion.version}, flags=[${newVersion.flags.join(', ')}]`);
    }
  }

  console.log('18) persist registry/ledger (mcts-wave-2 반영)');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('19) game-summary 재렌더 (mcts-wave-2 반영)');
  const finalSummaryMarkdown2 = renderGameSummaryMarkdown(rootDir, GAME_ID, {
    latestWaveCriteria: mctsWave2Config.criteria,
  });
  writeFileSync(join(rootDir, 'runs', 'janggi', 'summary.md'), finalSummaryMarkdown2);
  console.log('   게임 요약: runs/janggi/summary.md');
}

main();
