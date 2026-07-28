# Loop Forge — 설계도

> **문서 지도**: 최신 상태는 [`docs/HANDOFF-2026-07-28.md`](docs/HANDOFF-2026-07-28.md),
> 개별 결정의 맥락·대안·결과는 [`docs/adr/`](docs/adr/README.md), 운영 함정은
> [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md). 이 문서는 "지금 구조가
> 어떻게 생겼는가"의 정본이고, ADR은 "왜 이렇게 됐는가"의 정본이다.

> 완성된 게임 프로젝트(보드게임·하스스톤류 전략 카드게임 등)를 받아서, 그 게임의 NPC 난이도를
> **프롬프트 한 줄 없이** 자동으로 끌어올리는 플랫폼. 방법은 두 가지 축의 결합이다:
> **게임 온보딩 파이프라인**(게임을 하네스 위에서 돌 수 있는 상태로 전환·채점·검증)과
> **큰 루프/작은 루프 실험 엔진**(수십만 판 규모의 통계적 전략 검증).

이 설계는 실전에서 검증된 선행 프로젝트(웹 티추 NPC 하네스: 4,100개 후보 · 16만+ 판 · 과적합
발견과 재설계까지의 전체 사이클)의 교훈을 일반화한 것이다. 그 하네스에서 실제로 터졌던 사고들
— 좌석 편향 +15%p, 고정 시드 과적합, ±7.9%p 통계 노이즈의 오채택, 관찰(observation) 오염 —
이 이 설계의 채점 축과 게이트 규칙의 직접적 근거다.

---

## 1. 전체 아키텍처 — 4개 계층

```
┌──────────────────────────────────────────────────────────────┐
│ ④ 루프 엔진 (큰 루프)                    src/loop/            │
│    후보 전략 설계 → 웨이브 발주 → 결과 해석 → 재설계            │
├──────────────────────────────────────────────────────────────┤
│ ③ 실험 커널 (작은 루프)                  src/kernel/          │
│    시드 원장 · 페어드 통계 · SPRT · digest 무결성 ·           │
│    다단 채택 게이트 (screen→smoke→prune→holdout→graduation)  │
├──────────────────────────────────────────────────────────────┤
│ ② 적합성 게이트 (Conformance Gate)       src/onboarding/      │
│    G-Score 채점 배터리: 축별 점수 + 부족 구현 목록 + 수정 지침  │
│    임계 미달이면 루프 실행을 거부한다 (preflight hard-stop)     │
├──────────────────────────────────────────────────────────────┤
│ ① 게임 어댑터 계약 (Game Adapter Contract) src/contract/      │
│    게임 온보딩 파이프라인의 산출물 포맷                         │
│    (headless 룰 엔진 · 관찰 빌더 · 합법수 · 기준선 봇)          │
└──────────────────────────────────────────────────────────────┘
```

계층 간 규칙: **위 계층은 아래 계층의 타입에만 의존한다.** ③④는 게임을 전혀 모른다 —
아는 것은 `GameAdapter`와 `GameBot` 인터페이스뿐이다. 게임 지식은 전부 ①의 어댑터 구현
안에 갇힌다. (티추 하네스에서 `mistake-detector`에 게임 로직이 스며들어 경계가 무너졌던
것의 재발 방지: 도메인 훅은 어댑터가 **데이터로 선언**하고 커널은 실행만 한다.)

**실제 import 의존 방향** (위 다이어그램은 개념도이고, 코드 의존은 아래가 정본이다 —
적합성 게이트는 게임을 "실행"해서 채점하므로 loop 위에 있다):

```
contract ← kernel ← loop ← onboarding
                  ↖ artifacts
              ↖ search (mcts — OpenSpiel 충실 이식, contract+kernel만)
              ↖ learn  (mccfr — 〃)
reference → (contract, kernel/rng)          demo, reference/runners/* → 전 계층 (앱 경계)
```

`search/`·`learn/`(2026-07-23, `docs/GAP-ANALYSIS-7.md`)의 산출물은 전부
`BotFactory`다 — 루프 엔진은 이들의 존재를 모르고, 러너(앱 경계)가
`withStrategyFlags`로 어댑터에 후보 플래그를 덧붙여 웨이브에 주입한다. 탐색/학습
봇이라도 holdout까지 통과해야 adopted(불변 규칙 3에 특례 없음).

`reference/runners/<gameId>.ts`는 게임별 실행 진입점이다(H5/Z3) — `demo.ts`와
동일하게 앱 경계로 취급되어 전 계층을 import할 수 있고 `Date.now()`도 허용된다
(`src/__tests__/dependency-rules.test.ts`의 `APP_BOUNDARY_PREFIXES`가 `reference/
runners/`로 시작하는 모든 경로를 자동 예외 처리 — 게임이 늘어나도 예외 목록을
수동으로 추가할 필요가 없다).

허용 edge는 이것이 전부이며, `src/__tests__/dependency-rules.test.ts`가 기계적으로
강제한다 (위반 import는 테스트 실패). 결정론 규칙(`Date.now()`/`Math.random()` 금지,
앱 경계 제외)도 같은 방식으로 강제된다 — 문서로만 존재하는 규칙은 성장 중에 반드시
무너진다는 것이 선행 하네스의 교훈이다.

## 2. ① 게임 어댑터 계약

### 2.1 핵심 결정: "결정 지점은 데이터, 봇 인터페이스는 메서드 하나"

티추 하네스의 `TichuBot`은 `chooseGrandTichu / choosePassSignal / choosePush /
chooseMahjongWish` 등 게임 전용 메서드 7개로 굳어 있어서 재사용이 불가능했다.
Loop Forge에서는 이를 뒤집는다:

- 어댑터가 자기 게임의 결정 지점(멀리건, 카드 플레이, 공격 대상 지정, 패교환…)을
  `DecisionPointSpec[]` **데이터로 선언**한다.
- 봇 인터페이스는 `decide(decisionPoint, observation, legalChoices) → choice`
  **단 하나**다. 커널·루프는 결정 지점의 의미를 몰라도 된다.

### 2.2 계약 명세 (`src/contract/types.ts`가 정본)

| 구성 요소 | 역할 | 근거가 된 선행 사례 |
|---|---|---|
| `createInitialState(seed)` | 시드 → 초기 상태. 모든 랜덤은 주입된 RNG로만 | 티추 harness/core 결정론 규칙 |
| `currentDecision(state)` | 지금 누가 어떤 결정을 내릴 차례인지 (null=종국) | PettingZoo AEC의 agent iteration |
| `getObservation(state, player)` | **정보 은닉의 유일한 통로** | 티추 observationBuilder 경계 |
| `getLegalChoices(state)` | 현재 결정의 합법 선택지 | OpenSpiel `State.legal_actions` |
| `applyChoice(state, choice)` | 상태 전이 (순수 함수) | OpenSpiel `apply_action` |
| `getOutcome(state)` | 승자 + 플레이어별 composite score | OpenSpiel `returns` |
| `encodeChoice(choice)` | 선택의 안정적 문자열 키 (로깅·dedup·재현 비교) | 티추 sortedActionKey |
| `invariants` | 게임별 불변량(카드 보존 등)을 데이터로 선언 | 티추 harness invariants 테스트 |
| `hiddenInfoProbe` | "이 플레이어가 보면 안 되는 정보"를 변조하는 훅 → 관찰 불변성 자동 검사 | 티추 tichuCalls 오염 버그의 교훈 |
| `baselines` | Random + Heuristic 기준선 봇 (필수 동봉) | 티추 ladder-v1의 바닥 rung |
| `strategySurface` | 이름 붙은 플래그 → 변형 봇 생성기 (후보 전략 주입 지점) | 티추 StrategyFlags의 일반화 |
| `seatingPlan` | 페어드 평가용 좌석 순열 스케줄 | 좌석 편향 +15%p 사고의 재발 방지 |

### 2.3 결정론 규칙 (강제)

어댑터/봇 코드에서 `Date.now()` · `Math.random()` · 외부 I/O 금지. 모든 랜덤은
`createInitialState(seed)`와 `BotFactory(seed)`로 주입된 결정론적 RNG(Mulberry32)를
통해서만 흐른다. 같은 (게임 시드, 봇 시드 배열)은 반드시 같은 trajectory를 재생한다 —
이것이 C1 축에서 자동 검증된다.

## 3. 게임 온보딩 파이프라인 (①을 만드는 과정)

```
게임 프로젝트 소스 입력
   ↓
[G-Profile] 게임 파악 — GameProfile 문서 생성 (규격화된 인벤토리)
   ↓            페이즈 구조 · 결정 지점 · 랜덤성 원천 · 은닉 정보 경계 ·
   ↓            승패 판정 · 기존 NPC/AI 로직의 위치 · UI/네트워크 결합 지점
   ↓
[G-Score] 전환 준비도 채점 — 아래 4장의 축별 자동 채점
   ↓                                                  ↖
[G-Convert] headless 쌍둥이 구현 (어댑터 계약 충족)      │ 미달 항목 수정
   ↓                                                  │ 후 재채점 (반복)
[G-Parity] 쌍둥이 정합성 검증 — 실게임 리플레이 재생 일치   ↗
   ↓ 임계 통과 (preflight)
②③④ 순수 계층으로 인계 → 수십만 판 루프 시작
```

- v1에서 G-Profile은 **규격화된 템플릿**(`GameProfile` 스키마)이다. 사람 또는 코딩
  에이전트가 소스를 읽고 채우며, 스키마 검증기가 완전성을 강제한다. (소스 자동 분석은
  v3 로드맵.)
- G-Parity는 어댑터가 `replayFixtures`(실게임에서 뽑은 리플레이)를 동봉하면 커널이
  재생-비교한다. 리플레이가 없으면 해당 축 점수 상한이 잠긴다 — "정합성 미증명" 상태로
  루프에 들어갈 수 없다. (티추 v3 증거 계약의 production parity 요구 일반화.)

## 4. ② 적합성 게이트 — G-Score 채점 배터리

각 축 0~100점. **종합 점수는 가중 평균이 아니라 최저 축이 지배한다**(한 축이라도
바닥이면 루프 무의미). 채점 리포트는 점수 + 실패 항목별 `blocker` + 수정 지침 문자열을
낸다. 임계(기본 70) 미달이면 웨이브 러너가 실행을 거부한다.

| 축 | 이름 | 검사 내용 | 선행 하네스에서의 근거 사고 |
|---|---|---|---|
| C0 | 계약 정합성 | 어댑터 shape·spec 유효성, 결정지점/좌석계획 선언 완전성 | — |
| C1 | 결정론 | 같은 시드 N회 재현 → trajectory(choice key 열 + outcome) 동일 | 시드 재현이 전체 파이프라인의 전제 |
| C2 | 규칙 무결성 | 랜덤 플레이아웃 K판 무크래시 · 합법수 비어있지 않음 · 불법 choice 거부 · 최대 스텝 내 종국 · invariants 통과 | invalid/crash 지표 |
| C3 | 정보 은닉 | `hiddenInfoProbe`로 비공개 정보 변조 → 관찰 불변 | observationBuilder 오염 버그 |
| C4 | 처리량 | 초당 게임 수 측정, 하한 미달 시 감점 (수십만 판의 전제) | 16만 판 실험의 현실성 |
| C5 | 기준선 생태계 | Random 자기대국 항등 캘리브레이션 = 50%±CI · Heuristic이 Random을 유의하게 이김 · 좌석별 승률 편차 측정·보고 | **좌석 편향 +15%p 오채택 사고** |
| C6 | 전략 표면 | strategySurface 플래그가 probe 시드에서 실제로 다른 결정을 만드는지 (no-op/중복 검출) | v58 리셋에서 56/100이 no-op |
| C7 | 정합성 증명 | replayFixtures 재생 일치율 | 티추 production parity 요구 |

## 5. ③ 실험 커널 (작은 루프)

전부 게임 중립 — 숫자·시드·digest만 다룬다. 선행 하네스에서 이식/일반화:

- **시드 원장** (`kernel/seed-ledger.ts`): 시드 뱅크 예약/소비 원장. 구간 겹침 금지,
  1회 소비. holdout/graduation 뱅크는 학습에 재사용 불가. → 고정 시드 과적합 재발 방지.
- **페어드 통계** (`kernel/paired-stats.ts`): 시드 블록(좌석 미러링 페어)을 재표본 단위로
  하는 퍼센타일 부트스트랩 신뢰구간. → 좌석 편향 상쇄 + 올바른 분산 추정.
- **SPRT** (`kernel/sprt.ts`): Fishtest/OpenBench에서 체리픽. 고정 판수 대신 순차 검정 —
  효과가 명확한 후보는 일찍 끝내고, 애매한 후보에 판수를 몰아준다. smoke 단계의 기본 게이트.
- **digest 무결성** (`kernel/digest.ts`): 평가 산출물의 canonical JSON SHA-256 봉인.
  실험 증거의 변조·드리프트 감지. (v1은 산출물 봉인까지, 소스 클로저 digest는 v2.)
- **다단 채택 게이트** (`kernel/gates.ts`):
  `screen(0판, 행동 지문) → smoke(SPRT, salt 시드) → prune(고정 N, salt 시드)
  → holdout(고정 N, 미사용 예약 뱅크) → graduation(사이클 경계, 완전 신규 뱅크)`.
  smoke 통과는 "선별"일 뿐 채택이 아니다. holdout까지 통과해야 기준선 반영.
  → ±7.9%p 노이즈 오채택 재발 방지.

## 6. ④ 루프 엔진 (큰 루프)

- **매치 러너** (`loop/match.ts`): 어댑터 위에서 1판 실행. 불법 choice·무한 루프·
  invariant 위반을 즉시 검출해 게임 결과가 아닌 **어댑터 결함**으로 분류.
- **페어드 대국** (`loop/paired-match.ts`): seatingPlan의 좌석 순열마다 같은 게임 시드로
  반복 → 시드 블록 하나의 승률 분수/점수차를 산출.
- **캘리브레이션** (`loop/calibrate.ts`): 항등 테스트(같은 봇 vs 같은 봇 → 50% 확인),
  노이즈 플로어, 좌석 편향 측정. C5 축의 실행기이자 상시 진단 도구.
- **웨이브 러너** (`loop/wave-runner.ts`): 후보 집합을 받아 게이트 순서대로 평가하고
  `WaveReport`(채택/선별/근접실패/실패 + 통계 + 시드 소비 기록)를 봉인.
### 6.1 큰 루프 프로토콜 (v1 — 사람/에이전트 개입 지점 명세)

GAP-ANALYSIS-5 H9에서 확인된 대로, v1까지는 이 절이 한 문장("WaveReport 실패 패턴이
다음 후보 설계의 입력이 된다")뿐이었다. 실제로 "개입"이 무엇을 의미하는지, 어떤
순서로 진행하는지를 아래에 명세한다 — 새 도구를 만드는 게 아니라 **이미 존재하는
조각들(WaveReport, AdoptionLedger, strategySurface)을 어떤 순서로 조합해 쓰는지**를
성문화하는 것이다.

**1단계 — 웨이브 결과 확보**: `runWave`(또는 `assembleWaveConfig` + `runWave`)를
1회 실행하면 `WaveReport`가 나온다. 각 후보는 `verdict`
(`adopted`/`screened`/`near-miss`/`failed`) + 축소된 통계(`WaveCandidateResult.stats`)를
가진다. 이 시점에 채택된(`adopted`) 후보는 바로 `BaselineRegistry`에 새 버전으로
합성(v1→v2 등)하면 되고, 사람의 개입이 필요한 건 **near-miss/failed** 후보뿐이다.

**2단계 — near-miss를 구조화된 형태로 추출**: `AdoptionLedger`의
`extractNearMissCandidates(record)`(H10, `src/artifacts/adoption-ledger.ts`)가
자유 텍스트 `nextLoopNotes` 대신 각 near-miss 후보의 `{flags, failedAtTier,
pointWinRate, pointScoreDiff, winRateCI, gap}`을 기계가 읽을 수 있는 목록으로
뽑아준다. `gap`은 승격 기준(`PromotionCriteria`)까지 얼마나 모자랐는지를 나타내
"조금만 더 손보면 되는 후보"와 "근본적으로 다시 설계해야 하는 후보"를 구분하는
근거가 된다.

**3단계 — 사람 또는 에이전트가 재설계**: 이 구조화된 목록을 읽고, 게임 어댑터의
`strategySurface`(`src/reference/<game>.ts`)에서 해당 `StrategyFlagSpec.apply`
클로저를 수정하거나 새 플래그를 추가한다. v1에는 이것 말고 다른 개입 경로가 없었다
— config/데이터 기반으로 전략을 제안하는 방법은 없고, 항상 TypeScript 코드를 고쳐
어댑터를 재빌드해야 했다.

**2026-07-26 갱신**: `kernel/search-blueprint.ts`(`deriveSearchBlueprint`, §10,
ADR-0005)가 3단계의 "탐색/학습 계열 후보를 뭘로 시도할지" 판단 부분을
classification+capabilities+실측 기반 자동 추천으로 대체했다 — **단, 이건 "어떤
알고리즘·예산을 1차 시도할지"까지만 자동화한 것이고, 여전히 코드 작업(전략 플래그
자체를 손으로 작성/조정하는 것)이 남는다.** 예를 들어 오목의 `forkAwareness`(다방향
위협 인식, ADR-0008)나 도미니언의 챔피언 롤아웃 재도전은 여전히 사람/에이전트가
게임을 분석해 직접 설계한 것이다. 자동화된 것은 "1차 시도의 시작점"이지 "재설계
전체"가 아니다 — 이 구분을 흐리지 않는다.
- 이미 한 웨이브에서 판정된 `flag` 이름은 **재사용하지 않는다** — 같은 이름으로
  로직만 바꾸면 `AdoptionLedger`의 이력이 "같은 플래그가 예전엔 near-miss였는데
  이번엔 adopted"처럼 모호해진다. 로직을 바꿨으면 새 flag 이름을 쓴다
  (`winCheapestV2` 등).
- 완전히 새로운 아이디어를 시도하고 싶으면 그냥 새 `StrategyFlagSpec`을 추가한다 —
  near-miss 재설계와 신규 아이디어 추가는 같은 메커니즘(strategySurface에 항목
  추가)이다.

**4단계 — 다음 웨이브 발주**: 재설계/신규 플래그의 이름을 다음 `runWave` 호출의
`candidates`에 손으로 나열한다(`WaveConfig.candidates` — 여전히 호출자가 채우는
평문 리스트, `wave-runner.ts` 참고). 여기서 사람이 조절할 수 있는 또 다른 개입
축은 **탐색 폭**이다 — 한 라운드에 후보를 몇 개 넣을지, `tiers`의 블록 수를
얼마나 넉넉하게 잡을지는 예산(시간·시드 뱅크)과 트레이드오프이며 이것도 명시적
개입 지점이다.

**요약 — v1에서 "사용자가 큰루프에 개입한다"의 정확한 의미**:
1. 웨이브 리포트를 읽는다(사람 또는 에이전트).
2. `extractNearMissCandidates`로 무엇이 얼마나 아깝게 실패했는지 구조화된 형태로
   본다.
3. 어댑터 코드에서 전략 플래그를 수정/추가한다(코드 작업 — v1엔 이것뿐).
4. 다음 웨이브의 candidates/tiers를 정하고 재발주한다.

자동화(ROADMAP v2 "큰 루프 반자동화": 실패 패턴 → 후보 설계 프롬프트/템플릿 자동
생성)는 3단계를 에이전트가 대신 하게 만드는 것이지, 이 4단계 절차 자체를 바꾸는
것이 아니다.

## 7. 오픈소스 체리픽 명세

| 출처 | 가져온 것 | 반영 위치 |
|---|---|---|
| OpenSpiel (DeepMind) | `Game/State` API의 형태: legal_actions → apply_action → returns 사이클, 은닉 정보 게임 지원 구조 | `contract/types.ts` |
| PettingZoo | AEC(Agent-Environment-Cycle)식 "지금 누구 차례" 이터레이션 | `currentDecision()` |
| Gymnasium `check_env` / PettingZoo `api_test` | 환경 구현 자동 검사 배터리라는 발상 — 단 이진 통과가 아닌 **세분화 점수 + 수정 지침**으로 확장 | `onboarding/score.ts` |
| Fishtest / OpenBench | SPRT 순차 검정, "패치 후보 → 대량 대국 → 통계 게이트" 운영 모델, 분산 워커(v2 로드맵) | `kernel/sprt.ts`, 게이트 설계 |
| 티추 NPC 하네스 (선행 프로젝트) | 시드 원장 · 페어드 부트스트랩 · 다단 게이트 · 캘리브레이션 · 행동 지문 스크리닝 · digest 봉인 · parity 요구 — 그리고 이 전부의 **실사고 근거** | `kernel/*`, `onboarding/*` 전반 |
| Optuna/Ax | (개념만) 탐색-활용 균형의 후보 예산 배분 — v2 큰 루프 자동화에서 참고 | ROADMAP |
| OpenSpiel (2차 흡수, 2026-07-23) | `information_state_string`/`GameType.utility` 시맨틱, `api_test` 전이 순수성 검사, **UCT MCTS·outcome-sampling MCCFR 알고리즘 충실 이식** | `contract/types.ts` 옵션 필드, `onboarding/score.ts` C2, `search/mcts.ts`, `learn/mccfr.ts` (`docs/GAP-ANALYSIS-7.md`) |

라이선스: 기본 정책은 코드 복사 없음(아이디어 수준 체리픽 + 자체 구현).
**예외(2026-07-23 개정)**: OpenSpiel(Apache-2.0)의 알고리즘 구현(`python/algorithms/`
의 MCTS·MCCFR)에 한해 로직을 기준 삼은 충실 이식(faithful port)을 허용한다 —
파생 사실과 원 출처를 해당 파일 상단 주석과 `docs/CREDITS.md`에 표기한다.

## 8. v1 범위 (이 저장소의 첫 구현)

1. `contract/types.ts` — 계약 정본 (이 설계 문서의 §2)
2. `kernel/` — rng, seed-ledger, paired-stats, sprt, digest, gates (+단위 테스트)
3. `onboarding/` — GameProfile 스키마·검증기, C0~C7 채점 배터리, 리포트 생성 (+테스트)
4. `loop/` — match, paired-match, calibrate, wave-runner (+테스트)
5. `reference/` — 레퍼런스 게임 **mini-trick**(2인 트릭테이킹: 셔플 RNG · 상대 손패 은닉 ·
   선공 편향 존재 · 전략 플래그 3개)으로 전체 파이프라인 end-to-end 증명:
   온보딩 채점 → 캘리브레이션 → 웨이브 1회 → 채택 판정까지 `npm run demo` 한 번에 실행.

v1의 성공 기준: 레퍼런스 게임이 C0~C7을 통과하고, 웨이브 러너가 "효과 있는 플래그는
채택, no-op 플래그는 screen에서 탈락, 노이즈 플래그는 holdout에서 탈락"을 실제로
보여주는 것.

## 9. 실전 온보딩 현황 (v1.4~1.5, 2026-07-21~22)

레퍼런스 게임(mini-trick) 외에 실제 오픈소스 게임 6종을 온보딩했다. 각 게임의
어댑터는 `src/reference/<gameId>.ts`, 실행 진입점은 `src/reference/runners/
<gameId>.ts`(mini-trick만 예외적으로 `demo.ts`를 씀 — 파이프라인 최초 증명용이라
분리하지 않음). 원본 오픈소스 출처는 `docs/CREDITS.md` 참고.

| 게임 | 원본 소스 | 특성 | 갭 분석 |
|---|---|---|---|
| 스플랜더 | caeleel/splendor | 2~4인 FFA, 완전정보, 콘텐츠(카드) 100 커버 | GAP-ANALYSIS-4 |
| 오목 | imjacobclark/BoardGameEngine | 2인, 완전정보, 승/패 전용(scoreMargin:none), 시드-강제 오프닝 | GAP-ANALYSIS-4 |
| 장기 | davisethan/janggi | 2인, 완전정보, 승/패 전용, 시드-강제 마상 배치 | 6개 게임 병렬 온보딩 세션 |
| 도미니언 | rspeer/dominiate | 2인, 부분 은닉(hiddenInfoProbe), 킹덤 카드 12종 부분집합 | 〃 |
| 윙스팬(core) | keithgw/wingspan | 2인, 부분 은닉, 원본 자체가 실제 윙스팬 규칙의 극단 단순화판(서식지·트리거 없음) — 소스를 있는 그대로 온보딩 | 〃 |
| 하스스톤(mirror) | danielyule/hearthbreaker | 2인, 은닉정보(hiddenInfoProbe), 미러 매치·중립카드 12장 한정 | 〃 |

**채점 기준 강화(2026-07-21, FIX-BACKLOG S1)**: `ReplayFixture.provenance`
필드로 원본 게임 리플레이(`'original-replay'`)와 어댑터 self-play 재현성
증거(`'self-play'`, 미선언 시 기본값)를 구분한다. 원본 리플레이가 하나도 없으면
C7-parity 점수가 통과율과 무관하게 **60점으로 캡**된다(기본 threshold는 80으로
상향). 지금 7개 게임 전부 self-play fixture만 있어 C7=60, `ready:false`다 —
게임 로직 자체(C0~C6)는 전부 100점이지만 "원본 게임과 진짜로 일치한다"는 증거는
아직 없다는 뜻이다. 각 러너는 이 사실을 감추지 않고 로그/리포트에 경고로 남기되,
C7만 캡된 경우 웨이브 실행은 계속 진행한다(`src/onboarding/wave-readiness.ts`).

## 10. 탐색·학습 후보 계층 (v1.5~1.13, 2026-07-23~26)

②③④ 순수 계층 옆에 `search/`·`learn/` 계층을 추가했다(ADR-0002). 이들은
OpenSpiel(DeepMind) 알고리즘의 충실 이식(ADR-0001)이며, 산출물은 전부
`BotFactory`라 `loop`/`onboarding`은 이들의 존재를 모른다.

| 모듈 | 내용 |
|---|---|
| `search/mcts.ts` | UCT MCTS. `rolloutPolicy`('random'\|'heuristic')·`rolloutFactory`(임의 BotFactory)·`tacticalDepth`(즉승/즉방어 프리체크)·`rootOverride`(게임별 우선순위 판정 훅, ADR-0008) 옵션 |
| `search/ismcts.ts` | SO-ISMCTS(Cowling 2012). 은닉 정보 게임용, `sampleStateFromObservation`(결정화) 위에서 동작 |
| `learn/mccfr.ts` | outcome-sampling MCCFR. 학습 산출물(정책 테이블)을 봇으로 재생 |
| `kernel/search-blueprint.ts` | `deriveSearchBlueprint` — 위 모듈 중 무엇을, 어떤 예산·롤아웃으로 1차 시도할지 classification+capabilities+실측 기반 자동 추천(ADR-0005). 순수 데이터, search/learn 미참조 |
| `reference/runners/shared/search-candidate.ts` | 추천 데이터 → 실제 `MctsConfig`/`IsmctsConfig`로 번역하는 앱 경계 헬퍼 |

계약에는 이를 위한 옵션 필드 3개가 추가됐다(`contract/types.ts`, 전부 하위호환):
`GameSpec.utility?`(zero-sum/general, MCCFR 적격성 판단), `informationStateKey?`
(CFR 정보집합 키, 미선언 시 관찰 기반 폴백 — perfect recall 미보장),
`reconstructState?`(완전정보 게임의 MCTS 시뮬레이션 루트 복원). 은닉 정보 게임은
대신 `sampleStateFromObservation?`(결정화 — "아는 것은 보존, 모르는 것만 모순 없이
재샘플링")을 선언한다.

탐색/학습 봇도 다단 게이트(§5)에 특례 없이 통과해야 채택된다 — 이게 `loop`가
후보의 출처를 몰라도 되게 설계한 §1의 계층 원칙이 그대로 지켜지는 지점이다.

## 11. 확장성·일반화 라운드 (v1.14~1.22, 2026-07-27~28)

기존 6개 게임(스플랜더·오목·장기·도미니언·윙스팬·하스스톤)은 전부 "턴제·적대적
2~4인" 계열이었다. 시스템이 낯선 카테고리에도 자동으로 대응하는지 검증하기 위해
2개 게임을 추가 온보딩했다:

| 게임 | 원본 소스 | 특성 | 실증한 것 |
|---|---|---|---|
| 아발론 | AlexLomm/avalon-engine | 5인, 숨은 진영(멀린·하수인·암살자), 승/패 전용 | `hiddenTeamStructure`(ADR-0006) — C5 축의 identityCenter 자기모순 해소 |
| 카탄(core) | rpjohnst/catan | 4인 FFA, 부분 은닉, 대인원 킹메이킹 | `fieldMix`(ADR-0007) — 혼합 상대 구성 웨이브 |

두 온보딩 다 신규 카테고리를 코드 레벨로 사전 진단(`docs/GAP-ANALYSIS-10.md`,
M1~M4)한 뒤 실제 게임으로 실증하는 순서를 따랐다 — 이 순서(사전 진단 → 게임
중립 수정 → 실전 온보딩으로 실증) 자체가 다음 신규 카테고리(협동 게임 M2, 실시간
게임 M3)에도 재사용 가능한 절차다.

최종 9게임 registry 상태와 각 게임의 탐색 후보 실험 결과는
[`docs/HANDOFF-2026-07-28.md`](docs/HANDOFF-2026-07-28.md) §2·§4 참고 — 특히
오목의 C열(챗봇 AI 대비 맞대결) 5개 카드 전부 실패 사례는 이 프로젝트가 "성공만
보여주지 않는다"는 원칙(ADR-0009)의 가장 상세한 실증이다.
