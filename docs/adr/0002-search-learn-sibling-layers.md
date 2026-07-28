# ADR-0002 — search/·learn/을 kernel의 형제 계층으로 배치

**상태**: 채택됨 (2026-07-23)

## 맥락

탐색(MCTS/IS-MCTS)·학습(MCCFR) 알고리즘을 어느 계층에 둘지 결정해야 했다.
`loop/` 안에 두면 웨이브 러너와 강하게 결합되고, `kernel/` 안에 두면 게임 중립
원칙은 지키지만 `kernel`이 지금까지 "숫자·시드·digest만 다루는" 순수 통계
계층이었다는 정체성이 흐려진다.

## 결정

`search/`·`learn/`을 `kernel`과 같은 층위의 **형제 계층**으로 신설한다.
의존 방향은 `search/learn → contract, kernel`(kernel이 이들을 모름 — 반대
방향 의존 없음). 산출물은 전부 평범한 `BotFactory`라 `loop`는 이들의 존재를
전혀 모른다 — 러너(앱 경계)가 `withStrategyFlags`로 어댑터에 후보 플래그를
얹어 웨이브에 주입한다.

## 대안

- **`loop/search/`처럼 loop 하위에 중첩**: 기각 — loop가 search를 알아야
  한다는 암묵적 결합이 생기고, `kernel/search-blueprint.ts`(순수 데이터 추천
  함수, ADR-0005)가 kernel에서 search 타입을 참조해야 하는 순환 위험이 생김.
- **`onboarding/` 하위에 배치**: 기각 — onboarding은 "게임이 루프를 돌 준비가
  됐는가" 채점 계층이지 후보 생성 계층이 아님, 책임이 섞임.

## 결과

`dependency-rules.test.ts`에 `search: ['contract','kernel']`,
`learn: ['contract','kernel']` 한 줄씩만 추가해 기계적으로 강제됐다. 학습/탐색
봇도 게이트(screen→smoke→prune→holdout→regression)에 특례 없이 통과해야
채택되는 것이 이 배치 덕에 자연스럽게 보장된다 — loop가 봇의 출처(수제 휴리스틱
인지 MCTS인지)를 구분할 방법 자체가 없기 때문이다.
