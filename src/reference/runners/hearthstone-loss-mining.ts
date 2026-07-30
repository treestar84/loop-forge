/**
 * hearthstone-loss-mining — GAP-11 프로토콜 v2 1회전 전반부(채굴, 도미니언·
 * 오목 1회전과 동일한 패턴, docs/GAP-ANALYSIS-11.md §5 Phase 1-E/3 step 3
 * 선례): 하스스톤 registry v2(ismcts-s128-hr)의 합성봇을 L2(외부 Opus봇)
 * 상대로 N판 실측해 trajectory를 기록하고, mineLosses로 LossReport를 뽑고,
 * 그 분기점을 프로브 은행으로 봉인한 뒤 L1(중수) 상대로 그래디언트 복원을
 * 재확인한다.
 *
 * withStrategyFlags 함정(오목 v5/도미니언 v2와 동일 클래스): registry v2의
 * 플래그 `ismcts-s128-hr`는 하스스톤 어댑터의 정적 strategySurface에 없는
 * 동적 플래그(shared/hearthstone-ismcts-flag.ts, hearthstone-benchmark.ts
 * v2가 이미 겪은 문제) — composeBot을 bare 어댑터에 바로 걸면 "unknown
 * strategy flag"로 던진다. hearthstone-benchmark.ts v2와 동일하게
 * withStrategyFlags(bareAdapter, [hearthstoneIsmctsFlagSpec(bareAdapter)])로
 * 확장한 뒤에만 composeBot을 호출한다.
 *
 * 자원 규칙(도미니언 loss-mining 선례 재사용): IS-MCTS(s128) 포함이라 판당
 * 비용이 순정 heuristic보다 훨씬 크므로, N_TRIAL=5판을 먼저 재고 예상 소요가
 * 30분 예산을 넘으면 N을 N_MIN=60까지 낮춘다(사용자 지시).
 *
 * 시드: 하스스톤이 이미 쓰는 범위 — 내부 웨이브(문서화된 1-999대), 3열
 * 벤치마크(SEED_BASE=55,000, N<=1,600 → 55,000-56,599), anchor-ladder.ts의
 * L1/L2 게이트(994,000+/995,000+)와 L3 게이트(1,000,000+/1,001,000+) — 와
 * 겹치지 않는 500,000+(측정1)/501,000+(측정2)를 쓴다. 봇 시드 베이스는
 * anchor-ladder.ts의 983_1xx/986_1xx, benchmark.ts의 950_10x와 겹치지 않는
 * 신규 987_1xx 블록.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-exempt,
 * may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { mineLosses, type LossReport } from '../../loop/loss-mining';
import { buildProbeBank, scoreAgainstProbes, type ProbePosition, type ProbeScore } from '../../loop/probe-bank';
import type { MatchTrajectoryRecord } from '../../loop/paired-match';
import { loadOrCreateLedger, loadOrCreateRegistry } from '../../artifacts/game-state';
import { saveTrajectories, saveProbeBank } from '../../artifacts/trajectory-archive';
import { hearthstoneAdapter } from '../hearthstone';
import { hearthstoneOpusBot } from '../experiments/hearthstone-opus-bot';
import { hearthstoneMidBot } from '../experiments/hearthstone-mid-bot';
import { hearthstoneIsmctsFlagSpec } from './shared/hearthstone-ismcts-flag';

const GAME_ID = 'hearthstone';
const ADOPTED_VERDICT = 'adopted';
const L2_ANCHOR_ID = 'external-opus-l2';
const L1_ANCHOR_ID = 'external-mid-l1';

const N_TRIAL = 5;
const N_TARGET = 100;
const N_MIN = 60;
const BUDGET_MS = 30 * 60 * 1000;

const SEED_BASE_M1 = 500_000;
const SEED_BASE_M2 = 501_000;

/** Distinct per-matchup bot-seed bases, same convention as gomoku/dominion
 * loss-mining precedent — except `probeScoreL2`, deliberately equal to
 * `mineLosses` for self-consistency (scoreAgainstProbes reproducing
 * mineLosses's own anchorChoiceKey requires the identical seed base). */
const BOT_SEED_BASE = {
  m1: 987_101,
  m2: 987_102,
  mineLosses: 987_201,
  probeScoreL2: 987_201,
  probeScoreV2: 987_302,
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

/** Same fallback logic as hearthstone-benchmark.ts's resolveLoopForgeFlags:
 * prefer registry.latest() flags, fall back to ledger-adopted flags. */
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
  report: LossReport,
  topN: number,
): Array<{ decisionPointId: string; decisions: number; mismatches: number; mismatchRate: number }> {
  return Object.entries(report.mismatchRateByDecisionPoint)
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

/** Times an N_TRIAL-game v2-vs-L2 sample and picks the largest N in
 * [N_MIN, N_TARGET] whose extrapolated wall-clock stays under BUDGET_MS,
 * accounting for measurement 1 + measurement 2 both running at that N
 * (dominion-loss-mining.ts's precedent, reused verbatim per task brief). */
function decideSampleSize(
  adapter: ReturnType<typeof eraseAdapter>,
  v2Bot: ReturnType<typeof composeBot>,
  opusBot: typeof hearthstoneOpusBot,
): { n: number; msPerGame: number; trialElapsedMs: number } {
  const t0 = Date.now();
  const trial = runHeadToHead(adapter, v2Bot, opusBot, seeds(SEED_BASE_M1 - 1000, N_TRIAL), BOT_SEED_BASE.m1);
  const trialElapsedMs = Date.now() - t0;
  const games = trial.blocks * 2;
  const msPerGame = games > 0 ? trialElapsedMs / games : Infinity;

  let n = N_TARGET;
  while (n > N_MIN && msPerGame * 2 * n > BUDGET_MS) {
    n = Math.max(N_MIN, n - 10);
  }
  return { n, msPerGame, trialElapsedMs };
}

function main(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const bareAdapter = eraseAdapter(hearthstoneAdapter);
  // hearthstone-benchmark.ts v2's fix, reused verbatim: registry v2's
  // ismcts-s128-hr flag is dynamic (not on the bare adapter's
  // strategySurface) — extend before composeBot or it throws "unknown
  // strategy flag".
  const adapter = withStrategyFlags(bareAdapter, [hearthstoneIsmctsFlagSpec(bareAdapter)]);

  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const l2Anchor = registry.getAnchor(L2_ANCHOR_ID);
  const l1Anchor = registry.getAnchor(L1_ANCHOR_ID);
  if (!l2Anchor) {
    throw new Error(
      `hearthstone-loss-mining: anchor "${L2_ANCHOR_ID}" is not registered — run hearthstone-anchor-ladder.ts first (GAP-11 Phase 1-C)`,
    );
  }
  if (!l1Anchor) {
    throw new Error(
      `hearthstone-loss-mining: anchor "${L1_ANCHOR_ID}" is not registered — run hearthstone-anchor-ladder.ts first (GAP-11 Phase 1-C)`,
    );
  }

  const resolved = resolveLoopForgeFlags(rootDir);
  const v2Bot = composeBot(adapter, resolved.flags);
  const opusBot = hearthstoneOpusBot;
  const midBot = hearthstoneMidBot;

  console.log(`=== hearthstone loss-mining (GAP-11 프로토콜 v2 1회전) ===`);
  console.log(
    `  registry latest: ${resolved.registryLatestVersion} flags=[${resolved.registryLatestFlags.join(', ') || '(none)'}]`,
  );
  console.log(`  v2 합성봇 composed flags: [${resolved.flags.join(', ') || '(none)'}]`);

  const outDir = join(rootDir, 'runs', GAME_ID, 'challenge-l2');
  mkdirSync(outDir, { recursive: true });

  // --- Resource rule: time a 5-game trial before committing to N=100 ---
  console.log(`  사전 타이밍: v2 vs L2 ${N_TRIAL}판 시험 …`);
  const sizing = decideSampleSize(adapter, v2Bot, opusBot);
  const n = sizing.n;
  console.log(
    `     ms/game=${sizing.msPerGame.toFixed(0)} (trial ${N_TRIAL}판 ${(sizing.trialElapsedMs / 1000).toFixed(1)}s) -> N=${n}` +
      (n < N_TARGET ? ` (budget 축소, 목표 ${N_TARGET}에서 하향)` : ''),
  );

  // --- Measurement 1: v2 vs L2, full trajectory collection ---
  const t0 = Date.now();
  console.log(`  측정 1) v2 합성봇 vs L2(opus) N=${n} seedBase=${SEED_BASE_M1} …`);
  const records: MatchTrajectoryRecord[] = [];
  const m1 = runHeadToHead(adapter, v2Bot, opusBot, seeds(SEED_BASE_M1, n), BOT_SEED_BASE.m1, {
    trajectoryCollector: (record) => records.push(record),
  });
  const t1 = Date.now();
  console.log(
    `     winRate=${pct(m1.candidateWinRate)} CI=${ci(m1)} draw/split=${pct(m1.drawRate)} blocks=${m1.blocks} trajectories=${records.length} (${((t1 - t0) / 1000).toFixed(1)}s)`,
  );

  const trajectoriesPath = saveTrajectories(outDir, records, l2Anchor);
  console.log(`  저장: ${trajectoriesPath}`);

  // --- LossReport ---
  const report = mineLosses(adapter, records, opusBot, { anchorSeedBase: BOT_SEED_BASE.mineLosses });
  const lossReportPath = join(outDir, 'loss-report.json');
  writeFileSync(lossReportPath, JSON.stringify(report, null, 2));
  console.log(`  저장: ${lossReportPath}`);

  const topMismatches = topMismatchDecisionPoints(report, 5);
  console.log(`  LossReport: totalGames=${report.totalGames} candidateLosses=${report.candidateLosses} divergences=${report.divergences.length}`);
  console.log(`  첫 분기 깊이 히스토그램: ${JSON.stringify(report.firstDivergenceDepthHistogram)}`);
  console.log(`  불일치율 상위 결정지점(>=5회): ${topMismatches.map((e) => `${e.decisionPointId}=${pct(e.mismatchRate)}(${e.mismatches}/${e.decisions})`).join(', ') || '(none)'}`);

  // --- Probe bank ---
  const probes: readonly ProbePosition[] = buildProbeBank(report, records, L2_ANCHOR_ID, { maxProbes: MAX_PROBES });
  const probeBankPath = join(rootDir, 'runs', GAME_ID, 'probe-bank.json');
  saveProbeBank(probeBankPath, probes, l2Anchor);
  console.log(`  저장: ${probeBankPath} (probes=${probes.length})`);

  const l2SelfScore: ProbeScore = scoreAgainstProbes(adapter, opusBot, probes, BOT_SEED_BASE.probeScoreL2);
  const v2ProbeScore: ProbeScore = scoreAgainstProbes(adapter, v2Bot, probes, BOT_SEED_BASE.probeScoreV2);
  console.log(
    `  프로브 검증: L2 자기일치율=${pct(l2SelfScore.agreementRate)} (probes=${l2SelfScore.probes}, skipped=${l2SelfScore.skipped}) — 1.0 기대`,
  );
  console.log(
    `  프로브 검증: v2 합성봇 일치율=${pct(v2ProbeScore.agreementRate)} (probes=${v2ProbeScore.probes}, skipped=${v2ProbeScore.skipped})`,
  );

  // --- Measurement 2: v2 vs L1, win rate only ---
  const t2 = Date.now();
  console.log(`  측정 2) v2 합성봇 vs L1(mid) N=${n} seedBase=${SEED_BASE_M2} …`);
  const m2 = runHeadToHead(adapter, v2Bot, midBot, seeds(SEED_BASE_M2, n), BOT_SEED_BASE.m2);
  const t3 = Date.now();
  console.log(
    `     winRate=${pct(m2.candidateWinRate)} CI=${ci(m2)} draw/split=${pct(m2.drawRate)} blocks=${m2.blocks} (${((t3 - t2) / 1000).toFixed(1)}s)`,
  );

  const gradientRestored = m2.candidateWinRate > 0;
  console.log(
    `  그래디언트 복원 판정: v2 vs L1 winRate=${pct(m2.candidateWinRate)} -> ${gradientRestored ? 'PASS(0%가 아님)' : 'FAIL(여전히 0%)'}`,
  );

  const totalSeconds = (t3 - t0) / 1000;
  console.log(`  총 소요: ${totalSeconds.toFixed(1)}s`);

  const summaryPath = join(outDir, 'judgment-summary.json');
  const summary = {
    gameId: GAME_ID,
    generatedAt: new Date().toISOString(),
    registry: {
      latestVersion: resolved.registryLatestVersion,
      composedFlags: resolved.flags,
    },
    sampleSizing: {
      n,
      target: N_TARGET,
      min: N_MIN,
      msPerGameTrial: sizing.msPerGame,
      trialGames: N_TRIAL,
    },
    measurement1_v2VsL2: {
      seedBase: SEED_BASE_M1,
      n,
      botSeedBase: BOT_SEED_BASE.m1,
      result: m1,
      trajectoriesRecorded: records.length,
      trajectoriesPath,
    },
    lossReport: {
      path: lossReportPath,
      totalGames: report.totalGames,
      candidateLosses: report.candidateLosses,
      divergenceCount: report.divergences.length,
      firstDivergenceDepthHistogram: report.firstDivergenceDepthHistogram,
      topMismatchDecisionPoints: topMismatches,
    },
    probeBank: {
      path: probeBankPath,
      probeCount: probes.length,
      l2SelfAgreementRate: l2SelfScore.agreementRate,
      v2AgreementRate: v2ProbeScore.agreementRate,
    },
    measurement2_v2VsL1: {
      seedBase: SEED_BASE_M2,
      n,
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
