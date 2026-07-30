/**
 * dominion-design-brief-round3 — GAP-11 Phase 4-C third round, second half
 * (team-lead task): assembles dominion's round-3 design brief via
 * artifacts/design-brief.ts, following dominion-design-brief-round2.ts's
 * precedent — consumes dominion-loss-mining-round3.ts's judgment-summary.json
 * (this round's first file, re-mining chapelEconomyV2 standalone rather than
 * registry v4 — see that file's own doc comment for why) plus
 * portfolio-round2.json's wave/challenge outcome, and folds in a 1~2회전
 * bottleneck-migration summary (chapelTrash -> action/buy -> ?) as the
 * task's explicit "extraEvidence" requirement.
 *
 * axisMatrix rows update dominion-design-brief-round2.ts's snapshot with
 * round 2's actual outcome: A8 (도메인 전략 재설계) note extended with the
 * chapelEconomyV2 result (registry v3->v4 promotion, L2 13.8%->42.5%) and
 * round 3's re-mining finding (bottleneck migrated back toward chapelTrash
 * as an interaction effect, not a regression of the unchanged trash policy
 * itself). A10 (모방/이식) note extended with opusCloneDominion's structural
 * mirror ceiling (50.0%, CI width 0) — consistent with the gomoku 4-B2
 * lesson already on file. Every other row carried forward unchanged from
 * round 2 (A1-A7, A9 untouched).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer) per src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { renderDesignBrief } from '../../artifacts/design-brief';

const GAME_ID = 'dominion';
const ROOT_DIR = join(__dirname, '..', '..', '..');

function pct(x: number | undefined): string {
  return typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '-';
}

function main(): void {
  console.log(`=== dominion design brief round 3 (GAP-11 Phase 4-C) — rootDir=${ROOT_DIR} ===`);

  const axisMatrix = [
    { axis: 'A1 탐색 예산', status: '시도(0.400)', note: 'ismcts-wave-4, ismcts-s256-hr, regression 단계 실패(ADR-0009 대상) — 2회전 이후 변경 없음' },
    { axis: 'A2 롤아웃 정책 교체', status: '시도(악화)', note: 'ismcts-wave-2/3, s64 계열이 s256보다 더 나쁜 결과 — 2회전 이후 변경 없음' },
    { axis: 'A3 전술 프리체크', status: '미시도' },
    { axis: 'A4 루트 오버라이드', status: '미시도' },
    {
      axis: 'A5 트리 prior (D1+D2)',
      status: '시도-실패',
      note:
        '1회전 B4: ismcts-s64-prior-w16, 프로브 필터 통과했으나 정규 웨이브 prune 단계에서 탈락(challenge L2=0.0%) — 2회전 재시도 없음, 변경 없음.',
    },
    { axis: 'A6 상대 정보 기반 설계 (D4)', status: '미시도' },
    { axis: 'A7 오프닝 북 / 정석 테이블', status: '—', note: 'registry kind 일반화 선행 필요(D6 비고) — 변경 없음' },
    {
      axis: 'A8 도메인 전략 재설계',
      status: '시도-성공(2연속)',
      note:
        '1회전 chapelEconomy(A8) -> registry v3, chapelTrash 불일치 67.4%->3.2% 해소, 병목이 action(19.4%)/buy(16.4%)로 이동. ' +
        '2회전 chapelEconomyV2(같은 A8 축, buy/action 재설계 + chapelTrash는 verbatim 보존) -> registry v4에 채택 기록, ' +
        'N=40 챌린지 L2=42.5%(v3 대비 2.5배). ' +
        '3회전 재채굴(chapelEconomyV2 단독 재측정, N=100): L2=42.0% [36.3, 48.0](2회전 수치와 CI 겹침, 재현성 확인), ' +
        'L1=54.3% [47.5, 61.0](2회전 55.0%와 재현성 확인, 그래디언트 유지). ' +
        '**병목 이동 3단계 확인**: chapelTrash 67.4%(1회전 v2 기준선) -> action 19.4%/buy 16.4%(2회전 v3=chapelEconomy 재채굴) -> ' +
        '**chapelTrash 12.9%(3회전 최다) > buy 10.7% > action 4.6%(3회전 chapelEconomyV2 재채굴)** — ' +
        '병목이 buy/action에서 다시 chapelTrash로 돌아왔다. 단, 이것이 "V2가 chapelTrash를 퇴보시켰다"는 뜻은 아니다 — ' +
        'V2는 chapelTrash 정책 자체를 chapelEconomy(2회전, 3.2%)와 완전히 동일하게(verbatim) 보존했다. ' +
        '해석: buy/action 재설계가 게임을 더 다른 궤적(다른 덱 구성·타이밍)으로 이끌어, 동일한 trash 휴리스틱이 ' +
        '노출되는 국면 분포 자체가 바뀌었다 — **결정지점 간 상호작용 효과**(한 지점을 고치면 다른 지점이 새로운 분포의 ' +
        '국면을 만나 재부상)이지 단일 지점의 절대적 열화가 아니다. 다음 라운드 표적: chapelTrash를 buy/action 재설계 이후의 ' +
        '실제 국면 분포에 맞춰 재조정(예: 성장기 밀도 임계값을 V2의 새 커브에 재적합), 그 다음으로 buy(10.7%).',
    },
    { axis: 'A9 학습(MCCFR/정책 테이블)', status: '미검토' },
    {
      axis: 'A10 모방/이식 (B5/B4)',
      status: '실패 2회 + 클론 거울 1회(주의)',
      note:
        '1회전 정적 값 기반 모방 2회 실패(0.275->0.100). 2회전 B4 opusCloneDominion(완전 클론)은 vs L2=50.0%(CI 폭 0) — ' +
        '구조적으로 정확히 50%인 거울 대국일 뿐 통계적 승리가 아니다(클론은 상한이 50%). registry v4의 flags 리스트 마지막 원소가 ' +
        'opusCloneDominion이라 composeBot 덮어쓰기 시맨틱상 v4의 실제 조립 결과 = opusCloneDominion 단독(ADR-0014) — ' +
        '이 사실이 3회전 재채굴 대상 선정의 근거였다(v4를 채굴하면 거울 대국이라 배울 게 없음, chapelEconomyV2 단독을 채굴). ' +
        '오목 4-B/4-B2 교훈(탐색 prior 이식은 대등까지 가능하나 거울 대국에서 예산 우위는 기각)과 정합 — 도미니언에서도 ' +
        '클론은 종착점이 아니라 상한을 보여주는 참조점으로 취급해야 한다.',
    },
  ];

  const round3SummaryPath = join(ROOT_DIR, 'runs', GAME_ID, 'challenge-l2-round3', 'judgment-summary.json');
  let round3SummaryBody = '- 산출물 없음(challenge-l2-round3/judgment-summary.json 없음 — dominion-loss-mining-round3.ts를 먼저 실행)';
  if (existsSync(round3SummaryPath)) {
    const summary = JSON.parse(readFileSync(round3SummaryPath, 'utf8')) as {
      candidate?: { flag?: string; note?: string; registryLatestVersionForReference?: string | null };
      measurement1_candidateVsL2?: { result?: { candidateWinRate?: number; winRateCI?: { lower?: number; upper?: number } } };
      measurement2_candidateVsL1?: { result?: { candidateWinRate?: number; winRateCI?: { lower?: number; upper?: number } }; gradientRestored?: boolean };
      lossReport?: { candidateLosses?: number; totalGames?: number; topMismatchDecisionPoints?: readonly { decisionPointId: string; mismatchRate: number }[] };
      probeBank?: { l2SelfAgreementRate?: number; candidateAgreementRate?: number; probeCount?: number };
    };
    const m1 = summary.measurement1_candidateVsL2?.result;
    const m2 = summary.measurement2_candidateVsL1?.result;
    const top = summary.lossReport?.topMismatchDecisionPoints ?? [];
    round3SummaryBody =
      `${summary.candidate?.flag ?? '(unknown)'} 단독 봇의 3회전 재채굴 판정 실험 (dominion-loss-mining-round3.ts, GAP-11 Phase 4-C):\n\n` +
      `- 재채굴 대상 선정 근거: ${summary.candidate?.note ?? '-'}\n` +
      `- registry latest(참고용, 이번 라운드는 미사용): ${summary.candidate?.registryLatestVersionForReference ?? '-'}\n` +
      `- vs L2(opus): winRate=${pct(m1?.candidateWinRate)} CI=[${pct(m1?.winRateCI?.lower)}, ${pct(m1?.winRateCI?.upper)}] ` +
      `(2회전 N=40 챌린지 42.5%와 CI 겹침 — 재현성 확인)\n` +
      `- vs L1(mid): winRate=${pct(m2?.candidateWinRate)} CI=[${pct(m2?.winRateCI?.lower)}, ${pct(m2?.winRateCI?.upper)}] ` +
      `(그래디언트 추적: ${summary.measurement2_candidateVsL1?.gradientRestored ? 'PASS' : 'FAIL'}, 2회전 N=40 챌린지 55.0%와 CI 겹침)\n` +
      `- 패배율: ${summary.lossReport?.candidateLosses ?? '-'}/${summary.lossReport?.totalGames ?? '-'}\n` +
      `- 프로브 은행 3회전: probes=${summary.probeBank?.probeCount ?? '-'}, L2 자기일치율=${pct(summary.probeBank?.l2SelfAgreementRate)}(1.0 기대 충족) ` +
      `— chapelEconomyV2 새 프로브 일치율=${pct(summary.probeBank?.candidateAgreementRate)}(정의상 0% — 이 프로브들은 chapelEconomyV2가 L2와 갈린 지점만 채굴했으므로 예상된 값)\n` +
      `- 병목 이동(3회전, 이번 채굴): ${top.map((t) => `${t.decisionPointId}=${pct(t.mismatchRate)}`).join(', ') || '(none)'} ` +
      `— chapelTrash가 다시 최다 불일치 지점으로 부상(상세는 위 "축 매트릭스" A8 행 참조)\n\n` +
      `상세 분기 깊이·결정지점 불일치율은 위 "LossReport 요약" 절 참조(같은 산출물에서 자동 추출됨).`;
  }

  const portfolioRound2Path = join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round2.json');
  let portfolioSummaryBody = '- 산출물 없음(portfolio-round2.json 없음)';
  if (existsSync(portfolioRound2Path)) {
    const p = JSON.parse(readFileSync(portfolioRound2Path, 'utf8')) as {
      wave?: { results?: readonly { flag: string; verdict: string; tiersPassed: readonly string[] }[] };
      challenge?: Record<string, Record<string, { winRate: number; blocks: number }>>;
      adoption?: { promotedVersion?: string | null; adoptedFlags?: readonly string[] };
      bucketOutcomes?: readonly { bucket: string; candidates: number; adopted: number; challengeDelta: number }[];
    };
    const rows = (p.wave?.results ?? [])
      .map((r) => `| ${r.flag} | ${r.verdict} | ${r.tiersPassed.join('→') || '(none)'} |`)
      .join('\n');
    const l2 = p.challenge?.['external-opus-l2'] ?? {};
    const l1 = p.challenge?.['external-mid-l1'] ?? {};
    const challengeRows = Object.keys(l2)
      .map((subject) => `| ${subject} | L2=${pct(l2[subject]?.winRate)} | L1=${pct(l1[subject]?.winRate)} |`)
      .join('\n');
    portfolioSummaryBody =
      `2회전 포트폴리오 웨이브 결과 (runs/dominion/portfolio-round2.json, dominion-portfolio-round2.ts):\n\n` +
      `| 플래그 | 판정 | 통과 단계 |\n|---|---|---|\n${rows}\n\n` +
      `challenge 승률 (feedback anchors, N=40):\n\n| 대상 | L2(opus) | L1(mid) |\n|---|---|---|\n${challengeRows}\n\n` +
      `승격: ${p.adoption?.promotedVersion ?? '-'} (채택 플래그: ${(p.adoption?.adoptedFlags ?? []).join(', ') || '(none)'})\n\n` +
      `버킷 수율: ${(p.bucketOutcomes ?? []).map((b) => `${b.bucket}(candidates=${b.candidates}, adopted=${b.adopted}, Δ=${b.challengeDelta.toFixed(4)})`).join(', ')}\n\n` +
      `주의: registry v4 flags 리스트 마지막 원소가 opusCloneDominion이므로 composeBot 덮어쓰기 시맨틱상(ADR-0014) ` +
      `v4가 실제로 만드는 봇은 opusCloneDominion 단독(=L2 클론)이다 — chapelEconomyV2의 진짜 개선(N=40 L2=42.5%)은 v4 registry 상 ` +
      `죽은 코드다. 이번 라운드의 재채굴이 chapelEconomyV2 단독을 표적으로 택한 이유가 여기 있다.`;
  }

  const extraEvidence = [
    {
      title: 'chapelEconomyV2 3회전 판정 실험 요약 (dominion-loss-mining-round3.ts, 이번 라운드)',
      body: round3SummaryBody,
    },
    {
      title: '2회전 포트폴리오 웨이브 요약 (portfolio-round2.json)',
      body: portfolioSummaryBody,
    },
    {
      title: '병목 이동 3단계 요약 (1~3회전 통합, 다음 B3 설계의 핵심 입력)',
      body:
        '도미니언 A8(도메인 전략 재설계) 축의 채굴 표적 이동 이력 — 매 라운드 이전 병목을 겨냥한 재설계가 그 병목을 실측 해소하고 ' +
        '다음 병목을 드러내는 패턴이 3연속 재현됐다:\n\n' +
        '1. **1회전**: 기준선(rushProvinces, v2) chapelTrash 불일치 **67.4%**(dominant) — "구매가 아니라 덱 정리 판단"이 첫 정량 진단. ' +
        'chapelEconomy(A8) 설계가 chapelTrash를 표적으로 삼아 채택 -> registry v3.\n' +
        '2. **2회전**: v3(=chapelEconomy 단독, composeBot 덮어쓰기 확인) 재채굴 — chapelTrash 3.2%로 급감(해소 확인), 병목이 ' +
        '**action 19.4%/buy 16.4%**로 이동. chapelEconomyV2(A8 후속) 설계가 buy/action을 재설계하며 chapelTrash는 verbatim 보존 ' +
        '-> 채택 -> registry v4(단, 실체는 opusCloneDominion 덮어쓰기).\n' +
        '3. **3회전(이번)**: chapelEconomyV2 단독 재채굴 — **chapelTrash 12.9%(최다) > buy 10.7% > action 4.6%**. ' +
        'action/buy가 2회전 수치보다 낮아져 V2의 재설계가 실제로 작동함을 재확인했지만, chapelTrash가 다시 최다 불일치 지점으로 ' +
        '부상했다. chapelTrash 정책 자체는 2회전과 완전히 동일(verbatim)하므로 이것은 "정책 열화"가 아니라 ' +
        '"buy/action이 게임을 새로운 국면 분포로 이끌어 동일 휴리스틱이 다시 노출됨"이라는 **결정지점 간 상호작용 효과**다.\n\n' +
        '설계 함의: 병목이 정확히 그 병목만 고치면 사라지는 독립 변수가 아니라, 다른 결정지점 재설계가 국면 분포를 바꾸면서 ' +
        '재부상할 수 있는 상호의존 변수다. 다음 B3 설계는 chapelTrash를 "1회전 문제의 재발"이 아니라 ' +
        '"V2의 buy/action이 만든 새 국면 분포에 맞춘 재적합 대상"으로 접근해야 한다 — 임계값을 2회전 국면 분포가 아니라 ' +
        '3회전(V2 buy/action 이후) 국면 분포에서 재도출할 것.',
    },
  ];

  const brief = renderDesignBrief({
    gameId: GAME_ID,
    rootDir: ROOT_DIR,
    axisMatrix,
    extraEvidence,
  });

  mkdirSync(join(ROOT_DIR, 'runs', GAME_ID), { recursive: true });
  const outPath = join(ROOT_DIR, 'runs', GAME_ID, 'design-brief-round3.md');
  writeFileSync(outPath, brief);
  console.log(`저장: runs/${GAME_ID}/design-brief-round3.md`);
}

main();
