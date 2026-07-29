/**
 * dominion-loss-mining — GAP-11 Phase 3-C first half (docs/GAP-ANALYSIS-11.md
 * §5 Phase 3 step 3): ports gomoku's judgment-experiment infrastructure
 * (gomoku-loss-mining.ts, GAP-11 Phase 1-E) to dominion so the design brief
 * for dominion's A8 (domain strategy redesign, still "미시도" per §3 D6) has
 * real LossReport evidence instead of only the ismcts near-miss history.
 *
 * Unlike gomoku's v5, dominion registry v2's flags are `['rushProvinces']` —
 * a *static* strategy flag already declared on dominionAdapter's bare
 * strategySurface (src/reference/dominion.ts, `rushProvinces` spec) — so no
 * withStrategyFlags extension is needed; composeBot(eraseAdapter(dominionAdapter),
 * ['rushProvinces']) works directly.
 *
 * Steps (identical shape to gomoku-loss-mining.ts):
 *   1. Record N=100 fresh-seed games of registry v2's composed bot vs L2
 *      (external-opus-l2 = dominionOpusBot) via runHeadToHead's
 *      trajectoryCollector, save the full trajectory archive.
 *   2. Mine every lost game for the first decision where v2 diverges from
 *      what L2 would have played (mineLosses).
 *   3. Promote divergences into a sealed probe bank (buildProbeBank/
 *      saveProbeBank), sanity-checked via L2's self-agreement (must be 1.0).
 *   4. Re-run v2 vs L1 (external-mid-l1 = dominionMidBot) over a second,
 *      disjoint N=100 seed block to confirm the loss signal is not
 *      uninformative (GAP-11 §1 R1-b) — a non-zero L1 win rate is the
 *      "gradient restored" criterion.
 *
 * Seeds: dominion's used ranges are dominion-runner-{smoke,prune,holdout}
 * (1-90, 1000-1029, 2000-2029), the four ismcts waves (30000-33019,
 * 40000-43019, 50000-53019, 60000-63019 — dominion.ts's own doc comments),
 * dominion-benchmark.ts (50,000-51,999, i.e. overlapping ismcts-wave-3's
 * range per that file's pre-existing comment — not this file's concern),
 * and dominion-anchor-ladder.ts (992,000+/993,000+/998,000+/999,000+). This
 * file uses 400,000+ (measurement 1) and 401,000+ (measurement 2), both
 * clear of every range above. Bot-seed bases use a fresh 986_1xx block,
 * distinct from dominion-anchor-ladder.ts's 982_1xx/985_1xx and
 * dominion-benchmark.ts's 71/72/73_0xx bases.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-exempt,
 * may wire every layer, may call Date.now()) per
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
import { loadOrCreateLedger, loadOrCreateRegistry } from '../../artifacts/game-state';
import { saveTrajectories, saveProbeBank } from '../../artifacts/trajectory-archive';
import { dominionAdapter } from '../dominion';
import { dominionOpusBot } from '../experiments/dominion-opus-bot';
import { dominionMidBot } from '../experiments/dominion-mid-bot';

const GAME_ID = 'dominion';
const ADOPTED_VERDICT = 'adopted';
const L2_ANCHOR_ID = 'external-opus-l2';
const L1_ANCHOR_ID = 'external-mid-l1';

/** GAP-11 Phase 3-C resource rule: dominion games run up to 800 decisions, so
 * N=100 may exceed the ~30 minute budget. main() times a 5-game trial first
 * and shrinks N (never below 60) if the extrapolated cost is too high,
 * logging the decision either way instead of silently guessing. */
const N_TRIAL = 5;
const N_TARGET = 100;
const N_MIN = 60;
const BUDGET_MS = 30 * 60 * 1000;

const SEED_BASE_M1 = 400_000;
const SEED_BASE_M2 = 401_000;

/** Distinct per-matchup bot-seed bases, same convention as every other
 * benchmark runner in this directory — except `probeScoreL2`, which is
 * deliberately equal to `mineLosses` for the same self-consistency reason
 * documented in gomoku-loss-mining.ts (scoreAgainstProbes reproducing
 * mineLosses's own anchorChoiceKey requires the identical seed base). */
const BOT_SEED_BASE = {
  m1: 986_101,
  m2: 986_102,
  mineLosses: 986_201,
  probeScoreL2: 986_201,
  probeScoreV2: 986_302,
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

/** Same fallback logic as dominion-benchmark.ts's resolveLoopForgeFlags:
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
 * accounting for measurement 1 + measurement 2 both running at that N. */
function decideSampleSize(
  adapter: ReturnType<typeof eraseAdapter>,
  v2Bot: ReturnType<typeof composeBot>,
  opusBot: typeof dominionOpusBot,
): { n: number; msPerGame: number; trialElapsedMs: number } {
  const t0 = Date.now();
  const trial = runHeadToHead(adapter, v2Bot, opusBot, seeds(SEED_BASE_M1 - 1000, N_TRIAL), BOT_SEED_BASE.m1);
  const trialElapsedMs = Date.now() - t0;
  const games = trial.blocks * 2;
  const msPerGame = games > 0 ? trialElapsedMs / games : Infinity;

  // Both measurements run at N games each => 2N games total for the win-rate
  // pair, plus loss-mining/probe-bank re-decision passes over already-played
  // trajectories (cheap: no new games). Budget the 2N games generously.
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
      `dominion-loss-mining: anchor "${L2_ANCHOR_ID}" is not registered — run dominion-anchor-ladder.ts first (GAP-11 Phase 1-C)`,
    );
  }
  if (!l1Anchor) {
    throw new Error(
      `dominion-loss-mining: anchor "${L1_ANCHOR_ID}" is not registered — run dominion-anchor-ladder.ts first (GAP-11 Phase 1-C)`,
    );
  }

  const resolved = resolveLoopForgeFlags(rootDir);
  const v2Bot = composeBot(adapter, resolved.flags);
  const opusBot = dominionOpusBot;
  const midBot = dominionMidBot;

  console.log(`=== dominion loss-mining (GAP-11 Phase 3-C) ===`);
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

  const topMismatches = topMismatchDecisionPoints(report, 3);
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
