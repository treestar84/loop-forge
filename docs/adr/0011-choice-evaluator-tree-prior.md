# ADR-0011 — choiceEvaluator 계약 확장과 MCTS 트리 prior

- 상태: 채택됨 (2026-07-29, GAP-ANALYSIS-11 D1+D2)
- 관련: ADR-0002(search 계층), ADR-0008(rootOverride), ADR-0012(앵커 래더)

## 맥락

게임 지식이 탐색에 들어가는 통로가 롤아웃 정책(희석: forkAwareness 9.0%→
MCTS 래핑 시 0.0%)과 루트 오버라이드(단발: 41.1% 발동에도 0.0%)의 두 극단뿐
이었다(GAP-11 R3). Opus봇의 우위는 매 노드의 수 선택 품질인데, 트리의 선택
(selection) 단계에 지식을 주입할 계약 훅이 없었다 — `mcts.ts:36` 주석의
"no policy prior"가 그 자인이다. Phase 1-E 판정 실험은 오목 v5가 중수 봇(L1)
에게조차 0.5%로 지는 서열(v5<L1<L2)을 실측해 이 결함을 정량 확정했다.

## 결정

1. **계약**: `GameSpec.choiceEvaluator?(state, player, choices) → number[]` —
   선택지별 정적 평가를 어댑터가 **데이터로 선언**한다(strategySurface와 동일
   원칙). search 계층은 숫자 배열만 소비하므로 게임 지식은 계층 ①에 갇힌 채다.
2. **탐색**: `MctsConfig.priorWeight?`/`priorSource?: 'choiceEvaluator'` —
   선택 단계 UCB를 `Q + uctC·√(lnN/n) + priorWeight·P(c)/(1+n)`으로 확장
   (progressive bias: 방문 누적 시 prior 영향 자연 감쇠 — 통계가 지식을
   이긴다). P(c)는 evaluator 점수의 softmax. 확장 순서도 prior 내림차순.
   미지정 시 기존 동작 byte-for-byte 불변(rolloutFactory 등과 동일한 옵트인
   패턴). IS-MCTS는 MctsConfig 재사용으로 자동 적용.

## 대안

- **롤아웃 정책 강화 반복**: 이미 3게임에서 "흉내 열화" 실측(GAP-8 §4.7,
  FIX-BACKLOG 장기) — 지식이 시뮬레이션 끝단에서 희석되는 구조 자체가 원인이라
  기각.
- **rootOverride 확장(트리 내부 오버라이드)**: 지식이 통계를 대체하게 되어
  탐색의 존재 의의가 사라지고, 오버라이드 조건의 정밀도에 전부를 걸게 됨 —
  progressive bias는 지식을 "초기 가이드"로 한정해 이 문제를 피한다.
- **AlphaZero식 학습 prior(신경망)**: 이 예산(단일 맥북)과 v1 스코프에서
  기각 — 손으로 선언한 evaluator가 같은 주입점을 공유하므로, 이후 학습
  산출물로 교체 가능한 구조는 유지된다(priorSource 확장 여지).

## 결과

- 오목 forkAwareness 위협 스코어링이 루트 1수가 아니라 트리 전체의 선택
  품질에 반영되는 첫 경로. 판정 기준: L2 상대 9.0%(순정 forkAwareness) 초과
  또는 L1 상대 승률 곡선의 유의 개선(Phase 1-E가 만든 래더 계측 기반).
- 리스크: evaluator 호출이 노드 확장마다 발생 — 비용은 priorWeight=0으로
  완전 우회 가능하고, 판당 비용 실측을 웨이브 투입 전에 요구한다.
