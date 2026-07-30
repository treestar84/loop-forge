/**
 * gomoku-design-brief-round4 — GAP-11 Phase 4 오목 4회전 전반부(브리프, 팀리드
 * 지시), following gomoku-design-brief-round2.ts's precedent verbatim.
 *
 * `renderDesignBrief` itself still reads round 1's fixed paths
 * (`challenge-l2/loss-report.json`, `probe-bank.json`) — this round's new
 * loss-mining-round4.ts outputs (challenge-l2-round4/{loss-report,
 * draw-report,judgment-summary}.json, probe-bank-round4.json) go into
 * `extraEvidence`, same discipline round2's brief already established.
 *
 * axisMatrix rows update gomoku's column of docs/GAP-ANALYSIS-11.md §3 D6's
 * table through round 3 (3회전 미니 진단까지의 실측 반영) plus this round's A7
 * 선행-인프라 조사 결과(팀리드 지시 항목 3).
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

interface JudgmentSummaryV7 {
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
  readonly probeBank?: { readonly probeCount?: number; readonly l2SelfAgreementRate?: number; readonly v7AgreementRate?: number };
  readonly measurement2_v7VsL1?: {
    readonly result?: { readonly candidateWinRate?: number; readonly winRateCI?: { readonly lower?: number; readonly upper?: number } };
    readonly gradientRestored?: boolean;
  };
}

function main(): void {
  console.log(`=== gomoku design brief round 4 (GAP-11 Phase 4) — rootDir=${ROOT_DIR} ===`);

  const axisMatrix = [
    {
      axis: 'A1 탐색 예산',
      status: '완료(기각)',
      note: '카드 1~5 s256 단독 0%, 3회전 미니 진단(s512/s768, opusclone evaluator 위 예산 우위)도 기각(vs L2 45.8~46.0%, 전부 s256의 51.0%와 CI 겹침) — 예산 축 소진 선언(ADR-0009), 축 폐기',
    },
    { axis: 'A2 롤아웃 정책 교체', status: '완료(시도-0%)' },
    { axis: 'A3 전술 프리체크', status: '완료(시도-0%)' },
    { axis: 'A4 루트 오버라이드', status: '완료(시도-0%)' },
    {
      axis: 'A5 트리 prior (D1+D2)',
      status: '완료(시도-성공)',
      note: '라운드1 chain/defensive(B3/B4)로 L2 0%→25.6%, 라운드2 combined 계열로 8~28%대 유지·opening5-defensive는 필터 탈락 — 이산 티어 축은 포화, opusclone(A10)으로 주도권 이동',
    },
    {
      axis: 'A6 상대 정보 기반 설계 (D4)',
      status: '완료(시도-성공)',
      note: '라운드1 오프닝 정책(mcts7-s256-opening6-prior-w16)이 LossReport 표적 설계의 첫 성공례. 단 composeBot 조립 결함으로 v6/v7에서는 실행되지 않음(A7 참고) — 축 자체의 유효성과 조립 생존 여부는 별개',
    },
    {
      axis: 'A7 오프닝 북 / 정석 테이블',
      status: '조사 완료(인프라 불필요, 착수는 이연)',
      note:
        '이번 라운드 조사 결과: registry `kind` 일반화나 새 인프라는 필요 없다. `gomokuOpeningThenPriorFlagSpec` ' +
        '(src/reference/runners/shared/gomoku-round1-candidates.ts)가 이미 "첫 N수는 하드코딩 결정 규칙 → 이후 ' +
        'MCTS로 전환"하는 StrategyFlagSpec을 구현하고 있고(mcts7-s256-opening6-prior-w16/mcts11-s256-opening5-' +
        'defensive-w16이 이 패턴으로 이미 배치됨), "포지션→착수" 룩업 테이블도 같은 시그니처(`apply: () => (seed) => ' +
        '{ decide(...) { 테이블에 있으면 그 수, 없으면 engine.decide(...) } }`, `assembly: \'terminal\'`)로 즉시 만들 ' +
        '수 있다. 즉 A7은 순수 설계/데이터 문제(어떤 국면을 테이블에 넣을 것인가)이지 아키텍처 선행 작업이 아니다. ' +
        '다만 이번 라운드의 LossReport 재측정(아래 핵심 발견 1)이 "패배가 전부 첫 10수에 갈린다"는 전제 자체를 ' +
        '약화시켰다(첫 분기의 53%만 0-9구간, 나머지는 20~100수대 꼬리) — 오프닝북의 기대 수익이 라운드1~2 대비 ' +
        '낮아져 다음 카드로 이연.',
    },
    {
      axis: 'A8 도메인 전략 재설계',
      status: '완료(부분)',
      note: 'forkAwareness(구) + 비대칭 방어 가중치(defensive) + combined(defensive+chain) — 이산 티어 평가함수 계열의 한계선까지 도달',
    },
    { axis: 'A9 학습(MCCFR/정책 테이블)', status: '부적격(상태공간)' },
    {
      axis: 'A10 모방/이식 (B5)',
      status: '완료(시도-성공, 최대 수율)',
      note:
        '라운드2 B4 opusclone(L2 자신의 위협-점수 함수를 트리 prior로 이식) — L2 상대 승률이 사상 처음 50%를 ' +
        '돌파(2회전 확증 51.0%[47.5-54.5], 이번 4회전 재채굴 55.0%[50.5-59.8] — CI 하한이 처음으로 0.5를 넘음, ' +
        '단 이 측정은 확증 프로토콜이 아닌 채굴용 N=100 표본이라 L3 홀드아웃 트리거 판정은 팀리드/메인 루프 확인 ' +
        '필요). 모방의 성패는 축이 아니라 주입 수준(롤아웃 모방은 실패, tree prior 이식은 성공)이 갈랐다.',
    },
    {
      axis: 'A11 비대칭 공격/방어 가중치',
      status: '완료(시도-성공)',
      note: '라운드1 B4 defensive — L2 상대 승률 최초 0%대 탈출(25.6%). 판당 비용 4~6배(원인: 탐색 확산, 코드 결함 아님)',
    },
  ];

  const round3Body =
    '3회전 미니 진단(gomoku-round3-candidates.ts, 부정 결과): v7(=opusclone-w16 단독)과 L2가 같은 위협함수 위에서 ' +
    '대국하는 거울 대국이라는 가설 위에, evaluator는 그대로 두고 탐색 예산만 s256→s512/s768로 올려 "예산 우위가 ' +
    '거울에서 결정 게임을 가져올 수 있는가"를 검증했다. **기각**: s512 45.8%[41.0-51.0], s768 46.0%[40.5-52.0] ' +
    '— 전부 s256 자신의 51.0%[47.5-54.5]와 CI 겹침, 무승부율도 52~59% 그대로. 예산 축은 이 조합에서도 무효 ' +
    '(ADR-0009, 축 소진 선언). 3회전 시점 결론: v7 = L2와 통계적 대등, 초월 미달. 무승부 57.5%의 "거울 대국을 ' +
    '가르는 축"이 다음 카드로 이연됐다 — 이번 4회전 재채굴의 draw-report.json이 바로 이 질문에 대한 정량 데이터다.';

  const summaryPath = join(ROOT_DIR, 'runs', GAME_ID, 'challenge-l2-round4', 'judgment-summary.json');
  let round4Body = '- 산출물 없음(challenge-l2-round4/judgment-summary.json 없음 — gomoku-loss-mining-round4.ts를 먼저 실행)';
  if (existsSync(summaryPath)) {
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as JudgmentSummaryV7;
    const m1 = summary.measurement1_v7VsL2?.result;
    const m2 = summary.measurement2_v7VsL1?.result;
    const lr = summary.lossReport;
    const dr = summary.drawReport;
    const lossTopMismatches = (lr?.topMismatchDecisionPoints ?? [])
      .map((e) => `${e.decisionPointId}=${pct(e.mismatchRate)}(${e.mismatches}/${e.decisions})`)
      .join(', ');
    const drawTopMismatches = (dr?.topMismatchDecisionPoints ?? [])
      .map((e) => `${e.decisionPointId}=${pct(e.mismatchRate)}(${e.mismatches}/${e.decisions})`)
      .join(', ');

    round4Body =
      `v7 합성봇(flags=[${(summary.registry?.composedFlags ?? []).join(', ') || '(none)'}], composeBot의 "MCTS 계열 ` +
      `플래그는 base를 완전히 무시" 규칙상 실질적으로 마지막 항목인 mcts12-s256-opusclone-w16 단독과 완전히 동일 — ` +
      `이 사실은 round2 재채굴에서 이미 규명됐고, 이번 라운드는 v7 실행 로그의 composedFlags 배열을 그대로 재출력해 ` +
      `재확인만 했다)의 4회전 재채굴 판정 실험 (gomoku-loss-mining-round4.ts, GAP-11 Phase 4):\n\n` +
      `- v7 vs L2(opus): winRate=${pct(m1?.candidateWinRate)} CI=[${pct(m1?.winRateCI?.lower)}, ${pct(m1?.winRateCI?.upper)}] ` +
      `draw=${pct(m1?.drawRate)} (N=100, 신규 시드 800,000-800,099 — 3회전 확증치 51.0%[47.5-54.5]/무승부57.5%와 비교)\n` +
      `- v7 vs L1(mid): winRate=${pct(m2?.candidateWinRate)} CI=[${pct(m2?.winRateCI?.lower)}, ${pct(m2?.winRateCI?.upper)}] ` +
      `(그래디언트 추적: ${summary.measurement2_v7VsL1?.gradientRestored ? 'PASS' : 'FAIL'}, 2회전 확증치 93.8%와 비교)\n` +
      `- 패배: ${lr?.candidateLosses ?? '-'}/${lr?.totalGames ?? '-'}, 무승부: ${dr?.drawGames ?? '-'}/${lr?.totalGames ?? '-'}\n` +
      `- 패배판 첫 분기 깊이 히스토그램: ${JSON.stringify(lr?.firstDivergenceDepthHistogram ?? {})}\n` +
      `- 패배판 불일치율(place): ${lossTopMismatches || '(none)'}\n` +
      `- 무승부판 길이 히스토그램: ${JSON.stringify(dr?.gameLengthHistogram ?? {})}\n` +
      `- 무승부판 첫/마지막 분기 깊이 히스토그램: 첫=${JSON.stringify(dr?.firstDivergenceDepthHistogram ?? {})}, ` +
      `마지막(안착 지점 근사)=${JSON.stringify(dr?.lastDivergenceDepthHistogram ?? {})}\n` +
      `- 무승부판 불일치율(place): ${drawTopMismatches || '(none)'}\n` +
      `- 프로브(round4, probe-bank-round4.json): 신규 ${summary.probeBank?.probeCount ?? '-'}개, ` +
      `L2 자기일치율=${pct(summary.probeBank?.l2SelfAgreementRate)}(1.0 기대), v7 일치율=${pct(summary.probeBank?.v7AgreementRate)} ` +
      `(round4 프로브 은행은 v7 자신의 패배 분기점에서 채굴된 것이므로 정의상 0%에 가깝다 — round1/2와 동일한 방법론적 이유)\n\n` +
      `**핵심 발견 1 — 승률 추가 개선, 패배 분기 구조는 질적으로 변했다**: v7 vs L2 55.0%[50.5-59.8]는 3회전 확증치 ` +
      `51.0%[47.5-54.5]보다 점추정이 높고 **CI 하한이 처음으로 0.5를 넘었다**(신규 독립 표본 N=100). 다만 이 측정은 ` +
      `채굴용 러너의 부산물이지 portfolio-*-confirm.ts류의 확증 프로토콜이 아니므로, L3 홀드아웃 트리거(초월 판정) ` +
      `실행 여부는 이 브리프의 판단 범위 밖 — 팀리드/메인 루프가 별도 확증 측정으로 재확인할 것을 권고한다. ` +
      `한편 패배판의 place 불일치율은 **4.0%(46/1152)로 라운드2의 46.8%, 라운드1의 95.1%에서 극적으로 하락** — ` +
      `v7(opusclone)이 L2 자신의 채점 로직을 이식했으므로 당연한 결과다. 그런데 첫 분기 깊이 히스토그램은 더 이상 ` +
      `"전부 첫 10수"가 아니다: 36개 발산 손실 게임 중 19개(53%)만 0-9구간, 나머지는 10~109수 사이에 넓게 퍼져 ` +
      `있다(10-19:3, 20-29:8, 30-39:2, 50-59:1, 70-79:1, 80-89:1, 100-109:1). **1~2회전과 다른 구조다**: 예전에는 ` +
      `"전략 수준 자체가 낮아 초반부터 전방위로 갈리는" 손실이었지만, 지금은 "거의 전 결정에서 L2와 일치하다가 ` +
      `드물게(4%) 특정 국면에서만 갈리는" 손실이고, 그 갈리는 지점이 게임 전반에 걸쳐 흩어져 있다 — 국지적 전술 ` +
      `실수(넓은 전략 격차 아님)가 남은 패배의 원인이라는 뜻.\n\n` +
      `**핵심 발견 2(신규, 팀리드 지시 항목) — 패배의 42%는 발산이 전혀 없는 "거울 손실"**: candidateLosses=62 중 ` +
      `divergences가 1건 이상 있는 게임은 36개뿐 — 나머지 26개(42%)는 후보가 자신의 모든 결정에서 L2 자신이 ` +
      `택했을 수와 완전히 동일하게 두었는데도 패배했다. v7이 L2의 완전한 클론(opusclone evaluator)이므로 이는 ` +
      `구조적으로 당연하다: 두 플레이어가 거의 같은 정책으로 대국하면 승부는 오목의 선/후공 비대칭(선공 우위) 같은 ` +
      `구조적 요인이 가른다는 뜻 — evaluator를 더 다듬어도 이 42%는 줄어들지 않을 가능성이 높다(3회전의 "거울 ` +
      `대국에서 예산 우위 무효" 결론과 같은 계열의 증거).\n\n` +
      `**핵심 발견 3 — 무승부는 "안착"하지 않는다, 끝까지 갈리다가 보드가 차서 강제 종료된다**: 무승부 56게임 ` +
      `전부 길이 220-229수(15x15=225칸 보드가 거의 다 찬 상태)에서 끝난다 — 무승부율이 국지적 안전 전략(둘 다 ` +
      `일찍 위협을 다 막아 안정된 국면에 안착)이 아니라 **보드 소진형 무승부**임을 뜻한다. 마지막 분기 깊이 ` +
      `히스토그램이 이를 뒷받침한다: 210-219구간에 40건, 220-229구간에 16건 — 즉 후보와 L2(자기 자신 기준)의 ` +
      `불일치가 **게임이 끝나기 10수 안쪽까지 계속된다**. "무승부로 안착하는 지점이 초반/중반/후반 중 어디인가"에 ` +
      `대한 답은 **"후반 끝자락(보드 소진 직전)"**이지만, 그 이유는 전술적 합의가 아니라 남은 합법수가 몇 개 안 ` +
      `남아 기계적으로 수렴하는 것으로 보인다(합법수 고갈). 실제로 무승부판의 place 불일치율은 **11.6%(724/6218)로 ` +
      `패배판(4.0%)의 3배 가깝다** — 후보가 무승부 게임에서는 L2 자신의 선택과 오히려 더 자주 다르게 두는데도 ` +
      `승부를 못 가른다는 뜻. 첫 분기도 초반(0-9:17)에 몰려 있지만 140-179 구간에도 두 번째 뭉치(140-149:4, ` +
      `150-159:5, 160-169:9, 170-179:3 = 21건)가 있어, 무승부 게임은 "초반 한 번 갈리고 중반부에 또 한 번 크게 ` +
      `갈리는" 이중 분기 패턴을 보인다 — 초반 단일 분기 후 그대로 패배로 가는 손실 게임과 뚜렷이 다른 프로필.\n\n` +
      `**Phase 5 설계 입력 정리**: (a) 잔여 패배(58%가 4% 불일치의 국지적 전술 실수, 42%가 거울 구조적 손실 — ` +
      `전자만 evaluator 개선으로 공략 가능)를 잡으려면 오프닝북(A7)보다는 **분산된 중후반 전술 실수 지점**(place ` +
      `불일치 국면 46개, probe-bank-round4.json에 봉인)을 겨냥한 설계가 더 표적화됨. (b) 무승부(58%)를 승부로 ` +
      `바꾸려면 "안착점을 흔드는" 것이 아니라 **초반(0-9)과 중반(140-179) 이중 분기 지점에서 공격적 수를 강제하는** ` +
      `evaluator 변형이 유망(합법수 고갈로 가는 경로 자체를 봉쇄). (c) A7 오프닝북은 이번 라운드 조사로 인프라 ` +
      `장벽이 없다는 게 확인됐으므로 착수 자체는 언제든 가능하지만, 첫 발견처럼 손실의 절반만 초반에 몰려 있어 ` +
      `기대 수익이 라운드1~2 대비 낮다 — B1-exploit(저비용) 버킷 정도로 배치하고 B3/B4는 (a)(b) 쪽에 집중하는 ` +
      `것을 권고.`;
  }

  const extraEvidence = [
    { title: '3회전 요약(미니 진단, 예산 축 기각)', body: round3Body },
    { title: '4회전 재채굴 요약 (gomoku-loss-mining-round4.ts, 이번 라운드)', body: round4Body },
  ];

  const brief = renderDesignBrief({
    gameId: GAME_ID,
    rootDir: ROOT_DIR,
    axisMatrix,
    extraEvidence,
  });

  mkdirSync(join(ROOT_DIR, 'runs', GAME_ID), { recursive: true });
  const outPath = join(ROOT_DIR, 'runs', GAME_ID, 'design-brief-round4.md');
  writeFileSync(outPath, brief);
  console.log(`저장: runs/${GAME_ID}/design-brief-round4.md`);
}

main();
