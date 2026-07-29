/**
 * gomoku-round3-candidates — GAP-11 Phase 4-B2 미니 진단 배치 (팀리드 지시,
 * ./gomoku-round2-candidates.ts/./gomoku-round1-candidates.ts와 같은
 * side-effect-free 후보 빌더 모듈 관행을 그대로 따름).
 *
 * 설계 논거(팀리드 확정, 이 라운드의 유일한 검증 대상): v7(=registry v7
 * composed bot, composeBot의 "마지막 MCTS 플래그만 생존" 규칙에 따라 실질
 * `mcts12-s256-opusclone-w16` 단독)과 L2(external-opus-l2)는 같은 위협
 * 함수(opus-clone evaluator가 L2 자신의 채점 로직을 이식한 것) 위에서 대국하는
 * 거울 대국 — portfolio-round2.json의 challenge 결과가 무승부 57.5%로
 * 이를 보여준다. 같은 evaluator를 공유하는 두 플레이어 사이에서 남는 유일한
 * 비대칭 축은 **탐색 예산**(트리가 그 evaluator를 얼마나 깊이/넓게 활용할 수
 * 있는가)이므로, 이 라운드는 evaluator를 전혀 바꾸지 않고 simulations만
 * 256→512(미달 시 추가로 768)로 올린 **단일 자립(self-contained)** 플래그만
 * 시험한다. 과거 라운드1의 "예산만 단독으로 올린" 시도(B1 계열, w32/w64
 * priorWeight 실험)는 약한 evaluator(당시 championRolloutPriorConfig의
 * choiceEvaluator) 위에서 실패했지만, 그 축과 "opusclone evaluator" 축의
 * 조합은 이번이 최초 시도 — 축 매트릭스상 새 조합이라 ADR-0009(같은 축
 * 재탕 금지) 위반이 아니다(팀리드 지시 원문).
 *
 * mcts12-s256-opusclone-w16(round2-candidates.ts)과 완전히 같은 구성 —
 * evaluator(gomokuOpusCloneEvaluator)/priorWeight(16)/uctC(1.4)/
 * rolloutCount(1)/rolloutFactory(챔피언 롤아웃) 전부 동일 — simulations 값만
 * 바꾼 파생이다. 팀리드가 지정한 이름 그대로 `mcts12-s512-opusclone-w16`
 * (evaluator 계열 번호 12는 유지, 예산 접미사만 s256→s512) — 다른 MCTS 계열
 * 플래그와 마찬가지로 composeBot의 "base 완전 무시" 규칙이 적용되는 단일
 * 자립 플래그이므로 다른 플래그와 나열해도 안전하게 대체 가능하다.
 *
 * s512도 미달일 경우를 대비한 s768 대조 후보도 함께 정의해 둔다(팀리드 절차
 * 3번째 분기) — 실제로 쓰일지는 진단 러너가 s512 결과를 보고 결정한다(이
 * 모듈 자체는 두 후보를 값싸게 둘 다 만들어 둘 뿐, 실행 여부는 관여하지
 * 않는다).
 */

import type { AnyGameAdapter } from '../../../contract/types';
import { composeBot } from '../../../loop/compose';
import type { BucketId } from '../../../artifacts/portfolio';
import type { MctsConfig } from '../../../search/mcts';
import { gomokuOpusCloneEvaluator } from '../../experiments/gomoku-opus-clone-evaluator';
import { GOMOKU_CHAMPION_ROLLOUT_FLAGS, gomokuMctsFlagSpecFor } from './gomoku-mcts-flag';
import { erasePriorEvaluator, type RoundCandidate } from './gomoku-round1-candidates';

export type { RoundCandidate };

export const GOMOKU_ROUND3_S512_FLAG = 'mcts12-s512-opusclone-w16';
export const GOMOKU_ROUND3_S768_FLAG = 'mcts12-s768-opusclone-w16';

/** B1-exploit: mcts12-s256-opusclone-w16(round2 챔피언 축)의 기계적 파생 — simulations만 바꾼다. */
function opusCloneConfig(bareAdapter: AnyGameAdapter, simulations: number, label: string): MctsConfig {
  return {
    simulations,
    uctC: 1.4,
    rolloutCount: 1,
    label,
    rolloutFactory: composeBot(bareAdapter, [...GOMOKU_CHAMPION_ROLLOUT_FLAGS]),
    priorWeight: 16,
    priorEvaluator: erasePriorEvaluator(gomokuOpusCloneEvaluator),
  };
}

/** 1차 진단 후보 — s256 → s512 예산 우위 단독 검증. */
export function buildRound3S512Candidate(bareAdapter: AnyGameAdapter): RoundCandidate {
  return {
    flag: GOMOKU_ROUND3_S512_FLAG,
    bucket: 'B1-exploit' as BucketId,
    spec: gomokuMctsFlagSpecFor(
      bareAdapter,
      opusCloneConfig(bareAdapter, 512, 's512-opusclone-w16'),
      GOMOKU_ROUND3_S512_FLAG,
    ),
  };
}

/** s512이 미달일 때만 쓰는 s768 대조 후보(팀리드 절차 3번째 분기). */
export function buildRound3S768Candidate(bareAdapter: AnyGameAdapter): RoundCandidate {
  return {
    flag: GOMOKU_ROUND3_S768_FLAG,
    bucket: 'B1-exploit' as BucketId,
    spec: gomokuMctsFlagSpecFor(
      bareAdapter,
      opusCloneConfig(bareAdapter, 768, 's768-opusclone-w16'),
      GOMOKU_ROUND3_S768_FLAG,
    ),
  };
}
