/**
 * dominion-loss-mining-round2 — GAP-11 Phase 4-C first half (team-lead task,
 * following gomoku-loss-mining-round2.ts's round-2 precedent verbatim): re-run
 * the same judgment experiment against registry **v3** (the portfolio-round1
 * winner: `chapelEconomy-d08`, `chapelEconomy-late3`, `chapelEconomy` appended
 * after v2's static `rushProvinces` — composeBot's "later flag ignores its
 * base entirely" convention means the composed bot resolves to the *last*
 * flag in the list).
 *
 * IMPORTANT composeBot semantic check (per team-lead's explicit instruction):
 * `chapelEconomyFlagSpec.apply()` (../dominion.ts) takes **no** `base`
 * parameter at all (signature `apply()`, not `apply(base)`) — it always
 * starts from a fresh `heuristicBaseline(seed)` fallback and ignores
 * whatever bot the previous flag in the chain produced. So
 * `composeBot(adapter, ['rushProvinces', 'chapelEconomy-d08',
 * 'chapelEconomy-late3', 'chapelEconomy'])` resolves to plain `chapelEconomy`
 * alone — the first three flags (`rushProvinces`, `chapelEconomy-d08`,
 * `chapelEconomy-late3`) are fully overwritten dead weight in this chain.
 * This differs from `chapelEconomy-d08` (a *different*, mechanically-tuned
 * candidate that portfolio-round1.ts's challenge table measured
 * independently at L2=22.5%/L1=33.1%): registry v3's actual composed bot is
 * `chapelEconomy` (plain), whose own portfolio-round1 challenge numbers were
 * L2=17.5%/L1=30.0% — the two must not be conflated when comparing this
 * round's results against "round 1's numbers".
 *
 * Seeds: fresh, disjoint from every range dominion-loss-mining.ts's own doc
 * comment lists (up to 401,000-401,099) and from dominion-portfolio-round1.ts's
 * own ranges (700,000-700,004, 711,000+/712,000+/713,000+/714,000+,
 * 715,000-715,039) — this file uses 420,000+ (measurement 1, v3 vs L2) and
 * 421,000+ (measurement 2, v3 vs L1), trial games at 419,000+ (clear of both).
 * Bot-seed bases: a fresh 988_1xx/988_2xx/988_3xx block, distinct from
 * dominion-loss-mining.ts's 986_1xx and dominion-portfolio-round1.ts's
 * 987_1xx/987_3xx.
 *
 * Probe bank: round 1's runs/dominion/probe-bank.json is left untouched: this
 * round's newly-mined divergences are sealed into a separate
 * runs/dominion/probe-bank-round2.json (team-lead task instruction) —
 * probeId is `${gameSeed}-${decisionIndex}` (probe-bank.ts), so the disjoint
 * seed range above already guarantees no probeId collides with round 1's
 * bank.
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
import { loadOrCreateLedger, loadOrCreateRegistry } from '../../artifacts/game-state';
import { saveTrajectories, saveProbeBank } from '../../artifacts/trajectory-archive';
import { dominionAdapter } from '../dominion';
import { dominionOpusBot } from '../experiments/dominion-opus-bot';
import { dominionMidBot } from '../experiments/dominion-mid-bot';

const GAME_ID = 'dominion';
const ADOPTED_VERDICT = 'adopted';
const L2_ANCHOR_ID = 'external-opus-l2';
const L1_ANCHOR_ID = 'external-mid-l1';

/** Resource rule (team-lead instruction): heuristic-class bot, low cost
 * expected, but time a small trial before committing to the full N — same
 * shape as dominion-loss-mining.ts's own decideSampleSize. */
const N_TRIAL = 5;
const N_TARGET = 100;
const N_MIN = 60;
const BUDGET_MS = 30 * 60 * 1000;

const SEED_BASE_M1 = 420_000;
const SEED_BASE_M2 = 421_000;

/** Distinct per-matchup bot-seed bases, same convention as
 * dominion-loss-mining.ts — `probeScoreL2` is deliberately equal to
 * `mineLosses`'s base (probe-bank.ts's self-consistency requirement). */
const BOT_SEED_BASE = {
  m1: 988_101,
  m2: 988_102,
  mineLosses: 988_201,
  probeScoreL2: 988_201,
  probeScoreV3: 988_302,
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

/** Same fallback logic as dominion-loss-mining.ts's resolveLoopForgeFlags:
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

/** Times an N_TRIAL-game v3-vs-L2 sample and picks the largest N in
 * [N_MIN, N_TARGET] whose extrapolated wall-clock stays under BUDGET_MS,
 * accounting for measurement 1 + measurement 2 both running at that N. */
function decideSampleSize(
  adapter: ReturnType<typeof eraseAdapter>,
  v3Bot: ReturnType<typeof composeBot>,
  opusBot: typeof dominionOpusBot,
): { n: number; msPerGame: number; trialElapsedMs: number } {
  const t0 = Date.now();
  const trial = runHeadToHead(adapter, v3Bot, opusBot, seeds(SEED_BASE_M1 - 1000, N_TRIAL), BOT_SEED_BASE.m1);
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
      `dominion-loss-mining-round2: anchor "${L2_ANCHOR_ID}" is not registered — run dominion-anchor-ladder.ts first`,
    );
  }
  if (!l1Anchor) {
    throw new Error(
      `dominion-loss-mining-round2: anchor "${L1_ANCHOR_ID}" is not registered — run dominion-anchor-ladder.ts first`,
    );
  }

  const resolved = resolveLoopForgeFlags(rootDir);
  if (resolved.registryLatestVersion !== 'v3') {
    console.warn(
      `  경고: registry latest=${resolved.registryLatestVersion} (v3 예상과 다름) — 계속 진행하되 결과 해석 시 comparabilityKey 확인 필요`,
    );
  }
  const v3Bot = composeBot(adapter, resolved.flags);
  const opusBot = dominionOpusBot;
  const midBot = dominionMidBot;

  console.log(`=== dominion loss-mining round 2 (GAP-11 Phase 4-C) ===`);
  console.log(
    `  registry latest: ${resolved.registryLatestVersion} flags=[${resolved.registryLatestFlags.join(', ') || '(none)'}]`,
  );
  console.log(`  v3 합성봇 composed flags(리스트): [${resolved.flags.join(', ') || '(none)'}]`);
  console.log(
    `  composeBot 덮어쓰기 시맨틱 확인: chapelEconomyFlagSpec.apply()는 base 인자를 받지 않음(항상 fresh heuristicBaseline로 시작) ` +
      `-> 리스트의 마지막 플래그 'chapelEconomy'가 앞의 rushProvinces/chapelEconomy-d08/chapelEconomy-late3를 전부 덮어씀. ` +
      `실제 지배 플래그 = 'chapelEconomy' 단독 (chapelEconomy-d08과는 다른 후보이므로 혼동 주의).`,
  );

  const outDir = join(rootDir, 'runs', GAME_ID, 'challenge-l2-round2');
  mkdirSync(outDir, { recursive: true });

  // --- Resource rule: time a 5-game trial before committing to N=100 ---
  console.log(`  사전 타이밍: v3 vs L2 ${N_TRIAL}판 시험 …`);
  const sizing = decideSampleSize(adapter, v3Bot, opusBot);
  const n = sizing.n;
  console.log(
    `     ms/game=${sizing.msPerGame.toFixed(0)} (trial ${N_TRIAL}판 ${(sizing.trialElapsedMs / 1000).toFixed(1)}s) -> N=${n}` +
      (n < N_TARGET ? ` (budget 축소, 목표 ${N_TARGET}에서 하향)` : ''),
  );

  // --- Measurement 1: v3 vs L2, full trajectory collection ---
  const t0 = Date.now();
  console.log(`  측정 1) v3 합성봇 vs L2(opus) N=${n} seedBase=${SEED_BASE_M1} …`);
  const records: MatchTrajectoryRecord[] = [];
  const m1 = runHeadToHead(adapter, v3Bot, opusBot, seeds(SEED_BASE_M1, n), BOT_SEED_BASE.m1, {
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

  // --- Probe bank (round 2, sealed separately from round 1's) ---
  const probes: readonly ProbePosition[] = buildProbeBank(report, records, L2_ANCHOR_ID, { maxProbes: MAX_PROBES });
  const probeBankPath = join(rootDir, 'runs', GAME_ID, 'probe-bank-round2.json');
  saveProbeBank(probeBankPath, probes, l2Anchor);
  console.log(`  저장: ${probeBankPath} (probes=${probes.length}, round1 probe-bank.json 보존)`);

  const l2SelfScore: ProbeScore = scoreAgainstProbes(adapter, opusBot, probes, BOT_SEED_BASE.probeScoreL2);
  const v3ProbeScore: ProbeScore = scoreAgainstProbes(adapter, v3Bot, probes, BOT_SEED_BASE.probeScoreV3);
  console.log(
    `  프로브 검증: L2 자기일치율=${pct(l2SelfScore.agreementRate)} (probes=${l2SelfScore.probes}, skipped=${l2SelfScore.skipped}) — 1.0 기대`,
  );
  console.log(
    `  프로브 검증: v3 합성봇 일치율=${pct(v3ProbeScore.agreementRate)} (probes=${v3ProbeScore.probes}, skipped=${v3ProbeScore.skipped})`,
  );

  // --- Measurement 2: v3 vs L1, win rate only (gradient tracking) ---
  const t2 = Date.now();
  console.log(`  측정 2) v3 합성봇 vs L1(mid) N=${n} seedBase=${SEED_BASE_M2} …`);
  const m2 = runHeadToHead(adapter, v3Bot, midBot, seeds(SEED_BASE_M2, n), BOT_SEED_BASE.m2);
  const t3 = Date.now();
  console.log(
    `     winRate=${pct(m2.candidateWinRate)} CI=${ci(m2)} draw/split=${pct(m2.drawRate)} blocks=${m2.blocks} (${((t3 - t2) / 1000).toFixed(1)}s)`,
  );

  const gradientRestored = m2.candidateWinRate > 0;
  console.log(
    `  그래디언트 추적: v3 vs L1 winRate=${pct(m2.candidateWinRate)} (1회전 challenge의 chapelEconomy 단독 vs L1은 30.0%, chapelEconomy-d08은 33.1% — 서로 다른 후보) -> ${gradientRestored ? 'PASS(0%가 아님)' : 'FAIL(0%로 회귀)'}`,
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
      composedFlagsList: resolved.flags,
      actualDominantFlag: 'chapelEconomy',
      composeBotSemanticNote:
        "chapelEconomyFlagSpec.apply() takes no base parameter (always starts fresh heuristicBaseline) -> the last flag in the list ('chapelEconomy') fully overwrites rushProvinces/chapelEconomy-d08/chapelEconomy-late3. round1's portfolio challenge table measured chapelEconomy (plain) at L2=17.5%/L1=30.0%, distinct from chapelEconomy-d08's L2=22.5%/L1=33.1%.",
    },
    sampleSizing: {
      n,
      target: N_TARGET,
      min: N_MIN,
      msPerGameTrial: sizing.msPerGame,
      trialGames: N_TRIAL,
    },
    measurement1_v3VsL2: {
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
      v3AgreementRate: v3ProbeScore.agreementRate,
    },
    measurement2_v3VsL1: {
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
