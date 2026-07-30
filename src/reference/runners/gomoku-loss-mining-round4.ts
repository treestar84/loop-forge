/**
 * gomoku-loss-mining-round4 — GAP-11 Phase 4 오목 4회전 전반부(재채굴 + 브리프
 * 입력, 팀리드 지시, docs/GAP-ANALYSIS-11.md §5.5 following gomoku-loss-mining-
 * round2.ts's precedent verbatim).
 *
 * 대상: registry **v7**. v7의 flags 배열은 정적 6종 + round1 4종(portfolio-
 * round1.ts 승격) + round2 3종(portfolio-round2.ts 승격: `mcts10-s256-combined-
 * w16`, `mcts10-s256-combined-w16-c04`, `mcts12-s256-opusclone-w16`) — 3회전의
 * s512/s768 예산 우위 진단(gomoku-round3-candidates.ts)은 기각돼 registry에는
 * 반영되지 않았다(v7 그대로). composeBot의 "MCTS 계열 플래그는 base를 완전히
 * 무시" 규칙(round2 재채굴에서 처음 발견, gomoku-loss-mining-round2.ts 자신의
 * doc comment)이 여기서도 그대로 적용돼, v7의 실질 합성봇은 나열된 MCTS 플래그
 * 중 **마지막 하나** `mcts12-s256-opusclone-w16` 단독이다 — 이는 3회전 미니
 * 진단(gomoku-round3-candidates.ts)이 이미 명시한 사실이므로 재확인만 한다
 * (실행 시 콘솔에 composedFlags를 그대로 출력해 팀리드가 재확인할 수 있게 함).
 *
 * Seeds: fresh, disjoint from every prior gomoku-loss-mining*.ts range
 * (300,000s round1 / 400,000s round2 / 520,000-538,999 portfolio rounds /
 * 70,000-90,699 3-column benchmarks / 700,000-700,099·600,000 gomoku.ts's own
 * noise-floor probe / 990,000-997,999 anchor-ladder gates) — this file uses
 * 800,000+ (측정 1, v7 vs L2) and 801,000+ (측정 2, v7 vs L1). Bot-seed bases:
 * 977,101/977,102/977,201(mineLosses+mineDraws+probeScoreL2, probe-bank.ts's
 * self-consistency requirement)/977,302 — a distinct range from every prior
 * round's 975,1xx-975,3xx/976,1xx-976,3xx.
 *
 * Probe bank: rounds 1/2's runs/gomoku/probe-bank.json /
 * probe-bank-round2.json are left untouched — this round's newly-mined
 * L2-loss divergences are sealed into a separate
 * runs/gomoku/probe-bank-round4.json (팀리드 지시), same probeId convention
 * (`${gameSeed}-${decisionIndex}`) so the disjoint seed range above already
 * guarantees no collision.
 *
 * Draw analysis (팀리드 지시, 이번 라운드의 핵심 신규 분석): v7 vs L2의 무승부율
 * 57.5%(3회전 확증치)가 어디서 갈리는지 — `mineDraws`(loop/loss-mining.ts, 이
 * 라운드를 위해 신설한 mineLosses의 draw 대응 함수)로 (a) 무승부 게임의 전체
 * 길이 분포(gameLengthHistogram), (b) 그 안에서 후보-앵커 첫/마지막 분기 깊이
 * 분포(first/lastDivergenceDepthHistogram — lastDivergenceDepthHistogram이
 * "무승부로 안착하는 지점"의 직접 근사: 그 이후로는 후보가 앵커와 완전히
 * 합의했다는 뜻)를 각각 집계한다. 패배 판의 분기 구조가 1~2회전(전부 첫
 * 10수)과 같은지 다른지는 기존 mineLosses의 firstDivergenceDepthHistogram을
 * 그대로 비교해 판정한다.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { mineDraws, mineLosses, type DrawReport, type LossReport } from '../../loop/loss-mining';
import { buildProbeBank, scoreAgainstProbes, type ProbePosition, type ProbeScore } from '../../loop/probe-bank';
import type { MatchTrajectoryRecord } from '../../loop/paired-match';
import { loadOrCreateLedger, loadOrCreateRegistry } from '../../artifacts/game-state';
import { saveTrajectories, saveProbeBank } from '../../artifacts/trajectory-archive';
import { gomokuAdapter } from '../gomoku';
import { gomokuOpusBot } from '../experiments/gomoku-opus-bot';
import { gomokuMidBot } from '../experiments/gomoku-mid-bot';
import {
  GOMOKU_MCTS_CONFIG,
  GOMOKU_MCTS_FLAG,
  GOMOKU_MCTS_HR_CONFIG,
  GOMOKU_MCTS_HR_FLAG,
  GOMOKU_MCTS2_S256_CONFIG,
  GOMOKU_MCTS2_S256_FLAG,
  GOMOKU_MCTS2_S256_HR_CONFIG,
  GOMOKU_MCTS2_S256_HR_FLAG,
  gomokuMctsFlagSpecFor,
  gomokuMcts2S256CrFlagSpec,
  gomokuMcts2S512CrFlagSpec,
} from './shared/gomoku-mcts-flag';
import { buildCandidates } from './shared/gomoku-round1-candidates';
import { buildRound2Candidates } from './shared/gomoku-round2-candidates';

const GAME_ID = 'gomoku';
const ADOPTED_VERDICT = 'adopted';
const L2_ANCHOR_ID = 'external-opus-l2';
const L1_ANCHOR_ID = 'external-mid-l1';
const EXPECTED_REGISTRY_VERSION = 'v7';

const N_M1 = 100;
const N_M2 = 100;
const SEED_BASE_M1 = 800_000;
const SEED_BASE_M2 = 801_000;

/** Distinct per-matchup bot-seed bases (cross-contamination guard, same
 * convention as gomoku-loss-mining-round2.ts) — `probeScoreL2` is
 * deliberately equal to `mineLosses`/`mineDraws`'s base (probe-bank.ts's
 * self-consistency requirement). */
const BOT_SEED_BASE = {
  m1: 977_101,
  m2: 977_102,
  mine: 977_201,
  probeScoreL2: 977_201,
  probeScoreV7: 977_302,
} as const;

const MAX_PROBES = 200;

function seeds(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function ci(result: HeadToHeadResult): string {
  return `${pct(result.winRateCI.lower)}-${pct(result.winRateCI.upper)}`;
}

/** Same fallback logic as gomoku-loss-mining-round2.ts's resolveLoopForgeFlags. */
function resolveLoopForgeFlags(rootDir: string): {
  flags: string[];
  registryLatestVersion: string | null;
  registryLatestFlags: string[];
} {
  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const ledger = loadOrCreateLedger(rootDir, GAME_ID);

  const latest = registry.latest();
  const registryLatestFlags = latest ? [...latest.flags] : [];

  const adopted: string[] = [];
  for (const record of ledger.all()) {
    for (const entry of record.entries) {
      if (entry.verdict === ADOPTED_VERDICT) {
        for (const flag of entry.flags) {
          if (!adopted.includes(flag)) adopted.push(flag);
        }
      }
    }
  }

  const flags = registryLatestFlags.length > 0 ? registryLatestFlags : adopted;

  return {
    flags,
    registryLatestVersion: latest ? latest.version : null,
    registryLatestFlags,
  };
}

/** Top-N decision points by mismatch rate (min 5 decisions, to avoid noise
 * from decision points seen only once or twice). */
function topMismatchDecisionPoints(
  mismatchRateByDecisionPoint: LossReport['mismatchRateByDecisionPoint'],
  topN: number,
): Array<{ decisionPointId: string; decisions: number; mismatches: number; mismatchRate: number }> {
  return Object.entries(mismatchRateByDecisionPoint)
    .map(([decisionPointId, stats]) => ({
      decisionPointId,
      decisions: stats.decisions,
      mismatches: stats.mismatches,
      mismatchRate: stats.decisions > 0 ? stats.mismatches / stats.decisions : 0,
    }))
    .filter((entry) => entry.decisions >= 5)
    .sort((a, b) => b.mismatchRate - a.mismatchRate)
    .slice(0, topN);
}

function main(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const bareAdapter = eraseAdapter(gomokuAdapter);
  // Extend the bare adapter with every dynamic flag registry v7 can name:
  // the 6 pre-existing static MCTS flags, round1's 4 promoted dynamic flags,
  // and round2's 6-candidate batch (3 of which v7 actually adopted) — same
  // "rebuild the exact same extended adapter every round measured against"
  // discipline as gomoku-loss-mining-round2.ts's own doc comment.
  const round1Candidates = buildCandidates(bareAdapter);
  const round2Candidates = buildRound2Candidates(bareAdapter);
  const adapter = withStrategyFlags(bareAdapter, [
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_CONFIG, GOMOKU_MCTS_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_HR_CONFIG, GOMOKU_MCTS_HR_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_CONFIG, GOMOKU_MCTS2_S256_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_HR_CONFIG, GOMOKU_MCTS2_S256_HR_FLAG),
    gomokuMcts2S256CrFlagSpec(bareAdapter),
    gomokuMcts2S512CrFlagSpec(bareAdapter),
    ...round1Candidates.map((candidate) => candidate.spec),
    ...round2Candidates.map((candidate) => candidate.spec),
  ]);

  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const l2Anchor = registry.getAnchor(L2_ANCHOR_ID);
  const l1Anchor = registry.getAnchor(L1_ANCHOR_ID);
  if (!l2Anchor) {
    throw new Error(
      `gomoku-loss-mining-round4: anchor "${L2_ANCHOR_ID}" is not registered — run gomoku-anchor-ladder.ts first`,
    );
  }
  if (!l1Anchor) {
    throw new Error(
      `gomoku-loss-mining-round4: anchor "${L1_ANCHOR_ID}" is not registered — run gomoku-anchor-ladder.ts first`,
    );
  }

  const resolved = resolveLoopForgeFlags(rootDir);
  if (resolved.registryLatestVersion !== EXPECTED_REGISTRY_VERSION) {
    console.warn(
      `  경고: registry latest=${resolved.registryLatestVersion} (${EXPECTED_REGISTRY_VERSION} 예상과 다름) — 계속 진행하되 결과 해석 시 comparabilityKey 확인 필요`,
    );
  }
  const v7Bot = composeBot(adapter, resolved.flags);
  const opusBot = gomokuOpusBot;
  const midBot = gomokuMidBot;

  console.log(`=== gomoku loss-mining round 4 (GAP-11 Phase 4) ===`);
  console.log(
    `  registry latest: ${resolved.registryLatestVersion} flags(선언)=[${resolved.registryLatestFlags.join(', ') || '(none)'}]`,
  );
  console.log(
    `  v7 합성봇 composedFlags(=composeBot에 전달한 실제 배열): [${resolved.flags.join(', ') || '(none)'}]`,
  );
  console.log(
    `  주의: composeBot은 MCTS 계열 플래그의 base를 전부 무시하므로, 실질 지배 플래그는 배열의 마지막 MCTS 플래그 하나뿐(round2 재채굴에서 처음 규명) — 위 배열의 마지막 항목을 확인할 것.`,
  );

  const outDir = join(rootDir, 'runs', GAME_ID, 'challenge-l2-round4');
  mkdirSync(outDir, { recursive: true });

  // --- Measurement 1: v7 vs L2, full trajectory collection ---
  const t0 = Date.now();
  console.log(`  측정 1) v7 합성봇 vs L2(opus) N=${N_M1} seedBase=${SEED_BASE_M1} …`);
  const records: MatchTrajectoryRecord[] = [];
  const m1 = runHeadToHead(adapter, v7Bot, opusBot, seeds(SEED_BASE_M1, N_M1), BOT_SEED_BASE.m1, {
    trajectoryCollector: (record) => records.push(record),
  });
  const t1 = Date.now();
  console.log(
    `     winRate=${pct(m1.candidateWinRate)} CI=${ci(m1)} draw/split=${pct(m1.drawRate)} blocks=${m1.blocks} trajectories=${records.length} (${((t1 - t0) / 1000).toFixed(1)}s)`,
  );

  const trajectoriesPath = saveTrajectories(outDir, records, l2Anchor);
  console.log(`  저장: ${trajectoriesPath}`);

  // --- LossReport (losses only) ---
  const lossReport: LossReport = mineLosses(adapter, records, opusBot, { anchorSeedBase: BOT_SEED_BASE.mine });
  const lossReportPath = join(outDir, 'loss-report.json');
  writeFileSync(lossReportPath, JSON.stringify(lossReport, null, 2));
  console.log(`  저장: ${lossReportPath}`);

  const topLossMismatches = topMismatchDecisionPoints(lossReport.mismatchRateByDecisionPoint, 3);
  console.log(
    `  LossReport: totalGames=${lossReport.totalGames} candidateLosses=${lossReport.candidateLosses} divergences=${lossReport.divergences.length}`,
  );
  console.log(`  패배판 첫 분기 깊이 히스토그램: ${JSON.stringify(lossReport.firstDivergenceDepthHistogram)}`);
  console.log(
    `  패배판 불일치율 상위 결정지점(>=5회): ${topLossMismatches.map((e) => `${e.decisionPointId}=${pct(e.mismatchRate)}(${e.mismatches}/${e.decisions})`).join(', ') || '(none)'}`,
  );

  // --- DrawReport (draws only, this round's core new analysis) ---
  const drawReport: DrawReport = mineDraws(adapter, records, opusBot, { anchorSeedBase: BOT_SEED_BASE.mine });
  const drawReportPath = join(outDir, 'draw-report.json');
  writeFileSync(drawReportPath, JSON.stringify(drawReport, null, 2));
  console.log(`  저장: ${drawReportPath}`);

  const topDrawMismatches = topMismatchDecisionPoints(drawReport.mismatchRateByDecisionPoint, 3);
  console.log(
    `  DrawReport: totalGames=${drawReport.totalGames} drawGames=${drawReport.drawGames} divergences=${drawReport.divergences.length}`,
  );
  console.log(`  무승부판 길이 히스토그램: ${JSON.stringify(drawReport.gameLengthHistogram)}`);
  console.log(`  무승부판 첫 분기 깊이 히스토그램: ${JSON.stringify(drawReport.firstDivergenceDepthHistogram)}`);
  console.log(
    `  무승부판 마지막 분기 깊이 히스토그램(안착 지점 근사): ${JSON.stringify(drawReport.lastDivergenceDepthHistogram)}`,
  );
  console.log(
    `  무승부판 불일치율 상위 결정지점(>=5회): ${topDrawMismatches.map((e) => `${e.decisionPointId}=${pct(e.mismatchRate)}(${e.mismatches}/${e.decisions})`).join(', ') || '(none)'}`,
  );

  // --- Probe bank (round 4, sealed separately from rounds 1/2's) ---
  const probes: readonly ProbePosition[] = buildProbeBank(lossReport, records, L2_ANCHOR_ID, {
    maxProbes: MAX_PROBES,
  });
  const probeBankPath = join(rootDir, 'runs', GAME_ID, 'probe-bank-round4.json');
  saveProbeBank(probeBankPath, probes, l2Anchor);
  console.log(`  저장: ${probeBankPath} (probes=${probes.length}, round1/round2 probe bank 보존)`);

  const l2SelfScore: ProbeScore = scoreAgainstProbes(adapter, opusBot, probes, BOT_SEED_BASE.probeScoreL2);
  const v7ProbeScore: ProbeScore = scoreAgainstProbes(adapter, v7Bot, probes, BOT_SEED_BASE.probeScoreV7);
  console.log(
    `  프로브 검증: L2 자기일치율=${pct(l2SelfScore.agreementRate)} (probes=${l2SelfScore.probes}, skipped=${l2SelfScore.skipped}) — 1.0 기대`,
  );
  console.log(
    `  프로브 검증: v7 합성봇 일치율=${pct(v7ProbeScore.agreementRate)} (probes=${v7ProbeScore.probes}, skipped=${v7ProbeScore.skipped})`,
  );

  // --- Measurement 2: v7 vs L1, win rate only (gradient tracking) ---
  const t2 = Date.now();
  console.log(`  측정 2) v7 합성봇 vs L1(mid) N=${N_M2} seedBase=${SEED_BASE_M2} …`);
  const m2 = runHeadToHead(adapter, v7Bot, midBot, seeds(SEED_BASE_M2, N_M2), BOT_SEED_BASE.m2);
  const t3 = Date.now();
  console.log(
    `     winRate=${pct(m2.candidateWinRate)} CI=${ci(m2)} draw/split=${pct(m2.drawRate)} blocks=${m2.blocks} (${((t3 - t2) / 1000).toFixed(1)}s)`,
  );

  const gradientRestored = m2.candidateWinRate > 0;
  console.log(
    `  그래디언트 추적: v7 vs L1 winRate=${pct(m2.candidateWinRate)} (2회전 확증치는 93.8%) -> ${gradientRestored ? 'PASS(0%가 아님)' : 'FAIL(0%로 회귀)'}`,
  );

  const totalSeconds = (t3 - t0) / 1000;
  console.log(`  총 소요: ${totalSeconds.toFixed(1)}s`);

  const summaryPath = join(outDir, 'judgment-summary.json');
  const summary = {
    gameId: GAME_ID,
    round: 4,
    generatedAt: new Date().toISOString(),
    registry: {
      latestVersion: resolved.registryLatestVersion,
      declaredFlags: resolved.registryLatestFlags,
      composedFlags: resolved.flags,
      note: 'composeBot의 base 무시 규칙상 실질 지배 플래그는 composedFlags 배열의 마지막 MCTS 계열 항목뿐(round2 재채굴 최초 규명).',
    },
    measurement1_v7VsL2: {
      seedBase: SEED_BASE_M1,
      n: N_M1,
      botSeedBase: BOT_SEED_BASE.m1,
      result: m1,
      trajectoriesRecorded: records.length,
      trajectoriesPath,
    },
    lossReport: {
      path: lossReportPath,
      totalGames: lossReport.totalGames,
      candidateLosses: lossReport.candidateLosses,
      divergenceCount: lossReport.divergences.length,
      firstDivergenceDepthHistogram: lossReport.firstDivergenceDepthHistogram,
      topMismatchDecisionPoints: topLossMismatches,
    },
    drawReport: {
      path: drawReportPath,
      totalGames: drawReport.totalGames,
      drawGames: drawReport.drawGames,
      divergenceCount: drawReport.divergences.length,
      gameLengthHistogram: drawReport.gameLengthHistogram,
      firstDivergenceDepthHistogram: drawReport.firstDivergenceDepthHistogram,
      lastDivergenceDepthHistogram: drawReport.lastDivergenceDepthHistogram,
      topMismatchDecisionPoints: topDrawMismatches,
    },
    probeBank: {
      path: probeBankPath,
      probeCount: probes.length,
      l2SelfAgreementRate: l2SelfScore.agreementRate,
      v7AgreementRate: v7ProbeScore.agreementRate,
    },
    measurement2_v7VsL1: {
      seedBase: SEED_BASE_M2,
      n: N_M2,
      botSeedBase: BOT_SEED_BASE.m2,
      result: m2,
      gradientRestored,
    },
    elapsedSeconds: totalSeconds,
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`  저장: ${summaryPath}`);
}

main();
