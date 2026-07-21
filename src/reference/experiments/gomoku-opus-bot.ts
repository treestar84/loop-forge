/**
 * gomoku-opus-bot — a from-scratch heuristic Gomoku bot designed in ONE pass
 * ("what would a strong player do?"), WITHOUT going through Loop Forge's
 * scoring / wave / gate machinery. This is the "just ask the LLM to design a
 * bot" arm of the benchmark experiment (docs/BENCHMARK-EXPERIMENT.md, column
 * A) — it is a comparison subject, deliberately kept OUT of the game adapter's
 * strategySurface so it is never confused with a pipeline-validated strategy.
 *
 * Layer: this file lives in `reference/` and imports only from `contract`,
 * `kernel`, and its sibling `../gomoku` (types + BOARD_SIZE) — the reference
 * layer's allowed edges (src/__tests__/dependency-rules.test.ts). All
 * randomness flows through `createRng(seed)` (tie-breaking only); no
 * Date.now()/Math.random() (determinism rule).
 *
 * Design (single-shot heuristic, no lookahead search):
 *   Every decision scores each *relevant* empty cell (a cell adjacent — within
 *   Chebyshev radius 2 — to an existing stone) by two quantities:
 *     - offense: the threat value created if I place my stone there;
 *     - defense: the threat value the opponent would create if they took it.
 *   Threat value per direction is derived from the resulting consecutive run
 *   length and how many of its two ends stay open (a four with two open ends is
 *   unstoppable; an open three forces a response; etc.), summed across the four
 *   axes so a fork (two simultaneous open threes) scores higher than a single
 *   line — the classic winning motif. Immediate wins and immediate must-blocks
 *   are handled with strict priority above the scored comparison so a weighting
 *   quirk can never make the bot walk past a win or into a loss.
 */

import type { BotFactory, PlayerId } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import type { Cell, GomokuChoice, GomokuMove, GomokuObservation } from '../gomoku';
import { BOARD_SIZE } from '../gomoku';

const CENTER = (BOARD_SIZE - 1) / 2;
const WIN_LENGTH = 5;
const NEIGHBOR_RADIUS = 2;

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

/**
 * Threat value of placing `cell` at (row,col) along a single axis, from the
 * resulting run length and open-end count. Assumes (row,col) is empty on
 * `board` (the caller only scores empty cells). Returns a large sentinel for a
 * completed five so callers can detect an immediate win/loss cheaply.
 */
function directionThreat(
  board: readonly Cell[],
  row: number,
  col: number,
  cell: Cell,
  dr: number,
  dc: number,
): number {
  let forward = 0;
  let r = row + dr;
  let c = col + dc;
  while (inBounds(r, c) && board[indexOf(r, c)] === cell) {
    forward += 1;
    r += dr;
    c += dc;
  }
  const forwardOpen = inBounds(r, c) && board[indexOf(r, c)] === 0;

  let backward = 0;
  r = row - dr;
  c = col - dc;
  while (inBounds(r, c) && board[indexOf(r, c)] === cell) {
    backward += 1;
    r -= dr;
    c -= dc;
  }
  const backwardOpen = inBounds(r, c) && board[indexOf(r, c)] === 0;

  const total = forward + backward + 1;
  const openEnds = (forwardOpen ? 1 : 0) + (backwardOpen ? 1 : 0);

  if (total >= WIN_LENGTH) return 1_000_000;
  if (openEnds === 0) return 0; // a dead line extends nothing
  if (total === 4) return openEnds === 2 ? 50_000 : 2_000; // open four vs simple four
  if (total === 3) return openEnds === 2 ? 800 : 60; // open three vs blocked three
  if (total === 2) return openEnds === 2 ? 40 : 6;
  return openEnds === 2 ? 4 : 1; // lone stone
}

function placementScore(board: readonly Cell[], move: GomokuMove, cell: Cell): number {
  let score = 0;
  for (const [dr, dc] of DIRECTIONS) {
    score += directionThreat(board, move.row, move.col, cell, dr, dc);
  }
  return score;
}

function makesFive(board: readonly Cell[], move: GomokuMove, cell: Cell): boolean {
  for (const [dr, dc] of DIRECTIONS) {
    if (directionThreat(board, move.row, move.col, cell, dr, dc) >= 1_000_000) {
      return true;
    }
  }
  return false;
}

/** Cells within Chebyshev radius NEIGHBOR_RADIUS of at least one stone. */
function nearStone(board: readonly Cell[], row: number, col: number): boolean {
  for (let dr = -NEIGHBOR_RADIUS; dr <= NEIGHBOR_RADIUS; dr += 1) {
    for (let dc = -NEIGHBOR_RADIUS; dc <= NEIGHBOR_RADIUS; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const r = row + dr;
      const c = col + dc;
      if (inBounds(r, c) && board[indexOf(r, c)] !== 0) return true;
    }
  }
  return false;
}

function centerBonus(move: GomokuMove): number {
  const dist = Math.max(Math.abs(move.row - CENTER), Math.abs(move.col - CENTER));
  return (BOARD_SIZE - dist) * 0.5;
}

/** Defensive weight: taking away an opponent threat is worth almost as much as
 * building the same threat ourselves, but offense breaks true ties so we press
 * our own advantage rather than passively mirror. */
const DEFENSE_WEIGHT = 0.95;

export const gomokuOpusBot: BotFactory<GomokuObservation, GomokuChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'gomoku-opus',
    decide(_decisionPoint, observation, legal) {
      const board = observation.board;
      const myCell = playerToCell(observation.self);
      const oppCell: Cell = myCell === 1 ? 2 : 1;

      // Priority 1: take an immediate win.
      for (const move of legal) {
        if (makesFive(board, move, myCell)) return move;
      }
      // Priority 2: block an immediate opponent win.
      const blocks: GomokuMove[] = [];
      for (const move of legal) {
        if (makesFive(board, move, oppCell)) blocks.push(move);
      }
      if (blocks.length > 0) {
        // Multiple winning cells means an unstoppable fork already exists;
        // block the one that is also our strongest developing square.
        return pickBest(blocks, (move) => placementScore(board, move, myCell) + centerBonus(move), rng);
      }

      // Priority 3: scored offense+defense over cells adjacent to play.
      const candidates = legal.filter((move) => nearStone(board, move.row, move.col));
      const pool = candidates.length > 0 ? candidates : legal;
      return pickBest(
        pool,
        (move) =>
          placementScore(board, move, myCell) +
          DEFENSE_WEIGHT * placementScore(board, move, oppCell) +
          centerBonus(move),
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
