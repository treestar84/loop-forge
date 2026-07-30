import { gomokuCloneChainPriorEvaluator } from '../gomoku-clone-chain-prior-evaluator';
import { gomokuOpusCloneEvaluator } from '../gomoku-opus-clone-evaluator';
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

describe('gomokuCloneChainPriorEvaluator (GAP-11 round4 B4-explore, clone-then-chain-prior combination)', () => {
  it('equals opusclone score + chain score for every choice, unweighted', () => {
    const board = emptyBoard();
    board[7 * BOARD_SIZE + 4] = 1;
    board[7 * BOARD_SIZE + 5] = 1;
    const move: GomokuMove = { row: 7, col: 7 };
    const s = state(board);

    const [combined] = gomokuCloneChainPriorEvaluator(s, SELF, [move]);
    const [clone] = gomokuOpusCloneEvaluator(s, SELF, [move]);
    const [chain] = gomokuChainEvaluator(s, SELF, [move]);

    expect(combined).toBeCloseTo((clone as number) + (chain as number), 10);
  });

  it('still ranks an immediate win as the dominant choice', () => {
    const board = emptyBoard();
    board[7 * BOARD_SIZE + 4] = 1;
    board[7 * BOARD_SIZE + 5] = 1;
    board[7 * BOARD_SIZE + 6] = 1;
    board[7 * BOARD_SIZE + 7] = 1;
    const s = state(board);
    const [winScore] = gomokuCloneChainPriorEvaluator(s, SELF, [{ row: 7, col: 8 }]);
    const [quietScore] = gomokuCloneChainPriorEvaluator(s, SELF, [{ row: 0, col: 0 }]);
    expect(winScore as number).toBeGreaterThan(quietScore as number);
  });
});
