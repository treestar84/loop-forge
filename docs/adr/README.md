# 아키텍처 결정 기록 (ADR)

되돌리기 비싼 결정, 또는 "왜 이렇게 안 하고 저렇게 했는가"가 코드만 봐서는
안 드러나는 결정을 기록한다. GAP-ANALYSIS 문서(라운드별 발견 기록)와 역할이
다르다 — ADR은 **결정 하나**를 맥락·대안·결과 중심으로 짧게 남긴다.

| ID | 제목 | 상태 |
|---|---|---|
| [0001](0001-openspiel-faithful-port-exception.md) | OpenSpiel 알고리즘 충실 이식 라이선스 예외 | 채택됨 |
| [0002](0002-search-learn-sibling-layers.md) | search/·learn/을 kernel의 형제 계층으로 배치 | 채택됨 |
| [0003](0003-regression-gate.md) | 승격 전 "현재 챔피언과 직접 대결" 회귀 게이트 | 채택됨 |
| [0004](0004-calibrated-score-diff-threshold.md) | 점수차 임계를 고정 상수 대신 캘리브레이션에서 파생 | 채택됨 |
| [0005](0005-search-candidate-auto-recommendation.md) | 탐색 후보 생성을 데이터 전용 커널 함수로 자동화 | 채택됨 |
| [0006](0006-identity-center-opt-in-escape-hatches.md) | identityCenter 가정 붕괴에 옵트인 이스케이프 해치로 대응 | 채택됨 |
| [0007](0007-field-mix-additive-option.md) | fieldMix를 opponent 대체가 아닌 추가 옵션으로 도입 | 채택됨 |
| [0008](0008-mcts-root-override-hook.md) | MCTS에 게임 중립 루트 오버라이드 훅 신설 | 채택됨 |
| [0009](0009-no-forcing-policy.md) | 큰루프 재도전의 "억지 반복 금지" 원칙 | 채택됨 |
| [0010](0010-opus-bot-benchmark-methodology.md) | Opus봇 벤치마크 방법론 — 1회 설계 후 고정 | 채택됨 |
| [0012](0012-anchor-ladder-holdout-opponents.md) | 앵커 래더(L1/L2/L3)와 홀드아웃 상대 분리 | 채택됨 |

## 형식

각 ADR은 짧게: **맥락**(무슨 문제였나) → **결정**(무엇을 했나) →
**대안**(무엇을 안 했고 왜인가) → **결과**(지금까지 실측된 효과, 남은 리스크).
