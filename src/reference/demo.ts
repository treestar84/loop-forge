/**
 * End-to-end demo (`npm run demo`): mini-trick through the full Loop Forge
 * pipeline — conformance scoring, calibration, and a wave (DESIGN.md §8 item 5).
 *
 *   1. Score mini-trick with the G-Score battery, render the Markdown report.
 *   2. Run identity calibration diagnostics.
 *   3. Reserve smoke/prune/holdout seed banks and run a wave over
 *      winCheapest / noopSort / leadHighFirst against the heuristic baseline.
 *   4. Print the WaveReport as a table.
 */

import { sha256Digest } from '../kernel/digest';
import { DEFAULT_CRITERIA } from '../kernel/gates';
import { SeedLedger } from '../kernel/seed-ledger';
import { calibrateIdentity } from '../loop/calibrate';
import { eraseAdapter } from '../loop/erase';
import { runWave, type WaveConfig } from '../loop/wave-runner';
import { renderReportMarkdown } from '../onboarding/report';
import { scoreAdapter } from '../onboarding/score';
import { miniTrickAdapter } from './mini-trick';

function section(title: string): void {
  console.log('');
  console.log('='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
}

function main(): void {
  const adapter = eraseAdapter(miniTrickAdapter);

  section('1단계 — G-Score 온보딩 채점');
  const conformance = scoreAdapter(adapter, { threshold: 65 });
  console.log(renderReportMarkdown(conformance));

  if (!conformance.ready) {
    console.log(
      '온보딩 채점 미달 — 웨이브 실행을 중단합니다. 위 blocker 항목을 먼저 해결하세요.',
    );
    return;
  }
  console.log('온보딩 채점 통과 — 웨이브 실행으로 진행합니다.');

  section('2단계 — 캘리브레이션 (좌석 편향/항등성 진단)');
  const identitySeeds = Array.from({ length: 300 }, (_, i) => 900_000 + i);
  const identity = calibrateIdentity(adapter, miniTrickAdapter.baselines.random, identitySeeds, 800_000);
  console.log(`평균 승률(항등, ~0.5가 기대값): ${identity.meanWinRate.toFixed(4)}`);
  console.log(
    `좌석별 승률: [${identity.seatWinRates.map((rate) => rate.toFixed(4)).join(', ')}]`,
  );
  console.log(`좌석 편향(bias, max-min): ${identity.bias.toFixed(4)}`);

  section('3단계 — 웨이브 실행 (winCheapest / noopSort / leadHighFirst)');
  const ledger = new SeedLedger();
  const reservedAt = new Date().toISOString();
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

  section('4단계 — WaveReport 결과');
  console.log(`waveId: ${report.waveId}`);
  console.log(`seedConsumption: ${report.seedConsumption.join(', ')}`);
  console.log(`reportDigest: ${report.reportDigest}`);
  console.log(`(digest 재계산 검증: ${sha256Digest({
    waveId: report.waveId,
    results: report.results,
    seedConsumption: report.seedConsumption,
  }) === report.reportDigest ? 'OK' : 'MISMATCH'})`);
  console.log('');

  const header = '| flag | verdict | tiersPassed | smoke winRate | prune winRate | holdout winRate |';
  const divider = '|---|---|---|---|---|---|';
  console.log(header);
  console.log(divider);
  for (const result of report.results) {
    const smoke = result.stats.smoke ? result.stats.smoke.pointWinRate.toFixed(3) : '-';
    const prune = result.stats.prune ? result.stats.prune.pointWinRate.toFixed(3) : '-';
    const holdout = result.stats.holdout ? result.stats.holdout.pointWinRate.toFixed(3) : '-';
    console.log(
      `| ${result.flag} | ${result.verdict} | ${result.tiersPassed.join('→') || '(none)'} | ${smoke} | ${prune} | ${holdout} |`,
    );
    if (result.defect) {
      console.log(`  ⚠ defect: [${result.defect.type}] ${result.defect.message}`);
    }
  }

  console.log('');
  console.log(
    '기대: winCheapest는 채택(adopted), noopSort는 screen에서 탈락(behavioral no-op), ' +
      'leadHighFirst는 실제 통계 결과에 따른 판정(near-miss/failed/adopted 무엇이든 그대로).',
  );
}

main();
