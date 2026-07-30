/**
 * gomoku-clone-chain-prior-evaluator — GAP-11 Phase 6 round4 B4-explore
 * candidate (design-brief-round4.md B4, 팀리드 배치: "A5×A10 진짜 결합" —
 * 지금까지 트리 prior(A5)와 모방/이식(A10)은 "클론이 있기 전에 결합"
 * (round2/3의 combined evaluator, defensive+chain) 아니면 "클론 자체가
 * 곧 A10"이었지, **"클론 위에 얹은 prior"는 시도한 적이 없다** — 이 파일이
 * 그 미시도 조합).
 *
 * `gomokuOpusCloneEvaluator`(L2 자신의 연속 위협 점수, 그대로 재사용)와
 * `gomokuChainEvaluator`(공격 선행 자산 — 자유 2연/교차점/수비 미러, 그대로
 * 재사용)의 단순 가산 합. 두 evaluator 모두 이미 검증된 기존 후보이므로
 * 로직을 재구현하지 않는다(`gomoku-combined-evaluator.ts`가 defensive+chain을
 * 합산하는 것과 같은 패턴).
 *
 * `gomoku-combined-evaluator.ts`(defensive+0.6*chain)와 달리 이 evaluator
 * 자체에는 chain 쪽 계수를 두지 않는다(1:1 가산) — "클론의 판단을 뒤집지
 * 않고 탐색 우선순위만 살짝 흔든다"는 설계 목표는 evaluator 내부의 가중치가
 * 아니라 `MctsConfig.priorWeight`를 챔피언(클론 단독, w16)보다 낮은 값(4 또는
 * 8)으로 두는 쪽에서 달성한다 — 이 evaluator가 얼마나 강하게 탐색을 편향
 * 시키는지 전체를 조절하는 단일 지점을 유지해, "결합 비율"과 "개입 강도"라는
 * 두 축을 분리하지 않고 하나로 합쳐 불필요한 자유도를 늘리지 않기 위함.
 * 어느 priorWeight(4 vs 8)를 쓰는지는 이 evaluator의 관심사가 아니다 —
 * 그 선택은 `../runners/gomoku-portfolio-round4.ts`의 사전 소형 진단이 정하고,
 * `MctsConfig.priorWeight`로 전달된다.
 *
 * Meant to be supplied via `MctsConfig.priorEvaluator` (search/mcts.ts),
 * exactly like `gomokuChainEvaluator`/`gomokuOpusCloneEvaluator`/
 * `gomokuCombinedEvaluator`.
 */

import type { PlayerId } from '../../contract/types';
import type { GomokuMove, GomokuState } from '../gomoku';
import { gomokuOpusCloneEvaluator } from './gomoku-opus-clone-evaluator';
import { gomokuChainEvaluator } from './gomoku-chain-evaluator';

/**
 * score(c) = opusCloneScore(c) + chainScore(c) — see this file's own doc
 * comment for why the combination itself carries no separate coefficient.
 */
export function gomokuCloneChainPriorEvaluator(
  state: GomokuState,
  player: PlayerId,
  choices: readonly GomokuMove[],
): readonly number[] {
  const clone = gomokuOpusCloneEvaluator(state, player, choices);
  const chain = gomokuChainEvaluator(state, player, choices);
  return choices.map((_, index) => (clone[index] as number) + (chain[index] as number));
}
