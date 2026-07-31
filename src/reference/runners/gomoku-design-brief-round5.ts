/**
 * gomoku-design-brief-round5 — GAP-11 오목 5회전 전반부(브리프), following
 * ./gomoku-design-brief-round4.ts's precedent verbatim (renderDesignBrief는
 * 여전히 round1의 고정 경로를 읽고, 이번 라운드 산출물
 * challenge-l2-round5/{loss-report,draw-report,draw-convergence,
 * judgment-summary}.json은 `extraEvidence`로 들어간다).
 *
 * axisMatrix는 round4 브리프의 행을 이번 라운드 실측으로 갱신한다(A4/A7 행).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer) per src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { renderDesignBrief } from '../../artifacts/design-brief';

const GAME_ID = 'gomoku';
const ROOT_DIR = join(__dirname, '..', '..', '..');

function pct(x: number | undefined): string {
  return typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '-';
}

interface JudgmentSummaryRound5 {
  readonly registry?: { readonly composedFlags?: readonly string[] };
  readonly measurement1_v7VsL2?: {
    readonly result?: {
      readonly candidateWinRate?: number;
      readonly drawRate?: number;
      readonly winRateCI?: { readonly lower?: number; readonly upper?: number };
    };
  };
  readonly lossReport?: {
    readonly candidateLosses?: number;
    readonly totalGames?: number;
    readonly divergenceCount?: number;
    readonly firstDivergenceDepthHistogram?: Readonly<Record<string, number>>;
    readonly topMismatchDecisionPoints?: ReadonlyArray<{
      readonly decisionPointId: string;
      readonly decisions: number;
      readonly mismatches: number;
      readonly mismatchRate: number;
    }>;
  };
  readonly drawReport?: {
    readonly drawGames?: number;
    readonly gameLengthHistogram?: Readonly<Record<string, number>>;
    readonly firstDivergenceDepthHistogram?: Readonly<Record<string, number>>;
    readonly lastDivergenceDepthHistogram?: Readonly<Record<string, number>>;
    readonly topMismatchDecisionPoints?: ReadonlyArray<{
      readonly decisionPointId: string;
      readonly decisions: number;
      readonly mismatches: number;
      readonly mismatchRate: number;
    }>;
  };
  readonly drawConvergence?: {
    readonly drawGames?: number;
    readonly lastDecisiveOpportunityHistogram?: Readonly<Record<string, number>>;
    readonly deadTailLengthHistogram?: Readonly<Record<string, number>>;
    readonly meanLastDecisiveOpportunityDepth?: number;
    readonly meanDeadTailLength?: number;
    readonly meanGameLength?: number;
  };
  readonly probeBank?: { readonly probeCount?: number; readonly l2SelfAgreementRate?: number; readonly v7AgreementRate?: number };
  readonly measurement2_v7VsL1?: {
    readonly result?: { readonly candidateWinRate?: number; readonly winRateCI?: { readonly lower?: number; readonly upper?: number } };
    readonly gradientRestored?: boolean;
  };
}

function main(): void {
  console.log(`=== gomoku design brief round 5 (GAP-11 Phase 4) — rootDir=${ROOT_DIR} ===`);

  const axisMatrix = [
    {
      axis: 'A1 탐색 예산',
      status: '완료(기각, 축 소진)',
      note: '카드 1~5 s256 단독 0%, 3회전 s512/s768 기각 — ADR-0009 재시도 금지 대상',
    },
    { axis: 'A2 롤아웃 정책 교체', status: '완료(시도-0%, 축 소진)' },
    { axis: 'A3 전술 프리체크', status: '완료(시도-0%, 축 소진)' },
    {
      axis: 'A4 루트 오버라이드',
      status: '재시도(5회전 B4)',
      note:
        '과거 시도는 forkAwareness 기하 기반 단독(mcts3-s256-override, 0%). 5회전은 **클론 위협 점수 기반**으로 ' +
        '결정적 위협(열린 4 이상)만 루트에서 가로채는 A4×A10 결합 — 축 자체의 재시도가 아니라 미시도 조합.',
    },
    { axis: 'A5 트리 prior (D1+D2)', status: '완료(시도-성공, 이산 티어는 포화)' },
    {
      axis: 'A6 상대 정보 기반 설계 (D4)',
      status: '완료(시도-성공)',
      note: '라운드1 오프닝 정책이 첫 성공례. 5회전 B2는 이 축 위에서 프로브 분포에 맞춘 priorWeight 스케줄로 재시도.',
    },
    {
      axis: 'A7 오프닝 북 / 정석 테이블',
      status: '착수(5회전 B1, 저비용)',
      note:
        'round4 조사대로 신규 인프라 불요(gomokuOpeningThenPriorFlagSpec 재사용). round4는 "손실의 절반만 초반"이라 ' +
        '기대수익을 하향했지만, **5회전 재채굴은 다시 초반 집중을 보인다**(첫 분기 0-9구간 28/41, 프로브 52개 중 32개가 ' +
        'decisionIndex 0-9) — 그래서 B1(저비용) 버킷에서 오프닝 창 3/5 스윕으로 착수.',
    },
    {
      axis: 'A8 도메인 전략 재설계',
      status: '5회전 신규 시도(B3 drawaverse)',
      note:
        '이산 티어 계열은 포화. 5회전은 "무승부로 가는 수 자체를 덜 선호"하는 랭킹 편향이라는 새 형태 — ' +
        '이 라운드 채굴의 무승부 수렴 분석(강제 위협 가능한 마지막 수순 평균 140.5수)이 ramp 구간을 직접 정했다.',
    },
    { axis: 'A9 학습(MCCFR/정책 테이블)', status: '부적격(상태공간)' },
    {
      axis: 'A10 모방/이식 (B5)',
      status: '완료(시도-성공, 현 챔피언)',
      note: 'v7 = opusclone 단독. 5회전 후보 5개 전부 이 클론 위에 얹는 구조라 A10 자체의 재시도는 아니다.',
    },
    { axis: 'A11 비대칭 공격/방어 가중치', status: '완료(시도-성공)' },
  ];

  const round4Body =
    '4회전(2026-07-30): 후보 6종(클론 위 동점 타이브레이크 B3+B1 2종, 클론+chain prior B4, jumpthree B2) ' +
    '**전부 regression 근접실패** — 챔피언 v7(클론 단독)을 못 넘었다. challenge vs L2 최고 48.7%. 채굴 발견 3건: ' +
    '(1) place 불일치율 95.1%→46.8%→4.0%로 질적 전환(남은 패배는 국지적 전술 실수), (2) 패배의 42%는 발산이 ' +
    '전혀 없는 "거울 손실", (3) 무승부 56판 전부 220-229수 보드 소진형. 5회전은 (3)에 대한 최초의 처치(B3 ' +
    'drawaverse)와 (1)에 대한 표적 설계(B2/B4)를 동시에 건다.';

  const summaryPath = join(ROOT_DIR, 'runs', GAME_ID, 'challenge-l2-round5', 'judgment-summary.json');
  let round5Body = '- 산출물 없음(challenge-l2-round5/judgment-summary.json 없음 — gomoku-loss-mining-round5.ts를 먼저 실행)';
  if (existsSync(summaryPath)) {
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as JudgmentSummaryRound5;
    const m1 = summary.measurement1_v7VsL2?.result;
    const m2 = summary.measurement2_v7VsL1?.result;
    const lr = summary.lossReport;
    const dr = summary.drawReport;
    const dc = summary.drawConvergence;
    const lossTopMismatches = (lr?.topMismatchDecisionPoints ?? [])
      .map((e) => `${e.decisionPointId}=${pct(e.mismatchRate)}(${e.mismatches}/${e.decisions})`)
      .join(', ');
    const drawTopMismatches = (dr?.topMismatchDecisionPoints ?? [])
      .map((e) => `${e.decisionPointId}=${pct(e.mismatchRate)}(${e.mismatches}/${e.decisions})`)
      .join(', ');

    round5Body =
      `v7 합성봇(실질 = mcts12-s256-opusclone-w16 단독)의 5회전 재채굴 (gomoku-loss-mining-round5.ts, 신규 시드 ` +
      `810,000+/811,000+):\n\n` +
      `- v7 vs L2(opus): winRate=${pct(m1?.candidateWinRate)} CI=[${pct(m1?.winRateCI?.lower)}, ${pct(m1?.winRateCI?.upper)}] ` +
      `draw=${pct(m1?.drawRate)} (N=100 — 3회전 확증 51.0%[47.5-54.5], 4회전 확증 50.0%[46.6-53.4]와 같은 대등 구간)\n` +
      `- v7 vs L1(mid): winRate=${pct(m2?.candidateWinRate)} (그래디언트 ${summary.measurement2_v7VsL1?.gradientRestored ? 'PASS' : 'FAIL'})\n` +
      `- 패배: ${lr?.candidateLosses ?? '-'}/${lr?.totalGames ?? '-'}, 발산 ${lr?.divergenceCount ?? '-'}건, ` +
      `무승부: ${dr?.drawGames ?? '-'}/${lr?.totalGames ?? '-'}\n` +
      `- 패배판 첫 분기 깊이: ${JSON.stringify(lr?.firstDivergenceDepthHistogram ?? {})}\n` +
      `- 패배판 불일치율(place): ${lossTopMismatches || '(none)'}\n` +
      `- 무승부판 길이: ${JSON.stringify(dr?.gameLengthHistogram ?? {})}, 첫 분기 ` +
      `${JSON.stringify(dr?.firstDivergenceDepthHistogram ?? {})}, 마지막 분기 ` +
      `${JSON.stringify(dr?.lastDivergenceDepthHistogram ?? {})}\n` +
      `- 무승부판 불일치율(place): ${drawTopMismatches || '(none)'}\n` +
      `- 프로브(round5): ${summary.probeBank?.probeCount ?? '-'}개, L2 자기일치율=${pct(summary.probeBank?.l2SelfAgreementRate)}, ` +
      `v7 일치율=${pct(summary.probeBank?.v7AgreementRate)}\n\n` +
      `**신규 분석 — 무승부 수렴은 평균 140수에 이미 확정된다**: 무승부판을 재생해 매 수마다 착수자가 만들 수 있었던 ` +
      `최대 자기 위협을 계산한 결과, 열린 3 이상(응수를 강제하는 최저 등급)을 만들 수 있었던 **마지막 수순의 평균이 ` +
      `${dc?.meanLastDecisiveOpportunityDepth?.toFixed(1) ?? '-'}수**였다(히스토그램 ` +
      `${JSON.stringify(dc?.lastDecisiveOpportunityHistogram ?? {})}). 게임 평균 길이는 ` +
      `${dc?.meanGameLength?.toFixed(1) ?? '-'}수이므로, **평균 ${dc?.meanDeadTailLength?.toFixed(1) ?? '-'}수는 ` +
      `어떤 착수로도 강제 위협을 만들 수 없는 "죽은 꼬리"**다(${JSON.stringify(dc?.deadTailLengthHistogram ?? {})}). ` +
      `round4의 "마지막 분기가 210-229구간"이라는 관찰은 그 구간의 불일치가 **의미 있는 승부 분기가 아니라 빈칸 ` +
      `채우기**였다는 뜻이고, 실제 개입 가능한 마지막 시점은 그보다 70-80수 이르다. 5회전 B3(drawaverse)의 ramp ` +
      `구간 [60, 140]이 이 실측에서 직접 나왔다.\n\n` +
      `**round4와 어긋난 관찰(감추지 않는다)**: round4는 패배 첫 분기가 10~109수로 흩어져 "중후반 국지적 전술"을 ` +
      `다음 표적으로 지목했지만, 5회전의 독립 표본은 다시 초반 집중을 보인다(0-9구간 28건, 프로브 52개 중 32개가 ` +
      `decisionIndex 0-9). 두 라운드 모두 N=100 표본이므로 어느 쪽도 확정이 아니며, 이번 라운드의 B1(오프닝)과 ` +
      `B2(초반 prior 강화)는 **이번 라운드 자신의 채굴**을 따랐다.`;
  }

  const extraEvidence = [
    { title: '4회전 요약(후보 전멸, 부정 결과)', body: round4Body },
    { title: '5회전 재채굴 요약 (gomoku-loss-mining-round5.ts, 이번 라운드)', body: round5Body },
  ];

  const brief = renderDesignBrief({
    gameId: GAME_ID,
    rootDir: ROOT_DIR,
    axisMatrix,
    extraEvidence,
  });

  mkdirSync(join(ROOT_DIR, 'runs', GAME_ID), { recursive: true });
  const outPath = join(ROOT_DIR, 'runs', GAME_ID, 'design-brief-round5.md');
  writeFileSync(outPath, brief);
  console.log(`저장: runs/${GAME_ID}/design-brief-round5.md`);
}

main();
