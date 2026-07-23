/**
 * janggi — reference GameAdapter implementation (headless onboarding of an
 * open-source Janggi/한국 장기 (Korean chess) rules reference).
 *
 * Rules implemented (verified against https://github.com/davisethan/janggi,
 * a Python rules reference, and corrected against real Janggi rules where
 * that reference has a bug — see "Deliberate deviations" below):
 *   - 9 columns x 10 rows board (indices 0..89, row-major, row 0 = Han/Red's
 *     back rank, row 9 = Cho/Blue's back rank).
 *   - Player 0 = Cho (blue/green), palace rows 7-9 cols 3-5, moves first.
 *     Player 1 = Han (red), palace rows 0-2 cols 3-5.
 *   - Pieces: General(Gung), Guard(Sa) x2, Chariot(Cha) x2, Cannon(Po) x2,
 *     Horse(Ma) x2, Elephant(Sang) x2, Soldier(Byeong/Jol) x5.
 *   - General/Guard: one step orthogonally within their own palace, or one
 *     step along a palace diagonal line (the two X-shaped lines connecting
 *     each palace's 4 corners through its center) — or "pass" (move to own
 *     square), a real Janggi move used when no other move is wanted.
 *   - Chariot: unlimited orthogonal slide (like a chess rook), plus sliding
 *     along a palace diagonal line when it sits on one of that palace's
 *     diagonal points.
 *   - Cannon: same movement shape as the chariot, but every move (including
 *     diagonal ones) must jump exactly one non-cannon piece (the "screen")
 *     — cannons can neither jump nor capture another cannon.
 *   - Horse: (2,1) jump, blocked if the orthogonally-adjacent leg square is
 *     occupied.
 *   - Elephant: (3,2) jump, blocked if either of its two leg squares (one
 *     orthogonal, one diagonal) is occupied.
 *   - Soldier: one step forward or sideways (never backward); may also step
 *     diagonally forward, but only from the specific enemy-palace diagonal
 *     points on its forward path (corner -> center -> far corners).
 *   - Check: illegal to make a move that leaves your own general attacked,
 *     or that leaves the two generals "facing" each other (same column, no
 *     piece between them — the "flying general" rule).
 *   - Game over: whichever side's move it is with zero legal moves loses —
 *     this covers checkmate AND stalemate (Janggi has no stalemate draw,
 *     unlike chess). A ply cap (see MAX_PLIES) declares a draw for games
 *     that run long without a decisive result, standing in for Janggi's
 *     real no-progress/repetition draw rules (out of scope here) — without
 *     some such cap, random-vs-random playouts would not reliably terminate
 *     (docs/ONBOARDING-GUIDE.md §5, "종국 규칙 구현 필수").
 *
 * Deliberate deviations from the davisethan/janggi Python reference:
 *   - That reference's General/Guard diagonal-move filter only checks that
 *     the *destination* stays inside the palace, not that source+destination
 *     are actually connected by a palace diagonal line. That lets a General
 *     sitting on a palace edge-midpoint (e.g. row 0 col 4, not a corner or
 *     center) make an illegal diagonal step. This adapter restricts General
 *     /Guard diagonal moves to the real diagonal-line edges only, the same
 *     way this codebase's gomoku adapter fixed its reference's win-checker
 *     bug rather than copying it (see src/reference/gomoku.ts module doc).
 *   - The Python reference has no stalemate/no-legal-move handling outside
 *     of check (`is_in_checkmate` is only ever consulted after a check), and
 *     no move-count cap, so a stalemated (but not checked) side would let
 *     the game hang forever, and it has no way to end a long undecided game.
 *     Real Janggi treats "no legal moves" as a loss unconditionally, and
 *     real play terminates long games by no-progress/repetition draw rules;
 *     this adapter implements the loss rule exactly and a ply-cap draw as a
 *     minimal stand-in for the (materially more complex) real draw rules.
 *
 * Determinism / opening diversity (docs/ONBOARDING-GUIDE.md §5.5, "장기의
 * 함정"): real Janggi lets each side choose, before the game starts, whether
 * its Elephant/Horse pair on each flank is Elephant-then-Horse or
 * Horse-then-Elephant (4 combinations per side, chosen independently per
 * side — 16 total starting layouts). That choice must NOT be modeled as an
 * in-game bot decision: a deterministic bot always picks the same layout,
 * which collapses seed diversity in exactly the way the C1 seed-diversity
 * check is meant to catch, except C1 uses a random bot and would not notice.
 * `createInitialState(seed)` therefore forces the layout choice itself, the
 * same way gomoku forces its opening line — see `pickArrangement` below.
 *
 * All randomness flows through `createRng`/`Rng.nextInt`/`shuffled` from
 * ../kernel/rng — no Date.now()/Math.random() anywhere in this file (C1).
 */

import type {
  BotFactory,
  GameAdapter,
  Outcome,
  PendingDecision,
  PlayerId,
  ReplayFixture,
  StrategyFlagSpec,
} from '../contract/types';
import { createRng, shuffled } from '../kernel/rng';

// -----------------------------------------------------------------------
// Board geometry
// -----------------------------------------------------------------------

export const ROWS = 10;
export const COLS = 9;
const BOARD_SIZE = ROWS * COLS; // 90
const MAX_PLIES = 220;

export const GENERAL = 1;
export const GUARD = 2;
export const CHARIOT = 3;
export const CANNON = 4;
export const HORSE = 5;
export const ELEPHANT = 6;
export const SOLDIER = 7;

/** Cell value: 0 empty; positive = player 0 (Cho) piece type; negative = player 1 (Han). */
export type Cell = number;

export interface JanggiState {
  readonly board: readonly Cell[];
  readonly toMove: PlayerId;
  readonly ply: number;
  readonly redArrangement: number;
  readonly blueArrangement: number;
}

export interface JanggiObservation {
  readonly self: PlayerId;
  readonly board: readonly Cell[];
  readonly toMove: PlayerId;
  readonly ply: number;
}

export interface JanggiMove {
  readonly from: number;
  readonly to: number;
}

export type JanggiChoice = JanggiMove;

function idx(row: number, col: number): number {
  return row * COLS + col;
}

function rowOf(i: number): number {
  return Math.floor(i / COLS);
}

function colOf(i: number): number {
  return i % COLS;
}

function inBoard(row: number, col: number): boolean {
  return row >= 0 && row < ROWS && col >= 0 && col < COLS;
}

function otherPlayer(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

function pieceOwner(cell: Cell): PlayerId | null {
  if (cell === 0) return null;
  return cell > 0 ? 0 : 1;
}

function pieceType(cell: Cell): number {
  return Math.abs(cell);
}

function encodePiece(player: PlayerId, type: number): Cell {
  return player === 0 ? type : -type;
}

// -----------------------------------------------------------------------
// Palaces and diagonal lines
// -----------------------------------------------------------------------

interface Palace {
  readonly rowMin: number;
  readonly rowMax: number;
  readonly colMin: number;
  readonly colMax: number;
}

/** palaceOf(player) — the palace that player's General/Guard live in. */
function palaceOf(player: PlayerId): Palace {
  return player === 0
    ? { rowMin: 7, rowMax: 9, colMin: 3, colMax: 5 }
    : { rowMin: 0, rowMax: 2, colMin: 3, colMax: 5 };
}

function inPalace(palace: Palace, row: number, col: number): boolean {
  return row >= palace.rowMin && row <= palace.rowMax && col >= palace.colMin && col <= palace.colMax;
}

/** The two X-diagonal lines (corner-center-corner) for both palaces, as ordered index triples. */
const DIAGONAL_LINES: readonly (readonly [number, number, number])[] = [
  [idx(0, 3), idx(1, 4), idx(2, 5)],
  [idx(0, 5), idx(1, 4), idx(2, 3)],
  [idx(7, 3), idx(8, 4), idx(9, 5)],
  [idx(7, 5), idx(8, 4), idx(9, 3)],
];

/** index -> list of rays (each ray = ordered indices, nearest first) along palace diagonals. */
const DIAGONAL_RAYS: ReadonlyMap<number, readonly (readonly number[])[]> = (() => {
  const raysByIndex = new Map<number, (readonly number[])[]>();
  const push = (from: number, ray: readonly number[]): void => {
    const existing = raysByIndex.get(from) ?? [];
    existing.push(ray);
    raysByIndex.set(from, existing);
  };
  for (const line of DIAGONAL_LINES) {
    const [a, b, c] = line;
    push(a, [b, c]);
    push(c, [b, a]);
    push(b, [a]);
    push(b, [c]);
  }
  return raysByIndex;
})();

/** Explicit forward-diagonal soldier steps: (player, fromIndex) -> extra diagonal target. */
const SOLDIER_DIAGONALS: ReadonlyMap<string, number> = new Map([
  // Player 0 (Cho) advances up into the Han palace (rows 0-2).
  [`0:${idx(2, 3)}`, idx(1, 4)],
  [`0:${idx(2, 5)}`, idx(1, 4)],
  [`0:${idx(1, 4)}`, idx(0, 3)],
  // second diagonal from (1,4) handled separately below (Map key collision) —
  // see soldierDiagonalTargets().
  // Player 1 (Han) advances down into the Cho palace (rows 7-9).
  [`1:${idx(7, 3)}`, idx(8, 4)],
  [`1:${idx(7, 5)}`, idx(8, 4)],
  [`1:${idx(8, 4)}`, idx(9, 3)],
]);

function soldierDiagonalTargets(player: PlayerId, from: number): readonly number[] {
  if (player === 0 && from === idx(1, 4)) return [idx(0, 3), idx(0, 5)];
  if (player === 1 && from === idx(8, 4)) return [idx(9, 3), idx(9, 5)];
  const key = `${player}:${from}`;
  const target = SOLDIER_DIAGONALS.get(key);
  return target === undefined ? [] : [target];
}

// -----------------------------------------------------------------------
// Starting arrangement (seed-forced Elephant/Horse layout diversity)
// -----------------------------------------------------------------------

/** Left flank = cols 1-2, right flank = cols 6-7. Each side independently picks
 * one of the 4 combinations below — this is the seed-forced diversity the
 * "장기의 함정" note requires (see module doc). */
const ARRANGEMENTS: readonly { readonly left: readonly [number, number]; readonly right: readonly [number, number] }[] = [
  { left: [ELEPHANT, HORSE], right: [ELEPHANT, HORSE] },
  { left: [HORSE, ELEPHANT], right: [ELEPHANT, HORSE] },
  { left: [ELEPHANT, HORSE], right: [HORSE, ELEPHANT] },
  { left: [HORSE, ELEPHANT], right: [HORSE, ELEPHANT] },
];

function buildBackRank(player: PlayerId, arrangement: number, rank: number, board: Cell[]): void {
  const spec = ARRANGEMENTS[arrangement] as (typeof ARRANGEMENTS)[number];
  board[idx(rank, 0)] = encodePiece(player, CHARIOT);
  board[idx(rank, 1)] = encodePiece(player, spec.left[0]);
  board[idx(rank, 2)] = encodePiece(player, spec.left[1]);
  board[idx(rank, 3)] = encodePiece(player, GUARD);
  board[idx(rank, 4)] = 0;
  board[idx(rank, 5)] = encodePiece(player, GUARD);
  board[idx(rank, 6)] = encodePiece(player, spec.right[0]);
  board[idx(rank, 7)] = encodePiece(player, spec.right[1]);
  board[idx(rank, 8)] = encodePiece(player, CHARIOT);
}

function buildInitialBoard(redArrangement: number, blueArrangement: number): Cell[] {
  const board: Cell[] = new Array<Cell>(BOARD_SIZE).fill(0);
  // Han (player 1) back rank: row 0. General: row 1 col 4. Cannons: row 2 cols 1,7.
  buildBackRank(1, redArrangement, 0, board);
  board[idx(1, 4)] = encodePiece(1, GENERAL);
  board[idx(2, 1)] = encodePiece(1, CANNON);
  board[idx(2, 7)] = encodePiece(1, CANNON);
  for (const col of [0, 2, 4, 6, 8]) {
    board[idx(3, col)] = encodePiece(1, SOLDIER);
  }
  // Cho (player 0) back rank: row 9. General: row 8 col 4. Cannons: row 7 cols 1,7.
  buildBackRank(0, blueArrangement, 9, board);
  board[idx(8, 4)] = encodePiece(0, GENERAL);
  board[idx(7, 1)] = encodePiece(0, CANNON);
  board[idx(7, 7)] = encodePiece(0, CANNON);
  for (const col of [0, 2, 4, 6, 8]) {
    board[idx(6, col)] = encodePiece(0, SOLDIER);
  }
  return board;
}

function createInitialState(seed: number): JanggiState {
  const rng = createRng(seed);
  const redArrangement = rng.nextInt(ARRANGEMENTS.length);
  const blueArrangement = rng.nextInt(ARRANGEMENTS.length);
  const board = buildInitialBoard(redArrangement, blueArrangement);
  return { board, toMove: 0, ply: 0, redArrangement, blueArrangement };
}

// -----------------------------------------------------------------------
// Move generation (raw / shape-and-blocking only, no self-check filtering)
// -----------------------------------------------------------------------

const ORTHOGONAL_DIRS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

function orthogonalRay(from: number, dr: number, dc: number): number[] {
  const ray: number[] = [];
  let row = rowOf(from) + dr;
  let col = colOf(from) + dc;
  while (inBoard(row, col)) {
    ray.push(idx(row, col));
    row += dr;
    col += dc;
  }
  return ray;
}

function slideRay(board: readonly Cell[], player: PlayerId, ray: readonly number[], out: number[]): void {
  for (const square of ray) {
    const occupant = board[square] as Cell;
    if (occupant === 0) {
      out.push(square);
      continue;
    }
    if (pieceOwner(occupant) !== player) {
      out.push(square);
    }
    break;
  }
}

function cannonJumpRay(
  board: readonly Cell[],
  player: PlayerId,
  ray: readonly number[],
  out: number[],
): void {
  let i = 0;
  while (i < ray.length && board[ray[i] as number] === 0) {
    i += 1;
  }
  if (i >= ray.length) return; // no screen piece anywhere along the ray
  const screen = board[ray[i] as number] as Cell;
  if (pieceType(screen) === CANNON) return; // cannons cannot jump another cannon
  i += 1;
  for (; i < ray.length; i += 1) {
    const square = ray[i] as number;
    const occupant = board[square] as Cell;
    if (occupant === 0) {
      out.push(square);
      continue;
    }
    if (pieceOwner(occupant) !== player && pieceType(occupant) !== CANNON) {
      out.push(square);
    }
    break;
  }
}

function chariotMoves(board: readonly Cell[], player: PlayerId, from: number): number[] {
  const out: number[] = [];
  for (const [dr, dc] of ORTHOGONAL_DIRS) {
    slideRay(board, player, orthogonalRay(from, dr, dc), out);
  }
  for (const ray of DIAGONAL_RAYS.get(from) ?? []) {
    slideRay(board, player, ray, out);
  }
  return out;
}

function cannonMoves(board: readonly Cell[], player: PlayerId, from: number): number[] {
  const out: number[] = [];
  for (const [dr, dc] of ORTHOGONAL_DIRS) {
    cannonJumpRay(board, player, orthogonalRay(from, dr, dc), out);
  }
  for (const ray of DIAGONAL_RAYS.get(from) ?? []) {
    cannonJumpRay(board, player, ray, out);
  }
  return out;
}

function stepMoves(board: readonly Cell[], player: PlayerId, _from: number, targets: readonly number[]): number[] {
  const out: number[] = [];
  for (const target of targets) {
    const occupant = board[target] as Cell;
    if (occupant === 0 || pieceOwner(occupant) !== player) {
      out.push(target);
    }
  }
  return out;
}

function generalGuardMoves(board: readonly Cell[], player: PlayerId, from: number): number[] {
  const palace = palaceOf(player);
  const targets: number[] = [];
  const row = rowOf(from);
  const col = colOf(from);
  for (const [dr, dc] of ORTHOGONAL_DIRS) {
    const r = row + dr;
    const c = col + dc;
    if (inPalace(palace, r, c)) targets.push(idx(r, c));
  }
  for (const ray of DIAGONAL_RAYS.get(from) ?? []) {
    const first = ray[0] as number;
    if (inPalace(palace, rowOf(first), colOf(first))) targets.push(first);
  }
  // Passing (moving to one's own square) is always a shape-legal option —
  // a real Janggi move, not a capture, so it must not go through the
  // own-piece-occupancy filter in stepMoves below.
  return [from, ...stepMoves(board, player, from, targets)];
}

function horseMoves(board: readonly Cell[], player: PlayerId, from: number): number[] {
  const row = rowOf(from);
  const col = colOf(from);
  const specs: readonly [readonly [number, number], readonly [number, number]][] = [
    [[-1, 0], [-2, -1]],
    [[-1, 0], [-2, 1]],
    [[0, 1], [-1, 2]],
    [[0, 1], [1, 2]],
    [[1, 0], [2, 1]],
    [[1, 0], [2, -1]],
    [[0, -1], [1, -2]],
    [[0, -1], [-1, -2]],
  ];
  const targets: number[] = [];
  for (const [[legDr, legDc], [destDr, destDc]] of specs) {
    const legRow = row + legDr;
    const legCol = col + legDc;
    if (!inBoard(legRow, legCol) || board[idx(legRow, legCol)] !== 0) continue;
    const destRow = row + destDr;
    const destCol = col + destDc;
    if (!inBoard(destRow, destCol)) continue;
    targets.push(idx(destRow, destCol));
  }
  return stepMoves(board, player, from, targets);
}

function elephantMoves(board: readonly Cell[], player: PlayerId, from: number): number[] {
  const row = rowOf(from);
  const col = colOf(from);
  const specs: readonly [readonly [number, number], readonly [number, number], readonly [number, number]][] = [
    [[-1, 0], [-2, -1], [-3, -2]],
    [[-1, 0], [-2, 1], [-3, 2]],
    [[0, 1], [-1, 2], [-2, 3]],
    [[0, 1], [1, 2], [2, 3]],
    [[1, 0], [2, 1], [3, 2]],
    [[1, 0], [2, -1], [3, -2]],
    [[0, -1], [1, -2], [2, -3]],
    [[0, -1], [-1, -2], [-2, -3]],
  ];
  const targets: number[] = [];
  for (const [[leg1Dr, leg1Dc], [leg2Dr, leg2Dc], [destDr, destDc]] of specs) {
    const leg1Row = row + leg1Dr;
    const leg1Col = col + leg1Dc;
    if (!inBoard(leg1Row, leg1Col) || board[idx(leg1Row, leg1Col)] !== 0) continue;
    const leg2Row = row + leg2Dr;
    const leg2Col = col + leg2Dc;
    if (!inBoard(leg2Row, leg2Col) || board[idx(leg2Row, leg2Col)] !== 0) continue;
    const destRow = row + destDr;
    const destCol = col + destDc;
    if (!inBoard(destRow, destCol)) continue;
    targets.push(idx(destRow, destCol));
  }
  return stepMoves(board, player, from, targets);
}

function soldierMoves(board: readonly Cell[], player: PlayerId, from: number): number[] {
  const row = rowOf(from);
  const col = colOf(from);
  const forwardDr = player === 0 ? -1 : 1;
  const targets: number[] = [];
  if (inBoard(row + forwardDr, col)) targets.push(idx(row + forwardDr, col));
  if (inBoard(row, col - 1)) targets.push(idx(row, col - 1));
  if (inBoard(row, col + 1)) targets.push(idx(row, col + 1));
  targets.push(...soldierDiagonalTargets(player, from));
  return stepMoves(board, player, from, targets);
}

/** Raw destinations for the piece at `from` — shape and blocking rules only. */
function rawMoves(board: readonly Cell[], from: number): number[] {
  const cell = board[from] as Cell;
  const owner = pieceOwner(cell);
  if (owner === null) return [];
  const type = pieceType(cell);
  switch (type) {
    case GENERAL:
    case GUARD:
      return generalGuardMoves(board, owner, from);
    case CHARIOT:
      return chariotMoves(board, owner, from);
    case CANNON:
      return cannonMoves(board, owner, from);
    case HORSE:
      return horseMoves(board, owner, from);
    case ELEPHANT:
      return elephantMoves(board, owner, from);
    case SOLDIER:
      return soldierMoves(board, owner, from);
    default:
      return [];
  }
}

function findGeneral(board: readonly Cell[], player: PlayerId): number {
  const target = encodePiece(player, GENERAL);
  for (let i = 0; i < board.length; i += 1) {
    if (board[i] === target) return i;
  }
  throw new Error(`findGeneral: player ${player} has no general on the board`);
}

/**
 * Cheap geometric pre-filter, used only to skip the (comparatively
 * expensive) full move generation in `isSquareAttacked` for pieces that
 * obviously cannot reach `target` at all — a real hot path (C4 throughput),
 * since it runs once per opponent piece for every self-check test of every
 * candidate move.
 */
function couldReach(type: number, from: number, target: number): boolean {
  const dr = Math.abs(rowOf(from) - rowOf(target));
  const dc = Math.abs(colOf(from) - colOf(target));
  switch (type) {
    case HORSE:
      return (dr === 2 && dc === 1) || (dr === 1 && dc === 2);
    case ELEPHANT:
      return (dr === 3 && dc === 2) || (dr === 2 && dc === 3);
    case GENERAL:
    case GUARD:
    case SOLDIER:
      return dr <= 1 && dc <= 1;
    case CHARIOT:
    case CANNON: {
      if (dr === 0 || dc === 0) return true;
      const rays = DIAGONAL_RAYS.get(from);
      if (!rays) return false;
      return rays.some((ray) => ray.includes(target));
    }
    default:
      return true;
  }
}

function isSquareAttacked(board: readonly Cell[], target: number, byPlayer: PlayerId): boolean {
  for (let i = 0; i < board.length; i += 1) {
    const cell = board[i] as Cell;
    if (pieceOwner(cell) !== byPlayer) continue;
    if (!couldReach(pieceType(cell), i, target)) continue;
    if (rawMoves(board, i).includes(target)) return true;
  }
  return false;
}

function generalsFacingAt(board: readonly Cell[], gA: number, gB: number): boolean {
  if (colOf(gA) !== colOf(gB)) return false;
  const col = colOf(gA);
  const rowLo = Math.min(rowOf(gA), rowOf(gB));
  const rowHi = Math.max(rowOf(gA), rowOf(gB));
  for (let row = rowLo + 1; row < rowHi; row += 1) {
    if (board[idx(row, col)] !== 0) return false;
  }
  return true;
}

function applyMove(board: readonly Cell[], move: JanggiMove): Cell[] {
  const next = board.slice();
  next[move.to] = board[move.from] as Cell;
  if (move.from !== move.to) next[move.from] = 0;
  return next;
}

/**
 * Fully-legal moves for `player`: raw shape/blocking, minus self-check, minus
 * facing. Performance-sensitive (C4 throughput): mutates one scratch board
 * in place and undoes each candidate rather than allocating a fresh board
 * per candidate, and reuses cached general positions instead of re-scanning
 * the whole board for them on every candidate.
 */
function legalMovesFor(board: readonly Cell[], player: PlayerId): JanggiMove[] {
  const moves: JanggiMove[] = [];
  const opponent = otherPlayer(player);
  const scratch = board.slice();
  const ownGeneralStart = findGeneral(board, player);
  const oppGeneralStart = findGeneral(board, opponent);
  for (let from = 0; from < board.length; from += 1) {
    const cell = board[from] as Cell;
    if (pieceOwner(cell) !== player) continue;
    for (const to of rawMoves(board, from)) {
      const captured = scratch[to] as Cell;
      scratch[to] = cell;
      if (from !== to) scratch[from] = 0;

      const ownGeneralIndex = from === ownGeneralStart ? to : ownGeneralStart;
      const oppGeneralIndex = oppGeneralStart === to ? -1 : oppGeneralStart;
      const safe =
        oppGeneralIndex !== -1 &&
        !isSquareAttacked(scratch, ownGeneralIndex, opponent) &&
        !generalsFacingAt(scratch, ownGeneralIndex, oppGeneralIndex);
      if (safe) {
        moves.push({ from, to });
      }

      scratch[from] = cell;
      scratch[to] = captured;
    }
  }
  return moves;
}

function isPlayerInCheck(board: readonly Cell[], player: PlayerId): boolean {
  return isSquareAttacked(board, findGeneral(board, player), otherPlayer(player));
}

// -----------------------------------------------------------------------
// Adapter surface
// -----------------------------------------------------------------------

function currentDecision(state: JanggiState): PendingDecision | null {
  if (state.ply >= MAX_PLIES) return null;
  if (legalMovesFor(state.board, state.toMove).length === 0) return null;
  return { player: state.toMove, decisionPoint: 'move' };
}

function getObservation(state: JanggiState, player: PlayerId): JanggiObservation {
  return { self: player, board: state.board, toMove: state.toMove, ply: state.ply };
}

function hashBoardState(state: JanggiState): number {
  let hash = 0x811c9dc5 ^ state.toMove ^ (state.ply << 1);
  for (let i = 0; i < state.board.length; i += 1) {
    hash ^= (state.board[i] as number) + 8;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function getLegalChoices(state: JanggiState): readonly JanggiMove[] {
  if (currentDecision(state) === null) {
    throw new Error('getLegalChoices: game is already over');
  }
  const moves = legalMovesFor(state.board, state.toMove);
  return shuffled(moves, createRng(hashBoardState(state)));
}

function applyChoice(state: JanggiState, choice: JanggiMove): JanggiState {
  const decision = currentDecision(state);
  if (!decision) {
    throw new Error('applyChoice: game is already over');
  }
  const legal = legalMovesFor(state.board, state.toMove);
  const isLegal = legal.some((move) => move.from === choice.from && move.to === choice.to);
  if (!isLegal) {
    throw new Error(`applyChoice: illegal move ${choice.from}->${choice.to}`);
  }
  const board = applyMove(state.board, choice);
  return {
    board,
    toMove: otherPlayer(state.toMove),
    ply: state.ply + 1,
    redArrangement: state.redArrangement,
    blueArrangement: state.blueArrangement,
  };
}

/** Sum of PIECE_VALUE (excluding the General, which is never captured) for `player`. */
function materialScore(board: readonly Cell[], player: PlayerId): number {
  let total = 0;
  for (const cell of board) {
    if (pieceOwner(cell) !== player) continue;
    const type = pieceType(cell);
    if (type === GENERAL) continue;
    total += PIECE_VALUE[type] as number;
  }
  return total;
}

function getOutcome(state: JanggiState): Outcome | null {
  if (currentDecision(state) !== null) return null;
  if (state.ply >= MAX_PLIES) {
    // No checkmate/stalemate within the ply cap: fall back to a material-count
    // decision, the same way many digital Janggi implementations score a
    // move-limited game (see module doc's "Deliberate deviations" section for
    // why an unconditional draw here would collapse strategy signal — bots
    // without real search essentially never force checkmate, so an
    // unconditional cap-draw makes every paired comparison land on 0.5).
    const material0 = materialScore(state.board, 0);
    const material1 = materialScore(state.board, 1);
    if (material0 === material1) {
      return { scores: [0, 0], winners: [0, 1] };
    }
    const winner = material0 > material1 ? 0 : 1;
    const scores = [0, 0];
    scores[winner] = 1;
    return { scores, winners: [winner] };
  }
  const loser = state.toMove;
  const winner = otherPlayer(loser);
  const scores = [0, 0];
  scores[winner] = 1;
  return { scores, winners: [winner] };
}

function encodeChoice(choice: JanggiMove): string {
  return `${choice.from}-${choice.to}`;
}

/**
 * MCTS simulation root (docs/GAP-ANALYSIS-7.md O6): the observation carries
 * the full board, toMove, and ply, so state is losslessly reconstructable
 * except for `redArrangement`/`blueArrangement`, which are diagnostic-only —
 * the Elephant/Horse layout they record is already baked into `board` at
 * createInitialState time and no move-generation logic ever re-reads these
 * two fields afterward, so a placeholder value here changes no gameplay.
 */
function reconstructState(observation: JanggiObservation): JanggiState {
  return {
    board: observation.board,
    toMove: observation.toMove,
    ply: observation.ply,
    redArrangement: 0,
    blueArrangement: 0,
  };
}

// -----------------------------------------------------------------------
// Invariants
// -----------------------------------------------------------------------

function singleGeneralInvariant(state: JanggiState): string | null {
  for (const player of [0, 1] as const) {
    const target = encodePiece(player, GENERAL);
    const count = state.board.filter((cell) => cell === target).length;
    if (count !== 1) {
      return `player ${player} has ${count} generals on the board (expected exactly 1)`;
    }
  }
  return null;
}

function pieceCountInvariant(state: JanggiState): string | null {
  const total = state.board.filter((cell) => cell !== 0).length;
  if (total > 32) {
    return `board has ${total} pieces, more than the 32 pieces the game starts with`;
  }
  return null;
}

function previousMoverNotInCheckInvariant(state: JanggiState): string | null {
  const previousMover = otherPlayer(state.toMove);
  if (isPlayerInCheck(state.board, previousMover)) {
    return `player ${previousMover} just moved but is left in check — illegal position`;
  }
  return null;
}

// -----------------------------------------------------------------------
// Baselines
// -----------------------------------------------------------------------

const PIECE_VALUE: Readonly<Record<number, number>> = {
  [GENERAL]: 1000,
  [GUARD]: 3,
  [CHARIOT]: 13,
  [CANNON]: 7,
  [HORSE]: 5,
  [ELEPHANT]: 3,
  [SOLDIER]: 2,
};

const randomBaseline: BotFactory<JanggiObservation, JanggiChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'janggi-random',
    decide(_decisionPoint, _observation, legal) {
      return legal[rng.nextInt(legal.length)] as JanggiChoice;
    },
  };
};

/**
 * Heuristic baseline: weighs a capture's value against the risk of immediate
 * recapture (so it will decline an unsafe big capture, unlike the
 * `captureHighestValue` strategy flag below, which is deliberately
 * unconditional — that contrast is what keeps the flag behaviorally distinct
 * rather than a redundant restatement of what this baseline already does),
 * plus a small positional term that rewards advancing toward the enemy back
 * rank so games make real progress instead of both sides shuffling forever;
 * ties broken by the lowest encoded key (deterministic, no RNG).
 */
function moveScore(observation: JanggiObservation, move: JanggiMove): number {
  const board = observation.board;
  // A pass (General/Guard moving to its own square) has a non-empty
  // destination — its own piece — which must never read as a "capture".
  const captured = move.to === move.from ? 0 : (board[move.to] as Cell);
  const captureValue = captured === 0 ? 0 : (PIECE_VALUE[pieceType(captured)] as number);
  const next = applyMove(board, move);
  const opponent = otherPlayer(observation.self);
  const exposed = isSquareAttacked(next, move.to, opponent) ? 1 : 0;
  const movingType = pieceType(board[move.from] as Cell);
  const exposureCost = exposed * (PIECE_VALUE[movingType] as number);
  const advance = observation.self === 0 ? ROWS - 1 - rowOf(move.to) : rowOf(move.to);
  return captureValue * 3 - exposureCost + advance;
}

const heuristicBaseline: BotFactory<JanggiObservation, JanggiChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'janggi-heuristic',
    decide(_decisionPoint, observation, legal) {
      let bestScore = -Infinity;
      let candidates: JanggiMove[] = [];
      for (const move of legal) {
        const score = moveScore(observation, move);
        if (score > bestScore) {
          bestScore = score;
          candidates = [move];
        } else if (score === bestScore) {
          candidates.push(move);
        }
      }
      // A fixed tie-break (e.g. lowest encoded key) makes two heuristic bots
      // settle into an infinite back-and-forth once no capture/advance is
      // available (every zero-sum tie resolves the same way every time) —
      // seeded random tie-breaking avoids that degenerate repetition while
      // staying fully deterministic given the bot's seed (C1).
      return candidates[rng.nextInt(candidates.length)] as JanggiMove;
    },
  };
};

// -----------------------------------------------------------------------
// Strategy surface
// -----------------------------------------------------------------------

function wrapBotId(id: string, suffix: string): string {
  return `${id}+${suffix}`;
}

/** Strategy flag: effective. Always takes the highest-value capture on offer
 * (ties broken by the base bot's own choice among the tied captures);
 * otherwise delegates to the base bot entirely. */
const captureHighestValue: StrategyFlagSpec<JanggiObservation, JanggiChoice> = {
  flag: 'captureHighestValue',
  description: 'Plays the highest-value available capture; otherwise delegates to base.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot.id, 'captureHighestValue'),
        decide(decisionPoint, observation, legal) {
          let bestValue = 0;
          let candidates: JanggiChoice[] = [];
          for (const move of legal) {
            // A pass (General/Guard moving to its own square) has a non-empty
            // destination — its own piece — which must never read as a "capture".
            if (move.to === move.from) continue;
            const target = observation.board[move.to] as Cell;
            if (target === 0) continue;
            const value = PIECE_VALUE[pieceType(target)] as number;
            if (value > bestValue) {
              bestValue = value;
              candidates = [move];
            } else if (value === bestValue) {
              candidates.push(move);
            }
          }
          if (candidates.length === 0) {
            return bot.decide(decisionPoint, observation, legal);
          }
          if (candidates.length === 1) {
            return candidates[0] as JanggiChoice;
          }
          const baseChoice = bot.decide(decisionPoint, observation, legal);
          const baseKey = encodeChoice(baseChoice);
          const tieMatch = candidates.find((move) => encodeChoice(move) === baseKey);
          return tieMatch ?? (candidates[0] as JanggiChoice);
        },
      };
    };
  },
};

/** Strategy flag: effective. Plays a move that gives check to the opponent
 * general if one exists; otherwise delegates to the base bot. */
const preferCheck: StrategyFlagSpec<JanggiObservation, JanggiChoice> = {
  flag: 'preferCheck',
  description: 'Plays a move that checks the opponent general if one is available; otherwise delegates to base.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot.id, 'preferCheck'),
        decide(decisionPoint, observation, legal) {
          const opponent = otherPlayer(observation.self);
          for (const move of legal) {
            const next = applyMove(observation.board, move);
            if (isPlayerInCheck(next, opponent)) {
              return move;
            }
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/** Strategy flag: marginal. Always advances a Soldier if any Soldier move is
 * legal (ties broken by lowest encoded key), ignoring captures/safety;
 * otherwise delegates to the base bot. */
const advanceSoldier: StrategyFlagSpec<JanggiObservation, JanggiChoice> = {
  flag: 'advanceSoldier',
  description: 'Always moves a Soldier when one has a legal move, ties broken deterministically; otherwise delegates to base.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot.id, 'advanceSoldier'),
        decide(decisionPoint, observation, legal) {
          let best: JanggiChoice | null = null;
          let bestKey = '';
          for (const move of legal) {
            if (pieceType(observation.board[move.from] as Cell) !== SOLDIER) continue;
            const key = encodeChoice(move);
            if (best === null || key < bestKey) {
              best = move;
              bestKey = key;
            }
          }
          return best ?? bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

// -----------------------------------------------------------------------
// Replay fixtures — generated by actually running this adapter's own
// random-vs-random self-play (see src/reference/__tests__/janggi.test.ts for
// the generation note), then hardcoded here.
// -----------------------------------------------------------------------

const replayFixtures: readonly ReplayFixture[] = [
  {
    id: "janggi-seed-11",
    seed: 11,
    choiceKeys: [
      "86-77", "2-21", "84-84", "0-18", "76-68", "8-17", "68-67", "21-4", "56-55", "17-16",
      "60-59", "31-30", "64-28", "5-5", "87-76", "35-44", "55-56", "13-12", "84-75", "27-28",
      "67-68", "19-73", "70-64", "18-36", "68-68", "44-53", "56-55", "73-76", "64-69", "36-41",
      "68-67", "41-37", "82-57", "28-27", "69-63", "29-28", "63-69", "4-23", "81-72", "33-34",
      "58-49", "27-36", "69-65", "3-13", "89-71", "37-41", "57-42", "5-14", "72-63", "13-21",
      "65-68", "25-52", "83-66", "34-33", "59-58", "23-34", "54-45", "12-13", "58-59", "41-23",
      "71-69", "36-37", "63-81", "21-12", "81-84", "52-48", "59-60", "76-73", "60-51", "16-17",
      "55-56", "48-21", "56-57", "23-24", "51-50", "28-27", "84-81", "53-52", "49-40", "52-61",
      "81-86", "37-46", "68-71", "30-29", "69-87", "17-8", "71-44", "13-13", "86-81", "13-4",
      "66-55", "8-17", "44-80", "73-76", "45-46", "17-35", "81-82", "76-78", "80-35", "34-17",
      "77-76", "33-34", "57-58", "78-33", "46-47", "12-3", "87-60", "34-35", "62-53", "4-5",
      "76-85", "24-15", "55-38", "33-28", "60-78", "15-42", "67-67", "42-41", "40-31", "1-30",
      "82-81", "27-36", "78-77", "14-13", "81-45", "13-12", "58-57", "21-48", "85-86", "61-70",
      "77-68", "48-75", "50-49", "35-44", "67-67", "5-13", "49-50", "44-53", "57-48", "13-5",
      "45-81", "3-4", "86-86", "36-45", "86-77", "41-32", "81-84", "6-23", "31-32", "75-39",
      "84-82", "45-46", "77-86", "46-45", "67-76", "30-51", "50-51", "39-57", "82-84", "17-24",
      "48-39", "12-13", "76-77", "57-21", "51-50", "5-5", "68-76", "23-12", "50-51", "24-31",
      "88-59", "29-30", "39-30", "21-3", "84-57", "31-14", "86-86", "7-32", "30-21", "32-47",
      "76-73", "45-54", "57-30", "13-22", "59-84", "22-23", "38-19", "14-25", "21-22", "28-10",
      "30-29", "5-5", "51-52", "4-4", "29-31", "3-75", "31-29", "4-4", "73-46", "12-1",
      "52-43", "25-32", "19-30", "75-21", "22-21", "4-4", "46-73", "53-62", "29-47", "62-71",
      "73-19", "10-55", "77-68", "55-10", "21-12", "54-55", "47-65", "55-56", "84-63", "10-13",
    ],
    finalScores: [1, 0],
  },
  {
    id: "janggi-seed-22",
    seed: 22,
    choiceKeys: [
      "54-55", "29-28", "58-49", "0-18", "55-46", "7-32", "49-50", "35-44", "81-36", "13-4",
      "76-75", "8-7", "36-43", "32-61", "82-57", "5-14", "70-52", "18-0", "52-79", "4-4",
      "46-37", "14-14", "83-72", "61-32", "57-28", "14-14", "37-38", "3-3", "43-40", "4-4",
      "60-61", "44-53", "79-43", "33-42", "86-85", "14-14", "43-70", "14-23", "75-76", "25-21",
      "50-41", "42-51", "88-69", "7-43", "84-75", "23-13", "41-32", "6-25", "72-55", "25-8",
      "87-58", "43-44", "62-53", "21-84", "40-41", "84-12", "89-88", "19-55", "76-77", "13-14",
      "88-79", "3-3", "75-84", "44-41", "70-68", "41-43", "77-77", "2-21", "32-31", "43-38",
      "79-80", "1-30", "58-73", "27-36", "69-86", "55-19", "80-89", "21-10", "77-76", "19-1",
      "64-10", "14-5", "10-46", "0-9", "53-52", "38-11", "56-55", "12-48", "89-87", "30-59",
      "52-51", "9-18", "87-89", "11-15", "84-75", "59-44", "61-60", "15-42", "75-66", "5-5",
      "76-67", "48-53", "60-61", "53-35", "73-48", "35-29", "89-71", "29-27", "71-69", "27-0",
      "86-79", "18-19", "61-60", "0-81", "46-49", "42-40", "55-56", "19-26", "31-30", "40-41",
      "28-3", "41-50", "79-62", "44-23", "30-21", "50-32", "68-71", "81-0", "69-78", "23-38",
      "67-76", "32-35", "85-84", "38-23", "3-28", "23-52", "66-66", "1-82", "78-69", "5-14",
      "69-68", "82-88", "76-85", "88-7", "28-57", "4-4", "68-86", "36-37", "66-75", "35-32",
      "57-82", "26-44", "86-77", "32-50", "56-57", "14-23", "57-58", "50-49", "71-53", "49-22",
      "77-59", "44-38", "85-86", "38-44", "59-50", "22-49", "21-13", "4-13", "60-61", "44-40",
      "50-68", "13-4", "61-60", "7-61", "58-59", "49-51", "48-19", "4-5", "68-63", "51-48",
      "86-86", "0-6", "63-68", "6-87", "68-66", "48-12", "84-76", "12-13", "62-79", "40-22",
      "66-57", "87-24", "53-51", "61-88", "76-67", "5-5", "57-30", "22-49", "59-50", "24-20",
      "30-21", "8-15", "19-48", "49-50", "86-85", "88-83", "51-78", "50-59", "21-30", "15-34",
      "60-59", "37-46", "48-73", "23-23", "30-3", "5-14", "59-50", "23-22", "50-41", "13-5",
    ],
    finalScores: [0, 1],
  },
  {
    id: "janggi-seed-33",
    seed: 33,
    choiceKeys: [
      "76-67", "3-4", "60-61", "2-21", "54-45", "21-28", "82-57", "4-3", "45-46", "8-26",
      "70-52", "33-34", "89-80", "35-44", "62-53", "3-12", "81-36", "12-12", "36-44", "26-8",
      "87-70", "8-44", "70-87", "0-9", "57-28", "5-14", "80-76", "13-23", "52-70", "12-12",
      "83-66", "1-30", "46-47", "23-22", "53-44", "19-46", "70-43", "31-32", "76-72", "46-48",
      "43-79", "30-59", "44-35", "9-10", "72-74", "14-14", "64-10", "6-23", "61-62", "29-28",
      "66-49", "12-12", "84-75", "48-52", "67-76", "59-30", "76-66", "32-31", "87-70", "12-12",
      "56-55", "30-9", "74-83", "23-16", "79-74", "12-21", "70-77", "16-5", "35-26", "14-14",
      "55-54", "14-13", "83-85", "31-32", "88-59", "21-12", "77-60", "22-22", "66-76", "34-35",
      "76-67", "13-4", "10-73", "9-30", "60-79", "27-36", "74-78", "5-16", "73-76", "52-48",
      "49-60", "36-45", "75-66", "12-3", "60-71", "28-37", "67-68", "22-21", "47-48", "25-18",
      "86-86", "37-36", "26-17", "30-51", "76-13", "7-22", "79-60", "51-26", "60-53", "35-44",
      "66-66", "16-23", "66-75", "21-12", "13-9", "12-21", "17-16", "3-13", "58-57", "22-47",
      "75-75", "23-34", "59-80", "36-37", "75-66", "26-41", "68-76", "4-5", "66-66", "37-46",
      "53-42", "34-15", "80-59", "45-54", "78-33", "5-14", "85-82", "13-23", "16-7", "23-22",
      "82-64", "44-53", "33-51", "18-72", "76-85", "21-13", "66-76", "14-23", "71-88", "41-70",
      "88-77", "15-4", "76-76", "72-77", "42-23", "22-21", "76-67", "21-22", "57-56", "13-5",
      "7-6", "5-13", "9-63", "32-31", "23-4", "47-18", "59-84", "54-55", "4-15", "55-64",
      "63-0", "18-39", "86-77", "13-3", "48-39", "46-47", "39-40", "64-65", "85-86", "47-56",
      "40-39", "65-66", "15-22", "3-12", "39-30", "56-57", "6-5", "70-49", "84-55", "49-70",
      "62-61", "66-75", "55-40", "75-74", "40-69", "57-56", "30-21", "12-21", "69-84", "21-22",
      "0-6", "22-21", "6-1", "21-22", "5-4", "31-32", "67-67", "22-13", "77-68", "53-52",
      "84-69", "52-51", "4-3", "56-65", "69-44", "65-66", "1-4", "13-14", "67-67", "70-49",
    ],
    finalScores: [1, 0],
  },
];

// -----------------------------------------------------------------------

export const janggiAdapter: GameAdapter<JanggiState, JanggiObservation, JanggiChoice> = {
  spec: {
    gameId: 'janggi',
    playerCount: 2,
    decisionPoints: [
      {
        id: 'move',
        description: 'Move one of your pieces from its current square to a legal destination.',
      },
    ],
    seatingPlan: [
      [0, 1],
      [1, 0],
    ],
    perfectInformation: true,
    scoreMargin: 'none',
    maxDecisionsPerGame: MAX_PLIES,
    utility: 'zero-sum',
  },
  createInitialState,
  currentDecision,
  getObservation,
  getLegalChoices,
  applyChoice,
  getOutcome,
  encodeChoice,
  reconstructState,
  invariants: [singleGeneralInvariant, pieceCountInvariant, previousMoverNotInCheckInvariant],
  replayFixtures,
  baselines: {
    random: randomBaseline,
    heuristic: heuristicBaseline,
  },
  strategySurface: [captureHighestValue, preferCheck, advanceSoldier],
};

export { ARRANGEMENTS, isPlayerInCheck, legalMovesFor, applyMove };
