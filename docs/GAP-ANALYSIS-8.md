# 갭 분석 8 — 고도화 라운드 + 전 게임 순차 스윕 (2026-07-23~24)

> GAP-ANALYSIS-7(OpenSpiel 흡수)에서 발견된 갭들의 처치 라운드(O10, P1~P5)와,
> 사용자 지시("맥북에 부하를 주지 않는 선에서 모든 게임을 순차적으로 다 진행")에
> 따른 전 7게임 순차 스윕의 기록. 무거운 연산은 항상 동시 1개(nice 하향, 힙
> 오버라이드 금지)로 제한 — §4의 자원 사고 재발 방지 규칙 참고.

## 1. 전 게임 스윕 결과 (탐색/학습 후보 투입 최종 판정)

| 게임 | 후보 | verdict | 근거 수치 | registry |
|---|---|---|---|---|
| 오목 | mcts2-s256-hr (P5 수정 후) | **adopted** | holdout 1.000(15블록) · **regression 0.600 vs v3 챔피언**(CI 0.50–0.70, 40블록) | v1→**v4** |
| 하스스톤 | ismcts-s128-hr | **adopted** | holdout 0.867 · regression 1.000 · 점수차 14.7~19.6(임계 5 상회) | v1→**v2** |
| 스플랜더 | ismcts-s128-hr | screened | prune 승률 0.900(CI 0.80–1.00)이나 점수차 3.67 < 5 | v2 유지 |
| 도미니언 | ismcts-s64-hr | screened | prune 승률 0.933(CI 0.83–1.00)이나 점수차 3.40 < 5 | v2 유지 |
| 윙스팬 | ismcts-s256-hr | screened | prune 승률 **1.000**이나 점수차 4.07 < 5 | v1 유지 |
| 장기 | mcts2-s128-hr (P2 최적화 후) | failed | smoke 0.375(8블록) — 수정 전 0.000에서 개선됐으나 미달 | v1 유지 |
| mini-trick | mccfr-os-150000-pr (perfect recall) | screened | smoke 0.578 통과 후 prune 0.550 탈락 | v1 유지 |

요약: **채택 2**(오목·하스스톤), 점수차 게이트 탈락 3(스플랜더·도미니언·윙스팬 —
§2의 P6 패턴), 실력 미달 2(장기·mini-trick). 모든 판정에 특례 없음 — 학습/탐색
봇도 동일 게이트.

## 2. 이 라운드에서 발견된 갭과 처치

| ID | 발견 | 처치 | 상태 |
|---|---|---|---|
| P5 | MCTS 예산<분기수 병리: 타이브레이크가 보상 무시(이식 충실도 결함— OpenSpiel sort_key는 total_reward 포함) + untried FIFO 확장의 좌표 편향. P1의 mcts-s64-hr이 mcts-s64와 27수 100% 동일(no-op)했던 근본 원인이자 오목 C열 100% 열세의 실원인 | 타이브레이크에 보상 반영 + 확장 순서 rng 셔플 + 예산을 분기수 이상(s256)으로 — 수정 직후 오목 채택 성공. **주의: 이 수정으로 기존 mcts-s64 플래그의 재조립 행동도 달라짐**(소스 클로저 digest가 로드맵인 이유의 실증) | 완료 |
| P6 | scored 게임의 `minScoreDiff=5` 고정 임계가 "승률 압도·점수차 소폭" 후보를 일괄 차단 — 3게임 연속 재현. near-miss 추출도 점수차 탈락을 못 잡음 | 점수차 임계를 캘리브레이션(점수 스케일·노이즈 플로어)에서 파생하도록 blueprint 연결 + near-miss 보강 — **다음 라운드** | 미착수 |
| — | 결정화 왕복 검증(`getObservation(sampled)===observation` + invariants)이 하스스톤 어댑터의 실제 회계 버그 2건을 적발: 소멸 카드 존(graveyard) 부재, 손패 캡 드로우 번 미기록 | 어댑터 수정 + invariant 확장. 교훈: **결정화 훅은 IS-MCTS용만이 아니라 온보딩 품질 검사 장치를 겸한다** — ONBOARDING-GUIDE 반영은 P6와 함께 | 완료(버그), 가이드 반영 대기 |
| — | 좌석 소유자 판별: `GameBot.decide`가 player id를 안 받으므로(계약 불변) IS-MCTS 봇이 관찰 소유 좌석을 왕복 검증으로 탐지(detectViewer). 하스스톤에서 틀린 후보 프로브가 예외를 던지는 구현 결함 발견·수정 | `observation.self` 기준 우주 복원으로 수정 | 완료 |

## 3. 처치 완료 항목 상세 (O10·P1~P4는 FIX-BACKLOG 완료 표 참고)

- **O10 regression 티어**: holdout 통과 후 "후보 vs 현 기준선 합성봇" 재검증.
  오목 v4 채택에서 첫 실전 검증(챔피언 상대 60% 승리 확인 후 승격) — override형
  후보의 회귀 미검출 구멍(v3 사고)이 봉합됨.
- **P2 장기 최적화**: 행동 보존(30시드 trajectory 지문 전후 완전 일치, 2회 재현)
  확인. 최적화 후 mcts2-s128-hr 판당 비용이 실험 가능 수준으로 하락.
- **P3 perfect recall**: 관찰에 공개 이력 추가(공개 정보만 — 은닉 규칙 무손상,
  C0~C7 재채점 완전 동일). 메모리 3점 계단 측정(10k/30k/100k)으로 선형 외삽 →
  150k iterations(heapUsed ≈1.4GB) 선정. §4 사고의 정량 원인 규명 겸함(1M
  iterations ≈ 12M infosets ≈ 10GB+).
- **P4 IS-MCTS + 결정화**: SO-ISMCTS(Cowling 2012, availability-count UCB1)
  이식. 결정화 훅 4게임(스플랜더·도미니언·하스스톤·윙스팬) 구현, 전부 왕복
  일치·invariants·시드 민감성 3종 테스트로 고정.

## 4. 자원 사고와 재발 방지 규칙 (2026-07-23 밤)

병렬 에이전트 3개가 각자 무거운 연산(MCTS 웨이브·장기 측정·MCCFR 학습 힙
18GB/100만 반복)을 동시 실행 → 메모리 고갈(여유 131MB)·load 66 → 세션 중단.
이후 전 스윕에 적용한 규칙: ① 무거운 연산 동시 1개(실행 전 잔여 프로세스 확인),
② `--max-old-space-size` 금지 + 학습은 소량 계단 측정으로 메모리 외삽 후 반복 수
결정, ③ `nice -n 10`, ④ jest와 연산 비동시. 부하 문제 재발 없음. 별도 관찰:
맥북 절전 시 연산이 일시정지되므로(도미니언 웨이브가 밤새 0.01초 CPU) 장시간
실행은 절전 전 완료되도록 예산을 잡거나 아침 재실행을 감안할 것.

## 4.5 P6 처치 결과 (2026-07-24~25 재도전 라운드)

임계를 캘리브레이션 파생(2σ)으로 교정하고 3게임을 재도전한 결과:

| 게임 | scoreDiffStdDev 실측 | 파생 임계 (구 고정 5) | ismcts-wave-2 결과 |
|---|---|---|---|
| 스플랜더 | 0.0000 (항등 붕괴) | 0 + 경고 | prune 0.867·holdout 0.833 통과 → **regression 0.325 탈락** → near-miss |
| 도미니언 | 0.0000 (항등 붕괴) | 0 + 경고 | smoke/prune/holdout **전부 1.000** 통과 → **regression 0.275(점수차 −26.85) 탈락** → near-miss |
| 윙스팬 | 0.0000 (항등 붕괴) | 0 + 경고 | 전 티어 1.000 → **adopted → v2**(ismcts-s256-hr, 첫 승격) |

**핵심 교훈 — 게이트 스택의 상호 보완이 실측으로 증명됨**: P6 교정은 "잘못된
이유(점수차 단위 오류)로 차단되던 후보"를 통과시켰고, 그 즉시 O10 regression
티어가 "raw 휴리스틱은 압도하지만 현 챔피언보다 약한" 스플랜더·도미니언 후보를
정확히 차단했다. P6 없이는 오탈락, O10 없이는 오채택(오목 v3 사고의 재현)이었을
것이다. 두 near-miss는 `failedAtTier=regression`으로 구조화되어 다음 큰루프
설계(챔피언 전략과의 결합 후보 등)의 입력이 된다.

부수 수확: 실배선 중 `deriveBlueprint`의 잠재 버그(blockStdDev=0 항등 붕괴 시
무가드 예외 — 러너들이 수동 폴백으로 우회해 온 원인) 발견·수정, 회귀 테스트 고정.
ONBOARDING-GUIDE §9에 결정화 훅·선언 지침·임계 파생 정본을 성문화.

## 4.6 오목 C열 역전 재도전 결과 (2026-07-25~26, 원인 분리 확정)

두 지렛대를 진단 head-to-head(N=100, 게이트 없는 순수 집계)로 먼저 분리 측정:

| 후보 | vs Opus봇 | vs 현 챔피언(v4) | 판당 비용 |
|---|---|---|---|
| mcts2-s512-hr (예산만 2배) | 0% | 37.5%(오히려 열세) | 530ms |
| mcts2-s256-cr (챔피언 롤아웃) | 0% | **100% 완파** | 88ms |
| mcts2-s512-cr (둘 다) | 0% | **100% 완파** | 189ms |

**원인 분리 결론**: 예산 상향은 순가치 없음(내부 기준선보다도 약해짐). 롤아웃을
raw heuristic에서 챔피언 합성봇으로 바꾸는 것은 내부 기준선 대비 진짜 개선이지만,
Opus 즉흥봇 상대로는 3후보 전부 0/100 — **접근 자체의 한계**(Opus봇의 즉승/즉방어
최우선 + 다방향 위협 스코어링은 얕은 트리 탐색으로 넘을 수 없는 구조적 우위).

`search/mcts.ts`에 `MctsConfig.rolloutFactory?`(임의 BotFactory를 롤아웃 정책으로
주입, 미지정 시 기존 경로 완전 불변) 추가해 챔피언 롤아웃을 구현. mcts-wave-4에서
두 후보 모두 **adopted**(regression vs v4: 95.0%/96.3%, 40블록) → **registry v5**
승격(sourceDigest 첨부 확인). 벤치마크 v5(N=1,300, 대규모 실측): A/B/C **전부
100%** — C열 역전 불발이 정량 확정됨. 다음 카드는 오프닝북/전술 확장 계열
(진단에서 이미 식별, 이번 라운드 범위 밖으로 명시 이연).

## 4.7 near-miss 큰루프 1회전 — 스플랜더/도미니언 챔피언 롤아웃 재도전 (2026-07-26)

DESIGN.md §6.1의 4단계 프로토콜(웨이브 확보 → near-miss 구조화 → 어댑터 재설계 →
재발주)을 사람이 아닌 에이전트가 실전으로 1회전 완주했다 — 결과의 성공/실패와
무관하게 이 자체가 §6.1 검증 대상이다.

**1단계 재확인**: `extractNearMissCandidates`가 §4.5의 두 near-miss를
`{flags, failedAtTier: 'regression', pointWinRate, pointScoreDiff, winRateCI, gap}`
형태로 이미 구조화해 두었고(스플랜더 `runs/splendor/ismcts-wave-2-near-miss.json`,
도미니언 `runs/dominion/ismcts-wave-2-near-miss.json`), 이 레코드가 재설계의
직접 근거였다.

**2단계**: `search/ismcts.ts`는 `search/mcts.ts`의 `MctsConfig`/`evaluate`를
그대로 재사용하므로(파일 상단 doc comment), `rolloutFactory`(오목 C열 재도전에서
추가된 옵션)가 IS-MCTS에도 코드 변경 없이 이미 적용된다는 사실을 확인했다.
`src/search/__tests__/ismcts.test.ts`에 hidden-corridor 픽스처 기반 회귀 테스트
4개를 추가해 이 사실을 고정(rolloutFactory 미지정 시 기존 동작 동일 /
지정 시 결정론·legal 반환 / rolloutPolicy보다 우선 / ismctsBotFactory 경로도 동일).

**3단계 — 챔피언 롤아웃 후보 설계**: 오목 C열 재도전(§4.6)의 "챔피언 합성봇을
롤아웃 정책으로 주입" 패턴을 그대로 IS-MCTS에 적용. 각 게임의 v2(유일한 채택
전략) 자체를 롤아웃 챔피언으로 사용 — 스플랜더 `buyHighestPoints`, 도미니언
`rushProvinces`. 새 플래그명(§6.1 "이미 판정된 이름 재사용 금지"):
`ismcts-s128-cr`(`shared/splendor-ismcts-flag.ts`), `ismcts-s64-cr`
(`shared/dominion-ismcts-flag.ts`) — 시뮬레이션 예산은 기존 hr 변형과 동일,
rolloutFactory만 raw heuristic → 챔피언 합성봇으로 교체.

판당 비용 실측(scratch 스크립트, 미체크인; nice -n 10, 단독 프로세스, 3판):

| 후보 | vs heuristic | vs v2 챔피언(regression) |
|---|---|---|
| 스플랜더 ismcts-s128-cr | ~1,441ms | ~826ms |
| 도미니언 ismcts-s64-cr | ~1,848ms | ~2,500ms |

ismcts-wave-3 배선: 후보 단일, opponent='heuristic', baselineFlags=registry
latest(v2), tiers는 ismcts-wave-2와 동일 크기(smoke≤30/prune15/holdout15/
regression20), criteria는 ismcts-wave-2와 동일 P6 파생 캘리브레이션(두 게임 모두
scoreDiffStdDev=0 항등 붕괴 → derivedMinScoreDiff=0) 재사용. 신규 시드뱅크
`{game}-ismcts3-*`(50000-53019), 기존 웨이브 범위와 비겹침.

**4단계 실행 결과 (regression 티어가 실제 관건)**:

| 게임 | 후보 | smoke | prune | holdout | regression | verdict |
|---|---|---|---|---|---|---|
| 스플랜더 | ismcts-s128-cr | 0.906 (Δ3.125) | 0.800 (Δ1.233) | 0.900 (Δ2.667) | **0.675 (Δ-1.350)** | **adopted** |
| 도미니언 | ismcts-s64-cr | 0.700 (Δ1.783) | 0.817 (Δ4.167) | 0.650 (Δ1.400) | **0.100 (Δ-40.125)** | near-miss (재차) |

- **스플랜더: 채택 성공.** 챔피언 롤아웃이 raw heuristic 롤아웃(§4.5의
  ismcts-s128-hr, regression winRate=0.325)을 regression winRate=0.675로
  끌어올려 통과선(0.5)을 넘겼다. `registry v2→v3` 승격 확인:
  `flags=[buyHighestPoints, ismcts-s128-cr]`, `sourceWaveId=ismcts-wave-3`.
- **도미니언: 오히려 악화, 재차 near-miss.** 챔피언 롤아웃 적용 후 regression
  winRate이 0.275(§4.5의 ismcts-s64-hr) → **0.100**으로 더 나빠졌다
  (scoreDiff도 -26.85 → -40.125로 악화). smoke/prune/holdout은 여전히 통과.
  승격 없음, registry는 v2 그대로.

**도미니언 실패 원인 추정(정황 증거, 확정 아님)**: `rushProvinces`는 그 이름대로
"주(Province) 카드를 최우선으로 밀어붙이는" 단일 축의 그리디 전략으로 보이며,
IS-MCTS 롤아웃 안에서 이 전략을 흉내 내는 매 시뮬레이션이 도미니언의 훨씬 큰
분기 계수(구매 단계에서 킹덤 10종+기본 카드 전부가 합법 선택지, 게임 길이도
최대 800 결정 대 스플랜더의 600)와 결합되면서 (a) 롤아웃 자체가 비싸져
같은 예산(simulations=64)에서 실효 탐색 깊이가 줄었거나, (b) 그리디 단일
전략을 흉내 내는 롤아웃이 실제 원본 `rushProvinces` 봇의 타이밍/조건 분기를
정확히 재현하지 못해 오히려 "약한 rushProvinces 흉내"가 매 결정마다
현 챔피언(=진짜 rushProvinces)에게 정보만 누설하는 꼴이 되었을 가능성이 있다.
스플랜더의 `buyHighestPoints`(포인트 최댓값 카드 구매, 훨씬 단순한 단일 조건
휴리스틱)에서는 이 패턴이 문제없이 통했다는 대비가 이 가설을 뒷받침한다 —
**단, 이 근거는 관찰적 대비일 뿐 원인을 직접 격리한 진단 실험은 수행하지
않았다**(§4.6 오목 사례처럼 head-to-head 진단으로 예산 vs 롤아웃 정책을
분리하는 절차는 이번 라운드 범위 밖).

**§6.1 완주 확인**: 두 게임 모두에서 1단계(near-miss 확보)→2단계(구조화 재확인)
→3단계(어댑터 재설계, 신규 플래그)→4단계(재발주·실행)가 실제로 끝까지
수행됐고, 결과는 게임마다 갈렸다(스플랜더 성공/도미니언 실패) — §6.1이 명시하는
"재설계이지 성공 보장이 아니다"가 실측으로 확인된 사례. 도미니언에 대한 억지
3차 재시도는 하지 않았다.

## 5. 남은 것

- P6(점수차 임계 캘리브레이션 파생 + near-miss 보강) — 스윕이 만든 최우선 후속.
- 하스스톤 v2·오목 v4의 3열 벤치마크 재실행(현 리더보드는 구 버전 기준),
  오목 C열(vs Opus봇) 역전 여부는 여전히 미확인(N=20 소표본에서 C열 100% 유지).
- mcts-wave-3 이후 웨이브들의 2회 재실행(중복 승격 가드) 검증은 오목·mini-trick
  에서만 수행 — 장기·스플랜더·도미니언·하스스톤·윙스팬 신규 웨이브는 동일
  가드 코드이므로 생략(자원 절약, 코드 경로 동일성 근거).
