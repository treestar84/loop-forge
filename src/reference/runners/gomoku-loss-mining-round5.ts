/**
 * gomoku-loss-mining-round5 — GAP-11 Phase 4 오목 5회전 전반부(재채굴 + 브리프
 * 입력), following gomoku-loss-mining-round4.ts's precedent verbatim except for
 * this round's own new analysis (아래 "무승부 수렴 확정 시점" 절).
 *
 * 대상: registry **v7** (round4는 어떤 후보도 regression을 못 넘어 승격이 없었다 —
 * 챔피언은 그대로 v7이고, composeBot의 "MCTS 계열 플래그는 base를 완전히 무시"
 * 규칙상 실질 지배 플래그는 배열 마지막 `mcts12-s256-opusclone-w16` 단독).
 *
 * Seeds: fresh, disjoint from every prior gomoku-loss-mining*.ts range
 * (300,000s round1 / 400,000s round2 / 800,000-801,099 round4 / 520,000-553,099
 * portfolio rounds / 70,000-90,699 3-column benchmarks / 700,000-700,099·600,000
 * gomoku.ts's own noise-floor probe / 990,000-997,999 anchor-ladder gates) —
 * this file uses 810,000+ (측정 1, v7 vs L2) and 811,000+ (측정 2, v7 vs L1).
 * Bot-seed bases: 978,101/978,102/978,201/978,302 — distinct from every prior
 * round's 975,1xx-977,3xx.
 *
 * Probe bank: rounds 1/2/4's banks are left untouched — this round's newly
 * mined L2-loss divergences are sealed into a separate
 * runs/gomoku/probe-bank-round5.json, same probeId convention
 * (`${gameSeed}-${decisionIndex}`) so the disjoint seed range above already
 * guarantees no collision.
 *
 * **이번 라운드의 신규 분석 — "무승부 수렴은 몇 수째에 확정되는가"** (설계 브리프
 * scratchpad/gomoku-round5-design-spec.md 1번 지시): round4는 무승부 56판이 전부
 * 220-229수의 보드 소진형이고 마지막 분기가 210-229구간에 몰려 있다는 것까지
 * 밝혔지만, "그래서 어느 시점부터 개입해도 소용없는가"는 답하지 못했다(마지막
 * 분기는 '서로 다르게 뒀다'는 사실일 뿐 '아직 승부가 가능했다'는 증거가 아니다 —
 * 보드가 거의 찬 뒤의 불일치는 아무 의미 없는 빈칸 채우기일 수 있다). 이 라운드는
 * 무승부 판을 그대로 재생(replay)하며 **매 결정 시점에 착수자가 만들 수 있었던
 * 최대 자기 위협 점수**(`gomokuOwnThreatScores`, L2 자신의 연속 위협 함수의 공격
 * 반쪽)를 계산해, 그 값이 마지막으로 `GOMOKU_OPEN_THREE_SCORE`(열린 3 = 응수를
 * 강제하는 최저 등급) 이상이었던 수순을 게임별로 구한다. 그 이후 구간은 "어떤
 * 착수로도 강제 위협을 못 만드는 죽은 꼬리"이므로, **개입 가능한 마지막 분기점의
 * 상한**이 된다. 히스토그램(10수 단위)과 평균 죽은 꼬리 길이를 함께 기록한다.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import type { PlayerId } from '../../contract/types';
import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { mineDraws, mineLosses, type DrawReport, type LossReport } from '../../loop/loss-mining';
import { buildProbeBank, scoreAgainstProbes, type ProbePosition, type ProbeScore } from '../../loop/probe-bank';
import type { MatchTrajectoryRecord } from '../../loop/paired-match';
import { loadOrCreateLedger, loadOrCreateRegistry } from '../../artifacts/game-state';
import { saveTrajectories, saveProbeBank } from '../../artifacts/trajectory-archive';
import { gomokuAdapter, type GomokuMove, type GomokuState } from '../gomoku';
import { gomokuOpusBot } from '../experiments/gomoku-opus-bot';
import { gomokuMidBot } from '../experiments/gomoku-mid-bot';
import { GOMOKU_OPEN_THREE_SCORE, gomokuOwnThreatScores } from '../experiments/gomoku-opus-clone-evaluator';
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
const SEED_BASE_M1 = 810_000;
const SEED_BASE_M2 = 811_000;

const BOT_SEED_BASE = {
  m1: 978_101,
  m2: 978_102,
  mine: 978_201,
  probeScoreL2: 978_201,
  probeScoreV7: 978_302,
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

/** Same fallback logic as gomoku-loss-mining-round4.ts's resolveLoopForgeFlags. */
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

// ---------------------------------------------------------------------
// 무승부 수렴 확정 시점 분석 (이번 라운드의 신규 분석, 파일 doc comment)
// ---------------------------------------------------------------------

function bucket10(depth: number): string {
  const lower = Math.floor(depth / 10) * 10;
  return `${lower}-${lower + 9}`;
}

interface DrawConvergenceReport {
  /** 분석에 쓴 무승부 게임 수. */
  readonly drawGames: number;
  /** 게임별 "마지막으로 열린 3 이상의 강제 위협을 만들 수 있었던 수순"의 10수 단위 히스토그램. */
  readonly lastDecisiveOpportunityHistogram: Readonly<Record<string, number>>;
  /** 그 시점 이후 남은 수(=아무도 강제 위협을 못 만드는 "죽은 꼬리")의 10수 단위 히스토그램. */
  readonly deadTailLengthHistogram: Readonly<Record<string, number>>;
  readonly meanLastDecisiveOpportunityDepth: number;
  readonly meanDeadTailLength: number;
  readonly meanGameLength: number;
  /** 강제 위협 판정 임계(열린 3). */
  readonly threshold: number;
}

/**
 * Replays each draw game move by move (gomokuAdapter's own concrete
 * createInitialState/getLegalChoices/applyChoice — this file is an app
 * boundary) and finds, per game, the last decision index at which the mover
 * could still have created an open-three-or-better threat. See the file doc
 * comment for why this is the upper bound on "개입 가능한 마지막 분기점".
 */
function analyzeDrawConvergence(records: readonly MatchTrajectoryRecord[]): DrawConvergenceReport {
  const lastDecisive: number[] = [];
  const deadTail: number[] = [];
  const gameLengths: number[] = [];
  const lastHistogram: Record<string, number> = {};
  const tailHistogram: Record<string, number> = {};

  for (const record of records) {
    if (record.outcome.winner !== null) {
      continue;
    }
    let state: GomokuState = gomokuAdapter.createInitialState(record.gameSeed);
    let lastDecisiveIndex = -1;
    let index = 0;
    for (const encoded of record.choices) {
      const legal = gomokuAdapter.getLegalChoices(state);
      const chosen = legal.find((move) => gomokuAdapter.encodeChoice(move) === encoded);
      if (chosen === undefined) {
        break; // defensive: unreachable for a well-formed record
      }
      const mover: PlayerId = state.moveCount % 2 === 0 ? 0 : 1;
      const threats = gomokuOwnThreatScores(state, mover, legal as readonly GomokuMove[]);
      let best = 0;
      for (const threat of threats) {
        if (threat > best) best = threat;
      }
      if (best >= GOMOKU_OPEN_THREE_SCORE) {
        lastDecisiveIndex = index;
      }
      state = gomokuAdapter.applyChoice(state, chosen);
      index += 1;
    }

    const length = record.choices.length;
    gameLengths.push(length);
    lastDecisive.push(lastDecisiveIndex);
    const tail = lastDecisiveIndex >= 0 ? length - 1 - lastDecisiveIndex : length;
    deadTail.push(tail);
    lastHistogram[bucket10(Math.max(lastDecisiveIndex, 0))] = (lastHistogram[bucket10(Math.max(lastDecisiveIndex, 0))] ?? 0) + 1;
    tailHistogram[bucket10(tail)] = (tailHistogram[bucket10(tail)] ?? 0) + 1;
  }

  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    drawGames: lastDecisive.length,
    lastDecisiveOpportunityHistogram: lastHistogram,
    deadTailLengthHistogram: tailHistogram,
    meanLastDecisiveOpportunityDepth: mean(lastDecisive),
    meanDeadTailLength: mean(deadTail),
    meanGameLength: mean(gameLengths),
    threshold: GOMOKU_OPEN_THREE_SCORE,
  };
}

function main(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const bareAdapter = eraseAdapter(gomokuAdapter);
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
      `gomoku-loss-mining-round5: anchor "${L2_ANCHOR_ID}" is not registered — run gomoku-anchor-ladder.ts first`,
    );
  }
  if (!l1Anchor) {
    throw new Error(
      `gomoku-loss-mining-round5: anchor "${L1_ANCHOR_ID}" is not registered — run gomoku-anchor-ladder.ts first`,
    );
  }

  const resolved = resolveLoopForgeFlags(rootDir);
  if (resolved.registryLatestVersion !== EXPECTED_REGISTRY_VERSION) {
    console.warn(
      `  경고: registry latest=${resolved.registryLatestVersion} (${EXPECTED_REGISTRY_VERSION} 예상과 다름) — 계속 진행하되 결과 해석 시 comparabilityKey 확인 필요`,
    );
  }
  const v7Bot = composeBot(adapter, resolved.flags);

  console.log(`=== gomoku loss-mining round 5 (GAP-11 Phase 4) ===`);
  console.log(
    `  registry latest: ${resolved.registryLatestVersion} flags(선언)=[${resolved.registryLatestFlags.join(', ') || '(none)'}]`,
  );
  console.log(`  v7 합성봇 composedFlags: [${resolved.flags.join(', ') || '(none)'}] (실질 지배 = 마지막 MCTS 플래그 단독)`);

  const outDir = join(rootDir, 'runs', GAME_ID, 'challenge-l2-round5');
  mkdirSync(outDir, { recursive: true });

  const t0 = Date.now();
  console.log(`  측정 1) v7 합성봇 vs L2(opus) N=${N_M1} seedBase=${SEED_BASE_M1} …`);
  const records: MatchTrajectoryRecord[] = [];
  const m1 = runHeadToHead(adapter, v7Bot, gomokuOpusBot, seeds(SEED_BASE_M1, N_M1), BOT_SEED_BASE.m1, {
    trajectoryCollector: (record) => records.push(record),
  });
  const t1 = Date.now();
  console.log(
    `     winRate=${pct(m1.candidateWinRate)} CI=${ci(m1)} draw/split=${pct(m1.drawRate)} blocks=${m1.blocks} trajectories=${records.length} (${((t1 - t0) / 1000).toFixed(1)}s)`,
  );

  const trajectoriesPath = saveTrajectories(outDir, records, l2Anchor);
  console.log(`  저장: ${trajectoriesPath}`);

  const lossReport: LossReport = mineLosses(adapter, records, gomokuOpusBot, { anchorSeedBase: BOT_SEED_BASE.mine });
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

  const drawReport: DrawReport = mineDraws(adapter, records, gomokuOpusBot, { anchorSeedBase: BOT_SEED_BASE.mine });
  const drawReportPath = join(outDir, 'draw-report.json');
  writeFileSync(drawReportPath, JSON.stringify(drawReport, null, 2));
  console.log(`  저장: ${drawReportPath}`);

  const topDrawMismatches = topMismatchDecisionPoints(drawReport.mismatchRateByDecisionPoint, 3);
  console.log(
    `  DrawReport: totalGames=${drawReport.totalGames} drawGames=${drawReport.drawGames} divergences=${drawReport.divergences.length}`,
  );
  console.log(`  무승부판 길이 히스토그램: ${JSON.stringify(drawReport.gameLengthHistogram)}`);
  console.log(`  무승부판 첫 분기 깊이 히스토그램: ${JSON.stringify(drawReport.firstDivergenceDepthHistogram)}`);
  console.log(`  무승부판 마지막 분기 깊이 히스토그램: ${JSON.stringify(drawReport.lastDivergenceDepthHistogram)}`);
  console.log(
    `  무승부판 불일치율 상위 결정지점(>=5회): ${topDrawMismatches.map((e) => `${e.decisionPointId}=${pct(e.mismatchRate)}(${e.mismatches}/${e.decisions})`).join(', ') || '(none)'}`,
  );

  // --- 이번 라운드 신규: 무승부 수렴 확정 시점 ---
  const drawConvergence = analyzeDrawConvergence(records);
  const drawConvergencePath = join(outDir, 'draw-convergence.json');
  writeFileSync(drawConvergencePath, JSON.stringify(drawConvergence, null, 2));
  console.log(`  저장: ${drawConvergencePath}`);
  console.log(
    `  무승부 수렴 분석: 마지막 강제위협(열린3 이상) 가능 수순 평균=${drawConvergence.meanLastDecisiveOpportunityDepth.toFixed(1)}, ` +
      `죽은 꼬리 평균=${drawConvergence.meanDeadTailLength.toFixed(1)}수, 평균 길이=${drawConvergence.meanGameLength.toFixed(1)}`,
  );
  console.log(`  마지막 강제위협 가능 수순 히스토그램: ${JSON.stringify(drawConvergence.lastDecisiveOpportunityHistogram)}`);
  console.log(`  죽은 꼬리 길이 히스토그램: ${JSON.stringify(drawConvergence.deadTailLengthHistogram)}`);

  const probes: readonly ProbePosition[] = buildProbeBank(lossReport, records, L2_ANCHOR_ID, {
    maxProbes: MAX_PROBES,
  });
  const probeBankPath = join(rootDir, 'runs', GAME_ID, 'probe-bank-round5.json');
  saveProbeBank(probeBankPath, probes, l2Anchor);
  console.log(`  저장: ${probeBankPath} (probes=${probes.length}, round1/2/4 probe bank 보존)`);

  const l2SelfScore: ProbeScore = scoreAgainstProbes(adapter, gomokuOpusBot, probes, BOT_SEED_BASE.probeScoreL2);
  const v7ProbeScore: ProbeScore = scoreAgainstProbes(adapter, v7Bot, probes, BOT_SEED_BASE.probeScoreV7);
  console.log(
    `  프로브 검증: L2 자기일치율=${pct(l2SelfScore.agreementRate)} (probes=${l2SelfScore.probes}, skipped=${l2SelfScore.skipped}) — 1.0 기대`,
  );
  console.log(
    `  프로브 검증: v7 합성봇 일치율=${pct(v7ProbeScore.agreementRate)} (probes=${v7ProbeScore.probes}, skipped=${v7ProbeScore.skipped})`,
  );

  const t2 = Date.now();
  console.log(`  측정 2) v7 합성봇 vs L1(mid) N=${N_M2} seedBase=${SEED_BASE_M2} …`);
  const m2 = runHeadToHead(adapter, v7Bot, gomokuMidBot, seeds(SEED_BASE_M2, N_M2), BOT_SEED_BASE.m2);
  const t3 = Date.now();
  console.log(
    `     winRate=${pct(m2.candidateWinRate)} CI=${ci(m2)} draw/split=${pct(m2.drawRate)} blocks=${m2.blocks} (${((t3 - t2) / 1000).toFixed(1)}s)`,
  );

  const gradientRestored = m2.candidateWinRate > 0;
  const totalSeconds = (t3 - t0) / 1000;
  console.log(`  총 소요: ${totalSeconds.toFixed(1)}s`);

  const summaryPath = join(outDir, 'judgment-summary.json');
  const summary = {
    gameId: GAME_ID,
    round: 5,
    generatedAt: new Date().toISOString(),
    registry: {
      latestVersion: resolved.registryLatestVersion,
      declaredFlags: resolved.registryLatestFlags,
      composedFlags: resolved.flags,
      note: 'composeBot의 base 무시 규칙상 실질 지배 플래그는 composedFlags 배열의 마지막 MCTS 계열 항목뿐.',
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
    drawConvergence: { path: drawConvergencePath, ...drawConvergence },
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
