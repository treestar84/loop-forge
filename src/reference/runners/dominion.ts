/**
 * dominion — per-game execution entrypoint (H5/H7): scores conformance, loads
 * (or bootstraps) this game's BaselineRegistry/AdoptionLedger from
 * `runs/dominion/`, registers the pristine v1 baseline + benchmark anchors on
 * first run only, runs one small smoke-only wave over dominion's strategy
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
import { computeSourceDigest } from '../../artifacts/source-digest';
import { dominionAdapter } from '../dominion';
import { DOMINION_ISMCTS_S64_HR_FLAG, dominionIsmctsFlagSpec } from './shared/dominion-ismcts-flag';

const GAME_ID = 'dominion';

/**
 * Source closure (approximate — see artifacts/source-digest.ts's doc
 * comment) for this game's flag-behavior-relevant code: the adapter itself,
 * both search algorithms this runner's flags can invoke, this game's shared
 * IS-MCTS flag spec, and loop/compose.ts (every registered version's flags
 * are reassembled through composeBot, so a change there can change every
 * version's behavior too).
 */
const SOURCE_FILES = [
  join(__dirname, '..', 'dominion.ts'),
  join(__dirname, '..', '..', 'search', 'mcts.ts'),
  join(__dirname, '..', '..', 'search', 'ismcts.ts'),
  join(__dirname, 'shared', 'dominion-ismcts-flag.ts'),
  join(__dirname, '..', '..', 'loop', 'compose.ts'),
];

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
  const adapter = eraseAdapter(dominionAdapter);
  const runStore = new RunStore(rootDir);
  const specDigest = sha256Digest(canonicalJson(adapter.spec));

  console.log(`=== dominion runner (rootDir=${rootDir}) ===`);

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
    dominionAdapter.baselines.heuristic,
    identitySeeds,
    calibrationBotSeedBase,
    { iterations: 2000, confidenceLevel: 0.95, seed: 123 },
  );
  // identity self-play이 완전히 결정론적이거나 signal collapse를 일으키면
  // blockStdDev가 0이 되어 recommendBlockCount가 예외를 던진다 — 이 경우
  // 표본 크기 근거를 낼 수 없으므로 클램프 하한(5)으로 대체한다.
  let recommendedBlocks: number;
  try {
    recommendedBlocks =
      noiseFloor.blockStdDev > 0
        ? recommendBlockCount({ blockStdDev: noiseFloor.blockStdDev, targetEffect: 0.05 })
        : 5;
  } catch {
    recommendedBlocks = 5;
  }
  const clampedBlocks = Math.min(Math.max(recommendedBlocks, 5), 30);
  console.log(
    `   캘리브레이션: blockStdDev=${noiseFloor.blockStdDev.toFixed(4)}, 권장 블록수=${recommendedBlocks}, 클램프 후=${clampedBlocks}`,
  );

  console.log('3) load-or-create registry/ledger from runs/dominion/');
  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const ledger = loadOrCreateLedger(rootDir, GAME_ID);
  const sourceDigest = computeSourceDigest(SOURCE_FILES);
  const priorLatest = registry.latest();
  // Warn-only, not a block (docs/GAP-ANALYSIS-8.md §2 v1 policy): a source
  // drift since the last registered version means that version's flags may
  // now reassemble differently than when it was adopted (the P5 mcts-s64
  // reassembly-change incident this feature was built to surface), but
  // stopping the runner here would make every code fix to search/mcts.ts or
  // search/ismcts.ts also block every game's runner — reproducibility status
  // should stay visible, not gate experimentation.
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
    throw new Error('dominion runner: v1 baseline missing after registration step');
  }

  console.log('5) small smoke-only wave over strategySurface flags');
  const flags = dominionAdapter.strategySurface.map((spec) => spec.flag);
  console.log(`   candidates: ${flags.join(', ')}`);

  const waveLedger = new SeedLedger();
  const reservedAt = now();
  const smokeMaxBlocks = clampedBlocks * 3;
  waveLedger.reserve({
    bankId: 'dominion-runner-smoke',
    range: { start: 1, end: smokeMaxBlocks },
    purpose: 'smoke',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'dominion-runner-prune',
    range: { start: 1000, end: 1000 + clampedBlocks - 1 },
    purpose: 'prune',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'dominion-runner-holdout',
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
        bankId: 'dominion-runner-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: smokeMaxBlocks,
        minBlocks: 5,
      },
      prune: { bankId: 'dominion-runner-prune', blocks: clampedBlocks },
      holdout: { bankId: 'dominion-runner-holdout', blocks: clampedBlocks },
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

  console.log('7) baseline promotion');
  const adoptedFlags = report.results
    .filter((result) => result.verdict === 'adopted')
    .flatMap((result) => result.flags);
  if (adoptedFlags.length === 0) {
    console.log('   이번 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('dominion runner: registry has no latest baseline version to promote from');
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
        sourceDigest,
      });
      console.log(`   승격: ${promoted.version}, flags=${JSON.stringify(promoted.flags)}`);
    }
  }

  console.log('8) near-miss candidate extraction');
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
  writeFileSync(join(rootDir, 'runs', 'dominion', 'near-miss.json'), JSON.stringify(nearMiss, null, 2));

  console.log('9) persist registry/ledger');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('10) game summary');
  const summaryMarkdown = renderGameSummaryMarkdown(rootDir, GAME_ID, {
    latestWaveCriteria: waveConfig.criteria,
  });
  writeFileSync(join(rootDir, 'runs', 'dominion', 'summary.md'), summaryMarkdown);
  console.log('   게임 요약: runs/dominion/summary.md');

  /**
   * 11) ismcts-wave-1 (docs/FIX-BACKLOG.md P4). Dominion is real hidden-
   * information (unlike splendor's public-board-only hidden deck order) —
   * `getObservation` never exposes the opponent's hand, and only exposes the
   * viewer's own deck as a composition (`own.deckComposition`), never an
   * order. `sampleStateFromObservation` (src/reference/dominion.ts)
   * resamples the viewer's own deck order plus the opponent's hand+deck pool
   * (composition AND order) per simulation; `ismctsBotFactory`
   * (src/search/ismcts.ts) runs SO-ISMCTS on top of it — same mechanism as
   * splendor's ismcts-wave-1 (reference/runners/splendor.ts), extended here
   * to a game where the determinization hook actually has to hide something
   * from the opponent, not just from nobody. Single candidate `ismcts-s64-hr`
   * (shared/dominion-ismcts-flag.ts — see its doc comment for the throughput
   * measurement that picked simulations=64 over 128), opponent 'heuristic'
   * like every other wave, plus a regression tier against the CURRENT
   * baseline composite bot (registry.latest() — v2's `rushProvinces`,
   * docs/GAP-ANALYSIS-7.md O10 lesson: a raw-heuristic-only gate can't detect
   * a candidate that is actually weaker than the already-adopted baseline).
   *
   * Dominion is a 2-player game with `utility` left undeclared (defaults to
   * 'general', contract/types.ts) — same "no CFR/UCT convergence guarantee,
   * not a reason to withhold the candidate" reasoning as splendor's
   * ismcts-wave-1 comment; smoke/prune/holdout/regression is the gate that
   * decides, with no search-bot special case.
   *
   * Block-count arithmetic (throughput from shared/dominion-ismcts-flag.ts's
   * doc comment; 1 block = 2 games; ~2,545ms/game observed, rounded up for
   * safety margin against the small 3-seed sample):
   *   smoke  <=30 blocks = 60 games  * ~2,545ms ≈ 153s
   *   prune    15 blocks = 30 games  * ~2,545ms ≈  76s
   *   holdout  15 blocks = 30 games  * ~2,545ms ≈  76s
   *   regression 20 blocks = 40 games * ~2,545ms ≈ 102s
   *   total ≈ 407s (≈6.8 min) — well under the 30-minute wave ceiling.
   *
   * New seed banks (dominion-ismcts-*, ranges 30000-33019) do not overlap
   * any range used above (dominion-runner-{smoke,prune,holdout}: 1-90,
   * 1000-1029, 2000-2029) or by dominion-benchmark.ts (SEED_BASE=50,000+).
   */
  console.log('11) IS-MCTS 후보 웨이브 (ismcts-wave-1)');
  const ismctsFlagSpec = dominionIsmctsFlagSpec(adapter);
  const ismctsAdapter = withStrategyFlags(adapter, [ismctsFlagSpec]);

  const ismctsLatest = registry.latest();
  if (ismctsLatest === undefined) {
    throw new Error('dominion runner: registry has no latest baseline before ismcts-wave-1');
  }

  const ismctsLedger = new SeedLedger();
  const ismctsReservedAt = now();
  const ismctsSmokeMax = 30;
  const ismctsPruneBlocks = 15;
  const ismctsHoldoutBlocks = 15;
  const ismctsRegressionBlocks = 20;
  ismctsLedger.reserve({
    bankId: 'dominion-ismcts-smoke',
    range: { start: 30000, end: 30000 + ismctsSmokeMax - 1 },
    purpose: 'smoke',
    reservedAt: ismctsReservedAt,
  });
  ismctsLedger.reserve({
    bankId: 'dominion-ismcts-prune',
    range: { start: 31000, end: 31000 + ismctsPruneBlocks - 1 },
    purpose: 'prune',
    reservedAt: ismctsReservedAt,
  });
  ismctsLedger.reserve({
    bankId: 'dominion-ismcts-holdout',
    range: { start: 32000, end: 32000 + ismctsHoldoutBlocks - 1 },
    purpose: 'holdout',
    reservedAt: ismctsReservedAt,
  });
  ismctsLedger.reserve({
    bankId: 'dominion-ismcts-regression',
    range: { start: 33000, end: 33000 + ismctsRegressionBlocks - 1 },
    purpose: 'regression',
    reservedAt: ismctsReservedAt,
  });

  const ismctsWaveConfig = assembleWaveConfig(ismctsAdapter, {
    waveId: 'ismcts-wave-1',
    candidates: [{ flag: DOMINION_ISMCTS_S64_HR_FLAG }],
    opponent: 'heuristic',
    ledger: ismctsLedger,
    recordedAt: now(),
    baselineFlags: ismctsLatest.flags,
    baselineVersion: ismctsLatest.version,
    tiers: {
      smoke: {
        bankId: 'dominion-ismcts-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: ismctsSmokeMax,
        minBlocks: 5,
      },
      prune: { bankId: 'dominion-ismcts-prune', blocks: ismctsPruneBlocks },
      holdout: { bankId: 'dominion-ismcts-holdout', blocks: ismctsHoldoutBlocks },
      regression: { bankId: 'dominion-ismcts-regression', blocks: ismctsRegressionBlocks },
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
    runId: ismctsReport.waveId,
    kind: 'wave',
    recordedAt: now(),
    comparabilityKey: ismctsReport.comparabilityKey,
    payload: ismctsReport,
    markdown: `# Wave Report — ${ismctsReport.waveId}\n\n${ismctsReport.results
      .map((r) => `- ${r.flag}: ${r.verdict} (tiers: ${r.tiersPassed.join('→') || 'none'})`)
      .join('\n')}\n`,
  });

  console.log('12) ismcts-wave-1 adoption ledger 기록');
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

  console.log('12.5) ismcts-wave-1 near-miss 후보 추출');
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

  console.log('12.6) ismcts-wave-1 채택 플래그 registry 승격');
  const ismctsAdoptedFlags = ismctsReport.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (ismctsAdoptedFlags.length === 0) {
    console.log('   이번 ismcts-wave-1에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('dominion runner: registry has no latest baseline before ismcts-wave-1 promotion step');
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
        sourceDigest,
      });
      console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
    }
  }

  console.log('13) persist registry/ledger (ismcts-wave-1 반영)');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('14) game-summary 재렌더 (ismcts-wave-1 반영)');
  const finalSummaryMarkdown = renderGameSummaryMarkdown(rootDir, GAME_ID, {
    latestWaveCriteria: ismctsWaveConfig.criteria,
  });
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'summary.md'), finalSummaryMarkdown, 'utf8');
  console.log(`   게임 요약: runs/${GAME_ID}/summary.md`);

  /**
   * 15) ismcts-wave-2 (docs/FIX-BACKLOG.md P6, docs/GAP-ANALYSIS-8.md §2).
   * ismcts-wave-1 above was screened purely on the fixed cross-game
   * DEFAULT_CRITERIA.minScoreDiff=5: prune winRate=0.933 (CI 0.83-1.00)
   * cleared minWinRate comfortably, but pointScoreDiff=3.40 fell short of a
   * threshold with no relationship to dominion's own score scale. P6 derives
   * a game-calibrated threshold instead — 2 x the identity-self-play
   * scoreDiffStdDev already measured in step 2's `noiseFloor` — and passes it
   * through `assembleWaveConfig`'s `calibration` argument so
   * `deriveBlueprint`'s `recommendedMinScoreDiff` becomes this wave's
   * `criteria.minScoreDiff`. Same candidate/logic as ismcts-wave-1
   * (`ismctsAdapter` / `DOMINION_ISMCTS_S64_HR_FLAG`, unchanged) — only the
   * gate criteria differ. New seed banks (dominion-ismcts2-*, ranges
   * 40000-43019) do not overlap ismcts-wave-1's 30000-33019 range or any
   * dominion-runner-* range.
   */
  console.log('15) IS-MCTS 후보 웨이브 2 (ismcts-wave-2, P6: 점수차 임계 캘리브레이션 파생)');
  const derivedMinScoreDiff = noiseFloor.scoreDiffStdDev > 0 ? 2 * noiseFloor.scoreDiffStdDev : 0;
  console.log(
    `   캘리브레이션: scoreDiffStdDev=${noiseFloor.scoreDiffStdDev.toFixed(4)}, ` +
      `파생 임계=${derivedMinScoreDiff.toFixed(4)} (기존 고정 임계=5)`,
  );

  const ismcts2Latest = registry.latest();
  if (ismcts2Latest === undefined) {
    throw new Error('dominion runner: registry has no latest baseline before ismcts-wave-2');
  }

  const ismcts2Ledger = new SeedLedger();
  const ismcts2ReservedAt = now();
  const ismcts2SmokeMax = 30;
  const ismcts2PruneBlocks = 15;
  const ismcts2HoldoutBlocks = 15;
  const ismcts2RegressionBlocks = 20;
  ismcts2Ledger.reserve({
    bankId: 'dominion-ismcts2-smoke',
    range: { start: 40000, end: 40000 + ismcts2SmokeMax - 1 },
    purpose: 'smoke',
    reservedAt: ismcts2ReservedAt,
  });
  ismcts2Ledger.reserve({
    bankId: 'dominion-ismcts2-prune',
    range: { start: 41000, end: 41000 + ismcts2PruneBlocks - 1 },
    purpose: 'prune',
    reservedAt: ismcts2ReservedAt,
  });
  ismcts2Ledger.reserve({
    bankId: 'dominion-ismcts2-holdout',
    range: { start: 42000, end: 42000 + ismcts2HoldoutBlocks - 1 },
    purpose: 'holdout',
    reservedAt: ismcts2ReservedAt,
  });
  ismcts2Ledger.reserve({
    bankId: 'dominion-ismcts2-regression',
    range: { start: 43000, end: 43000 + ismcts2RegressionBlocks - 1 },
    purpose: 'regression',
    reservedAt: ismcts2ReservedAt,
  });

  const ismcts2WaveConfig = assembleWaveConfig(
    ismctsAdapter,
    {
      waveId: 'ismcts-wave-2',
      candidates: [{ flag: DOMINION_ISMCTS_S64_HR_FLAG }],
      opponent: 'heuristic',
      ledger: ismcts2Ledger,
      recordedAt: now(),
      baselineFlags: ismcts2Latest.flags,
      baselineVersion: ismcts2Latest.version,
      tiers: {
        smoke: {
          bankId: 'dominion-ismcts2-smoke',
          sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
          maxBlocks: ismcts2SmokeMax,
          minBlocks: 5,
        },
        prune: { bankId: 'dominion-ismcts2-prune', blocks: ismcts2PruneBlocks },
        holdout: { bankId: 'dominion-ismcts2-holdout', blocks: ismcts2HoldoutBlocks },
        regression: { bankId: 'dominion-ismcts2-regression', blocks: ismcts2RegressionBlocks },
      },
      screenProbe: { seeds: [1, 2, 3], botSeedBase: 100 },
    },
    { blockStdDev: noiseFloor.blockStdDev, scoreDiffStdDev: noiseFloor.scoreDiffStdDev },
  );
  console.log(
    `   criteria.minScoreDiff=${ismcts2WaveConfig.criteria.minScoreDiff.toFixed(4)} (블루프린트 파생, 기존 고정값 5와 비교)`,
  );

  const ismcts2Report = runWave(ismctsAdapter, ismcts2WaveConfig);
  for (const result of ismcts2Report.results) {
    console.log(
      `   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`,
    );
    for (const tier of ['screen', 'smoke', 'prune', 'holdout', 'regression'] as const) {
      const stats = result.stats[tier];
      if (stats) {
        console.log(
          `     ${tier}: winRate=${stats.pointWinRate.toFixed(3)} scoreDiff=${stats.pointScoreDiff.toFixed(3)} blocks=${stats.blocks}`,
        );
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
    runId: ismcts2Report.waveId,
    kind: 'wave',
    recordedAt: now(),
    comparabilityKey: ismcts2Report.comparabilityKey,
    payload: ismcts2Report,
    markdown: `# Wave Report — ${ismcts2Report.waveId}\n\n${ismcts2Report.results
      .map((r) => `- ${r.flag}: ${r.verdict} (tiers: ${r.tiersPassed.join('→') || 'none'})`)
      .join('\n')}\n`,
  });

  console.log('16) ismcts-wave-2 adoption ledger 기록');
  const ismcts2Entries: AdoptionEntry[] = ismcts2Report.results.map((result) => {
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
  const ismcts2AdoptionRecord = ledger.add({
    waveId: ismcts2Report.waveId,
    recordedAt: now(),
    comparabilityKey: ismcts2Report.comparabilityKey,
    baselineVersion: ismcts2Latest.version,
    opponentId: ismcts2WaveConfig.opponent,
    entries: ismcts2Entries,
    nextLoopNotes: [],
  });

  console.log('16.5) ismcts-wave-2 near-miss 후보 추출');
  const ismcts2NearMiss = extractNearMissCandidates(ismcts2AdoptionRecord, ismcts2WaveConfig.criteria);
  if (ismcts2NearMiss.length === 0) {
    console.log('   근접실패 후보 없음.');
  } else {
    for (const candidate of ismcts2NearMiss) {
      console.log(
        `   flags=[${candidate.flags.join('+')}] failedAtTier=${candidate.failedAtTier} winRateGap=${candidate.gap.winRateGap.toFixed(4)} scoreDiffGap=${candidate.gap.scoreDiffGap.toFixed(4)}`,
      );
    }
  }
  writeFileSync(
    join(rootDir, 'runs', GAME_ID, 'ismcts-wave-2-near-miss.json'),
    JSON.stringify(ismcts2NearMiss, null, 2),
  );
  console.log(`   저장: runs/${GAME_ID}/ismcts-wave-2-near-miss.json`);

  console.log('16.6) ismcts-wave-2 채택 플래그 registry 승격');
  const ismcts2AdoptedFlags = ismcts2Report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (ismcts2AdoptedFlags.length === 0) {
    console.log('   이번 ismcts-wave-2에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('dominion runner: registry has no latest baseline before ismcts-wave-2 promotion step');
    }
    const lineage = registry.lineage(currentLatest.version);
    const alreadyPromoted = lineage.some((version) => version.sourceWaveId === ismcts2Report.waveId);
    if (alreadyPromoted) {
      console.log('   이 ismcts-wave-2는 이미 승격됨 — 스킵');
    } else {
      const nextVersion = registry.register({
        version: `v${lineage.length + 1}`,
        flags: [...currentLatest.flags, ...ismcts2AdoptedFlags],
        parent: currentLatest.version,
        createdAt: now(),
        sourceWaveId: ismcts2Report.waveId,
        notes: `ismcts-wave-2에서 채택된 플래그 승격 (P6 파생 임계): ${ismcts2AdoptedFlags.join(', ')}`,
        sourceDigest,
      });
      console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
    }
  }

  console.log('17) persist registry/ledger (ismcts-wave-2 반영)');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('18) game-summary 재렌더 (ismcts-wave-2 반영)');
  const wave2SummaryMarkdown = renderGameSummaryMarkdown(rootDir, GAME_ID, {
    latestWaveCriteria: ismcts2WaveConfig.criteria,
  });
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'summary.md'), wave2SummaryMarkdown, 'utf8');
  console.log(`   게임 요약: runs/${GAME_ID}/summary.md`);
}

main();
