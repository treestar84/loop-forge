# Loop Forge — 에이전트 작업 지침

먼저 읽을 것: `docs/HANDOFF-2026-07-28.md`(최신 핸드오프 — 전체 맥락·현재 상태·다음
단계. `-2026-07-21.md`는 이전 핸드오프로 역사적 기록만), 그다음 `DESIGN.md`, 그다음
`docs/adr/`(주요 결정의 맥락·대안·결과)와 `docs/TROUBLESHOOTING.md`(운영 함정).

## 작업 방식
- 설계·계획·갭 분석 = 메인 루프(Fable)가 직접 작성. 코드 구현 = Sonnet 서브에이전트 위임.
- 사용자 보고는 한국어, 표·수치 중심.
- 커밋 전 `npm run typecheck` + `npm test` 통과 필수.
- 커밋 트레일러: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## 불변 규칙 (docs/HANDOFF-2026-07-21.md §5의 요약, 위반 금지)
- 계층 의존 방향 `contract ← kernel ← loop ← onboarding` / `artifacts`는 loop 위 /
  게임 지식은 contract 위로 금지 — `src/__tests__/dependency-rules.test.ts`가 강제하며
  이 테스트를 우회·완화하지 않는다.
- `Date.now()`/`Math.random()`은 앱 경계(`src/reference/demo.ts`, `src/reference/runners/*.ts`) 밖에서 금지.
- smoke 통과 ≠ 채택. holdout(미사용 예약 시드)까지 통과해야 adopted.
- holdout/graduation 시드 뱅크 재사용 금지, 앵커 봇 갱신 금지.
- 점수 비교는 comparabilityKey 동일 문맥 안에서만 (docs/INTERPRETATION.md 제1규칙).

## 문서 지도
- 핸드오프(최신 상태 스냅샷): `docs/HANDOFF-2026-07-28.md`
- 아키텍처 결정 기록(왜 이렇게 됐는가): `docs/adr/README.md` (ADR-0001~0010)
- 운영 함정·재발 방지: `docs/TROUBLESHOOTING.md`
- 온보딩 절차: `docs/ONBOARDING-GUIDE.md` (§0 적용 범위부터, §10까지 — 탐색 후보 자동 추천 포함)
- 지표 해석: `docs/INTERPRETATION.md`
- 갭 분석 이력: `docs/GAP-ANALYSIS.md`(훌라·체스) → `-2.md`(5게임) → `-3.md`(12계열)
  → `-4.md`(실전 온보딩 1차: 스플랜더·오목) → `-5.md`(목표 정합성 점검) → `-6.md`
  (산출물 신선도·3열 비교 실험 착수 전 점검) → `-7.md`(OpenSpiel 흡수: MCTS/IS-MCTS/
  MCCFR) → `-8.md`(고도화+전 게임 스윕, 오목 C열 카드 1~3) → `-9.md`(탐색 후보 자동
  추천 계층) → `-10.md`(4개 신규 카테고리 사전 진단: 숨은 진영·협동·실시간·대인원)
- 벤치마크: 실험 설계 `docs/BENCHMARK-EXPERIMENT.md`, 실측 결과(1~7)
  `docs/BENCHMARK-LEADERBOARD.md`
- 새 갭을 발견하면 새 GAP-ANALYSIS 문서에 기록하고 처치(구현/가이드/로드맵)를 명시한다.
- 실제로 고쳐야 할 코드/가이드 항목은 `docs/FIX-BACKLOG.md`에 누적 추적한다(라운드별
  기록인 GAP-ANALYSIS와 달리 상태가 바뀌는 살아있는 목록 — 줄을 지우지 않고 상태만 갱신).
- 되돌리기 비싼 결정을 새로 내리면 `docs/adr/`에 번호를 이어 ADR을 추가한다.
