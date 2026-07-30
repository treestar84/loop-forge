/**
 * gomoku-round4-candidates — GAP-11 Phase 6 round4 candidate batch builder
 * (팀리드 배치 + 메인 루프 Fable의 B3 심층 설계, scratchpad
 * gomoku-round4-design-spec.md 그대로 구현 — see that spec's own doc comment
 * for the full per-candidate design rationale), following
 * ./gomoku-round2-candidates.ts/./gomoku-round3-candidates.ts's own
 * side-effect-free candidate-builder convention.
 *
 * 후보 배치 (6개 배치 지시, 실제 5개 — B3 자신의 spec은 B1 파생이 재사용하는
 * epsilon 상수만 가져가고 별도 spec 함수를 공유하므로 "본안+파생 3개"가
 * 사실상 하나의 factory에서 파생됨, round2의 "헤더는 6, 본문은 5" 선례와
 * 같은 종류의 표기 차이 — 여기서는 실제로 5개의 서로 다른 flag가 생성됨):
 *   - B3-deep: `gomokuCloneTiebreak` — 메인 루프 B3 본안(비-MCTS, evaluator
 *     argmax + combined 타이브레이크, ../experiments/gomoku-clone-tiebreak-bot.ts).
 *     assembly: 'terminal'(ADR-0014) — MCTS가 아니므로 base를 무시하는 것도
 *     당연하지만, 여러 터미널이 후보 풀에 동시에 오를 수 있는 이번 라운드
 *     구조상 명시적으로 선언한다.
 *   - B1-exploit x2: `gomokuCloneTiebreak-eps-tight`(epsilon=1, 거의 완전
 *     동점만 재평가)/`gomokuCloneTiebreak-eps-wide`(epsilon=20, 근접값도
 *     동점군으로 묶어 재평가 범위 확대) — B3의 기계적 파생(epsilon 스윕).
 *   - B2-opponent: `mcts14-s256-jumpthree-w16` — 실행 에이전트 설계
 *     (round4 프로브 46개의 흩어진 분포를 근거로, 기존 모든 prior evaluator가
 *     놓치는 "jump three"(跳三, 뛰어넘은 3연) 기하 축 —
 *     ../experiments/gomoku-jump-three-evaluator.ts. B3의 "동점 타이브레이크"
 *     (비-MCTS, evaluator 재점수화)와 완전히 다른 접근: 이건 MCTS 위의 새
 *     tree prior다). assembly: 'terminal'.
 *   - B4-explore: `mcts13-s256-clone-chainprior` — 팀리드 지시(A5×A10 진짜
 *     결합, ../experiments/gomoku-clone-chain-prior-evaluator.ts). base
 *     rollout/평가(championRollout, simulations=256, uctC=1.4,
 *     rolloutCount=1)는 챔피언 clone 후보(mcts12-s256-opusclone-w16)와
 *     완전히 동일 — 오직 priorEvaluator(clone+chain 가산)와 priorWeight
 *     (4 또는 8, 챔피언의 16보다 낮음 — "최소 개입")만 다르다. priorWeight
 *     선택은 이 모듈의 관심사가 아니라 호출자(../gomoku-portfolio-round4.ts)의
 *     사전 소형 진단이 정해 `cloneChainPriorWeight` 파라미터로 넘긴다.
 */

import type { AnyGameAdapter } from '../../../contract/types';
import { composeBot } from '../../../loop/compose';
import type { BucketId } from '../../../artifacts/portfolio';
import type { MctsConfig } from '../../../search/mcts';
import {
  makeGomokuCloneTiebreakBot,
  GOMOKU_CLONE_TIEBREAK_EPSILON_DEFAULT,
  GOMOKU_CLONE_TIEBREAK_EPSILON_TIGHT,
  GOMOKU_CLONE_TIEBREAK_EPSILON_WIDE,
} from '../../experiments/gomoku-clone-tiebreak-bot';
import { gomokuJumpThreeEvaluator } from '../../experiments/gomoku-jump-three-evaluator';
import { gomokuCloneChainPriorEvaluator } from '../../experiments/gomoku-clone-chain-prior-evaluator';
import { GOMOKU_CHAMPION_ROLLOUT_FLAGS, gomokuMctsFlagSpecFor } from './gomoku-mcts-flag';
import { erasePriorEvaluator, type RoundCandidate } from './gomoku-round1-candidates';
import type { GomokuMove, GomokuObservation } from '../../gomoku';
import type { StrategyFlagSpec } from '../../../contract/types';

export type { RoundCandidate };

export const GOMOKU_CLONE_TIEBREAK_FLAG = 'gomokuCloneTiebreak';
export const GOMOKU_CLONE_TIEBREAK_EPS_TIGHT_FLAG = 'gomokuCloneTiebreak-eps-tight';
export const GOMOKU_CLONE_TIEBREAK_EPS_WIDE_FLAG = 'gomokuCloneTiebreak-eps-wide';
export const GOMOKU_JUMP_THREE_FLAG = 'mcts14-s256-jumpthree-w16';
export const GOMOKU_CLONE_CHAIN_PRIOR_FLAG = 'mcts13-s256-clone-chainprior';

/**
 * B3/B1 flag spec builder: wraps `makeGomokuCloneTiebreakBot(epsilon)`
 * (../../experiments/gomoku-clone-tiebreak-bot.ts, concretely typed against
 * GomokuObservation/GomokuChoice) into the erased `StrategyFlagSpec<unknown,
 * unknown>` shape — same "cast at the boundary, inside apply()" convention as
 * `gomokuOpeningThenPriorFlagSpec` (./gomoku-round1-candidates.ts). `apply()`
 * ignores `base` entirely (it is not an MCTS candidate, but it is still a
 * self-contained decision procedure that never modulates a base bot's
 * choice — same convention as every other terminal candidate in this repo).
 */
export function gomokuCloneTiebreakFlagSpec(epsilon: number, flag: string): StrategyFlagSpec<unknown, unknown> {
  return {
    flag,
    description: `Non-MCTS evaluator-argmax terminal candidate (GAP-11 round4 B3-deep/B1-exploit): opusclone evaluator argmax, epsilon=${epsilon}-tied candidates re-scored by the combined (defensive+0.6*chain) evaluator (../../experiments/gomoku-clone-tiebreak-bot.ts); ignores the base bot entirely.`,
    apply: () => (seed) => {
      const bot = makeGomokuCloneTiebreakBot(epsilon)(seed as number);
      return {
        id: bot.id,
        decide(decisionPoint, observation, legal) {
          return bot.decide(decisionPoint, observation as GomokuObservation, legal as readonly GomokuMove[]);
        },
      };
    },
    assembly: 'terminal',
  };
}

/**
 * Rebuild this round's 5-candidate batch against `bareAdapter` — see this
 * module's own doc comment for the full per-candidate design rationale.
 * `cloneChainPriorWeight` (4 or 8) must come from the caller's own pre-wave
 * diagnostic (../gomoku-portfolio-round4.ts) — this module does not run any
 * diagnostic itself (side-effect-free convention, this module's own doc
 * comment).
 */
export function buildRound4Candidates(
  bareAdapter: AnyGameAdapter,
  cloneChainPriorWeight: number,
): readonly RoundCandidate[] {
  const championRollout = composeBot(bareAdapter, [...GOMOKU_CHAMPION_ROLLOUT_FLAGS]);

  const b3: RoundCandidate = {
    flag: GOMOKU_CLONE_TIEBREAK_FLAG,
    bucket: 'B3-deep' as BucketId,
    spec: gomokuCloneTiebreakFlagSpec(GOMOKU_CLONE_TIEBREAK_EPSILON_DEFAULT, GOMOKU_CLONE_TIEBREAK_FLAG),
  };

  const b1: RoundCandidate[] = [
    {
      flag: GOMOKU_CLONE_TIEBREAK_EPS_TIGHT_FLAG,
      bucket: 'B1-exploit' as BucketId,
      spec: gomokuCloneTiebreakFlagSpec(GOMOKU_CLONE_TIEBREAK_EPSILON_TIGHT, GOMOKU_CLONE_TIEBREAK_EPS_TIGHT_FLAG),
    },
    {
      flag: GOMOKU_CLONE_TIEBREAK_EPS_WIDE_FLAG,
      bucket: 'B1-exploit' as BucketId,
      spec: gomokuCloneTiebreakFlagSpec(GOMOKU_CLONE_TIEBREAK_EPSILON_WIDE, GOMOKU_CLONE_TIEBREAK_EPS_WIDE_FLAG),
    },
  ];

  const b2: RoundCandidate = {
    flag: GOMOKU_JUMP_THREE_FLAG,
    bucket: 'B2-opponent' as BucketId,
    spec: gomokuMctsFlagSpecFor(
      bareAdapter,
      {
        simulations: 256,
        uctC: 1.4,
        rolloutCount: 1,
        label: 's256-jumpthree-w16',
        rolloutFactory: championRollout,
        priorWeight: 16,
        priorEvaluator: erasePriorEvaluator(gomokuJumpThreeEvaluator),
      },
      GOMOKU_JUMP_THREE_FLAG,
    ),
  };

  const b4: RoundCandidate = {
    flag: GOMOKU_CLONE_CHAIN_PRIOR_FLAG,
    bucket: 'B4-explore' as BucketId,
    spec: gomokuMctsFlagSpecFor(
      bareAdapter,
      {
        simulations: 256,
        uctC: 1.4,
        rolloutCount: 1,
        label: 's256-clone-chainprior',
        rolloutFactory: championRollout,
        priorWeight: cloneChainPriorWeight,
        priorEvaluator: erasePriorEvaluator(gomokuCloneChainPriorEvaluator),
      },
      GOMOKU_CLONE_CHAIN_PRIOR_FLAG,
    ),
  };

  return [b3, ...b1, b2, b4];
}
