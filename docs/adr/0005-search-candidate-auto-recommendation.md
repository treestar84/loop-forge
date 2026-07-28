# ADR-0005 — 탐색 후보 생성을 데이터 전용 커널 함수로 자동화

**상태**: 채택됨 (2026-07-26)

## 맥락

채점/게이트 파라미터(C0~C7 임계, 티어 블록수, 점수차 임계)는 이미
classification+calibration → 파생형이었지만(ADR-0004), "이 게임에 MCTS를 쓸지
IS-MCTS를 쓸지, 예산은 얼마로, 롤아웃은 어떻게"는 매 게임 온보딩마다 에이전트가
손으로 판단해 6개 거의 동일한 `*-mcts-flag.ts`/`*-ismcts-flag.ts` 파일에
하드코딩했다. 다음에 올 낯선 게임도 같은 시행착오를 처음부터 반복하게 된다.

## 결정

`kernel/search-blueprint.ts`에 `deriveSearchBlueprint(classification,
capabilities, throughputSamples, waveTimeBudgetMs)`를 신설한다. 입출력 전부
**순수 데이터**(어댑터 능력 선언 여부, 실측 판당 비용) — `search`/`learn`을
import하지 않아 계층 규칙을 지킨다. family(MCTS/IS-MCTS/CFR 병행 여부)·예산·
롤아웃 등급·전술 프리체크 깊이를 규칙 기반으로 추천한다. 번역은 앱 경계의
`reference/runners/shared/search-candidate.ts`가 맡는다.

## 대안

- **LLM에게 매번 "이 게임엔 뭘 써야 할지" 물어보기**: 기각 — 재현 불가능(같은
  게임을 다시 물으면 다른 답이 나올 수 있음), 그리고 이미 7게임의 실제 선택
  패턴이 간단한 규칙(능력 선언 → family, 처리량 → 예산)으로 설명됨을 확인했다.
- **기존 게임의 flag를 이 함수 결과로 교체**: 하지 않음 — 손으로 검증된 결과를
  건드릴 이유가 없다. 이 함수는 **다음 게임**을 위한 것.

## 결과

7게임의 실제 (classification, capabilities, 실측 throughput)을 데이터로 넣어
family·rolloutTier 추천이 실제 채택된 알고리즘 계열과 방향이 **7/7 일치**함을
회귀 픽스처로 검증(비용 0, 웨이브 재실행 없음). 장기 재도전에서 실전 첫 사용
사례가 나왔는데, "커스텀 합성 롤아웃은 이 함수의 스코프 밖(random/heuristic
등급만 앎)"이라는 경계를 정확히 지키는 것도 함께 확인됐다 — 설계된 한계가
실전에서도 정확히 작동한다는 뜻.
