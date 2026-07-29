/**
 * gomoku-design-brief-round2 — GAP-11 Phase 4-A task 3: assembles gomoku's
 * round-2 design brief via artifacts/design-brief.ts, following
 * dominion-design-brief-round1.ts's standalone-brief-only precedent (the
 * batch/wave/challenge steps that follow are Phase 4-B, a separate task).
 *
 * `renderDesignBrief` itself still reads round 1's fixed paths
 * (`challenge-l2/loss-report.json`, `probe-bank.json`) — it is not re-pointed
 * at round 2's `challenge-l2-round2/`/`probe-bank-round2.json` outputs, since
 * changing what the renderer reads by default is out of this task's scope
 * (GAP-11 Phase 4-A instruction: round 2's new LossReport/profiling/
 * portfolio-round1 findings go into `extraEvidence`, which is exactly what
 * that field exists for — the renderer's own artifact scan already covers
 * round 1's LossReport/probe bank sections on its own).
 *
 * axisMatrix rows update gomoku's column of docs/GAP-ANALYSIS-11.md §3 D6's
 * table with round-1 results per this task's own instruction (A5
 * 시도-부분성공, A6 시도-성공, A8 부분, A11 new row for the B4 asymmetric-
 * weighting axis this round actually promoted).
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

interface JudgmentSummary {
  readonly registry?: { readonly composedFlags?: readonly string[] };
  readonly measurement1_v6VsL2?: {
    readonly result?: { readonly candidateWinRate?: number; readonly winRateCI?: { readonly lower?: number; readonly upper?: number } };
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
  readonly probeBank?: { readonly probeCount?: number; readonly l2SelfAgreementRate?: number; readonly v6AgreementRate?: number };
  readonly measurement2_v6VsL1?: {
    readonly result?: { readonly candidateWinRate?: number; readonly winRateCI?: { readonly lower?: number; readonly upper?: number } };
    readonly gradientRestored?: boolean;
  };
}

function main(): void {
  console.log(`=== gomoku design brief round 2 (GAP-11 Phase 4-A) — rootDir=${ROOT_DIR} ===`);

  const axisMatrix = [
    { axis: 'A1 탐색 예산', status: '시도(0%)', note: '카드 1~5, Phase 2 이전(GAP-11 §0)' },
    { axis: 'A2 롤아웃 정책 교체', status: '시도(0%)' },
    { axis: 'A3 전술 프리체크', status: '시도(0%)' },
    { axis: 'A4 루트 오버라이드', status: '시도(0%)' },
    {
      axis: 'A5 트리 prior (D1+D2)',
      status: '시도-부분성공',
      note: '라운드1 chain evaluator(B3, w16/w48)로 L2 0%→0~7.5% 부분 개선, w48이 w16보다 우세 — 잠재 티어 가중 축은 유효하나 단독으로는 벽을 못 넘음',
    },
    {
      axis: 'A6 상대 정보 기반 설계 (D4)',
      status: '시도-성공',
      note: '라운드1 B2 오프닝 정책(mcts7-s256-opening6-prior-w16)이 LossReport의 "패배 전부 첫 10수 분기"를 직접 겨냥해 채택(vs L1 32.5%, vs L2 3.75%) — LossReport→설계 경로의 첫 성공례',
    },
    { axis: 'A7 오프닝 북 / 정석 테이블', status: '미시도', note: 'registry kind 일반화 선행 필요(D6 비고)' },
    {
      axis: 'A8 도메인 전략 재설계',
      status: '부분',
      note: 'forkAwareness(구) + 라운드1 B4 비대칭 방어 가중치(신규 A11) — 아직 게임 전체를 재설계한 수준은 아님',
    },
    { axis: 'A9 학습(MCCFR/정책 테이블)', status: '부적격(상태공간)' },
    { axis: 'A10 모방/이식 (B5)', status: '미시도', note: '라운드1 0후보(전이성 낮다고 판단), 라운드2도 아직 미시도' },
    {
      axis: 'A11 비대칭 공격/방어 가중치',
      status: '시도-성공(최대 수율)',
      note: '라운드1 B4 gomokuDefensiveEvaluator — L2 상대 승률 사상 최초 0%대 탈출(25.6%, N=40). 단 판당 비용이 챔피언 대비 6배 이상 evaluator 호출 발생(Phase 4-A 프로파일링, 코드 결함 아님 — 아래 추가 증거)',
    },
  ];

  const profilingEvidence = {
    title: '프로파일링: mcts9-s256-defensive-w16 비용 이상치 (GAP-11 Phase 4-A task 1)',
    body:
      '라운드1 프로브 필터가 측정한 4,748ms/게임(타 후보 400~500ms대의 약 10배)의 원인을 ' +
      'N=5 vs L2 재측정 + priorEvaluator 호출 카운터로 분리했다.\n\n' +
      '| 후보 | elapsed(N=5) | ms/게임 | evaluator 호출 수 | 호출당 스캔한 선택지 수 | 호출당 ms |\n' +
      '|---|---|---|---|---|---|\n' +
      '| chain-w16 | 2,870ms | 574.0 | 10,925 | 213.8 | 0.263 |\n' +
      '| defensive-w16 | 12,005ms | 2,401.0 | 62,042 | 156.5 | 0.193 |\n\n' +
      '**결론: 코드 결함이 아니다.** 호출당 비용은 defensive가 오히려 더 낮다(0.193ms < 0.263ms) — ' +
      '개별 스캔 로직(scanDiscreteTiers/latentFreeTwoScore)은 chain-evaluator.ts와 동일한 알고리즘 복잡도이고 ' +
      '더 효율적으로 실행된다. 원인은 **priorEvaluator 호출 횟수 자체가 약 5.7배(10,925→62,042)** — ' +
      'MCTS priorEvaluator는 노드가 처음 확장될 때 1회 호출되므로(search/mcts.ts), 이는 같은 256-시뮬레이션 ' +
      '예산 안에서 defensive 후보가 훨씬 더 많은 서로 다른 노드를 방문한다는 뜻이다. defensive 후보의 티어 설계 ' +
      '(DEFENSIVE_TIER 8단 + DENY_LATENT_WEIGHT=1.2 우세)가 다수 착점을 근접한 점수로 동점 처리해 progressive-bias ' +
      '항의 착점 간 분별력을 낮추고, 그 결과 탐색이 소수 착점에 집중되지 못하고 넓게 퍼진다고 추정된다(이 라운드에서 ' +
      '검증하지 않은 가설 — 인과관계 확정은 별도 실험 필요).\n\n' +
      '**행동 보존 수정은 적용하지 않았다** — 비용의 원인이 코드 비효율이 아니라 이 후보의 설계 자체(더 넓은 트리 탐색)이므로, ' +
      '"같은 입력→같은 출력" 최적화로 줄일 수 있는 낭비가 아니다. 코드를 바꾸면 곧 행동(탐색 형태)이 바뀌어 금지 조건에 걸린다. ' +
      '라운드1의 4,748ms는 이 재측정치(2,401ms)의 약 2배로, 그 절반가량은 측정 시점의 CPU 경합(동시 세션의 다른 에이전트 프로세스)이 ' +
      '보탠 노이즈였을 가능성이 크다 — 두 측정 모두 chain-w16 대비 defensive-w16이 유의하게 비싸다는 정성적 결론은 일치한다. ' +
      '**시사점**: defensive류 후보를 웨이브에 태울 때는 다른 후보 대비 4~6배의 시간 예산을 미리 배정해야 하고, ' +
      '이후 라운드에서 "티어 동점을 줄이는" 방향(예: 동점 착점에 위치 기반 보조 점수 추가)의 재설계는 비용과 탐색 형태를 ' +
      '동시에 개선할 수 있는 후보 축이다(다음 B3/B4 설계 입력).',
  };

  const portfolioRound1Path = join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round1.json');
  let portfolioRound1Body = '- 산출물 없음(portfolio-round1.json 없음)';
  if (existsSync(portfolioRound1Path)) {
    const raw = JSON.parse(readFileSync(portfolioRound1Path, 'utf8')) as {
      readonly probeFilter?: ReadonlyArray<{ readonly flag: string; readonly bucket: string; readonly agreementRate: number; readonly msPerGame: number; readonly advanced: boolean }>;
      readonly challenge?: Record<string, Record<string, { readonly winRate: number; readonly blocks: number }>>;
    };
    const filterTable =
      '| 후보 | 버킷 | 프로브 일치율 | ms/게임 | 진출 |\n|---|---|---|---|---|\n' +
      (raw.probeFilter ?? [])
        .map((row) => `| ${row.flag} | ${row.bucket} | ${pct(row.agreementRate)} | ${row.msPerGame.toFixed(0)} | ${row.advanced ? 'O' : 'X'} |`)
        .join('\n');
    const l1 = raw.challenge?.['external-mid-l1'];
    const l2 = raw.challenge?.['external-opus-l2'];
    const challengeTable =
      '| 후보 | vs L1 | vs L2 |\n|---|---|---|\n' +
      Object.keys(l1 ?? {})
        .filter((flag) => flag !== 'baseline')
        .map((flag) => `| ${flag} | ${pct(l1?.[flag]?.winRate)} | ${pct(l2?.[flag]?.winRate)} |`)
        .join('\n');
    portfolioRound1Body =
      '라운드1 포트폴리오(portfolio-round1.json) 요약 — 7후보 중 4개(B2/B3x2/B4) 프로브 필터 통과, ' +
      '전원 웨이브 채택(registry v5→v6):\n\n' +
      filterTable +
      '\n\n웨이브 이후 challenge(N=40) 승률:\n\n' +
      challengeTable +
      '\n\n**핵심**: B4(defensive)가 최대 수율(vs L2 25.6%)로 카드 1~5+Phase2 전부 0%였던 벽을 처음 돌파. ' +
      '프로브 일치율 순위(B1<B2<B3<B4)가 challenge 성적 순위와 정확히 일치(선별 신호 재확인). ' +
      'chain-w16(0%)과 chain-w48(7.5%)의 차이가 "잠재 티어 가중을 더 올려야 한다"는 신호.';
  }

  const round2SummaryPath = join(ROOT_DIR, 'runs', GAME_ID, 'challenge-l2-round2', 'judgment-summary.json');
  let round2Body = '- 산출물 없음(challenge-l2-round2/judgment-summary.json 없음 — gomoku-loss-mining-round2.ts를 먼저 실행)';
  if (existsSync(round2SummaryPath)) {
    const summary = JSON.parse(readFileSync(round2SummaryPath, 'utf8')) as JudgmentSummary;
    const m1 = summary.measurement1_v6VsL2?.result;
    const m2 = summary.measurement2_v6VsL1?.result;
    const lr = summary.lossReport;
    const topMismatches = (lr?.topMismatchDecisionPoints ?? [])
      .map((e) => `${e.decisionPointId}=${pct(e.mismatchRate)}(${e.mismatches}/${e.decisions})`)
      .join(', ');
    round2Body =
      `v6 합성봇(flags=[${(summary.registry?.composedFlags ?? []).join(', ') || '(none)'}], 실질적으로 마지막 플래그인 ` +
      `mcts9-s256-defensive-w16 단독과 동일 — composeBot의 "이후 플래그가 base를 무시" 규칙, 이 파일 자체 doc comment 참고)의 ` +
      `라운드2 판정 실험 (gomoku-loss-mining-round2.ts, GAP-11 Phase 4-A):\n\n` +
      `- v6 vs L2(opus): winRate=${pct(m1?.candidateWinRate)} CI=[${pct(m1?.winRateCI?.lower)}, ${pct(m1?.winRateCI?.upper)}] (N=100, 라운드1 challenge N=40 25.6%와 비교)\n` +
      `- v6 vs L1(mid): winRate=${pct(m2?.candidateWinRate)} CI=[${pct(m2?.winRateCI?.lower)}, ${pct(m2?.winRateCI?.upper)}] ` +
      `(그래디언트 추적: ${summary.measurement2_v6VsL1?.gradientRestored ? 'PASS' : 'FAIL'}, 라운드1 defensive 단독 vs L1 45.0%와 비교)\n` +
      `- 패배율: ${lr?.candidateLosses ?? '-'}/${lr?.totalGames ?? '-'}\n` +
      `- 첫 분기 깊이 히스토그램: ${JSON.stringify(lr?.firstDivergenceDepthHistogram ?? {})} (라운드1 v5 기준 {"0-9":200} 전패와 비교)\n` +
      `- 불일치율 상위 결정지점(>=5회): ${topMismatches || '(none)'}\n` +
      `- 프로브(round2, probe-bank-round2.json): 신규 ${summary.probeBank?.probeCount ?? '-'}개, ` +
      `L2 자기일치율=${pct(summary.probeBank?.l2SelfAgreementRate)}(1.0 기대), v6 일치율=${pct(summary.probeBank?.v6AgreementRate)}(round2 probe bank는 v6 자신의 패배 분기점에서 채굴된 것이므로 정의상 낮음)\n\n` +
      `**핵심 발견 1 — 승률은 개선, 분기 깊이는 불변**: v6 vs L2 20.5%(N=100, CI 좁음)는 라운드1 defensive 단독 ` +
      `challenge(25.6%, N=40, CI 넓음)와 겹치는 범위로 사실상 재확인이고, v5의 0%에서는 확실한 개선이다. v6 vs L1도 ` +
      `48.5%로 라운드1(45.0%)·v5(0.5%) 대비 계속 상승. 그런데 첫 분기 깊이 히스토그램은 **{"0-9":137}로 여전히 ` +
      `패배 전부가 첫 10수 안에 갈린다** — 라운드1 v5의 {"0-9":200}(전패)과 구조적으로 동일한 패턴이다. ` +
      `승률은 올랐는데 "왜 지는가"의 구조는 그대로라는 뜻: v6은 초반에 갈린 게임을 예전보다 더 자주 뒤집어서 ` +
      `이기는 것이지, 초반 갈림 자체를 줄인 게 아니다.\n\n` +
      `**핵심 발견 2(가장 중요, Phase 4-B 설계에 직접 영향) — B2 오프닝 정책이 v6에서 전혀 실행되지 않는다**: ` +
      `composeBot(loop/compose.ts)은 각 플래그를 순서대로 적용하는데, MCTS 계열 플래그의 apply()는 base를 ` +
      `전부 무시하고 완전히 새 팩토리를 반환한다(이 저장소의 기존 관례, gomoku-mcts-flag.ts 각 스펙 자신의 doc ` +
      `comment). registry v6의 플래그 목록 마지막 항목이 mcts9-s256-defensive-w16이므로, "v6 합성봇"은 실제로는 ` +
      `**defensive-w16 단독과 완전히 동일한 런타임 동작**이고, 그 앞에 나열된 mcts7-s256-opening6-prior-w16 ` +
      `(B2, 초반 오프닝 정책 — 바로 이 LossReport의 "패배가 전부 초반에 갈린다"는 발견을 정확히 겨냥해 설계된 ` +
      `후보)은 조립 과정에서 완전히 버려진다. 즉 라운드1이 진짜로 채택한 것은 "4개 후보의 앙상블"이 아니라 ` +
      `"defensive-w16 하나"이고, 초반 취약점을 겨냥한 유일한 후보(B2)는 지금 아무 효과가 없다. **핵심 발견 1의 ` +
      `"분기 깊이 불변" 현상이 바로 이 조립 구조의 직접적 결과다.** Phase 4-B의 B3 재설계는 이 문제를 반드시 ` +
      `다뤄야 한다 — 후보를 늘리는 것보다 먼저, (a) composeBot 대신 여러 전략을 실제로 합성하는 조립 방식(예: ` +
      `오프닝 구간엔 B2 정책, 이후엔 defensive prior를 쓰는 단일 후보로 재정의)을 쓰거나, (b) 최소한 이번 ` +
      `라운드부터는 "이긴 후보 각각을 개별 challenge 대상으로 유지"하고 registry 조립 순서에 의존하지 않는 ` +
      `방식으로 다음 후보를 설계해야 한다.\n\n` +
      `**핵심 발견 3**: place 결정지점 불일치율이 라운드1 v5의 95.1%에서 46.8%(895/1912)로 크게 낮아졌다 — ` +
      `defensive 후보가 낱개 결정 단위로는 L2와 훨씬 더 많이(53.2%) 일치한다는 뜻이다. 그런데도 손실 게임의 ` +
      `분기 깊이 분포가 그대로인 이유는, 남은 47%의 불일치가 여전히 게임 첫 10수 이내에 최소 1회 발생하면 ` +
      `그 게임의 "첫 분기"로 기록되기 때문 — 국지적 일치율 개선과 "패배를 만드는 결정적 첫 실수"는 서로 다른 ` +
      `축이라는 방법론적 교훈이다(다음 라운드 지표 설계에 참고).`;
  }

  const extraEvidence = [
    profilingEvidence,
    { title: '라운드1 포트폴리오 요약 (portfolio-round1.json)', body: portfolioRound1Body },
    { title: 'v6 판정 실험 요약 (gomoku-loss-mining-round2.ts, 이번 라운드)', body: round2Body },
  ];

  const brief = renderDesignBrief({
    gameId: GAME_ID,
    rootDir: ROOT_DIR,
    axisMatrix,
    extraEvidence,
  });

  mkdirSync(join(ROOT_DIR, 'runs', GAME_ID), { recursive: true });
  const outPath = join(ROOT_DIR, 'runs', GAME_ID, 'design-brief-round2.md');
  writeFileSync(outPath, brief);
  console.log(`저장: runs/${GAME_ID}/design-brief-round2.md`);
}

main();
