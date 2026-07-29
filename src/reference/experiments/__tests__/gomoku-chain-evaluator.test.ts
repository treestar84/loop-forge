import { gomokuChainEvaluator } from '../gomoku-chain-evaluator';
import type { Cell, GomokuMove, GomokuState } from '../../gomoku';
import { BOARD_SIZE } from '../../gomoku';

function emptyBoard(): Cell[] {
  return new Array<Cell>(BOARD_SIZE * BOARD_SIZE).fill(0);
}

function state(board: Cell[]): GomokuState {
  return { board, moveCount: board.filter((cell) => cell !== 0).length, winner: null, openingId: 'fixture' };
}

const SELF: 0 = 0;
const OPPONENT: 1 = 1;

function scoreFor(board: Cell[], move: GomokuMove): number {
  const [score] = gomokuChainEvaluator(state(board), SELF, [move]);
  return score as number;
}

describe('gomokuChainEvaluator (docs/GAP-ANALYSIS-11.md Phase 3-B B3)', () => {
  it('scores a free-two-with-room move above an ordinary isolated move', () => {
    const board = emptyBoard();
    // Self (cell 1) stone at (7,7); (7,8) extends it into a free two (both
    // ends open, plenty of room on an otherwise empty board).
    board[7 * BOARD_SIZE + 7] = 1;

    const freeTwoScore = scoreFor(board, { row: 7, col: 8 });
    const ordinaryScore = scoreFor(board, { row: 0, col: 0 });

    expect(freeTwoScore).toBeGreaterThan(ordinaryScore);
  });

  it('rewards a move that creates two simultaneous free-two lines with more than double a single line\'s score (선행 교차점 보너스)', () => {
    const twoLineBoard = emptyBoard();
    // Self stones at (7,8) [horizontal neighbor] and (8,7) [vertical
    // neighbor] of the move (7,7) — placing at (7,7) creates a free two on
    // both axes at once.
    twoLineBoard[7 * BOARD_SIZE + 8] = 1;
    twoLineBoard[8 * BOARD_SIZE + 7] = 1;
    const twoLineScore = scoreFor(twoLineBoard, { row: 7, col: 7 });

    const oneLineBoard = emptyBoard();
    // Same move, but only the horizontal neighbor is present — exactly one free-two line.
    oneLineBoard[7 * BOARD_SIZE + 8] = 1;
    const oneLineScore = scoreFor(oneLineBoard, { row: 7, col: 7 });

    expect(twoLineScore).toBeGreaterThan(2 * oneLineScore);
  });

  it('applies the 0.8x defensive mirror when a move denies a forming opponent free-two structure (수비 미러)', () => {
    const denyBoard = emptyBoard();
    // Opponent (cell 2) stone at (10, 10); if the opponent played at
    // (10, 11) next they would form their own free two there. The move
    // being scored is *our* candidate move at that same cell.
    denyBoard[10 * BOARD_SIZE + 10] = 2;
    const denyScore = scoreFor(denyBoard, { row: 10, col: 11 });

    const neutralBoard = emptyBoard();
    const neutralScore = scoreFor(neutralBoard, { row: 3, col: 3 });

    expect(denyScore).toBeGreaterThan(neutralScore);
  });

  it('still ranks the 6 discrete tiers (win/blockWin/fork/blockFork/four/openThree) above any latent-only score', () => {
    const board = emptyBoard();
    // Self (cell 1) has four in a row at (7,3..6); (7,7) or (7,2) completes five.
    board[7 * BOARD_SIZE + 3] = 1;
    board[7 * BOARD_SIZE + 4] = 1;
    board[7 * BOARD_SIZE + 5] = 1;
    board[7 * BOARD_SIZE + 6] = 1;
    // A latent-only move elsewhere on the same board.
    board[9 * BOARD_SIZE + 9] = 1;

    const winScore = scoreFor(board, { row: 7, col: 7 });
    const latentScore = scoreFor(board, { row: 9, col: 10 });

    expect(winScore).toBe(50);
    expect(winScore).toBeGreaterThan(latentScore);
  });
});
