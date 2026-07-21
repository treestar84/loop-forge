# Loop Forge 로드맵

## v1 — 파이프라인 증명 (현재)
- 계약·커널·온보딩 채점·루프 엔진·레퍼런스 게임(mini-trick) end-to-end.
- 성공 기준: `npm run demo` 한 번으로 온보딩 채점 → 캘리브레이션 → 웨이브 → 채택 판정.

## v2 — 실전 게임 1종 온보딩
- 외부 게임 프로젝트(보드게임 또는 하스스톤류) 1종을 G-Profile → G-Convert로 실제 온보딩.
- GSPRT(pentanomial) 업그레이드, 소스 클로저 digest(런타임 identity), ablation 클린업 도구
  (`lab:cleanup` 상당), 분산 워커(OpenBench 모델) 검토.
- 큰 루프 반자동화: WaveReport 실패 패턴 → 후보 설계 프롬프트/템플릿 자동 생성.

## v3 — 온보딩 자동화
- G-Profile 소스 자동 분석(정적 분석 + 코딩 에이전트)으로 GameProfile 초안 자동 생성.
- 전환 작업 자체를 에이전트가 수행하고 G-Score 재채점 루프를 자동으로 도는 self-serve 온보딩.
- 채택 전략의 실게임 역이식(포팅) 가이드 자동 생성.
