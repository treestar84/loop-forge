/**
 * gomoku-draw-averse-evaluator — GAP-11 오목 5회전 B3-deep 후보(메인 루프 Fable
 * 지정 설계, scratchpad/gomoku-round5-design-spec.md의 `drawaverse` 명세 그대로).
 *
 * 근거(4회전 채굴 발견 3): v7 vs L2의 무승부는 "안착"이 아니라 **보드 소진형**
 * 이다 — 56판 전부 220-229수, 즉 양쪽이 서로의 위협을 계속 지우기만 하다가
 * 합법수가 고갈돼 강제 종료된다. 4회전의 clone-tiebreak(동점 국면에서 클론과
 * 같은 수를 고르는 보정)와 **다른 종류의 개입**이다: 저건 "이미 동점인 두 수 중
 * 무엇을 고르나"였고, 이건 **"무승부로 가는 수 자체를 덜 선호한다"**는 탐색
 * 랭킹 편향이다(A8 신규 설계축).
 *
 * 설계:
 *   score(c) = cloneScore(c) + ramp(state) * attackEmphasis * ownThreat(c)
 *
 * - `cloneScore`는 챔피언 v7이 쓰는 `gomokuOpusCloneEvaluator`(자기 위협 +
 *   0.95×상대 위협 + 중앙 보너스) 그대로 — v7의 판단 자체는 건드리지 않는다.
 * - `ownThreat`는 그 evaluator의 **공격 반쪽만**(`gomokuOwnThreatScores`).
 *   즉 가산항은 "이 수가 내 공격을 얼마나 키우는가"만 본다 — 방어 미러 항이
 *   빠져 있으므로, 같은 클론 점수를 갖는 두 수 중 **수비적으로 안전하지만
 *   무승부로 가는 수보다, 위험하지만 승부를 가르는 공격수**가 위로 올라온다.
 * - `ramp`는 보드가 얼마나 찼는가로만 켜진다(0 → 1 선형): `drawZoneStartMoveCount`
 *   이전에는 정확히 0이므로 초·중반 행동은 v7과 완전히 동일하고, 무승부로
 *   수렴 중인 후반에서만 편향이 걸린다.
 * - **균형 조건**(spec의 "双방 위협이 균형인 국면"): 어느 쪽이든 이미 결정적
 *   위협(열린 4 이상, `DECISIVE_THREAT_SCORE`)을 만들 수 있는 국면이면 ramp를
 *   0으로 되돌린다 — 즉승/필수방어 안전망이 걸린 국면에서는 편향을 아예 걸지
 *   않는다(클론의 sentinel 판단을 흔들지 않기 위함).
 *
 * `MctsConfig.priorEvaluator`(search/mcts.ts)로 주입되는 것을 전제로 한다 —
 * `gomokuCloneChainPriorEvaluator`/`gomokuOpusCloneEvaluator`와 같은 시그니처.
 */

import type { PlayerId } from '../../contract/types';
import { BOARD_SIZE, type GomokuMove, type GomokuState } from '../gomoku';
import { gomokuOpusCloneEvaluator, gomokuOwnThreatScores } from './gomoku-opus-clone-evaluator';

const TOTAL_CELLS = BOARD_SIZE * BOARD_SIZE;

/** 열린 4(50,000) — 이 이상이면 한쪽이 이미 결정적 위협을 쥔 국면이므로 편향을 끈다. */
export const GOMOKU_DECISIVE_THREAT_SCORE = 50_000;

export interface GomokuDrawAverseOptions {
  /** 이 수순(=state.moveCount)부터 ramp가 0에서 선형 상승한다. */
  readonly drawZoneStartMoveCount: number;
  /**
   * ramp가 1에 도달하는 수순 — round5 채굴의 실측(무승부판에서 열린 3 이상의
   * 강제 위협을 만들 수 있었던 **마지막** 수순의 평균 ≈ 140수)이 근거다. 그
   * 이후 구간은 어떤 착수로도 강제 위협이 불가능한 "죽은 꼬리"(평균 80수)라
   * 편향을 걸어봐야 의미가 없다 — 그래서 보드 만석(225)이 아니라 **개입이
   * 아직 가능한 마지막 시점**에 최대 강도를 맞춘다.
   */
  readonly drawZoneFullMoveCount: number;
  /** ramp=1일 때 자기 공격 점수에 곱해지는 가중치. */
  readonly attackEmphasis: number;
}

/** ramp(state) ∈ [0,1] — `drawZoneStartMoveCount`에서 0, `drawZoneFullMoveCount` 이상에서 1. */
export function gomokuDrawZoneRamp(
  state: GomokuState,
  drawZoneStartMoveCount: number,
  drawZoneFullMoveCount: number,
): number {
  if (state.moveCount <= drawZoneStartMoveCount) {
    return 0;
  }
  const full = Math.min(drawZoneFullMoveCount, TOTAL_CELLS);
  const span = full - drawZoneStartMoveCount;
  if (span <= 0) {
    return 1;
  }
  const ramp = (state.moveCount - drawZoneStartMoveCount) / span;
  return ramp > 1 ? 1 : ramp;
}

function maxOf(values: readonly number[]): number {
  let best = 0;
  for (const value of values) {
    if (value > best) best = value;
  }
  return best;
}

/**
 * Build the round5 B3-deep evaluator — see this module's own doc comment for
 * the full design rationale. Pure function of (state, player, choices); no
 * hidden state between calls.
 */
export function makeGomokuDrawAverseEvaluator(
  options: GomokuDrawAverseOptions,
): (state: GomokuState, player: PlayerId, choices: readonly GomokuMove[]) => readonly number[] {
  return (state, player, choices) => {
    const clone = gomokuOpusCloneEvaluator(state, player, choices);
    const ramp = gomokuDrawZoneRamp(state, options.drawZoneStartMoveCount, options.drawZoneFullMoveCount);
    if (ramp === 0) {
      return clone;
    }

    const own = gomokuOwnThreatScores(state, player, choices);
    const opponent: PlayerId = player === 0 ? 1 : 0;
    const opponentThreats = gomokuOwnThreatScores(state, opponent, choices);
    if (maxOf(own) >= GOMOKU_DECISIVE_THREAT_SCORE || maxOf(opponentThreats) >= GOMOKU_DECISIVE_THREAT_SCORE) {
      return clone; // 결정적 위협이 이미 있는 국면 — 편향 끔(균형 조건)
    }

    const weight = ramp * options.attackEmphasis;
    return choices.map((_, index) => (clone[index] as number) + weight * (own[index] as number));
  };
}
