/**
 * dominion-design-brief-round4 — GAP-11 Phase 6 fourth round, second half
 * (main-loop design spec §2): assembles dominion's round-4 design brief via
 * artifacts/design-brief.ts, following dominion-design-brief-round3.ts's
 * precedent — consumes dominion-loss-mining-round4.ts's judgment-summary.json
 * (this round's re-mining of registry v5, the current champion) plus
 * portfolio-round3.json's wave/challenge outcome, and folds in the 1~4회전
 * bottleneck-migration summary as extraEvidence.
 *
 * axisMatrix rows update round 3's snapshot with round 3's actual outcome:
 *   - A5 (트리 prior): 시도-실패 -> 시도-성공, since round 3's B4
 *     (`ismcts-s64-v2buy-prior`, chapelEconomyV2's buy knowledge injected as
 *     MctsConfig.priorEvaluator) passed regression and became registry v5.
 *   - A8 (도메인 전략 재설계): round 3's chapelEconomyV3 family verdict
 *     (regression 근접실패 — the adaptive-trash-floor hypothesis rejected as a
 *     standalone policy) recorded, plus round 4's re-framing of it as a
 *     partial-replacement prior (B3).
 *   - A3 (전술 프리체크): still 미시도 as of round 3 — this is exactly why
 *     round 4's B4 picks it (ADR-0009: no repeating an already-judged axis).
 * Every other row carried forward unchanged.
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
  console.log(`=== dominion design brief round 4 (GAP-11 Phase 6) — rootDir=${ROOT_DIR} ===`);

  const axisMatrix = [
    { axis: 'A1 탐색 예산', status: '시도(0.400)', note: 'ismcts-wave-4, ismcts-s256-hr, regression 단계 실패(ADR-0009 대상) — 변경 없음' },
    { axis: 'A2 롤아웃 정책 교체', status: '시도(악화)', note: 'ismcts-wave-2/3, s64 계열이 s256보다 더 나쁜 결과 — 변경 없음' },
    {
      axis: 'A3 전술 프리체크',
      status: '미시도 -> 4회전 B4로 첫 시도',
      note:
        '3회전까지 도미니언에서 한 번도 시도되지 않은 축. 4회전 B4(ismcts-s64-v2buy-prior-precheck)가 ' +
        'v5 위에 결정론적 프리체크(coins>=8 Province 구매 / Curse 트래시 가능 시 즉시 / Curse 남아있을 때 Witch 플레이)를 ' +
        '얹어 첫 시도 — ADR-0009("같은 축 반복 금지") 준수를 위한 선택이기도 하다.',
    },
    { axis: 'A4 루트 오버라이드', status: '미시도', note: '4회전에서도 미시도로 남음(B4는 A3을 택함) — 다음 회전 후보 축.' },
    {
      axis: 'A5 트리 prior (D1+D2)',
      status: '시도-성공(3회전)',
      note:
        '1회전 B4: ismcts-s64-prior-w16(generic choiceEvaluator) 정규 웨이브 prune 탈락(challenge L2=0.0%). ' +
        '3회전 B4: ismcts-s64-v2buy-prior — prior source를 generic이 아니라 chapelEconomyV2 자신의 buy 지식으로 ' +
        '교체(MctsConfig.priorEvaluator)하자 regression 통과 -> **registry v5 승격**. ' +
        '"상대/자기 지식을 롤아웃이 아니라 prior로 주입"이라는 처치가 오목·하스스톤에 이어 도미니언에서도 성립. ' +
        '단 priorWeight는 16으로 고정한 채 넘어갔다(곡선 미확보) — 4회전 B1 2개(w8/w32)가 그 국소 곡선을 채운다.',
    },
    { axis: 'A6 상대 정보 기반 설계 (D4)', status: '미시도' },
    { axis: 'A7 오프닝 북 / 정석 테이블', status: '—', note: 'registry kind 일반화 선행 필요(D6 비고) — 변경 없음' },
    {
      axis: 'A8 도메인 전략 재설계',
      status: '2연속 성공 후 3회전 기각',
      note:
        '1회전 chapelEconomy -> v3(chapelTrash 67.4%->3.2%), 2회전 chapelEconomyV2 -> v4 기록(L2 42.5%), ' +
        '3회전 재채굴에서 chapelTrash 12.9%로 재부상(정책 열화가 아니라 V2 buy/action이 만든 새 국면 분포와의 상호작용 효과). ' +
        '3회전 B3/B1(chapelEconomyV3 계열 = 적응형 trash 임계) + B2(witchFirst)는 **전부 regression 근접실패** — ' +
        '적응형 임계 가설은 "독립 정책"으로는 기각됐다. ' +
        '4회전은 같은 가설을 다른 형태로 재시도한다: 독립 정책이 아니라 **v5의 prior 중 trash 축만 부분 교체**' +
        '(ismcts-s64-v2buy-adaptivetrash-prior) — 3회전 문서가 스스로 "미탐색"으로 남긴 조합이다.',
    },
    { axis: 'A9 학습(MCCFR/정책 테이블)', status: '미검토' },
    {
      axis: 'A10 모방/이식 (B5/B4)',
      status: '실패 2회 + 클론 거울 1회(주의) + 계보에서 배제',
      note:
        '2회전 B4 opusCloneDominion(완전 클론)은 vs L2=50.0%(CI 폭 0) — 구조적 거울일 뿐 통계적 승리가 아니다. ' +
        '3회전 승격에서 composeBotChecked/assembleFlags를 처음 실전 적용하며 클론을 계보 후보 풀에서 명시 배제했고, ' +
        'assembleFlags가 chapelEconomyV2를 excluded로 정직 기록하며 ismcts-s64-v2buy-prior로 계보를 이었다(v5). ' +
        '4회전도 같은 배제 규칙을 유지한다.',
    },
  ];

  const round4SummaryPath = join(ROOT_DIR, 'runs', GAME_ID, 'challenge-l2-round4', 'judgment-summary.json');
  let round4SummaryBody = '- 산출물 없음(challenge-l2-round4/judgment-summary.json 없음 — dominion-loss-mining-round4.ts를 먼저 실행)';
  if (existsSync(round4SummaryPath)) {
    const summary = JSON.parse(readFileSync(round4SummaryPath, 'utf8')) as {
      candidate?: { flag?: string; note?: string; registryLatestVersionForReference?: string | null };
      sampleSizing?: { n?: number; target?: number; msPerGameTrial?: number };
      measurement1_candidateVsL2?: { result?: { candidateWinRate?: number; winRateCI?: { lower?: number; upper?: number }; drawRate?: number } };
      measurement2_candidateVsL1?: { result?: { candidateWinRate?: number; winRateCI?: { lower?: number; upper?: number } }; gradientRestored?: boolean };
      lossReport?: { candidateLosses?: number; totalGames?: number; topMismatchDecisionPoints?: readonly { decisionPointId: string; mismatchRate: number; mismatches: number; decisions: number }[] };
      probeBank?: { l2SelfAgreementRate?: number; candidateAgreementRate?: number; probeCount?: number };
    };
    const m1 = summary.measurement1_candidateVsL2?.result;
    const m2 = summary.measurement2_candidateVsL1?.result;
    const top = summary.lossReport?.topMismatchDecisionPoints ?? [];
    round4SummaryBody =
      `${summary.candidate?.flag ?? '(unknown)'}(= registry v5, 현 챔피언) 재채굴 판정 실험 (dominion-loss-mining-round4.ts, GAP-11 Phase 6):\n\n` +
      `- 재채굴 대상 선정 근거: ${summary.candidate?.note ?? '-'}\n` +
      `- 표본 크기: N=${summary.sampleSizing?.n ?? '-'} (목표 ${summary.sampleSizing?.target ?? '-'}, 사전 실측 ms/game=${summary.sampleSizing?.msPerGameTrial?.toFixed(0) ?? '-'})\n` +
      `- vs L2(opus): winRate=${pct(m1?.candidateWinRate)} CI=[${pct(m1?.winRateCI?.lower)}, ${pct(m1?.winRateCI?.upper)}] ` +
      `(3회전 포트폴리오 N=40 challenge의 36.2%와는 문맥이 다르므로 직접 비교 금지 — INTERPRETATION 제1규칙)\n` +
      `- vs L1(mid): winRate=${pct(m2?.candidateWinRate)} CI=[${pct(m2?.winRateCI?.lower)}, ${pct(m2?.winRateCI?.upper)}] ` +
      `(그래디언트 추적: ${summary.measurement2_candidateVsL1?.gradientRestored ? 'PASS' : 'FAIL'})\n` +
      `- 패배율: ${summary.lossReport?.candidateLosses ?? '-'}/${summary.lossReport?.totalGames ?? '-'}\n` +
      `- 프로브 은행 4회전: probes=${summary.probeBank?.probeCount ?? '-'}, L2 자기일치율=${pct(summary.probeBank?.l2SelfAgreementRate)}(1.0 기대) ` +
      `— 챔피언의 새 프로브 일치율=${pct(summary.probeBank?.candidateAgreementRate)}(정의상 0% 근처: 이 프로브들은 챔피언이 L2와 갈린 지점만 채굴)\n` +
      `- 불일치율 상위 결정지점(이번 채굴): ${top.map((t) => `${t.decisionPointId}=${pct(t.mismatchRate)}(${t.mismatches}/${t.decisions})`).join(', ') || '(none)'} ` +
      `— **4회전 B2(상대정보) 표적은 이 목록의 최상위 항목에서 재선정한다**(3회전 표적을 그대로 쓰지 않는다).\n\n` +
      `상세 분기 깊이·결정지점 불일치율은 위 "LossReport 요약" 절 참조.`;
  }

  const portfolioRound3Path = join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round3.json');
  let portfolioSummaryBody = '- 산출물 없음(portfolio-round3.json 없음)';
  if (existsSync(portfolioRound3Path)) {
    const p = JSON.parse(readFileSync(portfolioRound3Path, 'utf8')) as {
      wave?: { results?: readonly { flag: string; verdict: string; tiersPassed: readonly string[] }[] };
      challenge?: Record<string, Record<string, { winRate: number; blocks: number }>>;
      adoption?: { promotedVersion?: string | null; adoptedFlags?: readonly string[]; assembleFlags?: { flags?: readonly string[]; excluded?: readonly unknown[] } | null };
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
      `3회전 포트폴리오 웨이브 결과 (runs/dominion/portfolio-round3.json, dominion-portfolio-round3.ts):\n\n` +
      `| 플래그 | 판정 | 통과 단계 |\n|---|---|---|\n${rows}\n\n` +
      `challenge 승률 (feedback anchors, N=40):\n\n| 대상 | L2(opus) | L1(mid) |\n|---|---|---|\n${challengeRows}\n\n` +
      `승격: ${p.adoption?.promotedVersion ?? '-'} (채택 플래그: ${(p.adoption?.adoptedFlags ?? []).join(', ') || '(none)'}, ` +
      `assembleFlags 최종 flags: ${(p.adoption?.assembleFlags?.flags ?? []).join(', ') || '-'})\n\n` +
      `버킷 수율: ${(p.bucketOutcomes ?? []).map((b) => `${b.bucket}(candidates=${b.candidates}, adopted=${b.adopted}, Δ=${b.challengeDelta.toFixed(4)})`).join(', ')}`;
  }

  const extraEvidence = [
    {
      title: 'registry v5 4회전 재채굴 요약 (dominion-loss-mining-round4.ts, 이번 라운드)',
      body: round4SummaryBody,
    },
    {
      title: '3회전 포트폴리오 웨이브 요약 (portfolio-round3.json)',
      body: portfolioSummaryBody,
    },
    {
      title: '4회전 후보 배치의 근거 (메인 루프 설계 브리프, scratchpad/dominion-round4-design-spec.md)',
      body:
        '이번 라운드는 3회전이 스스로 "미탐색"이라고 명시한 조합 하나를 본안(B3)으로 삼는다.\n\n' +
        '- **B3(심층, 메인 루프 지정)**: `ismcts-s64-v2buy-adaptivetrash-prior` — v5의 prior에서 **trash 축만** ' +
        'chapelEconomyV3의 적응형 임계 지식으로 부분 교체. 3회전이 chapelEconomyV3를 *독립 정책*으로 시험해 ' +
        '근접실패로 기각했지만, 같은 채굴이 "chapelTrash 재부상은 V2 buy/action이 만든 국면 분포와의 ' +
        '상호작용 효과"라고 진단했으므로, 가설의 올바른 형태는 "V2 지식 위에 얹은 trash 재적합"이다.\n' +
        '- **B1(기계) 2개**: `-w8`/`-w32` — 3회전이 priorWeight를 16으로 고정하고 넘어갔으므로 A5 축의 ' +
        '국소 곡선(8/16/32) 확보.\n' +
        '- **B2(상대정보) 1개**: 이번 라운드 자체 채굴의 최다 불일치 결정지점에서 재선정(3회전 표적 재사용 금지).\n' +
        '- **B4(탐험) 1개**: A3 전술 프리체크 — 도미니언 축 매트릭스에서 아직 미시도인 축(ADR-0009 준수).\n\n' +
        '판정 절차는 D5.5 포트폴리오 프로토콜 v2 그대로: 프로브 필터 -> 상위 4 -> 정규 웨이브' +
        '(regression 상대 = v5) -> challenge(L1/L2, N=40) -> composeBotChecked/assembleFlags 승격. ' +
        '초월 판정은 N=40 vs L2 CI 하한 > 0.5일 때만 N=200 확증, 확증도 통과할 때만 L3 홀드아웃.',
    },
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
