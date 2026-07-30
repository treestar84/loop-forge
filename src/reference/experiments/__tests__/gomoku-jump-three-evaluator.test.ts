import { gomokuJumpThreeEvaluator } from '../gomoku-jump-three-evaluator';
import type { Cell, GomokuMove, GomokuState } from '../../gomoku';
import { BOARD_SIZE, CHOICE_EVALUATOR_TIER } from '../../gomoku';

function emptyBoard(): Cell[] {
  return new Array<Cell>(BOARD_SIZE * BOARD_SIZE).fill(0);
}

function state(board: Cell[]): GomokuState {
  return { board, moveCount: board.filter((cell) => cell !== 0).length, winner: null, openingId: 'fixture' };
}

const SELF: 0 = 0;

function scoreFor(board: Cell[], move: GomokuMove): number {
  const [score] = gomokuJumpThreeEvaluator(state(board), SELF, [move]);
  return score as number;
}

describe('gomokuJumpThreeEvaluator (GAP-11 round4 B2-opponent, jump-three/跳三 axis)', () => {
  it('reuses gomokuChoiceEvaluator: an immediate self-win still dominates a jump-three bonus', () => {
    const board = emptyBoard();
    board[7 * BOARD_SIZE + 4] = 1;
    board[7 * BOARD_SIZE + 5] = 1;
    board[7 * BOARD_SIZE + 6] = 1;
    board[7 * BOARD_SIZE + 7] = 1;
    const winScore = scoreFor(board, { row: 7, col: 8 });

    const jumpBoard = emptyBoard();
    jumpBoard[7 * BOARD_SIZE + 4] = 1;
    jumpBoard[7 * BOARD_SIZE + 5] = 1;
    const jumpScore = scoreFor(jumpBoard, { row: 7, col: 7 });

    expect(winScore).toBeGreaterThan(jumpScore);
  });

  it('scores an SS_S jump-three (own stones, room on both sides) above an unrelated quiet move', () => {
    const board = emptyBoard();
    board[7 * BOARD_SIZE + 4] = 1;
    board[7 * BOARD_SIZE + 5] = 1;
    // col 6 stays empty (the gap); placing at col 7 completes the SS_S shape.
    const jumpScore = scoreFor(board, { row: 7, col: 7 });
    const quietScore = scoreFor(board, { row: 0, col: 0 });

    expect(jumpScore).toBeGreaterThan(quietScore);
  });

  it('does not fire on a plain contiguous three (gap only at a window end, already handled by the base tiers)', () => {
    const boardContiguous = emptyBoard();
    boardContiguous[7 * BOARD_SIZE + 5] = 1;
    boardContiguous[7 * BOARD_SIZE + 6] = 1;
    // Placing at col 7 makes a contiguous _SSS_ open three, not a jump shape —
    // the gap in every 4-window this move belongs to sits at a window end
    // (position 0 or 3), which countJumpThreeWindows deliberately excludes.
    const contiguousScore = scoreFor(boardContiguous, { row: 7, col: 7 });
    expect(contiguousScore).toBe(CHOICE_EVALUATOR_TIER.openThree);
  });

  it('mirrors an opponent jump-three shape at reduced (0.8x) weight — denying it still beats a quiet move', () => {
    const board = emptyBoard();
    board[7 * BOARD_SIZE + 4] = 2;
    board[7 * BOARD_SIZE + 5] = 2;
    // Opponent (cell=2) has SS_S potential through col 7; self move there denies it.
    const denyScore = scoreFor(board, { row: 7, col: 7 });
    const quietScore = scoreFor(board, { row: 0, col: 0 });

    expect(denyScore).toBeGreaterThan(quietScore);
  });

  it('is deterministic: the same board/move always returns the same score', () => {
    const board = emptyBoard();
    board[7 * BOARD_SIZE + 4] = 1;
    board[7 * BOARD_SIZE + 5] = 1;
    const move: GomokuMove = { row: 7, col: 7 };
    expect(scoreFor(board, move)).toBe(scoreFor(board, move));
  });
});
