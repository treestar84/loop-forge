/**
 * gomoku-portfolio-round4 — GAP-11 Phase 6 round4 (팀리드 지시, 메인 루프
 * Fable의 B3 심층 설계: scratchpad gomoku-round4-design-spec.md 그대로
 * 구현), following gomoku-portfolio-round2.ts/gomoku-portfolio-round3-
 * diagnostic.ts's own precedent (candidate batch -> probe filter -> wave ->
 * challenge -> bookkeeping -> transcendence check), plus this round's own
 * new requirement (matching dominion-portfolio-round3.ts's own first use):
 * the promotion step uses `composeBotChecked`/`assembleFlags` (ADR-0014).
 *
 * Candidate batch (5, ./shared/gomoku-round4-candidates.ts's own doc comment
 * has the full per-candidate design rationale): `gomokuCloneTiebreak`
 * (B3-deep, 메인 루프 본안, 비-MCTS evaluator-argmax), its 2 epsilon-sweep
 * derivatives (B1-exploit), `mcts14-s256-jumpthree-w16` (B2-opponent, 실행
 * 에이전트 설계), `mcts13-s256-clone-chainprior` (B4-explore, 팀리드 배치
 * "A5×A10 진짜 결합").
 *
 * Pre-wave diagnostic (design spec's own instruction, "사전 소형 진단으로
 * 선택"): B4's `MctsConfig.priorWeight` (4 or 8) is chosen here, before the
 * candidate batch is built, by a small N=12 head-to-head vs L2 for each
 * weight — the higher win rate wins (tie broken by the lower value, since
 * the design's own goal is "최소 개입").
 *
 * Probe filter: round1 (probe-bank.json) + round2 (probe-bank-round2.json) +
 * round4 (probe-bank-round4.json) probe banks merged (deduped by probeId,
 * same helper shape as round2/round3's own `mergeProbeBanks`). **No
 * probe-bank-round3.json exists** — round3 (gomoku-portfolio-round3-
 * diagnostic.ts) was a budget-only mini diagnostic that never mined losses
 * or built a probe bank (its own doc comment: "부정 결과" — 예산 축
 * 기각, LossReport/probe-bank 생성 없음), so the team lead's "r1+r2+r3+r4"
 * instruction is honored by merging every probe bank that actually exists
 * on disk (round3 contributes zero probes, not a missing file bug). Cost
 * check stays 5 games/candidate (round1's own convention).
 *
 * WAVE TIER SIZING (team lead's resource rule): 3 of this round's 5
 * candidates (`gomokuCloneTiebreak` and its 2 epsilon derivatives) are
 * **not MCTS at all** — a single evaluator-argmax pass per decision, no
 * simulation budget — so their per-game cost is close to the raw heuristic
 * baseline's, far below round2's defensive/combined-family concern. Only
 * the 2 MCTS candidates (`mcts14-s256-jumpthree-w16`, `mcts13-s256-clone-
 * chainprior`) carry the continuous-prior-family cost round2 profiled
 * (~5.7x node visits at a fixed budget). This runner reuses round2's own
 * already-reduced tier sizes (smoke<=20/prune=10/holdout=10/regression=25)
 * rather than round1's un-reduced convention, as a conservative choice given
 * up to 4 of 5 candidates could advance and up to 2 of those 4 could be the
 * expensive MCTS family — recorded here per the resource rule's own "축소
 * 후 기록" requirement.
 *
 * Fresh seed ranges (verified non-overlapping with every prior gomoku
 * runner's own documented range — grepped across every `N{3}_N{3}` literal
 * in reference/runners/gomoku*.ts before picking these; round2 occupies
 * 530_000-536_099/989_1xx-989_7xx, round3's mini diagnostic reused round2's
 * seed helper without its own fresh range, v7-transcendence-check occupies
 * its own separate block documented in that file):
 *   - B4 priorWeight diagnostic (4 vs 8): 545_000-545_011 (N=12), bot seed
 *     base 992_001.
 *   - probe-filter cost check: 546_000-546_004 (N=5), bot seed base 992_101.
 *   - wave smoke/prune/holdout/regression: 547_000+/548_000+/549_000+/550_000+.
 *   - challenge (L1/L2, N=40): 551_000-551_039, bot seed base 992_301.
 *   - confirm (only if N=40 triggers, N=200): 552_000-552_199, bot seed base 992_501.
 *   - L3 holdout (only if confirm also triggers, N=100): 553_000-553_099, bot seed base 992_701.
 * `PROBE_SCORE_BOT_SEED_BASE` stays 975_201 (round1/round2's own base — see
 * round2's own doc comment for why this one constant never gets a fresh
 * value: probe-bank.ts's self-consistency contract needs the same anchor-
 * seed derivation that produced each probe's `anchorChoiceKey`).
 *
 * Promotion (design spec's own instruction, first live gomoku use of
 * `composeBotChecked`/`assembleFlags`): candidate pool = this round's
 * adopted terminal flags + v7 itself (`mcts12-s256-opusclone-w16`, v7's own
 * actual composed content per composeBot's override semantics) — v7 is
 * *not* excluded from the pool (design spec's explicit required decision:
 * unlike dominion's opusCloneDominion, gomoku has no separate independent
 * lineage to protect — the clone itself already *is* the accepted
 * baseline). `v7`'s challengeScore comes from this wave's own
 * `subject: 'baseline'` challenge row (same "measure it via the wave
 * itself" trick dominion-portfolio-round3.ts used for chapelEconomyV2).
 *
 * Transcendence check (team lead's instruction, "4회전에서 이미 한 번
 * 노이즈에 속았다" — N=100 point-estimate-only progression is explicitly
 * forbidden this round): if the N=40 challenge vs L2 shows
 * winRateCI.lower > 0.5, re-measure at N=200 (confirmatory, matching
 * dominion-portfolio-round3.ts's own shape) — only if the confirmation also
 * clears the threshold does this script run the L3 holdout head-to-head
 * (`external-style2-l3`, gomoku-anchor-ladder.ts's holdout anchor) at
 * N=100, gate-free (no LossReport/probe-bank generation — `runHeadToHead`
 * called without a `trajectoryCollector`, so there is no trajectory to mine
 * in the first place).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import type { AnyBotFactory, AnyGameAdapter } from '../../contract/types';
import { eraseAdapter } from '../../loop/erase';
import { composeBot, composeBotChecked, assembleFlags, withStrategyFlags, type AssembleFlagsCandidate } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
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
import { gomokuAdapter } from '../gomoku';
import { gomokuOpusBot } from '../experiments/gomoku-opus-bot';
import { gomokuMidBot } from '../experiments/gomoku-mid-bot';
import { gomokuPositionalBot } from '../experiments/gomoku-positional-bot';
import { gomokuCloneChainPriorEvaluator } from '../experiments/gomoku-clone-chain-prior-evaluator';
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
import { buildCandidates as buildRound1Candidates, erasePriorEvaluator } from './shared/gomoku-round1-candidates';
import { buildRound2Candidates } from './shared/gomoku-round2-candidates';
import { buildRound4Candidates, GOMOKU_CLONE_CHAIN_PRIOR_FLAG } from './shared/gomoku-round4-candidates';

const GAME_ID = 'gomoku';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const PROBE_SCORE_BOT_SEED_BASE = 975_201;

const DIAGNOSTIC_SEED_BASE = 545_000;
const DIAGNOSTIC_N = 12;
const DIAGNOSTIC_BOT_SEED_BASE = 992_001;

const COST_CHECK_SEED_BASE = 546_000;
const COST_CHECK_N = 5;
const COST_CHECK_BOT_SEED_BASE = 992_101;

const L1_ANCHOR_ID = 'external-mid-l1';
const L2_ANCHOR_ID = 'external-opus-l2';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRANSCENDENCE_TRIGGER_THRESHOLD = 0.5;

const CONFIRM_N = 200;
const CONFIRM_SEED_BASE = 552_000;
const CONFIRM_BOT_SEED_BASE = 992_501;

const L3_N = 100;
const L3_SEED_BASE = 553_000;
const L3_BOT_SEED_BASE = 992_701;

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

// ---------------------------------------------------------------------
// Probe bank merge (round1 + round2 + round4, deduped by probeId — file doc comment)
// ---------------------------------------------------------------------

function mergeProbeBanks(banks: readonly (readonly ProbePosition[])[]): readonly ProbePosition[] {
  const seen = new Map<string, ProbePosition>();
  for (const bank of banks) {
    for (const probe of bank) {
      if (!seen.has(probe.probeId)) {
        seen.set(probe.probeId, probe);
      }
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------
// B4 priorWeight pre-wave diagnostic (file doc comment)
// ---------------------------------------------------------------------

function chooseCloneChainPriorWeight(bareAdapter: AnyGameAdapter, championRollout: AnyBotFactory): number {
  const candidateWeights = [4, 8];
  const diagnosticSeeds = seeds(DIAGNOSTIC_SEED_BASE, DIAGNOSTIC_N);
  let bestWeight = candidateWeights[0] as number;
  let bestWinRate = -Infinity;
  for (const weight of candidateWeights) {
    const bot = gomokuMctsFlagSpecFor(
      bareAdapter,
      {
        simulations: 256,
        uctC: 1.4,
        rolloutCount: 1,
        label: `s256-clone-chainprior-diag-w${weight}`,
        rolloutFactory: championRollout,
        priorWeight: weight,
        priorEvaluator: erasePriorEvaluator(gomokuCloneChainPriorEvaluator),
      },
      `mcts13-diag-w${weight}`,
    ).apply(championRollout) as AnyBotFactory;
    const result = runHeadToHead(bareAdapter, bot, gomokuOpusBot as AnyBotFactory, diagnosticSeeds, DIAGNOSTIC_BOT_SEED_BASE);
    console.log(`   [진단] priorWeight=${weight}: winRate=${pct(result.candidateWinRate)} (N=${DIAGNOSTIC_N})`);
    if (result.candidateWinRate > bestWinRate) {
      bestWinRate = result.candidateWinRate;
      bestWeight = weight;
    }
  }
  return bestWeight;
}

// ---------------------------------------------------------------------
// Probe filter
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
  candidates: readonly { readonly flag: string; readonly bucket: BucketId }[],
  probes: readonly ProbePosition[],
): readonly ProbeFilterRow[] {
  const costSeeds = seeds(COST_CHECK_SEED_BASE, COST_CHECK_N);
  const rows: Array<Omit<ProbeFilterRow, 'advanced'>> = [];

  for (const candidate of candidates) {
    const bot = composeBot(adapter, [candidate.flag]);
    const probeScore = scoreAgainstProbes(adapter, bot, probes, PROBE_SCORE_BOT_SEED_BASE);

    const t0 = Date.now();
    const costResult = runHeadToHead(adapter, bot, gomokuOpusBot as AnyBotFactory, costSeeds, COST_CHECK_BOT_SEED_BASE);
    const elapsedMs = Date.now() - t0;
    const msPerGame = costResult.blocks > 0 ? elapsedMs / costResult.blocks : Infinity;

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
    return a.msPerGame - b.msPerGame; // tie-break: cheaper wins
  });
  const advancingFlags = new Set(ranked.slice(0, 4).map((row) => row.flag));

  return rows.map((row) => ({ ...row, advanced: advancingFlags.has(row.flag) }));
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
  console.log(`=== gomoku portfolio round 4 (GAP-11 Phase 6) — rootDir=${ROOT_DIR} ===`);

  const bareAdapter = eraseAdapter(gomokuAdapter);

  // The adapter must resolve every registry v7 (this round's baseline) flag
  // name, not just this round's own 5 candidates — composeBot(adapter,
  // latest.flags) is called deep inside runWave's regression tier — same
  // reconstruction round2/round3's own doc comments document.
  const round1Candidates = buildRound1Candidates(bareAdapter);
  const round2Candidates = buildRound2Candidates(bareAdapter);
  const preRound4Adapter = withStrategyFlags(bareAdapter, [
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_CONFIG, GOMOKU_MCTS_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_HR_CONFIG, GOMOKU_MCTS_HR_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_CONFIG, GOMOKU_MCTS2_S256_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_HR_CONFIG, GOMOKU_MCTS2_S256_HR_FLAG),
    gomokuMcts2S256CrFlagSpec(bareAdapter),
    gomokuMcts2S512CrFlagSpec(bareAdapter),
    ...round1Candidates.map((candidate) => candidate.spec),
    ...round2Candidates.map((candidate) => candidate.spec),
  ]);

  console.log('0) B4 priorWeight 사전 소형 진단 (4 vs 8, N=12 vs L2)');
  const championRolloutForDiagnostic = composeBot(preRound4Adapter, ['blockImmediateThreat', 'centerProximity', 'extendLongestLine']);
  const cloneChainPriorWeight = chooseCloneChainPriorWeight(preRound4Adapter, championRolloutForDiagnostic);
  console.log(`   선택: priorWeight=${cloneChainPriorWeight}`);

  console.log('1) 후보 배치 생성 (B3-deep x1, B1-exploit x2, B2-opponent x1, B4-explore x1 = 5)');
  const candidates = buildRound4Candidates(bareAdapter, cloneChainPriorWeight);
  for (const candidate of candidates) {
    console.log(`   ${candidate.bucket}: ${candidate.flag}`);
  }
  const adapter = withStrategyFlags(preRound4Adapter, candidates.map((candidate) => candidate.spec));

  console.log('2) 프로브 필터 (round1+round2+round4 프로브 은행 합산 채점 — round3은 부정 결과만 있어 은행 없음, 판당 비용 실측 각 5판, 상위 4 진출)');
  const probeBankRound1Path = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank.json');
  const probeBankRound2Path = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round2.json');
  const probeBankRound4Path = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round4.json');
  const probesRound1 = loadProbeBank(probeBankRound1Path);
  const probesRound2 = loadProbeBank(probeBankRound2Path);
  const probesRound4 = loadProbeBank(probeBankRound4Path);
  const mergedProbes = mergeProbeBanks([probesRound1, probesRound2, probesRound4]);
  console.log(
    `   프로브 은행: round1=${probesRound1.length}, round2=${probesRound2.length}, round3=0(은행 없음), round4=${probesRound4.length}, 합산(중복 제거 후)=${mergedProbes.length}`,
  );
  const probeFilterRows = runProbeFilter(adapter, candidates, mergedProbes);
  const advancing = probeFilterRows.filter((row) => row.advanced);
  const cutRow = probeFilterRows.find((row) => !row.advanced);
  console.log(`   진출: ${advancing.map((row) => row.flag).join(', ')}`);
  if (cutRow) {
    console.log(`   탈락: ${cutRow.flag} (agreement=${pct(cutRow.probeScore.agreementRate)})`);
  }

  console.log('3) 정규 웨이브 (신규 시드 뱅크, regression 상대=v7, challenge L1/L2 N=40, L3 미포함)');
  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const ledgerStore = loadOrCreateLedger(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined || latest.version !== 'v7') {
    throw new Error(
      `gomoku-portfolio-round4: registry latest=${latest?.version ?? '(none)'} — expected v7 (run portfolio-round2's promotion first)`,
    );
  }
  console.log(`   baseline=${latest.version} (composeBot 덮어쓰기 시맨틱상 실체=mcts12-s256-opusclone-w16 단독)`);

  const waveLedger = new SeedLedger();
  const reservedAt = now();
  const SMOKE_MAX = 20; // round1 관행: 30 (축소 근거: 파일 doc comment 'WAVE TIER SIZING')
  const PRUNE_BLOCKS = 10; // round1: 15
  const HOLDOUT_BLOCKS = 10; // round1: 15
  const REGRESSION_BLOCKS = 25; // round1: 40
  waveLedger.reserve({ bankId: 'gomoku-portfolio4-smoke', range: { start: 547_000, end: 547_000 + SMOKE_MAX - 1 }, purpose: 'smoke', reservedAt });
  waveLedger.reserve({ bankId: 'gomoku-portfolio4-prune', range: { start: 548_000, end: 548_000 + PRUNE_BLOCKS - 1 }, purpose: 'prune', reservedAt });
  waveLedger.reserve({ bankId: 'gomoku-portfolio4-holdout', range: { start: 549_000, end: 549_000 + HOLDOUT_BLOCKS - 1 }, purpose: 'holdout', reservedAt });
  waveLedger.reserve({ bankId: 'gomoku-portfolio4-regression', range: { start: 550_000, end: 550_000 + REGRESSION_BLOCKS - 1 }, purpose: 'regression', reservedAt });

  const CHALLENGE_N = 40;
  const CHALLENGE_SEED_BASE = 551_000;
  const CHALLENGE_BOT_SEED_BASE = 992_301;
  const challengeEntries: readonly WaveChallengeEntry[] = [
    { anchorId: L1_ANCHOR_ID, factory: gomokuMidBot as AnyBotFactory, role: 'feedback' },
    { anchorId: L2_ANCHOR_ID, factory: gomokuOpusBot as AnyBotFactory, role: 'feedback' },
  ];

  const waveConfig = {
    ...assembleWaveConfig(adapter, {
      waveId: 'portfolio-round4',
      candidates: advancing.map((row) => ({ flag: row.flag })),
      opponent: 'heuristic',
      ledger: waveLedger,
      recordedAt: now(),
      baselineFlags: latest.flags,
      baselineVersion: latest.version,
      tiers: {
        smoke: { bankId: 'gomoku-portfolio4-smoke', sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 }, maxBlocks: SMOKE_MAX, minBlocks: 5 },
        prune: { bankId: 'gomoku-portfolio4-prune', blocks: PRUNE_BLOCKS },
        holdout: { bankId: 'gomoku-portfolio4-holdout', blocks: HOLDOUT_BLOCKS },
        regression: { bankId: 'gomoku-portfolio4-regression', blocks: REGRESSION_BLOCKS },
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
  const v7L2 = challengeTable[L2_ANCHOR_ID]?.['baseline'];
  console.log(`   v7(=subject:'baseline') vs L2 이번 라운드 재측정: winRate=${v7L2 ? pct(v7L2.winRate) : '(없음)'}`);

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
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'near-miss-round4.json'), JSON.stringify(nearMiss, null, 2));

  console.log('6) registry 승격 — composeBotChecked/assembleFlags (ADR-0014)');
  const adoptedFlags = report.results.filter((r) => r.verdict === 'adopted').flatMap((r) => r.flags);
  const surfaceByFlag = new Map(adapter.strategySurface.map((spec) => [spec.flag, spec]));

  let promotedVersion: string | null = null;
  let promotedFlags: readonly string[] = latest.flags;
  let assembleResult: { flags: readonly string[]; excluded: readonly { flag: string; reason: string }[] } | null = null;

  if (adoptedFlags.length > 0) {
    const lineage = registry.lineage(latest.version);
    const toCandidate = (flag: string, challengeScore: number | undefined): AssembleFlagsCandidate => {
      const assembly = surfaceByFlag.get(flag)?.assembly;
      return {
        flag,
        ...(assembly !== undefined ? { assembly } : {}),
        ...(challengeScore !== undefined ? { challengeScore } : {}),
      };
    };

    const pool: AssembleFlagsCandidate[] = [];
    // v7 자신(design spec's required decision: 배제 대상 아님 — 오목은
    // 도미니언과 달리 "이전 챔피언"이 이미 클론이라 이번엔 기준선 그
    // 자체가 클론이고, 배제할 다른 독립 계보가 없다). v7의 실체 =
    // mcts12-s256-opusclone-w16 단독(composeBot 덮어쓰기 시맨틱).
    pool.push(toCandidate('mcts12-s256-opusclone-w16', v7L2?.winRate));
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

    const nextVersion = registry.register({
      version: `v${lineage.length + 1}`,
      flags: assembleResult.flags,
      parent: latest.version,
      createdAt: now(),
      sourceWaveId: report.waveId,
      notes:
        `portfolio-round4에서 assembleFlags(ADR-0014)로 승격: pool=[${pool.map((c) => c.flag).join(', ')}], ` +
        `excluded=[${assembleResult.excluded.map((e) => e.flag).join(', ') || '(없음)'}].`,
    });
    promotedVersion = nextVersion.version;
    promotedFlags = nextVersion.flags;
    console.log(`   승격: ${nextVersion.version}, flags=[${nextVersion.flags.join(', ')}]`);
  } else {
    console.log('   채택된 후보 없음 — 승격 없음 (v7 유지)');
  }
  saveRegistry(ROOT_DIR, GAME_ID, registry);
  saveLedger(ROOT_DIR, GAME_ID, ledgerStore);

  console.log('7) 버킷 수율 계산 + 재배분 (round2 portfolio-state.json 로드 후 갱신 — round3은 포트폴리오 배분 갱신 없는 미니 진단이었음)');
  const verdictByFlag = new Map(report.results.map((result) => [result.flag, result.verdict]));
  const roundBaselineL2WinRate = v7L2?.winRate ?? 0.5;

  const bucketOutcomes: BucketOutcome[] = BUCKET_ORDER.map((bucket) => {
    const bucketCandidates = candidates.filter((candidate) => candidate.bucket === bucket);
    const bucketAdvancing = bucketCandidates.filter((candidate) => advancing.some((row) => row.flag === candidate.flag));
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

  console.log('8) 초월 판정 트리거 검사 (vs L2 winRateCI.lower > 0.5, N=40 — 트리거 시 반드시 N=200 확증부터)');
  const transcendenceEntries: TranscendenceEntry[] = [];
  for (const entry of report.challengeResult ?? []) {
    if (entry.anchorId !== L2_ANCHOR_ID || entry.subject === 'baseline') {
      continue;
    }
    if (entry.winRateCI.lower <= TRANSCENDENCE_TRIGGER_THRESHOLD) {
      continue;
    }
    const flag = entry.subject;
    const wasAdopted = adoptedFlags.includes(flag);
    console.log(`   N=40 트리거됨: ${flag} (winRateCI.lower=${pct(entry.winRateCI.lower)}) — N=${CONFIRM_N} 확증 측정 실행 (점추정만으로 진행 절대 금지)`);
    const candidateBot = wasAdopted ? composeBotChecked(adapter, promotedFlags) : composeBot(adapter, [flag]);
    const confirmResult = runHeadToHead(adapter, candidateBot, gomokuOpusBot as AnyBotFactory, seeds(CONFIRM_SEED_BASE, CONFIRM_N), CONFIRM_BOT_SEED_BASE);
    console.log(`   확증(N=${CONFIRM_N}) ${flag} vs L2: winRate=${pct(confirmResult.candidateWinRate)} CI=${ciStr(confirmResult)}`);

    const confirmTriggered = confirmResult.winRateCI.lower > TRANSCENDENCE_TRIGGER_THRESHOLD;
    let l3Result: HeadToHeadResult | null = null;
    if (confirmTriggered) {
      console.log(`   확증도 트리거 통과 — L3(${L3_ANCHOR_ID}) 홀드아웃 판정 실행 (N=${L3_N}, 게이트 없음, 승률 숫자만)`);
      l3Result = runHeadToHead(adapter, candidateBot, gomokuPositionalBot as AnyBotFactory, seeds(L3_SEED_BASE, L3_N), L3_BOT_SEED_BASE);
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

  console.log('9) runs/gomoku/portfolio-round4.json 저장');
  const summary = {
    gameId: GAME_ID,
    generatedAt: now(),
    designSpecPath: 'scratchpad/gomoku-round4-design-spec.md (main-loop Fable, 그대로 구현)',
    preWaveDiagnostic: {
      purpose: 'B4-explore mcts13-s256-clone-chainprior의 MctsConfig.priorWeight (4 vs 8) 선택',
      n: DIAGNOSTIC_N,
      chosenWeight: cloneChainPriorWeight,
      flag: GOMOKU_CLONE_CHAIN_PRIOR_FLAG,
    },
    probeBankSources: {
      round1: { path: `runs/${GAME_ID}/probe-bank.json`, probes: probesRound1.length },
      round2: { path: `runs/${GAME_ID}/probe-bank-round2.json`, probes: probesRound2.length },
      round3: { path: null, probes: 0, note: '부정 결과만 있는 미니 진단, LossReport/probe-bank 생성 없음' },
      round4: { path: `runs/${GAME_ID}/probe-bank-round4.json`, probes: probesRound4.length },
      merged: mergedProbes.length,
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
    waveTierSizing: {
      convention: { smoke: 30, prune: 15, holdout: 15, regression: 40 },
      usedThisRound: { smoke: SMOKE_MAX, prune: PRUNE_BLOCKS, holdout: HOLDOUT_BLOCKS, regression: REGRESSION_BLOCKS },
      reason:
        '이 라운드 5후보 중 3개(gomokuCloneTiebreak 계열)는 MCTS가 아닌 evaluator-argmax 터미널 봇(탐색 비용 없음), ' +
        '나머지 2개(jumpthree/clone-chainprior)만 round2가 프로파일링한 continuous-prior-family 비용(약 5.7배)을 진다 — ' +
        '보수적으로 round2의 이미 축소된 관행을 그대로 재사용(파일 doc comment 참고).',
    },
    wave: {
      waveId: report.waveId,
      comparabilityKey: report.comparabilityKey,
      results: report.results.map((result) => ({ flag: result.flag, verdict: result.verdict, tiersPassed: result.tiersPassed })),
    },
    challenge: challengeTable,
    adoption: {
      promotedVersion,
      adoptedFlags,
      assembleFlags: assembleResult ? { flags: assembleResult.flags, excluded: assembleResult.excluded } : null,
    },
    bucketOutcomes,
    portfolioAllocation: { previous: currentAllocation, next: nextAllocation },
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
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round4.json'), JSON.stringify(summary, null, 2));
  console.log(`   저장: runs/${GAME_ID}/portfolio-round4.json`);
}

main();
