/**
 * dominion-portfolio-round3 — GAP-11 Phase 5 second half (team-lead
 * instruction, main-loop design spec: scratchpad/dominion-round3-design-
 * spec.md, implemented verbatim), following dominion-portfolio-round1.ts/
 * dominion-portfolio-round2.ts's own precedent (candidate batch -> probe
 * filter -> wave -> challenge -> bookkeeping -> transcendence check), plus
 * this round's own new requirement: the promotion step is the first live use
 * of `composeBotChecked`/`assembleFlags` (ADR-0014, src/loop/compose.ts).
 *
 * GAP-ANALYSIS-12.md E1 refactor (2026-07-31, scratchpad/e1-round-executor-
 * design-spec.md): steps 2-5 of DESIGN.md §6.2 (probe filter -> wave ->
 * challenge -> promotion -> reallocation) now delegate to
 * `artifacts/portfolio-round.ts`'s `runPortfolioRound` — this file keeps
 * only game knowledge (candidate batch, IS-MCTS flag spec, probe-bank/anchor
 * loading) and this round's own bespoke steps outside the shared executor's
 * scope (transcendence check, adoption ledger recording). Re-run with the
 * same seeds against the pre-refactor commit (2d6cd67)'s
 * runs/dominion/portfolio-round3.json confirmed byte-identical probeFilter
 * agreementRate, wave verdicts, challenge winRate, and adoption flags.
 *
 * Required design decision (design-spec's own instruction, "그대로 구현"):
 * registry v4's actual composed bot is `opusCloneDominion` (a full L2 clone —
 * composeBot's override semantics collapse v4's flags list to that one
 * terminal flag, ADR-0014). A clone's ~50% win rate against the very anchor
 * it clones is a statistical mirror-match artifact, not skill — it must
 * never be used as this round's comparison baseline, or no independently
 * designed candidate could ever be adopted ("scored lower than the clone").
 * This round's lineage baseline is instead `chapelEconomyV2` (42.0% vs L2,
 * round-3 re-measurement, dominion-loss-mining-round3.ts) — the promotion
 * step's candidate pool explicitly excludes opusCloneDominion (the registry
 * itself is untouched; this is only "next lineage start point" exclusion).
 *
 * Candidate batch (5 — B3x1, B1x2, B2x1, B4x1, matching round2's own
 * "header says 6, body specifies 5" precedent: the design spec's retroactive
 * `assembly: 'terminal'` declaration on chapelEconomyV2 is metadata, not a
 * 6th wave candidate). All 5 registered on dominionAdapter.strategySurface in
 * ../dominion.ts under "GAP-11 Phase 5 round-3 candidate batch" (see that
 * doc comment for full per-candidate design rationale) except the B4 IS-MCTS
 * candidate, which (matching every prior dominion ismcts wave's own
 * precedent) is wired in below via `withStrategyFlags` rather than baked
 * into the adapter's own strategySurface:
 *   - B3-deep (1): `chapelEconomyV3` — chapelEconomyV2's buy/action reused
 *     verbatim, chapelTrash's fixed Copper-trash floor replaced with an
 *     adaptive one derived from estimated game-length progress (targets the
 *     round-3 LossReport's #1 mismatch, chapelTrash's re-emergence at 12.9%).
 *   - B1-exploit (2): `chapelEconomyV3-aggressive`/`chapelEconomyV3-
 *     conservative` — one step more/less aggressive on the same adaptive
 *     floor range.
 *   - B2-opponent (1): `chapelEconomyV2-witchFirst` — targets the round-3
 *     LossReport's #2 mismatch (buy, 10.7%) via a Witch/Laboratory buy-order
 *     reorder, independent of B3's trash-floor axis.
 *   - B4-explore (1): `ismcts-s64-v2buy-prior` — SO-ISMCTS (s64 budget,
 *     ADR-0009, unchanged from every prior dominion ismcts wave) using
 *     `dominionV2BuyPriorEvaluator` (chapelEconomyV2's own buy-priority
 *     knowledge, not the adapter's generic `choiceEvaluator`) as
 *     `MctsConfig.priorEvaluator` — a genuinely new prior-source combination,
 *     distinct from round1's B4 (`ismcts-s64-prior-w16`, generic
 *     choiceEvaluator, pruned at challenge L2=0%) per ADR-0009's "같은 조합
 *     반복 금지" rule.
 * B5-imitate is not used this round (0 candidates, recorded as a
 * BucketOutcome with candidates: 0 — same convention as round1/round2's own
 * B5-imitate exclusion).
 *
 * Probe filter: round1+round2+round3 probe banks (3 files) loaded and scored
 * together, deduped by probeId (mergeProbeBanks, now shared in
 * portfolio-round.ts). Per-candidate cost check (5 games) same as
 * round1/round2; unlike round2 (all 5 candidates advanced, no cut), this
 * round applies round1's own top-4-of-5 cut (ranked by probe agreementRate
 * desc, ties broken by cheaper msPerGame) — team-lead instruction "상위 4
 * 진출". The B4 IS-MCTS candidate is the resource-rule-flagged one
 * (heuristic candidates are cheap; only B4 needs the sequential/nice-precheck
 * the team lead specified) — this script must be invoked under `nice -n 10`
 * externally (this file cannot set OS scheduling priority on itself), and
 * the 5-game cost check already runs every candidate (including B4) strictly
 * sequentially in one process, satisfying "사전 5판 비용 확인".
 *
 * Regression opponent = chapelEconomyV2 (design spec's own instruction, NOT
 * v4/latest.flags): achieved by passing `regressionOpponentFlags:
 * [LINEAGE_BASELINE_FLAG]` (not `latest.flags`, which round2 used for its
 * v3-champion regression opponent) — `wave-runner.ts`'s
 * `computeChallengeResult` also measures this same composite under
 * `subject: 'baseline'` in the challenge table for free, which is exactly
 * chapelEconomyV2's own N=40-vs-L1/L2 challenge score under this round's own
 * seeds (used directly as chapelEconomyV2's `challengeScore` input to
 * `assembleFlags` below, for an apples-to-apples comparison against this
 * round's own candidates rather than reusing the differently-seeded N=100
 * figure from loss-mining-round3). Smoke/prune/holdout tiers still use the
 * `opponent: 'heuristic'` raw baseline (round1/round2's own convention —
 * "티어는 도미니언 관행").
 *
 * Fresh seed ranges (verified non-overlapping with every prior dominion
 * runner's own documented range — see dominion-portfolio-round2.ts's own doc
 * comment for the full list through 727,000-727,099/989_1xx-989_7xx, plus
 * dominion-loss-mining-round3.ts's 429,000+/430,000+/431,000+ and
 * 990_1xx-990_3xx):
 *   - probe-filter cost check: 730,000-730,004 (N=5, shared block).
 *   - wave smoke/prune/holdout/regression: 731,000+/732,000+/733,000+/734,000+
 *     (runPortfolioRound reserves these at fixed 1000-seed offsets from
 *     waveSeedBase=731_000 — the exact convention this file used manually
 *     before the E1 refactor).
 *   - challenge (L1/L2): 735,000-735,039 (N=40).
 *   - confirm (only if triggered): 736,000-736,199 (N=200).
 *   - transcendence L3 holdout (only if confirm also triggers): 737,000-737,099 (N=100).
 * Bot seed bases (fresh 991_1xx/991_3xx/991_5xx/991_7xx block, distinct from
 * every dominion base used above): 991_101 (cost check/probe filter),
 * 991_301 (challenge), 991_501 (confirm), 991_701 (L3 holdout).
 * PROBE_SCORE_BOT_SEED_BASE stays 986_201 (round1's base — dominionOpusBot's
 * decide() never reads its seed parameter, so the base choice does not
 * affect self-consistency; round2's own doc comment has the full argument).
 *
 * Resource rule (team lead's instruction): heuristic-class candidates
 * (B1/B2/B3, 4 of the 5) are cheap; only B4 (IS-MCTS) needs sequential
 * execution / nice -n 10 / a pre-wave 5-game cost check, all satisfied by
 * this script's structure (single Node process, cost check runs before the
 * wave, external `nice -n 10` invocation required at launch time).
 *
 * Promotion (design spec + team-lead instruction, first live
 * `composeBotChecked`/`assembleFlags` use): candidate pool = this round's
 * adopted terminal flags + chapelEconomyV2 (lineage baseline, included even
 * though it is not itself a wave candidate this round — its challengeScore
 * comes from the wave's own `subject: 'baseline'` challenge measurement) +
 * this round's adopted decorator flags (if any — none of this round's 5
 * candidates declare `assembly: 'decorator'`, so expected empty).
 * opusCloneDominion is never added to this pool (the design spec's required
 * decision, above, enforced via `promotion.excludeFromLineage`).
 * `assembleFlags`'s `excluded` result is logged and saved verbatim, never
 * hidden. v5 branches from v4 (`parent: 'v4'`) but its `flags` is
 * `assembleFlags`'s result, NOT `[...latest.flags, ...adopted]` (round2's own
 * promotion shape) — that would re-append the surviving terminal after
 * possibly-stale decorators and risk resurrecting the exact multi-terminal
 * ambiguity ADR-0014 exists to catch.
 *
 * Transcendence check (team lead's instruction, matching round2's own
 * shape): if the N=40 challenge vs L2 already shows winRateCI.lower > 0.5,
 * re-measure at N=200 (confirmatory) — only if that also clears the
 * threshold does this script run the L3 holdout head-to-head
 * (external-style2-l3, dominion-anchor-ladder.ts's holdout anchor) at N=100,
 * gate-free (no LossReport/probe-bank generation from the holdout result).
 * Unlike round2, this round's design spec explicitly omits L3 from the
 * regular challenge step (`challenge L1/L2(N=40) ... L3 미포함`) — L3 only
 * ever runs inside this transcendence branch, never as a regular challenge
 * entry.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import type { AnyBotFactory, AnyGameAdapter, PlayerId } from '../../contract/types';
import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { loadProbeBank } from '../../artifacts/trajectory-archive';
import {
  loadOrCreateLedger,
  loadOrCreateRegistry,
  saveLedger,
  saveRegistry,
} from '../../artifacts/game-state';
import { extractNearMissCandidates, type AdoptionEntry } from '../../artifacts/adoption-ledger';
import { INITIAL_ALLOCATION, loadPortfolioState } from '../../artifacts/portfolio';
import { runPortfolioRound, type RoundCandidateSpec } from '../../artifacts/portfolio-round';
import { ismctsBotFactory } from '../../search/ismcts';
import type { MctsConfig } from '../../search/mcts';
import {
  dominionAdapter,
  dominionV2BuyPriorEvaluator,
  type DominionState,
  type DominionChoice,
} from '../dominion';
import { dominionOpusBot } from '../experiments/dominion-opus-bot';
import { dominionMidBot } from '../experiments/dominion-mid-bot';
import { dominionEngineBot } from '../experiments/dominion-engine-bot';
import type { StrategyFlagSpec } from '../../contract/types';

const GAME_ID = 'dominion';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const PROBE_SCORE_BOT_SEED_BASE = 986_201;
const COST_CHECK_SEED_BASE = 730_000;
const COST_CHECK_N = 5;
const COST_CHECK_BOT_SEED_BASE = 991_101;

const L1_ANCHOR_ID = 'external-mid-l1';
const L2_ANCHOR_ID = 'external-opus-l2';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRANSCENDENCE_TRIGGER_THRESHOLD = 0.5;

const CONFIRM_N = 200;
const CONFIRM_SEED_BASE = 736_000;
const CONFIRM_BOT_SEED_BASE = 991_501;

const L3_N = 100;
const L3_SEED_BASE = 737_000;
const L3_BOT_SEED_BASE = 991_701;

/** Excluded from every candidate pool this round (design spec's required
 * decision) — v4's actual composed bot, a full L2 clone whose ~50% win rate
 * vs L2 is a mirror-match statistical artifact, not skill. */
const EXCLUDED_LINEAGE_STARTS = new Set(['opusCloneDominion']);

/** This round's lineage baseline (design spec) — not itself a wave
 * candidate, but always included in the promotion candidate pool. Its
 * challengeScore comes from this wave's own `subject: 'baseline'` challenge
 * row (see file doc comment). */
const LINEAGE_BASELINE_FLAG = 'chapelEconomyV2';

const B4_ISMCTS_FLAG = 'ismcts-s64-v2buy-prior';

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

function buildCandidates(): readonly RoundCandidateSpec[] {
  return [
    { flag: 'chapelEconomyV3', bucket: 'B3-deep' },
    { flag: 'chapelEconomyV3-aggressive', bucket: 'B1-exploit' },
    { flag: 'chapelEconomyV3-conservative', bucket: 'B1-exploit' },
    { flag: 'chapelEconomyV2-witchFirst', bucket: 'B2-opponent' },
    { flag: B4_ISMCTS_FLAG, bucket: 'B4-explore' },
  ];
}

/**
 * Widens `dominionV2BuyPriorEvaluator` (typed against DominionState/
 * DominionChoice in ../dominion.ts) to the erased `MctsConfig.priorEvaluator`
 * signature — same type-level-cast-only pattern as gomoku's own
 * `erasePriorEvaluator` (shared/gomoku-round1-candidates.ts).
 */
function eraseDominionPriorEvaluator(
  evaluator: (state: DominionState, player: PlayerId, choices: readonly DominionChoice[]) => readonly number[],
): (state: unknown, player: PlayerId, choices: readonly unknown[]) => readonly number[] {
  return (state, player, choices) => evaluator(state as DominionState, player, choices as readonly DominionChoice[]);
}

/**
 * B4's IS-MCTS candidate: s64 budget (ADR-0009, unchanged from every prior
 * dominion ismcts wave), rollout policy 'heuristic' (matches ismcts-s64-hr's
 * own precedent), `priorEvaluator` = chapelEconomyV2's own buy-priority
 * knowledge (`dominionV2BuyPriorEvaluator`) rather than the adapter's generic
 * `choiceEvaluator` — a new prior-source combination distinct from round1's
 * B4 (ADR-0009's "같은 조합 반복 금지"). `apply()` ignores `base` entirely
 * (same convention as every other search-based flag spec in this codebase).
 */
function dominionIsmctsV2BuyPriorFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  const config: MctsConfig = {
    simulations: 64,
    uctC: 1.4,
    rolloutCount: 1,
    rolloutPolicy: 'heuristic',
    label: 's64-v2buy-prior',
    priorWeight: 16,
    priorEvaluator: eraseDominionPriorEvaluator(dominionV2BuyPriorEvaluator),
  };
  return {
    flag: B4_ISMCTS_FLAG,
    description:
      'B4 explore (A5 tree prior, GAP-11 Phase 5, new combination per ADR-0009): SO-ISMCTS search candidate using dominionV2BuyPriorEvaluator (chapelEconomyV2\'s own buy-priority knowledge, injected via MctsConfig.priorEvaluator) as its prior, s64 simulation budget unchanged from every prior dominion ismcts wave; ignores the base bot entirely.',
    apply: () => ismctsBotFactory(adapter, config),
    assembly: 'terminal',
  };
}

interface TranscendenceEntry {
  readonly flag: string;
  readonly wasAdopted: boolean;
  readonly n40: { readonly winRate: number; readonly winRateCILower: number };
  readonly confirm: HeadToHeadResult;
  readonly confirmTriggered: boolean;
  readonly l3: HeadToHeadResult | null;
}

function main(): void {
  console.log(`=== dominion portfolio round 3 (GAP-11 Phase 5) — rootDir=${ROOT_DIR} ===`);

  const bareAdapter = eraseAdapter(dominionAdapter);
  const ismctsFlagSpec = dominionIsmctsV2BuyPriorFlagSpec(bareAdapter);
  const adapter = withStrategyFlags(bareAdapter, [ismctsFlagSpec]);

  console.log('1) 후보 배치 생성 (B3x1, B1x2, B2x1, B4x1 = 5)');
  const candidates = buildCandidates();
  for (const candidate of candidates) {
    console.log(`   ${candidate.bucket}: ${candidate.flag}`);
  }

  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const ledgerStore = loadOrCreateLedger(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined || latest.version !== 'v4') {
    throw new Error(
      `dominion-portfolio-round3: registry latest=${latest?.version ?? '(none)'} — expected v4 (run dominion-portfolio-round2.ts's promotion first)`,
    );
  }
  console.log(
    `   registry latest=${latest.version} flags=[${latest.flags.join(', ')}] (composeBot 덮어쓰기로 실제 = opusCloneDominion 단독) — ` +
      `이번 라운드 계보 기준선은 ${LINEAGE_BASELINE_FLAG}(클론 제외, 설계 명세 필수 결정)`,
  );

  console.log('2) 프로브 필터 (round1+round2+round3 프로브 은행 합산 채점, 판당 비용 실측 각 5판, 상위 4 진출)');
  const probeBankRound1Path = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank.json');
  const probeBankRound2Path = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round2.json');
  const probeBankRound3Path = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round3.json');
  const probesRound1 = loadProbeBank(probeBankRound1Path);
  const probesRound2 = loadProbeBank(probeBankRound2Path);
  const probesRound3 = loadProbeBank(probeBankRound3Path);

  console.log('3-7) 정규 웨이브 -> challenge -> 승격 -> 재배분 (artifacts/portfolio-round.ts runPortfolioRound)');
  const recordedAt = now();
  const currentAllocation = loadPortfolioState(ROOT_DIR, GAME_ID) ?? INITIAL_ALLOCATION;
  const outputPath = join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round3.json');

  const round = runPortfolioRound({
    gameId: GAME_ID,
    rootDir: ROOT_DIR,
    adapter,
    candidates,
    probeFilter: {
      probeBanks: [probesRound1, probesRound2, probesRound3],
      probeScoreSeedBase: PROBE_SCORE_BOT_SEED_BASE,
      costCheckN: COST_CHECK_N,
      costCheckSeedBase: COST_CHECK_SEED_BASE,
      costCheckOpponent: dominionOpusBot,
      costCheckBotSeedBase: COST_CHECK_BOT_SEED_BASE,
      advanceTopK: 4,
    },
    wave: {
      waveId: 'portfolio-round3',
      waveSeedBase: 731_000,
      tiers: {
        smoke: { sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 }, maxBlocks: 30, minBlocks: 5 },
        prune: { blocks: 15 },
        holdout: { blocks: 15 },
        regression: { blocks: 20 },
      },
      // this round's lineage baseline, NOT latest.flags (design spec's own instruction).
      regressionOpponentFlags: [LINEAGE_BASELINE_FLAG],
      comparabilityContext: undefined,
    },
    challenge: {
      anchors: [
        { anchorId: L1_ANCHOR_ID, factory: dominionMidBot as AnyBotFactory },
        { anchorId: L2_ANCHOR_ID, factory: dominionOpusBot as AnyBotFactory },
      ],
      seedBase: 735_000,
      botSeedBase: 991_301,
      n: 40,
    },
    promotion: {
      // Lineage baseline first (design spec's own instruction: chapelEconomyV2
      // stays a "터미널 도전자" — if nothing new beats it on challengeScore,
      // it survives assembleFlags's terminal tie-break).
      latestVersionFlags: [LINEAGE_BASELINE_FLAG],
      latestVersionAssembly: {},
      excludeFromLineage: EXCLUDED_LINEAGE_STARTS,
      registry,
      notesPrefix:
        'portfolio-round3에서 ',
    },
    bucketAllocation: { current: currentAllocation },
    outputPath,
    recordedAt,
    clockNowMs: Date.now,
  });

  for (const result of round.wave.results) {
    console.log(`   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`);
  }
  const lineageBaselineL2 = round.challenge[L2_ANCHOR_ID]?.['baseline'];
  console.log(
    `   ${LINEAGE_BASELINE_FLAG}(=subject:'baseline') vs L2 이번 라운드 재측정: winRate=${lineageBaselineL2 ? pct(lineageBaselineL2.winRate) : '(없음)'}`,
  );
  if (round.adoption.promotedVersion) {
    console.log(`   승격: ${round.adoption.promotedVersion}, flags=[${round.adoption.assembleFlagsResult?.flags.join(', ') ?? ''}]`);
  } else {
    console.log('   채택된 후보 없음 — 승격 없음 (v4 유지, opusCloneDominion 실체 문제는 이번 라운드 미해결로 남음)');
  }
  console.log('   재배분 결과:');
  for (const entry of round.nextAllocation) {
    console.log(`     ${entry.bucket}: ${(entry.share * 100).toFixed(1)}%`);
  }

  console.log('8) adoption ledger 기록');
  const entries: AdoptionEntry[] = round.wave.results.map((result) => {
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
    waveId: round.wave.waveId,
    recordedAt,
    comparabilityKey: round.wave.comparabilityKey,
    baselineVersion: latest.version,
    opponentId: 'heuristic',
    entries,
    nextLoopNotes: [],
  });

  saveRegistry(ROOT_DIR, GAME_ID, registry);
  saveLedger(ROOT_DIR, GAME_ID, ledgerStore);

  console.log('9) 초월 판정 트리거 검사 (vs L2 winRateCI.lower > 0.5, N=40)');
  const promotedFlags = round.adoption.assembleFlagsResult?.flags ?? latest.flags;
  const adoptedFlags = round.adoption.adoptedFlags;
  const transcendenceEntries: TranscendenceEntry[] = [];
  for (const entry of round.wave.challengeResult ?? []) {
    if (entry.anchorId !== L2_ANCHOR_ID || entry.subject === 'baseline') {
      continue;
    }
    if (entry.winRateCI.lower <= TRANSCENDENCE_TRIGGER_THRESHOLD) {
      continue;
    }
    const flag = entry.subject;
    const wasAdopted = adoptedFlags.includes(flag);
    console.log(`   N=40 트리거됨: ${flag} (winRateCI.lower=${pct(entry.winRateCI.lower)}) — N=${CONFIRM_N} 확증 측정 실행`);
    const candidateBot = wasAdopted ? composeBot(adapter, promotedFlags) : composeBot(adapter, [flag]);
    const confirmResult = runHeadToHead(adapter, candidateBot, dominionOpusBot, seeds(CONFIRM_SEED_BASE, CONFIRM_N), CONFIRM_BOT_SEED_BASE);
    console.log(`   확증(N=${CONFIRM_N}) ${flag} vs L2: winRate=${pct(confirmResult.candidateWinRate)} CI=${ciStr(confirmResult)}`);

    const confirmTriggered = confirmResult.winRateCI.lower > TRANSCENDENCE_TRIGGER_THRESHOLD;
    let l3Result: HeadToHeadResult | null = null;
    if (confirmTriggered) {
      console.log(`   확증도 트리거 통과 — L3(${L3_ANCHOR_ID}) 홀드아웃 판정 실행 (N=${L3_N}, 게이트 없음)`);
      l3Result = runHeadToHead(adapter, candidateBot, dominionEngineBot, seeds(L3_SEED_BASE, L3_N), L3_BOT_SEED_BASE);
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

  console.log('10) near-miss 추출 + runs/dominion/portfolio-round3.json 저장(설계 결정/transcendence 추가 병합)');
  const nearMiss = extractNearMissCandidates(adoptionRecord, round.criteria);
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round3-near-miss.json'), JSON.stringify(nearMiss, null, 2));

  const summary = {
    gameId: GAME_ID,
    generatedAt: recordedAt,
    designSpecPath: 'scratchpad/dominion-round3-design-spec.md (main-loop, 그대로 구현) + GAP-ANALYSIS-12.md E1 리팩터',
    requiredDesignDecision: {
      excludedFromLineagePool: [...EXCLUDED_LINEAGE_STARTS],
      lineageBaselineFlag: LINEAGE_BASELINE_FLAG,
      note: 'v4의 실체(opusCloneDominion, L2 완전 클론)는 다음 계보 시작점 후보에서 배제 — registry에서 제거하지 않음.',
    },
    registryV4: {
      flagsList: latest.flags,
      actualDominantFlag: 'opusCloneDominion',
      note: 'composeBot 덮어쓰기 시맨틱상(ADR-0014) v4의 실체는 opusCloneDominion 단독(L2 클론) — 이번 라운드 계보 기준선이 아님.',
    },
    probeBankSources: {
      round1: { path: `runs/${GAME_ID}/probe-bank.json`, probes: probesRound1.length },
      round2: { path: `runs/${GAME_ID}/probe-bank-round2.json`, probes: probesRound2.length },
      round3: { path: `runs/${GAME_ID}/probe-bank-round3.json`, probes: probesRound3.length },
    },
    probeFilter: round.probeFilter.map((row) => ({
      flag: row.flag,
      bucket: row.bucket,
      agreementRate: row.probeScore.agreementRate,
      probesScored: row.probeScore.probes - row.probeScore.skipped,
      probesSkipped: row.probeScore.skipped,
      msPerGame: row.msPerGame,
      advanced: row.advanced,
    })),
    wave: {
      waveId: round.wave.waveId,
      comparabilityKey: round.wave.comparabilityKey,
      baselineFlags: [LINEAGE_BASELINE_FLAG],
      results: round.wave.results.map((result) => ({
        flag: result.flag,
        verdict: result.verdict,
        tiersPassed: result.tiersPassed,
      })),
    },
    challenge: round.challenge,
    adoption: {
      promotedVersion: round.adoption.promotedVersion,
      adoptedFlags: round.adoption.adoptedFlags,
      assembleFlags: round.adoption.assembleFlagsResult
        ? { flags: round.adoption.assembleFlagsResult.flags, excluded: round.adoption.assembleFlagsResult.excluded }
        : null,
    },
    bucketOutcomes: round.bucketOutcomes,
    portfolioAllocation: { previous: currentAllocation, next: round.nextAllocation },
    excludedBuckets: {
      'B5-imitate': '이번 라운드 0 후보.',
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
  writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  console.log(`   저장: runs/${GAME_ID}/portfolio-round3.json`);
}

main();
