# 갭 분석 13 — 셀프서브 온보딩: "게임만 준비하면 따라만 해도 온보딩되는" 장치 (2026-08-02)

> 사용자 지시: "사용자가 쉽게 루프 포지를 사용할 수 있도록 장치가 필요해.
> 그냥 자신의 게임만 준비한 상태에서, 정확한 절차와 납득 가능한 수치를
> 순서대로 그냥 따라만 하면 온보딩되는 상태로 이어질 수 있도록."
> ROADMAP v3("온보딩 자동화 — self-serve 온보딩")의 구체 설계이기도 하다.

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
사용자                          장치가 하는 일
──────────────────────────────────────────────────────────────
npm run onboard                → 범위 자가진단 3문항(턴제/경쟁/게임간독립)
                                 → 부적합이면 §0 표의 사유와 함께 즉시 중단
npm run onboard -- profile     → GameProfile 템플릿 파일 생성 + "이 파일을
                                 채워달라"는 에이전트용 프롬프트 출력
  (에이전트가 프로필 채움)      → parseGameProfile 스키마 검증 = G1 게이트
npm run onboard -- scaffold    → 프로필을 읽고 아키타입 자동 판정 →
                                 해당 템플릿으로 어댑터 골격 + 러너 생성
  (에이전트가 TODO 채움)        → TODO 마커 0개 + tsc 0에러 = G2 게이트
npm run onboard -- score       → 채점 실행, blocker별 수정 지침 출력
  (에이전트가 blocker 수정)     → 반복. blocker 0(C7 제외) = G3 게이트
npm run onboard -- wave        → 캘리브레이션 → 첫 웨이브 자동 발주
                               → WaveReport + summary.md = G4 완료(온보딩 끝)
```

각 단계에서 명령은 항상 같고(`npm run onboard -- <stage>`), 장치가
현재 스테이지를 `runs/<gameId>/onboarding-state.json`으로 기억하므로
사용자는 "다음에 뭘 치지?"를 고민하지 않는다 — 인자 없이 `npm run onboard`만
치면 현재 스테이지와 다음 행동(에이전트에게 줄 프롬프트 포함)을 다시
출력한다.

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

## 3. 처치 설계 S1~S5

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
| B | S2 스캐폴드 생성기 + 템플릿 4종 + 자기 검증(스캐폴드 산출물이 tsc 통과·TODO 마커 grep 가능) | Sonnet 1개 | A(러너 골격이 S1 호출형이어야 함) |
| C | S3 CLI + 상태 머신 + package.json 스크립트 | Sonnet 1개 | A, B |
| D | S4 플레이북 + S5 README 교체 | 메인 루프 직접(문서) | C(CLI 출력과 상호 참조) |
| E | **종단 검증**: 저장소에 없는 새 미니 게임 1종(예: 간단한 connect-four)을 플레이북만 보고 처음부터 온보딩 — 문서·도구 외 지식을 쓰지 않는 것을 성공 기준으로 | Sonnet 1개(신선한 컨텍스트, 이 설계 문서 미제공) | D |

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
