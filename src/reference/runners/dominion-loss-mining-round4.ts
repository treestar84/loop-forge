/**
 * dominion-loss-mining-round4 — GAP-11 Phase 6 fourth round, first half
 * (main-loop design spec: scratchpad/dominion-round4-design-spec.md §1):
 * re-mine losses against the **current champion, registry v5**
 * (`ismcts-s64-v2buy-prior`, round 3's adoption). Unlike round 3 — which had
 * to mine `chapelEconomyV2` standalone because registry v4's actual composed
 * bot was an L2 clone (a mirror match with nothing to learn) — v5's flag list
 * is a single genuinely-independent design, so this round mines the champion
 * itself, exactly as the spec asks ("v5(현 챔피언) vs L2 트래젝토리 재수집").
 *
 * The champion's flag spec is NOT redefined here: it comes from
 * `shared/dominion-round4-candidates.ts`, shared with
 * dominion-portfolio-round4.ts (which uses the same flag as its regression
 * opponent and lineage baseline). A drifted second copy would mean mining a
 * different bot than the wave regresses against.
 *
 * Two measurements, following dominion-loss-mining-round3.ts's shape:
 *   1) v5 vs L2(opus), N<=100, full trajectory collection -> mineLosses ->
 *      LossReport -> probe bank (sealed separately as probe-bank-round4.json).
 *   2) v5 vs L1(mid), same N, win-rate only (gradient tracking).
 * Both use fresh seeds distinct from portfolio-round3.json's own N=40
 * challenge measurement (735,000-735,039) — an independent remeasurement.
 *
 * Cost note: v5 is a search bot (~2.5s/game at s64 per
 * shared/dominion-ismcts-flag.ts's throughput measurement), roughly two orders
 * of magnitude more expensive per game than round 3's heuristic mining target.
 * The `decideSampleSize` trial below (round 3's own mechanism, unchanged) is
 * what keeps this inside the 30-minute-per-measurement budget; N is reported
 * honestly in the summary whenever it lands below the N=100 target.
 *
 * Fresh seed ranges (verified non-overlapping with every prior dominion
 * runner's documented range — 400/401k, 420/421k, 429-431k, 700/710/715/720/
 * 725/726/727k, 730/735/736/737k, and the anchor ladder's 992k/993k): this
 * file uses 440,000+ (measurement 1), 441,000+ (measurement 2), trial games at
 * 439,000+. Bot-seed bases: a fresh 994_1xx/994_2xx/994_3xx block, distinct
 * from every prior dominion base (982_1xx, 985_1xx, 986_1xx-986_3xx,
 * 987_1xx-987_3xx, 988_1xx-988_3xx, 989_1xx-989_7xx, 990_1xx-990_3xx,
 * 991_1xx-991_7xx).
 *
 * Probe bank: round1/2/3 banks are left untouched — this round's newly-mined
 * divergences are sealed into runs/dominion/probe-bank-round4.json. probeId is
 * `${gameSeed}-${decisionIndex}`, so the disjoint seed range already
 * guarantees no probeId collides with an earlier bank.
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
import { mineLosses, type LossReport } from '../../loop/loss-mining';
import { buildProbeBank, scoreAgainstProbes, type ProbePosition, type ProbeScore } from '../../loop/probe-bank';
import type { MatchTrajectoryRecord } from '../../loop/paired-match';
import { loadOrCreateRegistry } from '../../artifacts/game-state';
import { saveTrajectories, saveProbeBank } from '../../artifacts/trajectory-archive';
import { dominionAdapter } from '../dominion';
import { dominionOpusBot } from '../experiments/dominion-opus-bot';
import { dominionMidBot } from '../experiments/dominion-mid-bot';
import {
  DOMINION_V5_CHAMPION_FLAG,
  dominionIsmctsV2BuyPriorFlagSpec,
} from './shared/dominion-round4-candidates';

const GAME_ID = 'dominion';
const CANDIDATE_FLAG = DOMINION_V5_CHAMPION_FLAG;
const L2_ANCHOR_ID = 'external-opus-l2';
const L1_ANCHOR_ID = 'external-mid-l1';

const N_TRIAL = 3;
const N_TARGET = 100;
const N_MIN = 40;
const BUDGET_MS = 30 * 60 * 1000;

const SEED_BASE_TRIAL = 439_000;
const SEED_BASE_M1 = 440_000;
const SEED_BASE_M2 = 441_000;

const BOT_SEED_BASE = {
  m1: 994_101,
  m2: 994_102,
  mineLosses: 994_201,
  probeScoreL2: 994_201,
  probeScoreCandidate: 994_302,
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
 * dominion-loss-mining-round3.ts. */
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

function decideSampleSize(
  adapter: ReturnType<typeof eraseAdapter>,
  candidateBot: ReturnType<typeof composeBot>,
  opusBot: typeof dominionOpusBot,
): { n: number; msPerGame: number; trialElapsedMs: number } {
  const t0 = Date.now();
  const trial = runHeadToHead(adapter, candidateBot, opusBot, seeds(SEED_BASE_TRIAL, N_TRIAL), BOT_SEED_BASE.m1);
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
  const bareAdapter = eraseAdapter(dominionAdapter);
  const adapter = withStrategyFlags(bareAdapter, [dominionIsmctsV2BuyPriorFlagSpec(bareAdapter)]);

  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const l2Anchor = registry.getAnchor(L2_ANCHOR_ID);
  const l1Anchor = registry.getAnchor(L1_ANCHOR_ID);
  if (!l2Anchor) {
    throw new Error(
      `dominion-loss-mining-round4: anchor "${L2_ANCHOR_ID}" is not registered — run dominion-anchor-ladder.ts first`,
    );
  }
  if (!l1Anchor) {
    throw new Error(
      `dominion-loss-mining-round4: anchor "${L1_ANCHOR_ID}" is not registered — run dominion-anchor-ladder.ts first`,
    );
  }

  const latest = registry.latest();
  console.log(`=== dominion loss-mining round 4 (GAP-11 Phase 6) ===`);
  console.log(
    `  registry latest: ${latest?.version ?? '(none)'} flags=[${latest?.flags.join(', ') ?? ''}] — ` +
      `이번 라운드 채굴 대상은 이 챔피언 자신('${CANDIDATE_FLAG}', 단일 독립 설계이므로 3회전과 달리 거울 대국 문제 없음).`,
  );
  if (latest?.version !== 'v5') {
    throw new Error(
      `dominion-loss-mining-round4: registry latest=${latest?.version ?? '(none)'} — expected v5 (run dominion-portfolio-round3.ts's promotion first)`,
    );
  }
  const candidateBot = composeBot(adapter, [CANDIDATE_FLAG]);
  const opusBot = dominionOpusBot;
  const midBot = dominionMidBot;

  const outDir = join(rootDir, 'runs', GAME_ID, 'challenge-l2-round4');
  mkdirSync(outDir, { recursive: true });

  console.log(`  사전 타이밍: ${CANDIDATE_FLAG} vs L2 ${N_TRIAL}판 시험 …`);
  const sizing = decideSampleSize(adapter, candidateBot, opusBot);
  const n = sizing.n;
  console.log(
    `     ms/game=${sizing.msPerGame.toFixed(0)} (trial ${N_TRIAL}판 ${(sizing.trialElapsedMs / 1000).toFixed(1)}s) -> N=${n}` +
      (n < N_TARGET ? ` (budget 축소, 목표 ${N_TARGET}에서 하향)` : ''),
  );

  // --- Measurement 1: v5 vs L2, full trajectory collection ---
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

  const report = mineLosses(adapter, records, opusBot, { anchorSeedBase: BOT_SEED_BASE.mineLosses });
  const lossReportPath = join(outDir, 'loss-report.json');
  writeFileSync(lossReportPath, JSON.stringify(report, null, 2));
  console.log(`  저장: ${lossReportPath}`);

  const topMismatches = topMismatchDecisionPoints(report, 5);
  console.log(`  LossReport: totalGames=${report.totalGames} candidateLosses=${report.candidateLosses} divergences=${report.divergences.length}`);
  console.log(`  첫 분기 깊이 히스토그램: ${JSON.stringify(report.firstDivergenceDepthHistogram)}`);
  console.log(`  불일치율 상위 결정지점(>=5회): ${topMismatches.map((e) => `${e.decisionPointId}=${pct(e.mismatchRate)}(${e.mismatches}/${e.decisions})`).join(', ') || '(none)'}`);

  // --- Probe bank (round 4, sealed separately from round 1/2/3's) ---
  const probes: readonly ProbePosition[] = buildProbeBank(report, records, L2_ANCHOR_ID, { maxProbes: MAX_PROBES });
  const probeBankPath = join(rootDir, 'runs', GAME_ID, 'probe-bank-round4.json');
  saveProbeBank(probeBankPath, probes, l2Anchor);
  console.log(`  저장: ${probeBankPath} (probes=${probes.length}, round1/2/3 probe-bank는 보존)`);

  const l2SelfScore: ProbeScore = scoreAgainstProbes(adapter, opusBot, probes, BOT_SEED_BASE.probeScoreL2);
  const candidateProbeScore: ProbeScore = scoreAgainstProbes(adapter, candidateBot, probes, BOT_SEED_BASE.probeScoreCandidate);
  console.log(
    `  프로브 검증: L2 자기일치율=${pct(l2SelfScore.agreementRate)} (probes=${l2SelfScore.probes}, skipped=${l2SelfScore.skipped}) — 1.0 기대`,
  );
  console.log(
    `  프로브 검증: ${CANDIDATE_FLAG} 일치율=${pct(candidateProbeScore.agreementRate)} (probes=${candidateProbeScore.probes}, skipped=${candidateProbeScore.skipped})`,
  );

  // --- Measurement 2: v5 vs L1, win rate only (gradient tracking) ---
  const t2 = Date.now();
  console.log(`  측정 2) ${CANDIDATE_FLAG} vs L1(mid) N=${n} seedBase=${SEED_BASE_M2} …`);
  const m2 = runHeadToHead(adapter, candidateBot, midBot, seeds(SEED_BASE_M2, n), BOT_SEED_BASE.m2);
  const t3 = Date.now();
  console.log(
    `     winRate=${pct(m2.candidateWinRate)} CI=${ci(m2)} draw/split=${pct(m2.drawRate)} blocks=${m2.blocks} (${((t3 - t2) / 1000).toFixed(1)}s)`,
  );

  const gradientRestored = m2.candidateWinRate > 0;
  console.log(
    `  그래디언트 추적: ${CANDIDATE_FLAG} vs L1 winRate=${pct(m2.candidateWinRate)} (3회전 포트폴리오 N=40 challenge는 L1=50.6%) -> ${gradientRestored ? 'PASS(0%가 아님)' : 'FAIL(0%로 회귀)'}`,
  );

  const totalSeconds = (t3 - t0) / 1000;
  console.log(`  총 소요: ${totalSeconds.toFixed(1)}s`);

  const summaryPath = join(outDir, 'judgment-summary.json');
  const summary = {
    gameId: GAME_ID,
    round: 4,
    generatedAt: new Date().toISOString(),
    candidate: {
      flag: CANDIDATE_FLAG,
      note:
        '이번 라운드 채굴 대상은 registry v5 챔피언 자신(ismcts-s64-v2buy-prior, 3회전 승격). ' +
        'v4와 달리 v5의 flags는 단일 독립 설계(클론 아님)라 자기 자신을 채굴해도 거울 대국이 되지 않는다.',
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
