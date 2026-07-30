/**
 * dominion-portfolio-round1 — GAP-11 Phase 3-C second half: the first live
 * run of the portfolio protocol v2 (docs/GAP-ANALYSIS-11.md D5.5, docs/adr/
 * 0013) for dominion, following gomoku-portfolio-round1.ts's precedent
 * (Phase 3-B) end to end:
 *
 *   1. Design brief — already produced by dominion-design-brief-round1.ts
 *      (this round's first half, commit 83293b9): runs/dominion/design-
 *      brief-round1.md. Not regenerated here; this file only consumes the
 *      LossReport/probe-bank evidence it documents.
 *   2. Portfolio candidate batch — 5 candidates across 4 buckets (B5-imitate
 *      skipped this round, recorded as a BucketOutcome with candidates: 0,
 *      same convention as gomoku's own round):
 *        B1-exploit (2): mechanical parameter variants of B3's chapelEconomy
 *          — `chapelEconomy-d08` (density threshold 1.0 -> 0.8) and
 *          `chapelEconomy-late3` (transition trigger remaining-Province
 *          4 -> 3) — both declared directly on dominionAdapter.strategySurface
 *          (../dominion.ts), per the main-loop A8 spec's own B1 section.
 *        B2-opponent (1): `simpleEconomyNoTrash` (../dominion.ts) — this
 *          round's own design (a deliberately different approach from B3):
 *          plain money-first buy order targeting the LossReport's #2
 *          mismatched decision point (buy, 18.1%), sidestepping the #1
 *          mismatch (chapelTrash, 67.4%) entirely by never trashing.
 *        B3-deep (1): `chapelEconomy` (../dominion.ts) — the main loop's own
 *          B3 design spec implemented verbatim (deck-money-density-aware
 *          Chapel trash + buy policy), this round's primary A8 candidate.
 *        B4-explore (1): `ismcts-s64-prior-w16` — this round's untried A5
 *          axis (tree prior): dominionAdapter.choiceEvaluator (a static
 *          buy/trash/action value evaluator, ../dominion.ts) wired as an
 *          IS-MCTS priorSource, s64 simulation budget kept unchanged from
 *          every prior dominion ismcts wave (ADR-0009: no budget increases
 *          without a dedicated go/no-go diagnostic).
 *   3. Probe filter — all 5 scored against runs/dominion/probe-bank.json
 *      (agreement rate) plus a 5-game-per-candidate cost measurement vs L2;
 *      the B4 ismcts candidate is additionally checked against the 30-minute
 *      wave budget (msPerGame x worst-case wave game count) and excluded
 *      from advancement (independent of its probe rank) if that projection
 *      would exceed it — the round's explicit resource rule for this
 *      candidate. Top 4 of the remaining candidates by agreement rate (cost
 *      as tiebreak) advance to the wave.
 *   4. Regular wave — assembleWaveConfig/runWave over the (up to 4)
 *      survivors, fresh non-overlapping seed banks, regression tier opponent
 *      = registry v2's composite (rushProvinces), challenge measurement
 *      against the L1/L2 feedback anchors (holdout L3 is never touched by
 *      this file, per the round's explicit instruction).
 *   5. Verdict + bookkeeping — any 'adopted' candidate promotes registry to
 *      v3 (duplicate-promotion guarded, same pattern as reference/runners/
 *      dominion.ts's ismcts-wave-N promotion steps); per-bucket
 *      BucketOutcome computed and fed through artifacts/portfolio.ts's
 *      `reallocate`, persisted to runs/dominion/portfolio-state.json (first
 *      round for this game — no prior state to load, INITIAL_ALLOCATION is
 *      the base).
 *   6. Everything summarized to runs/dominion/portfolio-round1.json,
 *      including chapelTrash-decision-point-specific probe agreement rates
 *      (filtered from the full probe bank) for the v2 baseline and every
 *      probe-filtered candidate — the round's own completion-report
 *      requirement (v2's chapelTrash agreement was measured at 0.0% during
 *      loss-mining; this file re-derives it plus each candidate's rate for
 *      direct comparison).
 *
 * Fresh seed ranges (game seeds), verified non-overlapping with every prior
 * dominion runner's own documented range: dominion-runner-{smoke,prune,
 * holdout} (1-90, 1000-1029, 2000-2029), the four ismcts waves (30000-33019,
 * 40000-43019, 50000-53019, 60000-63019), dominion-benchmark.ts
 * (50,000-51,999), dominion-anchor-ladder.ts (992,000+/993,000+/998,000+/
 * 999,000+), dominion-loss-mining.ts (400,000-400,099/401,000-401,099):
 *   - probe-filter cost check: 700,000-700,004 (N=5, shared block across all
 *     5 candidates for one comparabilityKey context).
 *   - wave smoke/prune/holdout/regression: 711,000+/712,000+/713,000+/714,000+.
 *   - challenge (L1/L2): 715,000-715,039 (N=40).
 * Bot seed bases (independent space, distinct from every existing dominion
 * bot-seed base: 982_1xx, 985_1xx, 986_1xx): 987_101 (cost check/probe
 * filter), 987_301 (challenge).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer including search/) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import type { AnyBotFactory, AnyGameAdapter, StrategyFlagSpec } from '../../contract/types';
import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead } from '../../loop/head-to-head';
import { scoreAgainstProbes, type ProbePosition, type ProbeScore } from '../../loop/probe-bank';
import { loadProbeBank } from '../../artifacts/trajectory-archive';
import { assembleWaveConfig } from '../../loop/assemble-wave-config';
import { runWave, type WaveChallengeEntry, type WaveReport } from '../../loop/wave-runner';
import { SeedLedger } from '../../kernel/seed-ledger';
import {
  loadOrCreateLedger,
  loadOrCreateRegistry,
  saveLedger,
  saveRegistry,
} from '../../artifacts/game-state';
import { extractNearMissCandidates, type AdoptionEntry } from '../../artifacts/adoption-ledger';
import {
  BUCKET_ORDER,
  INITIAL_ALLOCATION,
  loadPortfolioState,
  reallocate,
  savePortfolioState,
  type BucketId,
  type BucketOutcome,
} from '../../artifacts/portfolio';
import { ismctsBotFactory } from '../../search/ismcts';
import type { MctsConfig } from '../../search/mcts';
import { dominionAdapter } from '../dominion';
import { dominionOpusBot } from '../experiments/dominion-opus-bot';
import { dominionMidBot } from '../experiments/dominion-mid-bot';

const GAME_ID = 'dominion';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const PROBE_SCORE_BOT_SEED_BASE = 986_201; // same base dominion-loss-mining.ts's mineLosses/probeScoreL2 use (self-consistency, probe-bank.ts's doc comment).
const COST_CHECK_SEED_BASE = 700_000;
const COST_CHECK_N = 5;
const COST_CHECK_BOT_SEED_BASE = 987_101;

const WAVE_BUDGET_MS = 30 * 60 * 1000;
/** Worst-case total games across smoke(<=30 blocks)+prune(15)+holdout(15)+
 * regression(20) blocks, 2 games/block — same tier sizes as every prior
 * dominion ismcts wave (shared/dominion-ismcts-flag.ts's doc comments). */
const WAVE_WORST_CASE_GAMES = (30 + 15 + 15 + 20) * 2;

const ISMCTS_PRIOR_FLAG = 'ismcts-s64-prior-w16';

function now(): string {
  return new Date().toISOString();
}

function seeds(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------
// Step 2: candidate batch (B1/B2/B3/B4 — see file doc comment)
// ---------------------------------------------------------------------

interface RoundCandidate {
  readonly flag: string;
  readonly bucket: BucketId;
}

/**
 * B4's IS-MCTS prior candidate: s64 budget unchanged (ADR-0009), rollout
 * policy 'heuristic' (matches ismcts-s64-hr's own precedent), priorSource
 * 'choiceEvaluator' resolving to dominionAdapter.choiceEvaluator (a static
 * buy/trash/action evaluator declared directly on the adapter — see
 * ../dominion.ts's own doc comment on it). `apply()` ignores `base` entirely
 * (same convention as every other search-based flag spec in this codebase):
 * an IS-MCTS candidate builds its decision from search, not by modulating a
 * base bot's choice.
 */
const ISMCTS_PRIOR_CONFIG: MctsConfig = {
  simulations: 64,
  uctC: 1.4,
  rolloutCount: 1,
  rolloutPolicy: 'heuristic',
  label: 's64-prior-w16',
  priorWeight: 16,
  priorSource: 'choiceEvaluator',
};

function dominionIsmctsPriorFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  return {
    flag: ISMCTS_PRIOR_FLAG,
    description:
      'B4 explore (A5 tree prior, GAP-11 Phase 3-C): SO-ISMCTS search candidate using dominionAdapter.choiceEvaluator (static buy/trash/action value evaluation) as its priorSource, s64 simulation budget unchanged from every prior dominion ismcts wave (ADR-0009); ignores the base bot entirely.',
    apply: () => ismctsBotFactory(adapter, ISMCTS_PRIOR_CONFIG),
    assembly: 'terminal',
  };
}

function buildCandidates(): readonly RoundCandidate[] {
  return [
    { flag: 'chapelEconomy-d08', bucket: 'B1-exploit' },
    { flag: 'chapelEconomy-late3', bucket: 'B1-exploit' },
    { flag: 'simpleEconomyNoTrash', bucket: 'B2-opponent' },
    { flag: 'chapelEconomy', bucket: 'B3-deep' },
    { flag: ISMCTS_PRIOR_FLAG, bucket: 'B4-explore' },
  ];
}

// ---------------------------------------------------------------------
// Step 3: probe filter (+ B4 budget check)
// ---------------------------------------------------------------------

interface ProbeFilterRow {
  readonly flag: string;
  readonly bucket: BucketId;
  readonly probeScore: ProbeScore;
  readonly chapelTrashProbeScore: ProbeScore;
  readonly msPerGame: number;
  readonly budgetExcluded: boolean;
  readonly advanced: boolean;
}

function runProbeFilter(
  adapter: AnyGameAdapter,
  candidates: readonly RoundCandidate[],
  probes: readonly ProbePosition[],
  chapelTrashProbes: readonly ProbePosition[],
): readonly ProbeFilterRow[] {
  const costSeeds = seeds(COST_CHECK_SEED_BASE, COST_CHECK_N);
  const rows: Array<Omit<ProbeFilterRow, 'advanced'>> = [];

  for (const candidate of candidates) {
    const bot = composeBot(adapter, [candidate.flag]);
    const probeScore = scoreAgainstProbes(adapter, bot, probes, PROBE_SCORE_BOT_SEED_BASE);
    const chapelTrashProbeScore = scoreAgainstProbes(adapter, bot, chapelTrashProbes, PROBE_SCORE_BOT_SEED_BASE);

    const t0 = Date.now();
    const costResult = runHeadToHead(adapter, bot, dominionOpusBot, costSeeds, COST_CHECK_BOT_SEED_BASE);
    const elapsedMs = Date.now() - t0;
    const msPerGame = costResult.blocks > 0 ? elapsedMs / (costResult.blocks * 2) : Infinity;

    const budgetExcluded = candidate.flag === ISMCTS_PRIOR_FLAG && msPerGame * WAVE_WORST_CASE_GAMES > WAVE_BUDGET_MS;

    console.log(
      `  [probe-filter] ${candidate.flag} (${candidate.bucket}): agreement=${pct(probeScore.agreementRate)} ` +
        `(${probeScore.agreements}/${probeScore.probes - probeScore.skipped}, skipped=${probeScore.skipped}) ` +
        `chapelTrashAgreement=${pct(chapelTrashProbeScore.agreementRate)} ms/game=${msPerGame.toFixed(0)}` +
        (budgetExcluded
          ? ` -- 30분 예산 초과 예상(${((msPerGame * WAVE_WORST_CASE_GAMES) / 60000).toFixed(1)}분) -> 제외`
          : ''),
    );
    rows.push({ flag: candidate.flag, bucket: candidate.bucket, probeScore, chapelTrashProbeScore, msPerGame, budgetExcluded });
  }

  const eligible = rows.filter((row) => !row.budgetExcluded);
  const ranked = [...eligible].sort((a, b) => {
    if (b.probeScore.agreementRate !== a.probeScore.agreementRate) {
      return b.probeScore.agreementRate - a.probeScore.agreementRate;
    }
    return a.msPerGame - b.msPerGame; // tie-break: cheaper wins
  });
  const advancingFlags = new Set(ranked.slice(0, 4).map((row) => row.flag));

  return rows.map((row) => ({ ...row, advanced: advancingFlags.has(row.flag) }));
}

// ---------------------------------------------------------------------
// Step 4-6: wave + challenge + bookkeeping
// ---------------------------------------------------------------------

function main(): void {
  console.log(`=== dominion portfolio round 1 (GAP-11 Phase 3-C, ADR-0013) — rootDir=${ROOT_DIR} ===`);
  console.log('1) 설계 브리프 — 이미 존재 (runs/dominion/design-brief-round1.md, 이번 라운드 전반부 산출) — 재생성 생략');

  const bareAdapter = eraseAdapter(dominionAdapter);
  const ismctsFlagSpec = dominionIsmctsPriorFlagSpec(bareAdapter);
  const adapter = withStrategyFlags(bareAdapter, [ismctsFlagSpec]);

  console.log('2) 포트폴리오 후보 배치 생성 (B1x2, B2x1, B3x1, B4x1 = 5)');
  const candidates = buildCandidates();
  for (const candidate of candidates) {
    console.log(`   ${candidate.bucket}: ${candidate.flag}`);
  }

  console.log('3) 프로브 필터 (판당 비용 실측 각 5판, B4는 30분 예산 사전 점검, 상위 4개 진출)');
  const probeBankPath = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank.json');
  const probes = loadProbeBank(probeBankPath);
  const chapelTrashProbes = probes.filter((probe) => probe.decisionPointId === 'chapelTrash');
  console.log(`   전체 프로브=${probes.length}, chapelTrash 프로브=${chapelTrashProbes.length}`);

  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined) {
    throw new Error('dominion-portfolio-round1: registry has no latest baseline — run reference/runners/dominion.ts first');
  }
  const v2Bot = composeBot(bareAdapter, latest.flags);
  const v2ChapelTrashProbeScore = scoreAgainstProbes(bareAdapter, v2Bot, chapelTrashProbes, PROBE_SCORE_BOT_SEED_BASE);
  console.log(
    `   v2(${latest.flags.join('+') || '(none)'}) chapelTrash 프로브 일치율=${pct(v2ChapelTrashProbeScore.agreementRate)} ` +
      `(${v2ChapelTrashProbeScore.agreements}/${v2ChapelTrashProbeScore.probes - v2ChapelTrashProbeScore.skipped}) — 기준선`,
  );

  const probeFilterRows = runProbeFilter(adapter, candidates, probes, chapelTrashProbes);
  const advancing = probeFilterRows.filter((row) => row.advanced);
  console.log(`   진출: ${advancing.map((row) => row.flag).join(', ')}`);
  const budgetExcluded = probeFilterRows.filter((row) => row.budgetExcluded);
  if (budgetExcluded.length > 0) {
    console.log(`   30분 예산 초과로 제외: ${budgetExcluded.map((row) => row.flag).join(', ')}`);
  }

  console.log('4) 정규 웨이브 (신규 시드 뱅크)');
  const ledgerStore = loadOrCreateLedger(ROOT_DIR, GAME_ID);

  const waveLedger = new SeedLedger();
  const reservedAt = now();
  const SMOKE_MAX = 30;
  const PRUNE_BLOCKS = 15;
  const HOLDOUT_BLOCKS = 15;
  const REGRESSION_BLOCKS = 20;
  waveLedger.reserve({ bankId: 'dominion-portfolio1-smoke', range: { start: 711_000, end: 711_000 + SMOKE_MAX - 1 }, purpose: 'smoke', reservedAt });
  waveLedger.reserve({ bankId: 'dominion-portfolio1-prune', range: { start: 712_000, end: 712_000 + PRUNE_BLOCKS - 1 }, purpose: 'prune', reservedAt });
  waveLedger.reserve({ bankId: 'dominion-portfolio1-holdout', range: { start: 713_000, end: 713_000 + HOLDOUT_BLOCKS - 1 }, purpose: 'holdout', reservedAt });
  waveLedger.reserve({ bankId: 'dominion-portfolio1-regression', range: { start: 714_000, end: 714_000 + REGRESSION_BLOCKS - 1 }, purpose: 'regression', reservedAt });

  const CHALLENGE_N = 40;
  const CHALLENGE_SEED_BASE = 715_000;
  const CHALLENGE_BOT_SEED_BASE = 987_301;
  const challengeEntries: readonly WaveChallengeEntry[] = [
    { anchorId: 'external-mid-l1', factory: dominionMidBot as AnyBotFactory, role: 'feedback' },
    { anchorId: 'external-opus-l2', factory: dominionOpusBot as AnyBotFactory, role: 'feedback' },
  ];

  const waveConfig = {
    ...assembleWaveConfig(adapter, {
      waveId: 'portfolio-round1',
      candidates: advancing.map((row) => ({ flag: row.flag })),
      opponent: 'heuristic',
      ledger: waveLedger,
      recordedAt: now(),
      baselineFlags: latest.flags,
      baselineVersion: latest.version,
      tiers: {
        smoke: { bankId: 'dominion-portfolio1-smoke', sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 }, maxBlocks: SMOKE_MAX, minBlocks: 5 },
        prune: { bankId: 'dominion-portfolio1-prune', blocks: PRUNE_BLOCKS },
        holdout: { bankId: 'dominion-portfolio1-holdout', blocks: HOLDOUT_BLOCKS },
        regression: { bankId: 'dominion-portfolio1-regression', blocks: REGRESSION_BLOCKS },
      },
      screenProbe: { seeds: [1, 2, 3], botSeedBase: 100 },
    }),
    challenge: {
      entries: challengeEntries,
      seeds: seeds(CHALLENGE_SEED_BASE, CHALLENGE_N),
      botSeedBase: CHALLENGE_BOT_SEED_BASE,
    },
  };

  const report: WaveReport = runWave(adapter, waveConfig);
  for (const result of report.results) {
    console.log(`   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`);
  }

  console.log('5) challenge 결과');
  const challengeTable: Record<string, Record<string, { winRate: number; blocks: number }>> = {};
  for (const entry of report.challengeResult ?? []) {
    challengeTable[entry.anchorId] ??= {};
    (challengeTable[entry.anchorId] as Record<string, { winRate: number; blocks: number }>)[entry.subject] = {
      winRate: entry.winRate,
      blocks: entry.blocks,
    };
    console.log(`   ${entry.anchorId} vs ${entry.subject}: winRate=${pct(entry.winRate)} blocks=${entry.blocks}`);
  }

  console.log('6) adoption ledger 기록');
  const entries: AdoptionEntry[] = report.results.map((result) => {
    const tierStats: AdoptionEntry['tierStats'] = {};
    for (const tier of ['screen', 'smoke', 'prune', 'holdout', 'regression'] as const) {
      const stats = result.stats[tier];
      if (stats) {
        tierStats[tier] = {
          pointWinRate: stats.pointWinRate,
          pointScoreDiff: stats.pointScoreDiff,
          blocks: stats.blocks,
          ...(stats.drawRate !== undefined ? { drawRate: stats.drawRate } : {}),
          ...(stats.winRateCI !== undefined ? { winRateCI: stats.winRateCI } : {}),
        };
      }
    }
    const isNoOp = result.tiersPassed.length === 0 && result.stats.smoke === undefined;
    return {
      flags: result.flags,
      verdict: isNoOp ? 'screened-out' : result.verdict,
      tierStats,
      ...(isNoOp ? { failureReason: 'behavioral no-op (screened out before any games)' } : {}),
    };
  });
  const adoptionRecord = ledgerStore.add({
    waveId: report.waveId,
    recordedAt: now(),
    comparabilityKey: report.comparabilityKey,
    baselineVersion: latest.version,
    opponentId: waveConfig.opponent,
    entries,
    nextLoopNotes: [],
  });

  const nearMiss = extractNearMissCandidates(adoptionRecord, waveConfig.criteria);
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round1-near-miss.json'), JSON.stringify(nearMiss, null, 2));

  console.log('7) registry 승격 (채택 있으면, 중복 승격 가드)');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  let promotedVersion: string | null = null;
  if (adoptedFlags.length > 0) {
    const lineage = registry.lineage(latest.version);
    const alreadyPromoted = lineage.some((version) => version.sourceWaveId === report.waveId);
    if (alreadyPromoted) {
      console.log('   이 웨이브는 이미 승격됨 — 스킵');
      promotedVersion = lineage.find((version) => version.sourceWaveId === report.waveId)?.version ?? null;
    } else {
      const nextVersion = registry.register({
        version: `v${lineage.length + 1}`,
        flags: [...latest.flags, ...adoptedFlags],
        parent: latest.version,
        createdAt: now(),
        sourceWaveId: report.waveId,
        notes: `portfolio-round1에서 채택된 플래그 승격: ${adoptedFlags.join(', ')}`,
      });
      promotedVersion = nextVersion.version;
      console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
    }
  } else {
    console.log('   채택된 후보 없음 — 승격 없음');
  }
  saveRegistry(ROOT_DIR, GAME_ID, registry);
  saveLedger(ROOT_DIR, GAME_ID, ledgerStore);

  console.log('8) 버킷 수율 계산 + 재배분');
  const baselineL2WinRate = challengeTable['external-opus-l2']?.['baseline']?.winRate ?? 0;
  const verdictByFlag = new Map(report.results.map((result) => [result.flag, result.verdict]));

  const bucketOutcomes: BucketOutcome[] = BUCKET_ORDER.map((bucket) => {
    const bucketCandidates = candidates.filter((candidate) => candidate.bucket === bucket);
    const bucketAdvancing = bucketCandidates.filter((candidate) =>
      advancing.some((row) => row.flag === candidate.flag),
    );
    const adopted = bucketAdvancing.filter((candidate) => verdictByFlag.get(candidate.flag) === 'adopted').length;

    const deltas = bucketAdvancing
      .map((candidate) => challengeTable['external-opus-l2']?.[candidate.flag]?.winRate)
      .filter((winRate): winRate is number => winRate !== undefined)
      .map((winRate) => winRate - baselineL2WinRate);
    const challengeDelta = deltas.length > 0 ? deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length : 0;

    return { bucket, candidates: bucketCandidates.length, adopted, challengeDelta };
  });
  for (const outcome of bucketOutcomes) {
    console.log(
      `   ${outcome.bucket}: candidates=${outcome.candidates} adopted=${outcome.adopted} challengeDelta=${outcome.challengeDelta.toFixed(4)}`,
    );
  }

  const currentAllocation = loadPortfolioState(ROOT_DIR, GAME_ID) ?? INITIAL_ALLOCATION;
  const nextAllocation = reallocate(currentAllocation, bucketOutcomes);
  savePortfolioState(ROOT_DIR, GAME_ID, nextAllocation);
  console.log('   재배분 결과:');
  for (const entry of nextAllocation) {
    console.log(`     ${entry.bucket}: ${(entry.share * 100).toFixed(1)}%`);
  }

  console.log('9) runs/dominion/portfolio-round1.json 저장');
  const summary = {
    gameId: GAME_ID,
    generatedAt: now(),
    designBriefPath: `runs/${GAME_ID}/design-brief-round1.md`,
    v2Baseline: {
      flags: latest.flags,
      chapelTrashProbeAgreementRate: v2ChapelTrashProbeScore.agreementRate,
    },
    probeFilter: probeFilterRows.map((row) => ({
      flag: row.flag,
      bucket: row.bucket,
      agreementRate: row.probeScore.agreementRate,
      probesScored: row.probeScore.probes - row.probeScore.skipped,
      probesSkipped: row.probeScore.skipped,
      chapelTrashAgreementRate: row.chapelTrashProbeScore.agreementRate,
      chapelTrashProbesScored: row.chapelTrashProbeScore.probes - row.chapelTrashProbeScore.skipped,
      msPerGame: row.msPerGame,
      budgetExcluded: row.budgetExcluded,
      advanced: row.advanced,
    })),
    wave: {
      waveId: report.waveId,
      comparabilityKey: report.comparabilityKey,
      results: report.results.map((result) => ({
        flag: result.flag,
        verdict: result.verdict,
        tiersPassed: result.tiersPassed,
      })),
    },
    challenge: challengeTable,
    adoption: { promotedVersion, adoptedFlags },
    bucketOutcomes,
    portfolioAllocation: { previous: currentAllocation, next: nextAllocation },
    excludedBuckets: {
      'B5-imitate': '이번 라운드 0 후보 — GAP-11 §3 D6의 A10 행에 도미니언 모방 시도 실패 2회(주의)가 이미 기록되어 있어(0.275->0.100 열화), 전이성이 낮다고 판단(메인 루프 결정, 오목 라운드와 동일 근거).',
    },
  };
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round1.json'), JSON.stringify(summary, null, 2));
  console.log(`   저장: runs/${GAME_ID}/portfolio-round1.json`);
}

main();
