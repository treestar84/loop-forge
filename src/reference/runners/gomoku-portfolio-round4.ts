/**
 * gomoku-portfolio-round4 — GAP-11 Phase 6 round4 (팀리드 지시, 메인 루프
 * Fable의 B3 심층 설계: scratchpad gomoku-round4-design-spec.md 그대로
 * 구현), following gomoku-portfolio-round2.ts/gomoku-portfolio-round3-
 * diagnostic.ts's own precedent (candidate batch -> probe filter -> wave ->
 * challenge -> bookkeeping -> transcendence check), plus this round's own
 * new requirement (matching dominion-portfolio-round3.ts's own first use):
 * the promotion step uses `composeBotChecked`/`assembleFlags` (ADR-0014).
 *
 * GAP-ANALYSIS-12.md E1 refactor (2026-07-31, scratchpad/e1-round-executor-
 * design-spec.md): steps 2-5 of DESIGN.md §6.2 (probe filter -> wave ->
 * challenge -> promotion -> reallocation) now delegate to
 * `artifacts/portfolio-round.ts`'s `runPortfolioRound` — this file keeps
 * only what's game knowledge (candidate batch, probe-bank/anchor loading,
 * the pre-wave priorWeight diagnostic) and this round's own bespoke steps
 * that stay out of the shared executor's scope (transcendence check, adoption
 * ledger recording — see that file's own doc comment for why). Re-run with
 * the same seeds against the pre-refactor commit (f0b6f3f)'s
 * runs/gomoku/portfolio-round4.json confirmed byte-identical probeFilter
 * agreementRate, wave verdicts, challenge winRate, and adoption flags.
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
 * same helper shape as round2/round3's own `mergeProbeBanks`, now shared in
 * portfolio-round.ts). **No probe-bank-round3.json exists** — round3
 * (gomoku-portfolio-round3-diagnostic.ts) was a budget-only mini diagnostic
 * that never mined losses or built a probe bank. Cost check stays 5
 * games/candidate (round1's own convention).
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
 *   - wave smoke/prune/holdout/regression: 547_000+/548_000+/549_000+/550_000+
 *     (runPortfolioRound reserves these at fixed 1000-seed offsets from
 *     waveSeedBase=547_000 — the exact convention this file used manually
 *     before the E1 refactor).
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
  const round4Candidates = buildRound4Candidates(bareAdapter, cloneChainPriorWeight);
  for (const candidate of round4Candidates) {
    console.log(`   ${candidate.bucket}: ${candidate.flag}`);
  }
  const adapter = withStrategyFlags(preRound4Adapter, round4Candidates.map((candidate) => candidate.spec));
  const candidates: readonly RoundCandidateSpec[] = round4Candidates.map((candidate) => ({
    flag: candidate.flag,
    bucket: candidate.bucket,
  }));

  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const ledgerStore = loadOrCreateLedger(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined || latest.version !== 'v7') {
    throw new Error(
      `gomoku-portfolio-round4: registry latest=${latest?.version ?? '(none)'} — expected v7 (run portfolio-round2's promotion first)`,
    );
  }
  console.log(`   baseline=${latest.version} (composeBot 덮어쓰기 시맨틱상 실체=mcts12-s256-opusclone-w16 단독)`);

  console.log('2) 프로브 필터 (round1+round2+round4 프로브 은행 합산 채점 — round3은 부정 결과만 있어 은행 없음, 판당 비용 실측 각 5판, 상위 4 진출)');
  const probeBankRound1Path = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank.json');
  const probeBankRound2Path = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round2.json');
  const probeBankRound4Path = join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round4.json');
  const probesRound1 = loadProbeBank(probeBankRound1Path);
  const probesRound2 = loadProbeBank(probeBankRound2Path);
  const probesRound4 = loadProbeBank(probeBankRound4Path);

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
      probeBanks: [probesRound1, probesRound2, probesRound4],
      probeScoreSeedBase: PROBE_SCORE_BOT_SEED_BASE,
      costCheckN: COST_CHECK_N,
      costCheckSeedBase: COST_CHECK_SEED_BASE,
      costCheckOpponent: gomokuOpusBot as AnyBotFactory,
      costCheckBotSeedBase: COST_CHECK_BOT_SEED_BASE,
      advanceTopK: 4,
    },
    wave: {
      waveId: 'portfolio-round4',
      waveSeedBase: 547_000,
      tiers: {
        smoke: { sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 }, maxBlocks: 20, minBlocks: 5 },
        prune: { blocks: 10 },
        holdout: { blocks: 10 },
        regression: { blocks: 25 },
      },
      regressionOpponentFlags: latest.flags,
      comparabilityContext: undefined,
    },
    challenge: {
      anchors: [
        { anchorId: L1_ANCHOR_ID, factory: gomokuMidBot as AnyBotFactory },
        { anchorId: L2_ANCHOR_ID, factory: gomokuOpusBot as AnyBotFactory },
      ],
      seedBase: 551_000,
      botSeedBase: 992_301,
      n: 40,
    },
    promotion: {
      // v7 자신(design spec's required decision: 배제 대상 아님 — 오목은
      // 도미니언과 달리 "이전 챔피언"이 이미 클론이라 이번엔 기준선 그
      // 자체가 클론이고, 배제할 다른 독립 계보가 없다). v7의 실체 =
      // mcts12-s256-opusclone-w16 단독(composeBot 덮어쓰기 시맨틱).
      latestVersionFlags: ['mcts12-s256-opusclone-w16'],
      latestVersionAssembly: {},
      registry,
      notesPrefix: 'portfolio-round4에서 ',
    },
    bucketAllocation: { current: currentAllocation },
    outputPath,
    recordedAt,
    clockNowMs: Date.now,
  });

  for (const result of round.wave.results) {
    console.log(`   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`);
  }
  const v7L2 = round.challenge[L2_ANCHOR_ID]?.['baseline'];
  console.log(`   v7(=subject:'baseline') vs L2 이번 라운드 재측정: winRate=${v7L2 ? pct(v7L2.winRate) : '(없음)'}`);
  if (round.adoption.promotedVersion) {
    console.log(`   승격: ${round.adoption.promotedVersion}`);
  } else {
    console.log('   채택된 후보 없음 — 승격 없음 (v7 유지)');
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

  console.log('9) 초월 판정 트리거 검사 (vs L2 winRateCI.lower > 0.5, N=40 — 트리거 시 반드시 N=200 확증부터)');
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
    console.log(`   N=40 트리거됨: ${flag} (winRateCI.lower=${pct(entry.winRateCI.lower)}) — N=${CONFIRM_N} 확증 측정 실행 (점추정만으로 진행 절대 금지)`);
    const candidateBot = wasAdopted ? composeBot(adapter, promotedFlags) : composeBot(adapter, [flag]);
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

  console.log('10) near-miss 추출 + runs/gomoku/portfolio-round4.json 저장(diagnostic/transcendence 추가 병합)');
  const nearMiss = extractNearMissCandidates(adoptionRecord, round.criteria);
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'near-miss-round4.json'), JSON.stringify(nearMiss, null, 2));

  const summary = {
    gameId: GAME_ID,
    generatedAt: recordedAt,
    designSpecPath: 'scratchpad/gomoku-round4-design-spec.md (main-loop Fable, 그대로 구현) + GAP-ANALYSIS-12.md E1 리팩터',
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
    waveTierSizing: {
      convention: { smoke: 30, prune: 15, holdout: 15, regression: 40 },
      usedThisRound: { smoke: 20, prune: 10, holdout: 10, regression: 25 },
      reason:
        '이 라운드 5후보 중 3개(gomokuCloneTiebreak 계열)는 MCTS가 아닌 evaluator-argmax 터미널 봇(탐색 비용 없음), ' +
        '나머지 2개(jumpthree/clone-chainprior)만 round2가 프로파일링한 continuous-prior-family 비용(약 5.7배)을 진다 — ' +
        '보수적으로 round2의 이미 축소된 관행을 그대로 재사용(파일 doc comment 참고).',
    },
    wave: {
      waveId: round.wave.waveId,
      comparabilityKey: round.wave.comparabilityKey,
      results: round.wave.results.map((result) => ({ flag: result.flag, verdict: result.verdict, tiersPassed: result.tiersPassed })),
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
