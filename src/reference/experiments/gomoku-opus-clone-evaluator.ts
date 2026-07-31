/**
 * gomoku-opus-clone-evaluator — GAP-11 Phase 4-B B4 candidate (실행 에이전트
 * 설계, 축 매트릭스 A10 "모방/이식" — design-brief-round2.md 축 매트릭스에서
 * 이 게임에 대해 "미시도"로 기록된 유일한 실행 가능 축: A7(오프닝 북)은
 * "registry kind 일반화 선행 필요"로 이번 라운드 범위 밖, A9(학습)는
 * "부적격(상태공간)"으로 이번 라운드에서도 제외 대상).
 *
 * 지금까지 모든 트리 prior 후보(round1 chain/defensive, round2 combined)는
 * `CHOICE_EVALUATOR_TIER` 계열의 **이산 티어**(승리=50, 차단=45, 포크=40, …)를
 * 축으로 삼는다 — 같은 티어 안의 모든 후보 착점은 (동률 처리를 빼면) 사실상
 * 무차별해진다. 이 evaluator는 그 반대 축을 시도한다: L2 앵커
 * (`../experiments/gomoku-opus-bot.ts`)가 실제로 쓰는 **연속(continuous)
 * 위협 점수** — 각 방향의 (연결 길이, 열린 끝 수) 조합을 이산 등급이 아니라
 * 매끄러운 스칼라(directionThreat, 이 파일 자체 재구현, L2 소스 그대로 이식)로
 * 매기고, 자기 위협 + 0.95×상대 위협 + 중앙 보너스로 합산한다. 즉시승
 * (연결≥5)은 여전히 압도적 sentinel(1,000,000)로 처리돼 softmax 이후 사실상
 * 결정적으로 선택되므로, 명시적 tier 분기 없이도 안전망 기능이 보존된다.
 *
 * 설계 근거: L2(Opus봇)를 상대로 v6/combined 둘 다 여전히 초반 분기에서
 * 진다(design-brief-round2.md "핵심 발견 1/2") — L2 자신의 점수 함수를
 * 트리 prior로 직접 이식하면, L2가 초반에 무엇을 "좋다"고 보는지의 연속적
 * 순위 정보가 이산 티어보다 더 촘촘하게 탐색을 안내할 수 있다는 가설.
 * B4-explore의 "행동 지문이 챔피언과 최대 거리" 기준도 만족 — 현재 챔피언
 * v6(=defensive 단독, 이산 티어+잠재 free-two)와 점수 산출 방식 자체가
 * 이산/연속이라는 축에서 대비된다.
 *
 * 의도적으로 `../experiments/gomoku-opus-bot.ts`를 import하지 않고 그 채점
 * 로직을 이 파일 안에서 재구현한다 — L2는 registry의 외부 홀드아웃/피드백
 * 앵커이므로(docs/adr/0012) 그 파일에 export를 추가해 실험용 의존을 만들지
 * 않기 위함(앵커 파일은 절대 변경하지 않는다는 이 라운드의 원칙과 별개로,
 * 앵커가 실험 코드에 재사용되면 "L2 자신을 prior로 쓴 봇을 L2에게 붙여
 * 이긴다"는 순환 논증 여지를 없애기 위한 방어적 설계이기도 하다). 상수/공식은
 * gomoku-opus-bot.ts와 동일(WIN_LENGTH=5, DEFENSE_WEIGHT=0.95, 방향별
 * 임계값 상수) — 이식이 목적이므로 값을 바꾸지 않는다.
 *
 * Meant to be supplied via `MctsConfig.priorEvaluator` (search/mcts.ts),
 * exactly like `gomokuChainEvaluator`/`gomokuDefensiveEvaluator`.
 */

import type { PlayerId } from '../../contract/types';
import type { Cell, GomokuMove, GomokuState } from '../gomoku';
import { BOARD_SIZE } from '../gomoku';

const CENTER = (BOARD_SIZE - 1) / 2;
const WIN_LENGTH = 5;

const DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

function indexOf(row: number, col: number): number {
  return row * BOARD_SIZE + col;
}

function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function playerToCell(player: PlayerId): Cell {
  return player === 0 ? 1 : 2;
}

/** Verbatim port of gomoku-opus-bot.ts's `directionThreat` (this file's own doc comment — same constants, same formula). */
function directionThreat(board: readonly Cell[], row: number, col: number, cell: Cell, dr: number, dc: number): number {
  let forward = 0;
  let r = row + dr;
  let c = col + dc;
  while (inBounds(r, c) && board[indexOf(r, c)] === cell) {
    forward += 1;
    r += dr;
    c += dc;
  }
  const forwardOpen = inBounds(r, c) && board[indexOf(r, c)] === 0;

  let backward = 0;
  r = row - dr;
  c = col - dc;
  while (inBounds(r, c) && board[indexOf(r, c)] === cell) {
    backward += 1;
    r -= dr;
    c -= dc;
  }
  const backwardOpen = inBounds(r, c) && board[indexOf(r, c)] === 0;

  const total = forward + backward + 1;
  const openEnds = (forwardOpen ? 1 : 0) + (backwardOpen ? 1 : 0);

  if (total >= WIN_LENGTH) return 1_000_000;
  if (openEnds === 0) return 0;
  if (total === 4) return openEnds === 2 ? 50_000 : 2_000;
  if (total === 3) return openEnds === 2 ? 800 : 60;
  if (total === 2) return openEnds === 2 ? 40 : 6;
  return openEnds === 2 ? 4 : 1;
}

function placementScore(board: readonly Cell[], move: GomokuMove, cell: Cell): number {
  let score = 0;
  for (const [dr, dc] of DIRECTIONS) {
    score += directionThreat(board, move.row, move.col, cell, dr, dc);
  }
  return score;
}

function centerBonus(move: GomokuMove): number {
  const dist = Math.max(Math.abs(move.row - CENTER), Math.abs(move.col - CENTER));
  return (BOARD_SIZE - dist) * 0.5;
}

/** Same weight as gomoku-opus-bot.ts's `DEFENSE_WEIGHT` (this file's own doc comment). */
const DEFENSE_WEIGHT = 0.95;

/**
 * Own-side-only threat scores for `choices` (GAP-11 round5 addition): the
 * offense half of `gomokuOpusCloneEvaluator` below, without the defensive
 * mirror term or the center bonus. Added as an export (no behavior change to
 * the evaluator itself) so round5's draw-averse evaluator
 * (./gomoku-draw-averse-evaluator.ts) and round5's draw-convergence mining
 * analysis (../runners/gomoku-loss-mining-round5.ts) both reuse this exact
 * scoring instead of porting `directionThreat` a third time.
 */
export function gomokuOwnThreatScores(
  state: GomokuState,
  player: PlayerId,
  choices: readonly GomokuMove[],
): readonly number[] {
  const cell = playerToCell(player);
  return choices.map((move) => placementScore(state.board, move, cell));
}

/** Threat tier boundaries of `directionThreat` above, exported for round5's
 * "was a decisive attack still available?" mining question — 800 is the
 * open-three score, the lowest tier that forces a reply. */
export const GOMOKU_OPEN_THREE_SCORE = 800;

/**
 * Continuous L2-style per-choice evaluator (search/mcts.ts's
 * `MctsConfig.priorEvaluator` shape) — see this file's own doc comment.
 */
export function gomokuOpusCloneEvaluator(
  state: GomokuState,
  player: PlayerId,
  choices: readonly GomokuMove[],
): readonly number[] {
  const board = state.board;
  const myCell = playerToCell(player);
  const oppCell: Cell = myCell === 1 ? 2 : 1;

  return choices.map(
    (move) => placementScore(board, move, myCell) + DEFENSE_WEIGHT * placementScore(board, move, oppCell) + centerBonus(move),
  );
}
