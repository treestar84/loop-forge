# 수정 백로그 — 지금 고쳐야 할 것 (누적 관리)

> GAP-ANALYSIS 문서는 "라운드별 발견 기록"이고, 이 문서는 그중 **실제 코드/가이드
> 수정이 필요한 항목만 뽑아 상태를 추적**하는 누적 백로그다. 새 갭 분석 라운드가
> 끝나면 여기에 항목을 추가하고, 처치가 끝나면 상태만 바꾼다(줄을 지우지 않는다 —
> 이력 보존). ID는 출처 GAP-ANALYSIS 문서의 ID를 그대로 쓴다.

## 미착수

| ID | 항목 | 출처 |
|---|---|---|
| P7 | 오목 C열(vs Opus봇) 역전 — 예산 상향·챔피언 롤아웃 둘 다 시도했으나 원인 분리 결과 "접근 자체의 한계"(N=1,300 실측으로 확정, GAP-ANALYSIS-8 §4.6). 다음 카드: 오프닝북/전술 확장(즉승·즉방어 최우선 순서를 트리 탐색 앞단에 명시적으로 배선) | GAP-ANALYSIS-8 §4.6 |

registry 버전 표현 일반화(`kind: flags\|policy-table\|search-config`)는
GAP-ANALYSIS-7 §2 이연 목록.

## 완료 — near-miss 큰루프 1회전 (2026-07-26, `docs/GAP-ANALYSIS-8.md` §4.7)

| 처치 내용 | 증거 |
|---|---|
| DESIGN §6.1 프로토콜 실전 1회전: near-miss 구조화 레코드를 근거로 "챔피언 합성봇을 IS-MCTS 롤아웃 정책으로 주입"하는 새 후보(`ismcts-s128-cr`/`ismcts-s64-cr`, §6.1 새-이름 규칙) 설계·재발주 | 스플랜더: regression 0.325→**0.675**로 통과, **adopted→v3**. 도미니언: regression 0.275→**0.100**으로 오히려 악화, 재차 near-miss(억지 3차 재시도 없음 — 프로토콜은 성공 보장이 아님을 그대로 준수) |
| `search/ismcts.ts`가 `mcts.ts`의 `MctsConfig`를 재사용해 `rolloutFactory`가 코드 변경 없이 IS-MCTS에도 적용됨을 확인·고정 | 회귀 테스트 4건(hidden-corridor 픽스처) |

**최종 결합 검증** (2026-07-26, 4개 후속 작업 — 벤치마크 재측정·소스 digest·오목
C열·near-miss 큰루프 — 전부 완료): tsc 0에러, **38 suites / 466 tests 전부
통과**. 스플랜더 registry `['v1','v2','v3']`, 도미니언 `['v1','v2']`(near-miss
정직 유지) — 채택 여부와 정확히 일치.

## 완료 — 오목 C열 역전 시도 (2026-07-25~26, `docs/GAP-ANALYSIS-8.md` §4.6)

| 처치 내용 | 증거 |
|---|---|
| `MctsConfig.rolloutFactory?` 추가(임의 BotFactory 주입, 기존 경로 불변) + 챔피언 롤아웃 후보 2종 → mcts-wave-4에서 둘 다 adopted(regression vs v4 95.0%/96.3%) → **registry v5** | 진단 head-to-head로 예산 상향은 무가치·롤아웃 개선은 내부 기준선엔 유효·Opus엔 무효임을 사전 분리, 벤치마크 v5(N=1,300) A/B/C 전부 100%로 역전 불발 확정 |

## 완료 — P6 (2026-07-24~25, `docs/GAP-ANALYSIS-8.md` §4.5)

| ID | 처치 내용 | 증거 |
|---|---|---|
| P6 | ① `measureNoiseFloor().scoreDiffStdDev` 신설 → `deriveBlueprint().recommendedMinScoreDiff`(win-loss-only→0 / scored+실측→2σ / 항등 붕괴→0+경고 / 미보정→폴백 5) → `assembleWaveConfig` 기본 배선. ② `finalVerdict`: smoke 통과 후 점수차-단독-탈락은 screened보다 near-miss 우선. ③ 3게임 재도전(ismcts-wave-2, 새 뱅크): 스플랜더·도미니언은 holdout까지 통과 후 **regression에서 챔피언 열세(0.325/0.275)로 near-miss** — P6(오탈락 제거)와 O10(오채택 차단)의 상호 보완이 실측 증명. **윙스팬 ismcts-s256-hr 전 티어 1.000으로 adopted → v2**. ④ 부수: deriveBlueprint의 blockStdDev=0 무가드 예외(잠재 버그) 수정, ONBOARDING-GUIDE §9 성문화 | 신규 테스트 11건 포함 37 suites/450 tests 통과, 3게임 scoreDiffStdDev 전부 0.0000 실측(항등 붕괴), `runs/{splendor,dominion,wingspan}/ismcts-wave-2/`, wingspan registry `['v1','v2']` |

## 완료 — 고도화 라운드 + 전 게임 스윕 (2026-07-23~24, `docs/GAP-ANALYSIS-8.md`)

| ID | 처치 내용 | 증거 |
|---|---|---|
| O10 | regression 티어(kernel/gates TierId + wave-runner tiers.regression, 상대=현 기준선 합성봇, 실패 시 near-miss 강등, 미설정 시 기존 동작·digest 불변) | 신규 테스트 9건(override 회귀 검출·동급 통과·digest 고정), 오목 v4 채택에서 첫 실전 검증(regression 0.600 확인 후 승격) |
| P1 | `rolloutPolicy: 'random'\|'heuristic'` 옵션(기본 random, 기존 동작 불변). mcts-s64-hr 자체는 screen no-op → P5 발견의 계기 | mcts-wave-2 실행 기록, 27수 100% 동일 프로브 — 근본 원인은 P5로 이관·해결 |
| P2 | 장기 이동생성·장군판정 최적화(+267/-34), 행동 보존 강제 | 30시드 trajectory 지문 전후 완전 일치(2회 재현), 커밋 28476bc |
| P3 | mini-trick perfect recall + 메모리 계단 측정(150k iters, heapUsed≈1.4GB) + mccfr-wave-2 | scoreAdapter 재채점 완전 동일, mccfr-os-150000-pr screened(prune 0.550), registry v1 유지 |
| P4 | `sampleStateFromObservation` 훅 + `search/ismcts.ts`(SO-ISMCTS, availability-count UCB1) + 결정화 4게임(스플랜더·도미니언·하스스톤·윙스팬) 구현·검증 | 게임별 왕복·invariants·시드 민감성 3종 테스트, 하스스톤 회계 버그 2건 적발·수정(graveyard 존, 드로우 번) |
| P5 | mcts.ts 타이브레이크에 보상 반영 + 확장 순서 rng 셔플(이식 충실도 회복). 기존 mcts-s64 재조립 행동 변화는 주석·문서에 명시 | 수정 직후 오목 mcts2-s256-hr adopted(v4) — no-op 병리 해소 실증 |
| 스윕 | 전 7게임 순차 실행(무거운 연산 동시 1개·nice·힙 오버라이드 금지): 채택 2(오목 v4, 하스스톤 v2) / 점수차 탈락 3(P6) / 실력 미달 2(장기 0.375, mini-trick 0.550) | GAP-ANALYSIS-8 §1 표, 전 게임 registry가 verdict와 정확히 일치함을 메인 세션에서 직접 확인 |

이연 항목(IS-MCTS+결정화·레지스트리 버전 표현 일반화·정확 exploitability·
vanilla CFR·동시수·O8 sampled exploitability)은 `docs/GAP-ANALYSIS-7.md` §2에
사유와 함께 기록.

## 처치 순서 권고

P6이 다음 라운드 최우선 — 은닉 게임 3종(스플랜더·도미니언·윙스팬)에서 승률
압도 후보가 전부 점수차 고정 임계에 막혀 있어, 임계 캘리브레이션 없이는 이
게임들에서 채택이 구조적으로 불가능하다. 이후 후보: 하스스톤 v2·오목 v4의
3열 벤치마크 재실행(리더보드 갱신), 오목 C열(vs Opus) 역전 재도전.

## 완료 — OpenSpiel 흡수 라운드 (2026-07-23, `docs/GAP-ANALYSIS-7.md`)

| ID | 처치 내용 | 증거 |
|---|---|---|
| O1 | `GameSpec.utility?` + `informationStateKey?`/`reconstructState?` 옵션 추가(하위호환) | 34 suites/390 tests 통과 시점 편입, 기존 API 무손상 |
| O2 | `classifyGame`에 `utilityStructure`/`utilityDeclared`(추론 없음) | classify 테스트 3케이스 추가 |
| O3 | C2 전이 순수성 검사(api_test 흡수, 첫 플레이아웃 10결정 한정) — `C2_APPLYCHOICE_MUTATED_INPUT` blocker | 변조 픽스처로 검출 + mini-trick 무손상 회귀 테스트 |
| O4 | `withStrategyFlags`(compose.ts) — 러너의 후보 주입 통로, 이름 중복 throw | 단위 테스트 4건 |
| O5 | `src/search/mcts.ts` UCT MCTS 충실 이식(Apache-2.0 파생 표기), `search: [contract, kernel]` 계층 등록 | 결정론·전술픽스처·에러 테스트 통과 |
| O6 | 오목 `mcts-s64` **adopted**(holdout 1.000/15블록, v3 승격) · 장기 `mcts-s16` failed(smoke 0.000 — 처리량 제약 실측) · 스플랜더 제외(덱 순서 은닉) · 2회 실행 중복 승격 없음 | `runs/{gomoku,janggi}/mcts-wave-1/`, 처리량 실측표(오목 s64 321ms/판, 장기 s16 17.8s/판) |
| O7 | `src/learn/mccfr.ts` outcome-sampling MCCFR 이식 + PolicyTable(digest 봉인) + mini-trick 러너. mccfr-os-200000은 prune 탈락 **screened**(특례 없음) | 학습 9.5초/1,254,298 infosets, `runs/mini-trick/policy-*.json`, 테스트 4건 |
| O8 | 스킵 — sampled BR 구현이 반나절 기준 초과 판단, GAP-ANALYSIS-7 §2 이연 목록에 사유 기록 | — |
| O9 | DESIGN §1 import 지도(search/learn)·§7 라이선스 정책 개정, CREDITS.md 파생 절, GAP-ANALYSIS-7, 리더보드 "결과 2" | 메인 세션 직접 작성 |
| 3열 v3 | 오목 벤치마크 재실행(N=2,000, 1594.5초): A 100% / B 87.5%(CI 86.3–88.7) / C 100%(Opus) — O10 갭과 holdout 소표본 과대추정 실측 | `runs/gomoku/benchmark-3col-v3.{json,md}` |

**최종 결합 검증 4회차** (2026-07-23, O1~O9 반영): tsc 0에러, **36 suites /
401 tests 전부 통과**. 오목 registry `['v1','v2','v3']`(v3=+mcts-s64), 장기
`['v1']`(2회 실행 무손상), mini-trick `['v1']` — 채택 여부와 정확히 일치.

## 완료

| ID | 처치 내용 | 증거 |
|---|---|---|
| Z1 | `score.ts` C2 스팟체크를 pool-index 재구성 대신 수집 시점 `sourceGameSeed`/`depth` 원본 보관 방식으로 교체 | 오목 C2: 0(blocker) → 100. 회귀 테스트(`score.test.ts`)로 고정. 24 suites/251 tests 통과 |
| Z2 | `calibrateIdentity`/`measureNoiseFloor`가 게임 시드마다 `rng.fork(String(seed))`로 독립 봇 시드를 파생하도록 수정(외부 시그니처 불변) | 스플랜더 identity meanWinRate: botSeedBase 6종에서 0.325~0.7525 요동 → 0.46~0.51로 안정 수렴. 신규 회귀 테스트(`long-accumulate-game.ts` 픽스처)로 고정 |
| W1 | `GameSpec.scoreMargin?: 'none'\|'scored'` 옵션 필드 추가 | 하위호환 확인(기존 22스위트 무손상) |
| W2 | `classifyGame(spec, contentInventory?)` 신설 — `src/kernel/classify.ts` | mini-trick/splendor/오목(scoreMargin 가정) 3개 픽스처로 분류 결과 검증 |
| W3 | `deriveBlueprint(classification, calibration?)` 신설, `recommendBlockCount` 연결(X3 완전 배선) — `src/kernel/blueprint.ts` | 단위테스트로 blockStdDev 입력 시 표본 크기 반영 확인 |
| W4 | `scoreAdapter`가 블루프린트를 기본값으로 사용(옵션 최우선 override) + Z8 수정(688번 줄 `0.5`→`identityCenter`) | mini-trick/스플랜더/오목 재채점 회귀 없음, 24 suites/254 tests 통과 |
| Z8 | `scoreC5`의 head-to-head 유의성 검정을 하드코딩된 `0.5` 대신 `identityCenter`와 비교하도록 수정(W4와 함께 처리) | 3인 FFA 결정론적 픽스처(승자가 항상 player 0)로 회귀 테스트 — 수정 전이었다면 0.5 vs 0.5 비교로 "차이 없음" 오탐이 났을 케이스가 정상 판정됨 |
| W8 | (W4 검증 중 발견) `blueprint.ts`의 `C5_IDENTITY_SEED_COUNT_DEFAULT`/`C5_HEAD_TO_HEAD_SEED_COUNT_DEFAULT`가 `score.ts` 원래 DEFAULTS(200/300)와 정확히 뒤바뀐 값(300/200)으로 작성돼 있던 것을 발견·수정 — `demo.ts`의 무관한 identitySeeds/ladderSeeds 값을 잘못 참조한 것으로 추정 | 메인 세션에서 직접 수정 + `blueprint.test.ts` 잘못된 값 검증도 함께 수정, mini-trick이 override 없이 통과 |
| W5 | `assembleWaveConfig` 헬퍼 신설(`src/loop/assemble-wave-config.ts`), `demo.ts`가 이를 쓰도록 리팩터 | `npm run demo` 리팩터 전후 WaveReport reportDigest(sha256) 완전 동일 확인 |
| W6 | 벤치마크/채택 이력 렌더링이 승/패전용 게임의 scoreDiff를 숨기고 identityCenter 컨텍스트를 표시 | 인자 생략 시 기존 출력과 바이트 동일(하위호환), win-loss-only 전달 시 "N/A — 승/패 전용" 라벨 확인 |
| W7 | 오목 어댑터에 `scoreMargin:'none'` 선언 + `ONBOARDING-GUIDE.md` §8 신설, `INTERPRETATION.md` §3.5 상호참조 추가 | 오목 재채점: `scoreStructure=win-loss-only`, overall=100, ready=true 유지 확인 |
| P3 | mini-trick `MiniTrickState.completedTricks`(완료 트릭 카드 이력, public) 추가 → `getObservation`/`informationStateKey`에 노출 → perfect recall 달성(같은 {hand, trickWins, tricksCompleted, trick}이라도 완료 트릭 이력이 다르면 다른 키). 메모리 안전 3점 계단 측정(10k/30k/100k iterations)으로 외삽해 heapUsed 1.5GB 이하 최대치 150,000 iterations 선정, `mccfr-os-150000-pr` 학습(15.3s, 1,797,073 infosets, `runs/mini-trick/policy-mccfr-os-150000-pr.json`) 후 `mccfr-wave-2`(regression 티어 포함, 새 시드 뱅크 4개: 30000/31000/32000/34000)로 재도전 | scoreAdapter 재채점 C0~C7 완전 동일(diff 전후 axes 점수 무변화, blocker 0개), mccfr-wave-2: screen→smoke 통과(0.578) 후 prune 탈락 **screened**(mccfr-wave-1의 0.528 screened와 나란히 비교 — 시드 문맥 상이하므로 절대 수치 직접 비교 금지, INTERPRETATION 제1규칙), 2회 실행 모두 registry `['v1']` 유지(중복 승격 없음), tsc 0에러/36 suites/415 tests 통과 |
| H1 | `score.ts`의 20개 blocker `remediation`에 게임-규칙 언어 브릿지 문장 추가, `report.ts`에 축 범례 한 줄 추가 | 전/후 예시로 확인, 기존 테스트가 `includes()` 방식이라 무손상 |
| Z3 / H5 | `src/reference/runners/` 디렉토리 신설, `dependency-rules.test.ts`가 `reference/runners/`로 시작하는 모든 경로를 app-boundary로 자동 인식(접두어 매칭) — 게임이 늘어나도 예외 목록 수동 추가 불필요 | `src/reference/runners/gomoku.ts`로 실증, 레이어·결정론 규칙 유지 확인 |
| H7 | `src/artifacts/game-state.ts` 신설 — `runs/<gameId>/registry.json`·`ledger.json` 재로드/저장 헬퍼 | 오목 러너 2회 연속 실행을 메인 세션에서 직접 재현: 1회차 anchors=2/records=1 → 2회차 anchors=2(재등록 안 함)/records=2(누적) |
| H6 | `SaveRunInput`/`loadRun`/`RunSummary`에 `gameId` 필수 필드 추가, 저장 경로를 `runs/<gameId>/<runId>/`로 변경 | 서로 다른 게임이 같은 runId를 써도 충돌 안 함을 신규 테스트로 확인. `npm run demo` 재실행해 `runs/mini-trick/*` 구조로 정상 동작 메인 세션에서 직접 재현 |
| H9 | `DESIGN.md` §6.1 신설 — 큰루프 개입 4단계(웨이브 확보→near-miss 구조화→어댑터 코드 재설계→재발주) 명시, v1엔 코드 수정 외 개입 경로가 없다는 사실을 감추지 않고 명시 | 메인 세션에서 직접 작성(설계 문서) |
| H10 | `extractNearMissCandidates(record, criteria)` 신설 — near-miss 후보를 `{flags, failedAtTier, gap}`으로 구조화, winRateGap 오름차순 정렬 | 신규 단위테스트(음수 gap 케이스 포함) 통과 |
| H8 | `src/artifacts/game-summary.ts`의 `renderGameSummaryMarkdown(rootDir, gameId, options?)` 신설 — conformance/기준선/채택이력/near-miss/벤치마크를 한 마크다운으로 통합 | 오목 실전 데이터로 실제 출력 확보(온보딩 100/ready, v1 계보, 앵커 2개, 채택 3/근접실패 0) |
| H2 | `ONBOARDING-GUIDE.md` §3에 오목 Z1 사례로 실제 "채점→원인조사→수정→재채점" 워크스루 추가, "수정 대상은 어댑터지 원본이 아니다"(H3) 명시 | 메인 세션에서 직접 작성 |
| Z4 | §2 G-Convert 체크리스트에 "멀티스텝 턴" 항목 추가 — `takenColors` 같은 턴 내부 상태 패턴 성문화 | 메인 세션에서 직접 작성 |
| Z5 | §2 hiddenInfoProbe 항목에 "부분 은닉 판단 기준" 추가 — G-Profile에 판단 근거 기록 안내 | 메인 세션에서 직접 작성 |
| Z6 | §5.5에 "대형 상태공간 게임은 채점 방법론 자체가 흔들릴 수 있다" 경고 추가 — Z1/Z2 실전 사례 인용, mini-trick 대조군 진단법 안내 | 메인 세션에서 직접 작성 |
| Z7 | §2 종국 보장 규칙 항목에 "체스류만의 문제가 아니다" 명시 — 스플랜더 데드락 사례로 자원 누적형 게임도 해당됨을 연결 | 메인 세션에서 직접 작성 |
| S1 | 온보딩 채점 기준 강화(사용자 요청, "6개 게임 전부 100/100은 너무 후하다"). ① `ReplayFixture`에 옵션 필드 `provenance?: 'original-replay'\|'self-play'` 추가(`src/contract/types.ts`), ② `scoreC7`이 provenance로 fixture를 분리해 `original-replay`가 하나도 없으면 self-play 통과율과 무관하게 **점수 60점 캡**(`score.ts`), ③ `DEFAULTS`: `threshold` 70→80, `c1DiversitySeedCount` 8→12, `c1DiversityThreshold` 0.8→0.9, `c3SampleStates` 5→10, `c6ProbeSeeds` 5→10, ④ C2 콘텐츠 커버리지 만점 하한 50%→80% | 기존 6개 어댑터(mini-trick/splendor/gomoku/janggi/dominion/wingspan/hearthstone)는 전부 `replayFixtures`에 provenance 미선언(=self-play 취급) 상태 그대로 두고 재채점: 전부 C7=60(캡), overall=60, ready=false로 하락(이전엔 6개 전부 overall=100/ready=true). `score.test.ts`의 mini-trick "is ready" 단언을 새 사실(C7=60 캡→ready=false)에 맞게 갱신. tsc 0에러, **31 suites / 359 tests 전부 통과** |

**최종 결합 검증** (2026-07-21, 메인 세션에서 직접 재현, Z1~Z8+W1~W8+H1~H10 전부
반영된 상태): `scoreAdapter(splendorAdapter)`/`scoreAdapter(gomokuAdapter)` 둘 다
overall=100, ready=true 유지. `scoreAdapter(miniTrickAdapter, {threshold:65})` →
overall=67, ready=true(회귀 없음). `npm run demo`가 `runs/mini-trick/*` 네임스페이스
구조로 끝까지 정상 실행. tsc 0에러, **27 suites / 282 tests 전부 통과**. 문서
5건(H2/Z4/Z5/Z6/Z7)은 코드 변경 없음.

| R7 | `src/loop/head-to-head.ts`의 `runHeadToHead(adapter, candidate, opponent, seeds, botSeedBase)` 신설 — 게이트 없는 순수 승률 집계(bootstrapPairedSeedBlocks 기반, Z2와 동일한 rng.fork 봇시드 파생) | 항등 대조(≈0.5)·실력차 봇(0.53 CI 하한 초과)·결정론 재현 3케이스 테스트 통과 |
| R2 | `src/onboarding/wave-readiness.ts`의 `evaluateWaveReadiness(conformance)` 신설 — C7-only 예외 정책을 6개 러너 중복 코드에서 공용 헬퍼로 승격 | 6개 러너 전부 리팩터 후 재실행 정상 동작 확인 |
| R1 | `README.md` 전면 갱신(7게임·분류기·러너·artifacts 구조 반영), `DESIGN.md` §9 "실전 온보딩 현황" 신설 + import 다이어그램에 `reference/runners/` 추가 | 메인 세션에서 직접 작성 |
| R6 | `docs/CREDITS.md` 신설 — 6개 참조 오픈소스 출처·주의사항(윙스팬 원본이 실제 룰 아님 등) 정리 | 메인 세션에서 직접 작성 |
| R5 | 6개 러너에 calibration(`measureNoiseFloor`→`recommendBlockCount`, 5~30 클램프) 배선 | 5개 게임에서 blockStdDev=0(신호 붕괴) 발견해 클램프 하한 폴백 가드 일관 적용, 장기만 실제 분산(336→30 클램프) |
| R3 | `extractNearMissCandidates` 6개 러너에 배선, `runs/<gameId>/near-miss.json` 자동 생성 | 6개 전부 빈 배열(screen 탈락은 near-miss 아님) — 정상 |
| R4 | `renderGameSummaryMarkdown` 6개 러너에 배선, `runs/<gameId>/summary.md` 자동 생성 | 6개 전부 생성 확인 |
| R8 | `docs/BENCHMARK-LEADERBOARD.md` 신설 — 게임 추가마다 행이 느는 리더보드 문서, README에 요약 표+링크 | 6개 게임 결과 전부 반영해 실증 |
| 3열 실험 | `docs/BENCHMARK-EXPERIMENT.md` 설계대로 6개 게임 전부 구현·실행 — `src/reference/experiments/<gameId>-opus-bot.ts`(Opus 즉흥 설계, 웨이브 피드백 없이 1회) + `src/reference/runners/<gameId>-benchmark.ts`(`runHeadToHead` 3회, N=2,000) | 오목·도미니언은 Opus봇이 C열에서 우세(97.1%/95.3%), 스플랜더는 루프포지가 압도(C열 Opus 승률 6.9%), 장기·윙스팬·하스스톤은 채택 0개라 B열 정확히 ~50%(항등 대조 성립). 6개 전부 `docs/BENCHMARK-LEADERBOARD.md`에 정리 |

**최종 결합 검증 2회차** (2026-07-22, 메인 세션에서 직접 재현, R1~R8+3열 실험
전부 반영된 상태): tsc 0에러, **33 suites / 381 tests 전부 통과**. `runs/<gameId>/`
6개 전부 `conformance`, `runner-wave`, `registry.json`, `ledger.json`,
`near-miss.json`, `summary.md`, `benchmark-3col.{json,md}` 산출물 확인.

| R9 | 6개 러너에 `ledger.add` 이후 `saveRegistry` 이전 승격 단계 추가 — 채택 플래그가 있으면 `registry.latest()`+`lineage()`로 중복 승격 방지 확인 후 `v${n+1}` 신규 버전 등록(`sourceWaveId`로 웨이브 추적) | 오목/스플랜더/도미니언(채택 있음) → `versionOrder:['v1','v2']` 실제 생성, 2회 연속 실행해도 중복 등록 안 됨. 장기/윙스팬/하스스톤(채택 0개) → `versionOrder:['v1']` 그대로 유지 확인. 6개 전부 메인 세션에서 registry.json 직접 재현 |

**최종 결합 검증 3회차** (2026-07-22, R9 반영): tsc 0에러, **33 suites / 381
tests 전부 통과**. `runs/{gomoku,splendor,dominion}/registry.json`의
`versionOrder`가 `['v1','v2']`, `runs/{janggi,wingspan,hearthstone}/registry.json`은
`['v1']` — 채택 여부와 정확히 일치하는 것을 메인 세션에서 직접 확인.
