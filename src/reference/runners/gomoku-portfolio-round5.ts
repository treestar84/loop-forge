/**
 * gomoku-portfolio-round5 — GAP-11 Phase 4 오목 5회전 후반부(메인 루프 Fable의
 * 설계 브리프 scratchpad/gomoku-round5-design-spec.md 그대로 구현), following
 * ./gomoku-portfolio-round4.ts's own structure verbatim (candidate batch ->
 * probe filter -> wave -> challenge -> `composeBotChecked`/`assembleFlags`
 * 승격 -> 재배분 -> 초월 판정), steps 2-5 delegated to
 * `artifacts/portfolio-round.ts`'s `runPortfolioRound` (GAP-12 E1).
 *
 * Candidate batch (5, ./shared/gomoku-round5-candidates.ts's own doc comment
 * has the full per-candidate design rationale):
 *   - B3-deep: `mcts15-s256-drawaverse-w16` (메인 루프 지정 본안 — 무승부로
 *     수렴 중인 국면에서 "승부가 갈리는 수"를 탐색 랭킹에서 우대).
 *   - B1-exploit x2: `mcts16-s256-opening3-clone-w16` /
 *     `mcts16-s256-opening5-clone-w16` (A7 오프닝 북 저비용 버전, round4 자체
 *     권고대로 하향 스코프 — 오프닝 창 스윕).
 *   - B2-opponent: `mcts17-s256-clone-lateprior-sched` (round5 채굴이 지목한
 *     중후반 국지적 전술 실수 구간에 prior 개입을 강화).
 *   - B4-explore: `mcts18-s256-clone-rootoverride` (축 매트릭스 A4 루트
 *     오버라이드 × A10 클론 — 미시도 조합, 선택 사유는 그 파일 doc comment).
 *
 * **Naming deviation (정직하게 기록)**: 설계 브리프는 B3 후보를 문자 그대로
 * `mcts-s256-drawaverse-w16`이라 적었지만, 이 저장소의 오목 MCTS 후보 명명
 * 관례는 `mcts{N}-...`(마지막 사용 번호 mcts14)이므로 `mcts15-s256-drawaverse-
 * w16`으로 번호를 붙였다 — 설계 내용은 브리프 그대로이고 이름만 관례에 맞췄다.
 *
 * Probe filter: round1 + round2 + round4 + round5 probe banks merged (deduped
 * by probeId). Cost check 5 games/candidate (round1's own convention).
 * advanceTopK=4 of 5 candidates (round4와 동일).
 *
 * WAVE TIER SIZING: 이번 라운드는 5후보 **전부** MCTS 계열(round4는 3/5가
 * 비-MCTS evaluator-argmax였다)이라 판당 비용이 round4보다 크다. round2/round4가
 * 쓴 축소 티어(smoke<=20/prune=10/holdout=10/regression=25)를 그대로 재사용한다
 * — 더 줄이면 round4와의 비교 가능성이 깨지고, 늘리면 웨이브 예산을 초과한다
 * (자원 규칙의 "축소 후 기록" 요구사항에 따라 여기 남긴다).
 *
 * Fresh seed ranges (round4가 545,000-553,099 / 992,001-992,701을 점유하므로
 * 전부 그 위로):
 *   - probe-filter cost check: 556_000-556_004 (N=5), bot seed base 993_101.
 *   - wave smoke/prune/holdout/regression: 557_000+/558_000+/559_000+/560_000+.
 *   - challenge (L1/L2, N=40): 561_000-561_039, bot seed base 993_301.
 *   - 초월 트리거 측정 (N=100): 562_000-562_099, bot seed base 993_401.
 *   - 확증 (N=200): 563_000-563_199, bot seed base 993_501.
 *   - L3 홀드아웃 (N=100): 564_000-564_099, bot seed base 993_701.
 * `PROBE_SCORE_BOT_SEED_BASE`는 975_201 고정(probe-bank.ts의 자기일치성 계약 —
 * round4 doc comment의 설명 그대로).
 *
 * **초월 판정 사다리(설계 브리프 5번 + round4의 교훈)**: round4에서 채굴
 * 부산물의 N=100 점추정 55%가 N=200 확증에서 정확히 50.0%로 회귀한 전례가
 * 있으므로, 이번 라운드는 세 단계를 **순서대로** 밟는다.
 *   (1) 웨이브 challenge N=40 (계측, 판정 불개입 — round4와 동일 관례).
 *   (2) **N=100 트리거 측정**: N=40 vs L2 점추정이 이번 라운드 기준선
 *       (subject:'baseline' = v7 자신)보다 높고 0.5 이상인 후보 중 **최고
 *       1개**에 대해서만 실행한다(사전 등록 규칙 — 전 후보에 N=100을 돌리면
 *       비용이 웨이브 자체를 넘고, 점추정이 기준선에도 못 미치는 후보가 N=100
 *       에서 CI 하한 0.5를 넘을 개연성은 없다). CI 하한 > 0.5여야 다음 단계.
 *   (3) **N=200 확증** → 여기서도 CI 하한 > 0.5일 때만 **L3 홀드아웃**
 *       (`external-style2-l3`, N=100, 게이트 없음 — trajectoryCollector 없이
 *       호출하므로 채굴할 트래젝토리 자체가 생기지 않는다).
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
import { buildRound5Candidates, ROUND5_DESIGN_CONSTANTS } from './shared/gomoku-round5-candidates';

const GAME_ID = 'gomoku';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const PROBE_SCORE_BOT_SEED_BASE = 975_201;

const COST_CHECK_SEED_BASE = 556_000;
const COST_CHECK_N = 5;
const COST_CHECK_BOT_SEED_BASE = 993_101;

const L1_ANCHOR_ID = 'external-mid-l1';
const L2_ANCHOR_ID = 'external-opus-l2';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRANSCENDENCE_TRIGGER_THRESHOLD = 0.5;

const TRIGGER_N = 100;
const TRIGGER_SEED_BASE = 562_000;
const TRIGGER_BOT_SEED_BASE = 993_401;

const CONFIRM_N = 200;
const CONFIRM_SEED_BASE = 563_000;
const CONFIRM_BOT_SEED_BASE = 993_501;

const L3_N = 100;
const L3_SEED_BASE = 564_000;
const L3_BOT_SEED_BASE = 993_701;

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
  console.log(`=== gomoku portfolio round 5 (GAP-11 Phase 4) — rootDir=${ROOT_DIR} ===`);

  const bareAdapter = eraseAdapter(gomokuAdapter);

  // registry v7의 모든 플래그 이름을 해석할 수 있는 어댑터를 먼저 복원한다
  // (regression 티어가 composeBot(adapter, latest.flags)를 호출한다).
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

  console.log('1) 후보 배치 생성 (B3-deep x1, B1-exploit x2, B2-opponent x1, B4-explore x1 = 5)');
  console.log(`   설계 상수(채굴 round5 기반): ${JSON.stringify(ROUND5_DESIGN_CONSTANTS)}`);
  const round5Candidates = buildRound5Candidates(bareAdapter);
  for (const candidate of round5Candidates) {
    console.log(`   ${candidate.bucket}: ${candidate.flag}`);
  }
  const adapter = withStrategyFlags(preRound5Adapter, round5Candidates.map((candidate) => candidate.spec));
  const candidates: readonly RoundCandidateSpec[] = round5Candidates.map((candidate) => ({
    flag: candidate.flag,
    bucket: candidate.bucket,
  }));

  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const ledgerStore = loadOrCreateLedger(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined || latest.version !== 'v7') {
    throw new Error(
      `gomoku-portfolio-round5: registry latest=${latest?.version ?? '(none)'} — expected v7 (round4는 승격 없음)`,
    );
  }
  console.log(`   baseline=${latest.version} (실체=mcts12-s256-opusclone-w16 단독, composeBot 덮어쓰기 시맨틱)`);

  console.log('2) 프로브 필터 (round1+round2+round4+round5 프로브 은행 합산 채점, 판당 비용 실측 각 5판, 상위 4 진출)');
  const probesRound1 = loadProbeBank(join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank.json'));
  const probesRound2 = loadProbeBank(join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round2.json'));
  const probesRound4 = loadProbeBank(join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round4.json'));
  const probesRound5 = loadProbeBank(join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round5.json'));

  console.log('3-7) 정규 웨이브 -> challenge -> 승격 -> 재배분 (artifacts/portfolio-round.ts runPortfolioRound)');
  const recordedAt = now();
  const currentAllocation = loadPortfolioState(ROOT_DIR, GAME_ID) ?? INITIAL_ALLOCATION;
  const outputPath = join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round5.json');

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
      advanceTopK: 4,
    },
    wave: {
      waveId: 'portfolio-round5',
      waveSeedBase: 557_000,
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
      seedBase: 561_000,
      botSeedBase: 993_301,
      n: 40,
    },
    promotion: {
      // round4와 동일: v7 자신(실체 = mcts12-s256-opusclone-w16 단독)도 후보
      // 풀에 넣는다 — 오목은 도미니언과 달리 보호해야 할 별도 독립 계보가 없다
      // (챔피언 자신이 이미 클론).
      latestVersionFlags: ['mcts12-s256-opusclone-w16'],
      latestVersionAssembly: {},
      registry,
      notesPrefix: 'portfolio-round5에서 ',
    },
    bucketAllocation: { current: currentAllocation },
    outputPath,
    recordedAt,
    clockNowMs: Date.now,
  });

  for (const result of round.wave.results) {
    console.log(`   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`);
  }
  const baselineVsL2 = round.challenge[L2_ANCHOR_ID]?.['baseline'];
  console.log(`   v7(=subject:'baseline') vs L2 이번 라운드 재측정: winRate=${baselineVsL2 ? pct(baselineVsL2.winRate) : '(없음)'}`);
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

  console.log('9) 초월 판정 사다리 (N=40 계측 → N=100 트리거 → N=200 확증 → L3, 파일 doc comment의 사전 등록 규칙)');
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
    'N=40 challenge에서 어떤 후보도 (a) vs L2 점추정 >= 50% 및 (b) 이번 라운드 기준선(v7) 초과를 동시에 만족하지 못함 — N=100 트리거 측정 미실행.';

  if (best !== undefined) {
    console.log(
      `   N=40 최고 후보: ${best.flag} winRate=${pct(best.winRate)} (CI 하한 ${pct(best.ciLower)}), 기준선 v7=${pct(baselineWinRate)}`,
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

  console.log('10) near-miss 추출 + runs/gomoku/portfolio-round5.json 저장(초월 사다리 병합)');
  const nearMiss = extractNearMissCandidates(adoptionRecord, round.criteria);
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'near-miss-round5.json'), JSON.stringify(nearMiss, null, 2));

  const summary = {
    gameId: GAME_ID,
    generatedAt: recordedAt,
    designSpecPath: 'scratchpad/gomoku-round5-design-spec.md (main-loop Fable, 그대로 구현)',
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
      reason: '5후보 전부 MCTS 계열(round4는 3/5가 비-MCTS) — round2/round4의 축소 티어를 그대로 재사용해 비교 가능성 유지.',
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
  console.log(`   저장: runs/${GAME_ID}/portfolio-round5.json`);
}

main();
