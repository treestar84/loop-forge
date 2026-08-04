# 수정 백로그 — 지금 고쳐야 할 것 (누적 관리)

> GAP-ANALYSIS 문서는 "라운드별 발견 기록"이고, 이 문서는 그중 **실제 코드/가이드
> 수정이 필요한 항목만 뽑아 상태를 추적**하는 누적 백로그다. 새 갭 분석 라운드가
> 끝나면 여기에 항목을 추가하고, 처치가 끝나면 상태만 바꾼다(줄을 지우지 않는다 —
> 이력 보존). ID는 출처 GAP-ANALYSIS 문서의 ID를 그대로 쓴다.

## 미착수 — GAP-13: 셀프서브 온보딩 장치 (2026-08-02, `docs/GAP-ANALYSIS-13.md`, 사용자 지시)

> "게임만 준비하면 절차·수치를 따라만 해도 온보딩되는" 장치. 게이트 수치표와
> 상세 설계는 GAP-13 §2~§3, 구현 순서는 §4(Phase A→E, E가 종단 판정 실험).

| ID | 항목 | 상태 |
|---|---|---|
| S0 | 진단 스테이지(v2 신설) — P-Score 산식(`onboarding/readiness-estimate.ts`) + 룰북 렌더러(`artifacts/rulebook.ts`) + 판정 3단계(불가능/구현 필요/실행 가능)·불가능 사유서. 첫 실행이 "구현 더 해야 하나·지금 돌릴 수 있나·적합도 몇 %·룰북·보완 목록"에 전부 답한다 | **완료**(2026-08-03, GAP-13 §7) |
| S1 | 온보딩 파이프라인 실행기 추출(`artifacts/onboarding-pipeline.ts`) — catan.ts 러너 6단계의 게임 중립화, E1과 동일 수법·검증법(기존 러너 2개 리팩터 후 필드 일치) | **완료**(2026-08-03, GAP-13 §6) |
| S2 | 스캐폴드 생성기 — GameProfile 기반 아키타입 판정(perfect-info/hidden-info/multi-step/content-heavy, 조각 합성형) + `TODO(onboard)` 마커 골격 + S1 호출형 러너 자동 생성 | **완료**(2026-08-03, GAP-13 §8) |
| S3 | 단일 CLI `npm run onboard` + `runs/<gameId>/onboarding-state.json` 상태 머신 — 인자 없이 치면 현재 스테이지·게이트 수치·다음 프롬프트 출력 | **완료**(2026-08-03, GAP-13 §9) |
| S4 | `docs/ONBOARDING-PLAYBOOK.md` — 스테이지별 복붙 프롬프트+통과 수치, CLI와 상호 참조 | **완료**(2026-08-03) |
| S5 | README "내 게임에 적용하기" 교체 — `npm run onboard` 여정 중심, "기존 봇 필수" 과장 정정 | **완료**(2026-08-03) |
| S-E | 종단 판정 실험 — 이 설계를 모르는 신선한 에이전트가 플레이북만으로 신규 미니 게임 1종을 완주하는지 실측 | **완료**(2026-08-03, GAP-13 §11 — 커넥트포 G1→G4 완주, P-Score 75%→유효 C-Score 100) |
| S-F | 종단 실험 마찰 처치 — ① C-Score 표시 모순(C7 blocker가 통과 상태를 0%로 보이게 함 → "C7 제외 유효 점수"로 표시 변경) ② 스캐폴드에 `contract/types.ts` 정본 안내 ③ 플레이북에 C1↔C6 축 간섭 경고 ④ wave 실제 spawn + summary 스테일 문구(근본 원인: 스캐폴드 러너가 conformance run을 RunStore에 저장하지 않던 생성 버그) | **완료**(2026-08-04) |

## 진행 중 — GAP-12: 루프포지 자체 인프라 성숙도 (2026-07-30/31, `docs/GAP-ANALYSIS-12.md`, 사용자 지시)

> 게임 전략이 아니라 프레임워크 구조 자체의 부채. 실측 근거는 GAP-12 §0.

| ID | 항목 | 상태 |
|---|---|---|
| E1 | 포트폴리오 라운드 실행기 추출(`artifacts/portfolio-round.ts`) — diff가 파일 크기를 초과하는 복붙 문제 처치 | **완료**(2026-07-30, 커밋 2e3e232, GAP-12 §4) |
| E2 | (구) 6개 미적용 게임 일괄 앵커 래더 적용 — 일괄 처치 부적합 판정, v2로 재설계됨(아래 E2-A/E2-B) | 재설계 완료 |
| E2-A | 스플랜더·윙스팬에 GAP-11 정규 편입 — 옛 벤치마크로 이미 승리한 두 게임을 정규 표본에 합류 | **완료**(2026-08-04, GAP-11-ROUNDS.md — 스플랜더 초월 확정 2호(트리거 92.5%→확증 88.9%→L3 66.0%), 윙스팬은 트리거 74.3%·확증 74.4% 통과했으나 L3 앵커 등록이 지문 게이트에서 실패(84%≥70%)해 판정 미완, E10 참조) |
| E2-B | 장기·아발론·카탄 — 채택 후보 0개 상태부터 해결(GAP-11 적용 전 선행 과제). 게임별 A8 도메인 재설계 카드는 GAP-12 §7 표 참고 | 진행 중(장기 **완료** — 2026-08-05, GAP-11-ROUNDS.md "장기 A8 첫 채택 시도": 기물안전도+기동성 평가함수형 플래그 `janggiPieceSafetyMobility` 첫 시도로 adopted, v1→v2, holdout 95.0%[85.0-100%]. 아발론·카탄 남음) |
| E3 | 문서 분할(GAP-ANALYSIS-11의 라운드 로그를 `docs/GAP-11-ROUNDS.md`로) | **완료**(2026-07-31, GAP-12 §5) |
| E4 | 테스트 시간 예산 성문화(`docs/TROUBLESHOOTING.md` §12) | **완료**(2026-07-31, GAP-12 §6) |
| E5 | MCTS 옵션 필드 조합 계약 명시화 | 미착수 |
| E6 | no-op 승격 억제 — 승격 후보의 flags가 부모 버전과 완전히 동일하면 새 버전을 만들지 않고 기존 버전에 `sourceWaveId`만 덧붙이는 처치(하스스톤 2회전에서 v4=v3 내용 동일로 실측, `docs/GAP-11-ROUNDS.md` 하스스톤 2회전 판정) | 미착수 |
| E7 | 포트폴리오 수율 재배분이 "채택 여부"만 보고 "새 정보량"은 못 본다 — 하스스톤 2회전에서 B1이 이미 소진(우 소진: priorWeight 곡선 양옆 확인 완료)됐는데도 수율 계산상 80% 배분을 받음. 축 소진 여부를 수율 지표에 반영하는 처치 필요 | 미착수 |
| E8 | **screen 단계 해상도 결함** — `screenProbe`가 3시드(`seeds:[1,2,3]`) 소표본이라, 실제로는 성능 차이가 있는 후보를 "behavioral no-op"으로 버린다. 오목 5회전 실측: `mcts17-s256-clone-earlyprior-sched`가 screen에서 no-op 탈락했는데 같은 라운드 challenge N=40에서 기준선보다 8.7%p 높고(53.1% vs 44.4%), 초월 사다리 N=200 확증에서 53.1%[49.8-56.5]로 이 게임 사상 최고 성적을 냈다 — 승격 자격이 없는 후보가 가장 좋은 성적을 낸 역설. `screenCandidate`(loop/wave-runner.ts)는 통계 검정이 아니라 정확한 trajectory 동일성 비교라 시드를 늘려도 오탐(false positive) 위험은 없다 | **완료**(2026-08-01) — `artifacts/portfolio-round.ts`에 `RunPortfolioRoundInput.screenProbeSeeds?`(옵션, 기본값 `DEFAULT_SCREEN_PROBE_SEEDS`=8시드)를 추가. 과거 라운드 재현이 필요하면 `[1,2,3]`을 명시적으로 넘기면 되고, 생략하면 새 기본값이 적용된다. `reference/runners/*.ts`의 개별 WaveConfig 30여 곳에 흩어진 동일 리터럴은 스코프 밖(과거 라운드 재현성 보존 목적으로 손대지 않음) |
| E10 | **좁은 선택지 게임의 L3 지문 임계** — 윙스팬(턴당 4종 행동)에서 L2를 전혀 읽지 않은 독립 설계 L3 봇이 L2와 지문 84% 일치해 홀드아웃 등록 게이트(<70%)를 통과하지 못함. 선택지 공간이 좁으면 독립 설계가 자연 수렴한다는 실측 — 임계를 게임 특성(분기 폭)에 연동하거나 더 극단적 설계축을 요구하는 재설계 필요 | **완료**(2026-08-04, ADR-0015 보정 게이트 — fast-pass 70% 유지 + floor 기반 excess<0.5. 윙스팬 실측: floor=37.0%, 기존 L3 excess 74.6%·재설계(서식지 특화) L3도 68.7%로 둘 다 불통과 → "윙스팬 L3 구성 불가" 정직 확정. 보정 게이트가 게이트 쇼핑이 아니라 진짜 판별 장치임을 부정 결과로 증명. 윙스팬 초월 판정은 계속 미완) |
| E9 | **확증 N의 검정력 부족** — 오목 v9의 같은 후보를 N=100/200으로 세 번 측정하는 동안 점추정은 매번 53~55%로 일관됐는데 CI 하한만 두 번 정확히 0.5 문턱(49.8%) 근처에서 걸렸다. N=1000으로 올리자 CI 폭이 ±3.4%p→±1.5%p로 좁아지며 하한이 52.18%로 확실히 넘어 초월이 확정됐다(`docs/GAP-11-ROUNDS.md` "오목 v9 대규모 확증"). 즉 근접실패의 원인이 후보 설계 부족이 아니라 **확증 표본 크기의 검정력 부족**이었던 사례 — 다른 게임에서 같은 문턱 근접실패가 반복되면 재설계 전에 검정력부터 의심해야 한다는 원칙을 성문화할 필요 | 미착수(2026-08-01 발견) |

## 미착수 — GAP-11: 큰루프/작은루프 설계 수준 보완 (2026-07-29, `docs/GAP-ANALYSIS-11.md`, 사용자 지시)

> "루프포지가 무수한 큰루프-작은루프 반복으로 Opus 즉흥설계봇보다 강한 NPC를
> 만들어내는 장치가 되도록" 근본 원인 5개(R1~R5)를 진단하고 처치 D1~D6을
> 설계했다. 역할 규약: 설계·판단=Opus, 구현·측정=Sonnet. 상세는 GAP-11 §3~4.

**v2 개정(2026-07-29, 사용자 2차 지시 반영)**: 단일 외부 앵커 → **앵커 래더**
(L1 중수/L2 고수=기존 Opus봇/L3 신스타일 고수2=홀드아웃 전용), 패배 데이터
3단 활용(아카이브→LossReport→**프로브 국면 은행**), 큰루프 설계 단계의
**포트폴리오 버킷화**(B1 기계 스윕/B2 상대정보/B3 Opus 심층/B4 탐험/B5 모방,
수율 기반 비중 재배분). Phase 순서도 패배 인프라 최우선으로 재배열.

| ID | 항목 | Phase | 상태 |
|---|---|---|---|
| D4 | `runHeadToHead` trajectory 기록 옵션 + `loop/loss-mining.ts`(LossReport: 패배 확정 깊이·분기점 대조·결정지점별 불일치율) + `loop/probe-bank.ts`(프로브 국면 봉인·후보 채점기 — 웨이브 전 초저비용 필터) | 1 | **완료**(2026-07-29, 커밋 84954e2 + 자기일치율 1.0 후속 수정 — 결정별 파생 시드, GAP-11-ROUNDS.md) |
| D3 | `BenchmarkAnchor kind:'external'`+`role:'feedback'\|'holdout'` + `WaveConfig.challenge?` 계측 열(+ADR-0012, 채택 판정 불개입) + L1(Sonnet 설계)·L2(기존 Opus봇 봉인)·L3(신스타일 Opus 설계, 피드백 경로 코드 수준 차단) 앵커 등록 — 등록 전 실측 게이트(heuristic<L1<L2, L3는 L2와 행동 지문 거리 확인) | 1 | **완료**(2026-07-29, 커밋 3ff81af·7219fa5·e091076 — 3게임 래더 봉인, 판정 실험으로 v5<L1<L2 서열 실측, GAP-11-ROUNDS.md) |
| D1 | `choiceEvaluator?` 계약 확장(+ADR-0011) — 지식의 세 번째 주입 통로 (GameAdapter에 배치 — 제네릭 접근 필요, strategySurface와 동일 위치) | 2 | **완료**(2026-07-29, GAP-11-ROUNDS.md Phase 2) |
| D2 | `search/mcts.ts` PUCT prior/progressive bias(`priorWeight`, 미지정 시 불변, IS-MCTS 명시 공유) + 오목 실증 | 2 | **완료**(2026-07-29 — vs L1 0→34.5% 완전 단조 개선으로 "L1 곡선 유의 개선" 기준 충족·주입점 유효 실증, vs L2는 전 후보 0%로 미해결(무영향 — 다음 라운드 브리프 입력), GAP-11-ROUNDS.md) |
| D5 | 포트폴리오 후보 생성(B1~B5 버킷, 수율 기반 재배분·하한 5%) + `artifacts/design-brief.ts` + `artifacts/portfolio.ts` + 프로토콜 v2 6단계(DESIGN §6.2, +ADR-0013) | 3 | **완료**(2026-07-29, 커밋 cde13aa·4b01de4·ede0d01) |
| D6 | 축 매트릭스 성문화(게임×축 시도 현황 A1~A10, ADR-0009 적용 단위 명확화) | 3 | **완료**(2026-07-29 — GAP-11 §3 D6 표 + DESIGN §6.2 + 브리프 axisMatrix 배선) |
| — | 실증 1회전: 오목(브리프→B1~B5 배치→프로브 필터→웨이브→challenge) / 도미니언(A8 도메인 재설계, B3 주도) | 3 | **완료**(2026-07-29 — 오목: L2 0%→25.6% 사상 첫 돌파·v6 / 도미니언: 4차 정체를 A8 축 전환으로 돌파·v3·L2 3.75%→22.5%, 프로브 필터 예측력 두 게임 재현, GAP-11-ROUNDS.md) |
| — | 도미니언 3회전: chapelTrash 재부상(상호작용 효과) 규명, `composeBotChecked`/`assembleFlags`(ADR-0014) 최초 실전 적용 — 클론 배제·V2를 계보 기준선으로 경쟁시켜 v5(ismcts-s64-v2buy-prior) 승격 | 5 | **완료**(2026-07-30, GAP-11-ROUNDS.md) |
| — | 초월 판정: L3 홀드아웃 앵커 상대 >50%(CI 하한 0.5 초과)만 인정 — L2만 이기고 L3에 지면 과적합 실측으로 기록, B4 비중 상향 | 4 | 미착수 |
| — | **registry 조립 시맨틱 재설계**(ADR-0014): `StrategyFlagSpec.assembly?: 'decorator'\|'terminal'` 선언 + `analyzeAssembly`/`composeBotChecked`/`assembleFlags` 신설(`composeBot` 본체는 무수정 — 기존 registry 전부 재현 불변, 실측 다이제스트로 증명). 6게임+mini-trick의 기존 터미널 플래그(MCTS/IS-MCTS/클론 계열) 전부 소급 선언. 다음 라운드(도미니언 3회전·오목 4회전)의 승격 코드부터 `composeBotChecked`/`assembleFlags` 사용 의무화 | 4 | **완료**(2026-07-30, 60 suites/797 tests, 전체 실행 47초) |

## 완료(부정 결과, 카드 소진) — 오목 C열 5개 카드 최종 정리 (2026-07-28)

사용자 지시: "루프포지 전략도 오퍼스급 모델이 계속 보태는데 오퍼스보다 약한 게
말이 안 된다"는 문제 제기에 대한 원인 진단 결과, 지금까지의 전략 대부분이
**빠르게 작성된 단순 휴리스틱이었지 오퍼스 수준의 깊은 설계 노력을 들인 게
아니었다**는 게 실제 원인으로 확인됐다. 이를 교정하기 위해 오퍼스의 실제 우위
원리(다방향 위협/포크 인식)를 게임 지식으로 정식 이식하는 4·5번째 카드를
추가로 시도했다 — 결과는 부정적이지만 원인이 정밀하게 좁혀졌다.

| 카드 | 처치 | 결과 |
|---|---|---|
| 1(예산 2배) | mcts2-s512-hr | 0% (§4.6) |
| 2(롤아웃 교체) | mcts2-s256-cr/s512-cr(챔피언 롤아웃) | 0% (§4.6) |
| 3(전술 프리체크) | tacticalDepth(즉승/즉방어) | 0% (§4.8) |
| **4(포크 인식, 게임 지식 정식 이식)** | `forkAwareness` strategySurface 플래그(4방향 열린3/충족4 판정, 포크=2개 이상 동시 위협) | **순정 휴리스틱(탐색 없음) 9.0%(CI [5.5,13.0]) — 최초로 0%대 돌파.** 단 MCTS 롤아웃으로 감싸면(`mcts2-s256-fork`) 다시 0.0%로 희석 |
| **5(탐색 우회 루트 오버라이드)** | `search/mcts.ts`에 게임 중립 `rootOverride?` 훅 신설(tacticalDepth 즉승 체크 다음, 일반 MCTS 전에 삽입 — 포크 판정이 non-null이면 시뮬레이션 없이 즉시 반환), `gomokuForkDecision` 순수함수로 연결(`mcts3-s256-override`) | **0.0%(N=100 전패), 계측으로 실제 41.1% 발동 확인 — 배선 버그 아니라 실질적 한계** |

**결론**: 5개 카드 전부 시도, 카드 4가 유일하게 0%를 돌파했으나(9.0%) 탐색과
결합하는 순간 사라지고, 탐색을 완전히 우회해도(카드 5) 살아나지 않았다 —
"이 좁은 정의의 포크가 강한 상대에게는 진짜 강제승이 아니거나, 포크가 없는
나머지 수순에서 얕은 탐색이 계속 밀린다"는 게 가장 근거 있는 해석. **오목은
현재 구조(256-sim 얕은 MCTS)로는 오퍼스를 못 이긴다는 게 5장 전부를 소진한
뒤의 정직한 최종 결론**이다. `rootOverride` 훅 자체는 게임 중립 인프라로 유지
가치가 있다(다음 게임에 재사용 가능, 단위테스트 5개로 고정). `forkAwareness`도
strategySurface에 정식 등록돼 향후 정규 웨이브(raw heuristic 상대)에서 별도로
평가된다 — 오퍼스를 못 이겨도 내부 기준선 강화에는 여전히 쓰일 수 있다.

다음 카드가 있다면(이번 라운드 범위 밖, 억지 반복 금지): 시뮬레이션 예산을
훨씬 크게 늘리기(비용 문제 별도 검토 필요), 포크 정의를 연속/이중 위협 체인까지
확장하기, 또는 이 게임에서 순수 탐색 심화 접근 자체의 근본적 재검토.

tsc 0에러, 42 suites / 573 tests 전부 통과.

## 미착수 — 4개 신규 카테고리 사전 진단 (2026-07-27, `docs/GAP-ANALYSIS-10.md`, 사용자 지시)

> 실전 온보딩 6개(스플랜더·오목·장기·도미니언·윙스팬·하스스톤)는 전부 "턴제·
> 적대적 2~4인" 계열에 가깝다. 공개 후 사용자가 들고 올 완전히 다른 장르에서도
> 시스템이 게임 특성을 자동 파악해 맞는 장치만 켜지는지, 4개 신규 카테고리를
> 실제 게임으로 대입해 코드 레벨로 사전 진단했다.

| ID | 카테고리(예시 게임) | 발견 | 심각도 |
|---|---|---|---|
| M3 | 실시간·연속행동(레이싱·격투) | `search/mcts.ts`·`ismcts.ts`의 legal 배열 전수 순회 전제가 연속/초거대 이산 공간에서 깨짐, 결정지점 모델과 프레임 단위 실시간이 불일치, C4·표본산식 자릿수 붕괴 — 완전 신규 발견(F12는 선언만 하고 근거 없었음) | 낮음(우선 문서화) |

M1·M4는 실제 게임(아발론·카탄) 온보딩으로 진행 완료 — 아래 완료 표 참고. M2는
아래 완료 표(코드 수정) — 협동 게임 실전 온보딩은 다음 라운드 몫으로 남음.

## 완료 — M2 협동 게임 C5 축 일반화 (2026-07-27)

| 처치 내용 | 증거 |
|---|---|
| `GameSpec.cooperativeStructure?`(옵트인, M1의 `hiddenTeamStructure?`와 나란히) 추가 → `scoreC5`가 `identityFairnessExempt = hiddenTeamStructure \|\| cooperativeStructure`로 통합해 true일 때 `identityCenter`를 실측 `meanWinRate` 자기참조로 재정의(M1과 동일 메커니즘 재사용). 좌석 편향 검사·`C5_HEURISTIC_NOT_DISTINCT`는 완전히 별도 경로라 그대로 유지. `classifyGame`에 필드 배선 | 회귀 핀(미선언 시 기존 블로커 동작 동일) + 낮은 승률(0.1 vs 기대 0.25) 픽스처로 블로커 미발생 확인 + 좌석 편향은 여전히 잡힘 |

tsc 0에러, **42 suites / 565 tests 전부 통과**(직전 560 대비 신규 5건). 협동
게임(판데믹류) 실전 온보딩으로 실증하는 것은 이연(M1이 아발론으로, M4가
카탄으로 실증됐던 것과 같은 다음 단계).
M2·M3는 아직 실제 게임 온보딩이 없어 미착수 유지. 상세 근거는 GAP-ANALYSIS-10.md.

## 완료(근접실패, 개선 추세) — 도미니언 3차 재도전: 예산 증가 (2026-07-28)

이전 2회(ismcts-s64-hr 0.275, ismcts-s64-cr 챔피언 롤아웃 0.100 악화)와 겹치지
않는 새 축 — **롤아웃은 순정 heuristic 유지, 탐색 예산만 증가**(s64→s256)를
시도. 진단(N=60)에서 0.417로 개선 확인 후 실제 웨이브 진행.

| 시도 | regression 승률(vs 챔피언 rushProvinces) |
|---|---|
| 1차 ismcts-s64-hr | 0.275 |
| 2차 ismcts-s64-cr(챔피언 롤아웃, 억지 반복 금지로 재시도 안 함) | 0.100(악화) |
| **3차 ismcts-s256-hr(예산 증가)** | **0.400**(CI 0.25–0.55, smoke/prune/holdout 전부 1.000) |

**결과: 근접실패(near-miss), registry v2 그대로.** 개선 추세는 뚜렷하지만
(0.275→0.400, CI 상단이 0.5를 넘봄), 예산을 계속 올리는 것은 "같은 손잡이를
반복해서 돌리는" 것이라 여기서 정직하게 멈춘다 — 억지 반복 금지 원칙 유지.
다음 카드가 있다면 예산 확대가 아니라 **다른 종류의 축**(예: 도미니언의 실제
승리 조건 구조를 분석한 도메인 전략 재설계)이어야 한다.

tsc 0에러, 42 suites / 573 tests 전부 통과(변경 없음 — 이번 라운드는 러너
실험 코드만, 신규 유닛테스트 없음).

## 완료(부정 결과) — 장기 미채택 전략 롤아웃 합성 재도전 (2026-07-27)

목적: 장기(registry v1, 0/3 채택)에 챔피언이 없어 "챔피언 롤아웃"(오목·스플랜더에서
통했던 기법)을 그대로 쓸 수 없었다 — 대신 코드에 남아있지만 미채택인 수제 전략
`captureHighestValue`(안전 무시 최고가치 포획)+`preferCheck`(장군 유발 우선, 둘 다
"effective"로 문서화)를 MCTS **롤아웃 정책**으로 합성해 재도전.

**결과: 실패, 이전 시도보다 더 나빠짐** — 진단 head-to-head(N=60, sim=64, 게이트
없음) 승률 **0.1583** vs 순정 heuristic 롤아웃의 이전 기록 **0.375**. 웨이브는
지시대로 생략(억지 투입 안 함), registry v1 그대로.

**원인 규명**: 두 전략 다 안전 검토 없이 "무조건" 실행되도록 설계돼 있어(문서화된
의도 — heuristicBaseline과 행동적으로 구별되게 하려는 것), 롤아웃 정책으로 쓰면
"위험한 포획→역공 허용→체크 강행"이라는 비현실적 자멸 패턴을 시스템적으로
만들어내고 MCTS가 그 왜곡된 보상 신호를 신뢰하게 됨. **"단독 평가에서 effective로
표시된 전략도 롤아웃 정책으로 합성하면 반드시 좋아지지 않는다"**는 게 이번 라운드의
핵심 교훈 — 다음에 유사 실험을 설계할 때 참고할 것(같은 조합 재시도 금지).

**부수 검증**: `deriveSearchBlueprint`(v1.13) 실전 첫 적용 — family=tree-search,
simulations=32, tacticalPrecheckDepth=2 추천은 합리적이었으나, 커스텀 합성 롤아웃은
`rolloutTier: 'random'|'heuristic'` 스코프 밖이라 추천 대상이 아님을 확인(설계
의도대로, 버그 아님 — GAP-9 §3과 동일한 스코프 경계).

다음 후보(장기, 이연): uctC 조정, tacticalDepth 병행, 또는 안전을 고려하는 다른
전략 조합. 코드 변경 없음(진단만 수행), tsc/test 재실행 불요.

## 완료 — M1/M4 게임 중립 수정 (2026-07-27, 아발론·카탄 온보딩 선행 작업)

| ID | 처치 내용 | 증거 |
|---|---|---|
| M1 | `GameSpec.hiddenTeamStructure?`(옵트인) 추가 → `scoreC5`가 true일 때 `identityCenter`를 실측 `identity.meanWinRate` 자기참조로 재정의(1/playerCount 폴백 무력화), 좌석 편향 검사(`identity.bias`)는 분기 밖이라 그대로 유지. `classifyGame`에 필드 배선만(matchStructure 로직은 범위 밖) | 회귀 핀(미선언 시 기존 블로커 동작 동일) + 4인 비대칭 은닉 진영 픽스처로 신규 분기 검증(블로커 미발생 + 좌석 편향은 여전히 잡힘) |
| M4 | `WaveConfig.fieldMix?: ReadonlyArray<'heuristic'\|'random'>` 추가(길이=playerCount-1 검증) — `runPairedBlock` opponent 파라미터가 단일/배열 겸용으로 확장, wave-runner 전 함수가 restFactories 배열 기반으로 일반화 | 기존 reportDigest 고정 해시 무손상(미지정 시 완전 동일) + 4인 픽스처로 슬롯별 개별 factory 배치 검증(스파이로 호출 추적) + 길이 불일치 에러 |

tsc 0에러, **40 suites / 519 tests 전부 통과**(직전 511 대비 신규 8건).

## 완료 — 아발론 온보딩 (M1 실전 검증, 2026-07-27)

8번째 게임. 5인 기본 역할 세트(멀린·충복 2·모드레드의 하수인·암살자, 확장 역할
제외). 참고: [AlexLomm/avalon-engine](https://github.com/AlexLomm/avalon-engine)
(MIT, 구조만 참고·코드 미복사).

| 항목 | 결과 |
|---|---|
| conformance | C0~C6 100(C6=67, 전략 플래그 하나가 probe 시드에서 암살 페이즈 도달 못 함 — non-blocking), **C5=100(M1 실증)**, C7=60(self-play 캡, 정상) |
| **M1 실증** | `hiddenTeamStructure:true` 선언 시 C5가 `identityCenter`를 실측 `meanWinRate`(0.237) 자기참조로 삼아 **블로커 없이 통과**함을 로그로 직접 확인(정적 `1/playerCount=0.2` 기대였다면 걸렸을 상황) |
| 부수 발견 | 최초 heuristic 봇(정보 미활용)이 `C5_HEURISTIC_NOT_DISTINCT`로 실제 거부됨 — 멀린/악 진영이 알고 있는 정보를 실제로 쓰도록 재설계 후 통과. "블로커가 항상 어댑터 버그는 아니다" 원칙의 반례(이번엔 진짜 버그) |
| 웨이브 | 3플래그 전부 미채택(정상 — 목표는 파이프라인 완주였지 강한 전략 설계가 아님) |

tsc 0에러, **41 suites / 540 tests 전부 통과**.

## 완료 — 카탄 온보딩 (M4 실전 검증, 2026-07-27)

9번째 게임. 4인, 은행 4:1 거래만(플레이어 간 협상·항구·개발카드·최장도로/최대군세
보너스 제외 — 스코프 축소 명시), 승점 8(공식 10 대신, 보너스 부재로 10점까지
비현실적으로 오래 걸림). 참고: [rpjohnst/catan](https://github.com/rpjohnst/catan)
(라이선스 미명시, 구조만 참고·코드 미복사).

| 항목 | 결과 |
|---|---|
| conformance | C0~C4 100, **C5=100**(seatWinRate bias=0.485 — 선착 순서 우위, 카탄 실제 특성으로 예상된 결과이지 결함 아님), C6=67(non-blocking), C7=60(self-play 캡, 기존 8게임과 동일 패턴) |
| C4 실측 | 약 91만 decisions/sec, 1,150 games/sec — 4인+7종 결정지점 우려와 달리 처리량 양호 |
| **M4 실증** | 웨이브 A(단일 `opponent:'heuristic'`) vs 웨이브 B(`fieldMix:['heuristic','heuristic','random']`) 둘 다 실행 — 슬롯별 팩토리 배치를 로그로 직접 확인, 같은 후보의 smoke 승률이 두 웨이브 사이에서 실제로 달라짐(roadExpansionPriority 0.183→0.267, eagerBankTrade 0.125→0.167) — 비후보 상대 구성 변경이 결과에 실제 영향을 준다는 것을 실증 |

M9(신규 발견, 등재만): `score.ts`의 C3 샘플러가 카탄처럼 초기 셋업 구간이 긴
게임(16결정)에서 기본 옵션으로는 표본을 못 뚫는 구조적 한계 발견 — 러너
호출 시 `c3SampleStates` override로 우회(스코어러 본체는 미수정). 다른 "긴
셋업 페이즈" 게임에서 재발 가능한 패턴이라 별도 처치 후보로 남김(우선순위
낮음, GAP-ANALYSIS-10 스타일로 다음 라운드에 정식 등재 검토).

tsc 0에러, **42 suites / 560 tests 전부 통과**.

## 미착수

| ID | 항목 | 출처 |
|---|---|---|
registry 버전 표현 일반화(`kind: flags\|policy-table\|search-config`)는
GAP-ANALYSIS-7 §2 이연 목록. 도미니언 챔피언 롤아웃 재도전(3차 이상)은 억지
반복 금지 원칙에 따라 미착수로 남겨둠(§6.1 프로토콜은 성공 보장이 아님).

## 완료 — 확장성 라운드 (2026-07-26, `docs/GAP-ANALYSIS-9.md`, 사용자 지시 최우선)

> 목적: 온보딩 채점/게이트(C0~C7·티어 블록수·점수차 임계)는 이미 classification+
> calibration → 파생형이었으나, 탐색/학습 후보 생성(알고리즘·예산·롤아웃 선택)은
> 매 게임마다 에이전트가 손으로 판단해 6개 중복 파일에 하드코딩돼 있었다. "다음에
> 올 낯선 게임"이 같은 시행착오를 반복하지 않도록 이를 파생 함수로 승격했다.

| ID | 처치 내용 | 증거 |
|---|---|---|
| G1 | `kernel/search-blueprint.ts` — `deriveSearchBlueprint(classification, capabilities, throughputSamples, waveTimeBudgetMs, options?)`. 순수 데이터 추천(family·simulations·rolloutTier·tacticalPrecheckDepth·flagLabel·rationale), search/learn 미참조 | 단위테스트로 family·예산·CFR 병행·tacticalDepth 분기 전부 검증 |
| G2 | `loop/calibrate.ts`에 `measureAverageLegalChoiceCount` 신설(별도 경량 자기대국 순회 — runMatch/runPairedBlock 시그니처 불변, 다른 소비자 무영향), `NoiseFloorResult.averageLegalChoiceCount`에 배선 | 소형 픽스처로 평균 합법수 계산 검증 |
| G3 | `reference/runners/shared/search-candidate.ts` — `searchCandidateFlagSpec(adapter, recommendation)`. family별 mctsBotFactory/ismctsBotFactory 자동 분기, CFR/none은 명확한 에러. 기존 6개 게임별 shared 파일은 무손상 유지(신규 게임부터 이 헬퍼 사용) | 스모크 테스트(유효 StrategyFlagSpec·composeBot 합성·1판 정상 종료) |
| G4 | 회귀 픽스처 — 7게임(오목·장기·스플랜더·도미니언·하스스톤·윙스팬·mini-trick) 실제 classification+capabilities+실측 throughput으로 방향성 검증 | **7/7 전부 일치**(family·rolloutTier가 실제 채택된 알고리즘 계열과 방향 동일) — 비용 0(웨이브 재실행 없음) |
| G5 | `docs/ONBOARDING-GUIDE.md` §10 신설 — "탐색 후보 자동 추천" 4단계 표준 절차(캘리브레이션→deriveSearchBlueprint→searchCandidateFlagSpec→withStrategyFlags) | 기존 §8/§9 스타일 준수, 기존 7게임 flag 미교체 원칙 재확인 |

기존 7게임의 이미 채택된 flag는 이 라운드로 교체되지 않았다(설계 의도, GAP-9 §3).
tsc 0에러, **40 suites / 511 tests 전부 통과**(직전 38/474 대비 순증).

## 완료 — P7 오목 C열 역전 (전 카드 소진, 2026-07-26, `docs/GAP-ANALYSIS-8.md` §4.8)

| 처치 내용 | 증거 |
|---|---|
| `search/mcts.ts`에 게임 중립 전술 프리체크(`tacticalDepth: 0\|1\|2`, `tacticalBranchCap?`) 추가 — 1-ply 즉승 즉시 반환, 2-ply 상대 즉승 유발 수 배제(안전 후보 0개면 폴백). 미지정 시 기존 동작 완전 불변 | 신규 테스트 8건(즉승 즉시 반환·MCTS 생략 증명, 상대 즉승 배제, 폴백, 결정론, branchCap 동치) |
| `mcts2-s256-tactical`(챔피언 롤아웃 + tacticalDepth=2) 생성, Opus봇 진단(N=100)에서 **0.0%[0,0] 전패** 확인 → 웨이브 생략(지시 조건대로 억지 투입 금지) | vs v5 챔피언은 정상 동작(프리체크 자체는 game-neutral하게 정확) — 예산 상향·챔피언 롤아웃·전술 프리체크 3갈래 전부 Opus 상대 0%로 원인이 "즉흥 설계의 다방향 위협 스코어링을 얕은 탐색이 못 넘는다"로 최종 확정 |

이것으로 오목 C열 역전의 3가지 카드(예산·롤아웃·전술)가 전부 소진됐다 — "이 예산대에서는
구조적으로 즉흥 설계 LLM 봇이 이긴다"가 유효한 최종 결론이며, 남은 가설
(다방향 위협 스코어링을 서치 평가함수에 일반화 이식)은 game-specific 휴리스틱과
game-neutral 서치의 경계를 넘는 별도 설계라 범위 밖으로 명시 이연.

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
