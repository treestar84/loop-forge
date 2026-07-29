/**
 * gomoku-defensive-evaluator — GAP-11 Phase 3-B B4 candidate ("신규 탐험":
 * an axis matrix axis (docs/GAP-ANALYSIS-11.md §3 D6) none of A1-A10 covers —
 * asymmetric offense/defense weighting in the tree prior. Own design (not
 * part of the B3 deep-design spec the main loop wrote for
 * gomoku-chain-evaluator.ts), following the design brief's own B4 example
 * ("수비 우선 스타일 — 상대 잠재 위협 억제 최우선").
 *
 * Every prior candidate tried so far (Phase 2's `mcts4-s256-prior-w*`, this
 * round's B1 mechanical sweep, B3's chain evaluator) weights the deciding
 * player's own offense at least as heavily as denying the opponent's — even
 * `gomoku-chain-evaluator.ts`'s "수비 미러" only discounts the opponent's
 * latent score by 0.8x relative to the player's own 1.0x. This evaluator
 * inverts that relationship on both the discrete and latent tiers:
 *
 *   - Discrete tiers: `blockFork` now outranks `fork` (denying the
 *     opponent's already-formed fork is prioritized over building one's own
 *     fork) and two new tiers, `blockFour`/`blockOpenThree`, sit just above
 *     their offense counterparts `four`/`openThree` — this evaluator is the
 *     first to score "the opponent is about to get a four/open-three" as its
 *     own priority band rather than leaving it to `blockFork`/`blockWin`
 *     alone to catch.
 *   - Latent tier: the opponent's latent free-two score is weighted 1.2x
 *     (dominant) against the player's own 0.5x (subordinate) — the exact
 *     inverse of `gomoku-chain-evaluator.ts`'s 1.0x self / 0.8x opponent
 *     ratio, per this round's "억제 최우선" design brief.
 *
 * Shares `gomoku-chain-evaluator.ts`'s line-scanning primitives conceptually
 * but is kept as its own self-contained file (not a shared import) — the
 * same reference/experiments/ convention gomoku-opus-bot.ts and
 * gomoku-mid-bot.ts already follow, and it keeps this file's tier constants
 * independent of B3's `CHOICE_EVALUATOR_TIER`-derived ones so a future
 * change to one design does not silently perturb the other.
 *
 * Meant to be supplied via `MctsConfig.priorEvaluator` (search/mcts.ts),
 * exactly like `gomokuChainEvaluator` — see
 * ../runners/shared/gomoku-mcts-flag.ts's B4 flag spec.
 */

import type { PlayerId } from '../../contract/types';
import type { Cell, GomokuMove, GomokuState } from '../gomoku';
import { BOARD_SIZE } from '../gomoku';

const DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

/** Defense-first tier bands (this file's own doc comment) — independent of gomoku.ts's/gomoku-chain-evaluator.ts's CHOICE_EVALUATOR_TIER. */
const DEFENSIVE_TIER = {
  win: 50,
  blockWin: 45,
  blockFork: 40,
  fork: 35,
  blockFour: 30,
  four: 25,
  blockOpenThree: 20,
  openThree: 15,
} as const;

/** Own-offense latent weight — subordinate to the opponent-denial weight below (inverted from gomoku-chain-evaluator.ts's 1.0x/0.8x). */
const OWN_LATENT_WEIGHT = 0.5;
/** Opponent-denial latent weight — dominant, per this file's "억제 최우선" design. */
const DENY_LATENT_WEIGHT = 1.2;
const FREE_TWO_BONUS = 6;
const CROSSPOINT_BONUS = 4;

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
  readonly length: number;
  readonly beforeOpen: boolean;
  readonly afterOpen: boolean;
  readonly beforeRoom: number;
  readonly afterRoom: number;
}

/** Same no-trial-board-copy scan as gomoku-chain-evaluator.ts's `lineInfo` (see that file's doc comment) — duplicated here to keep this file self-contained per the reference/experiments/ convention. */
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

function isFreeTwo(info: LineInfo): boolean {
  return (
    info.length === 2 &&
    info.beforeOpen &&
    info.afterOpen &&
    info.length + info.beforeRoom + info.afterRoom >= 5
  );
}

interface DiscreteScan {
  readonly win: boolean;
  readonly fourTier: number; // DEFENSIVE_TIER.four when a live four exists, else 0
  readonly openThreeTier: number; // DEFENSIVE_TIER.openThree when an open three exists, else 0
  readonly forkThreats: number;
  readonly maxLength: number;
}

function scanDiscreteTiers(board: readonly Cell[], moveIdx: number, row: number, col: number, cell: Cell): DiscreteScan {
  let win = false;
  let fourTier = 0;
  let openThreeTier = 0;
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
      fourTier = DEFENSIVE_TIER.four;
      forkThreats += 1;
    } else if (info.length === 3 && openEnds === 2) {
      openThreeTier = DEFENSIVE_TIER.openThree;
      forkThreats += 1;
    }
  }
  return { win, fourTier, openThreeTier, forkThreats, maxLength };
}

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
 * Defense-first per-choice evaluator (search/mcts.ts's `MctsConfig.priorEvaluator`
 * shape) — see this file's own doc comment for the full tier design.
 */
export function gomokuDefensiveEvaluator(
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
      return DEFENSIVE_TIER.win;
    }
    const opponent = scanDiscreteTiers(board, moveIdx, move.row, move.col, opponentCell);
    if (opponent.win) {
      return DEFENSIVE_TIER.blockWin;
    }
    // Defense-first: blockFork outranks fork (inverted from the offense-led evaluators).
    if (opponent.forkThreats >= 2) {
      return DEFENSIVE_TIER.blockFork;
    }
    if (self.forkThreats >= 2) {
      return DEFENSIVE_TIER.fork;
    }
    if (opponent.fourTier > 0) {
      return DEFENSIVE_TIER.blockFour;
    }
    if (self.fourTier > 0) {
      return DEFENSIVE_TIER.four;
    }
    if (opponent.openThreeTier > 0) {
      return DEFENSIVE_TIER.blockOpenThree;
    }
    if (self.openThreeTier > 0) {
      return DEFENSIVE_TIER.openThree;
    }

    const ownLatent = latentFreeTwoScore(board, moveIdx, move.row, move.col, selfCell);
    const denyLatent = latentFreeTwoScore(board, moveIdx, move.row, move.col, opponentCell);
    const latentScore = OWN_LATENT_WEIGHT * ownLatent + DENY_LATENT_WEIGHT * denyLatent;

    return latentScore + self.maxLength / 10;
  });
}
