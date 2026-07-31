/**
 * dominion-portfolio-round4 — GAP-11 Phase 6 (main-loop design spec:
 * scratchpad/dominion-round4-design-spec.md, implemented as written), the
 * D5.5 portfolio protocol v2's steps 3-6, delegating steps 2-5 of DESIGN.md
 * §6.2 (probe filter -> wave -> challenge -> promotion -> reallocation) to
 * `artifacts/portfolio-round.ts`'s `runPortfolioRound` exactly as
 * dominion-portfolio-round3.ts does. This file keeps only game knowledge
 * (candidate batch, flag specs, probe-bank/anchor loading) plus the two
 * bespoke steps outside the shared executor's scope (transcendence check,
 * adoption ledger recording).
 *
 * Candidate batch (5 — B3x1, B1x2, B2x1, B4x1, all of them IS-MCTS variants
 * of registry v5, wired in via `withStrategyFlags` from
 * `shared/dominion-round4-candidates.ts` rather than baked into the adapter's
 * strategySurface, matching every prior dominion ismcts wave's precedent):
 *   - B3-deep (main-loop specified): `ismcts-s64-v2buy-adaptivetrash-prior` —
 *     v5's prior with only the trash axis swapped to chapelEconomyV3's
 *     adaptive Copper-trash floor knowledge.
 *   - B1-exploit (2): `ismcts-s64-v2buy-prior-w8` / `-w32` — priorWeight
 *     sweep around v5's fixed 16 (A5 axis local-optimum curve).
 *   - B2-opponent (1): `ismcts-s64-v2action-prior` — target re-selected from
 *     THIS round's mining (see the honest-record note below).
 *   - B4-explore (1): `ismcts-s64-v2buy-prior-precheck` — A3 전술 프리체크,
 *     dominion's axis matrix has A3 as 미시도 (ADR-0009 compliance).
 * B5-imitate is not used this round (0 candidates, recorded as a
 * BucketOutcome with candidates: 0 — same convention as rounds 1-3).
 *
 * HONEST RECORD — B3's premise did not survive this round's own mining.
 * The design spec picked B3 from round 3's finding that `chapelTrash`
 * re-emerged as the #1 mismatch (12.9%) — but that was measured against
 * `chapelEconomyV2`. dominion-loss-mining-round4.ts measured the actual
 * champion (v5) and found `chapelTrash` at **0.0% (0/511)**: the IS-MCTS
 * champion already agrees with the L2 anchor on every single trash decision
 * it faced. B3 therefore aims at a decision point with no remaining
 * disagreement to close, and the honest prior expectation is that it changes
 * nothing measurable. It is still implemented and run exactly as specified
 * (the spec is the main loop's call, and "the axis is already converged" is
 * itself a result worth measuring rather than asserting) — but the outcome is
 * recorded with that caveat attached, not as a surprise.
 * The same mining is what re-selected B2's target (the spec's bucket table
 * explicitly requires re-selection from this round's data): action 19.9%
 * (803/4044) > buy 18.9% (1091/5767) > chapelTrash 0.0%.
 *
 * Probe filter: round1+round2+round3+round4 probe banks (4 files) loaded and
 * scored together, deduped by probeId. Per-candidate 5-game cost check, then
 * round 1/3's top-4-of-5 cut (ranked by probe agreementRate desc, ties broken
 * by cheaper msPerGame). Every candidate this round is a search bot, so all
 * five are resource-rule-flagged: this script must be invoked under
 * `nice -n 10` externally and runs strictly sequentially in one process.
 *
 * Regression opponent = registry v5 (`ismcts-s64-v2buy-prior`), the design
 * spec's own instruction — passed as `regressionOpponentFlags`, which also
 * makes `computeChallengeResult` measure v5 itself under `subject: 'baseline'`
 * in this round's challenge table (used directly as v5's `challengeScore`
 * input to `assembleFlags`, an apples-to-apples comparison under this round's
 * own seeds rather than a reuse of the differently-seeded N=100 mining
 * figure). Smoke/prune/holdout tiers still use the `opponent: 'heuristic'`
 * raw baseline (dominion's own convention since round 1).
 *
 * Fresh seed ranges (verified non-overlapping with every prior dominion
 * runner's documented range — 400/401k, 420/421k, 429-431k, 439-441k,
 * 700/710/715/720/725/726/727k, 730/735/736/737k, anchor ladder 992k/993k):
 *   - probe-filter cost check: 740,000-740,004 (N=5, shared block).
 *   - wave smoke/prune/holdout/regression: 741,000+/742,000+/743,000+/744,000+
 *     (runPortfolioRound reserves these at fixed 1000-seed offsets from
 *     waveSeedBase=741,000).
 *   - challenge (L1/L2): 745,000-745,039 (N=40).
 *   - confirm (only if triggered): 746,000-746,199 (N=200).
 *   - L3 holdout (only if confirm also triggers): 747,000-747,099 (N=100).
 * Bot seed bases (fresh 995_1xx/995_3xx/995_5xx/995_7xx block): 995_101 (cost
 * check), 995_301 (challenge), 995_501 (confirm), 995_701 (L3 holdout).
 * PROBE_SCORE_BOT_SEED_BASE stays 986_201 (round 1/3's base — dominionOpusBot's
 * decide() never reads its seed parameter, so the base choice does not affect
 * self-consistency; round 2's doc comment carries the full argument).
 *
 * Promotion (composeBotChecked/assembleFlags, ADR-0014): candidate pool =
 * this round's adopted terminal flags + registry v5's own flag (the lineage
 * baseline, whose challengeScore comes from the wave's `subject: 'baseline'`
 * measurement). `opusCloneDominion` stays excluded from every lineage pool
 * (round 3's required design decision, carried forward — a full L2 clone's
 * ~50% mirror-match rate is not skill and must never become the bar an
 * independent design has to clear). `assembleFlags`'s `excluded` result is
 * logged and saved verbatim, never hidden.
 *
 * Transcendence check (protocol v2 step 5, order never skipped): only if the
 * N=40 challenge vs L2 shows winRateCI.lower > 0.5 is the N=200 confirmatory
 * measurement run; only if THAT also clears the threshold does the L3 holdout
 * head-to-head (external-style2-l3) run, at N=100, gate-free (no LossReport/
 * probe-bank generation from the holdout result). L3 never appears as a
 * regular challenge anchor.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import type { AnyBotFactory } from '../../contract/types';
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
import { dominionAdapter } from '../dominion';
import { dominionOpusBot } from '../experiments/dominion-opus-bot';
import { dominionMidBot } from '../experiments/dominion-mid-bot';
import { dominionEngineBot } from '../experiments/dominion-engine-bot';
import {
  DOMINION_V5_CHAMPION_FLAG,
  DOMINION_R4_B1_W8_FLAG,
  DOMINION_R4_B1_W32_FLAG,
  DOMINION_R4_B2_FLAG,
  DOMINION_R4_B3_FLAG,
  DOMINION_R4_B4_FLAG,
  dominionIsmctsV2BuyPriorFlagSpec,
  dominionIsmctsAdaptiveTrashPriorFlagSpec,
  dominionIsmctsPriorWeightSweepFlagSpec,
  dominionIsmctsV2ActionPriorFlagSpec,
  dominionIsmctsPrecheckFlagSpec,
} from './shared/dominion-round4-candidates';

const GAME_ID = 'dominion';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const PROBE_SCORE_BOT_SEED_BASE = 986_201;
const COST_CHECK_SEED_BASE = 740_000;
const COST_CHECK_N = 5;
const COST_CHECK_BOT_SEED_BASE = 995_101;

const WAVE_SEED_BASE = 741_000;
const CHALLENGE_SEED_BASE = 745_000;
const CHALLENGE_BOT_SEED_BASE = 995_301;
const CHALLENGE_N = 40;

const L1_ANCHOR_ID = 'external-mid-l1';
const L2_ANCHOR_ID = 'external-opus-l2';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRANSCENDENCE_TRIGGER_THRESHOLD = 0.5;

const CONFIRM_N = 200;
const CONFIRM_SEED_BASE = 746_000;
const CONFIRM_BOT_SEED_BASE = 995_501;

const L3_N = 100;
const L3_SEED_BASE = 747_000;
const L3_BOT_SEED_BASE = 995_701;

/** Excluded from every candidate pool, carried forward from round 3's
 * required design decision — v4's actual composed bot, a full L2 clone whose
 * ~50% win rate vs L2 is a mirror-match artifact, not skill. */
const EXCLUDED_LINEAGE_STARTS = new Set(['opusCloneDominion']);

/** This round's lineage baseline = the current champion, registry v5. */
const LINEAGE_BASELINE_FLAG = DOMINION_V5_CHAMPION_FLAG;

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
    { flag: DOMINION_R4_B3_FLAG, bucket: 'B3-deep' },
    { flag: DOMINION_R4_B1_W8_FLAG, bucket: 'B1-exploit' },
    { flag: DOMINION_R4_B1_W32_FLAG, bucket: 'B1-exploit' },
    { flag: DOMINION_R4_B2_FLAG, bucket: 'B2-opponent' },
    { flag: DOMINION_R4_B4_FLAG, bucket: 'B4-explore' },
  ];
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
  console.log(`=== dominion portfolio round 4 (GAP-11 Phase 6) — rootDir=${ROOT_DIR} ===`);

  const bareAdapter = eraseAdapter(dominionAdapter);
  const adapter = withStrategyFlags(bareAdapter, [
    dominionIsmctsV2BuyPriorFlagSpec(bareAdapter),
    dominionIsmctsAdaptiveTrashPriorFlagSpec(bareAdapter),
    dominionIsmctsPriorWeightSweepFlagSpec(bareAdapter, DOMINION_R4_B1_W8_FLAG, 8),
    dominionIsmctsPriorWeightSweepFlagSpec(bareAdapter, DOMINION_R4_B1_W32_FLAG, 32),
    dominionIsmctsV2ActionPriorFlagSpec(bareAdapter),
    dominionIsmctsPrecheckFlagSpec(bareAdapter),
  ]);

  console.log('1) 후보 배치 생성 (B3x1, B1x2, B2x1, B4x1 = 5)');
  const candidates = buildCandidates();
  for (const candidate of candidates) {
    console.log(`   ${candidate.bucket}: ${candidate.flag}`);
  }
  console.log(
    '   정직 기록: B3의 전제(3회전 chapelTrash 12.9% 재부상)는 이번 라운드 채굴에서 무효화됨 — ' +
      'v5 기준 chapelTrash 불일치 0.0%(0/511). 그래도 설계 명세대로 실행하고 결과를 그대로 기록한다.',
  );

  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const ledgerStore = loadOrCreateLedger(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined || latest.version !== 'v5') {
    throw new Error(
      `dominion-portfolio-round4: registry latest=${latest?.version ?? '(none)'} — expected v5 (run dominion-portfolio-round3.ts's promotion first)`,
    );
  }
  console.log(`   registry latest=${latest.version} flags=[${latest.flags.join(', ')}] — 계보 기준선 겸 regression 상대`);

  console.log('2) 프로브 필터 (round1~round4 프로브 은행 합산 채점, 판당 비용 실측 각 5판, 상위 4 진출)');
  const probesRound1 = loadProbeBank(join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank.json'));
  const probesRound2 = loadProbeBank(join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round2.json'));
  const probesRound3 = loadProbeBank(join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round3.json'));
  const probesRound4 = loadProbeBank(join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round4.json'));

  console.log('3-7) 정규 웨이브 -> challenge -> 승격 -> 재배분 (artifacts/portfolio-round.ts runPortfolioRound)');
  const recordedAt = now();
  const currentAllocation = loadPortfolioState(ROOT_DIR, GAME_ID) ?? INITIAL_ALLOCATION;
  const outputPath = join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round4.json');

  const round = runPortfolioRound({
    gameId: GAME_ID,
    rootDir: ROOT_DIR,
    adapter,
    candidates,
    probeFilter: {
      probeBanks: [probesRound1, probesRound2, probesRound3, probesRound4],
      probeScoreSeedBase: PROBE_SCORE_BOT_SEED_BASE,
      costCheckN: COST_CHECK_N,
      costCheckSeedBase: COST_CHECK_SEED_BASE,
      costCheckOpponent: dominionOpusBot,
      costCheckBotSeedBase: COST_CHECK_BOT_SEED_BASE,
      advanceTopK: 4,
      costMultiplierFlags: new Set(candidates.map((c) => c.flag)),
    },
    wave: {
      waveId: 'portfolio-round4',
      waveSeedBase: WAVE_SEED_BASE,
      tiers: {
        smoke: { sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 }, maxBlocks: 30, minBlocks: 5 },
        prune: { blocks: 15 },
        holdout: { blocks: 15 },
        regression: { blocks: 20 },
      },
      regressionOpponentFlags: [LINEAGE_BASELINE_FLAG],
      comparabilityContext: undefined,
    },
    challenge: {
      anchors: [
        { anchorId: L1_ANCHOR_ID, factory: dominionMidBot as AnyBotFactory },
        { anchorId: L2_ANCHOR_ID, factory: dominionOpusBot as AnyBotFactory },
      ],
      seedBase: CHALLENGE_SEED_BASE,
      botSeedBase: CHALLENGE_BOT_SEED_BASE,
      n: CHALLENGE_N,
    },
    promotion: {
      latestVersionFlags: [LINEAGE_BASELINE_FLAG],
      latestVersionAssembly: {},
      excludeFromLineage: EXCLUDED_LINEAGE_STARTS,
      registry,
      notesPrefix: 'portfolio-round4에서 ',
    },
    bucketAllocation: { current: currentAllocation },
    outputPath,
    recordedAt,
    clockNowMs: Date.now,
  });

  for (const row of round.probeFilter) {
    console.log(
      `   프로브: ${row.flag} agreement=${pct(row.probeScore.agreementRate)} msPerGame=${row.msPerGame.toFixed(0)} advanced=${row.advanced}`,
    );
  }
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
    console.log('   채택된 후보 없음 — 승격 없음 (v5 유지)');
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

  console.log('10) near-miss 추출 + runs/dominion/portfolio-round4.json 저장(설계 결정/transcendence 추가 병합)');
  const nearMiss = extractNearMissCandidates(adoptionRecord, round.criteria);
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round4-near-miss.json'), JSON.stringify(nearMiss, null, 2));

  const summary = {
    gameId: GAME_ID,
    generatedAt: recordedAt,
    designSpecPath: 'scratchpad/dominion-round4-design-spec.md (main-loop, 그대로 구현)',
    honestRecord: {
      b3PremiseInvalidated: {
        flag: DOMINION_R4_B3_FLAG,
        specPremise: '3회전 채굴(chapelEconomyV2 대상)에서 chapelTrash 불일치 12.9%로 최다 재부상.',
        round4Measurement: 'v5(현 챔피언) 대상 재채굴에서 chapelTrash 불일치 0.0% (0/511) — 이미 L2와 완전 수렴.',
        decision:
          '설계 명세대로 그대로 구현·실행하되, "이미 수렴한 축을 겨냥한 후보"라는 사전 진단을 명시 기록한다. 결과가 무변화여도 그것이 정직한 결과.',
      },
      b2TargetReselection: {
        flag: DOMINION_R4_B2_FLAG,
        reason:
          '설계 명세가 요구한 "이번 라운드 데이터로 재선정" 이행 — 4회전 채굴 불일치율: action 19.9%(803/4044) > buy 18.9%(1091/5767) > chapelTrash 0.0%(0/511). 최다 지점인 action을 표적으로 삼고, v5의 prior 중 playAction 분기만 chapelEconomyV2의 action 지식으로 교체.',
      },
    },
    requiredDesignDecision: {
      excludedFromLineagePool: [...EXCLUDED_LINEAGE_STARTS],
      lineageBaselineFlag: LINEAGE_BASELINE_FLAG,
      note: 'opusCloneDominion(L2 완전 클론)은 3회전에 이어 계보 후보 풀에서 계속 배제 — registry에서 제거하지는 않음.',
    },
    probeBankSources: {
      round1: { path: `runs/${GAME_ID}/probe-bank.json`, probes: probesRound1.length },
      round2: { path: `runs/${GAME_ID}/probe-bank-round2.json`, probes: probesRound2.length },
      round3: { path: `runs/${GAME_ID}/probe-bank-round3.json`, probes: probesRound3.length },
      round4: { path: `runs/${GAME_ID}/probe-bank-round4.json`, probes: probesRound4.length },
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
  console.log(`   저장: runs/${GAME_ID}/portfolio-round4.json`);
}

main();
