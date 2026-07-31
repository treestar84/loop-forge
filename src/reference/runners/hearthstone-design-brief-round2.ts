/**
 * hearthstone-design-brief-round2 — GAP-11 프로토콜 v2 2회전 후반부(브리프),
 * `hearthstone-design-brief-round1.ts` 및 도미니언 round2/round3 브리프
 * 러너와 동일한 패턴: `hearthstone-loss-mining-round2.ts`가 만든
 * `challenge-l2-round2/judgment-summary.json`을 `artifacts/design-brief.ts`로
 * 조립한다.
 *
 * 1회전과 달라진 점은 축 매트릭스다 — A5(트리 prior)가 이 게임에서
 * "시도-adopted"(v3 승격)로, A2(롤아웃 정책 교체)가 "시도-실패"(1회전 B4
 * l1rollout이 프로브 필터에서 탈락)로 확정됐고, A6(상대 정보 기반 설계)는
 * 1회전 B2(playfocus) near-miss로 "시도-실패"가 됐다.
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
  readonly measurement1_v3VsL2?: {
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
  readonly probeBank?: {
    readonly probeCount?: number;
    readonly l2SelfAgreementRate?: number;
    readonly championAgreementRate?: number;
    readonly mismatchByChoiceKind?: ReadonlyArray<{
      readonly kind: string;
      readonly probes: number;
      readonly scored: number;
      readonly mismatches: number;
      readonly mismatchRate: number;
    }>;
  };
  readonly measurement2_v3VsL1?: {
    readonly result?: { readonly candidateWinRate?: number };
    readonly gradientRestored?: boolean;
  };
}

function main(): void {
  console.log(`=== hearthstone design brief round 2 (GAP-11 프로토콜 v2) — rootDir=${ROOT_DIR} ===`);

  const axisMatrix: AxisMatrixRow[] = [
    { axis: 'A1 탐색 예산', status: '미시도', note: '하스스톤은 s128 고정 — 2회전 B4가 s192로 이 축의 첫 시도' },
    {
      axis: 'A2 롤아웃 정책 교체',
      status: '시도-실패',
      note: '1회전 B4 ismcts-s128-l1rollout(L1을 rolloutFactory로) — 프로브 일치율 35.5%로 최하위, 상위 4 컷에서 탈락. 오목·도미니언의 챔피언 롤아웃 실패에 이어 "중수 롤아웃도 약화" 사례 추가',
    },
    { axis: 'A3 전술 프리체크', status: '미시도' },
    { axis: 'A4 루트 오버라이드', status: '미시도' },
    {
      axis: 'A5 트리 prior',
      status: '시도-adopted',
      note: '1회전 B3/B1(choiceEvaluator를 IS-MCTS prior로, priorWeight 4/16/48) 전부 adopted, challenge 최고 w4가 v3로 승격(vs L2 46.3%). 이 게임에서 실증된 최강 축',
    },
    {
      axis: 'A6 상대 정보 기반 설계',
      status: '시도-실패',
      note: '1회전 B2 ismcts-s128-playfocus-w16(probe-bank의 play 축 겨냥) near-miss — 밴드 구조를 평평하게 만든 평가함수가 원인으로 추정. 2회전 B2는 같은 play 축을 다른 기전(배틀크라이 제거 밴드 승격)으로 재시도',
    },
    { axis: 'A7 오프닝 북 / 정석 테이블', status: '미시도' },
    {
      axis: 'A8 도메인 전략 재설계',
      status: '미시도',
      note: '2회전 B3(두 평가함수 합성 prior)가 이 축의 첫 본격 시도 — 파라미터 스윕이 아닌 지식 결합',
    },
    { axis: 'A9 학습/탐색(IS-MCTS)', status: '시도-adopted', note: 'ismcts-wave-1에서 ismcts-s128-hr 채택(v1→v2), 이후 A5와 결합해 v3' },
    { axis: 'A10 모방/이식', status: '미시도', note: '오목(opusclone)·도미니언(opusCloneDominion) 선례 있음 — 하스스톤은 여전히 미시도' },
  ];

  const round1Evidence: DesignBriefEvidence = {
    title: '1회전 결과 요약 (portfolio-round1.json, 이번 라운드의 출발점)',
    body:
      'v2(`ismcts-s128-hr`) 기준선에서 B3/B1(choiceEvaluator 트리 prior, priorWeight 스윕) 3종이 전부 adopted, ' +
      '`assembleFlags`(ADR-0014)가 challenge 최고 성적인 **`ismcts-s128-tempo-w4`(vs L2 46.3%)** 하나만 남기고 ' +
      '나머지 3종(구 챔피언 `ismcts-s128-hr` 포함)을 `excluded`로 기록해 **v3** 승격. ' +
      'B2(`playfocus-w16`)는 near-miss(vs L2 33.8%), B4(`l1rollout`)는 프로브 필터 탈락. ' +
      'priorWeight 곡선(같은 웨이브 문맥, N=40 challenge vs L2): **w0(=hr) 40.0% / w4 46.3% / w16 42.5% / w48 36.3%** — ' +
      '단조가 아니라 **w4 부근의 내부 최적점**이라, 2회전 B1은 설계 브리프가 예시한 w2/w24 대신 ' +
      '**w2/w8로 최적점을 양쪽에서 좁히는 배치**를 택한다(사유 기록: 곡률상 w24는 이미 하강 구간이라 정보량이 낮다).',
  };

  const summaryPath = join(ROOT_DIR, 'runs', GAME_ID, 'challenge-l2-round2', 'judgment-summary.json');
  let miningBody = '- 산출물 없음(challenge-l2-round2/judgment-summary.json 없음 — hearthstone-loss-mining-round2.ts를 먼저 실행)';
  if (existsSync(summaryPath)) {
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as JudgmentSummary;
    const m1 = summary.measurement1_v3VsL2?.result;
    const m2 = summary.measurement2_v3VsL1?.result;
    const lr = summary.lossReport;
    const kinds = summary.probeBank?.mismatchByChoiceKind ?? [];
    const kindTable = kinds
      .map((k) => `| ${k.kind} | ${k.probes} | ${k.mismatches} | ${pct(k.mismatchRate)} |`)
      .join('\n');
    const dpTable = (lr?.topMismatchDecisionPoints ?? [])
      .map((e) => `| ${e.decisionPointId} | ${e.decisions} | ${e.mismatches} | ${pct(e.mismatchRate)} |`)
      .join('\n');

    miningBody =
      `v3 챔피언(flags=[${(summary.registry?.composedFlags ?? []).join(', ') || '(none)'}]) vs L2(opus) N=100, ` +
      `신규 시드(506,000+/507,000+ — 1회전 채굴 500,000+/501,000+ 및 portfolio-round1 520,000-527,099과 비겹침) ` +
      `재채굴 결과 (hearthstone-loss-mining-round2.ts):\n\n` +
      `- v3 vs L2: winRate=${pct(m1?.candidateWinRate)} CI=[${pct(m1?.winRateCI?.lower)}, ${pct(m1?.winRateCI?.upper)}], ` +
      `무승부/split=${pct(m1?.drawRate)}\n` +
      `- v3 vs L1(mid): winRate=${pct(m2?.candidateWinRate)} — 그래디언트 ${summary.measurement2_v3VsL1?.gradientRestored ? 'PASS' : 'FAIL'}\n` +
      `- 패배: ${lr?.candidateLosses ?? '-'}/${lr?.totalGames ?? '-'}, 분기점 ${lr?.divergenceCount ?? '-'}개\n` +
      `- 첫 분기 깊이 히스토그램: ${JSON.stringify(lr?.firstDivergenceDepthHistogram ?? {})}\n` +
      `- 프로브: 신규 ${summary.probeBank?.probeCount ?? '-'}개(probe-bank-round2.json, 1회전 은행 보존), ` +
      `L2 자기일치율=${pct(summary.probeBank?.l2SelfAgreementRate)}, v3 일치율=${pct(summary.probeBank?.championAgreementRate)}\n\n` +
      `**결정지점별 불일치율**(이 게임은 어댑터가 결정지점을 단일 \`'action'\`으로만 인코딩 — 1회전 핵심 발견 1):\n\n` +
      `| decisionPointId | decisions | mismatches | mismatchRate |\n|---|---|---|---|\n${dpTable}\n\n` +
      `**choice 종류별 v3 불일치율**(encodeChoice 접두사 사후 분류 — 1회전은 일회성 스크립트였지만 이번엔 ` +
      `러너 안에 상설 집계로 넣었다):\n\n` +
      `| kind | probes | mismatches | mismatchRate |\n|---|---|---|---|\n${kindTable}\n\n` +
      '**핵심 발견 1 — 결정 수준 불일치율이 47.0%(1회전 v2) → 27.0%(2회전 v3)로 거의 절반**. ' +
      'A5(트리 prior) 채택이 승률뿐 아니라 "L2와 같은 수를 두는 비율"까지 실제로 끌어올렸다는 뜻 — ' +
      '승률 개선이 우연한 시드 효과가 아니라 정책 자체의 접근을 반영한다는 독립 증거다.\n\n' +
      '**핵심 발견 2 — 그럼에도 남은 불일치의 75%(135건 중 101건)는 여전히 `play` 축**이다. ' +
      '1회전 B2(playfocus)가 near-miss로 실패한 뒤에도 이 축이 최다로 남았다는 것은 "play 축은 실제로 약하지만 ' +
      '1회전의 처치 방식(밴드 구조를 평평하게 만드는 별도 평가함수)이 틀렸다"는 해석을 지지한다.\n\n' +
      '**핵심 발견 3(2회전 B2 후보를 직접 만든 관찰) — `hearthstoneChoiceEvaluator`의 밴드 비대칭.** ' +
      'L2가 분기점에서 고른 play 147개 중 30개가 `elven-archer`(1/1 몸집 + "1 피해" 배틀크라이)였다. ' +
      '현행 평가함수는 적 하수인을 죽이는 **주문**과 **영웅 능력**은 `removal`(350) 밴드로 올리면서, ' +
      '같은 일을 하는 **하수인 배틀크라이**는 `develop`(200) 밴드에 가산점만 얹는다 — 그 함수 자신의 doc comment가 ' +
      '3번 밴드를 "주문/배틀크라이/영웅 능력/등가 교환"이라고 적어 놓았는데도. 명시된 설계 의도와 구현의 어긋남이며, ' +
      '2회전 B2(`ismcts-s128-bcremoval-w4`)는 정확히 이 한 가지만 교정한다.\n\n' +
      '**핵심 발견 4 — L2 자기일치율이 1회전 99.0%에서 99.5%로 여전히 1.0 미만.** ' +
      '1회전이 기록한 "hearthstoneOpusBot이 완전 결정론이 아닐 가능성"이 다른 시드 블록에서도 재현됐다 — ' +
      '프로브 일치율 해석 시 0.5~1%p는 자기일치율 자체의 잔여 노이즈로 감안해야 한다(원인 규명은 여전히 이연).';
  }

  const extraEvidence: DesignBriefEvidence[] = [
    round1Evidence,
    { title: 'LossReport 재채굴 결과 (hearthstone-loss-mining-round2.ts, 2회전)', body: miningBody },
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
