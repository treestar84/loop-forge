/**
 * gomoku-chain-evaluator — GAP-11 Phase 3-B B3 deep-design candidate
 * ("잠재 위협 티어", see scratchpad B3 spec, docs/GAP-ANALYSIS-11.md §5.5
 * Phase 2 follow-up questions). Re-expresses gomoku's existing 6-tier
 * `gomokuChoiceEvaluator` (../gomoku.ts, CHOICE_EVALUATOR_TIER: win 50 >
 * blockWin 40 > fork 30 > blockFork 25 > four 20 > openThree 15) verbatim at
 * the top, then adds a *latent*-threat layer strictly below `openThree` for
 * moves that clear none of the 6 discrete tiers:
 *
 *   - "자유 2연" (free two with room): a move that creates a run of exactly
 *     2 own stones with both immediate ends empty AND enough total empty/own
 *     space along the line (run + both sides' empty room) to still reach 5 —
 *     the geometric precursor to an open three, not just any pair of stones.
 *     +6 per such line.
 *   - "선행 교차점 보너스": when a move creates 2+ independent free-two
 *     lines at once (the pre-fork structure — this is what a fork tier move
 *     already *is* one move later), +4 for every line beyond the first.
 *   - "수비 미러": 0.8x the same free-two score computed for what the
 *     *opponent* would have gained by playing this exact cell instead —
 *     rewards double-purpose moves (build my structure + deny theirs) the
 *     same way `gomokuChoiceEvaluator`'s blockFork tier rewards denying an
 *     already-formed opponent fork, one step earlier in the threat's
 *     lifecycle.
 *   - The pre-existing "연결 확장" fallback (longest same-colour resulting
 *     line / 10, max 0.4 since a length-5 result is already caught by the
 *     win tier above) is kept as the lowest sub-tier, added on top of the
 *     latent score so a move with zero latent structure still resolves by
 *     the same "closer to a longer own line" tie-break `gomokuChoiceEvaluator`
 *     already uses.
 *
 * Design rationale (docs/GAP-ANALYSIS-11.md §5.5 Phase 2 record): prior
 * diagnostic w16 moved gomoku's L1 win rate 0%→34.5% but stayed flat 0% vs
 * L2 — the hypothesis this evaluator tests is that L2's edge is secured
 * *before* a fork actually forms (in the free-two/cross-point accumulation
 * stage), a stage the existing evaluator's discrete tiers cannot see because
 * they only recognize a fork once it already exists.
 *
 * Deliberately does NOT modify `gomokuChoiceEvaluator`/`gomokuForkDecision`/
 * any existing scoring path in `../gomoku.ts` — this is a new, additive
 * evaluator function meant to be supplied directly via `MctsConfig.priorEvaluator`
 * (search/mcts.ts), not wired into the adapter's own `choiceEvaluator` field,
 * so multiple evaluator variants (this one, the original) can coexist as
 * distinct candidates (see ../runners/shared/gomoku-mcts-flag.ts's
 * `gomokuMcts5ChainFlagSpecFor`).
 *
 * Layer: reference/experiments/ (game knowledge, no search/loop/kernel
 * imports beyond contract + the sibling ../gomoku module for types/tiers —
 * src/__tests__/dependency-rules.test.ts's allowed edges for this layer).
 * Self-contained board scanning (does not reach into ../gomoku.ts's
 * unexported helpers), matching the existing gomoku-opus-bot.ts/
 * gomoku-mid-bot.ts pattern in this directory.
 *
 * Known edge case (not hidden): the additive latent score
 * (freeTwoCount*6 + max(0,freeTwoCount-1)*4 + 0.8*same for the opponent) is
 * not capped, so a move that simultaneously creates several free-two lines
 * on both sides in a very dense position could in principle exceed
 * `CHOICE_EVALUATOR_TIER.openThree` (15) — e.g. 2 own free-two lines (6+6)
 * plus the cross-point bonus (+4) already reaches 16. This is geometrically
 * rare (it requires several already-open two-stone lines converging on one
 * empty cell, which the discrete tiers above would usually have already
 * caught as a fork/blockFork one move earlier) and is left uncapped rather
 * than adding an unrequested clamp not in the B3 design spec — the prior's
 * softmax weighting (search/mcts.ts) means an occasional tier overlap does
 * not change what the search does with the *ordering* of the vast majority
 * of moves, which is what this candidate's diagnostic value depends on.
 */

import type { PlayerId } from '../../contract/types';
import { CHOICE_EVALUATOR_TIER } from '../gomoku';
import type { Cell, GomokuMove, GomokuState } from '../gomoku';
import { BOARD_SIZE } from '../gomoku';

const DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

/** +6 per free-two line a move creates (this file's own doc comment). */
const FREE_TWO_BONUS = 6;
/** +4 for every free-two line beyond the first the same move creates simultaneously. */
const CROSSPOINT_BONUS = 4;
/** 0.8x weight applied to the opponent's own latent score for the same cell ("수비 미러"). */
const DEFENSE_MIRROR_WEIGHT = 0.8;

function indexOf(row: number, col: number): number {
  return row * BOARD_SIZE + col;
}

function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function playerToCell(player: PlayerId): Cell {
  return player === 0 ? 1 : 2;
}

function otherPlayer(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

interface LineInfo {
  /** Total consecutive same-colour run length through (row,col) once `moveCell` is placed there. */
  readonly length: number;
  readonly beforeOpen: boolean;
  readonly afterOpen: boolean;
  /** Consecutive empty cells immediately beyond the open "before" end (0 when that end isn't open). */
  readonly beforeRoom: number;
  /** Consecutive empty cells immediately beyond the open "after" end (0 when that end isn't open). */
  readonly afterRoom: number;
}

/**
 * Walks one axis through a hypothetical placement of `moveCell` at
 * (row,col) without allocating a trial board — `moveIdx` substitutes
 * `moveCell` for whatever is actually at that one index (always empty in
 * practice, since callers only ever evaluate legal/empty cells), everywhere
 * else reads through the real board untouched. Same no-copy technique as
 * `../gomoku.ts`'s `runInfoAt`, extended here to also report the empty
 * "room" beyond each open end (needed for the free-two-with-room check).
 */
function lineInfo(
  board: readonly Cell[],
  moveIdx: number,
  moveCell: Cell,
  row: number,
  col: number,
  cell: Cell,
  dr: number,
  dc: number,
): LineInfo {
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
  let afterRoom = 0;
  if (afterOpen) {
    let rr = r;
    let cc = c;
    while (inBounds(rr, cc) && at(rr, cc) === 0) {
      afterRoom += 1;
      rr += dr;
      cc += dc;
    }
  }

  let r2 = row - dr;
  let c2 = col - dc;
  while (inBounds(r2, c2) && at(r2, c2) === cell) {
    length += 1;
    r2 -= dr;
    c2 -= dc;
  }
  const beforeOpen = inBounds(r2, c2) && at(r2, c2) === 0;
  let beforeRoom = 0;
  if (beforeOpen) {
    let rr = r2;
    let cc = c2;
    while (inBounds(rr, cc) && at(rr, cc) === 0) {
      beforeRoom += 1;
      rr -= dr;
      cc -= dc;
    }
  }

  return { length, beforeOpen, afterOpen, beforeRoom, afterRoom };
}

/** True iff `info` describes a free two ("자유 2연", this file's own doc comment): exactly 2 in a row, both immediate ends open, and enough total room (run + both sides' empty stretch) to still reach 5. */
function isFreeTwo(info: LineInfo): boolean {
  return (
    info.length === 2 &&
    info.beforeOpen &&
    info.afterOpen &&
    info.length + info.beforeRoom + info.afterRoom >= 5
  );
}

interface DiscreteTierScan {
  readonly win: boolean;
  readonly bestTier: number;
  readonly forkThreats: number;
  readonly maxLength: number;
}

/** One pass over all 4 axes for `cell` placed at (row,col), computing everything `gomokuChoiceEvaluator`'s discrete tiers need (win / four / openThree / fork-threat count) plus the raw max run length for the "연결 확장" fallback. */
function scanDiscreteTiers(board: readonly Cell[], moveIdx: number, row: number, col: number, cell: Cell): DiscreteTierScan {
  let win = false;
  let bestTier = 0;
  let forkThreats = 0;
  let maxLength = 0;
  for (const [dr, dc] of DIRECTIONS) {
    const info = lineInfo(board, moveIdx, cell, row, col, cell, dr, dc);
    maxLength = Math.max(maxLength, info.length);
    if (info.length >= 5) {
      win = true;
      continue;
    }
    const openEnds = (info.beforeOpen ? 1 : 0) + (info.afterOpen ? 1 : 0);
    if (info.length === 4 && openEnds >= 1) {
      bestTier = Math.max(bestTier, CHOICE_EVALUATOR_TIER.four);
      forkThreats += 1;
    } else if (info.length === 3 && openEnds === 2) {
      bestTier = Math.max(bestTier, CHOICE_EVALUATOR_TIER.openThree);
      forkThreats += 1;
    }
  }
  return { win, bestTier, forkThreats, maxLength };
}

/** Latent free-two score for `cell` placed at (row,col): `FREE_TWO_BONUS` per free-two line created, plus `CROSSPOINT_BONUS` for every such line beyond the first (this file's own doc comment). */
function latentFreeTwoScore(board: readonly Cell[], moveIdx: number, row: number, col: number, cell: Cell): number {
  let freeTwoCount = 0;
  for (const [dr, dc] of DIRECTIONS) {
    const info = lineInfo(board, moveIdx, cell, row, col, cell, dr, dc);
    if (isFreeTwo(info)) {
      freeTwoCount += 1;
    }
  }
  if (freeTwoCount === 0) {
    return 0;
  }
  return freeTwoCount * FREE_TWO_BONUS + Math.max(0, freeTwoCount - 1) * CROSSPOINT_BONUS;
}

/**
 * Per-choice evaluator (search/mcts.ts's `MctsConfig.priorEvaluator` shape):
 * `gomokuChoiceEvaluator`'s 6 discrete tiers verbatim, then the latent
 * free-two/cross-point/defense-mirror layer below `openThree`, then the
 * pre-existing "연결 확장" fallback — see this file's own doc comment for
 * the full design.
 */
export function gomokuChainEvaluator(
  state: GomokuState,
  player: PlayerId,
  choices: readonly GomokuMove[],
): readonly number[] {
  const board = state.board;
  const selfCell = playerToCell(player);
  const opponentCell = playerToCell(otherPlayer(player));

  return choices.map((move) => {
    const moveIdx = indexOf(move.row, move.col);

    const self = scanDiscreteTiers(board, moveIdx, move.row, move.col, selfCell);
    if (self.win) {
      return CHOICE_EVALUATOR_TIER.win;
    }
    const opponent = scanDiscreteTiers(board, moveIdx, move.row, move.col, opponentCell);
    if (opponent.win) {
      return CHOICE_EVALUATOR_TIER.blockWin;
    }
    if (self.forkThreats >= 2) {
      return CHOICE_EVALUATOR_TIER.fork;
    }
    if (opponent.forkThreats >= 2) {
      return CHOICE_EVALUATOR_TIER.blockFork;
    }
    if (self.bestTier > 0) {
      return self.bestTier;
    }

    const ownLatent = latentFreeTwoScore(board, moveIdx, move.row, move.col, selfCell);
    const opponentLatent = latentFreeTwoScore(board, moveIdx, move.row, move.col, opponentCell);
    const latentScore = ownLatent + DEFENSE_MIRROR_WEIGHT * opponentLatent;

    // "연결 확장" fallback, same scale as gomokuChoiceEvaluator's own
    // (max 0.4 — self.maxLength never exceeds 4 here, a length-5 result
    // would already have matched the win check above).
    return latentScore + self.maxLength / 10;
  });
}
