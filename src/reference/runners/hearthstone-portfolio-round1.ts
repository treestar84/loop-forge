/**
 * hearthstone-portfolio-round1 — GAP-11 Phase 7, hearthstone's first
 * portfolio-protocol round (docs/GAP-ANALYSIS-11.md D5.5, docs/adr/0013),
 * following the main-loop design spec verbatim (scratchpad/hearthstone-
 * round1-design-spec.md) after loss-mining's own first-round channel
 * discovery (v2 vs L2 34.0%, N=100, decision-point model collapsed to a
 * single `'action'` id — see runs/hearthstone/design-brief-round1.md).
 *
 * Candidate batch (5 — B3x1, B1x2, B2x1, B4x1; the design spec's own header
 * says "6개" but its body lists 5, matching dominion-portfolio-round3.ts's
 * own documented "header says 6, body specifies 5" precedent — no 6th
 * candidate is implied):
 *   - B3-deep (1): `ismcts-s128-tempo-w16` — `ismcts-s128-hr`'s exact
 *     budget/rollout config plus a tree prior sourced from
 *     `hearthstoneAdapter.choiceEvaluator` (../hearthstone.ts,
 *     `hearthstoneChoiceEvaluator`, ADR-0011) at priorWeight=16 (gomoku
 *     Phase 2's own starting point for this same mechanism).
 *   - B1-exploit (2): `ismcts-s128-tempo-w4`/`ismcts-s128-tempo-w48` —
 *     mechanical priorWeight sweep of the same B3 config.
 *   - B2-opponent (1): `ismcts-s128-playfocus-w16` — a DIFFERENT evaluator
 *     from B3 (`hearthstonePlayFocusedEvaluator`, ../experiments/hearthstone-
 *     play-focused-evaluator.ts), targeting this round's own probe-bank
 *     analysis (one-off scratch script, deleted after use per the design
 *     spec's instruction — encodeChoice-prefix mismatch rates against the
 *     v2 synthetic bot: play 61.4%/127, attack 56.8%/44, heroPower
 *     48.3%/29 — `play` is the largest and only axis this evaluator
 *     specializes) rather than a weight sweep of B3's own evaluator.
 *   - B4-explore (1): `ismcts-s128-l1rollout` — `hearthstoneMidBot` (L1
 *     anchor) injected as `MctsConfig.rolloutFactory`, s128 budget unchanged
 *     (an A2 rollout-policy-replace axis this game has never tried; unlike
 *     the champion-rollout precedent in gomoku/dominion that regressed win
 *     rate, this uses a mid-skill rollout, per the design spec's own
 *     rationale — may fail, still valid data).
 * All 5 declare `assembly: 'terminal'` (ADR-0014) — first-round convention
 * per the design spec's own instruction, matching this game's existing
 * `ismcts-s128-hr` flag's own declaration.
 *
 * Procedure (design spec's own instruction, verbatim):
 *   1. Probe filter: score all 5 against runs/hearthstone/probe-bank.json
 *      (agreement rate) plus a 5-game-per-candidate cost check vs L2; top 4
 *      advance.
 *   2. Regular wave: fresh non-overlapping seed bank, regression opponent =
 *      v2 (current champion, `baselineFlags: latest.flags`), challenge
 *      L1/L2 (N=40, fresh seeds). L3 is never a regular challenge entry.
 *   3. Promotion via `composeBotChecked`/`assembleFlags` (ADR-0014,
 *      src/loop/compose.ts) — first round for this game, so the candidate
 *      pool is simply this round's adopted terminals + v2 itself (v2 stays
 *      a "터미널 도전자": if nothing beats it on challengeScore, it
 *      survives assembleFlags's terminal tie-break, using the wave's own
 *      `subject: 'baseline'` challenge row as v2's challengeScore).
 *   4. On adoption: v3 = assembleFlags's result, `BucketOutcome`s computed
 *      with `INITIAL_ALLOCATION` (no prior portfolio state for this game)
 *      fed through `reallocate`, persisted to
 *      runs/hearthstone/portfolio-state.json.
 *   5. Transcendence trigger (design spec's own instruction): if any
 *      candidate's N=40 challenge vs L2 already has winRateCI.lower > 0.5,
 *      re-measure at N=200 (confirmatory) — only if that also clears the
 *      threshold does this script run the L3 holdout head-to-head
 *      (external-style2-l3, hearthstone-anchor-ladder.ts's holdout anchor)
 *      at N=100, gate-free (no LossReport/probe-bank generation from the
 *      holdout result — holdout guard).
 *   6. Everything summarized to runs/hearthstone/portfolio-round1.json.
 *
 * Fresh seed ranges (game seeds), verified non-overlapping with every prior
 * hearthstone runner's own documented range (hearthstone-benchmark.ts's
 * 55,000-56,599; hearthstone-anchor-ladder.ts's 994,000+/995,000+/
 * 1,000,000+/1,001,000+; hearthstone-loss-mining.ts's 499,000-499,004/
 * 500,000-500,099/501,000-501,099) — reusing gomoku-portfolio-round1.ts's own
 * numbering convention (520k-525k) for a game new to this protocol:
 *   - probe-filter cost check: 520,000-520,004 (N=5, shared block across all
 *     5 candidates for one comparabilityKey context).
 *   - wave smoke/prune/holdout/regression: 521,000+/522,000+/523,000+/524,000+.
 *   - challenge (L1/L2): 525,000-525,039 (N=40).
 *   - confirm (only if triggered): 526,000-526,199 (N=200).
 *   - transcendence L3 holdout (only if confirm also triggers): 527,000-527,099 (N=100).
 * Bot seed bases (fresh 988_1xx/988_3xx/988_5xx/988_7xx block, distinct from
 * every hearthstone base already documented above — 950_10x/983_10x/
 * 986_10x/987_1xx/987_2xx/987_3xx): 988_101 (cost check/probe filter),
 * 988_301 (challenge), 988_501 (confirm), 988_701 (L3 holdout).
 *
 * Resource rule (team-lead instruction): IS-MCTS s128 costs ~217ms/game
 * (hearthstone-loss-mining.ts's own pre-mining measurement) — this script
 * runs every candidate strictly sequentially in one process; invoke under
 * `nice -n 10` externally (this file cannot set OS scheduling priority on
 * itself).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import type { AnyBotFactory, AnyGameAdapter, PlayerId } from '../../contract/types';
import { eraseAdapter } from '../../loop/erase';
import { composeBot, composeBotChecked, assembleFlags, withStrategyFlags, type AssembleFlagsCandidate } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { scoreAgainstProbes, type ProbeScore } from '../../loop/probe-bank';
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
import type { StrategyFlagSpec } from '../../contract/types';
import { hearthstoneAdapter, type HearthstoneChoice, type HearthstoneState } from '../hearthstone';
import { hearthstoneOpusBot } from '../experiments/hearthstone-opus-bot';
import { hearthstoneMidBot } from '../experiments/hearthstone-mid-bot';
import { hearthstoneTempoBot } from '../experiments/hearthstone-tempo-bot';
import { hearthstonePlayFocusedEvaluator } from '../experiments/hearthstone-play-focused-evaluator';
import {
  hearthstoneIsmctsFlagSpec,
  hearthstoneIsmctsFlagSpecFor,
  hearthstoneTempoPriorConfig,
  hearthstoneL1RolloutConfig,
} from './shared/hearthstone-ismcts-flag';

const GAME_ID = 'hearthstone';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const PROBE_SCORE_BOT_SEED_BASE = 987_201; // hearthstone-loss-mining.ts's own base (self-consistency — L2's decide() never reads its seed parameter).
const COST_CHECK_SEED_BASE = 520_000;
const COST_CHECK_N = 5;
const COST_CHECK_BOT_SEED_BASE = 988_101;

const L1_ANCHOR_ID = 'external-mid-l1';
const L2_ANCHOR_ID = 'external-opus-l2';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRANSCENDENCE_TRIGGER_THRESHOLD = 0.5;

const CONFIRM_N = 200;
const CONFIRM_SEED_BASE = 526_000;
const CONFIRM_BOT_SEED_BASE = 988_501;

const L3_N = 100;
const L3_SEED_BASE = 527_000;
const L3_BOT_SEED_BASE = 988_701;

const B3_FLAG = 'ismcts-s128-tempo-w16';
const B1_W4_FLAG = 'ismcts-s128-tempo-w4';
const B1_W48_FLAG = 'ismcts-s128-tempo-w48';
const B2_FLAG = 'ismcts-s128-playfocus-w16';
const B4_FLAG = 'ismcts-s128-l1rollout';

function now(): string {
  return new Date().toISOString();
}

function seeds(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function ciStr(result: { readonly winRateCI: { readonly lower: number; readonly upper: number } }): string {
  return `[${pct(result.winRateCI.lower)}, ${pct(result.winRateCI.upper)}]`;
}

interface RoundCandidate {
  readonly flag: string;
  readonly bucket: BucketId;
}

/** Widens `hearthstonePlayFocusedEvaluator` (typed against HearthstoneState/
 * HearthstoneChoice) to the erased `MctsConfig.priorEvaluator` signature —
 * same type-level-cast-only pattern as gomoku/dominion's own erase helpers. */
function erasePlayFocusedEvaluator(): (
  state: unknown,
  player: PlayerId,
  choices: readonly unknown[],
) => readonly number[] {
  return (state, player, choices) =>
    hearthstonePlayFocusedEvaluator(state as HearthstoneState, player, choices as readonly HearthstoneChoice[]);
}

function buildCandidates(adapter: AnyGameAdapter): { candidates: readonly RoundCandidate[]; specs: readonly StrategyFlagSpec<unknown, unknown>[] } {
  const b3Spec = hearthstoneIsmctsFlagSpecFor(
    adapter,
    hearthstoneTempoPriorConfig(16, 's128-tempo-w16'),
    B3_FLAG,
    'B3 본안 (GAP-11 Phase 7 design spec): ismcts-s128-hr 예산 + hearthstoneAdapter.choiceEvaluator 트리 prior(priorWeight=16, ADR-0011).',
  );
  const b1w4Spec = hearthstoneIsmctsFlagSpecFor(
    adapter,
    hearthstoneTempoPriorConfig(4, 's128-tempo-w4'),
    B1_W4_FLAG,
    'B1 파생 (priorWeight 스윕, 기계 변형): B3과 동일 구성, priorWeight=4.',
  );
  const b1w48Spec = hearthstoneIsmctsFlagSpecFor(
    adapter,
    hearthstoneTempoPriorConfig(48, 's128-tempo-w48'),
    B1_W48_FLAG,
    'B1 파생 (priorWeight 스윕, 기계 변형): B3과 동일 구성, priorWeight=48.',
  );
  const b2Spec = hearthstoneIsmctsFlagSpecFor(
    adapter,
    { simulations: 128, uctC: 1.4, rolloutCount: 1, rolloutPolicy: 'heuristic', label: 's128-playfocus-w16', priorWeight: 16, priorEvaluator: erasePlayFocusedEvaluator() },
    B2_FLAG,
    'B2 opponent-targeted (probe-bank encodeChoice-prefix 분석, play 61.4%/127 최다 불일치): hearthstonePlayFocusedEvaluator를 priorEvaluator로 주입한 별도 축(B3와 다른 평가함수), priorWeight=16.',
  );
  const b4Spec = hearthstoneIsmctsFlagSpecFor(
    adapter,
    hearthstoneL1RolloutConfig(hearthstoneMidBot as AnyBotFactory, 's128-l1rollout'),
    B4_FLAG,
    'B4 미시도 축 (A2 rollout policy replace): hearthstoneMidBot(L1)을 rolloutFactory로 주입, s128 예산 유지.',
  );
  const candidates: readonly RoundCandidate[] = [
    { flag: B3_FLAG, bucket: 'B3-deep' },
    { flag: B1_W4_FLAG, bucket: 'B1-exploit' },
    { flag: B1_W48_FLAG, bucket: 'B1-exploit' },
    { flag: B2_FLAG, bucket: 'B2-opponent' },
    { flag: B4_FLAG, bucket: 'B4-explore' },
  ];
  return { candidates, specs: [b3Spec, b1w4Spec, b1w48Spec, b2Spec, b4Spec] };
}

// ---------------------------------------------------------------------
// Probe filter (+ per-candidate cost check, top-4-of-5 cut)
// ---------------------------------------------------------------------

interface ProbeFilterRow {
  readonly flag: string;
  readonly bucket: BucketId;
  readonly probeScore: ProbeScore;
  readonly msPerGame: number;
  readonly advanced: boolean;
}

function runProbeFilter(
  adapter: AnyGameAdapter,
  candidates: readonly RoundCandidate[],
  probes: ReturnType<typeof loadProbeBank>,
): readonly ProbeFilterRow[] {
  const costSeeds = seeds(COST_CHECK_SEED_BASE, COST_CHECK_N);
  const rows: Array<Omit<ProbeFilterRow, 'advanced'>> = [];

  for (const candidate of candidates) {
    const bot = composeBot(adapter, [candidate.flag]);
    const probeScore = scoreAgainstProbes(adapter, bot, probes, PROBE_SCORE_BOT_SEED_BASE);

    const t0 = Date.now();
    const costResult = runHeadToHead(adapter, bot, hearthstoneOpusBot, costSeeds, COST_CHECK_BOT_SEED_BASE);
    const elapsedMs = Date.now() - t0;
    const msPerGame = costResult.blocks > 0 ? elapsedMs / (costResult.blocks * 2) : Infinity;

    console.log(
      `  [probe-filter] ${candidate.flag} (${candidate.bucket}): agreement=${pct(probeScore.agreementRate)} ` +
        `(${probeScore.agreements}/${probeScore.probes - probeScore.skipped}, skipped=${probeScore.skipped}) ms/game=${msPerGame.toFixed(0)}`,
    );
    rows.push({ flag: candidate.flag, bucket: candidate.bucket, probeScore, msPerGame });
  }

  const ranked = [...rows].sort((a, b) => {
    if (b.probeScore.agreementRate !== a.probeScore.agreementRate) {
      return b.probeScore.agreementRate - a.probeScore.agreementRate;
    }
    return a.msPerGame - b.msPerGame;
  });
  const advancingFlags = new Set(ranked.slice(0, 4).map((row) => row.flag));

  return rows.map((row) => ({ ...row, advanced: advancingFlags.has(row.flag) }));
}

function main(): void {
  console.log(`=== hearthstone portfolio round 1 (GAP-11 Phase 7) — rootDir=${ROOT_DIR} ===`);

  const bareAdapter = eraseAdapter(hearthstoneAdapter);
  const ismctsFlagSpec = hearthstoneIsmctsFlagSpec(bareAdapter); // ismcts-s128-hr (needed to reconstruct v2's composite)
  const adapterForCandidates = withStrategyFlags(bareAdapter, [ismctsFlagSpec]);
  const { candidates, specs } = buildCandidates(adapterForCandidates);
  const adapter = withStrategyFlags(adapterForCandidates, specs);

  console.log('1) 후보 배치 생성 (B3x1, B1x2, B2x1, B4x1 = 5)');
  for (const candidate of candidates) {
    console.log(`   ${candidate.bucket}: ${candidate.flag}`);
  }

  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const ledgerStore = loadOrCreateLedger(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined || latest.version !== 'v2') {
    throw new Error(
      `hearthstone-portfolio-round1: registry latest=${latest?.version ?? '(none)'} — expected v2 (ismcts-s128-hr, ismcts-wave-1)`,
    );
  }
  console.log(`   registry latest=${latest.version} flags=[${latest.flags.join(', ')}]`);

  console.log('2) 프로브 필터 (판당 비용 실측 각 5판, 상위 4 진출)');
  const probeBankPath = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank.json');
  const probes = loadProbeBank(probeBankPath);
  const probeFilterRows = runProbeFilter(adapter, candidates, probes);
  const advanced = probeFilterRows.filter((row) => row.advanced);
  const cutRow = probeFilterRows.find((row) => !row.advanced);
  console.log(`   진출(상위 4): ${advanced.map((row) => row.flag).join(', ')}`);
  if (cutRow) {
    console.log(`   탈락: ${cutRow.flag} (agreement=${pct(cutRow.probeScore.agreementRate)})`);
  }

  console.log('3) 정규 웨이브 (신규 시드 뱅크, regression 상대=v2, challenge L1/L2 N=40, L3 미포함)');
  const waveCandidates = advanced.map((row) => ({ flag: row.flag }));
  const waveLedger = new SeedLedger();
  const reservedAt = now();
  const SMOKE_MAX = 30;
  const PRUNE_BLOCKS = 15;
  const HOLDOUT_BLOCKS = 15;
  const REGRESSION_BLOCKS = 20;
  waveLedger.reserve({ bankId: 'hearthstone-portfolio1-smoke', range: { start: 521_000, end: 521_000 + SMOKE_MAX - 1 }, purpose: 'smoke', reservedAt });
  waveLedger.reserve({ bankId: 'hearthstone-portfolio1-prune', range: { start: 522_000, end: 522_000 + PRUNE_BLOCKS - 1 }, purpose: 'prune', reservedAt });
  waveLedger.reserve({ bankId: 'hearthstone-portfolio1-holdout', range: { start: 523_000, end: 523_000 + HOLDOUT_BLOCKS - 1 }, purpose: 'holdout', reservedAt });
  waveLedger.reserve({ bankId: 'hearthstone-portfolio1-regression', range: { start: 524_000, end: 524_000 + REGRESSION_BLOCKS - 1 }, purpose: 'regression', reservedAt });

  const CHALLENGE_N = 40;
  const CHALLENGE_SEED_BASE = 525_000;
  const CHALLENGE_BOT_SEED_BASE = 988_301;
  const challengeEntries: readonly WaveChallengeEntry[] = [
    { anchorId: L1_ANCHOR_ID, factory: hearthstoneMidBot as AnyBotFactory, role: 'feedback' },
    { anchorId: L2_ANCHOR_ID, factory: hearthstoneOpusBot as AnyBotFactory, role: 'feedback' },
  ];

  const waveConfig = {
    ...assembleWaveConfig(adapter, {
      waveId: 'portfolio-round1',
      candidates: waveCandidates,
      opponent: 'heuristic',
      ledger: waveLedger,
      recordedAt: now(),
      baselineFlags: latest.flags,
      baselineVersion: latest.version,
      tiers: {
        smoke: { bankId: 'hearthstone-portfolio1-smoke', sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 }, maxBlocks: SMOKE_MAX, minBlocks: 5 },
        prune: { bankId: 'hearthstone-portfolio1-prune', blocks: PRUNE_BLOCKS },
        holdout: { bankId: 'hearthstone-portfolio1-holdout', blocks: HOLDOUT_BLOCKS },
        regression: { bankId: 'hearthstone-portfolio1-regression', blocks: REGRESSION_BLOCKS },
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

  console.log('4) challenge 결과');
  const challengeTable: Record<string, Record<string, { winRate: number; blocks: number; winRateCI: { lower: number; upper: number } }>> = {};
  for (const entry of report.challengeResult ?? []) {
    challengeTable[entry.anchorId] ??= {};
    (challengeTable[entry.anchorId] as Record<string, { winRate: number; blocks: number; winRateCI: { lower: number; upper: number } }>)[
      entry.subject
    ] = { winRate: entry.winRate, blocks: entry.blocks, winRateCI: entry.winRateCI };
    console.log(`   ${entry.anchorId} vs ${entry.subject}: winRate=${pct(entry.winRate)} CI=${ciStr(entry)} blocks=${entry.blocks}`);
  }
  const v2ChallengeL2 = challengeTable[L2_ANCHOR_ID]?.['baseline'];
  console.log(`   v2(=subject:'baseline') vs L2 이번 라운드 재측정: winRate=${v2ChallengeL2 ? pct(v2ChallengeL2.winRate) : '(없음)'}`);

  console.log('5) adoption ledger 기록');
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

  console.log('6) registry 승격 — composeBotChecked/assembleFlags (ADR-0014), 후보 풀 = 이번 채택 터미널 + v2');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  const surfaceByFlag = new Map(adapter.strategySurface.map((spec) => [spec.flag, spec]));

  let promotedVersion: string | null = null;
  let promotedFlags: readonly string[] = latest.flags;
  let assembleResult: { flags: readonly string[]; excluded: readonly { flag: string; reason: string }[] } | null = null;

  if (adoptedFlags.length > 0) {
    const toCandidate = (flag: string, challengeScore: number | undefined): AssembleFlagsCandidate => {
      const assembly = surfaceByFlag.get(flag)?.assembly;
      return {
        flag,
        ...(assembly !== undefined ? { assembly } : {}),
        ...(challengeScore !== undefined ? { challengeScore } : {}),
      };
    };

    const pool: AssembleFlagsCandidate[] = [];
    // v2 stays a "터미널 도전자" (design spec's own instruction) — its
    // challengeScore comes from the wave's own subject:'baseline' row.
    for (const flag of latest.flags) {
      pool.push(toCandidate(flag, v2ChallengeL2?.winRate));
    }
    for (const flag of adoptedFlags) {
      pool.push(toCandidate(flag, challengeTable[L2_ANCHOR_ID]?.[flag]?.winRate));
    }
    assembleResult = assembleFlags(pool);
    console.log(`   assembleFlags 후보 풀: ${pool.map((c) => `${c.flag}(${c.challengeScore !== undefined ? pct(c.challengeScore) : 'n/a'})`).join(', ')}`);
    console.log(`   assembleFlags 결과 flags=[${assembleResult.flags.join(', ')}]`);
    if (assembleResult.excluded.length > 0) {
      for (const excluded of assembleResult.excluded) {
        console.log(`   excluded: ${excluded.flag} — ${excluded.reason}`);
      }
    } else {
      console.log('   excluded: (없음)');
    }

    composeBotChecked(adapter, assembleResult.flags);

    const lineage = registry.lineage(latest.version);
    const nextVersion = registry.register({
      version: `v${lineage.length + 1}`,
      flags: assembleResult.flags,
      parent: latest.version,
      createdAt: now(),
      sourceWaveId: report.waveId,
      notes:
        `portfolio-round1에서 assembleFlags(ADR-0014)로 승격: pool=[${pool.map((c) => c.flag).join(', ')}], ` +
        `excluded=[${assembleResult.excluded.map((e) => e.flag).join(', ') || '(없음)'}].`,
    });
    promotedVersion = nextVersion.version;
    promotedFlags = nextVersion.flags;
    console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
  } else {
    console.log('   채택된 후보 없음 — 승격 없음 (v2 유지)');
  }
  saveRegistry(ROOT_DIR, GAME_ID, registry);
  saveLedger(ROOT_DIR, GAME_ID, ledgerStore);

  console.log('7) 버킷 수율 계산 + 초기 배분(INITIAL_ALLOCATION, 이 게임의 첫 포트폴리오 라운드)');
  const verdictByFlag = new Map(report.results.map((result) => [result.flag, result.verdict]));
  const roundBaselineL2WinRate = v2ChallengeL2?.winRate ?? 0;

  const bucketOutcomes: BucketOutcome[] = BUCKET_ORDER.map((bucket) => {
    const bucketCandidates = candidates.filter((candidate) => candidate.bucket === bucket);
    const bucketAdvancing = bucketCandidates.filter((candidate) => advanced.some((row) => row.flag === candidate.flag));
    const adopted = bucketAdvancing.filter((candidate) => verdictByFlag.get(candidate.flag) === 'adopted').length;

    const deltas = bucketAdvancing
      .map((candidate) => challengeTable[L2_ANCHOR_ID]?.[candidate.flag]?.winRate)
      .filter((winRate): winRate is number => winRate !== undefined)
      .map((winRate) => winRate - roundBaselineL2WinRate);
    const challengeDelta = deltas.length > 0 ? deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length : 0;

    return { bucket, candidates: bucketCandidates.length, adopted, challengeDelta };
  });
  for (const outcome of bucketOutcomes) {
    console.log(`   ${outcome.bucket}: candidates=${outcome.candidates} adopted=${outcome.adopted} challengeDelta=${outcome.challengeDelta.toFixed(4)}`);
  }

  const currentAllocation = loadPortfolioState(ROOT_DIR, GAME_ID) ?? INITIAL_ALLOCATION;
  const nextAllocation = reallocate(currentAllocation, bucketOutcomes);
  savePortfolioState(ROOT_DIR, GAME_ID, nextAllocation);
  console.log('   재배분 결과:');
  for (const entry of nextAllocation) {
    console.log(`     ${entry.bucket}: ${(entry.share * 100).toFixed(1)}%`);
  }

  console.log('8) 초월 판정 트리거 검사 (vs L2 winRateCI.lower > 0.5, N=40)');
  interface TranscendenceEntry {
    readonly flag: string;
    readonly wasAdopted: boolean;
    readonly n40: { readonly winRate: number; readonly winRateCILower: number };
    readonly confirm: HeadToHeadResult;
    readonly confirmTriggered: boolean;
    readonly l3: HeadToHeadResult | null;
  }
  const transcendenceEntries: TranscendenceEntry[] = [];
  for (const entry of report.challengeResult ?? []) {
    if (entry.anchorId !== L2_ANCHOR_ID || entry.subject === 'baseline') continue;
    if (entry.winRateCI.lower <= TRANSCENDENCE_TRIGGER_THRESHOLD) continue;

    const flag = entry.subject;
    const wasAdopted = adoptedFlags.includes(flag);
    console.log(`   N=40 트리거됨: ${flag} (winRateCI.lower=${pct(entry.winRateCI.lower)}) — N=${CONFIRM_N} 확증 측정 실행`);
    const candidateBot = wasAdopted ? composeBotChecked(adapter, promotedFlags) : composeBot(adapter, [flag]);
    const confirmResult = runHeadToHead(adapter, candidateBot, hearthstoneOpusBot, seeds(CONFIRM_SEED_BASE, CONFIRM_N), CONFIRM_BOT_SEED_BASE);
    console.log(`   확증(N=${CONFIRM_N}) ${flag} vs L2: winRate=${pct(confirmResult.candidateWinRate)} CI=${ciStr(confirmResult)}`);

    const confirmTriggered = confirmResult.winRateCI.lower > TRANSCENDENCE_TRIGGER_THRESHOLD;
    let l3Result: HeadToHeadResult | null = null;
    if (confirmTriggered) {
      console.log(`   확증도 트리거 통과 — L3(${L3_ANCHOR_ID}) 홀드아웃 판정 실행 (N=${L3_N}, 게이트 없음)`);
      // Holdout guard: no LossReport/probe-bank generation from this result,
      // never wired through hearthstoneTempoBot's own source file — only the
      // wave-runner-level composed bot faces the L3 anchor here.
      const l3Anchor = registry.getAnchor(L3_ANCHOR_ID);
      if (!l3Anchor) {
        throw new Error(`hearthstone-portfolio-round1: anchor "${L3_ANCHOR_ID}" is not registered`);
      }
      l3Result = runHeadToHead(adapter, candidateBot, hearthstoneTempoBot, seeds(L3_SEED_BASE, L3_N), L3_BOT_SEED_BASE);
      console.log(`   L3 vs ${flag}: winRate=${pct(l3Result.candidateWinRate)} CI=${ciStr(l3Result)} blocks=${l3Result.blocks}`);
    } else {
      console.log(`   확증(N=${CONFIRM_N})에서는 트리거 미달 — L3 홀드아웃 미실행`);
    }
    transcendenceEntries.push({
      flag,
      wasAdopted,
      n40: { winRate: entry.winRate, winRateCILower: entry.winRateCI.lower },
      confirm: confirmResult,
      confirmTriggered,
      l3: l3Result,
    });
  }
  if (transcendenceEntries.length === 0) {
    console.log('   N=40에서 어떤 후보도 트리거 미달 — 확증/L3 홀드아웃 미실행');
  }

  console.log('9) runs/hearthstone/portfolio-round1.json 저장');
  const summary = {
    gameId: GAME_ID,
    generatedAt: now(),
    designSpecPath: 'scratchpad/hearthstone-round1-design-spec.md (main-loop, 그대로 구현)',
    b2Analysis: {
      note: '일회성 스크립트(삭제됨)로 probe-bank.json 200개를 encodeChoice 접두사(play/heroPower/attack)별 v2 불일치율 분류.',
      mismatchRateByChoiceKind: { play: 0.614, attack: 0.568, heroPower: 0.483 },
      targetedKind: 'play',
    },
    probeFilter: probeFilterRows.map((row) => ({
      flag: row.flag,
      bucket: row.bucket,
      agreementRate: row.probeScore.agreementRate,
      probesScored: row.probeScore.probes - row.probeScore.skipped,
      probesSkipped: row.probeScore.skipped,
      msPerGame: row.msPerGame,
      advanced: row.advanced,
    })),
    wave: {
      waveId: report.waveId,
      comparabilityKey: report.comparabilityKey,
      baselineFlags: latest.flags,
      results: report.results.map((result) => ({
        flag: result.flag,
        verdict: result.verdict,
        tiersPassed: result.tiersPassed,
      })),
    },
    challenge: challengeTable,
    adoption: {
      promotedVersion,
      adoptedFlags,
      assembleFlags: assembleResult ? { flags: assembleResult.flags, excluded: assembleResult.excluded } : null,
    },
    bucketOutcomes,
    portfolioAllocation: { previous: currentAllocation, next: nextAllocation },
    excludedBuckets: {
      'B5-imitate': '이번 라운드 0 후보 — 설계 명세에 B5 후보 없음(첫 포트폴리오 라운드, 6개 배치 지시가 실제로는 5개).',
    },
    transcendence:
      transcendenceEntries.length > 0
        ? {
            triggered: true,
            threshold: TRANSCENDENCE_TRIGGER_THRESHOLD,
            entries: transcendenceEntries.map((entry) => ({
              flag: entry.flag,
              wasAdopted: entry.wasAdopted,
              n40: entry.n40,
              confirmN: CONFIRM_N,
              confirmWinRate: entry.confirm.candidateWinRate,
              confirmWinRateCI: entry.confirm.winRateCI,
              confirmTriggered: entry.confirmTriggered,
              l3AnchorId: entry.l3 ? L3_ANCHOR_ID : null,
              l3N: entry.l3 ? L3_N : null,
              l3WinRate: entry.l3?.candidateWinRate ?? null,
              l3WinRateCI: entry.l3?.winRateCI ?? null,
              note: entry.l3 ? '홀드아웃 가드: LossReport/probe-bank 생성 없음 — 승률 숫자만 기록.' : undefined,
            })),
          }
        : {
            triggered: false,
            threshold: TRANSCENDENCE_TRIGGER_THRESHOLD,
            reason: '어떤 후보도 N=40 challenge vs L2 winRateCI.lower > 0.5에 도달하지 못함 — 확증/L3 홀드아웃 미실행.',
          },
  };
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round1.json'), JSON.stringify(summary, null, 2));
  console.log(`   저장: runs/${GAME_ID}/portfolio-round1.json`);
}

main();
