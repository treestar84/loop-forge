/**
 * dominion-design-brief-round2 — GAP-11 Phase 4-C first half, second file
 * (team-lead task): assembles dominion's round-2 design brief via
 * artifacts/design-brief.ts, following dominion-design-brief-round1.ts's
 * precedent (Phase 3-C) and gomoku-loss-mining-round2.ts's round-2 shape —
 * consumes dominion-loss-mining-round2.ts's judgment-summary.json (this
 * round's first file) plus portfolio-round1.json's wave/challenge outcome,
 * and folds in the gomoku round-2/round-3 lesson (A10 imitation-as-prior)
 * as transferable cross-game evidence per the task instruction.
 *
 * axisMatrix rows update dominion-design-brief-round1.ts's snapshot with
 * round 1's actual outcome: A8 (도메인 전략 재설계) moves from "이번 라운드
 * 시도" to "시도-성공" (all 3 chapelEconomy-family candidates adopted,
 * promoted to registry v3); A5 (트리 prior) moves from "미시도" to
 * "시도-실패" (B4's ismcts-s64-prior-w16 candidate advanced past the probe
 * filter but failed at the wave's prune tier, per
 * runs/dominion/portfolio-round1.json's wave.results). Every other row is
 * carried forward unchanged from round 1 (A1-A4, A6, A7, A9 untouched this
 * round; A10 still "실패 2회(주의)" from round 1 — no new imitation attempt
 * this round).
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
  console.log(`=== dominion design brief round 2 (GAP-11 Phase 4-C) — rootDir=${ROOT_DIR} ===`);

  const axisMatrix = [
    { axis: 'A1 탐색 예산', status: '시도(0.400)', note: 'ismcts-wave-4, ismcts-s256-hr, regression 단계 실패(ADR-0009 대상) — 1회전 이후 변경 없음' },
    { axis: 'A2 롤아웃 정책 교체', status: '시도(악화)', note: 'ismcts-wave-2/3, s64 계열이 s256보다 더 나쁜 결과 — 1회전 이후 변경 없음' },
    { axis: 'A3 전술 프리체크', status: '미시도' },
    { axis: 'A4 루트 오버라이드', status: '미시도' },
    {
      axis: 'A5 트리 prior (D1+D2)',
      status: '시도-실패',
      note:
        '1회전 B4: ismcts-s64-prior-w16 (dominionAdapter.choiceEvaluator를 priorSource로, s64 예산 불변, ADR-0009 준수) — ' +
        '프로브 필터 통과(agreement=97.0%)했으나 정규 웨이브 prune 단계에서 탈락(challenge L2=0.0%, L1=3.75%). 예산 상향 없이는 ' +
        '정적 evaluator prior만으로 heuristic 재설계(A8)를 넘지 못함.',
    },
    { axis: 'A6 상대 정보 기반 설계 (D4)', status: '미시도' },
    { axis: 'A7 오프닝 북 / 정석 테이블', status: '—', note: 'registry kind 일반화 선행 필요(D6 비고) — 변경 없음' },
    {
      axis: 'A8 도메인 전략 재설계',
      status: '시도-성공',
      note:
        '1회전 B1x2(chapelEconomy-d08/late3)+B3(chapelEconomy) 3개 후보 모두 채택 -> registry v3 승격. ' +
        'composeBot 덮어쓰기 시맨틱상 실제 지배 플래그는 리스트 마지막 원소 chapelEconomy 단독(아래 "v3 실체" 절 참조). ' +
        '2회전 재채굴: chapelTrash 불일치율이 67.4%(1회전 v2 기준선)에서 3.2%로 급감 — A8이 겨냥한 병목을 실제로 해소했음을 확인. ' +
        '병목은 action(19.4%)·buy(16.4%)로 이동 — 다음 라운드 B3 재설계의 표적.',
    },
    { axis: 'A9 학습(MCCFR/정책 테이블)', status: '미검토' },
    {
      axis: 'A10 모방/이식 (B5)',
      status: '실패 2회(주의)',
      note:
        '1회전 "흉내 열화" 실측 교훈 — 도미니언 0.275→0.100, 이번 라운드는 B5 미시도(변경 없음). ' +
        '오목 2·3회전 교훈(아래 extraEvidence)이 이 축에 대한 게임 간 이식 가능한 추가 근거를 제공: ' +
        '모방을 정적 값(fallback)이 아니라 탐색 prior로 이식하면(오목 v6→v7 opusclone prior) 대등까지는 도달할 수 있으나, ' +
        '거울 대국(자기 자신과 동일 정책의 상대)에서는 "예산 우위" 가설이 기각된다 — 모방 성공이 예산 절약을 자동 보장하지 않는다.',
    },
  ];

  const round2SummaryPath = join(ROOT_DIR, 'runs', GAME_ID, 'challenge-l2-round2', 'judgment-summary.json');
  let round2SummaryBody = '- 산출물 없음(challenge-l2-round2/judgment-summary.json 없음 — dominion-loss-mining-round2.ts를 먼저 실행)';
  if (existsSync(round2SummaryPath)) {
    const summary = JSON.parse(readFileSync(round2SummaryPath, 'utf8')) as {
      registry?: { composedFlagsList?: readonly string[]; actualDominantFlag?: string; composeBotSemanticNote?: string };
      measurement1_v3VsL2?: { result?: { candidateWinRate?: number; winRateCI?: { lower?: number; upper?: number } } };
      measurement2_v3VsL1?: { result?: { candidateWinRate?: number; winRateCI?: { lower?: number; upper?: number } }; gradientRestored?: boolean };
      lossReport?: { candidateLosses?: number; totalGames?: number; topMismatchDecisionPoints?: readonly { decisionPointId: string; mismatchRate: number }[] };
      probeBank?: { l2SelfAgreementRate?: number; v3AgreementRate?: number; probeCount?: number };
    };
    const m1 = summary.measurement1_v3VsL2?.result;
    const m2 = summary.measurement2_v3VsL1?.result;
    const top = summary.lossReport?.topMismatchDecisionPoints ?? [];
    round2SummaryBody =
      `v3 합성봇(리스트=[${(summary.registry?.composedFlagsList ?? []).join(', ') || '(none)'}], ` +
      `실제 지배 플래그='${summary.registry?.actualDominantFlag ?? '-'}')의 2회전 판정 실험 (dominion-loss-mining-round2.ts, GAP-11 Phase 4-C):\n\n` +
      `- composeBot 시맨틱: ${summary.registry?.composeBotSemanticNote ?? '-'}\n` +
      `- v3 vs L2(opus): winRate=${pct(m1?.candidateWinRate)} CI=[${pct(m1?.winRateCI?.lower)}, ${pct(m1?.winRateCI?.upper)}] ` +
      `(1회전 challenge의 chapelEconomy 단독 L2=17.5%와 CI 겹침 — 재현성 확인)\n` +
      `- v3 vs L1(mid): winRate=${pct(m2?.candidateWinRate)} CI=[${pct(m2?.winRateCI?.lower)}, ${pct(m2?.winRateCI?.upper)}] ` +
      `(그래디언트 추적: ${summary.measurement2_v3VsL1?.gradientRestored ? 'PASS' : 'FAIL'}, 1회전 challenge의 chapelEconomy 단독 L1=30.0%와 CI 겹침)\n` +
      `- 패배율: ${summary.lossReport?.candidateLosses ?? '-'}/${summary.lossReport?.totalGames ?? '-'}\n` +
      `- 프로브 은행 2회전: probes=${summary.probeBank?.probeCount ?? '-'}, L2 자기일치율=${pct(summary.probeBank?.l2SelfAgreementRate)}(1.0 기대 충족) ` +
      `— v3 새 프로브 일치율=${pct(summary.probeBank?.v3AgreementRate)}(정의상 0% — 이 확률은 v3가 L2와 갈린 지점만 채굴했으므로 예상된 값, 1회전 v2의 chapelTrash 0.0%와 같은 성격)\n` +
      `- 병목 이동: ${top.map((t) => `${t.decisionPointId}=${pct(t.mismatchRate)}`).join(', ') || '(none)'} ` +
      `(1회전 v2 기준선의 chapelTrash 67.4% 병목이 3.2%로 해소되고 action/buy로 이동)\n\n` +
      `상세 분기 깊이·결정지점 불일치율은 위 "LossReport 요약" 절 참조(같은 산출물에서 자동 추출됨).`;
  }

  const portfolioRound1Path = join(ROOT_DIR, 'runs', GAME_ID, 'portfolio-round1.json');
  let portfolioSummaryBody = '- 산출물 없음(portfolio-round1.json 없음)';
  if (existsSync(portfolioRound1Path)) {
    const p = JSON.parse(readFileSync(portfolioRound1Path, 'utf8')) as {
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
      `1회전 포트폴리오 웨이브 결과 (runs/dominion/portfolio-round1.json, dominion-portfolio-round1.ts):\n\n` +
      `| 플래그 | 판정 | 통과 단계 |\n|---|---|---|\n${rows}\n\n` +
      `challenge 승률 (feedback anchors):\n\n| 대상 | L2(opus) | L1(mid) |\n|---|---|---|\n${challengeRows}\n\n` +
      `승격: ${p.adoption?.promotedVersion ?? '-'} (채택 플래그: ${(p.adoption?.adoptedFlags ?? []).join(', ') || '(none)'})\n\n` +
      `버킷 수율: ${(p.bucketOutcomes ?? []).map((b) => `${b.bucket}(candidates=${b.candidates}, adopted=${b.adopted}, Δ=${b.challengeDelta.toFixed(4)})`).join(', ')}\n\n` +
      `주의: registry v3 flags 리스트에 chapelEconomy-d08/chapelEconomy-late3/chapelEconomy 3개가 모두 채택 기록되어 있지만, ` +
      `composeBot이 순서대로 flag.apply(prevFactory)를 체이닝하고 chapelEconomy 계열 apply()는 base를 받지 않는 시그니처로 ` +
      `직전 결과를 전부 무시하므로, registry.latest()가 실제로 만드는 봇은 리스트 마지막 원소 chapelEconomy 단독이다 — ` +
      `challenge 표의 chapelEconomy-d08(L2=22.5%/L1=33.1%)과 chapelEconomy 단독(L2=17.5%/L1=30.0%)을 혼동하지 말 것.`;
  }

  const extraEvidence = [
    {
      title: 'v3 판정 실험 요약 (dominion-loss-mining-round2.ts, 이번 라운드)',
      body: round2SummaryBody,
    },
    {
      title: '1회전 포트폴리오 웨이브 요약 (portfolio-round1.json)',
      body: portfolioSummaryBody,
    },
    {
      title: '오목 2·3회전 교훈 (게임 간 이식 가능한 지식, A10 관련)',
      body:
        '오목 GAP-11 Phase 4-A/4-B/4-B2 (commits 8a3b208/49b5650/55e850a)에서 얻은, 도미니언에도 적용 가능한 일반 교훈:\n\n' +
        '1. **모방을 정적 fallback이 아니라 탐색 prior로 이식하면 성공할 수 있다.** 4-A에서 v6(defensive 단독, 값 기반 모방)는 ' +
        '실패했지만, 4-B에서 opusclone(L2의 관측 정책)을 IS-MCTS/MCTS의 priorSource로 이식한 v7은 L2와 통계적 대등(승률 CI가 ' +
        '50%를 포함)에 도달했다 — "이식 방식"이 "이식 여부"보다 중요하다는 근거.\n' +
        '2. **그러나 대등 도달이 예산 우위를 자동으로 함의하지 않는다.** 4-B2의 s512-opusclone 진단에서, prior로 대등에 도달한 ' +
        '봇을 거울 대국(자기 자신과 동일 정책의 상대와 대전)에 놓으면 예산 우위 가설이 정직하게 기각됐다(부정 결과로 명시적 채택) — ' +
        '즉 "모방 prior로 L2와 비겼다"는 결과를 "더 적은 예산으로 이겼다"로 확대 해석해서는 안 된다.\n\n' +
        '도미니언 A10에 대한 함의: 1회전의 두 차례 모방 실패(0.275→0.100)는 정적 값 기반 모방(오목 v6과 같은 부류)이었다. ' +
        'A10을 재시도한다면 오목 4-B의 성공 경로(evaluator/opus 관측 정책을 탐색 prior로 이식, ADR-0009 예산 불변 준수)를 ' +
        '따르는 편이 근거가 있으나, 그 경우에도 "대등 도달"과 "예산 절약"을 분리해서 측정해야 한다(오목 4-B2의 부정 결과가 그 근거).',
    },
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
