# ADR-0014 — StrategyFlagSpec 조립 종류 선언과 검증된 합성

- 상태: 채택됨 (2026-07-30, GAP-ANALYSIS-11 후속 — FIX-BACKLOG "registry 조립
  시맨틱 재설계")
- 관련: ADR-0002(search/learn 형제 계층), ADR-0011(트리 prior), ADR-0012(앵커
  래더), ADR-0013(포트폴리오)

## 맥락

`composeBot`(`src/loop/compose.ts`)은 `flags` 배열을 순서대로
`factory = spec.apply(factory)`로 체이닝한다. 그런데 탐색/학습 계열 플래그
(MCTS·IS-MCTS·완전 클론 등)의 `apply`는 전부 `apply: () => xBotFactory(...)`
형태로 **`base` 인자를 아예 받지 않고 무시**한다(설계 의도 — "챔피언 롤아웃"을
구현하려면 어차피 완전히 새로운 봇을 만들어야 하므로 정당한 패턴이다).

문제는 이것이 `composeBot`의 "순서대로 감싼다"는 암묵적 가정과 충돌할 때다:
한 웨이브에서 **복수 후보가 동시 채택**되면 승격 코드가 그냥
`flags: [...latest.flags, ...adoptedFlags]`로 이어 붙이는데, 배열에 터미널
플래그(base 무시)가 둘 이상 있거나 터미널 앞에 데코레이터가 있으면, **터미널이
아닌 아무것도 살아남지 않는다** — 배열의 마지막 항목만 실제 런타임 동작을
결정한다. 이 사실이 GAP-ANALYSIS-11에서 두 번 실측됐다:

- 오목 v6: `defensive-w16`이 마지막이라 `opening6-prior-w16`이 조립에서
  완전히 소실(Phase 4-A 발견).
- 도미니언 v4: `opusCloneDominion`이 마지막이라 `chapelEconomyV2`의 실측
  개선(L2 42.5%)이 registry 상 죽은 코드가 됨(Phase 4-C 발견).

두 사고 다 "버그가 아니라 우연히 최고 성능 후보가 마지막이라 무해했다"인데,
그 우연에 계속 기댈 수 없다.

## 결정

**1. 계약에 조립 종류를 데이터로 선언한다** — `strategySurface`·
`choiceEvaluator`와 동일한 원칙("어댑터가 데이터로 선언, 커널/루프는 실행만"):

```ts
export interface StrategyFlagSpec<TObservation, TChoice> {
  readonly flag: string;
  readonly description: string;
  readonly apply: (base: BotFactory<TObservation, TChoice>) => BotFactory<TObservation, TChoice>;
  /** 조립 종류(옵션, 미선언 시 'unknown' 취급 — 기존 동작·기존 registry
   *  재현에 전혀 영향 없음). 'decorator'는 base를 실제로 감싸 활용하는
   *  플래그, 'terminal'은 base를 완전히 무시하고 독립된 봇을 반환하는
   *  플래그(탐색/학습/클론 계열 전부 해당). ADR-0014. */
  readonly assembly?: 'decorator' | 'terminal';
}
```

**2. `composeBot`은 손대지 않는다.** 기존 100여 콜사이트·모든 기존
registry(v1~v7 등)의 재현 결과가 byte-for-byte 불변이어야 한다는 게 최우선
제약이다. 대신 **새 함수 3개**를 `loop/compose.ts`에 추가한다:

- `analyzeAssembly(adapter, flags): AssemblyAnalysis` — 순수 함수. 각 플래그의
  선언된 `assembly`(미선언 시 `'unknown'`)를 조회해 `errors`(선언된 터미널이
  2개 이상이거나, 터미널이 배열 첫 항목이 아닌 경우)와 `warnings`(조립 판단이
  불가능한 `'unknown'` 플래그 존재)를 낸다.
- `composeBotChecked(adapter, flags): AnyBotFactory` — `analyzeAssembly`의
  `errors`가 있으면 throw, 없으면 `composeBot`을 그대로 호출. **이후 모든
  신규 라운드의 승격 코드는 이 함수를 쓴다.**
- `assembleFlags(candidates): string[]` — 승격 시 다음 배열을 조립하는 순수
  헬퍼. 입력은 `{flag, assembly, challengeScore?}[]`(이전 챔피언의 생존
  플래그 + 이번 라운드 신규 채택 플래그 전부). 선언된 터미널이 여럿이면
  challengeScore 최고 1개만 남기고 나머지는 **배제**(재배치가 아니라 배제 —
  터미널은 자리를 옮겨도 base를 무시하므로 데코레이터로 강등할 수 없다),
  살아남은 터미널을 배열 맨 앞에, 데코레이터를 그 뒤에 원래 채택 순서대로
  배치. 배제된 후보는 반환값과 별도로 `excluded: {flag, reason}[]`에 기록해
  승격 로그에서 감추지 않는다.

**3. 기존 터미널 플래그 전체에 `assembly: 'terminal'`을 소급 선언한다**
(순수 메타데이터 추가 — `apply` 로직 무수정, 모든 게임의 기존 registry
재현이 회귀 테스트로 불변 확인돼야 채택). 대상: 6게임의 MCTS·IS-MCTS
shared 플래그 헬퍼 전부(`apply: () => ...BotFactory(...)` 패턴), 도미니언
`opusCloneDominion`, 오목의 prior/chain/defensive/combined/opusclone 계열
플래그. 명확히 데코레이터인 플래그(예: `blockImmediateThreat`,
`buyHighestPoints`)는 선언하지 않고 `'unknown'`으로 남긴다(선언 오분류보다
안전).

**4. 기존 registry(v1~v7 등)는 재작성하지 않는다.** `composeBot`이 불변이므로
과거 웨이브가 만든 조립 결과는 그대로 재현된다 — "우연히 무해했던" 상태를
정직한 역사로 보존한다. 새 규칙은 **다음 라운드(3회전 이후)의 승격 코드부터**
적용한다.

## 대안

- **`composeBot` 자체에 강제 검증을 내장**(옵션 인자로): 기각 — 기존
  콜사이트가 전부 옵션 없이 호출하므로 실질적으로 아무것도 안 바뀌고,
  시그니처만 복잡해진다. 별도 함수가 더 명확하고 위험이 0이다.
- **진짜 앙상블(다중 터미널 위원회 투표) 지원**: 훨씬 큰 기능(다중 봇 실행·
  투표 집계·비용 N배)이며 이번 문제(silent discard)의 최소 해법이 아니다.
  범위 밖으로 명시 이연 — 필요해지면 별도 ADR.
- **기존 registry 재작성(올바른 순서로 재승격)**: AdoptionLedger의 역사적
  사실(그 라운드에 실제로 무엇이 채택됐는가)을 왜곡하는 데다, 되돌리기 비싼
  겹치는 시드 뱅크 재사용 위험이 있어 기각. §4의 "재현 불변" 원칙 유지.

## 결과

- 다음부터 복수 채택 라운드가 조립 오류를 **조용히 삼키지 않고 즉시 throw**로
  드러낸다(`composeBotChecked`). "터미널 2개, 마지막만 생존"이 설계 결함에서
  검증 가능한 불변조건 위반으로 격상됐다.
- 리스크: `'unknown'` 플래그가 섞인 라운드는 여전히 미검증 구간이 남는다 —
  신규 플래그를 만들 때 `assembly`를 선언하는 습관이 안전판의 전제다. 이건
  강제가 아니라 컨벤션이므로 코드 리뷰(다음 라운드 설계 시 메인 루프 점검)로
  보완한다.
