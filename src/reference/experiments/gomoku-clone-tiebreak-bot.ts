/**
 * gomoku-clone-tiebreak-bot — GAP-11 Phase 6 round4 B3-deep main candidate
 * (메인 루프 Fable 심층 설계, scratchpad gomoku-round4-design-spec.md 그대로
 * 구현 — see that spec's own "B3 본안" section).
 *
 * 설계 근거(메인 루프 원문): registry v7의 조립 실체는
 * `mcts12-s256-opusclone-w16`(MCTS 탐색, opusclone evaluator를 tree prior로
 * 사용) 단독이고, 그 evaluator는 L2(external-opus-l2) 자신의 채점 로직을
 * 그대로 이식한 것이다(`gomoku-opus-clone-evaluator.ts`). 이 파일은 그
 * evaluator를 **탐색 없이 직접 argmax로 사용하는** 별도의 새 터미널
 * 후보다 — L2 자신의 `gomoku-opus-bot.ts`가 하는 "평가함수 최고점 선택,
 * 동점이면 rng로 무작위 선택" 구조를 그대로 재현하되, rng 대신 **combined
 * evaluator**(`gomoku-combined-evaluator.ts`, defensive + 0.6*chain, round2에서
 * 이미 구현/검증됨 — import, 로직 중복 금지)로 동점군을 재점수화해 그 안에서
 * 선택하도록 타이브레이크만 바꾼다.
 *
 * 절차: opusclone evaluator로 전체 legal moves를 채점 → 최고점 대비
 * `epsilon` 이내 차이인 후보를 "동점군"으로 묶음. 동점군이 정확히 1개
 * (고유 최선수가 있음)면 클론 원래 선택 그대로 반환(그 자체가 argmax이므로
 * 자명하게 불변). 동점군이 2개 이상이면 그 부분집합만 combined evaluator로
 * 다시 채점해 최고점을 선택(마지막 완전 동률은 seeded rng로 결정론적으로
 * 해소).
 *
 * MCTS가 아닌 순수 evaluator-argmax 터미널 봇이라는 점이 round2/round3의
 * 모든 clone 계열 후보(전부 MCTS 위에서 clone evaluator를 tree prior로
 * 사용)와의 핵심 차이 — 탐색 예산 비용이 없어 판당 비용이 낮다(design-brief
 * -round4.md의 자원 규칙이 "defensive/clone 계열 4-6배 비용"이라 부르는
 * 것은 tree-search 확산 비용이고, 이 후보는 그 확산 자체가 없다).
 *
 * `apply()`는 `base`를 무시한다(다른 모든 터미널 후보와 같은 관행) —
 * `assembly: 'terminal'` (ADR-0014).
 */

import type { BotFactory, GameBot, PlayerId } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import type { GomokuChoice, GomokuMove, GomokuObservation, GomokuState } from '../gomoku';
import { gomokuOpusCloneEvaluator } from './gomoku-opus-clone-evaluator';
import { gomokuCombinedEvaluator } from './gomoku-combined-evaluator';

/** B3 본안의 기본 epsilon (design-brief-round4.md B1 스윕의 기준점) — 오목 opusclone
 * 점수 스케일에서 "거의 완전 동점"만 잡히도록 보수적으로 작게 잡았다(중반
 * 국면에서 서로 다른 형태의 quiet move들은 대개 몇 점 이상 차이가 남 —
 * centerBonus만도 0.5 단위, 티어 점프는 훨씬 큼). B1 파생(tight/wide)은
 * 이 값을 좁히거나/넓히는 기계적 변형(팀리드 배치).
 */
export const GOMOKU_CLONE_TIEBREAK_EPSILON_DEFAULT = 5;
export const GOMOKU_CLONE_TIEBREAK_EPSILON_TIGHT = 1;
export const GOMOKU_CLONE_TIEBREAK_EPSILON_WIDE = 20;

function toState(observation: GomokuObservation): GomokuState {
  return { board: observation.board, moveCount: observation.moveCount, winner: null, openingId: 'gomoku-clone-tiebreak' };
}

/**
 * Builds a `gomokuCloneTiebreakBot` for the given `epsilon` (this file's own
 * doc comment for the full selection procedure). Deterministic given `seed`:
 * every branch (unique clone argmax, tied-then-combined argmax, or a final
 * genuine tie) resolves without any non-seeded randomness.
 */
export function makeGomokuCloneTiebreakBot(epsilon: number): BotFactory<GomokuObservation, GomokuChoice> {
  return (seed: number): GameBot<GomokuObservation, GomokuChoice> => {
    const rng = createRng(seed);
    return {
      id: `gomoku-clone-tiebreak-eps${epsilon}-${seed}`,
      decide(_decisionPoint, observation, legal) {
        const state = toState(observation);
        const player: PlayerId = observation.self;

        const cloneScores = gomokuOpusCloneEvaluator(state, player, legal);
        let bestCloneScore = -Infinity;
        for (const score of cloneScores) {
          if ((score as number) > bestCloneScore) {
            bestCloneScore = score as number;
          }
        }
        const tiedIndices: number[] = [];
        cloneScores.forEach((score, index) => {
          if (bestCloneScore - (score as number) <= epsilon) {
            tiedIndices.push(index);
          }
        });

        if (tiedIndices.length === 1) {
          return legal[tiedIndices[0] as number] as GomokuMove;
        }

        const tiedMoves = tiedIndices.map((index) => legal[index] as GomokuMove);
        const combinedScores = gomokuCombinedEvaluator(state, player, tiedMoves);
        let bestCombinedScore = -Infinity;
        let bestMoves: GomokuMove[] = [];
        combinedScores.forEach((score, index) => {
          const move = tiedMoves[index] as GomokuMove;
          if ((score as number) > bestCombinedScore) {
            bestCombinedScore = score as number;
            bestMoves = [move];
          } else if (score === bestCombinedScore) {
            bestMoves.push(move);
          }
        });

        if (bestMoves.length === 1) {
          return bestMoves[0] as GomokuMove;
        }
        return bestMoves[rng.nextInt(bestMoves.length)] as GomokuMove;
      },
    };
  };
}

export const gomokuCloneTiebreakBot = makeGomokuCloneTiebreakBot(GOMOKU_CLONE_TIEBREAK_EPSILON_DEFAULT);
