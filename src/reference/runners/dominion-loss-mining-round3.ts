/**
 * dominion-loss-mining-round3 — GAP-11 Phase 4-C third round, first half
 * (team-lead task): re-mine losses against **chapelEconomyV2 standalone**
 * (`composeBot(adapter, ['chapelEconomyV2'])`), NOT registry v4. Registry v4's
 * actual composed bot is `opusCloneDominion` (registry.json's flags list ends
 * with that terminal flag, and composeBot's override semantics — ADR-0014 —
 * mean the last flag in the list fully determines the runtime bot). Mining
 * against v4 would mean mining the L2-clone against itself: a mirror match
 * with nothing to learn. chapelEconomyV2 is round 2's best *independent*
 * design (L2=42.5% standalone, per portfolio-round2.json's own challenge
 * table at N=40) — that is this round's re-mining target per the team-lead's
 * explicit instruction.
 *
 * Two measurements, following dominion-loss-mining-round2.ts's shape:
 *   1) chapelEconomyV2 vs L2(opus), N=100, full trajectory collection ->
 *      mineLosses -> LossReport -> probe bank (sealed separately, round 3).
 *   2) chapelEconomyV2 vs L1(mid), N=100, win-rate only (gradient tracking,
 *      compared against round 2's N=40 measurement of 55.0%).
 * Both use fresh N=100 seeds distinct from portfolio-round2.json's own N=40
 * challenge measurement (725,000-725,039) — an independent remeasurement, not
 * a reuse of the wave's own challenge seeds.
 *
 * Fresh seed ranges (verified non-overlapping with every prior dominion
 * runner's own documented range — see dominion-portfolio-round2.ts's own doc
 * comment for the full list through 727,000-727,099/989_1xx-989_7xx): this
 * file uses 430,000+ (measurement 1, chapelEconomyV2 vs L2), 431,000+
 * (measurement 2, chapelEconomyV2 vs L1), trial games at 429,000+.
 * Bot-seed bases: a fresh 990_1xx/990_2xx/990_3xx block, distinct from every
 * prior dominion base (986_1xx-986_3xx, 988_1xx-988_3xx, 989_1xx-989_7xx).
 *
 * Probe bank: round1 (probe-bank.json) and round2 (probe-bank-round2.json)
 * are left untouched — this round's newly-mined divergences are sealed into a
 * separate runs/dominion/probe-bank-round3.json (team-lead instruction).
 * probeId is `${gameSeed}-${decisionIndex}` (probe-bank.ts), so the disjoint
 * seed range above already guarantees no probeId collides with round 1/2's
 * banks.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { eraseAdapter } from '../../loop/erase';
import { composeBot } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { mineLosses, type LossReport } from '../../loop/loss-mining';
import { buildProbeBank, scoreAgainstProbes, type ProbePosition, type ProbeScore } from '../../loop/probe-bank';
import type { MatchTrajectoryRecord } from '../../loop/paired-match';
import { loadOrCreateRegistry } from '../../artifacts/game-state';
import { saveTrajectories, saveProbeBank } from '../../artifacts/trajectory-archive';
import { dominionAdapter } from '../dominion';
import { dominionOpusBot } from '../experiments/dominion-opus-bot';
import { dominionMidBot } from '../experiments/dominion-mid-bot';

const GAME_ID = 'dominion';
const CANDIDATE_FLAG = 'chapelEconomyV2';
const L2_ANCHOR_ID = 'external-opus-l2';
const L1_ANCHOR_ID = 'external-mid-l1';

/** Resource rule (team-lead instruction): heuristic-class bot, low cost
 * expected, but time a small trial before committing to the full N — same
 * shape as dominion-loss-mining.ts/dominion-loss-mining-round2.ts's own
 * decideSampleSize. */
const N_TRIAL = 5;
const N_TARGET = 100;
const N_MIN = 60;
const BUDGET_MS = 30 * 60 * 1000;

const SEED_BASE_M1 = 430_000;
const SEED_BASE_M2 = 431_000;

const BOT_SEED_BASE = {
  m1: 990_101,
  m2: 990_102,
  mineLosses: 990_201,
  probeScoreL2: 990_201,
  probeScoreCandidate: 990_302,
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

/** Top-N decision points by mismatch rate (min 5 decisions, to avoid noise
 * from decision points seen only once or twice) — same helper as
 * dominion-loss-mining-round2.ts. */
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

/** Times an N_TRIAL-game candidate-vs-L2 sample and picks the largest N in
 * [N_MIN, N_TARGET] whose extrapolated wall-clock stays under BUDGET_MS,
 * accounting for measurement 1 + measurement 2 both running at that N. */
function decideSampleSize(
  adapter: ReturnType<typeof eraseAdapter>,
  candidateBot: ReturnType<typeof composeBot>,
  opusBot: typeof dominionOpusBot,
): { n: number; msPerGame: number; trialElapsedMs: number } {
  const t0 = Date.now();
  const trial = runHeadToHead(adapter, candidateBot, opusBot, seeds(SEED_BASE_M1 - 1000, N_TRIAL), BOT_SEED_BASE.m1);
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
  const adapter = eraseAdapter(dominionAdapter);

  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const l2Anchor = registry.getAnchor(L2_ANCHOR_ID);
  const l1Anchor = registry.getAnchor(L1_ANCHOR_ID);
  if (!l2Anchor) {
    throw new Error(
      `dominion-loss-mining-round3: anchor "${L2_ANCHOR_ID}" is not registered — run dominion-anchor-ladder.ts first`,
    );
  }
  if (!l1Anchor) {
    throw new Error(
      `dominion-loss-mining-round3: anchor "${L1_ANCHOR_ID}" is not registered — run dominion-anchor-ladder.ts first`,
    );
  }

  const latest = registry.latest();
  console.log(`=== dominion loss-mining round 3 (GAP-11 Phase 4-C) ===`);
  console.log(
    `  registry latest: ${latest?.version ?? '(none)'} flags=[${latest?.flags.join(', ') ?? ''}] — ` +
      `참고용으로만 표시, 이번 라운드는 registry를 사용하지 않음(팀리드 지시: v4 재채굴은 무의미 — ` +
      `composeBot 덮어쓰기 시맨틱상 v4 실체는 마지막 플래그 'opusCloneDominion'=L2 클론이라 거울 대국이 됨).`,
  );
  const candidateBot = composeBot(adapter, [CANDIDATE_FLAG]);
  const opusBot = dominionOpusBot;
  const midBot = dominionMidBot;
  console.log(`  재채굴 대상: '${CANDIDATE_FLAG}' 단독(2회전 최고 독립 설계, portfolio-round2.json N=40 챌린지: L2=42.5%, L1=55.0%)`);

  const outDir = join(rootDir, 'runs', GAME_ID, 'challenge-l2-round3');
  mkdirSync(outDir, { recursive: true });

  // --- Resource rule: time a 5-game trial before committing to N=100 ---
  console.log(`  사전 타이밍: ${CANDIDATE_FLAG} vs L2 ${N_TRIAL}판 시험 …`);
  const sizing = decideSampleSize(adapter, candidateBot, opusBot);
  const n = sizing.n;
  console.log(
    `     ms/game=${sizing.msPerGame.toFixed(0)} (trial ${N_TRIAL}판 ${(sizing.trialElapsedMs / 1000).toFixed(1)}s) -> N=${n}` +
      (n < N_TARGET ? ` (budget 축소, 목표 ${N_TARGET}에서 하향)` : ''),
  );

  // --- Measurement 1: chapelEconomyV2 vs L2, full trajectory collection ---
  const t0 = Date.now();
  console.log(`  측정 1) ${CANDIDATE_FLAG} vs L2(opus) N=${n} seedBase=${SEED_BASE_M1} …`);
  const records: MatchTrajectoryRecord[] = [];
  const m1 = runHeadToHead(adapter, candidateBot, opusBot, seeds(SEED_BASE_M1, n), BOT_SEED_BASE.m1, {
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

  // --- Probe bank (round 3, sealed separately from round 1/2's) ---
  const probes: readonly ProbePosition[] = buildProbeBank(report, records, L2_ANCHOR_ID, { maxProbes: MAX_PROBES });
  const probeBankPath = join(rootDir, 'runs', GAME_ID, 'probe-bank-round3.json');
  saveProbeBank(probeBankPath, probes, l2Anchor);
  console.log(`  저장: ${probeBankPath} (probes=${probes.length}, round1/round2 probe-bank는 보존)`);

  const l2SelfScore: ProbeScore = scoreAgainstProbes(adapter, opusBot, probes, BOT_SEED_BASE.probeScoreL2);
  const candidateProbeScore: ProbeScore = scoreAgainstProbes(adapter, candidateBot, probes, BOT_SEED_BASE.probeScoreCandidate);
  console.log(
    `  프로브 검증: L2 자기일치율=${pct(l2SelfScore.agreementRate)} (probes=${l2SelfScore.probes}, skipped=${l2SelfScore.skipped}) — 1.0 기대`,
  );
  console.log(
    `  프로브 검증: ${CANDIDATE_FLAG} 일치율=${pct(candidateProbeScore.agreementRate)} (probes=${candidateProbeScore.probes}, skipped=${candidateProbeScore.skipped})`,
  );

  // --- Measurement 2: chapelEconomyV2 vs L1, win rate only (gradient tracking) ---
  const t2 = Date.now();
  console.log(`  측정 2) ${CANDIDATE_FLAG} vs L1(mid) N=${n} seedBase=${SEED_BASE_M2} …`);
  const m2 = runHeadToHead(adapter, candidateBot, midBot, seeds(SEED_BASE_M2, n), BOT_SEED_BASE.m2);
  const t3 = Date.now();
  console.log(
    `     winRate=${pct(m2.candidateWinRate)} CI=${ci(m2)} draw/split=${pct(m2.drawRate)} blocks=${m2.blocks} (${((t3 - t2) / 1000).toFixed(1)}s)`,
  );

  const gradientRestored = m2.candidateWinRate > 0;
  console.log(
    `  그래디언트 추적: ${CANDIDATE_FLAG} vs L1 winRate=${pct(m2.candidateWinRate)} (2회전 N=40 챌린지는 L1=55.0% — 재현성 확인) -> ${gradientRestored ? 'PASS(0%가 아님)' : 'FAIL(0%로 회귀)'}`,
  );

  const totalSeconds = (t3 - t0) / 1000;
  console.log(`  총 소요: ${totalSeconds.toFixed(1)}s`);

  const summaryPath = join(outDir, 'judgment-summary.json');
  const summary = {
    gameId: GAME_ID,
    round: 3,
    generatedAt: new Date().toISOString(),
    candidate: {
      flag: CANDIDATE_FLAG,
      note:
        "registry v4가 아니라 chapelEconomyV2 단독을 채굴 대상으로 삼음 — v4의 실체는 opusCloneDominion(L2 완전 클론, composeBot 덮어쓰기 시맨틱, ADR-0014)이라 v4를 채굴하면 거울 대국(자기 자신과 대전)이 되어 배울 게 없음. " +
        "chapelEconomyV2는 2회전 최고 독립 설계(portfolio-round2.json N=40 챌린지: L2=42.5% [32.5, 52.5], L1=55.0% [45.0, 65.0]).",
      registryLatestVersionForReference: latest?.version ?? null,
    },
    sampleSizing: {
      n,
      target: N_TARGET,
      min: N_MIN,
      msPerGameTrial: sizing.msPerGame,
      trialGames: N_TRIAL,
    },
    measurement1_candidateVsL2: {
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
      candidateAgreementRate: candidateProbeScore.agreementRate,
    },
    measurement2_candidateVsL1: {
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
