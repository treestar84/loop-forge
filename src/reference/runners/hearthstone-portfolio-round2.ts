/**
 * hearthstone-portfolio-round2 — GAP-11 Phase 7, 하스스톤 2회전
 * (docs/GAP-ANALYSIS-11.md §3 D5.5 프로토콜 v2 6단계), 메인 루프 설계
 * 브리프(scratchpad/hearthstone-round2-design-spec.md)를 그대로 구현.
 * 파일명·구조는 `hearthstone-portfolio-round1.ts`와 도미니언
 * `dominion-portfolio-round2.ts`/`-round3.ts`의 "다음 회전" 관례를 따르고,
 * 2~5단계(프로브 필터 → 웨이브 → challenge → assembleFlags 승격 →
 * bucketOutcomes/reallocate → 저장)는 `artifacts/portfolio-round.ts`의
 * `runPortfolioRound`에 위임한다(GAP-ANALYSIS-12 E1).
 *
 * 출발점: registry **v3** = `ismcts-s128-tempo-w4`(1회전 승격, N=40 challenge
 * vs L2 46.3%). 2회전 재채굴(`hearthstone-loss-mining-round2.ts`)은 같은 봇을
 * 신규 시드 N=100에서 vs L2 51.0% [44.5, 57.0] / vs L1 89.0%로 재측정했고,
 * 결정 수준 불일치율이 47.0%(v2) → 27.0%(v3)로 절반이 됐음을 기록했다.
 *
 * 후보 배치(5 — B3x1, B1x2, B2x1, B4x1; 1회전과 동일한 버킷 비중 프리셋
 * 유지, 설계 브리프의 "아직 수율 데이터 부족해 재배분 근거 약함"):
 *   - **B3-deep (1, 메인 루프=Opus 지정)**: `ismcts-s128-blended-w4` —
 *     `hearthstoneChoiceEvaluator`(tempo, 밴드 순서)와
 *     `hearthstonePlayFocusedEvaluator`(play 선택지의 마나커브 적합도)를
 *     가중합한 새 prior(`../experiments/hearthstone-blended-evaluator.ts`),
 *     priorWeight=4(챔피언과 같은 예산 문맥). 이번 라운드의 유일한 진짜
 *     신규 설계축(A8) — 파라미터 스윕이 아니라 두 지식의 결합이다.
 *     가중치는 설계 브리프의 지시대로 소규모 스윕으로 확정한다(아래 1-b).
 *   - **B1-exploit (2)**: `ismcts-s128-tempo-w2` / `ismcts-s128-tempo-w8`.
 *     설계 브리프는 w2/w24를 예시하면서 "실행 에이전트가 round1 3점의 곡률을
 *     보고 국소 최적점 방향으로 조정해도 됨, 단 사유를 기록"이라고 허용했다.
 *     1회전의 같은 웨이브 문맥 N=40 challenge vs L2는
 *     **w0(=ismcts-s128-hr) 40.0% / w4 46.3% / w16 42.5% / w48 36.3%** —
 *     단조 감소가 아니라 **w4 부근의 내부 최적점**이다. w24는 이미 하강
 *     구간(w16과 w48 사이)이라 정보량이 낮으므로, 최적점을 양쪽에서 좁히는
 *     **w2/w8**을 택한다. (사유 기록 끝.)
 *   - **B2-opponent (1)**: `ismcts-s128-bcremoval-w4` —
 *     `../experiments/hearthstone-battlecry-removal-evaluator.ts`.
 *     설계 브리프의 "반드시 round2 자체 데이터로 타겟 재선정" 지시에 따라,
 *     이번 회전 채굴이 자동 집계한 choice 종류별 불일치율
 *     (play 68.7%/147, heroPower 68.2%/22, attack 61.3%/31 — 잔여 불일치
 *     135건 중 101건이 play)에서 타깃을 다시 뽑았다. 1회전 B2와 같은 `play`
 *     축이지만 기전이 다르다: 1회전은 밴드 구조를 버린 별도 평가함수를
 *     통째로 갈아끼웠고(near-miss), 이번엔 기존 평가함수를 그대로 두고
 *     "적 하수인을 죽이는 하수인 배틀크라이"만 `removal` 밴드로 승격한다
 *     (그 평가함수 자신의 doc comment가 선언한 밴드 정의와 구현의 어긋남 —
 *     자세한 근거는 해당 experiments 파일의 doc comment).
 *   - **B4-explore (1)**: `ismcts-s192-tempo-w4` — 탐색 예산 s128→s192(A1).
 *     ADR-0009/GAP-8의 "같은 축 억지 재시도 금지"에 저촉되지 않는다:
 *     A1은 오목·도미니언에서만 시도된 축이고 하스스톤에서는 미시도다.
 * 5개 전부 `assembly: 'terminal'`(ADR-0014) — `hearthstoneIsmctsFlagSpecFor`가
 * 선언하며, 1회전과 동일한 관례.
 *
 * 프로브 필터: 1회전(`probe-bank.json`) + 2회전(`probe-bank-round2.json`) 두
 * 은행을 합산 채점(probeId 기준 dedupe는 `runPortfolioRound`가 수행 — 두
 * 은행의 시드 범위가 서로 겹치지 않으므로 실제로는 400개 전부 남는다),
 * 후보당 5판 비용 실측, 상위 4 진출(1회전과 동일한 컷).
 * 프로브 채점 봇 시드 베이스는 2회전 채굴의 `mineLosses` 베이스(992_201)를
 * 쓴다 — 채점 대상은 앵커가 아니라 후보이므로 자기일치율과는 무관하고,
 * 같은 회전의 채굴과 같은 파생 문맥을 쓰는 편이 해석이 단순하다.
 *
 * 웨이브: regression 상대 = v3(`latest.flags`), 티어는 1회전과 동일 비중
 * (smoke SPRT 30 / prune 15 / holdout 15 / regression 20),
 * challenge는 L1/L2만(N=40). L3는 정규 challenge에 절대 넣지 않는다(D3).
 *
 * 신규 시드 범위(기존 하스스톤 러너의 문서화된 범위와 전부 비겹침 —
 * 벤치마크 55,000-56,599 / anchor-ladder 994,000+·995,000+·1,000,000+·
 * 1,001,000+ / 1회전 채굴 499,000-501,099 / portfolio-round1 520,000-527,099 /
 * 2회전 채굴 505,000-507,099):
 *   - 프로브 필터 비용 실측: 530,000-530,004 (N=5, 5후보 공통 블록).
 *   - 웨이브 smoke/prune/holdout/regression: 531,000+/532,000+/533,000+/534,000+
 *     (`runPortfolioRound`가 waveSeedBase=531,000에서 1000 간격으로 예약).
 *   - challenge (L1/L2): 535,000-535,039 (N=40).
 *   - 확증(트리거 시에만): 536,000-536,199 (N=200).
 *   - 초월 L3 홀드아웃(확증까지 통과해야만): 537,000-537,099 (N=100).
 *   - B3 가중치 스윕: 게임을 두지 않는다(프로브 대조만) — 시드 소비 없음.
 * 봇 시드 베이스(신규 993_1xx/993_3xx/993_5xx/993_7xx 블록, 기존
 * 950_10x/983_10x/986_10x/987_1xx-987_3xx/988_1xx-988_7xx/992_1xx-992_3xx와
 * 비겹침): 993_101(비용 실측/프로브 필터), 993_301(challenge), 993_501(확증),
 * 993_701(L3 홀드아웃).
 *
 * 초월 판정(설계 브리프 5번, 순서 엄수): 어떤 후보든 N=40 challenge vs L2의
 * `winRateCI.lower > 0.5`일 때만 N=200 확증을 돌리고, **확증도 통과한
 * 경우에만** L3(`external-style2-l3`) 홀드아웃 N=100을 실행한다. 홀드아웃
 * 결과로는 LossReport/probe-bank를 만들지 않는다(홀드아웃 가드).
 *
 * 자원 규칙: IS-MCTS s128/s192라 판당 비용이 크다 — 이 스크립트는 모든
 * 후보를 한 프로세스에서 순차 실행하며, 외부에서 `nice -n 10`으로 띄운다
 * (파일 스스로 OS 스케줄링 우선순위를 바꾸지 않는다).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer, may call Date.now()) per
 * src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import type { AnyBotFactory, AnyGameAdapter, PlayerId, StrategyFlagSpec } from '../../contract/types';
import { eraseAdapter } from '../../loop/erase';
import { composeBot, withStrategyFlags } from '../../loop/compose';
import { runHeadToHead, type HeadToHeadResult } from '../../loop/head-to-head';
import { scoreAgainstProbes } from '../../loop/probe-bank';
import { loadProbeBank } from '../../artifacts/trajectory-archive';
import { loadOrCreateLedger, loadOrCreateRegistry, saveLedger, saveRegistry } from '../../artifacts/game-state';
import { extractNearMissCandidates, type AdoptionEntry } from '../../artifacts/adoption-ledger';
import { INITIAL_ALLOCATION, loadPortfolioState } from '../../artifacts/portfolio';
import { runPortfolioRound, type RoundCandidateSpec } from '../../artifacts/portfolio-round';
import type { MctsConfig } from '../../search/mcts';
import { hearthstoneAdapter, type HearthstoneChoice, type HearthstoneState } from '../hearthstone';
import { hearthstoneOpusBot } from '../experiments/hearthstone-opus-bot';
import { hearthstoneMidBot } from '../experiments/hearthstone-mid-bot';
import { hearthstoneTempoBot } from '../experiments/hearthstone-tempo-bot';
import { hearthstoneBlendedEvaluator, type HearthstoneBlendWeights } from '../experiments/hearthstone-blended-evaluator';
import { hearthstoneBattlecryRemovalEvaluator } from '../experiments/hearthstone-battlecry-removal-evaluator';
import {
  HEARTHSTONE_ISMCTS_S128_HR_CONFIG,
  hearthstoneIsmctsFlagSpecFor,
  hearthstoneTempoPriorConfig,
} from './shared/hearthstone-ismcts-flag';

const GAME_ID = 'hearthstone';
const ROOT_DIR = join(__dirname, '..', '..', '..');

const PROBE_SCORE_BOT_SEED_BASE = 992_201;
const COST_CHECK_SEED_BASE = 530_000;
const COST_CHECK_N = 5;
const COST_CHECK_BOT_SEED_BASE = 993_101;

const WAVE_SEED_BASE = 531_000;
const CHALLENGE_SEED_BASE = 535_000;
const CHALLENGE_BOT_SEED_BASE = 993_301;
const CHALLENGE_N = 40;

const L1_ANCHOR_ID = 'external-mid-l1';
const L2_ANCHOR_ID = 'external-opus-l2';
const L3_ANCHOR_ID = 'external-style2-l3';
const TRANSCENDENCE_TRIGGER_THRESHOLD = 0.5;

const CONFIRM_N = 200;
const CONFIRM_SEED_BASE = 536_000;
const CONFIRM_BOT_SEED_BASE = 993_501;

const L3_N = 100;
const L3_SEED_BASE = 537_000;
const L3_BOT_SEED_BASE = 993_701;

const CHAMPION_FLAG = 'ismcts-s128-tempo-w4';
const B3_FLAG = 'ismcts-s128-blended-w4';
const B1_W2_FLAG = 'ismcts-s128-tempo-w2';
const B1_W8_FLAG = 'ismcts-s128-tempo-w8';
const B2_FLAG = 'ismcts-s128-bcremoval-w4';
const B4_FLAG = 'ismcts-s192-tempo-w4';

/** B3 가중치 후보(설계 브리프의 "예: 0.6/0.4" 를 포함하는 3점 스윕).
 * tempo 밴드 간격은 최소 150, playfocus 점수 폭은 대략 0~30이므로 세 조합
 * 모두 `play` 가중이 밴드를 넘지 않는다(0.2*30=6 < 0.8*150, 0.6*30=18 <
 * 0.4*150) — 즉 "밴드는 tempo가, 밴드 내부 서열은 playfocus가" 라는 결합
 * 의도가 세 점 모두에서 유지된다. */
const B3_BLEND_SWEEP: readonly HearthstoneBlendWeights[] = [
  { tempo: 0.8, play: 0.2 },
  { tempo: 0.6, play: 0.4 },
  { tempo: 0.4, play: 0.6 },
];

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

/** 하스스톤 타입으로 쓰인 평가함수를 소거된 `MctsConfig.priorEvaluator`
 * 시그니처로 넓힌다 — 1회전 `erasePlayFocusedEvaluator`와 동일한
 * 타입 수준 캐스트 전용 패턴. */
function eraseEvaluator(
  evaluator: (state: HearthstoneState, player: PlayerId, choices: readonly HearthstoneChoice[]) => readonly number[],
): (state: unknown, player: PlayerId, choices: readonly unknown[]) => readonly number[] {
  return (state, player, choices) =>
    evaluator(state as HearthstoneState, player, choices as readonly HearthstoneChoice[]);
}

function blendedConfig(weights: HearthstoneBlendWeights, label: string, priorWeight: number): MctsConfig {
  return {
    ...HEARTHSTONE_ISMCTS_S128_HR_CONFIG,
    label,
    priorWeight,
    priorEvaluator: eraseEvaluator(hearthstoneBlendedEvaluator(weights)),
  };
}

interface BlendSweepRow {
  readonly weights: HearthstoneBlendWeights;
  readonly agreementRate: number;
  readonly agreements: number;
  readonly scored: number;
}

/**
 * 1-b) B3 가중치 소규모 스윕(설계 브리프: "실행 에이전트가 소규모 스윕으로
 * 확정"). 게임을 두지 않고 **2회전 프로브 은행**(가장 최신 데이터, 200개)
 * 대조 일치율만 본다 — 프로토콜 자신의 선별 지표와 같은 지표를 쓰는 셈이라
 * 별도 정당화가 필요 없고, 비용도 후보 1개의 프로브 필터와 같다.
 */
function sweepBlendWeights(
  bareAdapter: AnyGameAdapter,
  probes: ReturnType<typeof loadProbeBank>,
): readonly BlendSweepRow[] {
  const rows: BlendSweepRow[] = [];
  for (const [index, weights] of B3_BLEND_SWEEP.entries()) {
    const flag = `blend-sweep-${index}`;
    const spec = hearthstoneIsmctsFlagSpecFor(
      bareAdapter,
      blendedConfig(weights, `s128-blend-sweep-${index}`, 4),
      flag,
      `B3 가중치 스윕(tempo=${weights.tempo}, play=${weights.play}) — 스윕 전용, 웨이브 후보 아님.`,
    );
    const sweepAdapter = withStrategyFlags(bareAdapter, [spec]);
    const score = scoreAgainstProbes(sweepAdapter, composeBot(sweepAdapter, [flag]), probes, PROBE_SCORE_BOT_SEED_BASE);
    const scored = score.probes - score.skipped;
    rows.push({ weights, agreementRate: score.agreementRate, agreements: score.agreements, scored });
    console.log(
      `   tempo=${weights.tempo}/play=${weights.play}: agreement=${pct(score.agreementRate)} (${score.agreements}/${scored})`,
    );
  }
  return rows;
}

function buildSpecs(
  adapter: AnyGameAdapter,
  blendWeights: HearthstoneBlendWeights,
): readonly StrategyFlagSpec<unknown, unknown>[] {
  return [
    // 계보 기준선(regression 상대 + 승격 후보 풀) — 이번 라운드의 웨이브
    // 후보는 아니지만 어댑터에 등록돼 있어야 composeBot이 v3를 만들 수 있다.
    hearthstoneIsmctsFlagSpecFor(
      adapter,
      hearthstoneTempoPriorConfig(4, 's128-tempo-w4'),
      CHAMPION_FLAG,
      'registry v3 챔피언 (1회전 승격): choiceEvaluator 트리 prior, priorWeight=4.',
    ),
    hearthstoneIsmctsFlagSpecFor(
      adapter,
      blendedConfig(blendWeights, 's128-blended-w4', 4),
      B3_FLAG,
      `B3 본안 (A8 지식 결합, 2회전 설계 브리프의 메인 루프 지정): hearthstoneChoiceEvaluator(tempo, 가중 ${blendWeights.tempo})와 hearthstonePlayFocusedEvaluator(마나커브, 가중 ${blendWeights.play})의 가중합을 트리 prior로, priorWeight=4.`,
    ),
    hearthstoneIsmctsFlagSpecFor(
      adapter,
      hearthstoneTempoPriorConfig(2, 's128-tempo-w2'),
      B1_W2_FLAG,
      'B1 파생 (priorWeight 스윕, 기계 변형): v3와 동일 구성, priorWeight=2 — 1회전 곡선의 내부 최적점(w4)을 아래에서 좁힌다.',
    ),
    hearthstoneIsmctsFlagSpecFor(
      adapter,
      hearthstoneTempoPriorConfig(8, 's128-tempo-w8'),
      B1_W8_FLAG,
      'B1 파생 (priorWeight 스윕, 기계 변형): v3와 동일 구성, priorWeight=8 — 1회전 곡선의 내부 최적점(w4)을 위에서 좁힌다.',
    ),
    hearthstoneIsmctsFlagSpecFor(
      adapter,
      {
        ...HEARTHSTONE_ISMCTS_S128_HR_CONFIG,
        label: 's128-bcremoval-w4',
        priorWeight: 4,
        priorEvaluator: eraseEvaluator(hearthstoneBattlecryRemovalEvaluator),
      },
      B2_FLAG,
      'B2 opponent-targeted (2회전 채굴의 choice 종류별 불일치율에서 재선정 — play 68.7%/147, 잔여 불일치의 75%): 적 하수인을 죽이는 하수인 배틀크라이만 removal 밴드로 승격한 평가함수, priorWeight=4.',
    ),
    hearthstoneIsmctsFlagSpecFor(
      adapter,
      { ...hearthstoneTempoPriorConfig(4, 's192-tempo-w4'), simulations: 192 },
      B4_FLAG,
      'B4 미시도 축 (A1 탐색 예산, 하스스톤 최초): v3와 동일 prior·롤아웃, simulations 128→192.',
    ),
  ];
}

function buildCandidates(): readonly RoundCandidateSpec[] {
  return [
    { flag: B3_FLAG, bucket: 'B3-deep' },
    { flag: B1_W2_FLAG, bucket: 'B1-exploit' },
    { flag: B1_W8_FLAG, bucket: 'B1-exploit' },
    { flag: B2_FLAG, bucket: 'B2-opponent' },
    { flag: B4_FLAG, bucket: 'B4-explore' },
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
  console.log(`=== hearthstone portfolio round 2 (GAP-11 Phase 7) — rootDir=${ROOT_DIR} ===`);

  const bareAdapter = eraseAdapter(hearthstoneAdapter);

  const registry = loadOrCreateRegistry(ROOT_DIR, GAME_ID);
  const ledgerStore = loadOrCreateLedger(ROOT_DIR, GAME_ID);
  const latest = registry.latest();
  if (latest === undefined || latest.version !== 'v3') {
    throw new Error(
      `hearthstone-portfolio-round2: registry latest=${latest?.version ?? '(none)'} — expected v3 (portfolio-round1의 승격 결과)`,
    );
  }
  if (latest.flags.length !== 1 || latest.flags[0] !== CHAMPION_FLAG) {
    throw new Error(
      `hearthstone-portfolio-round2: registry v3 flags=[${latest.flags.join(', ')}] — expected [${CHAMPION_FLAG}]`,
    );
  }
  console.log(`   registry latest=${latest.version} flags=[${latest.flags.join(', ')}]`);

  const probesRound1 = loadProbeBank(join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank.json'));
  const probesRound2 = loadProbeBank(join(ROOT_DIR, 'runs', GAME_ID, 'probe-bank-round2.json'));

  console.log('1-b) B3 가중치 소규모 스윕 (2회전 프로브 은행 200개 대조, 게임 없음)');
  const sweepRows = sweepBlendWeights(bareAdapter, probesRound2);
  const bestSweep = [...sweepRows].sort((a, b) => b.agreementRate - a.agreementRate)[0];
  if (bestSweep === undefined) {
    throw new Error('hearthstone-portfolio-round2: blend sweep produced no rows');
  }
  console.log(`   확정: tempo=${bestSweep.weights.tempo}/play=${bestSweep.weights.play} (agreement=${pct(bestSweep.agreementRate)})`);

  const adapter = withStrategyFlags(bareAdapter, buildSpecs(bareAdapter, bestSweep.weights));
  const candidates = buildCandidates();
  console.log('1) 후보 배치 생성 (B3x1, B1x2, B2x1, B4x1 = 5)');
  for (const candidate of candidates) {
    console.log(`   ${candidate.bucket}: ${candidate.flag}`);
  }

  console.log('2-7) 프로브 필터(1+2회전 은행 합산, 상위 4) → 웨이브 → challenge → 승격 → 재배분');
  const recordedAt = now();
  const currentAllocation = loadPortfolioState(ROOT_DIR, GAME_ID) ?? INITIAL_ALLOCATION;
  const outputPath = join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round2.json');

  const round = runPortfolioRound({
    gameId: GAME_ID,
    rootDir: ROOT_DIR,
    adapter,
    candidates,
    probeFilter: {
      probeBanks: [probesRound1, probesRound2],
      probeScoreSeedBase: PROBE_SCORE_BOT_SEED_BASE,
      costCheckN: COST_CHECK_N,
      costCheckSeedBase: COST_CHECK_SEED_BASE,
      costCheckOpponent: hearthstoneOpusBot as AnyBotFactory,
      costCheckBotSeedBase: COST_CHECK_BOT_SEED_BASE,
      advanceTopK: 4,
    },
    wave: {
      waveId: 'portfolio-round2',
      waveSeedBase: WAVE_SEED_BASE,
      tiers: {
        smoke: { sprt: { p0: 0.5, p1: 0.6, alpha: 0.1, beta: 0.1 }, maxBlocks: 30, minBlocks: 5 },
        prune: { blocks: 15 },
        holdout: { blocks: 15 },
        regression: { blocks: 20 },
      },
      regressionOpponentFlags: latest.flags,
      comparabilityContext: undefined,
    },
    challenge: {
      anchors: [
        { anchorId: L1_ANCHOR_ID, factory: hearthstoneMidBot as AnyBotFactory },
        { anchorId: L2_ANCHOR_ID, factory: hearthstoneOpusBot as AnyBotFactory },
      ],
      seedBase: CHALLENGE_SEED_BASE,
      botSeedBase: CHALLENGE_BOT_SEED_BASE,
      n: CHALLENGE_N,
    },
    promotion: {
      latestVersionFlags: latest.flags,
      latestVersionAssembly: { [CHAMPION_FLAG]: 'terminal' },
      registry,
      notesPrefix: 'portfolio-round2에서 ',
    },
    bucketAllocation: { current: currentAllocation },
    outputPath,
    recordedAt,
    clockNowMs: Date.now,
  });

  for (const row of round.probeFilter) {
    console.log(
      `   [probe-filter] ${row.flag} (${row.bucket}): agreement=${pct(row.probeScore.agreementRate)} ` +
        `ms/game=${row.msPerGame.toFixed(0)} advanced=${row.advanced}`,
    );
  }
  for (const result of round.wave.results) {
    console.log(`   ${result.flag}: verdict=${result.verdict} tiersPassed=${result.tiersPassed.join('→') || '(none)'}`);
  }
  for (const entry of round.wave.challengeResult ?? []) {
    console.log(`   ${entry.anchorId} vs ${entry.subject}: winRate=${pct(entry.winRate)} CI=${ciStr(entry)} blocks=${entry.blocks}`);
  }
  const v3ChallengeL2 = round.challenge[L2_ANCHOR_ID]?.['baseline'];
  console.log(`   v3(=subject:'baseline') vs L2 이번 라운드 재측정: ${v3ChallengeL2 ? pct(v3ChallengeL2.winRate) : '(없음)'}`);
  if (round.adoption.promotedVersion) {
    console.log(
      `   승격: ${round.adoption.promotedVersion}, flags=[${round.adoption.assembleFlagsResult?.flags.join(', ') ?? ''}]`,
    );
    for (const excluded of round.adoption.assembleFlagsResult?.excluded ?? []) {
      console.log(`   excluded: ${excluded.flag} — ${excluded.reason}`);
    }
  } else {
    console.log('   채택된 후보 없음 — 승격 없음 (v3 유지)');
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

  console.log('9) 초월 판정 트리거 검사 (vs L2 winRateCI.lower > 0.5, N=40 → 확증 N=200 → L3 홀드아웃)');
  const promotedFlags = round.adoption.assembleFlagsResult?.flags ?? latest.flags;
  const adoptedFlags = round.adoption.adoptedFlags;
  const transcendenceEntries: TranscendenceEntry[] = [];
  for (const entry of round.wave.challengeResult ?? []) {
    if (entry.anchorId !== L2_ANCHOR_ID || entry.subject === 'baseline') continue;
    if (entry.winRateCI.lower <= TRANSCENDENCE_TRIGGER_THRESHOLD) continue;

    const flag = entry.subject;
    const wasAdopted = adoptedFlags.includes(flag);
    console.log(`   N=40 트리거됨: ${flag} (winRateCI.lower=${pct(entry.winRateCI.lower)}) — N=${CONFIRM_N} 확증 측정 실행`);
    const candidateBot = wasAdopted ? composeBot(adapter, promotedFlags) : composeBot(adapter, [flag]);
    const confirmResult = runHeadToHead(
      adapter,
      candidateBot,
      hearthstoneOpusBot,
      seeds(CONFIRM_SEED_BASE, CONFIRM_N),
      CONFIRM_BOT_SEED_BASE,
    );
    console.log(`   확증(N=${CONFIRM_N}) ${flag} vs L2: winRate=${pct(confirmResult.candidateWinRate)} CI=${ciStr(confirmResult)}`);

    const confirmTriggered = confirmResult.winRateCI.lower > TRANSCENDENCE_TRIGGER_THRESHOLD;
    let l3Result: HeadToHeadResult | null = null;
    if (confirmTriggered) {
      console.log(`   확증도 트리거 통과 — L3(${L3_ANCHOR_ID}) 홀드아웃 판정 실행 (N=${L3_N}, 게이트 없음)`);
      const l3Anchor = registry.getAnchor(L3_ANCHOR_ID);
      if (!l3Anchor) {
        throw new Error(`hearthstone-portfolio-round2: anchor "${L3_ANCHOR_ID}" is not registered`);
      }
      // 홀드아웃 가드: 이 결과로 LossReport/probe-bank를 만들지 않는다.
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

  console.log('10) near-miss 추출 + runs/hearthstone/portfolio-round2.json 저장(설계 기록/transcendence 병합)');
  const nearMiss = extractNearMissCandidates(adoptionRecord, round.criteria);
  writeFileSync(join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round2-near-miss.json'), JSON.stringify(nearMiss, null, 2));

  const summary = {
    gameId: GAME_ID,
    generatedAt: recordedAt,
    designSpecPath: 'scratchpad/hearthstone-round2-design-spec.md (main-loop, 그대로 구현)',
    lineageBaseline: { version: latest.version, flags: latest.flags },
    b1WeightRationale:
      '설계 브리프의 w2/w24 예시 대신 w2/w8을 택함 — 1회전 같은 웨이브 문맥 N=40 challenge vs L2가 ' +
      'w0(=ismcts-s128-hr) 40.0% / w4 46.3% / w16 42.5% / w48 36.3%로 w4 부근 내부 최적점을 보였고, ' +
      'w24는 이미 하강 구간이라 정보량이 낮다고 판단(설계 브리프가 명시 허용한 조정, 사유 기록 조항 이행).',
    b2TargetSelection: {
      source: 'runs/hearthstone/challenge-l2-round2/judgment-summary.json (probeBank.mismatchByChoiceKind)',
      note: '1회전 타깃 재사용 금지 지시에 따라 2회전 자체 채굴로 재선정 — play가 여전히 최다(잔여 불일치 135건 중 101건). 처치 기전은 1회전 B2와 다르다(밴드 교체가 아니라 배틀크라이 제거의 밴드 승격).',
    },
    b3BlendSweep: {
      probeBank: 'runs/hearthstone/probe-bank-round2.json',
      probeScoreBotSeedBase: PROBE_SCORE_BOT_SEED_BASE,
      rows: sweepRows,
      selected: bestSweep.weights,
    },
    probeBankSources: {
      round1: { path: `runs/${GAME_ID}/probe-bank.json`, probes: probesRound1.length },
      round2: { path: `runs/${GAME_ID}/probe-bank-round2.json`, probes: probesRound2.length },
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
      baselineFlags: latest.flags,
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
      'B5-imitate': '이번 라운드 0 후보 — 설계 브리프에 B5 후보 없음(1회전과 동일한 버킷 비중 프리셋 유지).',
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
  console.log(`   저장: runs/${GAME_ID}/portfolio-round2.json`);
}

main();
