# Loop Forge — 설계도

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
- **큰 루프 프로토콜**: v1에서는 WaveReport의 실패 패턴 요약이 다음 후보 설계의 입력
  포맷으로 규격화된다(사람 또는 에이전트가 설계). 후보 자동 생성은 v2+.

## 7. 오픈소스 체리픽 명세

| 출처 | 가져온 것 | 반영 위치 |
|---|---|---|
| OpenSpiel (DeepMind) | `Game/State` API의 형태: legal_actions → apply_action → returns 사이클, 은닉 정보 게임 지원 구조 | `contract/types.ts` |
| PettingZoo | AEC(Agent-Environment-Cycle)식 "지금 누구 차례" 이터레이션 | `currentDecision()` |
| Gymnasium `check_env` / PettingZoo `api_test` | 환경 구현 자동 검사 배터리라는 발상 — 단 이진 통과가 아닌 **세분화 점수 + 수정 지침**으로 확장 | `onboarding/score.ts` |
| Fishtest / OpenBench | SPRT 순차 검정, "패치 후보 → 대량 대국 → 통계 게이트" 운영 모델, 분산 워커(v2 로드맵) | `kernel/sprt.ts`, 게이트 설계 |
| 티추 NPC 하네스 (선행 프로젝트) | 시드 원장 · 페어드 부트스트랩 · 다단 게이트 · 캘리브레이션 · 행동 지문 스크리닝 · digest 봉인 · parity 요구 — 그리고 이 전부의 **실사고 근거** | `kernel/*`, `onboarding/*` 전반 |
| Optuna/Ax | (개념만) 탐색-활용 균형의 후보 예산 배분 — v2 큰 루프 자동화에서 참고 | ROADMAP |

라이선스: 코드 복사 없음. 전부 아이디어 수준 체리픽 + 자체 구현.

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
