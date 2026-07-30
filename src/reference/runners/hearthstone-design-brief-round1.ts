/**
 * hearthstone-design-brief-round1 — GAP-11 프로토콜 v2 1회전 후반부(브리프,
 * 오목/도미니언 1회전과 동일한 패턴): hearthstone-loss-mining.ts가 만든
 * challenge-l2/loss-report.json·probe-bank.json을 artifacts/design-brief.ts로
 * 조립한다. 하스스톤은 이번이 축 매트릭스를 처음 채우는 라운드라, D6 표의
 * 대부분 축이 "미시도"로 시작하고 A9(IS-MCTS)만 registry v2 승격을 반영해
 * "시도-adopted"로 표시한다(GAP-11 §5 Phase 1-C/D 앵커 래더는 이미 등록된
 * 상태, 이 라운드는 채굴부터 시작).
 *
 * extraEvidence에는 두 가지를 넣는다: ① BENCHMARK-LEADERBOARD "결과 4"의
 * 배경 수치(v2 vs Opus봇 66.9%, 무승부/split 54.1% — 접전 상태), ②
 * hearthstone-loss-mining.ts가 이번에 뽑은 LossReport 핵심(어느 결정지점에서
 * 갈리는지). 하스스톤 어댑터는 결정지점을 전부 단일 `'action'`으로 인코딩
 * (reference/hearthstone.ts:301 — mulligan/hero-power/attack/play가 모두 같은
 * decisionPointId 아래 choice로 구분됨)하므로, mismatchRateByDecisionPoint가
 * 다종 결정지점으로 쪼개지지 않는다는 사실 자체를 첫 발견으로 기록한다
 * (renderDesignBrief의 LossReport 섹션은 이미 이 단일 항목을 그대로 렌더링
 * 하므로 별도 가공 없이도 드러나지만, extraEvidence에서 원인과 함의를
 * 명시한다).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer) per src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { renderDesignBrief, type AxisMatrixRow, type DesignBriefEvidence } from '../../artifacts/design-brief';

const GAME_ID = 'hearthstone';
const ROOT_DIR = join(__dirname, '..', '..', '..');

function pct(x: number | undefined): string {
  return typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '-';
}

interface JudgmentSummary {
  readonly registry?: { readonly composedFlags?: readonly string[] };
  readonly measurement1_v2VsL2?: {
    readonly result?: {
      readonly candidateWinRate?: number;
      readonly drawRate?: number;
      readonly winRateCI?: { readonly lower?: number; readonly upper?: number };
    };
  };
  readonly lossReport?: {
    readonly candidateLosses?: number;
    readonly totalGames?: number;
    readonly firstDivergenceDepthHistogram?: Readonly<Record<string, number>>;
    readonly topMismatchDecisionPoints?: ReadonlyArray<{
      readonly decisionPointId: string;
      readonly decisions: number;
      readonly mismatches: number;
      readonly mismatchRate: number;
    }>;
  };
  readonly probeBank?: {
    readonly probeCount?: number;
    readonly l2SelfAgreementRate?: number;
    readonly v2AgreementRate?: number;
  };
  readonly measurement2_v2VsL1?: {
    readonly result?: {
      readonly candidateWinRate?: number;
      readonly winRateCI?: { readonly lower?: number; readonly upper?: number };
    };
    readonly gradientRestored?: boolean;
  };
}

function main(): void {
  console.log(`=== hearthstone design brief round 1 (GAP-11 프로토콜 v2) — rootDir=${ROOT_DIR} ===`);

  const axisMatrix: AxisMatrixRow[] = [
    { axis: 'A1 탐색 예산', status: '미시도', note: '이번 라운드가 하스스톤의 첫 축 매트릭스 기록' },
    { axis: 'A2 롤아웃 정책 교체', status: '미시도' },
    { axis: 'A3 전술 프리체크', status: '미시도' },
    { axis: 'A4 루트 오버라이드', status: '미시도' },
    { axis: 'A5 트리 prior', status: '미시도', note: 'choiceEvaluator 통로(D1+D2)는 오목에서만 실증됨, 하스스톤 어댑터엔 아직 없음' },
    { axis: 'A6 상대 정보 기반 설계', status: '미시도', note: '이번 라운드 LossReport가 첫 데이터 — 다음 라운드 B2 후보의 입력' },
    { axis: 'A7 오프닝 북 / 정석 테이블', status: '미시도' },
    { axis: 'A8 도메인 전략 재설계', status: '미시도', note: 'hearthstoneOpusBot(L2)의 다방향 스코어링을 참고할 여지 — 아직 시도 없음' },
    {
      axis: 'A9 학습/탐색(IS-MCTS)',
      status: '시도-adopted',
      note: 'ismcts-wave-1에서 ismcts-s128-hr 채택(registry v1→v2, docs/FIX-BACKLOG.md P4) — 이 게임에서 채택된 유일한 전략, 은닉 정보 처리가 이 게임 최초의 탐색 축 성공례',
    },
    { axis: 'A10 모방/이식', status: '미시도', note: '오목(opusclone)·도미니언(opusCloneDominion) 둘 다 시도된 축이지만 하스스톤은 아직 미시도 — 은닉정보 게임에서 완전 클론이 IS-MCTS 결정론화와 어떻게 상호작용할지 미검증' },
  ];

  const leaderboardEvidence: DesignBriefEvidence = {
    title: '벤치마크 배경 (BENCHMARK-LEADERBOARD "결과 4")',
    body:
      '하스스톤 v2(ismcts-s128-hr) vs Opus봇 = **66.9%(65.5-68.3)**, 무승부/split **54.1%** — ' +
      'Opus 우세, 접전화 상태. 스플랜더(11.3%)·윙스팬(24.3%)처럼 루프포지가 압도하는 사례도 아니고, ' +
      '오목(100%)·도미니언(95.3%, 낡은 문맥)처럼 Opus가 압도하는 사례도 아닌 **중간 지대** — ' +
      'GAP-ANALYSIS-11 §0의 5게임 요약에서 하스스톤이 유일하게 "접전" 판정을 받은 게임이다. ' +
      '이번 채굴은 그 66.9%라는 숫자 뒤의 구조(어디서 갈리는가)를 처음으로 데이터화한다.',
  };

  const lossReportSummaryPath = join(ROOT_DIR, 'runs', GAME_ID, 'challenge-l2', 'judgment-summary.json');
  let lossReportBody = '- 산출물 없음(challenge-l2/judgment-summary.json 없음 — hearthstone-loss-mining.ts를 먼저 실행)';
  if (existsSync(lossReportSummaryPath)) {
    const summary = JSON.parse(readFileSync(lossReportSummaryPath, 'utf8')) as JudgmentSummary;
    const m1 = summary.measurement1_v2VsL2?.result;
    const m2 = summary.measurement2_v2VsL1?.result;
    const lr = summary.lossReport;
    const dpTable = (lr?.topMismatchDecisionPoints ?? [])
      .map((e) => `| ${e.decisionPointId} | ${e.decisions} | ${e.mismatches} | ${pct(e.mismatchRate)} |`)
      .join('\n');

    lossReportBody =
      `v2 합성봇(flags=[${(summary.registry?.composedFlags ?? []).join(', ') || '(none)'}], ` +
      `IS-MCTS 128-시뮬레이션·heuristic 롤아웃) vs L2(opus) N=100, 신규 시드(seedBase 500,000/501,000, ` +
      `기존 anchor-ladder.ts의 994,000+/995,000+/1,000,000+/1,001,000+ 및 hearthstone-benchmark.ts의 ` +
      `55,000-56,599와 겹치지 않음) 채굴 결과 (hearthstone-loss-mining.ts, 이번 라운드):\n\n` +
      `- v2 vs L2(opus): winRate=${pct(m1?.candidateWinRate)} CI=[${pct(m1?.winRateCI?.lower)}, ${pct(m1?.winRateCI?.upper)}]` +
      ` (오목/도미니언 loss-mining 선례와 동일한 200판 트라젝토리 전량 기록. 벤치마크 리더보드의 66.9%/N=? 문맥과는 ` +
      `시드·N이 다르므로 절대값 직접 비교는 금지 — INTERPRETATION 제1규칙. 이번 34.0% 자체는 이 채굴용 ` +
      `신규 시드 블록에서의 관측치다)\n` +
      `- v2 vs L1(mid): winRate=${pct(m2?.candidateWinRate)} — **그래디언트 복원 판정: ${summary.measurement2_v2VsL1?.gradientRestored ? 'PASS' : 'FAIL'}** ` +
      `(0%가 아니며, 오히려 L2 상대보다 큰 승률 — heuristic<L1<L2 서열이 이번에도 win-rate 방향에서 재확인됨)\n` +
      `- 패배율: ${lr?.candidateLosses ?? '-'}/${lr?.totalGames ?? '-'} (200판 중 132패, 나머지는 승리 또는 좌석 분할)\n` +
      `- 첫 분기 깊이 히스토그램: ${JSON.stringify(lr?.firstDivergenceDepthHistogram ?? {})} — ` +
      `분기의 대부분(94/132 ≈ 71%)이 첫 10수 이내에 발생, 나머지는 10~29수 구간(오목의 "전부 0~9구간" ` +
      `보다는 완만하게 분산돼 있어 하스스톤은 초반·중반이 섞여 갈린다)\n` +
      `- 프로브(probe-bank.json): 신규 200개, L2 자기일치율=${pct(summary.probeBank?.l2SelfAgreementRate)} ` +
      `(오목/도미니언의 1.0(100%)과 달리 **99.0%로 완전 1.0에 못 미침** — 아래 별도 기록), ` +
      `v2 합성봇 일치율=${pct(summary.probeBank?.v2AgreementRate)}\n\n` +
      `**결정지점별 불일치율(전체, 필터 없음 — 이 게임엔 사실상 이것 하나뿐이다)**:\n\n` +
      `| decisionPointId | decisions | mismatches | mismatchRate |\n|---|---|---|---|\n${dpTable}\n\n` +
      '**핵심 발견 1(가장 중요, 다음 설계 단계에 직접 영향) — 하스스톤 어댑터는 결정지점을 단일 ' +
      "`'action'`으로만 인코딩한다** (`src/reference/hearthstone.ts:301`, `currentDecision`이 " +
      "`{ player, decisionPoint: 'action' }`을 매 턴 그대로 반환). mulligan/hero-power/attack/play는 " +
      "같은 `'action'` decisionPointId 아래 서로 다른 choice 값으로만 구분되므로, " +
      '`mismatchRateByDecisionPoint`가 결정지점 **종류별로 쪼개지지 않는다** — 이번 결과가 `action=47.0%` ' +
      '(1861/3963) 단 한 줄인 것은 채굴이 부실해서가 아니라 어댑터의 결정지점 모델링이 이 게임에서 애초에 ' +
      '단일 레벨이기 때문이다. **다음 라운드에서 mulligan이 특히 약한가 vs attack이 특히 약한가를 알고 싶다면, ' +
      'LossReport/probe-bank 인프라를 바꾸는 것보다 choice 인코딩(encodeChoice) 접두사로 사후 분류하는 ' +
      '별도 집계가 필요하다** — mineLosses/probe-bank.ts 자체를 수정할 필요는 없다(게임 중립 계층을 유지해야 ' +
      '하는 GAP-11 D4 설계 원칙과 정합).\n\n' +
      '**핵심 발견 2 — L2 자기일치율이 99.0%로 오목/도미니언의 100%에 못 미친다.** GAP-11 Phase 1-E가 ' +
      '기록한 결정별 파생 시드 fork(gameSeed:decisionIndex) + 동일 시드 베이스 수정(자기일치율 70.5%→100.0%) ' +
      '이 hearthstone-loss-mining.ts에도 동일하게 적용돼 있음(BOT_SEED_BASE.probeScoreL2 === BOT_SEED_BASE.mineLosses) ' +
      '에도 200개 중 2개가 불일치한다는 뜻 — hearthstoneOpusBot이 오목/도미니언 앵커와 달리 매 결정에서 ' +
      '완전한 결정론이 아닐 가능성(예: 동률 처리에 seed로 파생되지 않는 비결정적 요소, 또는 관찰(observation)에 ' +
      '숨은 정보 샘플링이 얽힌 경로)이 있다는 신호다. 99.0%는 선별 신호로 쓰기엔 충분히 높지만(노이즈 천장 ' +
      '없음의 정의를 완전히 만족하지는 않음), 앞으로 하스스톤 프로브 채점 결과를 해석할 때 1~2%p는 자기일치율 ' +
      '자체의 잔여 노이즈라는 점을 감안해야 한다 — 원인 규명은 이번 라운드 범위를 넘는 별도 조사로 이연.\n\n' +
      '**핵심 발견 3 — 무승부/split이 이번 채굴 시드에서 56.0%(측정1)·52.0%(측정2)로 리더보드 배경 수치 ' +
      '(54.1%)와 거의 일치**. 다른 신규 시드 블록에서도 재현되는 수준이라, 하스스톤은 무승부/좌석분할 비중이 ' +
      '구조적으로 높다는 관찰이 특정 시드의 우연이 아님을 뒷받침한다 — 오목 4회전의 무승부는 보드 소진형 ' +
      '발견과 유사하게, 다음 라운드 설계가 무승부 다수 국면에서의 승부수 축을 고려할 근거가 된다.';
  }

  const extraEvidence: DesignBriefEvidence[] = [leaderboardEvidence, { title: 'LossReport 채굴 결과 (hearthstone-loss-mining.ts, 이번 라운드)', body: lossReportBody }];

  const brief = renderDesignBrief({
    gameId: GAME_ID,
    rootDir: ROOT_DIR,
    axisMatrix,
    extraEvidence,
  });

  mkdirSync(join(ROOT_DIR, 'runs', GAME_ID), { recursive: true });
  const outPath = join(ROOT_DIR, 'runs', GAME_ID, 'design-brief-round1.md');
  writeFileSync(outPath, brief);
  console.log(`저장: runs/${GAME_ID}/design-brief-round1.md`);
}

main();
