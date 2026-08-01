/**
 * gomoku-portfolio-round6 — 오목 6회전(E8 재확인). 메인 루프 Fable의 설계
 * 브리프 `scratchpad/gomoku-round6-recheck-design-spec.md` 그대로 구현하며,
 * 구조는 ./gomoku-portfolio-round5.ts를 그대로 따른다(후보 배치 -> 프로브
 * 필터 -> 웨이브 -> challenge -> `composeBotChecked`/`assembleFlags` 승격 ->
 * 재배분 -> 초월 사다리).
 *
 * **이 회전은 새 게임 전략을 설계하지 않는다.** 5회전에서
 * `mcts17-s256-clone-earlyprior-sched`가 웨이브 screen 단계에서 "behavioral
 * no-op"으로 탈락했는데, 같은 후보가 challenge N=40에서 vs L2 53.1%(기준선 v7
 * 44.4% 대비 +8.7%p), N=100 트리거 55.5% [51.0–59.8], N=200 확증 53.1%
 * [49.8–56.5](하한이 0.5에 0.2%p 미달)로 이 게임 사상 최고 성적을 냈다.
 * 원인은 screenProbe가 3시드 소표본(`seeds:[1,2,3]`)이라 그 후보의 코드 경로가
 * 갈리는 국면을 우연히 한 번도 안 거친 표본 부족이었고, FIX-BACKLOG E8이
 * `artifacts/portfolio-round.ts`의 기본 screen 시드를 8개
 * (`DEFAULT_SCREEN_PROBE_SEEDS`)로 상향해 이를 고쳤다. 이 회전은 **고쳐진
 * 게이트로 이미 나온 후보를 공정하게 재평가**하는 것이다.
 *
 * round5와의 차이(이 파일이 통제하는 유일한 변수):
 *   - `runPortfolioRound` 호출에서 `screenProbeSeeds`를 **생략** → 새 기본값
 *     8시드가 적용된다(round5는 고정 3시드였다).
 *   - 후보는 round5의 정의(`./shared/gomoku-round5-candidates.ts`)를 그대로
 *     재사용하고 그중 **옛 3시드 screen에서 탈락했던 두 개만** 재평가한다:
 *     `mcts17-s256-clone-earlyprior-sched`(B2, 이번 회전의 본 표적)와
 *     `mcts16-s256-opening3-clone-w16`(B1, 같은 이유로 탈락했던 참고 후보).
 *     `advanceTopK=2`라 프로브 필터는 둘 다 통과시킨다 — 이번 회전이 검정하는
 *     게이트는 프로브 필터가 아니라 screen이다.
 *   - 기준선이 v7이 아니라 **v8**(round5가 승격시킨 `mcts18-s256-clone-
 *     rootoverride` 단독)이다. 따라서 이번 라운드 challenge의 `subject:
 *     'baseline'`과 regression 상대는 전부 v8이고, round5의 44.4%와 직접
 *     비교하면 안 된다(comparabilityKey가 다르다 — docs/INTERPRETATION.md 제1규칙).
 *
 * Fresh seed ranges (round5가 556,000–564,099 / 봇시드 993,101–993,701을
 * 점유하므로 전부 그 위로 — holdout/graduation 뱅크 재사용 금지 규칙):
 *   - probe-filter cost check: 566_000–566_004 (N=5), bot seed base 994_101.
 *   - wave smoke/prune/holdout/regression: 567_000+/568_000+/569_000+/570_000+.
 *   - challenge (L1/L2, N=40): 571_000–571_039, bot seed base 994_301.
 *   - 초월 트리거 (N=100): 572_000–572_099, bot seed base 994_401.
 *   - 확증 (N=200): 573_000–573_199, bot seed base 994_501.
 *   - L3 홀드아웃 (N=100): 574_000–574_099, bot seed base 994_701.
 * `PROBE_SCORE_BOT_SEED_BASE`는 975_201 고정(probe-bank.ts의 자기일치성 계약).
 *
 * 웨이브 티어 크기는 round5와 동일(smoke<=20/prune=10/holdout=10/regression=25)
 * — 후보가 전부 MCTS 계열이라는 조건도 같고, 바꾸면 round5와의 비교 가능성이
 * 깨진다.
 *
 * **초월 판정 사다리는 round5와 동일한 순서로 엄격히 지킨다**: (1) challenge
 * N=40 계측(판정 불개입) → (2) 사전 등록 규칙에 따라 vs L2 점추정이 이번
 * 라운드 기준선(v8)보다 높고 0.5 이상인 후보 **최고 1개**만 N=100 트리거 →
 * CI 하한 > 0.5여야 (3) N=200 확증 → 거기서도 하한 > 0.5여야 (4) L3
 * (`external-style2-l3`) 홀드아웃. round5는 (3)에서 하한 49.8%로 0.2%p
 * 미달해 (4)에 못 갔다. 이번엔 시드 뱅크가 다르므로 결과는 더 좋을 수도, 다시
 * 못 미칠 수도 있다 — 편견 없이 측정하고 있는 그대로 기록한다.
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
import {
  DEFAULT_SCREEN_PROBE_SEEDS,
  runPortfolioRound,
  type RoundCandidateSpec,
} from '../../artifacts/portfolio-round';
import { gomokuAdapter } from '../gomoku';
import { gomokuOpusBot } from '../experiments/gomoku-opus-bot';
import { gomokuMidBot } from '../experiments/gomoku-mid-bot';
import { gomokuPositionalBot } from '../experiments/gomoku-positional-bot';
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
import { buildCandidates as buildRound1Candidates } from './shared/gomoku-round1-candidates';
import { buildRound2Candidates } from './shared/gomoku-round2-candidates';
import {
  buildRound5Candidates,
  GOMOKU_CLONE_EARLYPRIOR_FLAG,
  GOMOKU_OPENING3_CLONE_FLAG,
  ROUND5_DESIGN_CONSTANTS,
} from './shared/gomoku-round5-candidates';

const GAME_ID = 'gomoku';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const PROBE_SCORE_BOT_SEED_BASE = 975_201;

const COST_CHECK_SEED_BASE = 566_000;
const COST_CHECK_N = 5;
const COST_CHECK_BOT_SEED_BASE = 994_101;

const L1_ANCHOR_ID = 'external-mid-l1';
const L2_ANCHOR_ID = 'external-opus-l2';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRANSCENDENCE_TRIGGER_THRESHOLD = 0.5;

const TRIGGER_N = 100;
const TRIGGER_SEED_BASE = 572_000;
const TRIGGER_BOT_SEED_BASE = 994_401;

const CONFIRM_N = 200;
const CONFIRM_SEED_BASE = 573_000;
const CONFIRM_BOT_SEED_BASE = 994_501;

const L3_N = 100;
const L3_SEED_BASE = 574_000;
const L3_BOT_SEED_BASE = 994_701;

/** 이번 회전이 재평가하는 후보 — round5 정의 그대로, 옛 3시드 screen 탈락 2건. */
const RECHECK_FLAGS: readonly string[] = [GOMOKU_CLONE_EARLYPRIOR_FLAG, GOMOKU_OPENING3_CLONE_FLAG];

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

function main(): void {
  console.log(`=== gomoku portfolio round 6 (E8 재확인) — rootDir=${ROOT_DIR} ===`);
  console.log(`   screen 프로브 시드: 생략 → 기본값 ${JSON.stringify(DEFAULT_SCREEN_PROBE_SEEDS)} (round5는 [1,2,3])`);

  const bareAdapter = eraseAdapter(gomokuAdapter);

  // registry v8의 모든 플래그 이름을 해석할 수 있는 어댑터를 먼저 복원한다
  // (regression 티어가 composeBot(adapter, latest.flags)를 호출한다 — v8의
  // 실체 mcts18-s256-clone-rootoverride는 round5 후보 정의에서 나온다).
  const round1Candidates = buildRound1Candidates(bareAdapter);
  const round2Candidates = buildRound2Candidates(bareAdapter);
  const preRound5Adapter = withStrategyFlags(bareAdapter, [
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_CONFIG, GOMOKU_MCTS_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS_HR_CONFIG, GOMOKU_MCTS_HR_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_CONFIG, GOMOKU_MCTS2_S256_FLAG),
    gomokuMctsFlagSpecFor(bareAdapter, GOMOKU_MCTS2_S256_HR_CONFIG, GOMOKU_MCTS2_S256_HR_FLAG),
    gomokuMcts2S256CrFlagSpec(bareAdapter),
    gomokuMcts2S512CrFlagSpec(bareAdapter),
    ...round1Candidates.map((candidate) => candidate.spec),
    ...round2Candidates.map((candidate) => candidate.spec),
  ]);

  console.log('1) 후보 배치 재사용 (round5 정의 그대로 — 새 후보 설계 없음)');
  console.log(`   설계 상수(round5와 동일): ${JSON.stringify(ROUND5_DESIGN_CONSTANTS)}`);
  const round5Candidates = buildRound5Candidates(bareAdapter);
  // round5 후보 5개를 전부 어댑터에 등록한다(v8의 실체 mcts18 해석에 필요) —
  // 다만 이번 라운드가 평가하는 후보는 RECHECK_FLAGS 2개뿐이다.
  const adapter = withStrategyFlags(preRound5Adapter, round5Candidates.map((candidate) => candidate.spec));
  const recheckCandidates = round5Candidates.filter((candidate) => RECHECK_FLAGS.includes(candidate.flag));
  if (recheckCandidates.length !== RECHECK_FLAGS.length) {
    throw new Error(
      `gomoku-portfolio-round6: 재평가 후보 해석 실패 — 기대 ${RECHECK_FLAGS.join(', ')}, 실제 ${recheckCandidates.map((c) => c.flag).join(', ')}`,
    );
  }
  for (const candidate of recheckCandidates) {
    console.log(`   ${candidate.bucket}: ${candidate.flag} (round5 옛 3시드 screen 탈락분)`);
  }
  const candidates: readonly RoundCandidateSpec[] = recheckCandidates.map((candidate) => ({
    flag: candidate.flag,
    bucket: candidate.bucket,
  }));

  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const ledgerStore = loadOrCreateLedger(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined || latest.version !== 'v8') {
    throw new Error(
      `gomoku-portfolio-round6: registry latest=${latest?.version ?? '(none)'} — expected v8 (round5가 승격시킨 rootoverride 단독)`,
    );
  }
  console.log(`   baseline=${latest.version} (실체=${latest.flags.join(', ')})`);

  console.log('2) 프로브 필터 (round1+round2+round4+round5 프로브 은행 합산 채점, 판당 비용 실측 각 5판, 2후보 전원 진출)');
  const probesRound1 = loadProbeBank(join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank.json'));
  const probesRound2 = loadProbeBank(join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round2.json'));
  const probesRound4 = loadProbeBank(join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round4.json'));
  const probesRound5 = loadProbeBank(join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round5.json'));

  console.log('3-7) 정규 웨이브 -> challenge -> 승격 -> 재배분 (artifacts/portfolio-round.ts runPortfolioRound)');
  const recordedAt = now();
  const currentAllocation = loadPortfolioState(ROOT_DIR, GAME_ID) ?? INITIAL_ALLOCATION;
  const outputPath = join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round6.json');

  const round = runPortfolioRound({
    gameId: GAME_ID,
    rootDir: ROOT_DIR,
    adapter,
    candidates,
    probeFilter: {
      probeBanks: [probesRound1, probesRound2, probesRound4, probesRound5],
      probeScoreSeedBase: PROBE_SCORE_BOT_SEED_BASE,
      costCheckN: COST_CHECK_N,
      costCheckSeedBase: COST_CHECK_SEED_BASE,
      costCheckOpponent: gomokuOpusBot as AnyBotFactory,
      costCheckBotSeedBase: COST_CHECK_BOT_SEED_BASE,
      advanceTopK: 2,
    },
    wave: {
      waveId: 'portfolio-round6',
      waveSeedBase: 567_000,
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
      seedBase: 571_000,
      botSeedBase: 994_301,
      n: 40,
    },
    promotion: {
      latestVersionFlags: latest.flags,
      latestVersionAssembly: {},
      registry,
      notesPrefix: 'portfolio-round6(E8 재확인)에서 ',
    },
    bucketAllocation: { current: currentAllocation },
    outputPath,
    recordedAt,
    clockNowMs: Date.now,
    // screenProbeSeeds 생략 = 이번 회전의 유일한 통제 변수(E8 기본값 8시드).
  });

  console.log('   screen 판정(이번 회전의 첫 번째 판정 포인트):');
  for (const result of round.wave.results) {
    const screenedOut = result.tiersPassed.length === 0 && result.stats.smoke === undefined;
    console.log(
      `   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}` +
        `${screenedOut ? ' — 8시드에서도 behavioral no-op' : ''}`,
    );
  }
  const baselineVsL2 = round.challenge[L2_ANCHOR_ID]?.['baseline'];
  console.log(`   v8(=subject:'baseline') vs L2 이번 라운드 재측정: winRate=${baselineVsL2 ? pct(baselineVsL2.winRate) : '(없음)'}`);
  if (round.adoption.promotedVersion) {
    console.log(`   승격: ${round.adoption.promotedVersion}`);
  } else {
    console.log('   채택된 후보 없음 — 승격 없음 (v8 유지)');
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

  console.log('9) 초월 판정 사다리 (N=40 계측 → N=100 트리거 → N=200 확증 → L3, round5와 동일한 사전 등록 규칙)');
  const promotedFlags = round.adoption.assembleFlagsResult?.flags ?? latest.flags;
  const adoptedFlags = round.adoption.adoptedFlags;
  const baselineWinRate = baselineVsL2?.winRate ?? 0.5;

  const l2Rows = (round.wave.challengeResult ?? [])
    .filter((entry) => entry.anchorId === L2_ANCHOR_ID && entry.subject !== 'baseline')
    .map((entry) => ({ flag: entry.subject, winRate: entry.winRate, ciLower: entry.winRateCI.lower }))
    .sort((a, b) => b.winRate - a.winRate);
  const best = l2Rows[0];
  const triggerEligible =
    best !== undefined && best.winRate >= TRANSCENDENCE_TRIGGER_THRESHOLD && best.winRate > baselineWinRate;

  let triggerResult: HeadToHeadResult | null = null;
  let confirmResult: HeadToHeadResult | null = null;
  let l3Result: HeadToHeadResult | null = null;
  let ladderNote =
    'N=40 challenge에서 어떤 후보도 (a) vs L2 점추정 >= 50% 및 (b) 이번 라운드 기준선(v8) 초과를 동시에 만족하지 못함 — N=100 트리거 측정 미실행.';

  if (best !== undefined) {
    console.log(
      `   N=40 최고 후보: ${best.flag} winRate=${pct(best.winRate)} (CI 하한 ${pct(best.ciLower)}), 기준선 v8=${pct(baselineWinRate)}`,
    );
  }
  if (triggerEligible && best !== undefined) {
    const wasAdopted = adoptedFlags.includes(best.flag);
    const candidateBot = wasAdopted ? composeBot(adapter, promotedFlags) : composeBot(adapter, [best.flag]);
    console.log(`   트리거 측정 실행: ${best.flag} vs L2, N=${TRIGGER_N} (점추정만으로 진행 금지 — CI 하한으로 판정)`);
    triggerResult = runHeadToHead(
      adapter,
      candidateBot,
      gomokuOpusBot as AnyBotFactory,
      seeds(TRIGGER_SEED_BASE, TRIGGER_N),
      TRIGGER_BOT_SEED_BASE,
    );
    console.log(`   트리거(N=${TRIGGER_N}): winRate=${pct(triggerResult.candidateWinRate)} CI=${ciStr(triggerResult)}`);
    ladderNote = `N=100 트리거 측정 실행(${best.flag}): winRate=${pct(triggerResult.candidateWinRate)} CI 하한=${pct(triggerResult.winRateCI.lower)}.`;

    if (triggerResult.winRateCI.lower > TRANSCENDENCE_TRIGGER_THRESHOLD) {
      console.log(`   트리거 통과 — N=${CONFIRM_N} 확증 측정 실행`);
      confirmResult = runHeadToHead(
        adapter,
        candidateBot,
        gomokuOpusBot as AnyBotFactory,
        seeds(CONFIRM_SEED_BASE, CONFIRM_N),
        CONFIRM_BOT_SEED_BASE,
      );
      console.log(`   확증(N=${CONFIRM_N}): winRate=${pct(confirmResult.candidateWinRate)} CI=${ciStr(confirmResult)}`);
      ladderNote += ` 확증(N=200): winRate=${pct(confirmResult.candidateWinRate)} CI 하한=${pct(confirmResult.winRateCI.lower)}.`;

      if (confirmResult.winRateCI.lower > TRANSCENDENCE_TRIGGER_THRESHOLD) {
        console.log(`   확증도 통과 — L3(${L3_ANCHOR_ID}) 홀드아웃 실행 (N=${L3_N}, 게이트 없음, 승률 숫자만)`);
        l3Result = runHeadToHead(
          adapter,
          candidateBot,
          gomokuPositionalBot as AnyBotFactory,
          seeds(L3_SEED_BASE, L3_N),
          L3_BOT_SEED_BASE,
        );
        console.log(`   L3: winRate=${pct(l3Result.candidateWinRate)} CI=${ciStr(l3Result)} blocks=${l3Result.blocks}`);
        ladderNote += ` L3 홀드아웃 실행: winRate=${pct(l3Result.candidateWinRate)}.`;
      } else {
        ladderNote += ' 확증에서 CI 하한 미달 — L3 미실행.';
      }
    } else {
      console.log('   트리거(N=100)에서 CI 하한 미달 — 확증/L3 미실행');
      ladderNote += ' CI 하한 미달 — 확증/L3 미실행.';
    }
  } else {
    console.log(`   ${ladderNote}`);
  }

  console.log('10) near-miss 추출 + runs/gomoku/portfolio-round6.json 저장(초월 사다리 병합)');
  const nearMiss = extractNearMissCandidates(adoptionRecord, round.criteria);
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'near-miss-round6.json'), JSON.stringify(nearMiss, null, 2));

  const summary = {
    gameId: GAME_ID,
    generatedAt: recordedAt,
    designSpecPath: 'scratchpad/gomoku-round6-recheck-design-spec.md (main-loop Fable, 그대로 구현)',
    purpose:
      'E8(screen 프로브 시드 3→8) 수정 후 round5에서 screen 탈락했던 후보 2건을 고쳐진 게이트로 재평가 — 새 후보 설계 없음.',
    screenProbeSeeds: { round5: [1, 2, 3], round6: DEFAULT_SCREEN_PROBE_SEEDS, source: 'DEFAULT_SCREEN_PROBE_SEEDS (생략 시 기본값)' },
    designConstants: ROUND5_DESIGN_CONSTANTS,
    probeBankSources: {
      round1: { path: `runs/${GAME_ID}/probe-bank.json`, probes: probesRound1.length },
      round2: { path: `runs/${GAME_ID}/probe-bank-round2.json`, probes: probesRound2.length },
      round4: { path: `runs/${GAME_ID}/probe-bank-round4.json`, probes: probesRound4.length },
      round5: { path: `runs/${GAME_ID}/probe-bank-round5.json`, probes: probesRound5.length },
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
      reason: 'round5와 동일한 축소 티어 — 후보가 전부 MCTS 계열이고, 바꾸면 round5와의 비교 가능성이 깨진다.',
    },
    wave: {
      waveId: round.wave.waveId,
      comparabilityKey: round.wave.comparabilityKey,
      results: round.wave.results.map((result) => ({
        flag: result.flag,
        verdict: result.verdict,
        tiersPassed: result.tiersPassed,
        screenedOut: result.tiersPassed.length === 0 && result.stats.smoke === undefined,
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
    transcendence: {
      threshold: TRANSCENDENCE_TRIGGER_THRESHOLD,
      baselineVsL2N40: baselineWinRate,
      bestCandidateN40: best ?? null,
      triggerEligible,
      triggerN: triggerResult ? TRIGGER_N : null,
      triggerWinRate: triggerResult?.candidateWinRate ?? null,
      triggerWinRateCI: triggerResult?.winRateCI ?? null,
      confirmN: confirmResult ? CONFIRM_N : null,
      confirmWinRate: confirmResult?.candidateWinRate ?? null,
      confirmWinRateCI: confirmResult?.winRateCI ?? null,
      l3AnchorId: l3Result ? L3_ANCHOR_ID : null,
      l3N: l3Result ? L3_N : null,
      l3WinRate: l3Result?.candidateWinRate ?? null,
      l3WinRateCI: l3Result?.winRateCI ?? null,
      note: ladderNote,
    },
  };
  writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  console.log(`   저장: runs/${GAME_ID}/portfolio-round6.json`);
}

main();
