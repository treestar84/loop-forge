/**
 * gomoku-jump-three-evaluator — GAP-11 Phase 6 round4 B2-opponent candidate
 * (실행 에이전트 설계, runs/gomoku/design-brief-round4.md + 팀리드 지시: round4
 * 신규 프로브 46개의 공통 패턴을 겨냥한, B3의 "동점 타이브레이크"와는 다른 축).
 *
 * round4 프로브 은행(probe-bank-round4.json)의 decisionIndex 분포를 집계하면
 * 더 이상 라운드1/2처럼 초반(0-9)에만 몰려 있지 않다(0:21, 10-19:5, 20-29:9,
 * 30-39:3, 50-59:3, 70-79:1, 80-89:1, 90-99:1, 100-109:2 — 전체 46개 중
 * 절반 미달만 0구간) — 브리프 자신의 "핵심 발견 1"과 일치("국지적 전술
 * 실수가 게임 전반에 흩어져 있다"). 이 흩어진 실수들이 공유하는 구조적
 * 공통점을 찾기보다(46개 국면 각각의 보드를 재구성해 개별 분석하는 것은
 * 이번 라운드 예산 밖), 기존 모든 prior evaluator(chain/defensive/combined/
 * opusclone)가 놓치는 **기하학적 사각지대**를 겨냥한다: 지금까지의 모든
 * 축은 전부 **연속(contiguous)** 배열만 본다 — `gomoku-chain-evaluator.ts`의
 * "자유 2연"도 인접한 2개의 돌만 인정하고, `gomokuChoiceEvaluator`의
 * openThree/four도 마찬가지로 연속 배열만 감지한다. 그러나 오목의 표준
 * 전술 어휘에는 **뛰어넘은 배치**("跳三", jump three — S_SS 또는 SS_S처럼
 * 하나의 빈 칸을 사이에 둔 3개의 돌, 그 빈 칸을 채우면 열린4로 즉시 전환되는
 * 강제 압박형)가 명시적으로 존재하고, 이 형태는 연속-배열 탐지기로는 절대
 * 잡히지 않는다 — 이것이 round4 프로브의 흩어진 국지적 오류(place 불일치
 * 4.0%, 46/1152)를 만들어냈을 가능성이 있는, 아직 시도되지 않은 순수하게
 * 새로운 기하학적 축이다.
 *
 * 설계: `gomokuChoiceEvaluator`(../gomoku.ts, 이미 검증됨 — 6개 이산 티어:
 * win/blockWin/fork/blockFork/four/openThree)를 그대로 재사용(로직 중복
 * 금지)해 안전망(즉시승/즉시차단/포크)을 그대로 보존하고, 그 위에 "jump
 * three" 카운트에 비례하는 가산 보너스를 더한다(`gomoku-chain-evaluator.ts`가
 * openThree 아래에 latent free-two 가산을 더하는 것과 같은 additive 스타일 —
 * 다만 이 파일은 그 축과 겹치지 않는 별도의 기하 형태를 잡는다는 점이 다름).
 * 상대의 jump-three 형태도 0.8x 가중(수비 미러, chain evaluator와 동일 비율)
 * 으로 더한다.
 *
 * 알려진 한계(숨기지 않음): "room" 판정을 5-in-a-row까지의 정확한 여유
 * 칸 수 계산 대신 "패턴 양쪽 바로 바깥 한 칸이 상대 돌이 아님"이라는 약한
 * 조건으로 단순화했다 — chain evaluator의 `isFreeTwo`처럼 전체 여유 칸을
 * 정밀 계산하는 대신, 판당 비용을 낮추기 위한 의도적 근사(이 게임의 보드가
 * 15x15로 넓어 대부분의 중반 국면에서 이 근사와 정밀 계산의 차이가 실제
 * 발생하는 위치는 드묾). 가산 보너스는 상한 없음(연속 openThree/four 티어와
 * 마찬가지로 chain evaluator의 "알려진 edge case" 문서화 관행을 그대로 따름).
 *
 * Meant to be supplied via `MctsConfig.priorEvaluator` (search/mcts.ts),
 * exactly like `gomokuChainEvaluator`/`gomokuDefensiveEvaluator`/
 * `gomokuCombinedEvaluator`.
 */

import type { PlayerId } from '../../contract/types';
import { gomokuChoiceEvaluator } from '../gomoku';
import type { Cell, GomokuMove, GomokuState } from '../gomoku';
import { BOARD_SIZE } from '../gomoku';

const DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

/** Per jump-three window found for the deciding player (this file's own doc comment). */
const JUMP_THREE_BONUS = 8;
/** Mirror weight applied to the opponent's own jump-three count at the same cell (matches gomoku-chain-evaluator.ts's 0.8x defense-mirror ratio). */
const DEFENSE_MIRROR_WEIGHT = 0.8;

function indexOf(row: number, col: number): number {
  return row * BOARD_SIZE + col;
}

function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function playerToCell(player: PlayerId): Cell {
  return player === 0 ? 1 : 2;
}

function otherPlayer(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

/**
 * Counts "jump three" windows along one axis through (row,col), hypothetically
 * placing `cell` at that position (same "moveIdx override, no board copy"
 * technique as `gomoku-chain-evaluator.ts`'s `lineInfo` — and, matching that
 * file's own defense-mirror convention, the hypothetical stone placed at
 * moveIdx is always `cell` itself, whether `cell` is the deciding player's
 * own stone (the real move) or the opponent's (the "what would this cell be
 * worth to them" mirror query)): a length-4 window containing (row,col) with
 * exactly 3 `cell` stones and exactly 1 empty cell at an *internal* window
 * position (index 1 or 2 of the 4-window) — the gap that, once filled,
 * completes a contiguous 4. A gap at index 0 or 3 is a plain contiguous run
 * of 3 (already caught by `gomokuChoiceEvaluator`'s openThree/four tiers),
 * so those are deliberately excluded here to avoid double-scoring the same
 * shape twice. `opponent` stones inside the window disqualify it outright
 * (a window with any opposing stone cannot become a live four); the two
 * cells immediately outside the window must also not be `opponent` (weak
 * room check, this file's own doc comment).
 */
function countJumpThreeWindows(
  board: readonly Cell[],
  moveIdx: number,
  row: number,
  col: number,
  dr: number,
  dc: number,
  cell: Cell,
  opponent: Cell,
): number {
  const at = (r: number, c: number): Cell | null => {
    if (!inBounds(r, c)) return null;
    const i = indexOf(r, c);
    return i === moveIdx ? cell : (board[i] as Cell);
  };

  let count = 0;
  for (let k = -3; k <= 0; k += 1) {
    const positions: (Cell | null)[] = [0, 1, 2, 3].map((offset) => at(row + (k + offset) * dr, col + (k + offset) * dc));
    if (positions.some((value) => value === null)) {
      continue;
    }
    let cellCount = 0;
    let opponentCount = 0;
    let gapPosition = -1;
    let gapCount = 0;
    positions.forEach((value, position) => {
      if (value === cell) {
        cellCount += 1;
      } else if (value === opponent) {
        opponentCount += 1;
      } else {
        gapCount += 1;
        gapPosition = position;
      }
    });
    if (cellCount !== 3 || gapCount !== 1 || opponentCount !== 0) {
      continue;
    }
    if (gapPosition !== 1 && gapPosition !== 2) {
      continue; // contiguous run (gap at a window end) — already covered by gomokuChoiceEvaluator's tiers.
    }
    const before = at(row + (k - 1) * dr, col + (k - 1) * dc);
    const after = at(row + (k + 4) * dr, col + (k + 4) * dc);
    if (before === opponent || after === opponent) {
      continue; // dead on at least one side.
    }
    count += 1;
  }
  return count;
}

/**
 * Per-choice evaluator (search/mcts.ts's `MctsConfig.priorEvaluator` shape):
 * `gomokuChoiceEvaluator`'s 6 discrete tiers verbatim (reused, not
 * reimplemented), plus an additive "jump three" bonus for both the deciding
 * player and (mirrored, 0.8x) the opponent — see this file's own doc comment.
 */
export function gomokuJumpThreeEvaluator(
  state: GomokuState,
  player: PlayerId,
  choices: readonly GomokuMove[],
): readonly number[] {
  const base = gomokuChoiceEvaluator(state, player, choices);
  const board = state.board;
  const selfCell = playerToCell(player);
  const opponentCell = playerToCell(otherPlayer(player));

  return choices.map((move, index) => {
    const moveIdx = indexOf(move.row, move.col);
    let bonus = 0;
    for (const [dr, dc] of DIRECTIONS) {
      const selfWindows = countJumpThreeWindows(board, moveIdx, move.row, move.col, dr, dc, selfCell, opponentCell);
      const opponentWindows = countJumpThreeWindows(board, moveIdx, move.row, move.col, dr, dc, opponentCell, selfCell);
      bonus += selfWindows * JUMP_THREE_BONUS + opponentWindows * JUMP_THREE_BONUS * DEFENSE_MIRROR_WEIGHT;
    }
    return (base[index] as number) + bonus;
  });
}
