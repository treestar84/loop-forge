/**
 * gomoku-loss-mining — GAP-11 Phase 1-E judgment experiment: proves the loss
 * infrastructure (D4: loop/loss-mining.ts, loop/probe-bank.ts,
 * artifacts/trajectory-archive.ts) and the anchor ladder (D3:
 * 'external-mid-l1'/'external-opus-l2', gomoku-anchor-ladder.ts) actually
 * work end to end on a real losing candidate, using gomoku as the concrete
 * case (registry v5, 100% loss vs Opus per docs/GAP-ANALYSIS-11.md §0).
 *
 * Steps:
 *   1. Record N=100 fresh-seed games of registry v5's composed bot vs L2
 *      (external-opus-l2 = gomokuOpusBot) via runHeadToHead's
 *      trajectoryCollector, save the full trajectory archive.
 *   2. Mine every lost game for the first ply where v5 diverges from what L2
 *      would have played (mineLosses) — surfaces where the gradient
 *      actually breaks down, not just that it's 100%.
 *   3. Promote the divergences into a sealed, reusable probe bank
 *      (buildProbeBank/saveProbeBank), and sanity-check the bank two ways:
 *      L2's self-agreement (must be 1.0, deterministic replay/self-
 *      consistency) and v5's own agreement rate against it.
 *   4. Re-run v5 vs L1 (external-mid-l1 = gomokuMidBot) over a second,
 *      disjoint N=100 seed block to confirm v5 is not simply beaten by
 *      *everything* external — if the L1 matchup is also ~0%, the loss
 *      signal is uninformative (GAP-11 §1 R1-b's "무정보 손실 함수" failure
 *      mode); a non-zero win rate against L1 is this task's "gradient
 *      restored" success criterion.
 *
 * v5's composed adapter/flag-resolution logic (withStrategyFlags extension,
 * resolveLoopForgeFlags fallback) is copied verbatim from
 * gomoku-benchmark-v5.ts's precedent — composing registry v5's flags on the
 * *bare* gomokuAdapter throws "unknown strategy flag" for the dynamic MCTS
 * flags (mcts2-s256-cr, mcts2-s512-cr, etc.) unless the adapter's
 * strategySurface is extended with the matching flag specs first.
 *
 * Seeds: fresh ranges, verified non-overlapping with every existing gomoku
 * runner's seed base (gomoku-benchmark.ts 50,000-51,999; -v4 70,000-70,699;
 * -v4-full 80,000-80,699; -v5 90,000-91,299; gomoku-anchor-ladder.ts
 * 990,000/991,000/996,000/997,000) and with gomoku.ts's internal wave banks
 * (1-999, 1,000-2,029, 8,000-10,014, 20,000-23,039, 60,000-63,039,
 * 70,000-73,039, identitySeeds 700,000-700,099) — this file uses 300,000+
 * (measurement 1) and 301,000+ (measurement 2), both clear of all of the
 * above. Bot-seed bases (975,1xx-975,3xx range) are likewise distinct from
 * every existing runner's bot-seed bases.
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

const GAME_ID = 'gomoku';
const ADOPTED_VERDICT = 'adopted';
const L2_ANCHOR_ID = 'external-opus-l2';
const L1_ANCHOR_ID = 'external-mid-l1';

const N_M1 = 100;
const N_M2 = 100;
const SEED_BASE_M1 = 300_000;
const SEED_BASE_M2 = 301_000;

/** Distinct per-matchup bot-seed bases (cross-contamination guard, same
 * convention as every other benchmark runner in this directory) — except
 * `probeScoreL2`, which is deliberately equal to `mineLosses`: self-
 * consistency (scoreAgainstProbes reproducing mineLosses's own
 * anchorChoiceKey) requires the identical seed base on both sides, since
 * loss-mining.ts/probe-bank.ts's shared per-decision fork derivation is
 * itself a function of that base (GAP-11 Phase 1-E finding — see both
 * files' doc comments). */
const BOT_SEED_BASE = {
  m1: 975_101,
  m2: 975_102,
  mineLosses: 975_201,
  probeScoreL2: 975_201,
  probeScoreV5: 975_302,
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

/** Same fallback logic as gomoku-benchmark-v5.ts's resolveLoopForgeFlags:
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

function main(): void {
  const rootDir = join(__dirname, '..', '..', '..');
  const bareAdapter = eraseAdapter(gomokuAdapter);
  // Same extension as gomoku-benchmark-v5.ts: registry v5's dynamic MCTS
  // flags are not on the bare adapter's strategySurface, so composeBot would
  // throw "unknown strategy flag" without this.
  const adapter = withStrategyFlags(bareAdapter, [
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_CONFIG, GOMOKU_MCTS_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_HR_CONFIG, GOMOKU_MCTS_HR_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_CONFIG, GOMOKU_MCTS2_S256_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_HR_CONFIG, GOMOKU_MCTS2_S256_HR_FLAG),
    gomokuMcts2S256CrFlagSpec(bareAdapter),
    gomokuMcts2S512CrFlagSpec(bareAdapter),
  ]);

  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const l2Anchor = registry.getAnchor(L2_ANCHOR_ID);
  const l1Anchor = registry.getAnchor(L1_ANCHOR_ID);
  if (!l2Anchor) {
    throw new Error(
      `gomoku-loss-mining: anchor "${L2_ANCHOR_ID}" is not registered — run gomoku-anchor-ladder.ts first (GAP-11 Phase 1-C)`,
    );
  }
  if (!l1Anchor) {
    throw new Error(
      `gomoku-loss-mining: anchor "${L1_ANCHOR_ID}" is not registered — run gomoku-anchor-ladder.ts first (GAP-11 Phase 1-C)`,
    );
  }

  const resolved = resolveLoopForgeFlags(rootDir);
  const v5Bot = composeBot(adapter, resolved.flags);
  const opusBot = gomokuOpusBot;
  const midBot = gomokuMidBot;

  console.log(`=== gomoku loss-mining judgment (GAP-11 Phase 1-E) ===`);
  console.log(
    `  registry latest: ${resolved.registryLatestVersion} flags=[${resolved.registryLatestFlags.join(', ') || '(none)'}]`,
  );
  console.log(`  v5 합성봇 composed flags: [${resolved.flags.join(', ') || '(none)'}]`);

  const outDir = join(rootDir, 'runs', GAME_ID, 'challenge-l2');
  mkdirSync(outDir, { recursive: true });

  // --- Measurement 1: v5 vs L2, full trajectory collection ---
  const t0 = Date.now();
  console.log(`  측정 1) v5 합성봇 vs L2(opus) N=${N_M1} seedBase=${SEED_BASE_M1} …`);
  const records: MatchTrajectoryRecord[] = [];
  const m1 = runHeadToHead(adapter, v5Bot, opusBot, seeds(SEED_BASE_M1, N_M1), BOT_SEED_BASE.m1, {
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
  const v5ProbeScore: ProbeScore = scoreAgainstProbes(adapter, v5Bot, probes, BOT_SEED_BASE.probeScoreV5);
  console.log(
    `  프로브 검증: L2 자기일치율=${pct(l2SelfScore.agreementRate)} (probes=${l2SelfScore.probes}, skipped=${l2SelfScore.skipped}) — 1.0 기대`,
  );
  console.log(
    `  프로브 검증: v5 합성봇 일치율=${pct(v5ProbeScore.agreementRate)} (probes=${v5ProbeScore.probes}, skipped=${v5ProbeScore.skipped})`,
  );

  // --- Measurement 2: v5 vs L1, win rate only ---
  const t2 = Date.now();
  console.log(`  측정 2) v5 합성봇 vs L1(mid) N=${N_M2} seedBase=${SEED_BASE_M2} …`);
  const m2 = runHeadToHead(adapter, v5Bot, midBot, seeds(SEED_BASE_M2, N_M2), BOT_SEED_BASE.m2);
  const t3 = Date.now();
  console.log(
    `     winRate=${pct(m2.candidateWinRate)} CI=${ci(m2)} draw/split=${pct(m2.drawRate)} blocks=${m2.blocks} (${((t3 - t2) / 1000).toFixed(1)}s)`,
  );

  const gradientRestored = m2.candidateWinRate > 0;
  console.log(
    `  그래디언트 복원 판정: v5 vs L1 winRate=${pct(m2.candidateWinRate)} -> ${gradientRestored ? 'PASS(0%가 아님)' : 'FAIL(여전히 0%)'}`,
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
    measurement1_v5VsL2: {
      seedBase: SEED_BASE_M1,
      n: N_M1,
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
      v5AgreementRate: v5ProbeScore.agreementRate,
    },
    measurement2_v5VsL1: {
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
