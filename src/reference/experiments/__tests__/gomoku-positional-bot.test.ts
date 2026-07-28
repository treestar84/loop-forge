import { gomokuPositionalBot } from '../gomoku-positional-bot';
import { BOARD_SIZE, type Cell, type GomokuChoice, type GomokuObservation } from '../../gomoku';

function emptyBoard(): Cell[] {
  return Array.from({ length: BOARD_SIZE * BOARD_SIZE }, () => 0 as Cell);
}

function place(board: Cell[], row: number, col: number, cell: Cell): void {
  board[row * BOARD_SIZE + col] = cell;
}

function observation(board: readonly Cell[], self: 0 | 1 = 0): GomokuObservation {
  const moveCount = board.filter((cell) => cell !== 0).length;
  return { self, board, moveCount, toMove: self };
}

function legalFrom(board: readonly Cell[]): GomokuChoice[] {
  const moves: GomokuChoice[] = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (board[row * BOARD_SIZE + col] === 0) moves.push({ row, col });
    }
  }
  return moves;
}

describe('gomokuPositionalBot determinism (C1)', () => {
  it('returns the same decision for the same seed and observation, repeated', () => {
    const board = emptyBoard();
    place(board, 7, 7, 1);
    place(board, 7, 8, 2);
    place(board, 6, 7, 1);
    const obs = observation(board);
    const legal = legalFrom(board);

    const bot1 = gomokuPositionalBot(111);
    const bot2 = gomokuPositionalBot(111);
    expect(bot1.decide('place', obs, legal)).toEqual(bot2.decide('place', obs, legal));
  });

  it('is stateless across repeated calls on one instance', () => {
    const board = emptyBoard();
    place(board, 3, 3, 1);
    const obs = observation(board);
    const legal = legalFrom(board);
    const bot = gomokuPositionalBot(7);
    expect(bot.decide('place', obs, legal)).toEqual(bot.decide('place', obs, legal));
  });
});

describe('gomokuPositionalBot — safety net priority', () => {
  it('takes its own immediate win (four in a row completed at the open end)', () => {
    const board = emptyBoard();
    for (let col = 1; col <= 4; col += 1) place(board, 5, col, 1); // black: (5,1)..(5,4)
    const legal = legalFrom(board);
    const choice = gomokuPositionalBot(1).decide('place', observation(board, 0), legal);
    expect([
      { row: 5, col: 0 },
      { row: 5, col: 5 },
    ]).toContainEqual(choice);
  });

  it('blocks the opponent immediate win when it has none of its own', () => {
    const board = emptyBoard();
    for (let col = 5; col <= 8; col += 1) place(board, 9, col, 2); // white four in a row
    place(board, 0, 0, 1); // one lone black stone, no threat
    const legal = legalFrom(board);
    const choice = gomokuPositionalBot(2).decide('place', observation(board, 0), legal);
    expect([
      { row: 9, col: 4 },
      { row: 9, col: 9 },
    ]).toContainEqual(choice);
  });

  it('prefers its own win over blocking the opponent when both exist', () => {
    const board = emptyBoard();
    for (let col = 1; col <= 4; col += 1) place(board, 2, col, 1); // black can win at (2,0)/(2,5)
    for (let col = 1; col <= 4; col += 1) place(board, 12, col, 2); // white can win at (12,0)/(12,5)
    const legal = legalFrom(board);
    const choice = gomokuPositionalBot(3).decide('place', observation(board, 0), legal);
    expect(choice.row).toBe(2);
  });
});

describe('gomokuPositionalBot — evaluation', () => {
  it('always returns a member of the legal set', () => {
    const board = emptyBoard();
    place(board, 7, 7, 1);
    place(board, 8, 8, 2);
    const legal: GomokuChoice[] = [
      { row: 0, col: 0 },
      { row: 7, col: 6 },
      { row: 14, col: 14 },
    ];
    expect(legal).toContainEqual(gomokuPositionalBot(4).decide('place', observation(board), legal));
  });

  it('plays near the center on an empty board rather than a corner', () => {
    const board = emptyBoard();
    const choice = gomokuPositionalBot(5).decide('place', observation(board), legalFrom(board));
    expect(Math.abs(choice.row - 7)).toBeLessThanOrEqual(1);
    expect(Math.abs(choice.col - 7)).toBeLessThanOrEqual(1);
  });
});
