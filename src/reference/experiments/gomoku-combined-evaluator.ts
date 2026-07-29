/**
 * gomoku-combined-evaluator — GAP-11 Phase 4-B B3 처치 1 (메인 루프 심층 설계,
 * scratchpad b3-round2-design-spec.md 그대로 구현, docs/GAP-ANALYSIS-11.md
 * §5.5 Phase 4-A/4-B): defense (`gomokuDefensiveEvaluator`) + offense-lead
 * chain (`gomokuChainEvaluator`)의 가중 합. 두 evaluator 모두 이미 검증된
 * 라운드1 채택 후보이므로 로직을 재구현하지 않고 그대로 import해 합산한다
 * (설계 지시: "로직 중복 금지, 재사용").
 *
 * score(c) = defensiveScore(c) + chainWeight * chainScore(c), chainWeight
 * 기본값 0.6 (설계 지시): 수비 지배(1.0) + 공격 선행 보조(0.6) — 라운드1
 * 실측(defensive 25.6% vs chain 최고 7.5%)에서 수비가 이긴 결과를 존중하되,
 * chain evaluator의 "잠재 위협 티어"(자유 2연/교차점/수비 미러) 신호를 합성에
 * 복원한다. 설계 근거: v6(=defensive 단독, composeBot의 마지막 플래그 지배
 * 규칙 때문 — 이 파일들의 라운드1 doc comment 참고)에서는 chain의 공격 선행
 * 자산 신호가 완전히 소실되어 있었다.
 *
 * `makeGomokuCombinedEvaluator(chainWeight)`로 계수를 바꾼 변형(B1
 * `mcts10-s256-combined-w16-c04`, chainWeight=0.4)도 같은 팩토리에서 파생
 * — 별도 파일로 로직을 복제하지 않는다.
 *
 * Meant to be supplied via `MctsConfig.priorEvaluator` (search/mcts.ts),
 * exactly like `gomokuChainEvaluator`/`gomokuDefensiveEvaluator`.
 */

import type { PlayerId } from '../../contract/types';
import type { GomokuMove, GomokuState } from '../gomoku';
import { gomokuChainEvaluator } from './gomoku-chain-evaluator';
import { gomokuDefensiveEvaluator } from './gomoku-defensive-evaluator';

/** Default chain-evaluator weight (이 파일 doc comment, 메인 루프 처치 1 설계). */
export const DEFAULT_CHAIN_WEIGHT = 0.6;

/**
 * Builds a combined per-choice evaluator with a caller-supplied `chainWeight`
 * — `defensiveScore(c) + chainWeight * chainScore(c)` for every choice, both
 * component evaluators called exactly once each (no re-derivation of their
 * internal tier logic). Exported so round-2 variants that only differ in
 * `chainWeight` (e.g. B1's 0.4-weighted candidate) share this one
 * implementation instead of duplicating it.
 */
export function makeGomokuCombinedEvaluator(
  chainWeight: number,
): (state: GomokuState, player: PlayerId, choices: readonly GomokuMove[]) => readonly number[] {
  return (state, player, choices) => {
    const defensive = gomokuDefensiveEvaluator(state, player, choices);
    const chain = gomokuChainEvaluator(state, player, choices);
    return choices.map((_, index) => (defensive[index] as number) + chainWeight * (chain[index] as number));
  };
}

/** Default-weighted (`DEFAULT_CHAIN_WEIGHT` = 0.6) combined evaluator — this round's B3 primary candidate. */
export const gomokuCombinedEvaluator = makeGomokuCombinedEvaluator(DEFAULT_CHAIN_WEIGHT);
