/**
 * hearthstone — per-game execution entrypoint (H5/H7): scores conformance, loads
 * (or bootstraps) this game's BaselineRegistry/AdoptionLedger from
 * `runs/hearthstone/`, registers the pristine v1 baseline + benchmark anchors on
 * first run only, runs one small smoke-only wave over hearthstone's strategy
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
import { hearthstoneAdapter } from '../hearthstone';
import { HEARTHSTONE_ISMCTS_S128_HR_FLAG, hearthstoneIsmctsFlagSpec } from './shared/hearthstone-ismcts-flag';

const GAME_ID = 'hearthstone';

/**
 * Source closure (approximate — see artifacts/source-digest.ts's doc
 * comment) for this game's flag-behavior-relevant code: the adapter itself,
 * both search algorithms this runner's flags can invoke, this game's shared
 * IS-MCTS flag spec, and loop/compose.ts (every registered version's flags
 * are reassembled through composeBot, so a change there can change every
 * version's behavior too).
 */
const SOURCE_FILES = [
  join(__dirname, '..', 'hearthstone.ts'),
  join(__dirname, '..', '..', 'search', 'mcts.ts'),
  join(__dirname, '..', '..', 'search', 'ismcts.ts'),
  join(__dirname, 'shared', 'hearthstone-ismcts-flag.ts'),
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
  const adapter = eraseAdapter(hearthstoneAdapter);
  const runStore = new RunStore(rootDir);
  const specDigest = sha256Digest(canonicalJson(adapter.spec));

  console.log(`=== hearthstone runner (rootDir=${rootDir}) ===`);

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
  const identitySeeds = Array.from({ length: 100 }, (_, i) => 910_000 + i);
  const calibrationBotSeedBase = 810_000;
  const noiseFloor = measureNoiseFloor(
    adapter,
    hearthstoneAdapter.baselines.heuristic,
    identitySeeds,
    calibrationBotSeedBase,
    { iterations: 2000, confidenceLevel: 0.95, seed: 321 },
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

  console.log('3) load-or-create registry/ledger from runs/hearthstone/');
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
    throw new Error('hearthstone runner: v1 baseline missing after registration step');
  }

  console.log('5) small smoke-only wave over strategySurface flags');
  const flags = hearthstoneAdapter.strategySurface.map((spec) => spec.flag);
  console.log(`   candidates: ${flags.join(', ')}`);

  const waveLedger = new SeedLedger();
  const reservedAt = now();
  const smokeMaxBlocks = clampedBlocks * 3;
  waveLedger.reserve({
    bankId: 'hearthstone-runner-smoke',
    range: { start: 1, end: smokeMaxBlocks },
    purpose: 'smoke',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'hearthstone-runner-prune',
    range: { start: 1000, end: 1000 + clampedBlocks - 1 },
    purpose: 'prune',
    reservedAt,
  });
  waveLedger.reserve({
    bankId: 'hearthstone-runner-holdout',
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
        bankId: 'hearthstone-runner-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: smokeMaxBlocks,
        minBlocks: 5,
      },
      prune: { bankId: 'hearthstone-runner-prune', blocks: clampedBlocks },
      holdout: { bankId: 'hearthstone-runner-holdout', blocks: clampedBlocks },
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
  writeFileSync(join(rootDir, 'runs', 'hearthstone', 'near-miss.json'), JSON.stringify(nearMiss, null, 2));

  console.log('8) baseline promotion');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (adoptedFlags.length === 0) {
    console.log('   이번 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('hearthstone runner: registry has no latest baseline to promote from');
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
      console.log(`   승격: ${newVersion.version}, flags=${JSON.stringify(newVersion.flags)}`);
    }
  }

  console.log('9) persist registry/ledger');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('10) game summary');
  const summaryMarkdown = renderGameSummaryMarkdown(rootDir, GAME_ID, {
    latestWaveCriteria: waveConfig.criteria,
  });
  writeFileSync(join(rootDir, 'runs', 'hearthstone', 'summary.md'), summaryMarkdown);
  console.log('   게임 요약: runs/hearthstone/summary.md');

  /**
   * 11) ismcts-wave-1 (docs/FIX-BACKLOG.md P4). Hearthstone is real hidden-
   * information (opponent's hand and both decks' composition+order are never
   * exposed by `getObservation`) but, unlike dominion's anonymous multiset
   * cards, every card here carries a deterministic, globally unique
   * instanceId (`buildDeck`'s `p{playerIndex}-{defId}-{copy}` scheme fixed by
   * the mirror deck's card pool, independent of the game seed) — so
   * `sampleStateFromObservation` (src/reference/hearthstone.ts) reconstructs
   * each side's full 24-card instance universe directly via `buildDeck`
   * rather than needing an explicit composition field the way dominion's
   * `own.deckComposition` did. It resamples the viewer's own deck order plus
   * the opponent's hand+deck pool (composition AND order) per simulation;
   * `ismctsBotFactory` (src/search/ismcts.ts) runs SO-ISMCTS on top of it —
   * same mechanism as dominion's and splendor's ismcts-wave-1. Single
   * candidate `ismcts-s128-hr` (shared/hearthstone-ismcts-flag.ts — see its
   * doc comment for the throughput measurement that picked
   * simulations=128 over 64/32, since this game's mirror-match card pool
   * turned out much cheaper per game than dominion's), opponent 'heuristic'
   * like every other wave, plus a regression tier against the CURRENT
   * baseline composite bot (registry.latest() — docs/GAP-ANALYSIS-7.md O10
   * lesson: a raw-heuristic-only gate can't detect a candidate that is
   * actually weaker than the already-adopted baseline; hearthstone's registry
   * has adopted 0 candidates so far, so as of this wave the baseline
   * composite bot is still plain heuristic — same opponent as every other
   * tier, at the same per-game cost).
   *
   * Hearthstone is a 2-player game with `scoreMargin` left undeclared
   * (defaults to 'scored', src/kernel/classify.ts — `getOutcome` reports
   * remaining hero health, 0-30, as `scores`, which genuinely is a
   * meaningful margin, just never explicitly opted into via the spec field;
   * `blueprint.ts` flags this as a warning, not a blocker) and `utility` left
   * undeclared (defaults to 'general', contract/types.ts) — same "no
   * CFR/UCT convergence guarantee, not a reason to withhold the candidate"
   * reasoning as dominion's/splendor's ismcts-wave-1 comments; smoke/prune/
   * holdout/regression against `DEFAULT_CRITERIA`'s minScoreDiff=5 gate is
   * what decides, with no search-bot special case.
   *
   * Block-count arithmetic (throughput from shared/hearthstone-ismcts-flag.ts's
   * doc comment; 1 block = 2 games; ~287.8ms/game observed at s128-hr,
   * rounded up for safety margin against the small 3-seed sample):
   *   smoke      <=30 blocks = 60 games * ~288ms ≈  17s
   *   prune        15 blocks = 30 games * ~288ms ≈   9s
   *   holdout      15 blocks = 30 games * ~288ms ≈   9s
   *   regression   20 blocks = 40 games * ~288ms ≈  12s
   *   total ≈ 47s — well under the 30-minute wave ceiling (dominion's s64-hr
   *   wave alone took ~407s for a comparable block count).
   *
   * New seed banks (hearthstone-ismcts-*, ranges 30000-33019) do not overlap
   * any range used above (hearthstone-runner-{smoke,prune,holdout}: 1-90,
   * 1000-1029, 2000-2029) or by hearthstone-benchmark.ts (SEED_BASE=50,000+).
   */
  console.log('11) IS-MCTS 후보 웨이브 (ismcts-wave-1)');
  const ismctsFlagSpec = hearthstoneIsmctsFlagSpec(adapter);
  const ismctsAdapter = withStrategyFlags(adapter, [ismctsFlagSpec]);

  const ismctsLatest = registry.latest();
  if (ismctsLatest === undefined) {
    throw new Error('hearthstone runner: registry has no latest baseline before ismcts-wave-1');
  }

  const ismctsLedger = new SeedLedger();
  const ismctsReservedAt = now();
  const ismctsSmokeMax = 30;
  const ismctsPruneBlocks = 15;
  const ismctsHoldoutBlocks = 15;
  const ismctsRegressionBlocks = 20;
  ismctsLedger.reserve({
    bankId: 'hearthstone-ismcts-smoke',
    range: { start: 30000, end: 30000 + ismctsSmokeMax - 1 },
    purpose: 'smoke',
    reservedAt: ismctsReservedAt,
  });
  ismctsLedger.reserve({
    bankId: 'hearthstone-ismcts-prune',
    range: { start: 31000, end: 31000 + ismctsPruneBlocks - 1 },
    purpose: 'prune',
    reservedAt: ismctsReservedAt,
  });
  ismctsLedger.reserve({
    bankId: 'hearthstone-ismcts-holdout',
    range: { start: 32000, end: 32000 + ismctsHoldoutBlocks - 1 },
    purpose: 'holdout',
    reservedAt: ismctsReservedAt,
  });
  ismctsLedger.reserve({
    bankId: 'hearthstone-ismcts-regression',
    range: { start: 33000, end: 33000 + ismctsRegressionBlocks - 1 },
    purpose: 'regression',
    reservedAt: ismctsReservedAt,
  });

  const ismctsWaveConfig = assembleWaveConfig(ismctsAdapter, {
    waveId: 'ismcts-wave-1',
    candidates: [{ flag: HEARTHSTONE_ISMCTS_S128_HR_FLAG }],
    opponent: 'heuristic',
    ledger: ismctsLedger,
    recordedAt: now(),
    baselineFlags: ismctsLatest.flags,
    baselineVersion: ismctsLatest.version,
    tiers: {
      smoke: {
        bankId: 'hearthstone-ismcts-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: ismctsSmokeMax,
        minBlocks: 5,
      },
      prune: { bankId: 'hearthstone-ismcts-prune', blocks: ismctsPruneBlocks },
      holdout: { bankId: 'hearthstone-ismcts-holdout', blocks: ismctsHoldoutBlocks },
      regression: { bankId: 'hearthstone-ismcts-regression', blocks: ismctsRegressionBlocks },
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
      throw new Error('hearthstone runner: registry has no latest baseline before ismcts-wave-1 promotion step');
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
}

main();
