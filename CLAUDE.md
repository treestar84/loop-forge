# Loop Forge — 에이전트 작업 지침

먼저 읽을 것: `docs/HANDOFF-2026-07-21.md`(최신 핸드오프 — 전체 맥락·현재 상태·다음
단계), 그다음 `DESIGN.md`.

## 작업 방식
- 설계·계획·갭 분석 = 메인 루프(Fable)가 직접 작성. 코드 구현 = Sonnet 서브에이전트 위임.
- 사용자 보고는 한국어, 표·수치 중심.
- 커밋 전 `npm run typecheck` + `npm test` 통과 필수.
- 커밋 트레일러: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## 불변 규칙 (docs/HANDOFF-2026-07-21.md §5의 요약, 위반 금지)
- 계층 의존 방향 `contract ← kernel ← loop ← onboarding` / `artifacts`는 loop 위 /
  게임 지식은 contract 위로 금지 — `src/__tests__/dependency-rules.test.ts`가 강제하며
  이 테스트를 우회·완화하지 않는다.
- `Date.now()`/`Math.random()`은 `src/reference/demo.ts`(앱 경계) 밖에서 금지.
- smoke 통과 ≠ 채택. holdout(미사용 예약 시드)까지 통과해야 adopted.
- holdout/graduation 시드 뱅크 재사용 금지, 앵커 봇 갱신 금지.
- 점수 비교는 comparabilityKey 동일 문맥 안에서만 (docs/INTERPRETATION.md 제1규칙).

## 문서 지도
- 온보딩 절차: `docs/ONBOARDING-GUIDE.md` (§0 적용 범위부터)
- 지표 해석: `docs/INTERPRETATION.md`
- 갭 분석 이력: `docs/GAP-ANALYSIS.md`(훌라·체스) → `-2.md`(5게임) → `-3.md`(12계열)
- 새 갭을 발견하면 새 GAP-ANALYSIS 문서에 기록하고 처치(구현/가이드/로드맵)를 명시한다.
