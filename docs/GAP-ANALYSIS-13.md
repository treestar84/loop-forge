# 갭 분석 13 — 셀프서브 온보딩: "게임만 준비하면 따라만 해도 온보딩되는" 장치 (2026-08-02, v2)

> 사용자 지시: "사용자가 쉽게 루프 포지를 사용할 수 있도록 장치가 필요해.
> 그냥 자신의 게임만 준비한 상태에서, 정확한 절차와 납득 가능한 수치를
> 순서대로 그냥 따라만 하면 온보딩되는 상태로 이어질 수 있도록."
> ROADMAP v3("온보딩 자동화 — self-serve 온보딩")의 구체 설계이기도 하다.
>
> **v2 개정(2026-08-03, 사용자 2차 지시 반영)**: `npm run onboard` 첫 실행이
> **진단 리포트**로 끝나야 한다 — ① 게임 구현을 더 해야 하는지, ② 지금
> 상태로 루프포지를 돌릴 수 있는지, ③ 지금 상태의 적합도를 수치(%)로,
> ④ 그 게임의 **룰북**(어떤 룰 시스템인지 + 무엇을 보완 구현해야 하는지),
> ⑤ 근본적으로 부적합하다면 **불가능 사유서**. 이를 위해 S0(진단 스테이지)과
> P-Score(사전 준비도 산식)를 신설했다(§2.5, §3의 S0).

## 0. 문제 — 지금은 왜 "따라만 하면" 안 되는가 (실측 근거)

9개 게임을 온보딩해 본 지금, 절차 자체는 검증됐지만 **절차의 전달 방식**이
사람(또는 코딩 에이전트)의 사전 지식에 의존한다:

| # | 실측 사실 | 결과 |
|---|---|---|
| 0.1 | README "내 게임에 적용하기"의 5단계 표는 순서만 주고, 실제 작업량의 대부분이 있는 `ONBOARDING-GUIDE.md` §2 체크리스트 12항목·장르별 특수 규칙(§5~§7)은 링크 뒤에 숨어 있다 | README만 읽은 사용자는 2단계(어댑터 구현)에서 막힌다 |
| 0.2 | 게임별 러너가 전부 수제다 — `runners/catan.ts` 402줄, `runners/gomoku.ts` 1,230줄. 내용은 동일한 6단계 파이프라인(scoreAdapter → evaluateWaveReadiness → measureNoiseFloor/recommendBlockCount → assembleWaveConfig → runWave → summary/승격)의 복사·변형 | 새 게임마다 400줄+ 러너를 기존 러너를 "보고 베껴" 작성해야 한다. 포트폴리오 라운드에서 E1(GAP-12)로 이미 실증된 것과 동일한 복붙 부채 |
| 0.3 | 어댑터 시작점이 없다 — "gomoku.ts를 템플릿으로 써라"는 구전 규칙뿐. 완전정보/은닉정보/멀티스텝/콘텐츠헤비 중 어느 선례를 베껴야 하는지는 사람이 판단 | 잘못된 템플릿 선택 시 G-Convert 중반에 구조 재작업 |
| 0.4 | 진행 상태·통과 기준이 산출물에 없다 — "지금 몇 단계이고, 이 숫자가 나오면 다음으로 간다"가 문서 4곳(README·ONBOARDING-GUIDE·DESIGN §4·INTERPRETATION)에 분산 | 사용자가 "끝났는지"를 스스로 판정 못 함 |
| 0.5 | 채점→수정→재채점 반복 루프의 반복 명령이 게임별로 다르다(러너 파일명을 알아야 실행 가능) | "그냥 따라하기" 불가능 — 파일명 규칙이라는 암묵지 필요 |

**문제의 본질**: 커널·게이트·수치 기준은 전부 존재하고 9게임에서 검증까지
끝났다. 없는 것은 ① 그 절차를 **기계가 안내하는 단일 진입점**, ② 어댑터
**시작점(스캐폴드)**, ③ **스테이지별 통과 수치의 단일 표**, ④ 코딩
에이전트에게 줄 **복붙 프롬프트 시퀀스**다.

**자동화되지 않는 것(정직하게 미리 선언)**: G-Convert의 본질 — 원본 게임
규칙을 headless 어댑터로 재구현하는 코드 작업 — 은 이 장치로 사라지지
않는다. 이 장치가 하는 일은 그 작업을 "**어디서 시작해, 무엇을 채우고,
어떤 숫자가 나오면 통과인지**"가 전부 기계 판정되는 형태로 바꾸는 것이다.
코드 작성 자체는 여전히 사용자 곁의 코딩 에이전트(Claude Code 등)가 한다.

## 1. 목표 사용자 여정 (설계의 요구사항)

준비물: **자기 게임의 소스코드(또는 정확한 규칙 문서) 하나**. Loop Forge
저장소 clone + `npm install` + 코딩 에이전트.

```
사용자                              장치가 하는 일
──────────────────────────────────────────────────────────────────────
npm run onboard -- <내 게임 경로>   [S0 진단 — 이 한 번으로 아래 5개 답이 나온다]
                                   1. 게임 소스 스캔(파일 트리·언어·규모) — 기계
                                   2. GameProfile 작성 — 에이전트(자동 호출 가능
                                      시 자동, 아니면 프롬프트 제공) → 스키마
                                      검증 루프(parseGameProfile) = G1
                                   3. G0 범위 판정 — 불가능이면 불가능 사유서
                                      출력 후 종료(§2.5 판정 3단계)
                                   4. P-Score 산출 — 사전 준비도 %(§2.5 산식,
                                      항목별 근거 포함)
                                   5. RULEBOOK.md 생성 — 룰 시스템 분류 +
                                      보완 구현 목록(§3 S0)
                                   6. 진단 리포트 출력:
                                      · 지금 돌릴 수 있는가? (판정 3단계)
                                      · 게임 구현을 더 해야 하는가? (보완 목록)
                                      · 적합도 몇 %인가? (P-Score/C-Score)
                                      · 다음 행동은? (scaffold 명령 + 프롬프트)
npm run onboard -- scaffold        → 아키타입 판정 → 어댑터 골격+러너 생성
  (에이전트가 TODO 채움)            → TODO 마커 0개 + tsc 0에러 = G2 게이트
npm run onboard -- score           → 채점, blocker별 수정 지침. 반복.
  (에이전트가 blocker 수정)         → blocker 0(C7 제외) = G3 게이트.
                                     이 시점부터 %는 P-Score(추정)가 아니라
                                     C-Score(실측)로 대체된다
npm run onboard -- wave            → 캘리브레이션 → 첫 웨이브 자동 발주
                                   → WaveReport + summary.md = G4 완료
```

각 단계에서 명령은 항상 같고(`npm run onboard -- <stage>`), 장치가
현재 스테이지를 `runs/<gameId>/onboarding-state.json`으로 기억하므로
사용자는 "다음에 뭘 치지?"를 고민하지 않는다 — 인자 없이 `npm run onboard`만
치면 현재 스테이지와 다음 행동(에이전트에게 줄 프롬프트 포함)을 다시
출력한다.

**프로필 작성의 자동화 수준(정직한 경계)**: 임의의 외부 게임 소스를 읽고
GameProfile을 채우는 것은 정적 도구로 불가능하고 코딩 에이전트가 필요하다.
CLI는 헤드리스 에이전트(`claude -p` 등)가 감지되면 이 단계를 자동 실행하고,
없으면 완성된 프롬프트를 출력해 사용자가 자기 에이전트에 붙여넣게 한다 —
어느 쪽이든 품질 안전망은 동일하다(`parseGameProfile` 스키마 검증을 통과할
때까지 반복). 프로필 이후의 모든 단계(판정·P-Score·룰북 렌더링)는 순수
기계 연산이다.

## 2. 게이트 수치표 — "납득 가능한 수치" (전부 기존 코드의 실존 기준)

새로 발명한 숫자는 없다. 이미 코드에 있는 판정 기준을 스테이지별 단일 표로
승격한 것이다:

| 게이트 | 스테이지 | 통과 기준 | 판정 주체(기존 코드) |
|---|---|---|---|
| G0 범위 | 자가진단 | 턴제 · 경쟁(2인+) · 게임 간 독립, 3문항 전부 예 | 질문지(ONBOARDING-GUIDE §0 표) |
| G1 프로필 | G-Profile | 스키마 검증 통과(필수 필드·결정지점·무작위성 원천·은닉 경계·종국 보장 규칙 전부 기입) | `parseGameProfile` (onboarding/profile.ts) |
| G2 골격 | G-Convert | `TODO(onboard)` 마커 0개 + `tsc --noEmit` 0에러 | grep + tsc |
| G3 적합성 | G-Score | C7 제외 blocker 0개 (= overall ≥80, C1 결정론 재현 100%, C5 identity 50%±CI 포함) | `scoreAdapter` + `evaluateWaveReadiness` |
| G4 첫 웨이브 | 캘리브레이션+웨이브 | noise floor 측정 → 블록 수 권고(5~30 클램프) → WaveReport 생성(verdict 분류 무관 — **실패 verdict도 온보딩 성공**이다. 온보딩의 완료 조건은 "루프가 돌 수 있는 상태"이지 "채택이 나온 상태"가 아니다) | `measureNoiseFloor`/`recommendBlockCount`/`runWave` |
| (참고) C7 | G-Parity | 원본 리플레이 없으면 60점 캡 — 온보딩을 막지 않되 경고로 표시 | `evaluateWaveReadiness`의 warnings 경로 (기존 동작 그대로) |

## 2.5 P-Score — 사전 준비도 산식과 판정 3단계 (v2 신설)

**두 수치를 구분한다(정직성 원칙)**: 어댑터가 완성되기 전의 %는 프로필
기반 **추정치(P-Score)** 이고, 어댑터가 생긴 뒤에는 `scoreAdapter` 실측
**C-Score**가 그 자리를 대체한다. CLI와 룰북은 항상 어느 쪽인지 라벨을
붙여 출력한다("추정 준비도 78% — 어댑터 완성 후 실측으로 대체됨").

P-Score 산식 — 각 가중치는 이 저장소에서 실제로 터졌던 사고에 근거한다
(새로 발명한 항목 없음):

| 항목 | 가중치 | 채점 방법(프로필 필드) | 가중치의 실측 근거 |
|---|---|---|---|
| P2 무작위성 시드화 | 25 | `randomnessSources[].seedable=true` 비율 × 25 | C1 결정론이 전체 파이프라인의 전제(DESIGN §4) — 하나라도 시드 불가면 재현·통계 전부 무효 |
| P3 결정 지점 이산성 | 20 | 모든 `decisionPoints`가 유한 열거 가능한 선택지인지(자유 텍스트·연속값 행동이 있으면 해당 비율만큼 감점) | 자유 대화 협상이 범위 제외된 이유(ONBOARDING-GUIDE §0) — 이산화 안 되는 행동 공간은 `getLegalChoices`로 표현 불가 |
| P4 은닉 경계 명확성 | 15 | `hiddenInformation[].hiddenFrom`이 전부 구체적으로 명시됐는지(완전정보 게임은 자동 만점) | 티추 observationBuilder 오염 사고 — 경계가 모호하면 C3에서 반드시 잡히고 재작업 |
| P5 종국 보장 규칙 | 15 | `outcomeRule`에 유한 종료 보장(턴 상한/무진행 규칙 등)이 명시됐는지 | 스플랜더 데드락 실측(GAP-4 Z7) — 원본 소스에 없는 경우가 실제로 있었음 |
| P6 룰-UI 분리 용이성 | 15 | `uiCouplingNotes` 항목 수·심각도(룰이 UI 핸들러에 박혀 있을수록 감점) | G-Convert 최대 작업량이 룰 엔진 분리 — 결합도가 곧 재구현 비용 |
| P7 참조 구현 완전성 | 10 | 규칙이 실행 가능한 코드로 존재(만점) / 부분 코드+문서(절반) / 문서만(0) | 코드 없이 규칙 문서만 있으면 에이전트 추측 비율이 올라가 G-Parity 증명력도 함께 하락 |

합계 100. P1(범위 적합: 턴제·경쟁·게임간독립)은 점수 항목이 아니라
**게이트**다 — 하나라도 실패하면 %를 계산하지 않고 아래 "불가능" 판정으로
직행한다(94%짜리 실시간 게임 같은 오해를 원천 차단).

**판정 3단계** (진단 리포트의 첫 줄):

| 판정 | 조건 | 리포트가 답하는 것 |
|---|---|---|
| **불가능** | P1 게이트 실패 | 어느 전제가 왜 깨지는지 + 구현을 아무리 해도 안 되는 이유 + 로드맵 여부(협력 게임=로드맵에 있음, 실시간=지원 계획 없음 — ONBOARDING-GUIDE §0 표 그대로) |
| **구현 필요** | P1 통과 + 어댑터 없음(또는 G3 미달) | P-Score X%(추정) + 룰북의 보완 목록(무엇을 구현해야 하는지, P-Score 감점 항목 순) + scaffold 다음 행동 |
| **실행 가능** | 어댑터 존재 + G3 통과 | C-Score 실측(C0~C8 축별) + "지금 바로 `npm run onboard -- wave`로 루프를 돌릴 수 있다" |

## 3. 처치 설계 S0~S5

### S0. 진단 스테이지 — 첫 실행의 산출물 (v2 신설)

`npm run onboard -- <게임 경로>` 첫 실행이 만드는 것:

1. **`runs/<gameId>/RULEBOOK.md`** — GameProfile을 사람이 읽는 룰북으로
   렌더링: ① 룰 시스템 분류(페이즈 구조, 턴 순서, 결정 지점 표, 무작위성
   원천 표, 은닉 정보 경계 표, 승패·종국 규칙), ② 루프포지 관점의 특성
   (완전정보/은닉, 멀티스텝 턴 여부, 예상 아키타입 — 어댑터 완성 후에는
   `classifyGame` 실측 분류로 갱신), ③ **보완 구현 목록**(P-Score 감점
   항목별로 "무엇을 왜 고쳐야 하는지 + 가이드 해당 절 링크", 감점 큰 순),
   ④ 판정문(§2.5의 3단계 중 하나 + 수치 + 수치의 종류 라벨).
2. **`runs/<gameId>/onboarding-state.json`** — 상태 머신 초기화(S3와 공유).
3. 콘솔 진단 리포트 — 룰북의 판정문 + 다음 행동 요약.

렌더러는 순수 함수(`artifacts/` 계층, 프로필 → 마크다운)로 두고 CLI가
호출한다. 불가능 판정의 사유서도 같은 렌더러가 만든다 — §0 표의 제외
계열별로 "왜 구현으로도 해결되지 않는지"(예: 실시간 게임은 턴제 AEC 모델과
근본 불일치라 어댑터 계약 자체가 표현 불가) 문구를 데이터로 갖는다.

### S1. 온보딩 파이프라인 실행기 추출 — `artifacts/onboarding-pipeline.ts`

E1(portfolio-round.ts)과 동일한 수법: 최신 세대 러너(catan.ts)의 6단계를
게임 중립 함수 `runOnboardingPipeline(adapter, config)`로 추출한다.
결정론 규칙 준수(artifacts/ 계층이므로 `recordedAt`/`clockNowMs`는
호출자 주입 — portfolio-round.ts와 동일 패턴). **검증법도 E1과 동일**:
기존 러너 중 2개(장르가 다른 catan + gomoku 첫 웨이브 구간)를 이 함수로
리팩터해 재실행 → 기존 산출물과 필드 일치 확인. 기존 러너들은 재작성하지
않는다(과거 재현성 보존 — E8 처리 때와 같은 원칙).

### S2. 스캐폴드 생성기 — 아키타입 4종 템플릿

`npm run onboard -- scaffold`가 GameProfile을 읽고 아키타입을 판정해
`src/reference/<gameId>.ts`(어댑터 골격)와
`src/reference/runners/<gameId>.ts`(S1 파이프라인을 호출하는 ~40줄 러너)를
생성한다.

| 아키타입 | 판정 근거(프로필 필드) | 템플릿 모델 |
|---|---|---|
| perfect-info | `hiddenInformation` 비어 있음 | gomoku.ts |
| hidden-info | `hiddenInformation` 존재 | dominion.ts (hiddenInfoProbe·결정화 훅 골격 포함) |
| multi-step-turn | `decisionPoints` 중 한 턴 복수 결정 선언 | splendor.ts (`takenColors` 패턴 골격) |
| content-heavy | `knownIssues`/카드 인벤토리 규모 선언 | hearthstone.ts (콘텐츠 커버리지 주석 포함) |

골격의 모든 미완성 지점은 `// TODO(onboard): <ONBOARDING-GUIDE §2 체크리스트
항목 번호> — <한 줄 설명>` 형식 마커로 표시한다 — G2 게이트(grep 0개)의
판정 대상이자, 코딩 에이전트에게는 "다음에 채울 곳"의 기계가독 목록이 된다.
아키타입은 조합될 수 있으므로(예: 은닉+멀티스텝) 판정은 배타가 아니라
**골격 조각의 합성**으로 구현한다(기본 골격 + 해당하는 조각 추가).

### S3. 상태 머신 + 단일 CLI — `runners/onboard-cli.ts`

앱 경계(runners/)에 CLI를 둔다(`Date.now()` 허용 계층).
`runs/<gameId>/onboarding-state.json`에 `{ gameId, stage, gates: {g0..g4},
lastScoreReport, nextAction }`을 기록하고, 인자 없는 `npm run onboard`는
이 상태를 읽어 **현재 스테이지 + §2 게이트 수치 + 에이전트에게 줄 다음
프롬프트**를 그대로 출력한다. `package.json`에 `"onboard": "ts-node
src/reference/runners/onboard-cli.ts"` 스크립트 추가.

### S4. 플레이북 — `docs/ONBOARDING-PLAYBOOK.md`

스테이지당 1블록, 각 블록은 ① 사용자가 칠 명령, ② 코딩 에이전트에게
복붙할 프롬프트(ONBOARDING-GUIDE의 해당 절 링크 포함), ③ 통과 수치(§2 표의
해당 행), ④ 흔한 실패와 처방(기존 TROUBLESHOOTING 사례 인용) 순서로
구성한다. CLI(S3)의 `nextAction` 출력이 이 문서의 해당 블록을 가리키므로
문서와 도구가 서로를 참조한다. ONBOARDING-GUIDE.md는 심층 정본으로
유지하고, 플레이북은 "절차 순서와 프롬프트"만 담아 중복을 피한다.

### S5. README "내 게임에 적용하기" 교체

기존 5단계 표(프롬프트 나열)를 `npm run onboard` 여정 + §2 게이트 수치표
요약 + 플레이북 링크로 교체한다. "이미 봇(NPC)이 있는 게임" 과장 표현을
"게임 규칙의 동작하는 구현(또는 정확한 규칙 문서)만 있으면 된다"로 정정
(기준선 봇은 온보딩 과정에서 새로 만들어지므로 기존 봇은 필수가 아니다).

## 4. 구현 계획 (역할 규약: 설계=메인 루프, 구현=Sonnet 위임)

| Phase | 내용 | 위임 단위 | 의존 |
|---|---|---|---|
| A | S1 파이프라인 추출 + 리팩터 검증(catan·gomoku 필드 일치) | Sonnet 1개 | — |
| A′ | S0 진단 계층 — P-Score 산식(`onboarding/readiness-estimate.ts`, §2.5 표 그대로) + 룰북 렌더러(`artifacts/rulebook.ts`) + 프로필 스키마 추가 필드(결정지점 이산성·종국 보장 명시 여부 등, 전부 additive) + 단위테스트(제외 계열별 불가능 사유서·9게임 프로필 재사용 채점) | Sonnet 1개 (A와 병렬 가능) | — |
| B | S2 스캐폴드 생성기 + 템플릿 4종 + 자기 검증(스캐폴드 산출물이 tsc 통과·TODO 마커 grep 가능) | Sonnet 1개 | A(러너 골격이 S1 호출형이어야 함) |
| C | S3 CLI + 상태 머신 + package.json 스크립트 + S0 진단 흐름 배선(헤드리스 에이전트 감지 포함) | Sonnet 1개 | A, A′, B |
| D | S4 플레이북 + S5 README 교체 | 메인 루프 직접(문서) | C(CLI 출력과 상호 참조) |
| E | **종단 검증**: 저장소에 없는 새 미니 게임 1종(예: 간단한 connect-four)을 플레이북만 보고 처음부터 온보딩 — 문서·도구 외 지식을 쓰지 않는 것을 성공 기준으로. 진단 리포트의 P-Score와 완주 후 C-Score의 괴리도 함께 기록(산식 보정 입력) | Sonnet 1개(신선한 컨텍스트, 이 설계 문서 미제공) | D |

Phase E가 이 설계 전체의 진짜 판정 실험이다: "따라만 하면 되는가"는
주장이 아니라 **처음 보는 에이전트가 플레이북만으로 완주하는지**로
실측한다. 완주 실패 지점은 그대로 플레이북/CLI의 수정 입력이 된다.

## 5. 리스크와 한계 (감추지 않는다)

- **G-Convert의 난이도는 게임이 정한다**: 스캐폴드가 시작점을 주더라도
  콘텐츠 헤비 게임(카드 수백 종)의 재구현 노력 자체는 줄지 않는다. 장치의
  약속은 "절차 미로에서 길을 잃지 않는 것"이지 "코딩량 감소"가 아니다.
- **아키타입 오판정 가능성**: 프로필 기반 자동 판정이 틀리면(예: 은닉이
  지엽적인데 hidden-info로 판정) 불필요한 골격이 생긴다 — 스캐폴드 출력에
  판정 근거를 명시하고 `--archetype` 수동 오버라이드를 둔다.
- **CLI·플레이북·가이드 3중 문서화의 드리프트**: 게이트 수치를 세 곳에
  복사하면 반드시 어긋난다 — 수치의 정본은 코드(§2 표의 판정 주체)이고,
  CLI가 코드에서 직접 읽어 출력하며, 문서는 표를 한 곳(이 문서 §2)만
  가리키게 한다.
- **기존 9게임은 이 경로로 재온보딩하지 않는다** — 새 장치는 새 게임
  전용이고, 기존 러너·산출물은 그대로 둔다(과거 재현성).

## 6. S1 실행 기록 (2026-08-03, Phase A 완료)

`src/artifacts/onboarding-pipeline.ts`의 `runOnboardingPipeline()`으로
6단계(노이즈플로어 캘리브레이션→registry/ledger 부트스트랩→v1+앵커
등록→웨이브 조립→웨이브 실행→요약/승격: near-miss 추출·registry
승격·`renderGameSummaryMarkdown`·`saveRegistry`/`saveLedger`) 추출 완료.
**새 알고리즘 없이 catan.ts·gomoku.ts 첫 웨이브 구간의 기존 로직을 그대로
옮긴 것.**

**설계에서 조정한 1건(사전 지시대로 사유 기록)**: G-Score conformance
(`scoreAdapter`/`evaluateWaveReadiness`)는 이 함수 범위 밖에 뒀다.
`dependency-rules.test.ts`가 `artifacts/`→`onboarding/` import를 금지하기
때문(§0 표에는 conformance부터 파이프라인이 시작하는 것처럼 서술돼 있었지만,
실제로는 계층 규칙 위반). `artifacts/game-summary.ts`가 이미 같은 벽에
부딪혀 온보딩 리포트 타입을 duck-typing으로 우회한 선례가 있어, 이 파일도
conformance 단계 전체를 호출자(앱 경계)에게 남기고 노이즈플로어 캘리브레이션
단계부터 시작하도록 조정했다. 호출자는 `evaluateWaveReadiness(...).proceed`가
true일 때만 `runOnboardingPipeline`을 호출한다.

이탈(명세 보완, portfolio-round.ts의 `recordedAt`/`clockNowMs` 주입 패턴과
동일한 동기) 3건: ① 단일 `recordedAt`이 catan.ts/gomoku.ts의 여러 개별
`now()` 호출을 대신함(어느 것도 `comparabilityKey`/`reportDigest`에 들어가지
않음을 `loop/wave-runner.ts`로 확인) ② 시드뱅크 `bankId` 문자열은 게임ID로부터
자동 생성하지 않고 호출자가 그대로 주입(bankId가 `computeComparabilityKey`의
`seedBankIds`에 들어가 `comparabilityKey`/`reportDigest`를 바꾸므로, catan
웨이브A의 `-a` 접미사 같은 과거 관례를 자동유추가 아니라 값으로 보존해야
과거 웨이브를 바이트 단위로 재현 가능) ③ 웨이브의 `RunStore.saveRun` 저장을
포함(§3 S1 한 줄 요약이 명시하지 않았지만, 빠지면 `runs/<gameId>/<waveId>/`
런 레코드 자체가 사라져 이 절이 요구하는 필드 일치 확인이 애초에 성립하지
않음).

**검증(E1과 동일 수법 — 리팩터 전후 같은 시드로 재실행 후 필드 일치 확인)**:

| 게임 | 재실행 방식 | registry.json | near-miss.json | ledger.json(신규 항목) | summary.md |
|---|---|---|---|---|---|
| catan | wave A만 파이프라인 호출, wave B는 그대로 손코딩 유지 | 완전 일치(diff 없음) | 완전 일치(diff 없음, 빈 배열) | `runner-wave-single-opponent`·`runner-wave-field-mix` 두 항목 모두 `recordedAt` 제외 완전 일치(roadExpansionPriority smoke winRate=0.183, eagerBankTrade=0.125 등 수치 그대로) | 웨이브 재실행 누적분(2→4개 웨이브 기록)만 차이, 나머지 텍스트 동일 |
| gomoku | 첫 웨이브 구간만 파이프라인 호출(8) MCTS 웨이브 이후는 그대로 손코딩 유지) | 완전 일치(diff 없음) | 완전 일치(diff 없음, 빈 배열) | 기존 3후보(blockImmediateThreat·centerProximity·extendLongestLine) `recordedAt` 제외 완전 일치 + 어댑터가 그 사이 늘린 4번째 후보(forkAwareness, 리팩터와 무관한 별개 변경)가 추가로 채택됨 | registry가 이미 v9까지 진행된 현재 상태를 재반영(원본 백업의 summary.md가 그보다 오래된 스냅샷이라 발생하는 차이, 리팩터와 무관) |

재실행은 프로덕션 `runs/`(메인 체크아웃에 심링크)를 건드리지 않도록 격리된
임시 `runs/` 복사본에서 순차로(동시 1개) 수행했고, 종료 후 프로덕션 상태가
그대로임을 diff로 재확인했다. 재실행 중 `runs/dominion`·`runs/gomoku`의
`challenge-l2*` 디렉터리(judgment/loss-report 전용, `payload.json` 없음)를
`RunStore.listRuns()`가 전체 게임을 스캔하며 읽으려다 던지는 사전 존재 크래시를
발견했다(`renderGameSummaryMarkdown`→`RunStore.listRuns()`가 게임ID로
스코프되지 않고 `runs/*/*` 전체를 스캔) — **이 리팩터로 생긴 버그가 아니라
원본 catan.ts/gomoku.ts도 동일하게 겪는 기존 결함**이므로 이번 작업 범위에서
고치지 않고 별도 트래킹이 필요함을 남긴다(FIX-BACKLOG.md 후보).

`npm run typecheck` 0에러, `npm test` 64 suites/841 tests 전부 통과
(dependency-rules.test.ts의 계층 규칙·결정론 규칙 포함).

기존 다른 7개 게임 러너는 손대지 않음(과거 재현성 보존).

## 7. S0 실행 기록 (Phase A′, 2026-08-03)

Phase A′(S0 진단 계층)를 구현했다. 만든 것과 테스트가 증명하는 것:

**`src/onboarding/profile.ts` — additive 필드 확장**: 기존 필드·시그니처는
전혀 바꾸지 않고 전부 옵션 필드만 추가했다.
`GameProfileDecisionPoint.enumerable?: boolean`(P3),
`GameProfileHiddenInformation.boundaryExplicit?: boolean`(P4),
`GameProfile.terminationGuarantee?: string`(P5),
`GameProfile.uiCouplingSeverity?: 'none'|'low'|'medium'|'high'`(P6),
`GameProfile.referenceImplementation?: 'full-code'|'partial'|'document-only'`(P7),
`GameProfile.{turnBased,competitive,independentGames,decisionsStructurable}?: boolean`(P1
게이트, ONBOARDING-GUIDE.md §0의 제외 계열 4행에 1:1 대응). 미기입 시 채점
처리는 두 방향으로 정직하게 갈렸다: **P1 게이트 플래그는 미기입 시 통과로
간주**(대부분의 게임은 이 플래그를 선언할 필요가 없으므로, 기존 9게임
프로필에 소급 적용해도 갑자기 불가능 판정이 나지 않게), **P2~P7 채점 필드는
미기입 시 보수적으로 감점**(그 항목의 최저점 또는 0점 처리, 근거 문자열에
"미기입" 명시). `exactOptionalPropertyTypes: true`라 옵셔널 필드는 항상
`...(x !== undefined ? {x} : {})` 조건부 스프레드로 채워야 했다(기존
`artifacts/baseline-registry.ts` 등의 관행과 동일).

**`src/onboarding/readiness-estimate.ts` (신설)**: `estimateReadiness(profile)`
순수 함수. P1 게이트(4문항) 평가 후 실패 시 `{verdict:'impossible', gate}`로
즉시 반환(백분율 계산 안 함). 통과 시 P2~P7 6개 항목을 §2.5 표의 가중치·채점
방법대로 계산해 `{verdict:'estimate', gate, items, totalScore}` 반환. 이
모듈은 onboarding/profile.ts 하나에만 의존한다(readiness-estimate.ts는
`import`를 profile.ts에서만 한다 — dependency-rules.test.ts가 이를 기계적으로
강제).

**`src/artifacts/rulebook.ts` (신설)**: `renderRulebook(profile, estimate,
options?)` 순수 함수, Markdown 문자열 반환. §3 S0의 4요소(룰 시스템 분류/
루프포지 관점 특성/보완 구현 목록/판정문)를 전부 렌더링한다. **artifacts는
onboarding을 import할 수 없다는 계층 규칙**(dependency-rules.test.ts)을
지키기 위해 `GameProfile`/`ReadinessEstimate`를 다시 import하지 않고
`game-summary.ts`의 `ConformanceReportShape` 관행과 동일하게 구조적으로
동일한 shape을 로컬에 재선언해 duck-typing으로 받는다. `Date.now()`는 전혀
쓰지 않고, 필요하면 호출자가 `options.generatedAtLabel` 문자열을 주입한다.
판정문은 항상 수치 종류 라벨("**추정**", 어댑터 완성 후 C-Score로 대체됨)을
명시한다. 불가능 판정에서는 백분율 대신 게이트 실패 사유서(왜 구현으로도
해결되지 않는지)를 렌더링한다.

**테스트가 증명하는 것**:

- `src/onboarding/__tests__/readiness-estimate.test.ts` — ① 오목(완전정보)·
  도미니언(은닉정보, `boundaryExplicit:true`로 P4 만점)·카탄(6인, 대인원)
  세 게임의 실제 특성을 반영한 프로필을 만들어 `estimateReadiness`가
  `verdict:'estimate'`와 90%대 총점을 낸다(합리적 점수). ② 4종 제외 계열
  (`turnBased:false`=실시간, `competitive:false`=협력, `independentGames:false`
  =캠페인, `decisionsStructurable:false`=자유협상) 각각 `verdict:'impossible'`
  과 ONBOARDING-GUIDE.md §0 표 그대로의 사유 문자열(지원 계획 없음/로드맵/
  getLegalChoices 등 키워드)을 낸다. ③ `randomnessSources`에 시드 불가
  원천이 일부 있으면 P2가 비율대로(1/2 seedable → 25점 만점 중 13점) 깎인다.
  ④ `enumerable`/`terminationGuarantee`/`referenceImplementation` 미기입이
  각각 P3/P5/P7을 보수적으로 0점 처리하는지 별도 검증.
- `src/artifacts/__tests__/rulebook.test.ts` — ① "구현 필요" 판정문에
  "추정"·백분율이 포함되는지, ② 보완 목록이 감점 큰 순(P5 15점 손실 →
  P7 10점 손실)으로 정렬되고 ONBOARDING-GUIDE.md 링크를 포함하는지(만점
  항목은 목록에서 제외), ③ 불가능 판정에서 백분율 없이 "구현으로도
  해결되지 않는다" 사유서가 나오는지, ④ 완전정보/은닉정보 분류가
  `hiddenInformation` 유무로 올바르게 갈리는지.
- `src/__tests__/dependency-rules.test.ts` — 기존 테스트를 그대로 재실행해
  onboarding/readiness-estimate.ts와 artifacts/rulebook.ts가 계층 규칙(특히
  artifacts→onboarding 금지, Date.now 금지)을 위반하지 않음을 확인.

**검증**: `npm run typecheck` 0에러. `npm test` 66개 스위트 867개 테스트 전체
통과(신규 파일 2개가 24개 테스트 추가, 나머지는 기존 회귀 없음 확인). 무거운
실행(자기대국·웨이브 등) 없음 — 이 Phase는 순수 함수 계산과 문자열 렌더링만
다룬다.
