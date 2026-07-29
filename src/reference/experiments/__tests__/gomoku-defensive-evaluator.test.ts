import { gomokuDefensiveEvaluator } from '../gomoku-defensive-evaluator';
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
  const [score] = gomokuDefensiveEvaluator(state(board), SELF, [move]);
  return score as number;
}

describe('gomokuDefensiveEvaluator (docs/GAP-ANALYSIS-11.md Phase 3-B B4)', () => {
  it('scores blocking the opponent fork above building a self fork (defense-first tier inversion)', () => {
    // Opponent (cell 2) fork setup at (7,7): stones at (7,8)/(7,9) [horizontal]
    // and (8,7)/(9,7) [vertical], each an open two — placing opponent stone at
    // (7,7) would create two simultaneous open threes (a fork).
    const blockBoard = emptyBoard();
    blockBoard[7 * BOARD_SIZE + 8] = 2;
    blockBoard[7 * BOARD_SIZE + 9] = 2;
    blockBoard[8 * BOARD_SIZE + 7] = 2;
    blockBoard[9 * BOARD_SIZE + 7] = 2;
    const blockForkScore = scoreFor(blockBoard, { row: 7, col: 7 });

    // Self (cell 1) fork setup, mirrored: self stones creating a self-fork at (7,7).
    const selfForkBoard = emptyBoard();
    selfForkBoard[7 * BOARD_SIZE + 8] = 1;
    selfForkBoard[7 * BOARD_SIZE + 9] = 1;
    selfForkBoard[8 * BOARD_SIZE + 7] = 1;
    selfForkBoard[9 * BOARD_SIZE + 7] = 1;
    const selfForkScore = scoreFor(selfForkBoard, { row: 7, col: 7 });

    expect(blockForkScore).toBeGreaterThan(selfForkScore);
  });

  it('weights denying an opponent latent structure above building an equal-sized own structure (억제 최우선)', () => {
    const denyBoard = emptyBoard();
    // Opponent stone at (7,8): placing our move at (7,7) denies their free-two.
    denyBoard[7 * BOARD_SIZE + 8] = 2;
    const denyScore = scoreFor(denyBoard, { row: 7, col: 7 });

    const buildBoard = emptyBoard();
    // Self stone at (7,8): placing our move at (7,7) builds our own free-two of the same shape.
    buildBoard[7 * BOARD_SIZE + 8] = 1;
    const buildScore = scoreFor(buildBoard, { row: 7, col: 7 });

    expect(denyScore).toBeGreaterThan(buildScore);
  });
});
