import { gomokuOpusCloneEvaluator } from '../gomoku-opus-clone-evaluator';
import type { Cell, GomokuMove, GomokuState } from '../../gomoku';
import { BOARD_SIZE } from '../../gomoku';

function emptyBoard(): Cell[] {
  return new Array<Cell>(BOARD_SIZE * BOARD_SIZE).fill(0);
}

function state(board: Cell[]): GomokuState {
  return { board, moveCount: board.filter((cell) => cell !== 0).length, winner: null, openingId: 'fixture' };
}

const SELF: 0 = 0;

function scoreFor(board: Cell[], move: GomokuMove): number {
  const [score] = gomokuOpusCloneEvaluator(state(board), SELF, [move]);
  return score as number;
}

describe('gomokuOpusCloneEvaluator (docs/GAP-ANALYSIS-11.md Phase 4-B B4, A10 이식)', () => {
  it('scores an immediate self-win as the dominant sentinel value', () => {
    const board = emptyBoard();
    board[7 * BOARD_SIZE + 4] = 1;
    board[7 * BOARD_SIZE + 5] = 1;
    board[7 * BOARD_SIZE + 6] = 1;
    board[7 * BOARD_SIZE + 7] = 1;
    const winScore = scoreFor(board, { row: 7, col: 8 });

    const quietBoard = emptyBoard();
    const quietScore = scoreFor(quietBoard, { row: 7, col: 7 });

    expect(winScore).toBeGreaterThan(quietScore);
    expect(winScore).toBeGreaterThan(100_000);
  });

  it('weights denying an opponent open four above an unrelated quiet move', () => {
    const board = emptyBoard();
    board[7 * BOARD_SIZE + 5] = 2;
    board[7 * BOARD_SIZE + 6] = 2;
    board[7 * BOARD_SIZE + 7] = 2;
    board[7 * BOARD_SIZE + 8] = 2;
    const blockScore = scoreFor(board, { row: 7, col: 4 });

    const quietScore = scoreFor(board, { row: 0, col: 0 });
    expect(blockScore).toBeGreaterThan(quietScore);
  });

  it('gives higher score to a move closer to the board center, all else equal', () => {
    const board = emptyBoard();
    const centerScore = scoreFor(board, { row: 7, col: 7 });
    const cornerScore = scoreFor(board, { row: 0, col: 0 });
    expect(centerScore).toBeGreaterThan(cornerScore);
  });
});
