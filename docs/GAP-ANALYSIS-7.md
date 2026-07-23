# 갭 분석 7 — OpenSpiel 흡수 라운드 (2026-07-23)

> 사용자 요청: google-deepmind/open_spiel의 규칙 모델·봇 생태계·학습 알고리즘을
> "참고 구현이 아니라 그대로 흡수/가져오기" 수준으로 반영하되, 기존 철학·파이프라인과
> 충돌 없이. 특히 CFR(Counterfactual Regret Minimization)은 현재 없는 영역이므로
> 면밀히 적용을 검토할 것.

## 0. 전제 — 이미 흡수된 것과 "그대로 흡수"의 실체

OpenSpiel 규칙 모델 6요소(State / legal_actions / apply_action / observation /
is_terminal / returns)는 **v1 계약에 이미 의도적으로 흡수돼 있다**(DESIGN.md §7이
출처로 명기). 이번 라운드의 대상은 규칙 모델이 아니라 그 위의 세 층이다:

1. 정보상태/관찰 분리 (`information_state_string`) — CFR의 전제
2. 탐색 봇 (MCTS/UCT) — 완전정보 게임의 표준 후보 생성기
3. 학습 알고리즘 (MCCFR) — 큰루프 §6.1 "v1엔 수제 코드 수정 외 개입 경로가 없다"의
   자동 대안

"그대로 흡수"는 언어 장벽(C++/Python → TypeScript) 때문에 코드 복사로는 불가능하다.
채택한 수준: **시맨틱 1:1 미러**(API 의미·검사 항목을 그대로) + **알고리즘 충실
이식**(faithful port — OpenSpiel `python/algorithms/`의 로직을 기준 삼아 옮기고
Apache-2.0 파생임을 CREDITS에 표기). 이를 위해 DESIGN.md §7의 "코드 복사 없음,
아이디어 수준 체리픽" 정책을 "OpenSpiel에 한해 충실 이식 허용 + 출처 표기"로
개정한다(사용자 승인, 2026-07-23).

## 1. 발견 갭과 처치

| ID | 갭 | 처치 | 상태 |
|---|---|---|---|
| O1 | 계약에 정보집합 키(`information_state_string`)·상태 복원 통로가 없어 CFR/MCTS를 하네스가 만들 수 없음 | `GameSpec.utility?`, `informationStateKey?`, `reconstructState?`(완전정보 전용) 옵션 필드 추가 — 전부 하위호환 | 구현 |
| O2 | `classifyGame`이 utility 구조(zero-sum/general)를 모름 — CFR 수렴 보장 판단 불가 | `utilityStructure`/`utilityDeclared` 필드 추가. 미선언은 추론하지 않고 general(보수적) | 구현 |
| O3 | OpenSpiel `api_test`의 전이 순수성 검사(applyChoice가 입력 상태를 변조하지 않음)가 C2에 없음 | C2 플레이아웃에 스냅샷 비교 검사 편입(첫 플레이아웃 10결정 한정 — 처리량 보호) | 구현 |
| O4 | 탐색/학습 봇을 웨이브 후보로 넣을 통로가 없음 — 후보는 `strategySurface` 플래그뿐이고, 어댑터(reference 계층)는 search/learn을 import할 수 없음(계층 규칙) | `withStrategyFlags(adapter, extra)` 순수 헬퍼(loop 계층) — 러너(앱 경계)가 어댑터 코드 수정 없이 플래그를 덧붙임. 채택 시 재현 책임은 러너가 짐(같은 config로 재조립) | 구현 |
| O5 | MCTS(UCT) 부재 | `src/search/mcts.ts` — OpenSpiel `mcts.py` 충실 이식(UCT 선택·랜덤 롤아웃 평가기·결정론 Rng 주입). 신규 계층 `search → contract, kernel` | 구현 |
| O6 | 완전정보 게임(오목·장기·스플랜더)에 탐색 후보 미투입 — 벤치마크 3열에서 오목은 Opus 즉흥봇에 97.1% 열세 | 러너에서 `withStrategyFlags`로 `mcts-s<N>` 후보 투입, 시뮬 예산은 봇 id에 박제(comparabilityKey 문맥 유지). 처리량 실측 후 예산 클램프 | 구현 |
| O7 | CFR 계열 부재. vanilla CFR은 명시적 chance node를 요구하나 Loop Forge는 랜덤성을 시드에 접는 설계라 부적합 | **outcome-sampling MCCFR** 이식(`src/learn/mccfr.ts`) — 반복마다 시드 샘플 = chance 샘플링과 구조적 동형이라 계약 개조 불필요. 정책 테이블 산출물(digest 봉인) + policy 봇 래퍼. mini-trick 한정 1호 검증 | 구현 |
| O8 | 승률은 상대 지표뿐 — 절대 실력 지표 부재 | (stretch) mini-trick 한정 sampled best-response로 근사 exploitability. 과하면 이연 | 조건부 |
| O9 | 문서 — 흡수 정책·출처·계층 규칙 갱신 | DESIGN.md §7 개정, CREDITS.md OpenSpiel 절 추가, 이 문서 | 문서 |

## 1.5 실측 결과 (2026-07-22~23 실행 증거)

| 게임 | 후보 | verdict | 근거 수치 |
|---|---|---|---|
| 오목 | mcts-s64 (64 sims, uctC 1.4, rollout 2) | **adopted** → v3 승격 | smoke 0.861(18블록) → prune 0.900(15) → holdout 1.000(15). 웨이브 26.5초 |
| 장기 | mcts-s16 (처리량 제약 클램프) | **failed** | smoke 0.000(8블록) — 판당 ~20초 비용 탓에 16시뮬로 줄이자 사실상 랜덤 수준. §3의 처리량-예산 충돌 실측 확인 |
| mini-trick | mccfr-os-200000 (9.5초 학습, 1,254,298 infosets, key=adapter) | **screened** | smoke 0.528(80블록) 통과 후 prune 0.550(5블록) 탈락 — 학습봇 특례 없이 게이트 정상 작동 |
| 스플랜더 | (투입 안 함) | 제외 | 관찰이 덱 순서를 숨김(진짜 은닉 정보) → reconstructState 불가, 결정화(IS-MCTS)는 이연 항목 |

재실행 안전성: 오목·장기 러너 2회 연속 실행에도 중복 승격 없음(장기 v1 유지,
오목 v3 1회만 생성). 결합 검증: tsc 0에러, 36 suites/401 tests 통과.

**O10 (벤치마크 재실행에서 발견된 신규 갭)**: 오목 3열 벤치마크 v3 재실행(N=2,000)
결과 B열 87.5% — 구 문맥의 100%보다 낮다. 원인: `mcts-s64`의 `apply`가 base를
무시해 v3 합성봇이 순수 MCTS가 되며 수제 플래그를 덮어썼는데, **게이트의 대전
상대가 raw heuristic이라 "현 기준선(v2) 대비 회귀"를 검출할 수 없었다**. 또한
holdout 15블록의 100%가 N=2,000에서 87.5%로 내려앉아 소표본 과대추정도 재확인
(GAP-ANALYSIS-6 R5 신호). 처치는 다음 라운드: 승격 전 "현 기준선 합성봇 vs 후보"
회귀 게이트 추가 검토 — FIX-BACKLOG에 미착수로 등록.

## 2. 명시적으로 이연한 것 (오버엔지니어링 방지)

| 항목 | 이연 사유 |
|---|---|
| IS-MCTS + `sampleStateFromObservation`(결정화) | 은닉 정보 게임(도미니언·하스스톤)용. 결정화 어댑터 훅 구현 비용이 크고, 완전정보 3게임 실증이 먼저 |
| BaselineRegistry 버전 표현 일반화(`kind: flags\|policy-table\|search-config`) | v1 버전=플래그 목록으로도 러너가 같은 config로 재조립하면 재현 가능. 정책 테이블 아카이브가 실제로 쌓이기 시작하면 착수 |
| 정확 exploitability(전 chance 열거) | 셔플 열거는 mini-trick조차 비현실적. sampled 근사로 충분하며 근사임을 산출물에 명시 |
| vanilla CFR / CFR+ / Deep CFR | chance node 명시화라는 계약 대수술 요구(6개 어댑터 재작성). MCCFR로 동일 목적 달성 |
| 동시수(simultaneous moves) 지원 | 현재 7게임 전부 순차. 필요 시 순차화로 대응 |

## 3. 알려진 이론적 한계 (숨기지 않음)

- **폴백 infoset 키의 perfect recall 미보장**: `informationStateKey` 미선언 시
  `digest(decisionPoint + canonical observation)` 폴백을 쓰는데, 관찰에 행동 이력이
  없으면 CFR 수렴 보장이 약해진다("observation-CFR"). 리포트에 폴백 사용 여부를 표기.
- **(O7 구현 중 발견) infoset 키는 사실상 관찰-유도만 가능**: 학습은 state를 보지만
  학습된 정책을 재생하는 봇은 계약상 관찰만 받는다. 따라서 `informationStateKey`는
  학습·재생 양쪽에서 같은 키가 나오려면 (decisionPoint, observation)의 함수여야
  한다 — 진짜 perfect recall을 원하면 어댑터가 **관찰에 행동 이력을 포함**시켜야
  한다(mini-trick은 state가 완료 트릭의 카드 이력을 버려 현재로선 불가 — 어댑터
  주석에 명시). 이것은 봇 계약(관찰만 본다)을 지키는 대가이며, 계약을 완화하지
  않는다.
- **다인 FFA·general-sum에서 CFR 보장 없음**: 스플랜더류. 보장 없이 "휴리스틱 후보"로
  투입은 가능하나 판정은 어차피 게이트가 한다(smoke≠채택 불변 규칙이 안전망).
- **MCTS 처리량 충돌**: 탐색봇은 판당 비용이 기준봇의 수백~수천 배. 시뮬 예산을 봇
  id에 박제하고(`mcts-s64`), 웨이브 규모는 실측 처리량으로 결정한다. C4 축이 경고를
  내면 그것은 정보이지 결함이 아니다.
- **학습봇도 게이트를 그대로 통과해야 adopted**: MCCFR/MCTS 후보라고 특례 없음 —
  holdout까지 통과해야 기준선 반영(불변 규칙 3 유지). 이것이 OpenSpiel엔 없는
  Loop Forge의 차별점이므로 절대 완화하지 않는다.
