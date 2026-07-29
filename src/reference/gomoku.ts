/**
 * gomoku — reference GameAdapter implementation (headless onboarding of an
 * open-source Gomoku/五目並べ implementation).
 *
 * Rules (standard freestyle Gomoku, designed from scratch — NOT copied from
 * the reference project's win validator, which only checks one axis; see
 * below):
 *   - 15x15 board (rows/cols 0..14), Black (player 0) always plays first.
 *   - Players alternately place one stone on an empty intersection.
 *   - Getting 5-or-more same-colour stones in an unbroken line (horizontal,
 *     vertical, or either diagonal) wins immediately (overlines count —
 *     freestyle rules, no Renju overline restriction).
 *   - If the board fills with no five-in-a-row, the game is a draw.
 *
 * Determinism / opening diversity (docs/ONBOARDING-GUIDE.md §5, §5.5):
 * Gomoku is a fixed-start, perfect-information, fully deterministic game —
 * two deterministic bots replaying the empty board produce the exact same
 * game on every seed, which collapses the seed-diversity conformance check
 * (C1) and any paired-seed statistics downstream. `createInitialState(seed)`
 * resolves this the way chess-engine testers (Fishtest/OpenBench) resolve it
 * for chess: an opening book. The seed selects one of a bank of short,
 * pre-applied opening lines (2-4 stones, alternating Black/White) before
 * normal decision-driven play resumes. The bank deliberately includes both
 * symmetric-ish and imbalanced lines (one side already holds a stronger
 * shape) per §5.5's "불균형 오프닝" guidance, so paired statistics aren't
 * dominated by a single always-identical first-move-advantage game.
 *
 * All randomness flows through `createRng`/`Rng.nextInt` from ../kernel/rng
 * — no Date.now()/Math.random() anywhere in this file (C1 determinism rule).
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

export const BOARD_SIZE = 15;
const CENTER = 7;
const WIN_LENGTH = 5;
const TOTAL_CELLS = BOARD_SIZE * BOARD_SIZE; // 225

export type Cell = 0 | 1 | 2; // 0 = empty, 1 = black (player 0), 2 = white (player 1)

export interface GomokuMove {
  readonly row: number;
  readonly col: number;
}

export interface GomokuState {
  /** Flat row-major board, length BOARD_SIZE*BOARD_SIZE. */
  readonly board: readonly Cell[];
  /** Total stones placed so far (opening stones included). */
  readonly moveCount: number;
  /** Player who just won, if any; null while the game is undecided. */
  readonly winner: PlayerId | null;
  /** Id of the opening line selected by the seed (diagnostic only). */
  readonly openingId: string;
}

export interface GomokuObservation {
  readonly self: PlayerId;
  readonly board: readonly Cell[];
  readonly moveCount: number;
  readonly toMove: PlayerId;
}

export type GomokuChoice = GomokuMove;

function otherPlayer(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

function playerToCell(player: PlayerId): Cell {
  return player === 0 ? 1 : 2;
}

function cellToPlayer(cell: Cell): PlayerId | null {
  if (cell === 1) return 0;
  if (cell === 2) return 1;
  return null;
}

function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function indexOf(row: number, col: number): number {
  return row * BOARD_SIZE + col;
}

// -----------------------------------------------------------------------
// Opening book: each entry is a short sequence of (row,col) deltas from the
// board center, applied alternately Black/White (delta 0 = Black's move).
// Deliberately mixes symmetric-looking clusters, distant/split shapes, and
// imbalanced shapes (one side already forming an open three or a stronger
// cluster) — see the module doc comment for why this matters.
// -----------------------------------------------------------------------

interface OpeningSpec {
  readonly id: string;
  readonly deltas: readonly (readonly [number, number])[];
}

const OPENING_BOOK: readonly OpeningSpec[] = [
  { id: 'center-adjacent', deltas: [[0, 0], [0, 1]] },
  { id: 'center-diagonal', deltas: [[0, 0], [1, 1]] },
  { id: 'center-knight', deltas: [[0, 0], [1, 2]] },
  { id: 'center-split', deltas: [[0, 0], [-2, 2]] },
  { id: 'black-pair-open', deltas: [[0, 0], [3, -3], [0, 1]] },
  { id: 'black-pair-vertical', deltas: [[0, 0], [3, 3], [1, 0]] },
  { id: 'white-shoulder-hit', deltas: [[0, 0], [0, -1], [2, 0]] },
  { id: 'staircase', deltas: [[0, 0], [1, -1], [1, 0], [2, -1]] },
  { id: 'far-corner-white', deltas: [[0, 0], [-5, -5]] },
  { id: 'far-corner-black-follow', deltas: [[0, 0], [-5, -5], [-1, -1]] },
  { id: 'imbalanced-black-three-open', deltas: [[0, 0], [4, 4], [0, 1], [4, 3], [0, 2]] },
  { id: 'imbalanced-white-block', deltas: [[0, 0], [0, 1], [-4, -4], [0, -1]] },
  { id: 'cross-shape', deltas: [[0, 0], [1, 0], [-1, 0], [0, -1]] },
  { id: 'edge-lean-black', deltas: [[0, 0], [0, 5]] },
  { id: 'edge-lean-white', deltas: [[0, 0], [5, 0], [0, 5]] },
  { id: 'tight-cluster', deltas: [[0, 0], [0, 1], [1, 0], [1, 1]] },
  { id: 'loose-cluster', deltas: [[0, 0], [2, 1], [-1, 2], [1, -2]] },
  { id: 'diagonal-chain-black', deltas: [[0, 0], [3, -3], [1, -1], [4, -4]] },
  { id: 'diagonal-chain-white', deltas: [[0, 0], [1, -1], [-4, 4], [2, -2]] },
  { id: 'single-black-only', deltas: [[0, 0]] },
  { id: 'offset-pair-nw', deltas: [[0, 0], [-2, -1]] },
  { id: 'offset-pair-se', deltas: [[0, 0], [2, 1]] },
  { id: 'wide-imbalance-white', deltas: [[0, 0], [0, 2], [-3, 0], [0, -2]] },
  { id: 'wide-imbalance-black', deltas: [[0, 0], [-3, 0], [0, 3], [3, 0], [0, -3]] },
];

function buildOpeningBoard(opening: OpeningSpec): readonly Cell[] {
  const board: Cell[] = new Array<Cell>(TOTAL_CELLS).fill(0);
  opening.deltas.forEach(([dr, dc], moveIndex) => {
    const row = CENTER + dr;
    const col = CENTER + dc;
    if (!inBounds(row, col)) {
      throw new Error(
        `gomoku opening "${opening.id}": delta [${dr},${dc}] lands out of bounds at (${row},${col})`,
      );
    }
    const cell = playerToCell(moveIndex % 2 === 0 ? 0 : 1);
    const idx = indexOf(row, col);
    if (board[idx] !== 0) {
      throw new Error(`gomoku opening "${opening.id}": duplicate cell at (${row},${col})`);
    }
    board[idx] = cell;
  });
  return board;
}

function lineLengthThrough(
  board: readonly Cell[],
  row: number,
  col: number,
  cell: Cell,
  dr: number,
  dc: number,
): number {
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

const DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

/** True iff placing `cell` at (row,col) on `board` creates a 5+ line. */
function isWinningMove(board: readonly Cell[], row: number, col: number, cell: Cell): boolean {
  return DIRECTIONS.some(
    ([dr, dc]) => lineLengthThrough(board, row, col, cell, dr, dc) >= WIN_LENGTH,
  );
}

function findWinnerFromLastMove(
  board: readonly Cell[],
  lastMove: GomokuMove | null,
): PlayerId | null {
  if (!lastMove) return null;
  const idx = indexOf(lastMove.row, lastMove.col);
  const cell = board[idx];
  if (cell === undefined || cell === 0) return null;
  return isWinningMove(board, lastMove.row, lastMove.col, cell) ? cellToPlayer(cell) : null;
}

function createInitialState(seed: number): GomokuState {
  const rng = createRng(seed);
  const openingIndex = rng.nextInt(OPENING_BOOK.length);
  const opening = OPENING_BOOK[openingIndex] as OpeningSpec;
  const board = buildOpeningBoard(opening);
  const moveCount = opening.deltas.length;

  // The opening book is a fixed compile-time constant, but guard against a
  // future bad entry accidentally shipping a pre-won opening.
  let winner: PlayerId | null = null;
  opening.deltas.forEach(([dr, dc], moveIndex) => {
    const row = CENTER + dr;
    const col = CENTER + dc;
    const cell = playerToCell(moveIndex % 2 === 0 ? 0 : 1);
    if (isWinningMove(board, row, col, cell)) {
      winner = cellToPlayer(cell);
    }
  });
  if (winner !== null) {
    throw new Error(`gomoku opening "${opening.id}" is already a won position — fix the opening book`);
  }

  return { board, moveCount, winner: null, openingId: opening.id };
}

function currentDecision(state: GomokuState): PendingDecision | null {
  if (state.winner !== null) return null;
  if (state.moveCount >= TOTAL_CELLS) return null; // board full: draw
  const player: PlayerId = state.moveCount % 2 === 0 ? 0 : 1;
  return { player, decisionPoint: 'place' };
}

function getObservation(state: GomokuState, player: PlayerId): GomokuObservation {
  return {
    self: player,
    board: state.board,
    moveCount: state.moveCount,
    toMove: state.moveCount % 2 === 0 ? 0 : 1,
  };
}

/**
 * Deterministic hash of the board contents + moveCount, used only to derive
 * a state-local shuffle seed for getLegalChoices below — NOT a source of
 * game randomness (no bearing on rules or outcomes, purely reorders an
 * already-fully-determined list). Pure function of `state`, so this does not
 * violate the determinism rule.
 */
function hashBoardState(state: GomokuState): number {
  let hash = 0x811c9dc5 ^ state.moveCount;
  for (let i = 0; i < state.board.length; i += 1) {
    hash ^= (state.board[i] as number) + 1;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function getLegalChoices(state: GomokuState): readonly GomokuMove[] {
  if (currentDecision(state) === null) {
    throw new Error('getLegalChoices: game is already over');
  }
  const moves: GomokuMove[] = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (state.board[indexOf(row, col)] === 0) {
        moves.push({ row, col });
      }
    }
  }
  // Row-major order would otherwise make every legal-choice list share the
  // same "top-left-first" structure across all states. A bot with a fixed
  // RNG seed (as scoreAdapter's C5 identity calibration uses across every
  // sampled game seed) would then draw the exact same raw fraction sequence
  // against structurally similar lists every game, correlating its choices
  // with board position instead of behaving as a genuinely uniform random
  // baseline. Shuffling deterministically by state contents breaks that
  // correlation without introducing any real nondeterminism.
  return shuffled(moves, createRng(hashBoardState(state)));
}

function applyChoice(state: GomokuState, choice: GomokuMove): GomokuState {
  const decision = currentDecision(state);
  if (!decision) {
    throw new Error('applyChoice: game is already over');
  }
  if (!inBounds(choice.row, choice.col)) {
    throw new Error(`applyChoice: (${choice.row},${choice.col}) is out of bounds`);
  }
  const idx = indexOf(choice.row, choice.col);
  if (state.board[idx] !== 0) {
    throw new Error(`applyChoice: (${choice.row},${choice.col}) is already occupied`);
  }

  const cell = playerToCell(decision.player);
  const board = state.board.slice();
  board[idx] = cell;
  const moveCount = state.moveCount + 1;
  const winner = isWinningMove(board, choice.row, choice.col, cell) ? decision.player : null;

  return { board, moveCount, winner, openingId: state.openingId };
}

function getOutcome(state: GomokuState): Outcome | null {
  if (currentDecision(state) !== null) return null;
  if (state.winner !== null) {
    const loser = otherPlayer(state.winner);
    const scores = [0, 0];
    scores[state.winner] = 1;
    scores[loser] = 0;
    return { scores, winners: [state.winner] };
  }
  // Board full, no five-in-a-row: draw.
  return { scores: [0, 0], winners: [0, 1] };
}

function encodeChoice(choice: GomokuMove): string {
  return `${choice.row}-${choice.col}`;
}

/**
 * MCTS simulation root (docs/GAP-ANALYSIS-7.md O6): the observation carries the
 * full board and moveCount, so state is losslessly reconstructable except for
 * `winner`/`openingId`, which are diagnostic-only fields not read by any move
 * logic. `winner` is always null here because getObservation is only ever
 * requested while a decision is pending (currentDecision(state) !== null),
 * which by construction means the game is not yet won; `openingId` is never
 * consulted after createInitialState, so a placeholder is safe.
 */
function reconstructState(observation: GomokuObservation): GomokuState {
  return {
    board: observation.board,
    moveCount: observation.moveCount,
    winner: null,
    openingId: 'reconstructed',
  };
}

function stoneCountInvariant(state: GomokuState): string | null {
  let filled = 0;
  let black = 0;
  let white = 0;
  for (const cell of state.board) {
    if (cell !== 0) filled += 1;
    if (cell === 1) black += 1;
    if (cell === 2) white += 1;
  }
  if (filled !== state.moveCount) {
    return `stone count mismatch: board has ${filled} stones but moveCount is ${state.moveCount}`;
  }
  const diff = black - white;
  if (diff !== 0 && diff !== 1) {
    return `turn alternation violated: black=${black} white=${white} (black must lead by 0 or 1)`;
  }
  return null;
}

function singleWinnerInvariant(state: GomokuState): string | null {
  if (state.winner === null) return null;
  const winnerCell = playerToCell(state.winner);
  const loserCell = playerToCell(otherPlayer(state.winner));
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (state.board[indexOf(row, col)] === loserCell) {
        if (isWinningMove(state.board, row, col, loserCell)) {
          return `both players have a winning line simultaneously (loser cell ${loserCell} at ${row},${col})`;
        }
      }
    }
  }
  void winnerCell;
  return null;
}

// -----------------------------------------------------------------------
// Baselines
// -----------------------------------------------------------------------

function chebyshevDistance(a: GomokuMove, b: GomokuMove): number {
  return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
}

const randomBaseline: BotFactory<GomokuObservation, GomokuChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'gomoku-random',
    decide(_decisionPoint, _observation, legal) {
      return legal[rng.nextInt(legal.length)] as GomokuChoice;
    },
  };
};

/**
 * Heuristic baseline: score every legal cell by how many same-colour stones
 * sit within a 2-cell radius (rewarding building on existing shape), then
 * break ties by proximity to board center. Deterministic given the board.
 */
function heuristicScore(observation: GomokuObservation, move: GomokuMove): number {
  const self = playerToCell(observation.self);
  let score = 0;
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const row = move.row + dr;
      const col = move.col + dc;
      if (!inBounds(row, col)) continue;
      if (observation.board[indexOf(row, col)] === self) {
        const ring = Math.max(Math.abs(dr), Math.abs(dc));
        score += ring === 1 ? 3 : 1;
      }
    }
  }
  return score;
}

function bestByScore(
  legal: readonly GomokuMove[],
  scoreFn: (move: GomokuMove) => number,
): GomokuMove {
  const center: GomokuMove = { row: CENTER, col: CENTER };
  let best = legal[0] as GomokuMove;
  let bestScore = scoreFn(best);
  let bestDistance = chebyshevDistance(best, center);
  for (let i = 1; i < legal.length; i += 1) {
    const candidate = legal[i] as GomokuMove;
    const candidateScore = scoreFn(candidate);
    const candidateDistance = chebyshevDistance(candidate, center);
    if (
      candidateScore > bestScore ||
      (candidateScore === bestScore && candidateDistance < bestDistance)
    ) {
      best = candidate;
      bestScore = candidateScore;
      bestDistance = candidateDistance;
    }
  }
  return best;
}

const heuristicBaseline: BotFactory<GomokuObservation, GomokuChoice> = (_seed) => {
  return {
    id: 'gomoku-heuristic',
    decide(_decisionPoint, observation, legal) {
      return bestByScore(legal, (move) => heuristicScore(observation, move));
    },
  };
};

// -----------------------------------------------------------------------
// Strategy surface
// -----------------------------------------------------------------------

function wrapBotId(id: string, suffix: string): string {
  return `${id}+${suffix}`;
}

function findImmediateWin(
  observation: GomokuObservation,
  legal: readonly GomokuMove[],
  cell: Cell,
): GomokuMove | null {
  for (const move of legal) {
    if (isWinningMove(observation.board, move.row, move.col, cell)) {
      return move;
    }
  }
  return null;
}

/** Strategy flag: effective. Take an immediate win if available; otherwise
 * block the opponent's immediate win if they have one; otherwise delegate
 * to the base bot. */
const blockImmediateThreat: StrategyFlagSpec<GomokuObservation, GomokuChoice> = {
  flag: 'blockImmediateThreat',
  description:
    'Plays an immediate winning move if one exists, else blocks the opponent immediate win, else delegates to base.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot.id, 'blockImmediateThreat'),
        decide(decisionPoint, observation, legal) {
          const selfCell = playerToCell(observation.self);
          const win = findImmediateWin(observation, legal, selfCell);
          if (win) return win;
          const opponentCell = playerToCell(otherPlayer(observation.self));
          const block = findImmediateWin(observation, legal, opponentCell);
          if (block) return block;
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/** Strategy flag: marginal. Always plays the empty cell closest to board
 * center (ties broken by row then column), ignoring shape entirely. */
const centerProximity: StrategyFlagSpec<GomokuObservation, GomokuChoice> = {
  flag: 'centerProximity',
  description: 'Always plays the legal cell closest to the board center, ignoring existing shape.',
  apply(_base) {
    return (_seed) => {
      return {
        id: 'gomoku-centerProximity',
        decide(_decisionPoint, _observation, legal) {
          const center: GomokuMove = { row: CENTER, col: CENTER };
          let best = legal[0] as GomokuMove;
          let bestDistance = chebyshevDistance(best, center);
          for (let i = 1; i < legal.length; i += 1) {
            const candidate = legal[i] as GomokuMove;
            const distance = chebyshevDistance(candidate, center);
            if (
              distance < bestDistance ||
              (distance === bestDistance &&
                (candidate.row < best.row ||
                  (candidate.row === best.row && candidate.col < best.col)))
            ) {
              best = candidate;
              bestDistance = distance;
            }
          }
          return best;
        },
      };
    };
  },
};

function longestLineIfPlaced(board: readonly Cell[], move: GomokuMove, cell: Cell): number {
  const trial = board.slice();
  trial[indexOf(move.row, move.col)] = cell;
  let best = 0;
  for (const [dr, dc] of DIRECTIONS) {
    best = Math.max(best, lineLengthThrough(trial, move.row, move.col, cell, dr, dc));
  }
  return best;
}

/** Strategy flag: effective. Plays the legal cell that maximizes its own
 * longest resulting same-colour line (offense-first), ties broken by the
 * base heuristic's adjacency score. Distinct from the base heuristic, which
 * scores by local stone density rather than line length directly. */
const extendLongestLine: StrategyFlagSpec<GomokuObservation, GomokuChoice> = {
  flag: 'extendLongestLine',
  description:
    "Plays the legal cell that creates the longest same-colour line, ties broken by the base bot's own choice.",
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot.id, 'extendLongestLine'),
        decide(decisionPoint, observation, legal) {
          const self = playerToCell(observation.self);
          let bestLength = -1;
          let candidates: GomokuMove[] = [];
          for (const move of legal) {
            const length = longestLineIfPlaced(observation.board, move, self);
            if (length > bestLength) {
              bestLength = length;
              candidates = [move];
            } else if (length === bestLength) {
              candidates.push(move);
            }
          }
          if (candidates.length === 1) {
            return candidates[0] as GomokuMove;
          }
          const baseChoice = bot.decide(decisionPoint, observation, legal);
          const baseKey = encodeChoice(baseChoice);
          const tieMatch = candidates.find((move) => encodeChoice(move) === baseKey);
          return tieMatch ?? (candidates[0] as GomokuMove);
        },
      };
    };
  },
};

/**
 * Fork-awareness geometry (docs/GAP-ANALYSIS-8.md §4.8 follow-up): the
 * literal immediate-win/immediate-block tactical precheck (search/mcts.ts's
 * tacticalDepth) never beat the Opus improv bot because it can't see
 * multi-direction threats — a move that creates two independent "must
 * respond" lines at once (a fork) is a de-facto win even though neither line
 * is a 5-in-a-row yet. This is the first attempt to encode that geometry
 * directly as game knowledge in the adapter's strategySurface.
 *
 * `runInfoAt` walks one direction through a *hypothetical* placement without
 * allocating a trial board (unlike `longestLineIfPlaced` above) — `moveIdx`
 * substitutes `moveCell` for whatever is actually on the board at that one
 * index, everywhere else reads through untouched. This matters because
 * `countForkThreats` below calls it up to `4 directions * ~220 legal moves`
 * times per decision — worth avoiding a 225-cell array copy per call, since a
 * champion-rollout MCTS candidate could call this every simulated move.
 */
function runInfoAt(
  board: readonly Cell[],
  moveIdx: number,
  moveCell: Cell,
  row: number,
  col: number,
  cell: Cell,
  dr: number,
  dc: number,
): { readonly length: number; readonly beforeOpen: boolean; readonly afterOpen: boolean } {
  const at = (r: number, c: number): Cell => {
    const i = indexOf(r, c);
    return i === moveIdx ? moveCell : (board[i] as Cell);
  };
  let length = 1;
  let r = row + dr;
  let c = col + dc;
  while (inBounds(r, c) && at(r, c) === cell) {
    length += 1;
    r += dr;
    c += dc;
  }
  const afterOpen = inBounds(r, c) && at(r, c) === 0;
  let r2 = row - dr;
  let c2 = col - dc;
  while (inBounds(r2, c2) && at(r2, c2) === cell) {
    length += 1;
    r2 -= dr;
    c2 -= dc;
  }
  const beforeOpen = inBounds(r2, c2) && at(r2, c2) === 0;
  return { length, beforeOpen, afterOpen };
}

/**
 * Whether placing `cell` at (row,col) creates a "threat" in direction
 * (dr,dc): either an open three (3-in-a-row, both immediate ends empty — the
 * task's own definition, taken literally rather than requiring the extended
 * open-four-reachability check a full Renju engine would add) or a four with
 * at least one open end (a four with both ends blocked is dead — no
 * follow-up win). A run of 5+ is an outright win, handled separately by
 * `findImmediateWin` before fork scoring ever runs, so it is not counted here.
 */
function directionHasThreat(
  board: readonly Cell[],
  moveIdx: number,
  row: number,
  col: number,
  cell: Cell,
  dr: number,
  dc: number,
): boolean {
  const info = runInfoAt(board, moveIdx, cell, row, col, cell, dr, dc);
  if (info.length >= 5) return false;
  const openEnds = (info.beforeOpen ? 1 : 0) + (info.afterOpen ? 1 : 0);
  if (info.length === 4) return openEnds >= 1;
  if (info.length === 3) return openEnds === 2;
  return false;
}

/** Number of independent (different-direction) threats placing `cell` at `move` creates — 2+ is a fork. */
function countForkThreats(board: readonly Cell[], move: GomokuMove, cell: Cell): number {
  const moveIdx = indexOf(move.row, move.col);
  let threats = 0;
  for (const [dr, dc] of DIRECTIONS) {
    if (directionHasThreat(board, moveIdx, move.row, move.col, cell, dr, dc)) {
      threats += 1;
    }
  }
  return threats;
}

interface GomokuForkCandidates {
  readonly selfForkMoves: readonly GomokuMove[];
  readonly opponentForkMoves: readonly GomokuMove[];
  readonly selfSingleThreatMoves: readonly GomokuMove[];
}

/** Shared candidate-generation pass behind both `forkAwareness` and `gomokuForkDecision` below — kept as one function so the two never drift out of sync on what counts as a fork/single-threat move. */
function forkCandidateMoves(
  board: readonly Cell[],
  legal: readonly GomokuMove[],
  selfCell: Cell,
  opponentCell: Cell,
): GomokuForkCandidates {
  const selfForkMoves: GomokuMove[] = [];
  const selfSingleThreatMoves: GomokuMove[] = [];
  const opponentForkMoves: GomokuMove[] = [];
  for (const move of legal) {
    const selfThreats = countForkThreats(board, move, selfCell);
    if (selfThreats >= 2) {
      selfForkMoves.push(move);
    } else if (selfThreats === 1) {
      selfSingleThreatMoves.push(move);
    }
    if (countForkThreats(board, move, opponentCell) >= 2) {
      opponentForkMoves.push(move);
    }
  }
  return { selfForkMoves, opponentForkMoves, selfSingleThreatMoves };
}

/**
 * Pure fork-priority judgment (docs/GAP-ANALYSIS-8.md gomoku C-column retry
 * — MCTS rootOverride follow-up), factored out of `forkAwareness` below so it
 * can be reused outside the strategySurface flag machinery — specifically as
 * an MCTS `rootOverride` (search/mcts.ts's MctsConfig option), which has no
 * `base` bot to delegate to and needs a plain `(state, legal, player) =>
 * choice | null` shape.
 *
 * Deliberately does NOT include the immediate-win/immediate-block checks
 * `forkAwareness` itself layers on top: when wired as a rootOverride, those
 * are already covered — at strictly higher priority — by search/mcts.ts's
 * own `tacticalDepth` option (see that option's precedence doc comment), so
 * duplicating them here would be redundant, not incorrect, but the point of
 * this split is exactly to keep this function to the part that has no
 * game-neutral equivalent: fork move, fork block, then single-threat move,
 * in that priority order, else null.
 *
 * Ties within a tier are broken by legal-array order (the first candidate
 * found) rather than `forkAwareness`'s own base-bot-consulting tie-break —
 * there is no base bot available at an MCTS root, so this is the simplest
 * deterministic choice. `forkAwareness` does NOT call this function (it needs
 * its own tie-break), it calls the shared `forkCandidateMoves` helper above
 * instead — see that flag's own doc comment.
 */
export function gomokuForkDecision(
  state: Pick<GomokuState, 'board'>,
  legal: readonly GomokuMove[],
  player: PlayerId,
): GomokuMove | null {
  const selfCell = playerToCell(player);
  const opponentCell = playerToCell(otherPlayer(player));
  const { selfForkMoves, opponentForkMoves, selfSingleThreatMoves } = forkCandidateMoves(
    state.board,
    legal,
    selfCell,
    opponentCell,
  );
  if (selfForkMoves.length > 0) return selfForkMoves[0] as GomokuMove;
  if (opponentForkMoves.length > 0) return opponentForkMoves[0] as GomokuMove;
  if (selfSingleThreatMoves.length > 0) return selfSingleThreatMoves[0] as GomokuMove;
  return null;
}

/**
 * Strategy flag: effective, game-knowledge (docs/GAP-ANALYSIS-8.md §4.8
 * follow-up — the 4th and most specific card against the Opus improv bot's
 * C-column advantage). Priority-scored decision, delegating to `base` only
 * once none of its own criteria match. Uses the shared `forkCandidateMoves`
 * helper above (not `gomokuForkDecision`) because its tie-break within a
 * priority tier consults `base.decide`, which `gomokuForkDecision` — reused
 * outside strategySurface, where no base bot exists — deliberately does not:
 *   1. Take an immediate win if one exists.
 *   2. Block the opponent's immediate win if they have one.
 *   3. Play a move that creates a fork (2+ independent threats at once) —
 *      the opponent cannot block both, so this is a de-facto forced win.
 *   4. Block a move the opponent could use to create a fork next turn.
 *   5. Play a move that creates a single threat (open three / winning four).
 *   6. Otherwise delegate to `base.decide`.
 * Ties within a priority tier are broken by `base.decide`'s own pick among
 * the tied candidates (same pattern as `extendLongestLine` above), falling
 * back to the first candidate in `legal`'s (already state-shuffled) order
 * when the base pick isn't among them.
 */
const forkAwareness: StrategyFlagSpec<GomokuObservation, GomokuChoice> = {
  flag: 'forkAwareness',
  description:
    'Prioritizes immediate wins/blocks, then fork moves (2+ simultaneous threats) and fork blocks, then single-threat moves, else delegates to base.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot.id, 'forkAwareness'),
        decide(decisionPoint, observation, legal) {
          const selfCell = playerToCell(observation.self);
          const opponentCell = playerToCell(otherPlayer(observation.self));

          const win = findImmediateWin(observation, legal, selfCell);
          if (win) return win;
          const block = findImmediateWin(observation, legal, opponentCell);
          if (block) return block;

          const pickWithTieBreak = (candidates: readonly GomokuMove[]): GomokuMove => {
            if (candidates.length === 1) {
              return candidates[0] as GomokuMove;
            }
            const baseChoice = bot.decide(decisionPoint, observation, legal);
            const baseKey = encodeChoice(baseChoice);
            const match = candidates.find((move) => encodeChoice(move) === baseKey);
            return match ?? (candidates[0] as GomokuMove);
          };

          const { selfForkMoves, opponentForkMoves, selfSingleThreatMoves } = forkCandidateMoves(
            observation.board,
            legal,
            selfCell,
            opponentCell,
          );

          if (selfForkMoves.length > 0) return pickWithTieBreak(selfForkMoves);
          if (opponentForkMoves.length > 0) return pickWithTieBreak(opponentForkMoves);
          if (selfSingleThreatMoves.length > 0) return pickWithTieBreak(selfSingleThreatMoves);

          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/**
 * `choiceEvaluator` (contract/types.ts, ADR-0011, docs/GAP-ANALYSIS-11.md D1)
 * re-expressing `forkAwareness`/`gomokuForkDecision`'s threat-priority
 * judgment as per-choice scores instead of a single decision, so
 * `search/mcts.ts`'s tree prior (`MctsConfig.priorWeight`) can bias every
 * node's selection with this geometry, not just the root move a strategy
 * flag or `rootOverride` would otherwise pick. Priority tiers (highest wins,
 * strictly separated bands so softmax always ranks a higher tier above every
 * lower one regardless of how many moves share a tier):
 *   1. Immediate win (places a 5th stone in a row) — `CHOICE_EVALUATOR_TIER.win`.
 *   2. Blocks the opponent's immediate win — `.blockWin`.
 *   3. Creates a fork (2+ independent threats at once) — `.fork`.
 *   4. Blocks a move the opponent could use to create a fork next turn — `.blockFork`.
 *   5. Creates a four with at least one open end ("열린4/충족4") — `.four`.
 *   6. Creates an open three (both ends empty) — `.openThree`.
 *   7. Otherwise: a small, sub-`.openThree` score proportional to the
 *      longest same-colour line the move would create ("연결 확장" —
 *      `extendLongestLine`'s own criterion), so ties within this lowest tier
 *      still resolve to *something* other than a flat 0 for every move.
 * Deliberately does NOT modify `forkAwareness`/`gomokuForkDecision`/
 * `rootOverride`/any existing scoring path — this is a new, additive,
 * opt-in field (contract/types.ts's own doc comment on `choiceEvaluator`),
 * and gomoku's `strategySurface`/registered flags are untouched by adding it.
 */
const CHOICE_EVALUATOR_TIER = {
  win: 50,
  blockWin: 40,
  fork: 30,
  blockFork: 25,
  four: 20,
  openThree: 15,
} as const;

/**
 * Highest single-threat tier `move` reaches for `cell` across all 4
 * directions (0 when none) — length===4-with-an-open-end ("열린4/충족4") ranks
 * above length===3-with-both-ends-open ("열린3"), matching
 * `directionHasThreat`'s own threat definition but split into two tiers
 * instead of one boolean. Reuses `runInfoAt` (no trial-board allocation) —
 * same cost profile as `countForkThreats`/`directionHasThreat` above.
 */
function bestOwnThreatTier(board: readonly Cell[], move: GomokuMove, cell: Cell): number {
  const moveIdx = indexOf(move.row, move.col);
  let tier = 0;
  for (const [dr, dc] of DIRECTIONS) {
    const info = runInfoAt(board, moveIdx, cell, move.row, move.col, cell, dr, dc);
    if (info.length >= 5) continue; // outright win, scored separately (CHOICE_EVALUATOR_TIER.win)
    const openEnds = (info.beforeOpen ? 1 : 0) + (info.afterOpen ? 1 : 0);
    if (info.length === 4 && openEnds >= 1) {
      tier = Math.max(tier, CHOICE_EVALUATOR_TIER.four);
    } else if (info.length === 3 && openEnds === 2) {
      tier = Math.max(tier, CHOICE_EVALUATOR_TIER.openThree);
    }
  }
  return tier;
}

function gomokuChoiceEvaluator(
  state: GomokuState,
  player: PlayerId,
  choices: readonly GomokuMove[],
): readonly number[] {
  const selfCell = playerToCell(player);
  const opponentCell = playerToCell(otherPlayer(player));
  const { selfForkMoves, opponentForkMoves } = forkCandidateMoves(state.board, choices, selfCell, opponentCell);
  const selfForkKeys = new Set(selfForkMoves.map((move) => encodeChoice(move)));
  const opponentForkKeys = new Set(opponentForkMoves.map((move) => encodeChoice(move)));

  return choices.map((move) => {
    if (isWinningMove(state.board, move.row, move.col, selfCell)) {
      return CHOICE_EVALUATOR_TIER.win;
    }
    if (isWinningMove(state.board, move.row, move.col, opponentCell)) {
      return CHOICE_EVALUATOR_TIER.blockWin;
    }
    const key = encodeChoice(move);
    if (selfForkKeys.has(key)) {
      return CHOICE_EVALUATOR_TIER.fork;
    }
    if (opponentForkKeys.has(key)) {
      return CHOICE_EVALUATOR_TIER.blockFork;
    }
    const threatTier = bestOwnThreatTier(state.board, move, selfCell);
    if (threatTier > 0) {
      return threatTier;
    }
    // "연결 확장": below openThree's tier for any board (longestLineIfPlaced
    // never exceeds 4 here — a length-5+ result would already have matched
    // the win check above), so dividing by 10 keeps every value in this
    // fallback band strictly under CHOICE_EVALUATOR_TIER.openThree.
    return longestLineIfPlaced(state.board, move, selfCell) / 10;
  });
}

// -----------------------------------------------------------------------
// Replay fixtures — generated by actually running this adapter's own
// random-vs-random self-play (see src/reference/__tests__/gomoku.test.ts for
// the generation note), then hardcoded here. The original open-source
// project's win-validator bug (see module doc) meant it could not be trusted
// to produce a parity replay, so these are self-play reproducibility
// fixtures, not true cross-implementation parity fixtures — see the final
// report for detail.
// -----------------------------------------------------------------------

const replayFixtures: readonly ReplayFixture[] = [
  {
    id: 'gomoku-seed-11',
    seed: 11,
    choiceKeys: [
      '7-3', '10-10', '8-6', '13-0', '5-1', '11-13', '2-9', '4-2', '1-1', '3-11',
      '0-12', '8-9', '5-2', '8-2', '9-2', '1-11', '1-0', '0-14', '3-3', '2-12',
      '4-6', '8-14', '3-5', '11-10', '2-10', '14-0', '12-0', '12-3', '10-6', '0-3',
      '12-4', '4-1', '1-13', '1-7', '3-2', '7-1', '4-12', '0-5', '9-0', '1-3',
      '12-2', '3-0', '6-14', '8-3', '12-7', '6-11', '2-13', '3-6', '14-14', '8-11',
      '5-13', '3-4', '13-7', '13-8', '3-13', '13-2', '0-6', '14-13', '0-9', '14-9',
      '7-5', '7-9', '3-8', '6-2', '10-1', '6-0', '4-8', '7-4', '12-8', '9-14',
      '11-9', '0-10', '3-9', '4-14', '1-14', '10-4', '1-9', '5-10', '10-5', '5-4',
      '4-7', '9-5', '12-12', '5-3', '13-12', '10-7', '1-4', '10-12', '6-3', '5-8',
      '7-8', '2-5', '11-1', '11-12', '8-0', '6-8', '5-0', '1-12', '5-14', '0-2',
      '6-12', '11-2', '13-3', '9-3',
    ],
    finalScores: [0, 1],
  },
  {
    id: 'gomoku-seed-22',
    seed: 22,
    choiceKeys: [
      '6-4', '1-8', '6-0', '14-10', '3-6', '1-0', '13-1', '2-9', '3-5', '11-11',
      '9-5', '3-3', '5-7', '10-1', '11-12', '10-12', '14-11', '12-0', '10-8', '13-4',
      '11-9', '5-0', '6-12', '8-13', '9-9', '14-14', '11-1', '8-7', '14-7', '7-3',
      '11-6', '10-10', '13-10', '5-5', '7-10', '4-7', '9-8', '4-2', '11-10', '8-1',
      '3-2', '6-13', '1-7', '4-1', '6-11', '14-13', '10-3', '8-14', '7-11', '1-9',
      '12-11', '10-13', '5-4', '10-6', '13-0', '3-7', '14-5', '4-13', '2-12', '14-4',
      '12-6', '5-10', '11-14', '8-10', '13-6', '1-11', '8-11', '13-11', '14-0', '8-0',
      '0-7', '4-5', '13-8', '3-9', '11-4', '9-1', '3-14', '9-2', '11-5', '1-5',
      '14-1', '12-10', '7-8', '7-1', '0-9', '2-7', '12-1', '4-10', '8-9', '10-11',
      '2-10', '10-0', '5-2', '0-13', '9-3', '13-14', '0-2', '1-1', '6-10', '10-14',
    ],
    finalScores: [1, 0],
  },
  {
    id: 'gomoku-seed-33',
    seed: 33,
    choiceKeys: [
      '4-13', '8-6', '14-12', '7-13', '12-14', '3-1', '9-4', '11-5', '10-3', '7-8',
      '12-12', '1-7', '11-1', '13-14', '2-11', '4-7', '0-10', '9-9', '8-13', '10-14',
      '3-0', '7-5', '8-4', '0-14', '2-7', '10-4', '4-11', '14-6', '1-0', '4-8',
      '6-1', '12-5', '4-6', '6-7', '6-9', '4-0', '5-13', '8-12', '3-13', '12-6',
      '1-10', '3-11', '14-4', '11-8', '13-12', '0-6', '2-5', '9-1', '6-4', '0-13',
      '8-7', '11-0', '0-0', '8-5', '8-1', '12-4', '13-6', '1-5', '8-10', '6-8',
      '0-4', '4-5', '10-12', '4-9', '5-2', '9-7', '2-4', '12-11', '5-0', '2-3',
      '9-12', '9-10', '13-4', '7-14', '12-7', '7-0', '8-2', '8-11', '9-11', '0-5',
      '0-2', '14-14', '9-3', '10-1', '3-14', '8-14', '4-4', '5-5', '14-8', '11-7',
      '14-3', '14-9', '6-0', '10-5', '5-6', '14-7', '10-9', '7-2', '2-10', '6-10',
      '2-2', '13-11', '3-4', '5-1', '13-5', '2-9', '4-14', '7-6', '13-13', '12-9',
      '14-0', '6-5',
    ],
    finalScores: [0, 1],
  },
];

export const gomokuAdapter: GameAdapter<GomokuState, GomokuObservation, GomokuChoice> = {
  spec: {
    gameId: 'gomoku',
    playerCount: 2,
    decisionPoints: [
      {
        id: 'place',
        description: 'Place one stone on an empty intersection of the 15x15 board.',
      },
    ],
    seatingPlan: [
      [0, 1],
      [1, 0],
    ],
    perfectInformation: true,
    scoreMargin: 'none',
    maxDecisionsPerGame: TOTAL_CELLS,
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
  invariants: [stoneCountInvariant, singleWinnerInvariant],
  replayFixtures,
  baselines: {
    random: randomBaseline,
    heuristic: heuristicBaseline,
  },
  strategySurface: [blockImmediateThreat, centerProximity, extendLongestLine, forkAwareness],
  choiceEvaluator: gomokuChoiceEvaluator,
};

export { OPENING_BOOK, findWinnerFromLastMove, gomokuChoiceEvaluator, CHOICE_EVALUATOR_TIER };
