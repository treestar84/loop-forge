/**
 * dominion-design-brief-round1 — GAP-11 Phase 3-C second half (docs/GAP-
 * ANALYSIS-11.md §5 Phase 3 step 3): assembles dominion's round-1 design
 * brief via artifacts/design-brief.ts, following gomoku-portfolio-round1.ts's
 * step 1 precedent, but as a standalone step — the batch generation/wave/
 * challenge steps that follow gomoku's round 1 are deliberately NOT done
 * here; they are a separate follow-up task.
 *
 * axisMatrix rows are dominion's column of docs/GAP-ANALYSIS-11.md §3 D6's
 * table verbatim (A1 시도(0.400), A2 시도(악화), A8 미시도, etc.) — the axis
 * matrix document is the source of truth, this runner only formats the
 * snapshot for the brief.
 *
 * extraEvidence summarizes what design-brief.ts's own artifact scan does NOT
 * pick up automatically: the four ismcts near-miss waves live in per-wave
 * files (runs/dominion/ismcts-wave-{1,2,3,4}-near-miss.json), not the single
 * near-miss.json the renderer reads, and dominion-loss-mining.ts's win-rate
 * pair (v2 vs L2/L1) is summarized alongside the LossReport section the
 * renderer already covers on its own.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer) per src/__tests__/dependency-rules.test.ts.
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { renderDesignBrief } from '../../artifacts/design-brief';

const GAME_ID = 'dominion';
const ROOT_DIR = join(__dirname, '..', '..', '..');

interface NearMissEntry {
  readonly flags?: readonly string[];
  readonly failedAtTier?: string;
  readonly pointWinRate?: number;
  readonly gap?: { readonly winRateGap?: number };
}

function readNearMiss(wave: number): NearMissEntry[] {
  const path = join(ROOT_DIR, 'runs', GAME_ID, `ismcts-wave-${wave}-near-miss.json`);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as NearMissEntry[];
}

function pct(x: number | undefined): string {
  return typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '-';
}

function main(): void {
  console.log(`=== dominion design brief round 1 (GAP-11 Phase 3-C, ADR-0013) — rootDir=${ROOT_DIR} ===`);

  const axisMatrix = [
    { axis: 'A1 탐색 예산', status: '시도(0.400)', note: 'ismcts-wave-4, ismcts-s256-hr, regression 단계 실패(ADR-0009 대상)' },
    { axis: 'A2 롤아웃 정책 교체', status: '시도(악화)', note: 'ismcts-wave-2/3, s64 계열이 s256보다 더 나쁜 결과' },
    { axis: 'A3 전술 프리체크', status: '미시도' },
    { axis: 'A4 루트 오버라이드', status: '미시도' },
    { axis: 'A5 트리 prior (D1+D2)', status: '미시도' },
    { axis: 'A6 상대 정보 기반 설계 (D4)', status: '미시도' },
    { axis: 'A7 오프닝 북 / 정석 테이블', status: '—', note: 'registry kind 일반화 선행 필요(D6 비고)' },
    { axis: 'A8 도메인 전략 재설계', status: '이번 라운드 시도', note: 'B3 주도, 예산 상향 금지 준수 — 이번 라운드의 기본 축' },
    { axis: 'A9 학습(MCCFR/정책 테이블)', status: '미검토' },
    { axis: 'A10 모방/이식 (B5)', status: '실패 2회(주의)', note: '"흉내 열화" 실측 교훈 — 도미니언 0.275→0.100' },
  ];

  const ismctsWaves = [1, 2, 3, 4].map((wave) => ({ wave, entries: readNearMiss(wave) }));
  const nearMissTable =
    '| 웨이브 | 플래그 | 실패 단계 | 승률 | 승률갭 |\n|---|---|---|---|---|\n' +
    ismctsWaves
      .flatMap(({ wave, entries }) =>
        entries.map(
          (entry) =>
            `| ismcts-wave-${wave} | ${(entry.flags ?? []).join('+') || '(none)'} | ${entry.failedAtTier ?? '-'} | ${pct(
              entry.pointWinRate,
            )} | ${entry.gap?.winRateGap !== undefined ? entry.gap.winRateGap.toFixed(3) : '-'} |`,
        ),
      )
      .join('\n');

  const lossMiningSummaryPath = join(ROOT_DIR, 'runs', GAME_ID, 'challenge-l2', 'judgment-summary.json');
  let lossMiningSummaryBody = '- 산출물 없음(challenge-l2/judgment-summary.json 없음 — dominion-loss-mining.ts를 먼저 실행)';
  if (existsSync(lossMiningSummaryPath)) {
    const summary = JSON.parse(readFileSync(lossMiningSummaryPath, 'utf8')) as {
      registry?: { composedFlags?: readonly string[] };
      measurement1_v2VsL2?: { result?: { candidateWinRate?: number; winRateCI?: { lower?: number; upper?: number } } };
      measurement2_v2VsL1?: { result?: { candidateWinRate?: number; winRateCI?: { lower?: number; upper?: number } }; gradientRestored?: boolean };
      lossReport?: { candidateLosses?: number; totalGames?: number };
    };
    const m1 = summary.measurement1_v2VsL2?.result;
    const m2 = summary.measurement2_v2VsL1?.result;
    lossMiningSummaryBody =
      `v2 합성봇(flags=[${(summary.registry?.composedFlags ?? []).join(', ') || '(none)'}])의 이번 라운드 판정 실험 ` +
      `(dominion-loss-mining.ts, GAP-11 Phase 3-C):\n\n` +
      `- v2 vs L2(opus): winRate=${pct(m1?.candidateWinRate)} CI=[${pct(m1?.winRateCI?.lower)}, ${pct(m1?.winRateCI?.upper)}]\n` +
      `- v2 vs L1(mid): winRate=${pct(m2?.candidateWinRate)} CI=[${pct(m2?.winRateCI?.lower)}, ${pct(m2?.winRateCI?.upper)}] ` +
      `(그래디언트 복원: ${summary.measurement2_v2VsL1?.gradientRestored ? 'PASS' : 'FAIL'})\n` +
      `- 패배율: ${summary.lossReport?.candidateLosses ?? '-'}/${summary.lossReport?.totalGames ?? '-'}\n\n` +
      `상세 분기 깊이·결정지점 불일치율은 위 "LossReport 요약" 절 참조(같은 산출물에서 자동 추출됨). ` +
      `L1(9.0%) > L2(6.0%) 순서가 실측됐으나 둘 다 낮고 CI가 겹쳐(오목처럼 명확한 heuristic<L1<L2 서열이 ` +
      `이 매치업 쌍만으로는 재확인되지 않음) — A8 재설계가 겨냥할 신호는 승률 서열보다 아래 결정지점별 ` +
      `불일치율(LossReport 절)이 더 강하다.`;
  }

  const extraEvidence = [
    {
      title: 'IS-MCTS 근접실패 이력 (ismcts-wave-1~4-near-miss.json)',
      body:
        nearMissTable +
        '\n\n4개 웨이브 모두 근접실패(smoke/prune만 통과, holdout 또는 regression에서 탈락) — ' +
        'A1(탐색 예산)·A2(롤아웃 정책) 축의 파라미터 스윕만으로는 L2를 넘지 못한다는 반복 증거. ' +
        'wave-4(s256-hr)가 최고치 0.400으로 가장 근접했으나 여전히 CI 상한 0.55 < 기준 0.5 초과 실패. ' +
        '이 패턴이 A8(도메인 전략 재설계)이 이번 라운드의 기본 축으로 지정된 근거다.',
    },
    {
      title: 'v2 판정 실험 요약 (dominion-loss-mining.ts, 이번 라운드)',
      body: lossMiningSummaryBody,
    },
  ];

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
