import { gomokuChainEvaluator } from '../gomoku-chain-evaluator';
import { gomokuDefensiveEvaluator } from '../gomoku-defensive-evaluator';
import { DEFAULT_CHAIN_WEIGHT, gomokuCombinedEvaluator, makeGomokuCombinedEvaluator } from '../gomoku-combined-evaluator';
import type { Cell, GomokuMove, GomokuState } from '../../gomoku';
import { BOARD_SIZE } from '../../gomoku';

function emptyBoard(): Cell[] {
  return new Array<Cell>(BOARD_SIZE * BOARD_SIZE).fill(0);
}

function state(board: Cell[]): GomokuState {
  return { board, moveCount: board.filter((cell) => cell !== 0).length, winner: null, openingId: 'fixture' };
}

const SELF: 0 = 0;

describe('gomokuCombinedEvaluator (docs/GAP-ANALYSIS-11.md Phase 4-B B3 처치 1)', () => {
  it('equals defensiveScore + DEFAULT_CHAIN_WEIGHT * chainScore for every choice on a mixed board', () => {
    const board = emptyBoard();
    // A few scattered stones so both discrete tiers and latent free-two tiers
    // are exercised for at least some of the candidate moves below.
    board[7 * BOARD_SIZE + 8] = 1;
    board[7 * BOARD_SIZE + 9] = 1;
    board[8 * BOARD_SIZE + 7] = 2;
    board[9 * BOARD_SIZE + 7] = 2;
    const s = state(board);
    const choices: GomokuMove[] = [
      { row: 7, col: 7 },
      { row: 6, col: 8 },
      { row: 10, col: 10 },
    ];

    const combined = gomokuCombinedEvaluator(s, SELF, choices);
    const defensive = gomokuDefensiveEvaluator(s, SELF, choices);
    const chain = gomokuChainEvaluator(s, SELF, choices);

    choices.forEach((_choice, index) => {
      expect(combined[index]).toBeCloseTo((defensive[index] as number) + DEFAULT_CHAIN_WEIGHT * (chain[index] as number), 10);
    });
  });

  it('makeGomokuCombinedEvaluator applies a caller-supplied chainWeight instead of the default (B1 0.4 variant)', () => {
    const board = emptyBoard();
    board[7 * BOARD_SIZE + 8] = 1;
    const s = state(board);
    const choices: GomokuMove[] = [{ row: 7, col: 7 }];

    const weighted = makeGomokuCombinedEvaluator(0.4)(s, SELF, choices);
    const defensive = gomokuDefensiveEvaluator(s, SELF, choices);
    const chain = gomokuChainEvaluator(s, SELF, choices);

    expect(weighted[0]).toBeCloseTo((defensive[0] as number) + 0.4 * (chain[0] as number), 10);
  });

  it('weights defense-dominant (chainWeight < 1): blocking an opponent fork still outranks building a self free-two', () => {
    const blockBoard = emptyBoard();
    blockBoard[7 * BOARD_SIZE + 8] = 2;
    blockBoard[7 * BOARD_SIZE + 9] = 2;
    blockBoard[8 * BOARD_SIZE + 7] = 2;
    blockBoard[9 * BOARD_SIZE + 7] = 2;
    const [blockForkScore] = gomokuCombinedEvaluator(state(blockBoard), SELF, [{ row: 7, col: 7 }]);

    const latentBoard = emptyBoard();
    latentBoard[3 * BOARD_SIZE + 3] = 1;
    const [latentScore] = gomokuCombinedEvaluator(state(latentBoard), SELF, [{ row: 3, col: 4 }]);

    expect(blockForkScore as number).toBeGreaterThan(latentScore as number);
  });
});
