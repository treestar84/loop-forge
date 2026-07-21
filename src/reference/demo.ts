/**
 * End-to-end demo (`npm run demo`): mini-trick through the full Loop Forge
 * pipeline, persisting every step as a run artifact (GAP-ANALYSIS.md C1-C5):
 *
 *   1. Conformance scoring (G-Score) -> saved run.
 *   2. Calibration diagnostics -> saved run.
 *   3. BaselineRegistry: register v1 (pristine heuristic, no flags) and
 *      freeze the random/heuristic benchmark anchors.
 *   4. Wave over winCheapest/noopSort/leadHighFirst -> saved run +
 *      AdoptionLedger entry.
 *   5. Compose v2 from v1 + the wave's adopted flags.
 *   6. Benchmark ladder for v1 and v2 against the frozen anchors -> saved
 *      run + a win-rate progression SVG.
 *   7. Render the full AdoptionLedger as STRATEGY-HISTORY.md -> saved to
 *      runs/.
 *
 * demo.ts is the one place in this codebase allowed to call
 * `new Date().toISOString()` directly (kernel/loop code must stay
 * Date.now()-free; the artifact/run layer takes timestamps as required
 * caller-supplied parameters, and this is the caller).
 */

import { join } from 'node:path';

import { canonicalJson, sha256Digest } from '../kernel/digest';
import { DEFAULT_CRITERIA } from '../kernel/gates';
import { SeedLedger } from '../kernel/seed-ledger';
import { calibrateIdentity } from '../loop/calibrate';
import { eraseAdapter } from '../loop/erase';
import { runWave, type WaveConfig } from '../loop/wave-runner';
import { renderReportMarkdown } from '../onboarding/report';
import { scoreAdapter } from '../onboarding/score';
import { BaselineRegistry, composeBot } from '../artifacts/baseline-registry';
import { AdoptionLedger, type AdoptionEntry } from '../artifacts/adoption-ledger';
import { computeComparabilityKey, RunStore } from '../artifacts/run-store';
import { renderLadderMarkdown, runBenchmarkLadder } from '../artifacts/benchmark';
import { renderMetricTable, renderProgressionSvg } from '../artifacts/charts';
import { miniTrickAdapter } from './mini-trick';

function section(title: string): void {
  console.log('');
  console.log('='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
}

function main(): void {
  const adapter = eraseAdapter(miniTrickAdapter);
  const runStore = new RunStore(join(__dirname, '..', '..'));
  const savedPaths: string[] = [];
  const now = () => new Date().toISOString();

  const specDigest = sha256Digest(canonicalJson(adapter.spec));

  section('1단계 — G-Score 온보딩 채점');
  const conformance = scoreAdapter(adapter, { threshold: 65 });
  const conformanceMarkdown = renderReportMarkdown(conformance);
  console.log(conformanceMarkdown);

  if (!conformance.ready) {
    console.log(
      '온보딩 채점 미달 — 웨이브 실행을 중단합니다. 위 blocker 항목을 먼저 해결하세요.',
    );
    return;
  }
  console.log('온보딩 채점 통과 — 웨이브 실행으로 진행합니다.');

  runStore.saveRun({
    runId: 'conformance-mini-trick',
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
    markdown: conformanceMarkdown,
  });
  savedPaths.push('runs/conformance-mini-trick/');

  section('2단계 — 캘리브레이션 (좌석 편향/항등성 진단)');
  const identitySeeds = Array.from({ length: 300 }, (_, i) => 900_000 + i);
  const identity = calibrateIdentity(adapter, miniTrickAdapter.baselines.random, identitySeeds, 800_000);
  console.log(`평균 승률(항등, ~0.5가 기대값): ${identity.meanWinRate.toFixed(4)}`);
  console.log(
    `좌석별 승률: [${identity.seatWinRates.map((rate) => rate.toFixed(4)).join(', ')}]`,
  );
  console.log(`좌석 편향(bias, max-min): ${identity.bias.toFixed(4)}`);

  const calibrationMarkdown = [
    '# Calibration — mini-trick',
    '',
    renderMetricTable([
      { label: 'meanWinRate', value: identity.meanWinRate.toFixed(4), bar: { value: identity.meanWinRate, max: 1 } },
      { label: 'bias (max-min)', value: identity.bias.toFixed(4), bar: { value: identity.bias, max: 1 } },
    ]),
    '',
  ].join('\n');
  runStore.saveRun({
    runId: 'calibration-mini-trick',
    kind: 'calibration',
    recordedAt: now(),
    comparabilityKey: computeComparabilityKey({
      gameId: adapter.spec.gameId,
      specDigest,
      baselineVersion: 'n/a',
      opponentId: 'random',
      seedBankIds: [],
    }),
    payload: identity,
    markdown: calibrationMarkdown,
  });
  savedPaths.push('runs/calibration-mini-trick/');

  section('3단계 — BaselineRegistry v1 등록 + 벤치마크 앵커 동결');
  const registry = new BaselineRegistry();
  const registeredAt = now();
  const v1 = registry.register({
    version: 'v1',
    flags: [],
    parent: null,
    createdAt: registeredAt,
    sourceWaveId: null,
    notes: '순정 heuristic 기준선 (플래그 없음).',
  });
  registry.registerAnchor({ anchorId: 'anchor-random', kind: 'random' });
  registry.registerAnchor({ anchorId: 'anchor-heuristic', kind: 'heuristic' });
  console.log(`baseline ${v1.version} 등록, 앵커 2개(random, heuristic) 동결.`);

  section('4단계 — 웨이브 실행 (winCheapest / noopSort / leadHighFirst)');
  const ledger = new SeedLedger();
  const reservedAt = now();
  ledger.reserve({
    bankId: 'demo-smoke',
    range: { start: 1000, end: 1079 },
    purpose: 'smoke',
    reservedAt,
  });
  ledger.reserve({
    bankId: 'demo-prune',
    range: { start: 2000, end: 2149 },
    purpose: 'prune',
    reservedAt,
  });
  ledger.reserve({
    bankId: 'demo-holdout',
    range: { start: 3000, end: 3149 },
    purpose: 'holdout',
    reservedAt,
  });

  // mini-trick's scores range 0-6 (six tricks total); kernel/gates'
  // DEFAULT_CRITERIA is tuned for a larger-magnitude game, so this demo scales
  // minScoreDiff down accordingly. minWinRate is kept at the kernel default.
  const criteria = { minWinRate: DEFAULT_CRITERIA.minWinRate, minScoreDiff: 0.3 };

  const waveConfig: WaveConfig = {
    waveId: 'demo-wave-1',
    candidates: [{ flag: 'winCheapest' }, { flag: 'noopSort' }, { flag: 'leadHighFirst' }],
    opponent: 'heuristic',
    ledger,
    baselineFlags: v1.flags,
    baselineVersion: v1.version,
    tiers: {
      smoke: {
        bankId: 'demo-smoke',
        sprt: { p0: 0.5, p1: 0.58, alpha: 0.05, beta: 0.05 },
        maxBlocks: 80,
        minBlocks: 10,
      },
      prune: { bankId: 'demo-prune', blocks: 150 },
      holdout: { bankId: 'demo-holdout', blocks: 150 },
    },
    criteria,
    // Probe seeds independently confirmed to expose winCheapest's decision
    // divergence from the heuristic baseline (see loop/__tests__/wave-runner.test.ts).
    screenProbe: { seeds: [7, 11, 12, 13, 42], botSeedBase: 500 },
  };

  const report = runWave(adapter, waveConfig);

  section('4단계 결과 — WaveReport');
  console.log(`waveId: ${report.waveId}`);
  console.log(`comparabilityKey: ${report.comparabilityKey}`);
  console.log(`seedConsumption: ${report.seedConsumption.join(', ')}`);
  console.log(`reportDigest: ${report.reportDigest}`);

  const waveHeader = '| flag | verdict | tiersPassed | smoke winRate | prune winRate | holdout winRate | drawRate(holdout) |';
  const waveDivider = '|---|---|---|---|---|---|---|';
  const waveTableLines = [waveHeader, waveDivider];
  for (const result of report.results) {
    const smoke = result.stats.smoke ? result.stats.smoke.pointWinRate.toFixed(3) : '-';
    const prune = result.stats.prune ? result.stats.prune.pointWinRate.toFixed(3) : '-';
    const holdout = result.stats.holdout ? result.stats.holdout.pointWinRate.toFixed(3) : '-';
    const drawRate = result.stats.holdout?.drawRate !== undefined ? result.stats.holdout.drawRate.toFixed(3) : '-';
    waveTableLines.push(
      `| ${result.flag} | ${result.verdict} | ${result.tiersPassed.join('→') || '(none)'} | ${smoke} | ${prune} | ${holdout} | ${drawRate} |`,
    );
  }
  console.log(waveTableLines.join('\n'));
  console.log('');
  console.log(
    '기대: winCheapest는 채택(adopted), noopSort는 screen에서 탈락(behavioral no-op), ' +
      'leadHighFirst는 실제 통계 결과에 따른 판정(near-miss/failed/adopted 무엇이든 그대로).',
  );

  const waveMarkdown = ['# Wave Report — demo-wave-1', '', ...waveTableLines, ''].join('\n');
  runStore.saveRun({
    runId: report.waveId,
    kind: 'wave',
    recordedAt: now(),
    comparabilityKey: report.comparabilityKey,
    payload: report,
    markdown: waveMarkdown,
  });
  savedPaths.push(`runs/${report.waveId}/`);

  const adoptionLedger = new AdoptionLedger();
  const adoptionEntries: AdoptionEntry[] = report.results.map((result) => {
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
  adoptionLedger.add({
    waveId: report.waveId,
    recordedAt: now(),
    comparabilityKey: report.comparabilityKey,
    baselineVersion: v1.version,
    opponentId: waveConfig.opponent,
    entries: adoptionEntries,
    nextLoopNotes: [
      'noopSort는 순서 재배치만 하는 no-op으로 설계 의도대로 스크리닝에서 탈락함 — 유사 패턴 재도입 금지.',
      'leadHighFirst는 실제 holdout 판정에 따라 다음 웨이브에서 재설계 여부를 결정할 것.',
    ],
  });

  section('5단계 — v1 + 채택 플래그로 v2 합성');
  const adoptedFlags = report.results
    .filter((r) => r.verdict === 'adopted')
    .flatMap((r) => r.flags);
  const v2 = registry.register({
    version: 'v2',
    flags: [...v1.flags, ...adoptedFlags],
    parent: v1.version,
    createdAt: now(),
    sourceWaveId: report.waveId,
    notes: adoptedFlags.length > 0
      ? `wave ${report.waveId}에서 채택된 플래그(${adoptedFlags.join(', ')})를 v1에 합성.`
      : `wave ${report.waveId}에서 채택된 플래그 없음 — v2는 v1과 동일 구성.`,
  });
  console.log(`baseline ${v2.version} 등록 (flags: [${v2.flags.join(', ')}], parent: ${v2.parent}).`);

  section('6단계 — 앵커 사다리 벤치마크 (v1 vs v2)');
  const anchors = registry.listAnchors();
  const ladderSeeds = Array.from({ length: 200 }, (_, i) => 400_000 + i);
  const v1Subject = composeBot(adapter, v1.flags);
  const v2Subject = composeBot(adapter, v2.flags);
  const v1Ladder = runBenchmarkLadder(adapter, v1Subject, anchors, registry, {
    seeds: ladderSeeds,
    botSeedBase: 700_000,
  });
  const v2Ladder = runBenchmarkLadder(adapter, v2Subject, anchors, registry, {
    seeds: ladderSeeds,
    botSeedBase: 700_000,
  });
  console.log('v1 사다리:');
  console.log(renderLadderMarkdown(v1Ladder));
  console.log('v2 사다리:');
  console.log(renderLadderMarkdown(v2Ladder));

  const progressionSvg = renderProgressionSvg(
    anchors.map((anchor) => ({
      label: anchor.anchorId,
      points: [
        { x: v1.version, y: v1Ladder.rungs.find((r) => r.anchorId === anchor.anchorId)?.pointWinRate ?? 0 },
        { x: v2.version, y: v2Ladder.rungs.find((r) => r.anchorId === anchor.anchorId)?.pointWinRate ?? 0 },
      ],
    })),
    { title: 'mini-trick 앵커전 승률 추이 (v1 → v2)', yLabel: 'win rate', yMin: 0, yMax: 1 },
  );

  const benchmarkMarkdown = [
    '# Benchmark Ladder — v1 vs v2',
    '',
    '## v1',
    '',
    renderLadderMarkdown(v1Ladder),
    '## v2',
    '',
    renderLadderMarkdown(v2Ladder),
  ].join('\n');
  runStore.saveRun({
    runId: 'benchmark-v1-vs-v2',
    kind: 'benchmark',
    recordedAt: now(),
    comparabilityKey: computeComparabilityKey({
      gameId: adapter.spec.gameId,
      specDigest,
      baselineVersion: `${v1.version}->${v2.version}`,
      opponentId: 'anchor-ladder',
      seedBankIds: ['demo-ladder'],
    }),
    payload: { v1: v1Ladder, v2: v2Ladder, registry: registry.toJSON() },
    markdown: benchmarkMarkdown,
    svg: [{ name: 'progression.svg', content: progressionSvg }],
  });
  savedPaths.push('runs/benchmark-v1-vs-v2/ (payload.json, digest.txt, report.md, progression.svg)');

  section('7단계 — STRATEGY-HISTORY.md 렌더');
  const strategyHistoryMarkdown = adoptionLedger.renderStrategyHistoryMarkdown();
  runStore.saveRun({
    runId: 'strategy-history',
    kind: 'wave',
    recordedAt: now(),
    comparabilityKey: report.comparabilityKey,
    payload: adoptionLedger.toJSON(),
    markdown: strategyHistoryMarkdown,
  });
  savedPaths.push('runs/strategy-history/ (report.md === STRATEGY-HISTORY.md 내용)');

  section('요약');
  console.log('전체 파이프라인 실행 완료: 온보딩 채점 → 캘리브레이션 → 기준선 v1 등록 →');
  console.log('웨이브 실행(채택 판정) → v2 합성 → v1/v2 앵커 사다리 벤치마크 → 이력 렌더.');
  console.log('');
  console.log('저장된 산출물:');
  for (const path of savedPaths) {
    console.log(`  - ${path}`);
  }
}

main();
