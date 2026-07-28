import { gomokuMidBot } from '../gomoku-mid-bot';
import type { Cell, GomokuChoice, GomokuObservation } from '../../gomoku';
import { BOARD_SIZE } from '../../gomoku';

function emptyBoard(): Cell[] {
  return new Array<Cell>(BOARD_SIZE * BOARD_SIZE).fill(0);
}

function obs(overrides: Partial<GomokuObservation>): GomokuObservation {
  return {
    self: 0,
    board: emptyBoard(),
    moveCount: 0,
    toMove: 0,
    ...overrides,
  };
}

describe('gomokuMidBot determinism (C1)', () => {
  it('returns the same decision for the same seed and observation, repeated', () => {
    const bot1 = gomokuMidBot(7);
    const bot2 = gomokuMidBot(7);
    const legal: GomokuChoice[] = [
      { row: 7, col: 7 },
      { row: 7, col: 8 },
      { row: 0, col: 0 },
    ];
    const observation = obs({});
    expect(bot1.decide('place', observation, legal)).toEqual(bot2.decide('place', observation, legal));
  });
});

describe('gomokuMidBot — tactics', () => {
  it('takes an immediate win over anything else', () => {
    const board = emptyBoard();
    // Black (cell 1) has four in a row at (7,3..6); (7,7) completes five.
    board[7 * BOARD_SIZE + 3] = 1;
    board[7 * BOARD_SIZE + 4] = 1;
    board[7 * BOARD_SIZE + 5] = 1;
    board[7 * BOARD_SIZE + 6] = 1;
    const bot = gomokuMidBot(1);
    const legal: GomokuChoice[] = [
      { row: 0, col: 0 },
      { row: 7, col: 7 },
    ];
    const choice = bot.decide('place', obs({ self: 0, board }), legal);
    expect(choice).toEqual({ row: 7, col: 7 });
  });

  it('blocks the opponent immediate win when it cannot win itself', () => {
    const board = emptyBoard();
    // White (cell 2) has four in a row; black must block at (7,7).
    board[7 * BOARD_SIZE + 3] = 2;
    board[7 * BOARD_SIZE + 4] = 2;
    board[7 * BOARD_SIZE + 5] = 2;
    board[7 * BOARD_SIZE + 6] = 2;
    const bot = gomokuMidBot(2);
    const legal: GomokuChoice[] = [
      { row: 0, col: 0 },
      { row: 7, col: 7 },
    ];
    const choice = bot.decide('place', obs({ self: 0, board }), legal);
    expect(choice).toEqual({ row: 7, col: 7 });
  });

  it('every decision stays within the legal set when no tactic applies', () => {
    const bot = gomokuMidBot(3);
    const legal: GomokuChoice[] = [
      { row: 1, col: 1 },
      { row: 2, col: 2 },
      { row: 3, col: 3 },
    ];
    const choice = bot.decide('place', obs({}), legal);
    expect(legal).toContainEqual(choice);
  });
});
