import { makeGomokuCloneTiebreakBot } from '../gomoku-clone-tiebreak-bot';
import { gomokuOpusCloneEvaluator } from '../gomoku-opus-clone-evaluator';
import { gomokuCombinedEvaluator } from '../gomoku-combined-evaluator';
import type { Cell, GomokuMove, GomokuObservation } from '../../gomoku';
import { BOARD_SIZE } from '../../gomoku';

function emptyBoard(): Cell[] {
  return new Array<Cell>(BOARD_SIZE * BOARD_SIZE).fill(0);
}

function observationFor(board: readonly Cell[]): GomokuObservation {
  return { self: 0, board, moveCount: board.filter((cell) => cell !== 0).length, toMove: 0 };
}

describe('gomokuCloneTiebreakBot (GAP-11 round4 B3-deep main candidate)', () => {
  it('returns the opusclone evaluator\'s unique argmax unchanged when no tie exists', () => {
    const board = emptyBoard();
    // A single dominant move: an immediate self-win sentinel, versus otherwise quiet legal moves.
    board[7 * BOARD_SIZE + 4] = 1;
    board[7 * BOARD_SIZE + 5] = 1;
    board[7 * BOARD_SIZE + 6] = 1;
    board[7 * BOARD_SIZE + 7] = 1;
    const observation = observationFor(board);
    const legal: GomokuMove[] = [
      { row: 7, col: 8 }, // completes 5 — dominant sentinel score.
      { row: 0, col: 0 },
      { row: 1, col: 1 },
    ];

    const cloneScores = gomokuOpusCloneEvaluator(
      { board, moveCount: observation.moveCount, winner: null, openingId: 'fixture' },
      0,
      legal,
    );
    const expectedIndex = cloneScores.indexOf(Math.max(...(cloneScores as number[])));

    const bot = makeGomokuCloneTiebreakBot(5)(1);
    const move = bot.decide('place', observation, legal);
    expect(move).toEqual(legal[expectedIndex]);
  });

  it('breaks an opusclone tie using the combined evaluator\'s own argmax', () => {
    const board = emptyBoard();
    board[7 * BOARD_SIZE + 7] = 1; // one self stone at center.
    const observation = observationFor(board);
    // (7,8) and (8,7) are both directly adjacent to the center stone along a
    // different axis each, but geometrically symmetric to one another (90°
    // rotation) — their opusclone scores tie exactly. (0,0) is far from the
    // stone (no adjacency, small centerBonus) and scores far lower, well
    // outside epsilon.
    const legal: GomokuMove[] = [
      { row: 7, col: 8 },
      { row: 8, col: 7 },
      { row: 0, col: 0 },
    ];

    const fixtureState = { board, moveCount: 1, winner: null, openingId: 'fixture' } as const;
    const cloneScores = gomokuOpusCloneEvaluator(fixtureState, 0, legal) as number[];
    expect(cloneScores[0]).toBe(cloneScores[1]);
    expect((cloneScores[0] as number) - (cloneScores[2] as number)).toBeGreaterThan(5); // far outside GOMOKU_CLONE_TIEBREAK_EPSILON_DEFAULT.

    const combinedScores = gomokuCombinedEvaluator(fixtureState, 0, [legal[0] as GomokuMove, legal[1] as GomokuMove]);
    // Both tied moves are symmetric, so the combined evaluator ties them too.
    expect(combinedScores[0]).toBe(combinedScores[1]);

    const bot = makeGomokuCloneTiebreakBot(5)(1);
    const move = bot.decide('place', observation, legal);
    // The far cell (outside epsilon of the clone argmax) must never be chosen.
    expect(move).not.toEqual(legal[2]);
  });

  it('is deterministic: the same seed and inputs always produce the same choice', () => {
    const board = emptyBoard();
    const observation = observationFor(board);
    const legal: GomokuMove[] = [
      { row: 6, col: 7 },
      { row: 8, col: 7 },
      { row: 7, col: 6 },
      { row: 7, col: 8 },
    ];

    const moveA = makeGomokuCloneTiebreakBot(5)(42).decide('place', observation, legal);
    const moveB = makeGomokuCloneTiebreakBot(5)(42).decide('place', observation, legal);
    expect(moveA).toEqual(moveB);
  });
});
