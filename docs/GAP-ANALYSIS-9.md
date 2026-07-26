# 갭 분석 9 — 탐색/학습 후보 생성의 게임 특화 하드코딩 (2026-07-26)

> 사용자 지적: 남은 백로그가 전부 "지금 온보딩된 7게임을 더 잘 만드는" 방향이고,
> "다음에 올 낯선 게임에 자동으로 대응하는" 방향이 빠져 있다. 루프 포지가 공개될
> 때 대입될 게임은 지금의 7종과 무관하므로, 다양성·확장성을 담당하는 장치가
> 하나의 방향으로 고착되면 안 되고 게임 특성에 따라 적용 범위를 자동으로
> 가감해야 한다.

## 1. 진단 — 온보딩 채점/게이트는 이미 파생형이지만 탐색 후보 생성은 아니다

| 계층 | 게임 특화 여부 |
|---|---|
| C0~C7 채점 임계, 티어 블록수, 점수차 임계(P6) | ✅ `classifyGame`+캘리브레이션 → `deriveBlueprint`로 자동 파생 |
| **탐색/학습 알고리즘 선택·예산·롤아웃 등급** | ❌ 매 게임마다 에이전트가 스크래치 실측→손 판단. 재사용 가능한 규칙으로 코드화되지 않음 |

증거: `src/reference/runners/shared/{gomoku,janggi}-mcts-flag.ts`,
`{splendor,dominion,hearthstone,wingspan}-ismcts-flag.ts` 6개 파일이 거의 동일한
보일러플레이트이고 차이는 시뮬레이션 수·문자열 상수뿐 — 전부 에이전트가 그때그때
3판 실측 후 손으로 고른 값. MCTS/IS-MCTS 선택, 롤아웃 에스컬레이션(random→
heuristic→champion), tacticalDepth 적용 여부도 코드가 아니라 에이전트 프롬프트
안에만 존재하는 판단이었다.

## 2. 처방 — `kernel/search-blueprint.ts`

`deriveBlueprint`의 자매 함수. 계층 규칙(`kernel`은 `search`/`learn`을 모름) 준수를
위해 출력은 순수 데이터(알고리즘 계열·예산·롤아웃 등급 기술)로 한정하고, 실제
`MctsConfig`/`IsmctsConfig`/`MccfrConfig`로의 번역은 앱 경계 단일 헬퍼
(`reference/runners/shared/search-candidate.ts`)가 맡는다 — 6개 중복 파일을
1개로 통합.

```ts
deriveSearchBlueprint(
  classification: GameClassification,
  capabilities: SearchCapabilities,   // 어댑터 옵션 메서드 선언 여부만 담은 평면 데이터
  throughputSamples: readonly ThroughputSample[],  // 앱 경계가 실측해 주입
  waveTimeBudgetMs: number,
): readonly SearchCandidateRecommendation[]
```

판단 규칙(이번 라운드 7게임 실측에서 역산한 것):
- `sampleStateFromObservation` 선언 → `information-set-tree-search` 계열,
  `reconstructState` 선언 → `tree-search` 계열, 둘 다 없으면 `'none'`(확장 지점
  명시 — 아직 결정화/재구성을 구현 안 한 게임).
- 2인 + `utility:'zero-sum'` + `informationStateKey` 선언 → `counterfactual-regret`을
  **별도 추가 후보**로 병행 추천.
- 예산: throughput 표본에서 wave 시간 예산(기본 30분) 이내 최대값 — 지금까지
  매번 손으로 하던 산식의 함수화.
- 롤아웃 등급 기본값 `'heuristic'`(random은 P1에서 이미 무의미함이 증명됨).
  `'champion'` 등급은 초기 추천에 포함하지 않는다 — 채택된 기준선이 있어야
  가능한 §6.1 큰루프 에스컬레이션(재설계) 단계의 몫이며, 이것이 맞다.
- `tacticalPrecheckDepth`: 트리서치 계열이면 depth=1은 사실상 공짜라 기본 추천.
  depth=2(O(legal²))는 분기계수 신호 없이는 보수적으로 보류.

**분기계수 신호 보강**: `loop/calibrate.ts`의 자기대국 항등 측정 루프가 이미
매 결정마다 상태를 순회하므로, 평균 합법수(`averageLegalChoiceCount`)를 공짜로
집계해 `NoiseFloorResult`에 추가 — `tacticalPrecheckDepth=2` 추천의 근거로 삼는다.

## 3. 의도적으로 하지 않는 것

- 기존 7게임의 이미 채택된 flag(mcts2-s256-hr 등)를 이 함수 출력으로 **교체하지
  않는다** — 손으로 검증된 결과를 건드릴 이유가 없다. 목적은 다음에 올 새 게임이
  같은 시행착오를 반복하지 않게 하는 것.
- 검증은 실전 웨이브 재실행이 아니라 **회귀 픽스처**(7게임의 실제 분류·능력·
  실측치를 데이터로 넣어, 그때 사람이 고른 방향과 이 함수의 추천 방향이 일치
  하는지)로 한다 — 비용 없이 설계를 검증.
- 챔피언 롤아웃 자동 시도, IS-MCTS 결정화 함수 자동 생성 등은 이 함수의 범위
  밖(여전히 어댑터 저자/에이전트의 몫) — 이 함수는 "1차 시도 후보 추천"까지만
  책임진다.

## 4. 온보딩 절차 변화

`docs/ONBOARDING-GUIDE.md`에 새 단계 반영: 캘리브레이션 이후
"탐색 후보 자동 추천"(`deriveSearchBlueprint` 호출 → `search-candidate.ts`로
플래그화 → 웨이브 투입)이 표준 절차가 된다 — 과거처럼 에이전트가 매번 알고리즘·
예산·롤아웃을 처음부터 판단할 필요가 없다.
