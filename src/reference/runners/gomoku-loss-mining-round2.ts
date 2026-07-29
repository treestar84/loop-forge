/**
 * gomoku-loss-mining-round2 — GAP-11 Phase 4-A task 2 (docs/GAP-ANALYSIS-11.md
 * §5.5, following gomoku-loss-mining.ts's round-1 precedent verbatim): re-run
 * the same judgment experiment against registry **v6** (the portfolio-round1
 * winner: `mcts7-s256-opening6-prior-w16`, `mcts5-s256-chain-w16`,
 * `mcts5-s256-chain-w48`, `mcts9-s256-defensive-w16`, appended after the pre-
 * existing static flags — composeBot's "later flag ignores its base entirely"
 * convention means the composed bot resolves to the *last* flag in the list,
 * i.e. `mcts9-s256-defensive-w16` alone, exactly like v5's composed bot
 * resolved to `mcts2-s512-cr` alone in round 1).
 *
 * v6's 4 promoted flags are dynamic StrategyFlagSpecs originally defined in
 * gomoku-portfolio-round1.ts, extracted to
 * ./shared/gomoku-round1-candidates.ts's `buildCandidates` (GAP-11 Phase
 * 4-A, behavior-preserving move — see that module's own doc comment for why
 * importing gomoku-portfolio-round1.ts directly is unsafe: its own `main()`
 * runs unconditionally at module scope) — imported and reused verbatim here
 * rather than re-derived by hand, so this round's composed bot is
 * guaranteed identical to what portfolio-round1.ts actually
 * measured/promoted.
 *
 * Seeds: fresh, disjoint from every range gomoku-loss-mining.ts's own doc
 * comment lists (up to 301,000-301,099) and from gomoku-portfolio-round1.ts's
 * own ranges (520,000-520,004, 521,000+/522,000+/523,000+/524,000+,
 * 525,000-525,039) — this file uses 400,000+ (measurement 1, v6 vs L2) and
 * 401,000+ (measurement 2, v6 vs L1). Bot-seed bases: 976,101/976,102/976,201
 * (mineLosses+probeScoreL2, shared per probe-bank.ts's self-consistency
 * requirement)/976,302 — a distinct range from round 1's 975,1xx-975,3xx.
 *
 * Probe bank: round 1's runs/gomoku/probe-bank.json is left untouched: this
 * round's newly-mined divergences are sealed into a separate
 * runs/gomoku/probe-bank-round2.json (GAP-11 Phase 4-A task instruction) —
 * probeId is `${gameSeed}-${decisionIndex}` (probe-bank.ts), so the disjoint
 * seed range above already guarantees no probeId collides with round 1's
 * bank; keeping the file separate additionally records *which round's*
 * anchor/candidate pair produced each probe (comparabilityKey provenance),
 * since round 1 mined against v5's composed bot and this round mines against
 * v6's.
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

const GAME_ID = 'gomoku';
const ADOPTED_VERDICT = 'adopted';
const L2_ANCHOR_ID = 'external-opus-l2';
const L1_ANCHOR_ID = 'external-mid-l1';

const N_M1 = 100;
const N_M2 = 100;
const SEED_BASE_M1 = 400_000;
const SEED_BASE_M2 = 401_000;

/** Distinct per-matchup bot-seed bases (cross-contamination guard, same
 * convention as gomoku-loss-mining.ts) — `probeScoreL2` is deliberately equal
 * to `mineLosses`'s base (probe-bank.ts's self-consistency requirement). */
const BOT_SEED_BASE = {
  m1: 976_101,
  m2: 976_102,
  mineLosses: 976_201,
  probeScoreL2: 976_201,
  probeScoreV6: 976_302,
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

/** Same fallback logic as gomoku-benchmark-v5.ts's/gomoku-loss-mining.ts's resolveLoopForgeFlags:
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
  // Extend the bare adapter with every dynamic flag registry v6 can name:
  // the 6 pre-existing static MCTS flags (round 1's own extension list) plus
  // portfolio-round1.ts's 4 promoted dynamic flags (opening6-prior-w16,
  // chain-w16/w48, defensive-w16) — reused verbatim via `buildCandidates`
  // (this file's own doc comment).
  const round1Candidates = buildCandidates(bareAdapter);
  const adapter = withStrategyFlags(bareAdapter, [
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_CONFIG, GOMOKU_MCTS_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_HR_CONFIG, GOMOKU_MCTS_HR_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_CONFIG, GOMOKU_MCTS2_S256_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_HR_CONFIG, GOMOKU_MCTS2_S256_HR_FLAG),
    gomokuMcts2S256CrFlagSpec(bareAdapter),
    gomokuMcts2S512CrFlagSpec(bareAdapter),
    ...round1Candidates.map((candidate) => candidate.spec),
  ]);

  const registry = loadOrCreateRegistry(rootDir, GAME_ID);
  const l2Anchor = registry.getAnchor(L2_ANCHOR_ID);
  const l1Anchor = registry.getAnchor(L1_ANCHOR_ID);
  if (!l2Anchor) {
    throw new Error(
      `gomoku-loss-mining-round2: anchor "${L2_ANCHOR_ID}" is not registered — run gomoku-anchor-ladder.ts first`,
    );
  }
  if (!l1Anchor) {
    throw new Error(
      `gomoku-loss-mining-round2: anchor "${L1_ANCHOR_ID}" is not registered — run gomoku-anchor-ladder.ts first`,
    );
  }

  const resolved = resolveLoopForgeFlags(rootDir);
  if (resolved.registryLatestVersion !== 'v6') {
    console.warn(
      `  경고: registry latest=${resolved.registryLatestVersion} (v6 예상과 다름) — 계속 진행하되 결과 해석 시 comparabilityKey 확인 필요`,
    );
  }
  const v6Bot = composeBot(adapter, resolved.flags);
  const opusBot = gomokuOpusBot;
  const midBot = gomokuMidBot;

  console.log(`=== gomoku loss-mining round 2 (GAP-11 Phase 4-A) ===`);
  console.log(
    `  registry latest: ${resolved.registryLatestVersion} flags=[${resolved.registryLatestFlags.join(', ') || '(none)'}]`,
  );
  console.log(`  v6 합성봇 composed flags: [${resolved.flags.join(', ') || '(none)'}]`);

  const outDir = join(rootDir, 'runs', GAME_ID, 'challenge-l2-round2');
  mkdirSync(outDir, { recursive: true });

  // --- Measurement 1: v6 vs L2, full trajectory collection ---
  const t0 = Date.now();
  console.log(`  측정 1) v6 합성봇 vs L2(opus) N=${N_M1} seedBase=${SEED_BASE_M1} …`);
  const records: MatchTrajectoryRecord[] = [];
  const m1 = runHeadToHead(adapter, v6Bot, opusBot, seeds(SEED_BASE_M1, N_M1), BOT_SEED_BASE.m1, {
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

  // --- Probe bank (round 2, sealed separately from round 1's) ---
  const probes: readonly ProbePosition[] = buildProbeBank(report, records, L2_ANCHOR_ID, { maxProbes: MAX_PROBES });
  const probeBankPath = join(rootDir, 'runs', GAME_ID, 'probe-bank-round2.json');
  saveProbeBank(probeBankPath, probes, l2Anchor);
  console.log(`  저장: ${probeBankPath} (probes=${probes.length}, round1 probe-bank.json 보존)`);

  const l2SelfScore: ProbeScore = scoreAgainstProbes(adapter, opusBot, probes, BOT_SEED_BASE.probeScoreL2);
  const v6ProbeScore: ProbeScore = scoreAgainstProbes(adapter, v6Bot, probes, BOT_SEED_BASE.probeScoreV6);
  console.log(
    `  프로브 검증: L2 자기일치율=${pct(l2SelfScore.agreementRate)} (probes=${l2SelfScore.probes}, skipped=${l2SelfScore.skipped}) — 1.0 기대`,
  );
  console.log(
    `  프로브 검증: v6 합성봇 일치율=${pct(v6ProbeScore.agreementRate)} (probes=${v6ProbeScore.probes}, skipped=${v6ProbeScore.skipped})`,
  );

  // --- Measurement 2: v6 vs L1, win rate only (gradient tracking) ---
  const t2 = Date.now();
  console.log(`  측정 2) v6 합성봇 vs L1(mid) N=${N_M2} seedBase=${SEED_BASE_M2} …`);
  const m2 = runHeadToHead(adapter, v6Bot, midBot, seeds(SEED_BASE_M2, N_M2), BOT_SEED_BASE.m2);
  const t3 = Date.now();
  console.log(
    `     winRate=${pct(m2.candidateWinRate)} CI=${ci(m2)} draw/split=${pct(m2.drawRate)} blocks=${m2.blocks} (${((t3 - t2) / 1000).toFixed(1)}s)`,
  );

  const gradientRestored = m2.candidateWinRate > 0;
  console.log(
    `  그래디언트 추적: v6 vs L1 winRate=${pct(m2.candidateWinRate)} (라운드1 defensive 단독 vs L1은 45.0%) -> ${gradientRestored ? 'PASS(0%가 아님)' : 'FAIL(0%로 회귀)'}`,
  );

  const totalSeconds = (t3 - t0) / 1000;
  console.log(`  총 소요: ${totalSeconds.toFixed(1)}s`);

  const summaryPath = join(outDir, 'judgment-summary.json');
  const summary = {
    gameId: GAME_ID,
    round: 2,
    generatedAt: new Date().toISOString(),
    registry: {
      latestVersion: resolved.registryLatestVersion,
      composedFlags: resolved.flags,
    },
    measurement1_v6VsL2: {
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
      v6AgreementRate: v6ProbeScore.agreementRate,
    },
    measurement2_v6VsL1: {
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
