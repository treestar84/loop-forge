# 갭 분석 6차 — 산출물 신선도·중복 정책·실험 인프라 점검 (v1.5 시점)

> 방법: 서브에이전트 위임 없이 메인 세션(Fable)이 코드를 직접 읽고 점검했다(사용자
> 지시 "fable 사용해 이 부분만"). 계기: 6개 게임(스플랜더·오목·장기·도미니언·
> 윙스팬·하스스톤)의 온보딩+웨이브 실행이 전부 끝난 직후, "리드미에 담을 3열
> 승률 비교 실험"을 시작하기 전 마지막 점검. 관점 3가지: (1) 지금까지 만든
> 산출물이 실제로 사용자에게 도달하고 있는가, (2) 6개 러너를 만들며 반복된 패턴이
> 중복 부채로 남았는가, (3) 다음 실험(3열 승률 비교)에 실제로 필요한 인프라가
> 이미 있는가.

---

## R1. `README.md`가 mini-trick 시대에 정지해 있다 [높음, 신규]

`README.md`(37줄) 구조도(`## 구조`)에 `src/artifacts/`가 아예 없고, `src/reference/`는
"레퍼런스 게임 mini-trick"이라고만 적혀 있다. 실제로는:
- `src/reference/`에 게임 7종(mini-trick+6개 실전 게임) 어댑터가 있다.
- `src/reference/runners/`에 게임별 실행 진입점 6개가 있다(H5/Z3 산출물).
- `src/artifacts/`(run-store, game-state, game-summary, adoption-ledger, benchmark,
  baseline-registry)가 구조도에서 완전히 누락됐다.
- `src/kernel/classify.ts`/`blueprint.ts`(게임 분류기, W1~W8) 언급이 없다.
- "시작" 섹션이 `npm run demo`(mini-trick 전용)만 안내하고, 실전 게임을 돌리려면
  `src/reference/runners/<gameId>.ts`를 실행하면 된다는 안내가 없다.

사용자가 이제 여기에 **공개될 벤치마크 리더보드**를 담으려는 시점이라 이 문제가
더 심각해진다 — README는 프로젝트의 첫 인상인데 지금 상태로 두면 리더보드가
"이게 대체 뭘 하는 프로젝트인지 설명도 안 된 표"로 보인다.

- **처치**: 리더보드 작업 착수 전에 README를 현재 아키텍처(7게임, 분류기, 러너,
  6점 채점 기준 강화, C7 provenance 캡)에 맞게 갱신. `DESIGN.md`의 구조도(§1)도
  같은 문제가 있는지 함께 확인.

## R2. C7-only 예외 정책이 6개 러너 파일에 그대로 복붙돼 있다 [중간, 신규]

`nonParityBlockers` 체크 블록(conformance의 C7-parity 축만 걸리면 경고 후 웨이브
진행, 다른 축이 걸리면 정지)이 `src/reference/runners/{gomoku,splendor,janggi,
dominion,wingspan,hearthstone}.ts` **6개 파일에 전부 동일하게 복사돼 있다**(18회
매칭 확인 — 정의+사용 지점 합산). 게임을 하나 더 추가할 때마다 이 로직을 또
손으로 베껴야 하고, 정책이 바뀌면(예: 캡 기준을 60에서 다른 값으로 바꾸거나,
C4 처리량 변동성도 예외로 추가하려면) 6곳을 전부 찾아 고쳐야 한다.

- **처치**: `src/loop/` 또는 `src/onboarding/`에 `shouldProceedDespiteBlockers(
  conformance): {proceed: boolean, warnings: string[]}` 같은 공용 헬퍼를 만들어
  이 정책을 한 곳으로 승격. 6개 러너를 이 헬퍼를 쓰도록 리팩터.

## R3. `extractNearMissCandidates`(H10)가 실제 러너 어디에도 연결 안 됨 [중간, 신규]

이번 웨이브 실행에서 대부분의 후보가 near-miss/failed였다(장기 3/3, 윙스팬 3/3,
하스스톤 3/3 screen 탈락, 스플랜더·도미니언 각 2/3). 이게 정확히 H10이
"구조화해서 다음 라운드 입력으로 쓰라"고 만든 데이터인데, 6개 러너 스크립트
어디도 `extractNearMissCandidates`를 호출하지 않는다 — 그냥 콘솔 로그로만 찍고
끝난다. `DESIGN.md` §6.1이 설계한 큰 루프 2단계("near-miss를 구조화된 형태로
추출")가 실제 워크플로우에 아직 배선되지 않았다는 뜻이다.

- **처치**: 러너가 웨이브 종료 후 `extractNearMissCandidates`를 호출해 결과를
  `runs/<gameId>/near-miss.json`류로 저장하거나, 최소한 콘솔에 gap 수치까지
  출력하도록 갱신.

## R4. `renderGameSummaryMarkdown`(H8)이 6개 게임에 대해 한 번도 안 쓰였다 [중간,
    반복된 패턴 — GAP-ANALYSIS-5/이전 세션에서 이미 한 번 지적된 문제의 재발]

이전 세션에서 정확히 같은 문제("만들어놓고 안 보여줌")가 오목 하나에 대해
지적됐고 그때는 직접 보여줘서 해소했다. 그런데 이번에 6개 게임 전부 웨이브까지
실행해놓고 `renderGameSummaryMarkdown`을 한 번도 호출하지 않았다 — 즉 통합
산출물 인프라(H8)가 존재하는데도 계속 개별 `report.md`/콘솔 로그만 사용자에게
보여주는 습관이 반복되고 있다. 도구가 있다는 사실 자체가 습관을 안 바꿔준다는
뜻이다.

- **처치**: 각 러너 실행 마지막 단계에 `renderGameSummaryMarkdown` 호출을
  추가해서 `runs/<gameId>/summary.md`를 항상 자동 생성하게 만든다(사람이
  "보여달라"고 요청해야 나오는 게 아니라 매 실행마다 자동으로 남게).

## R5. 웨이브 티어 파라미터가 통계적 근거 없이 6개 게임에 동일하게 고정 [높음,
    신규 — 3열 실험의 신뢰도에 직결]

6개 러너 전부 `smoke.maxBlocks=20`, `prune.blocks=5`, `holdout.blocks=5`,
`screenProbe.seeds=[1,2,3]`을 그대로 복사해서 썼다. 이건 원래 오목 러너가
"작은 실증"을 목적으로 고른 임의값인데, `src/kernel/paired-stats.ts`의
`recommendBlockCount`(분산 기반 표본 크기 추천, X3/W3에서 이미 구현됨)를 실제로
호출해서 얻은 값이 아니다. 러너들 어디에도 **calibration(항등 대국으로 noise
floor 측정) 단계가 없다** — `demo.ts`는 이 단계가 있는데 게임별 러너 템플릿을
만들 때 빠뜨렸다.

결과: holdout까지 통과해 "adopted"로 채택된 전략(오목 3개, 스플랜더 1개,
도미니언 1개)이 통계적으로 진짜 유의미한지, 아니면 5블록짜리 표본의 우연인지
확신할 근거가 약하다. `screenProbe.seeds=[1,2,3]`도 이 6개 게임 각각에서 실제로
no-op을 잘 걸러내는지 검증된 적이 없다(오목 원본 데모의 시드는 "실측으로 확인된
값"이라고 주석에 명시돼 있었는데, 새 게임들은 검증 없이 그 숫자를 그대로
재사용했다).

이건 3열 승률 비교 실험(사용자가 다음에 하려는 것)의 신뢰도에 직접 영향을 준다
— "루프 포지로 채택한 전략"이 수천 판 규모의 순수 승률 검증에서 뒤집힌다면,
그게 전략 자체의 문제인지 표본 크기 부족 때문인지 구분이 안 된다.

- **처치**: 러너 템플릿에 calibration 단계 추가(`measureNoiseFloor` →
  `recommendBlockCount` → tier 블록 수 결정), screenProbe 시드는 게임별로
  최소 한 번은 "이 시드가 no-op을 실제로 걸러내는지" 검증하는 절차를 표준화.

## R6. 참조 오픈소스 저장소의 출처·라이선스가 코드 주석에만 흩어져 있다 [중간, 신규]

6개 게임 전부 원본 오픈소스 레포(caeleel/splendor, imjacobclark/BoardGameEngine,
davisethan/janggi, rspeer/dominiate, keithgw/wingspan, danielyule/hearthbreaker)를
참조 구현으로 삼아 만들어졌고, 각 어댑터 파일 상단 주석에 출처가 잘 적혀있다
— 하지만 **한곳에 모아 정리한 문서가 없다**. `DESIGN.md` §7 "오픈소스 체리픽
명세"는 로프-포지 자체의 설계 아이디어 출처(OpenSpiel, Fishtest 등)를 위한
표이지, 이번에 온보딩한 6개 게임의 원본 저장소용이 아니다. 사용자가 리드미에
공개용 벤치마크를 실으려는 시점이라, 각 게임이 참조한 오픈소스와 그 라이선스를
한 곳에서 확인할 수 있는 표가 없으면 출처 표기 누락 위험이 있다.

- **처치**: `README.md` 또는 새 `docs/CREDITS.md`에 6개 게임의 원본 레포·라이선스·
  참조 범위(전체 구현 vs 부분집합)를 표로 정리.

## R7. "게이트 없이 순수 승률만 뽑는" 유틸리티가 아직 없다 [높음, 3열 실험의
    직접 선결 조건]

지금 존재하는 대국 실행 API는 전부 통계적 게이트(screen→smoke→prune→holdout)에
묶여 있다: `runMatch`(1판), `runPairedBlock`(좌석 미러링 1블록), `calibrateIdentity`/
`measureNoiseFloor`(항등 전용). **"봇 A vs 봇 B를 N개 시드로 그냥 돌려서 순수
승률 하나만 다오"**에 해당하는 단일 진입점이 없다 — `runWave`를 억지로 쓰려면
가짜 `strategySurface` 플래그를 만들어 SPRT/게이트를 통과시켜야 하는데, 이건
사용자가 원하는 "수천 판 단순 대전" 실험의 목적과 안 맞는다(게이트는 통계적
신뢰구간을 확보하기 위한 것이지, 단순 승률 집계를 막으려는 게 아니다).

사용자가 요청한 3개 컬럼(A: Opus봇 vs 기본봇, B: 루프포지봇 vs 기본봇, C:
Opus봇 vs 루프포지봇)은 전부 이 "게이트 없는 대량 대전 → 승률" 패턴이다.

- **처치**: `src/loop/`에 `runHeadToHead(adapter, botFactoryA, botFactoryB, seeds,
  botSeedBase): {winRateA, winRateB, drawRate, blocks}`류의 경량 유틸을 신설 —
  내부적으로 `runPairedBlock`을 시드마다 돌려 평균만 내면 되므로 기존 커널
  위에 얇게 얹을 수 있다. 다음 라운드(3열 실험 구현)의 선결 작업.

## R8. 게임이 계속 추가되며 누적되는 "리더보드" 문서 컨벤션이 없다 [낮음, 신규]

지금 문서 체계(`GAP-ANALYSIS-N.md`, `FIX-BACKLOG.md`)는 전부 "무엇을 발견하고
고쳤는가"의 이력이지, "게임별 실험 결과가 누적되는 표"가 아니다. 사용자가
"게임을 계속 추가하면서 비교하고 싶다"고 했으므로, 새 게임이 추가될 때마다
자동으로(또는 최소 저항으로) 한 행이 늘어나는 문서 구조가 필요하다.

- **처치**: 다음 라운드에서 실험을 설계할 때 이 문서의 정확한 형태(README 안
  섹션 vs 별도 `docs/BENCHMARK-LEADERBOARD.md`)를 결정.

---

## 수렴: 처치 목록

| ID | 갭 | 심각도 | 처치 | 3열 실험의 선결 조건? |
|---|---|---|---|---|
| **R7** | 게이트 없는 순수 승률 유틸 부재 | **높음** | `runHeadToHead` 신설 | **예 — 직접 선결** |
| **R5** | 웨이브 티어 파라미터 통계적 근거 부재(calibration 단계 빠짐) | **높음** | 러너 템플릿에 calibration 단계 추가 | 예 — 결과 신뢰도 |
| **R1** | README가 mini-trick 시대에 정지 | **높음** | README/DESIGN 구조도 갱신 | 예 — 리더보드를 담을 자리 |
| **R2** | C7-only 예외 정책 6곳 중복 | 중간 | 공용 헬퍼로 승격 | 아니오 |
| **R3** | near-miss 구조화 추출이 러너에 안 붙음 | 중간 | 러너에 호출 추가 | 아니오 |
| **R4** | game-summary가 6게임에 안 쓰임 | 중간 | 러너 마지막 단계에 자동 호출 추가 | 아니오 |
| **R6** | 참조 레포 출처/라이선스 미정리 | 중간 | CREDITS 표 신설 | 예 — 공개 문서화 전 필요 |
| **R8** | 리더보드 누적 문서 컨벤션 부재 | 낮음 | 다음 라운드에서 형태 결정 | 예 — 실험 설계와 함께 |

**우선순위 제안**: 3열 실험을 시작하려면 **R7(순수 승률 유틸) → R5(calibration
배선) → R1(README) → R6(출처 정리)**이 사실상 선행 작업이다. R2~R4는 품질
문제지 실험 착수를 막지는 않으므로 병행하거나 이연 가능.
