/**
 * mini-trick MCCFR learning + wave runner (docs/GAP-ANALYSIS-7.md O7-c):
 * trains an outcome-sampling MCCFR average strategy (src/learn/mccfr.ts),
 * persists it as a sealed policy artifact, injects it as a candidate via
 * `withStrategyFlags` (O4), and runs it through the same
 * screen->smoke->prune->holdout gate every other candidate goes through — no
 * special-casing for a learned candidate (docs/GAP-ANALYSIS-7.md §3: "학습봇도
 * 게이트를 그대로 통과해야 adopted").
 *
 * mini-trick's demo entrypoint (`npm run demo`, src/reference/demo.ts)
 * already exercises the hand-authored winCheapest/noopSort/leadHighFirst
 * strategySurface end to end but never persists its BaselineRegistry to
 * disk. This runner is the first thing that does, for mini-trick — it
 * loads-or-creates `runs/mini-trick/registry.json`/`ledger.json` exactly
 * like `reference/runners/gomoku.ts` does (bootstrapping v1 + anchors only
 * if they are not already there), then adds the MCCFR wave on top.
 *
 * Every file under reference/runners/ is an app boundary (see
 * src/__tests__/dependency-rules.test.ts's APP_BOUNDARY_PREFIXES) — this is
 * the one place allowed to call `new Date().toISOString()` for this game's
 * MCCFR pipeline.
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
import { policyTableDigest, trainOutcomeSamplingMccfr, policyBotFactoryFor } from '../../learn/mccfr';
import type { StrategyFlagSpec } from '../../contract/types';
import { miniTrickAdapter } from '../mini-trick';
import { computeSourceDigest } from '../../artifacts/source-digest';

const GAME_ID = 'mini-trick';

/**
 * Source closure (approximate — see artifacts/source-digest.ts's doc
 * comment) for this game's flag-behavior-relevant code: the adapter itself,
 * learn/mccfr.ts (this game's flags are all trained MCCFR policy tables),
 * and loop/compose.ts (every registered version's flags are reassembled
 * through composeBot, so a change there can change every version's behavior
 * too). No search/*.ts entry — this runner never invokes MCTS/IS-MCTS.
 */
const SOURCE_FILES = [
  join(__dirname, '..', 'mini-trick.ts'),
  join(__dirname, '..', '..', 'learn', 'mccfr.ts'),
  join(__dirname, '..', '..', 'loop', 'compose.ts'),
];

/**
 * Training budget: measured with a throughput scratch script (not checked
 * in), 200,000 outcome-sampling MCCFR iterations over mini-trick took
 * ~10.5s wall clock on this machine and produced 1,254,298 distinct
 * information sets — comfortably inside the "few minutes" target
 * (docs/GAP-ANALYSIS-7.md O7-c) with room to spare. mini-trick's per-player
 * hand is part of the information-state key (see mini-trick.ts's
 * informationStateKey), so the infoset space is large and long-tailed —
 * most infosets are visited only a handful of times — but that is a fact
 * about this game's key granularity, not a training defect.
 */
const MCCFR_ITERATIONS = 200_000;
const MCCFR_TRAINING_SEED = 555_555;
const MCCFR_FLAG = `mccfr-os-${MCCFR_ITERATIONS}`;

/**
 * Perfect-recall training budget (docs/FIX-BACKLOG.md P3, docs/GAP-ANALYSIS-7.md
 * §3): `informationStateKey` now folds in the full public completed-trick
 * history (see mini-trick.ts), so the information-set space is far denser
 * per iteration than the pre-perfect-recall table above — a memory-safety
 * measurement was required before committing to a training budget (the prior
 * attempt at 1,000,000 iterations exhausted system memory).
 *
 * Measured with a throughput/memory scratch script (not checked in;
 * process.memoryUsage() after training, one iteration count per process so
 * V8 heap state from a prior run can't leak into the next measurement):
 *
 *   | iterations | infosetCount | heapUsed  | rss       | trainingMs |
 *   |-----------:|-------------:|----------:|----------:|-----------:|
 *   |     10,000 |      119,994 |  109.5 MB |  246.8 MB |        829 |
 *   |     30,000 |      359,879 |  322.9 MB |  463.7 MB |      2,472 |
 *   |    100,000 |    1,198,699 |  950.6 MB | 1,121.7 MB|      8,525 |
 *
 * infosetCount scales linearly at ~12.0 infosets/iteration across all three
 * points (11.999, 11.996, 11.987) — expected, since each mini-trick decision
 * now keys on the full completed-trick history. Fitting heapUsed linearly
 * against iterations using the two largest (most representative-at-scale)
 * points, (30_000, 322.9) and (100_000, 950.6): slope ≈ 8.97 KB/iteration,
 * intercept ≈ 53.9 MB. Solving heapUsed(iterations) = 1,500 MB (the 1.5GB
 * ceiling) gives iterations ≈ 161,300; 150,000 was chosen to keep a ~100MB
 * safety margin below that ceiling (extrapolated heapUsed(150_000) ≈ 1,398
 * MB) rather than training exactly at the edge of the estimate. A fresh
 * training seed (disjoint from MCCFR_TRAINING_SEED above) keeps the two
 * tables independently reproducible.
 */
const MCCFR_PR_ITERATIONS = 150_000;
const MCCFR_PR_TRAINING_SEED = 555_777;
const MCCFR_PR_FLAG = `mccfr-os-${MCCFR_PR_ITERATIONS}-pr`;

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
  const adapter = eraseAdapter(miniTrickAdapter);
  const runStore = new RunStore(rootDir);
  const specDigest = sha256Digest(canonicalJson(adapter.spec));

  console.log(`=== mini-trick MCCFR runner (rootDir=${rootDir}) ===`);

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
  const identitySeeds = Array.from({ length: 100 }, (_, i) => 850_000 + i);
  const noiseFloor = measureNoiseFloor(adapter, miniTrickAdapter.baselines.heuristic, identitySeeds, 750_000, {
    iterations: 2000,
    confidenceLevel: 0.95,
    seed: 42,
  });
  const recommendedBlocks = noiseFloor.blockStdDev > 0
    ? recommendBlockCount({ blockStdDev: noiseFloor.blockStdDev, targetEffect: 0.05 })
    : 5;
  const clampedBlocks = Math.min(Math.max(recommendedBlocks, 5), 100);
  console.log(
    `   캘리브레이션: blockStdDev=${noiseFloor.blockStdDev.toFixed(4)}, 권장 블록수=${recommendedBlocks}(클램프 후 ${clampedBlocks})`,
  );

  console.log('2) load-or-create registry/ledger from runs/mini-trick/');
  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const ledger = loadOrCreateLedger(rootDir, GAME_ID);
  const sourceDigest = computeSourceDigest(SOURCE_FILES);
  const priorLatest = registry.latest();
  // Warn-only, not a block (docs/GAP-ANALYSIS-8.md §2 v1 policy): a source
  // drift since the last registered version means that version's flags may
  // now reassemble differently than when it was adopted, but stopping the
  // runner here would make every code fix to learn/mccfr.ts also block this
  // game's runner — reproducibility status should stay visible, not gate
  // experimentation.
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
  const latest = registry.latest();
  if (latest === undefined) {
    throw new Error('mini-trick MCCFR runner: registry has no latest baseline after registration step');
  }

  console.log('4) outcome-sampling MCCFR 학습');
  const trainStart = Date.now();
  const policyTable = trainOutcomeSamplingMccfr(adapter, {
    iterations: MCCFR_ITERATIONS,
    seed: MCCFR_TRAINING_SEED,
  });
  const trainingMs = Date.now() - trainStart;
  console.log(
    `   iterations=${policyTable.meta.iterations} epsilon=${policyTable.meta.epsilon} ` +
      `infosetKeySource=${policyTable.meta.infosetKeySource} infosetCount=${policyTable.meta.infosetCount} ` +
      `trainingMs=${trainingMs}`,
  );

  const policyDigest = policyTableDigest(policyTable);
  // Flat file directly under runs/<gameId>/ — NOT a subdirectory — matching
  // the convention already used by near-miss.json/summary.md/registry.json/
  // ledger.json (see reference/runners/gomoku.ts). RunStore.listRuns treats
  // every *directory* under runs/<gameId>/ as a run and requires a
  // payload.json inside it; a "policies/" subdirectory here would collide
  // with that scan and break renderGameSummaryMarkdown for this game.
  const policyPath = join(rootDir, 'runs', GAME_ID, `policy-${MCCFR_FLAG}.json`);
  writeFileSync(policyPath, JSON.stringify({ digest: policyDigest, trainingMs, table: policyTable }, null, 2));
  console.log(`   저장: runs/${GAME_ID}/policy-${MCCFR_FLAG}.json (digest=${policyDigest})`);

  console.log('5) MCCFR 후보 웨이브 (mccfr-wave-1)');
  // withStrategyFlags extends the adapter's strategySurface without touching
  // miniTrickAdapter itself (loop layer helper, O4) — the flag's apply()
  // ignores whatever base bot composeBot would otherwise thread through it,
  // since a policy-table candidate builds its decision from the trained
  // table, not by modulating a base bot's choice (see src/learn/mccfr.ts's
  // doc comment on policyBotFactoryFor, and src/search/mcts.ts's
  // mctsBotFactory for the identical pattern already used for MCTS).
  const mccfrFlagSpec: StrategyFlagSpec<unknown, unknown> = {
    flag: MCCFR_FLAG,
    description: `Outcome-sampling MCCFR policy-table candidate (docs/GAP-ANALYSIS-7.md O7, ${MCCFR_ITERATIONS} iterations); ignores the base bot entirely.`,
    apply: () => policyBotFactoryFor(adapter, policyTable),
  };
  const mccfrAdapter = withStrategyFlags(adapter, [mccfrFlagSpec]);

  // Fresh seed range: demo.ts (the only other consumer of mini-trick seeds)
  // uses 500-3149ish and the 400000/700000/800000/900000 ranges — this wave
  // reserves the 20000s, disjoint from all of those.
  const mccfrLedger = new SeedLedger();
  const reservedAt = now();
  const smokeMaxBlocks = 80;
  mccfrLedger.reserve({
    bankId: 'mini-trick-mccfr-smoke',
    range: { start: 20_000, end: 20_000 + smokeMaxBlocks - 1 },
    purpose: 'smoke',
    reservedAt,
  });
  mccfrLedger.reserve({
    bankId: 'mini-trick-mccfr-prune',
    range: { start: 21_000, end: 21_000 + clampedBlocks - 1 },
    purpose: 'prune',
    reservedAt,
  });
  mccfrLedger.reserve({
    bankId: 'mini-trick-mccfr-holdout',
    range: { start: 22_000, end: 22_000 + clampedBlocks - 1 },
    purpose: 'holdout',
    reservedAt,
  });

  const mccfrWaveConfig = assembleWaveConfig(mccfrAdapter, {
    waveId: 'mccfr-wave-1',
    candidates: [{ flag: MCCFR_FLAG }],
    opponent: 'heuristic',
    ledger: mccfrLedger,
    recordedAt: now(),
    baselineFlags: latest.flags,
    baselineVersion: latest.version,
    tiers: {
      smoke: {
        bankId: 'mini-trick-mccfr-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: smokeMaxBlocks,
        minBlocks: 5,
      },
      prune: { bankId: 'mini-trick-mccfr-prune', blocks: clampedBlocks },
      holdout: { bankId: 'mini-trick-mccfr-holdout', blocks: clampedBlocks },
    },
    screenProbe: { seeds: [23_000, 23_001, 23_002, 23_003, 23_004], botSeedBase: 23_100 },
  });

  const report = runWave(mccfrAdapter, mccfrWaveConfig);
  for (const result of report.results) {
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
    runId: report.waveId,
    kind: 'wave',
    recordedAt: now(),
    comparabilityKey: report.comparabilityKey,
    payload: report,
    markdown: `# Wave Report — ${report.waveId}\n\n${report.results
      .map((r) => `- ${r.flag}: ${r.verdict} (tiers: ${r.tiersPassed.join('→') || 'none'})`)
      .join('\n')}\n`,
  });

  console.log('6) adoption ledger 기록');
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
    baselineVersion: latest.version,
    opponentId: mccfrWaveConfig.opponent,
    entries,
    nextLoopNotes: [
      `MCCFR 정책 테이블: iterations=${MCCFR_ITERATIONS}, infosetKeySource=${policyTable.meta.infosetKeySource}, infosetCount=${policyTable.meta.infosetCount}, digest=${policyDigest}.`,
    ],
  });

  console.log('6.5) near-miss 후보 추출');
  const nearMiss = extractNearMissCandidates(adoptionRecord, mccfrWaveConfig.criteria);
  if (nearMiss.length === 0) {
    console.log('   근접실패 후보 없음.');
  } else {
    for (const candidate of nearMiss) {
      console.log(
        `   flags=[${candidate.flags.join('+')}] failedAtTier=${candidate.failedAtTier} winRateGap=${candidate.gap.winRateGap.toFixed(4)} scoreDiffGap=${candidate.gap.scoreDiffGap.toFixed(4)}`,
      );
    }
  }
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'mccfr-near-miss.json'), JSON.stringify(nearMiss, null, 2));
  console.log(`   저장: runs/${GAME_ID}/mccfr-near-miss.json`);

  console.log('6.6) 웨이브 채택 플래그 registry 승격');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (adoptedFlags.length === 0) {
    console.log('   이번 MCCFR 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('mini-trick MCCFR runner: registry has no latest baseline before promotion step');
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
        notes: `MCCFR 웨이브 ${report.waveId}에서 채택된 플래그 승격: ${adoptedFlags.join(', ')}`,
        sourceDigest,
      });
      console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
    }
  }

  console.log('7) persist registry/ledger');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('8) game-summary 렌더');
  const summaryMarkdown = renderGameSummaryMarkdown(rootDir, GAME_ID, { latestWaveCriteria: mccfrWaveConfig.criteria });
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'summary.md'), summaryMarkdown);
  console.log(`   게임 요약: runs/${GAME_ID}/summary.md`);

  /**
   * 9) mccfr-wave-2 (docs/FIX-BACKLOG.md P3) — perfect-recall MCCFR candidate
   * `mccfr-os-<iters>-pr`, trained against the same mini-trick adapter but
   * now with `informationStateKey` closing the perfect-recall gap
   * (docs/GAP-ANALYSIS-7.md §3: completed-trick history is folded into both
   * state and observation, see mini-trick.ts). Adds a `tiers.regression`
   * gate (O10) after holdout, paired against the current baseline composite
   * bot (registry.latest()'s flags, currently v1/no flags — i.e. plain
   * heuristic) rather than special-casing this learned candidate: same
   * unconditional gate every other candidate faces (docs/GAP-ANALYSIS-7.md
   * §3, "학습봇도 게이트를 그대로 통과해야 adopted").
   */
  console.log('9) outcome-sampling MCCFR 학습 (perfect recall)');
  const prTrainStart = Date.now();
  const prPolicyTable = trainOutcomeSamplingMccfr(adapter, {
    iterations: MCCFR_PR_ITERATIONS,
    seed: MCCFR_PR_TRAINING_SEED,
  });
  const prTrainingMs = Date.now() - prTrainStart;
  console.log(
    `   iterations=${prPolicyTable.meta.iterations} epsilon=${prPolicyTable.meta.epsilon} ` +
      `infosetKeySource=${prPolicyTable.meta.infosetKeySource} infosetCount=${prPolicyTable.meta.infosetCount} ` +
      `trainingMs=${prTrainingMs}`,
  );

  const prPolicyDigest = policyTableDigest(prPolicyTable);
  const prPolicyPath = join(rootDir, 'runs', GAME_ID, `policy-${MCCFR_PR_FLAG}.json`);
  writeFileSync(
    prPolicyPath,
    JSON.stringify({ digest: prPolicyDigest, trainingMs: prTrainingMs, table: prPolicyTable }, null, 2),
  );
  console.log(`   저장: runs/${GAME_ID}/policy-${MCCFR_PR_FLAG}.json (digest=${prPolicyDigest})`);

  console.log('10) MCCFR 후보 웨이브 2 (mccfr-wave-2, perfect recall + regression 티어)');
  const prFlagSpec: StrategyFlagSpec<unknown, unknown> = {
    flag: MCCFR_PR_FLAG,
    description: `Perfect-recall outcome-sampling MCCFR policy-table candidate (docs/FIX-BACKLOG.md P3, ${MCCFR_PR_ITERATIONS} iterations); ignores the base bot entirely.`,
    apply: () => policyBotFactoryFor(adapter, prPolicyTable),
  };
  const mccfrWave2Adapter = withStrategyFlags(adapter, [prFlagSpec]);

  const mccfrWave2Latest = registry.latest();
  if (mccfrWave2Latest === undefined) {
    throw new Error('mini-trick MCCFR runner: registry has no latest baseline before mccfr-wave-2');
  }

  // Fresh seed range: disjoint from demo.ts's 500-3149ish/400000/700000/
  // 800000/900000 ranges and from mccfr-wave-1's 20000/21000/22000/23000
  // ranges above (screenProbe included) — this wave reserves the 30000s.
  const mccfrWave2Ledger = new SeedLedger();
  const mccfrWave2ReservedAt = now();
  const mccfrWave2SmokeMax = 80;
  const mccfrWave2PruneBlocks = clampedBlocks;
  const mccfrWave2HoldoutBlocks = clampedBlocks;
  const mccfrWave2RegressionBlocks = clampedBlocks;
  mccfrWave2Ledger.reserve({
    bankId: 'mini-trick-mccfr2-smoke',
    range: { start: 30_000, end: 30_000 + mccfrWave2SmokeMax - 1 },
    purpose: 'smoke',
    reservedAt: mccfrWave2ReservedAt,
  });
  mccfrWave2Ledger.reserve({
    bankId: 'mini-trick-mccfr2-prune',
    range: { start: 31_000, end: 31_000 + mccfrWave2PruneBlocks - 1 },
    purpose: 'prune',
    reservedAt: mccfrWave2ReservedAt,
  });
  mccfrWave2Ledger.reserve({
    bankId: 'mini-trick-mccfr2-holdout',
    range: { start: 32_000, end: 32_000 + mccfrWave2HoldoutBlocks - 1 },
    purpose: 'holdout',
    reservedAt: mccfrWave2ReservedAt,
  });
  mccfrWave2Ledger.reserve({
    bankId: 'mini-trick-mccfr2-regression',
    range: { start: 34_000, end: 34_000 + mccfrWave2RegressionBlocks - 1 },
    purpose: 'regression',
    reservedAt: mccfrWave2ReservedAt,
  });

  const mccfrWave2Config = assembleWaveConfig(mccfrWave2Adapter, {
    waveId: 'mccfr-wave-2',
    candidates: [{ flag: MCCFR_PR_FLAG }],
    opponent: 'heuristic',
    ledger: mccfrWave2Ledger,
    recordedAt: now(),
    baselineFlags: mccfrWave2Latest.flags,
    baselineVersion: mccfrWave2Latest.version,
    tiers: {
      smoke: {
        bankId: 'mini-trick-mccfr2-smoke',
        sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
        maxBlocks: mccfrWave2SmokeMax,
        minBlocks: 5,
      },
      prune: { bankId: 'mini-trick-mccfr2-prune', blocks: mccfrWave2PruneBlocks },
      holdout: { bankId: 'mini-trick-mccfr2-holdout', blocks: mccfrWave2HoldoutBlocks },
      regression: { bankId: 'mini-trick-mccfr2-regression', blocks: mccfrWave2RegressionBlocks },
    },
    screenProbe: { seeds: [33_000, 33_001, 33_002, 33_003, 33_004], botSeedBase: 33_100 },
  });

  const mccfrWave2Report = runWave(mccfrWave2Adapter, mccfrWave2Config);
  for (const result of mccfrWave2Report.results) {
    console.log(`   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`);
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
    runId: mccfrWave2Report.waveId,
    kind: 'wave',
    recordedAt: now(),
    comparabilityKey: mccfrWave2Report.comparabilityKey,
    payload: mccfrWave2Report,
    markdown: `# Wave Report — ${mccfrWave2Report.waveId}\n\n${mccfrWave2Report.results
      .map((r) => `- ${r.flag}: ${r.verdict} (tiers: ${r.tiersPassed.join('→') || 'none'})`)
      .join('\n')}\n`,
  });

  console.log('11) mccfr-wave-2 adoption ledger 기록');
  const mccfrWave2Entries: AdoptionEntry[] = mccfrWave2Report.results.map((result) => {
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
  const mccfrWave2AdoptionRecord = ledger.add({
    waveId: mccfrWave2Report.waveId,
    recordedAt: now(),
    comparabilityKey: mccfrWave2Report.comparabilityKey,
    baselineVersion: mccfrWave2Latest.version,
    opponentId: mccfrWave2Config.opponent,
    entries: mccfrWave2Entries,
    nextLoopNotes: [
      `perfect-recall MCCFR 정책 테이블: iterations=${MCCFR_PR_ITERATIONS}, infosetKeySource=${prPolicyTable.meta.infosetKeySource}, infosetCount=${prPolicyTable.meta.infosetCount}, digest=${prPolicyDigest}.`,
    ],
  });

  console.log('11.5) mccfr-wave-2 near-miss 후보 추출');
  const mccfrWave2NearMiss = extractNearMissCandidates(mccfrWave2AdoptionRecord, mccfrWave2Config.criteria);
  if (mccfrWave2NearMiss.length === 0) {
    console.log('   근접실패 후보 없음.');
  } else {
    for (const candidate of mccfrWave2NearMiss) {
      console.log(
        `   flags=[${candidate.flags.join('+')}] failedAtTier=${candidate.failedAtTier} winRateGap=${candidate.gap.winRateGap.toFixed(4)} scoreDiffGap=${candidate.gap.scoreDiffGap.toFixed(4)}`,
      );
    }
  }
  writeFileSync(
    join(rootDir, 'runs', GAME_ID, 'mccfr-wave-2-near-miss.json'),
    JSON.stringify(mccfrWave2NearMiss, null, 2),
  );
  console.log(`   저장: runs/${GAME_ID}/mccfr-wave-2-near-miss.json`);

  console.log('11.6) mccfr-wave-2 채택 플래그 registry 승격');
  const mccfrWave2AdoptedFlags = mccfrWave2Report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (mccfrWave2AdoptedFlags.length === 0) {
    console.log('   이번 mccfr-wave-2에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('mini-trick MCCFR runner: registry has no latest baseline before mccfr-wave-2 promotion step');
    }
    const lineage = registry.lineage(currentLatest.version);
    const alreadyPromoted = lineage.some((version) => version.sourceWaveId === mccfrWave2Report.waveId);
    if (alreadyPromoted) {
      console.log('   이 mccfr-wave-2는 이미 승격됨 — 스킵');
    } else {
      const nextVersion = registry.register({
        version: `v${lineage.length + 1}`,
        flags: [...currentLatest.flags, ...mccfrWave2AdoptedFlags],
        parent: currentLatest.version,
        createdAt: now(),
        sourceWaveId: mccfrWave2Report.waveId,
        notes: `mccfr-wave-2에서 채택된 플래그 승격: ${mccfrWave2AdoptedFlags.join(', ')}`,
        sourceDigest,
      });
      console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
    }
  }

  console.log('12) persist registry/ledger (mccfr-wave-2 반영)');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('13) game-summary 재렌더 (mccfr-wave-2 반영)');
  const finalSummaryMarkdown = renderGameSummaryMarkdown(rootDir, GAME_ID, {
    latestWaveCriteria: mccfrWave2Config.criteria,
  });
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'summary.md'), finalSummaryMarkdown);
  console.log(`   게임 요약: runs/${GAME_ID}/summary.md`);
}

main();
