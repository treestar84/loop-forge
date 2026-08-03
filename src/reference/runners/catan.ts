/**
 * catan — per-game execution entrypoint. Two purposes:
 *
 *  1. Standard onboarding validation (G-Score conformance, calibration,
 *     registry/ledger bootstrap, a small smoke-only wave over the strategy
 *     surface) — mirrors reference/runners/avalon.ts's structure. As of
 *     docs/GAP-ANALYSIS-13.md §3 S1, this half (from calibration through
 *     wave A's summary/promotion) is delegated to the game-neutral
 *     `artifacts/onboarding-pipeline.ts`'s `runOnboardingPipeline` — this
 *     file now only supplies G-Score conformance (an onboarding/-layer call
 *     the pipeline cannot make itself, see that file's doc comment) and this
 *     game's specific constants.
 *  2. M4 real-game validation (docs/GAP-ANALYSIS-10.md §4, M4 already
 *     implemented in loop/wave-runner.ts / commit 37fb7dc): catan is a
 *     4-player FFA game, exactly the shape M4's `WaveConfig.fieldMix` was
 *     built for ("나머지 3명 중 2명은 heuristic, 1명은 random" king-making
 *     composition). Step 4.5 below runs a SECOND wave with
 *     `fieldMix: ['heuristic', 'heuristic', 'random']` and logs per-slot bot
 *     factory identity plus a side-by-side comparison against wave A (the
 *     pipeline's single-opponent wave), to demonstrate fieldMix actually
 *     wiring distinct baselines into distinct non-candidate seats in a real
 *     multiplayer game (not just the unit-test coverage wave-runner.test.ts
 *     already has). This wave is outside `runOnboardingPipeline`'s scope
 *     (single-wave only) and stays hand-rolled here; it reloads the
 *     registry/ledger the pipeline already persisted, adds its own adoption
 *     record, and re-saves + re-renders the summary so the final on-disk
 *     state reflects both waves — exactly the order the pre-extraction
 *     version of this file used (ledger.add for both waves, THEN save, THEN
 *     render summary).
 *
 * Every file under reference/runners/ is an app boundary (see
 * src/__tests__/dependency-rules.test.ts's APP_BOUNDARY_PREFIXES) — this is
 * the one place allowed to call `new Date().toISOString()` for this game.
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { assembleWaveConfig } from '../../loop/assemble-wave-config';
import { runWave, type WaveConfig, type WaveReport } from '../../loop/wave-runner';
import { SeedLedger } from '../../kernel/seed-ledger';
import { scoreAdapter } from '../../onboarding/score';
import { renderReportMarkdown } from '../../onboarding/report';
import { evaluateWaveReadiness } from '../../onboarding/wave-readiness';
import { computeComparabilityKey, RunStore } from '../../artifacts/run-store';
import { canonicalJson, sha256Digest } from '../../kernel/digest';
import { saveLedger, saveRegistry } from '../../artifacts/game-state';
import { type AdoptionEntry } from '../../artifacts/adoption-ledger';
import { renderGameSummaryMarkdown } from '../../artifacts/game-summary';
import { runOnboardingPipeline } from '../../artifacts/onboarding-pipeline';
import { eraseAdapter } from '../../loop/erase';
import { computeSourceDigest } from '../../artifacts/source-digest';
import { catanAdapter } from '../catan';

const GAME_ID = 'catan';
const WAVE_A_ID = 'runner-wave-single-opponent';

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

function logWaveResults(report: WaveReport): void {
  for (const result of report.results) {
    console.log(`   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`);
    for (const tier of ['screen', 'smoke', 'prune', 'holdout'] as const) {
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
}

function main(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const adapter = eraseAdapter(catanAdapter);
  const runStore = new RunStore(rootDir);
  const specDigest = sha256Digest(canonicalJson(adapter.spec));

  console.log(`=== catan runner (rootDir=${rootDir}) ===`);

  console.log('1) G-Score conformance');
  // c3SampleStates raised from the default (10) to 25: the C3 sampler walks
  // `i` legal[0]-steps from a fresh game for sample i, but catan's initial
  // placement phase alone is 16 decisions (4 players x 2 rounds x
  // settlement+road) with every hand empty until round 2's placements grant
  // starting resources partway through — the default never reaches a state
  // with anything hidden to mutate. This is a per-call override (not a
  // score.ts edit), matching ONBOARDING-GUIDE.md §5.5's guidance to suspect
  // the scorer's sampling assumptions before the adapter for a new game
  // shape, then fix it without touching the shared scorer.
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

  console.log('2-7) 온보딩 파이프라인 — wave A (single-opponent field, opponent: heuristic, baseline pre-M4 shape)');
  const sourceDigest = computeSourceDigest(SOURCE_FILES);
  const identitySeeds = Array.from({ length: 60 }, (_, i) => 700_000 + i);
  const pipeline = runOnboardingPipeline(adapter, {
    gameId: GAME_ID,
    rootDir,
    adapter,
    sourceDigest,
    noiseFloor: {
      baselineFactory: catanAdapter.baselines.heuristic,
      identitySeeds,
      botSeedBase: 600_000,
      bootstrap: { iterations: 2000, confidenceLevel: 0.95, seed: 42 },
      targetEffect: 0.05,
      zeroStdDevFallbackBlocks: 5,
      clamp: { min: 5, max: 20 },
    },
    baseline: {
      v1Notes: '순정 heuristic 기준선 (플래그 없음).',
      anchors: [
        { anchorId: 'anchor-random', kind: 'random' },
        { anchorId: 'anchor-heuristic', kind: 'heuristic' },
      ],
    },
    wave: {
      waveId: WAVE_A_ID,
      bankIds: { smoke: 'catan-runner-smoke-a', prune: 'catan-runner-prune-a', holdout: 'catan-runner-holdout-a' },
      opponent: 'heuristic',
      smokeSprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 },
      smokeMinBlocks: 5,
      screenProbeSeeds: [1, 2, 3],
      screenProbeBotSeedBase: 100,
    },
    promotionNotePrefix: `웨이브 ${WAVE_A_ID}에서 채택된 플래그 승격: `,
    recordedAt: now(),
  });

  if (pipeline.sourceDrift?.drifted) {
    console.log(
      `   ⚠ source drift detected: registry latest (${pipeline.sourceDrift.priorVersion}) was registered with sourceDigest=${pipeline.sourceDrift.priorSourceDigest}, current source=${pipeline.sourceDrift.currentSourceDigest}.`,
    );
  } else if (pipeline.sourceDrift !== undefined && pipeline.sourceDrift.priorSourceDigest === undefined) {
    console.log(`   registry latest (${pipeline.sourceDrift.priorVersion}) predates sourceDigest tracking — no drift check possible`);
  }
  console.log(
    `   identity self-play (heuristic vs heuristic, ${identitySeeds.length} seeds): meanWinRate(seat0)=${pipeline.noiseFloor.pointWinRate.toFixed(4)}, ` +
      `CI=[${pipeline.noiseFloor.winRate.lower.toFixed(4)}, ${pipeline.noiseFloor.winRate.upper.toFixed(4)}] — playerCount=4 so naive expectation is ${(1 / adapter.spec.playerCount).toFixed(4)}.`,
  );
  console.log(
    `   캘리브레이션: blockStdDev=${pipeline.noiseFloor.blockStdDev.toFixed(4)}, 권장 블록수=${pipeline.recommendedBlocks}(클램프 후 ${pipeline.clampedBlocks})`,
  );
  const flags = catanAdapter.strategySurface.map((spec) => spec.flag);
  console.log(`   candidates: ${flags.join(', ')}`);
  console.log(`   criteria: minWinRate=${pipeline.criteria.minWinRate} minScoreDiff=${pipeline.criteria.minScoreDiff}`);
  logWaveResults(pipeline.report);
  if (pipeline.nearMiss.length === 0) {
    console.log('   근접실패 후보 없음.');
  } else {
    for (const candidate of pipeline.nearMiss) {
      console.log(
        `   flags=[${candidate.flags.join('+')}] failedAtTier=${candidate.failedAtTier} winRateGap=${candidate.gap.winRateGap.toFixed(4)} scoreDiffGap=${candidate.gap.scoreDiffGap.toFixed(4)}`,
      );
    }
  }
  console.log(`   저장: runs/${GAME_ID}/near-miss.json`);
  if (pipeline.promotion.promotedVersion === null) {
    console.log('   이번 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else if (pipeline.promotion.alreadyPromoted) {
    console.log('   이 웨이브는 이미 승격됨 — 스킵');
  } else {
    console.log(`   승격: ${pipeline.promotion.promotedVersion}, flags=[${pipeline.promotion.adoptedFlags.join(', ')}]`);
  }
  console.log(`   게임 요약(중간): runs/${GAME_ID}/summary.md`);

  const reportA = pipeline.report;

  console.log('4.5) wave B — M4 field-mix (docs/GAP-ANALYSIS-10.md M4): fieldMix=[heuristic,heuristic,random]');
  console.log('   3 non-candidate seats: 2 filled by baselines.heuristic, 1 filled by baselines.random —');
  console.log('   a king-making composition where the weak 3rd opponent (random) can decide who the 2 heuristic');
  console.log('   opponents inadvertently help, instead of every non-candidate seat facing the uniform opponent.');
  const clampedBlocks = pipeline.clampedBlocks;
  const smokeMaxBlocksB = clampedBlocks * 3;
  const ledgerB = new SeedLedger();
  const reservedAtB = now();
  ledgerB.reserve({ bankId: 'catan-runner-smoke-b', range: { start: 1, end: smokeMaxBlocksB }, purpose: 'smoke', reservedAt: reservedAtB });
  ledgerB.reserve({ bankId: 'catan-runner-prune-b', range: { start: 1000, end: 999 + clampedBlocks }, purpose: 'prune', reservedAt: reservedAtB });
  ledgerB.reserve({ bankId: 'catan-runner-holdout-b', range: { start: 2000, end: 1999 + clampedBlocks }, purpose: 'holdout', reservedAt: reservedAtB });

  const waveConfigB: WaveConfig = {
    ...assembleWaveConfig(adapter, {
      waveId: 'runner-wave-field-mix',
      candidates: flags.map((flag) => ({ flag })),
      opponent: 'heuristic', // ignored for non-candidate seats once fieldMix is set below; kept as the fallback shape.
      ledger: ledgerB,
      recordedAt: now(),
      baselineFlags: pipeline.registry.get('v1')?.flags ?? [],
      baselineVersion: pipeline.baselineVersion,
      tiers: {
        smoke: { bankId: 'catan-runner-smoke-b', sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 }, maxBlocks: smokeMaxBlocksB, minBlocks: 5 },
        prune: { bankId: 'catan-runner-prune-b', blocks: clampedBlocks },
        holdout: { bankId: 'catan-runner-holdout-b', blocks: clampedBlocks },
      },
      screenProbe: { seeds: [1, 2, 3], botSeedBase: 100 },
    }),
    fieldMix: ['heuristic', 'heuristic', 'random'],
  };
  console.log(`   fieldMix: [${(waveConfigB.fieldMix ?? []).join(', ')}] (length ${(waveConfigB.fieldMix ?? []).length}, expected playerCount-1=${adapter.spec.playerCount - 1})`);
  console.log('   slot->factory identity check (reconstructs exactly what wave-runner.ts:buildRestFactories does with this fieldMix, without touching loop/ internals):');
  (waveConfigB.fieldMix ?? []).forEach((baselineName, i) => {
    const bot = catanAdapter.baselines[baselineName](900_000 + i);
    console.log(`     seat ${i + 1} (non-candidate slot ${i}) -> baselines.${baselineName} -> bot.id="${bot.id}"`);
  });

  const reportB = runWave(adapter, waveConfigB);
  logWaveResults(reportB);
  saveRunIfAbsent(runStore, {
    gameId: GAME_ID,
    runId: reportB.waveId,
    kind: 'wave',
    recordedAt: now(),
    comparabilityKey: reportB.comparabilityKey,
    payload: reportB,
    markdown: `# Wave Report — ${reportB.waveId}\n\n${reportB.results.map((r) => `- ${r.flag}: ${r.verdict} (tiers: ${r.tiersPassed.join('→') || 'none'})`).join('\n')}\n`,
  });

  console.log('4.6) wave A vs wave B comparison (fieldMix effect on measured smoke win rate)');
  for (const flag of flags) {
    const a = reportA.results.find((r) => r.flag === flag);
    const b = reportB.results.find((r) => r.flag === flag);
    const aSmoke = a?.stats.smoke;
    const bSmoke = b?.stats.smoke;
    console.log(
      `   ${flag}: single-opponent smoke winRate=${aSmoke ? aSmoke.pointWinRate.toFixed(3) : 'n/a'} ` +
        `vs field-mix smoke winRate=${bSmoke ? bSmoke.pointWinRate.toFixed(3) : 'n/a'} ` +
        `(different because non-candidate seats face a different opponent composition, not because the candidate itself changed)`,
    );
  }

  console.log('5) record adoption ledger entry (wave B — wave A already recorded by the onboarding pipeline)');
  function toEntries(report: WaveReport): AdoptionEntry[] {
    return report.results.map((result) => {
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
  }

  // Reuse the same registry/ledger instances the pipeline already mutated
  // and persisted (wave A's promotion + adoption record are already saved
  // to disk at this point) so wave B's own adoption record appends onto that
  // same in-memory state.
  const registry = pipeline.registry;
  const ledger = pipeline.ledger;
  const v1 = registry.get('v1');
  if (v1 === undefined) {
    throw new Error('catan runner: v1 baseline missing after onboarding pipeline');
  }

  ledger.add({
    waveId: reportB.waveId,
    recordedAt: now(),
    comparabilityKey: reportB.comparabilityKey,
    baselineVersion: v1.version,
    opponentId: `fieldMix:${(waveConfigB.fieldMix ?? []).join('+')}`,
    entries: toEntries(reportB),
    nextLoopNotes: [],
  });

  // Wave B is M4-demonstration-only (not part of the adoption/near-miss
  // pipeline) — only wave A's near-miss candidates were extracted, already
  // done inside runOnboardingPipeline.

  console.log('6) persist registry/ledger (registry unchanged since pipeline\'s save; ledger now also has wave B)');
  saveRegistry(rootDir, GAME_ID, registry);
  saveLedger(rootDir, GAME_ID, ledger);
  console.log(`   anchors=${registry.listAnchors().length} adoptionRecords=${ledger.all().length}`);

  console.log('7) game-summary 렌더 (재렌더 — wave B의 원장 항목 반영)');
  const summaryMarkdown = renderGameSummaryMarkdown(rootDir, GAME_ID, { latestWaveCriteria: pipeline.criteria });
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'summary.md'), summaryMarkdown);
  console.log(`   게임 요약: runs/${GAME_ID}/summary.md`);

  console.log('=== catan runner complete ===');
}

main();
