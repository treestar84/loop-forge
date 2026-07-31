/**
 * hearthstone-blended-evaluator — GAP-11 Phase 7 2회전 B3 본안(메인 루프가
 * 설계 브리프에서 직접 지정한 유일한 신규 설계축, A8): 1회전이 각각 다른
 * 축에 특화된 두 평가함수를 만들어냈다는 관찰
 *   - `hearthstoneChoiceEvaluator` (../hearthstone.ts, ADR-0011): 즉사 >
 *     유리한 교환 > 제거 > 전개 > 명치 > 그 외의 **엄격한 밴드 순서**.
 *     1회전 B3/B1의 prior 원천이었고 v3(tempo-w4)로 승격됐다.
 *   - `hearthstonePlayFocusedEvaluator` (./hearthstone-play-focused-evaluator.ts):
 *     `play` 선택지만 마나커브 적합도로 세밀하게 구분하고 나머지는 평평하게
 *     둔다. 1회전 B2로 단독 투입돼 near-miss(vs L2 33.8%)로 탈락했다.
 * — 를 받아, 두 지식을 **하나의 prior로 합성**한다.
 *
 * 합성 방식과 그 이유(단순 가중합이지만 스케일 설계가 핵심):
 * `search/mcts.ts`의 prior는 점수 벡터에 softmax를 씌운다. tempo 쪽 밴드 간
 * 간격은 최소 150(`CHOICE_EVALUATOR_TIER`: 1000/500/350/200/50/0)이고
 * playfocus 쪽 점수 폭은 대략 0~30이다. 따라서
 *   blended = tempoWeight * tempo + playWeight * playfocus
 * 는 (0 < playWeight * 30 < tempoWeight * 150인 한) **밴드 선택은 전적으로
 * tempo가 하고, 같은 밴드 안에서의 우열만 playfocus가 가른다**는 사전식
 * 결합이 된다. 이는 두 평가함수의 역할 분담(tempo=전략적 우선순위,
 * playfocus=`play` 선택지 내부의 마나 효율)을 그대로 살리는 결합이며,
 * 한쪽이 다른 쪽을 완전히 덮어써서 사실상 단일 평가함수로 퇴화하는 것을
 * 막는다. 가중치 조합 자체는 2회전 러너가 프로브 은행 대조로 소규모
 * 스윕해 확정한다(설계 브리프의 "실행 에이전트가 소규모 스윕으로 확정").
 *
 * Layer: reference/experiments/ — `contract` 타입과 형제 `../hearthstone`,
 * 그리고 같은 디렉터리의 playfocus 평가함수만 import한다
 * (src/__tests__/dependency-rules.test.ts의 reference 계층 규칙).
 * 입력에 대해 순수·결정적(Date.now()/Math.random() 없음, C1).
 */

import type { PlayerId } from '../../contract/types';
import { hearthstoneChoiceEvaluator, type HearthstoneChoice, type HearthstoneState } from '../hearthstone';
import { hearthstonePlayFocusedEvaluator } from './hearthstone-play-focused-evaluator';

export interface HearthstoneBlendWeights {
  /** `hearthstoneChoiceEvaluator`(밴드 결정) 가중치. */
  readonly tempo: number;
  /** `hearthstonePlayFocusedEvaluator`(밴드 내부 서열) 가중치. */
  readonly play: number;
}

/**
 * 두 평가함수의 가중합 평가함수를 만든다. 반환 함수는 두 원본을 각각 한 번씩
 * 호출하므로 비용은 두 원본의 합(둘 다 상태를 변형하지 않는 순수 함수).
 */
export function hearthstoneBlendedEvaluator(
  weights: HearthstoneBlendWeights,
): (state: HearthstoneState, player: PlayerId, choices: readonly HearthstoneChoice[]) => readonly number[] {
  return (state, player, choices) => {
    const tempo = hearthstoneChoiceEvaluator(state, player, choices);
    const play = hearthstonePlayFocusedEvaluator(state, player, choices);
    return choices.map((_, index) => weights.tempo * (tempo[index] ?? 0) + weights.play * (play[index] ?? 0));
  };
}
