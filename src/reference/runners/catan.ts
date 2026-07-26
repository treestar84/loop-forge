/**
 * catan — per-game execution entrypoint. Two purposes:
 *
 *  1. Standard onboarding validation (G-Score conformance, calibration,
 *     registry/ledger bootstrap, a small smoke-only wave over the strategy
 *     surface) — mirrors reference/runners/avalon.ts's structure.
 *  2. M4 real-game validation (docs/GAP-ANALYSIS-10.md §4, M4 already
 *     implemented in loop/wave-runner.ts / commit 37fb7dc): catan is a
 *     4-player FFA game, exactly the shape M4's `WaveConfig.fieldMix` was
 *     built for ("나머지 3명 중 2명은 heuristic, 1명은 random" king-making
 *     composition). Step 4 below runs a SECOND wave with
 *     `fieldMix: ['heuristic', 'heuristic', 'random']` and logs per-slot bot
 *     factory identity plus a side-by-side comparison against the
 *     single-opponent wave from step 3, to demonstrate fieldMix actually
 *     wiring distinct baselines into distinct non-candidate seats in a real
 *     multiplayer game (not just the unit-test coverage wave-runner.test.ts
 *     already has).
 *
 * Every file under reference/runners/ is an app boundary (see
 * src/__tests__/dependency-rules.test.ts's APP_BOUNDARY_PREFIXES) — this is
 * the one place allowed to call `new Date().toISOString()` for this game.
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { assembleWaveConfig } from '../../loop/assemble-wave-config';
import { runWave, type WaveConfig } from '../../loop/wave-runner';
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
import { computeSourceDigest } from '../../artifacts/source-digest';
import { catanAdapter } from '../catan';

const GAME_ID = 'catan';

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

function logWaveResults(report: ReturnType<typeof runWave>): void {
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

  console.log('1.5) 캘리브레이션 — noise floor 기반 블록 수 산정 (heuristic vs heuristic, single-opponent field)');
  const identitySeeds = Array.from({ length: 60 }, (_, i) => 700_000 + i);
  const noiseFloor = measureNoiseFloor(adapter, catanAdapter.baselines.heuristic, identitySeeds, 600_000, {
    iterations: 2000,
    confidenceLevel: 0.95,
    seed: 42,
  });
  console.log(
    `   identity self-play (heuristic vs heuristic, ${identitySeeds.length} seeds): meanWinRate(seat0)=${noiseFloor.pointWinRate.toFixed(4)}, ` +
      `CI=[${noiseFloor.winRate.lower.toFixed(4)}, ${noiseFloor.winRate.upper.toFixed(4)}] — playerCount=4 so naive expectation is ${(1 / adapter.spec.playerCount).toFixed(4)}.`,
  );
  const recommendedBlocks = noiseFloor.blockStdDev > 0
    ? recommendBlockCount({ blockStdDev: noiseFloor.blockStdDev, targetEffect: 0.05 })
    : 5;
  const clampedBlocks = Math.min(Math.max(recommendedBlocks, 5), 20);
  console.log(
    `   캘리브레이션: blockStdDev=${noiseFloor.blockStdDev.toFixed(4)}, 권장 블록수=${recommendedBlocks}(클램프 후 ${clampedBlocks})`,
  );

  console.log('2) load-or-create registry/ledger from runs/catan/');
  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const ledger = loadOrCreateLedger(rootDir, GAME_ID);
  const sourceDigest = computeSourceDigest(SOURCE_FILES);
  const priorLatest = registry.latest();
  if (priorLatest?.sourceDigest !== undefined && priorLatest.sourceDigest !== sourceDigest) {
    console.log(
      `   ⚠ source drift detected: registry latest (${priorLatest.version}) was registered with sourceDigest=${priorLatest.sourceDigest}, current source=${sourceDigest}.`,
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
    throw new Error('catan runner: v1 baseline missing after registration step');
  }

  const flags = catanAdapter.strategySurface.map((spec) => spec.flag);
  console.log(`   candidates: ${flags.join(', ')}`);

  console.log('4) wave A — single-opponent field (opponent: heuristic, baseline pre-M4 shape)');
  const smokeMaxBlocksA = clampedBlocks * 3;
  const ledgerA = new SeedLedger();
  const reservedAtA = now();
  ledgerA.reserve({ bankId: 'catan-runner-smoke-a', range: { start: 1, end: smokeMaxBlocksA }, purpose: 'smoke', reservedAt: reservedAtA });
  ledgerA.reserve({ bankId: 'catan-runner-prune-a', range: { start: 1000, end: 999 + clampedBlocks }, purpose: 'prune', reservedAt: reservedAtA });
  ledgerA.reserve({ bankId: 'catan-runner-holdout-a', range: { start: 2000, end: 1999 + clampedBlocks }, purpose: 'holdout', reservedAt: reservedAtA });

  const waveConfigA = assembleWaveConfig(adapter, {
    waveId: 'runner-wave-single-opponent',
    candidates: flags.map((flag) => ({ flag })),
    opponent: 'heuristic',
    ledger: ledgerA,
    recordedAt: now(),
    baselineFlags: v1.flags,
    baselineVersion: v1.version,
    tiers: {
      smoke: { bankId: 'catan-runner-smoke-a', sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 }, maxBlocks: smokeMaxBlocksA, minBlocks: 5 },
      prune: { bankId: 'catan-runner-prune-a', blocks: clampedBlocks },
      holdout: { bankId: 'catan-runner-holdout-a', blocks: clampedBlocks },
    },
    screenProbe: { seeds: [1, 2, 3], botSeedBase: 100 },
  });
  console.log(`   criteria: minWinRate=${waveConfigA.criteria.minWinRate} minScoreDiff=${waveConfigA.criteria.minScoreDiff}`);
  console.log(`   fieldMix: ${waveConfigA.fieldMix === undefined ? '(unset — every non-candidate seat filled by opponent="heuristic")' : waveConfigA.fieldMix.join(',')}`);

  const reportA = runWave(adapter, waveConfigA);
  logWaveResults(reportA);
  saveRunIfAbsent(runStore, {
    gameId: GAME_ID,
    runId: reportA.waveId,
    kind: 'wave',
    recordedAt: now(),
    comparabilityKey: reportA.comparabilityKey,
    payload: reportA,
    markdown: `# Wave Report — ${reportA.waveId}\n\n${reportA.results.map((r) => `- ${r.flag}: ${r.verdict} (tiers: ${r.tiersPassed.join('→') || 'none'})`).join('\n')}\n`,
  });

  console.log('4.5) wave B — M4 field-mix (docs/GAP-ANALYSIS-10.md M4): fieldMix=[heuristic,heuristic,random]');
  console.log('   3 non-candidate seats: 2 filled by baselines.heuristic, 1 filled by baselines.random —');
  console.log('   a king-making composition where the weak 3rd opponent (random) can decide who the 2 heuristic');
  console.log('   opponents inadvertently help, instead of every non-candidate seat facing the uniform opponent.');
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
      baselineFlags: v1.flags,
      baselineVersion: v1.version,
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

  console.log('5) record adoption ledger entries (both waves)');
  function toEntries(report: typeof reportA): AdoptionEntry[] {
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

  const adoptionRecordA = ledger.add({
    waveId: reportA.waveId,
    recordedAt: now(),
    comparabilityKey: reportA.comparabilityKey,
    baselineVersion: v1.version,
    opponentId: waveConfigA.opponent,
    entries: toEntries(reportA),
    nextLoopNotes: [],
  });
  ledger.add({
    waveId: reportB.waveId,
    recordedAt: now(),
    comparabilityKey: reportB.comparabilityKey,
    baselineVersion: v1.version,
    opponentId: `fieldMix:${(waveConfigB.fieldMix ?? []).join('+')}`,
    entries: toEntries(reportB),
    nextLoopNotes: [],
  });

  console.log('5.5) near-miss 후보 추출 (wave A만 — 웨이브 B는 M4 실증용, 채택 파이프라인 대상 아님)');
  const nearMiss = extractNearMissCandidates(adoptionRecordA, waveConfigA.criteria);
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

  console.log('5.6) 웨이브 A 채택 플래그 registry 승격 (웨이브 B는 승격 대상에서 제외 — 필드믹스는 실증용)');
  const adoptedFlags = reportA.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  if (adoptedFlags.length === 0) {
    console.log('   이번 웨이브에서 채택된 전략 없음 — 승격 대상 없음');
  } else {
    const currentLatest = registry.latest();
    if (currentLatest === undefined) {
      throw new Error('catan runner: registry has no latest baseline before promotion step');
    }
    const lineage = registry.lineage(currentLatest.version);
    const alreadyPromoted = lineage.some((version) => version.sourceWaveId === reportA.waveId);
    if (alreadyPromoted) {
      console.log('   이 웨이브는 이미 승격됨 — 스킵');
    } else {
      const nextVersion = registry.register({
        version: `v${lineage.length + 1}`,
        flags: [...currentLatest.flags, ...adoptedFlags],
        parent: currentLatest.version,
        createdAt: now(),
        sourceWaveId: reportA.waveId,
        notes: `웨이브 ${reportA.waveId}에서 채택된 플래그 승격: ${adoptedFlags.join(', ')}`,
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
  const summaryMarkdown = renderGameSummaryMarkdown(rootDir, GAME_ID, { latestWaveCriteria: waveConfigA.criteria });
  writeFileSync(join(rootDir, 'runs', GAME_ID, 'summary.md'), summaryMarkdown);
  console.log(`   게임 요약: runs/${GAME_ID}/summary.md`);

  console.log('=== catan runner complete ===');
}

main();
