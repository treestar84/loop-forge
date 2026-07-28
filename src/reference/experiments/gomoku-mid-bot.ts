/**
 * gomoku-mid-bot — L1 anchor rung (docs/GAP-ANALYSIS-11.md D3/Phase 1-C): an
 * independent, one-shot mid-skill design meant to sit strictly between
 * `baselines.heuristic` and the L2 anchor (../experiments/gomoku-opus-bot.ts)
 * on the anchor ladder. Designed from scratch by reading this game's adapter
 * (../gomoku.ts) — NOT by copying gomoku-opus-bot.ts's threat-scoring logic,
 * per the task brief's "no logic copy" rule.
 *
 * L1 grade — "knows basic tactics, no deep reading":
 *   1. Take an immediate win if one exists (a legal move completing 5-in-a-row).
 *   2. Otherwise block the opponent's immediate win if they have one.
 *   3. Otherwise play the move that extends this player's own longest
 *      resulting same-colour line the most, ties broken by proximity to board
 *      center.
 * Deliberately does NOT do what gomoku-opus-bot.ts does: no open-three/open-
 * four threat weighting, no defensive (opponent-line) scoring beyond the
 * immediate-win block above, and no fork (multi-direction threat) awareness.
 * That gap is exactly what should keep this bot weaker than the L2 anchor
 * while still comfortably ahead of the density-only heuristic baseline
 * (../gomoku.ts's `heuristicBaseline`, which never checks for a win or a
 * block at all).
 *
 * Layer: reference/ — imports only contract/kernel types plus sibling
 * ../gomoku for its exported types/BOARD_SIZE (dependency-rules.test.ts's
 * reference-layer edges). Randomness flows through createRng(seed), used
 * only for deterministic tie-breaking (C1 determinism rule).
 */

import type { BotFactory, PlayerId } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import type { Cell, GomokuChoice, GomokuMove, GomokuObservation } from '../gomoku';
import { BOARD_SIZE } from '../gomoku';

const CENTER = (BOARD_SIZE - 1) / 2;
const WIN_LENGTH = 5;

const DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

function indexOf(row: number, col: number): number {
  return row * BOARD_SIZE + col;
}

function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function playerToCell(player: PlayerId): Cell {
  return player === 0 ? 1 : 2;
}

/** Length of the same-colour run through (row,col) if `cell` were placed there. */
function runLengthIfPlaced(board: readonly Cell[], row: number, col: number, cell: Cell, dr: number, dc: number): number {
  let count = 1;
  let r = row + dr;
  let c = col + dc;
  while (inBounds(r, c) && board[indexOf(r, c)] === cell) {
    count += 1;
    r += dr;
    c += dc;
  }
  r = row - dr;
  c = col - dc;
  while (inBounds(r, c) && board[indexOf(r, c)] === cell) {
    count += 1;
    r -= dr;
    c -= dc;
  }
  return count;
}

function longestRunIfPlaced(board: readonly Cell[], move: GomokuMove, cell: Cell): number {
  let best = 0;
  for (const [dr, dc] of DIRECTIONS) {
    best = Math.max(best, runLengthIfPlaced(board, move.row, move.col, cell, dr, dc));
  }
  return best;
}

function makesFive(board: readonly Cell[], move: GomokuMove, cell: Cell): boolean {
  return longestRunIfPlaced(board, move, cell) >= WIN_LENGTH;
}

function chebyshevToCenter(move: GomokuMove): number {
  return Math.max(Math.abs(move.row - CENTER), Math.abs(move.col - CENTER));
}

export const gomokuMidBot: BotFactory<GomokuObservation, GomokuChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'gomoku-mid-l1',
    decide(_decisionPoint, observation, legal) {
      const board = observation.board;
      const myCell = playerToCell(observation.self);
      const oppCell: Cell = myCell === 1 ? 2 : 1;

      // Priority 1: take an immediate win.
      for (const move of legal) {
        if (makesFive(board, move, myCell)) return move;
      }

      // Priority 2: block an immediate opponent win.
      const blocks = legal.filter((move) => makesFive(board, move, oppCell));
      if (blocks.length > 0) {
        return pickBest(blocks, (move) => -chebyshevToCenter(move), rng);
      }

      // Priority 3: extend my own longest line, ties toward the center. No
      // open-three/open-four weighting and no fork awareness — that is the
      // deliberate ceiling that keeps this bot below the L2 anchor.
      return pickBest(
        legal,
        (move) => longestRunIfPlaced(board, move, myCell) * 100 - chebyshevToCenter(move),
        rng,
      );
    },
  };
};

function pickBest(
  moves: readonly GomokuMove[],
  scoreFn: (move: GomokuMove) => number,
  rng: ReturnType<typeof createRng>,
): GomokuMove {
  let best: GomokuMove[] = [];
  let bestScore = -Infinity;
  for (const move of moves) {
    const score = scoreFn(move);
    if (score > bestScore) {
      bestScore = score;
      best = [move];
    } else if (score === bestScore) {
      best.push(move);
    }
  }
  if (best.length === 1) return best[0] as GomokuMove;
  return best[rng.nextInt(best.length)] as GomokuMove;
}
