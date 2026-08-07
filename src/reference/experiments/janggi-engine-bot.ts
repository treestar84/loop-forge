/**
 * janggi-engine-bot — L3 holdout anchor ('janggi-engine-l3').
 *
 * Designed WITHOUT reading ../experiments/janggi-opus-bot.ts (the L2 anchor
 * this bot must remain independent from) — its logic below was derived
 * solely from ../janggi.ts (the GameAdapter: rules, types, baselines) plus
 * ../experiments/janggi-mid-bot.ts (the L1 sibling for this same game),
 * consulted purely as a STRUCTURAL/STYLE template (BotFactory shape,
 * imports, how it calls legalMovesFor/applyMove/isPlayerInCheck, doc-comment
 * conventions, determinism via createRng) — none of its 1-ply-lookahead
 * evaluation philosophy is reused here. This is the same convention
 * wingspan-engine-bot.ts and splendor-engine-bot.ts document for their own
 * L2 files.
 *
 * Philosophy — "수비 우선(안전 기물 교환만) + 궁 방어 최우선 + 병사 조직적
 * 전진" ("defense-first: only safe piece trades, general/king safety is the
 * overriding priority, organized/coordinated soldier advance"). This is
 * deliberately NOT a "score every move by material + lookahead" evaluation
 * (that shape is what the L1 sibling already does) — it is a rule-based
 * decision CASCADE with no search and no opponent-reply simulation at all:
 *
 *   1. General safety first. `legalMovesFor` already filters out any move
 *      that would leave the bot's own general in check or facing the
 *      opponent's general, so every candidate here is already
 *      "self-check-safe" — that part is automatic and needs no extra code.
 *      On top of that floor, this bot scores each candidate by how many
 *      enemy pieces could reach a square adjacent to/inside its OWN palace
 *      after the move (fewer is better) and rewards keeping a Guard/General
 *      piece defending the palace. When the bot is currently in check, every
 *      legal move is already a check-escape (that's what "legal" means in
 *      that position), so this bot does nothing special for check beyond
 *      relying on legality — it never needs to override a "safe trade"
 *      preference with an "escape check" rule because there are no
 *      non-escaping legal moves to prefer in the first place.
 *   2. Only actively seeks "safe" trades: a capture is a candidate for
 *      "take it" only if, after capturing, the destination square is either
 *      unattackable by the opponent, OR attackable but the captured piece's
 *      value >= the capturing piece's value (a genuinely safe or favorable
 *      trade). This is a direct rule-based classification (one
 *      attacked-square check via `legalMovesFor`, no simulated opponent best
 *      reply, no search) — a different reasoning SHAPE than L1's
 *      lookahead-and-subtract, not just a different weight vector.
 *   3. Never voluntarily walks a piece into an attacked square unless (2)
 *      classifies it as a safe/favorable trade, or unless every legal move
 *      does so (forced) — the defense-first bias: this bot prefers passing
 *      up a minor positional gain over increasing its own exposed-piece
 *      count.
 *   4. Organized soldier advance: when no capture/defense/exposure concern
 *      applies, prefer advancing the LEAST-advanced Soldier (the
 *      "straggler") over a soldier that has already outpaced its
 *      neighbors — keeping the soldier line even rather than rushing one
 *      soldier ahead alone. This is a genuinely different axis from L1's
 *      "take the single highest immediate score" — there is no per-move
 *      score being maximized here, just a group-coordination rule.
 *   5. Fallback: deterministic lowest-encoded `${from}-${to}` key among
 *      whatever's left, tie-broken only by the bot's seeded RNG for genuine
 *      ties (C1 determinism — never Date.now()/Math.random()).
 *
 * Piece values used below are the standard real-world Janggi piece values
 * (public domain game knowledge, not read from janggi-opus-bot.ts or any
 * other file in this repo) — General excluded (never captured), Chariot 13,
 * Cannon 7, Horse 5, Guard 3, Elephant 3, Soldier 2.
 *
 * Layer: reference/experiments — imports only contract/kernel types plus
 * sibling ../janggi's exported types/constants/pure functions
 * (dependency-rules.test.ts's reference-layer edges). Randomness flows
 * through createRng(seed), used only for deterministic tie-breaking among
 * true ties (C1 determinism rule) — no Date.now()/Math.random() anywhere.
 */

import type { BotFactory, PlayerId } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import {
  CANNON,
  CHARIOT,
  COLS,
  ELEPHANT,
  GENERAL,
  GUARD,
  HORSE,
  ROWS,
  SOLDIER,
  applyMove,
  legalMovesFor,
  type Cell,
  type JanggiChoice,
  type JanggiMove,
  type JanggiObservation,
} from '../janggi';

const PIECE_VALUE: Readonly<Record<number, number>> = {
  [GENERAL]: 0, // never captured — excluded from material scoring
  [GUARD]: 3,
  [CHARIOT]: 13,
  [CANNON]: 7,
  [HORSE]: 5,
  [ELEPHANT]: 3,
  [SOLDIER]: 2,
};

function otherPlayer(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

function rowOf(i: number): number {
  return Math.floor(i / COLS);
}

function colOf(i: number): number {
  return i % COLS;
}

function pieceType(cell: Cell): number {
  return Math.abs(cell);
}

function encodeMove(move: JanggiMove): string {
  return `${move.from}-${move.to}`;
}

/** Palace squares for `player` — the 3x3 block their General/Guards defend. */
function palaceSquares(player: PlayerId): readonly number[] {
  const rowMin = player === 0 ? 7 : 0;
  const squares: number[] = [];
  for (let r = rowMin; r < rowMin + 3; r += 1) {
    for (let c = 3; c <= 5; c += 1) {
      squares.push(r * COLS + c);
    }
  }
  return squares;
}

/**
 * Is `square` reachable by any of `attacker`'s legal moves on `board`? Uses
 * the adapter's own exported `legalMovesFor` (self-check-safe move
 * generation) as an exactly-correct proxy for "the opponent could reach here
 * next turn with a real legal move" — no from-scratch attack scanner needed.
 */
function squareReachableBy(board: readonly Cell[], attacker: PlayerId, square: number): boolean {
  return legalMovesFor(board, attacker).some((m) => m.to === square);
}

/**
 * Count of `attacker`'s legal moves landing on any of `player`'s palace
 * squares — the "how exposed is my palace" metric rule 1 wants to minimize.
 * Cheap and direct (one legalMovesFor pass, one filter), not a search.
 */
function palaceThreatCount(board: readonly Cell[], player: PlayerId, attacker: PlayerId): number {
  const palace = new Set(palaceSquares(player));
  let count = 0;
  for (const move of legalMovesFor(board, attacker)) {
    if (palace.has(move.to)) count += 1;
  }
  return count;
}

/** Does `player` still have a Guard or General occupying their own palace after the move? */
function hasPalaceDefender(board: readonly Cell[], player: PlayerId): boolean {
  for (const square of palaceSquares(player)) {
    const cell = board[square] as Cell;
    if (cell === 0) continue;
    if (cell > 0 !== (player === 0)) continue;
    const type = pieceType(cell);
    if (type === GENERAL || type === GUARD) return true;
  }
  return false;
}

/**
 * Rule (2)/(3): is this move a "safe or favorable" trade/advance? A capture
 * is safe if the destination becomes unattackable, or if it's attackable but
 * the captured piece's value >= the capturing piece's value. A non-capture
 * is "safe" in the same sense if the moved piece's destination is not left
 * attackable at all. Purely a direct classification — no opponent-reply
 * simulation, no search (that's what keeps this bot's reasoning SHAPE
 * different from the L1 sibling's lookahead).
 */
function isSafeOrFavorable(board: readonly Cell[], self: PlayerId, move: JanggiMove): boolean {
  const opponent = otherPlayer(self);
  const captured = move.to === move.from ? 0 : (board[move.to] as Cell);
  const capturedValue = captured === 0 ? 0 : (PIECE_VALUE[pieceType(captured)] as number);
  const movingType = pieceType(board[move.from] as Cell);
  const movingValue = PIECE_VALUE[movingType] as number;
  const next = applyMove(board, move);
  const attackedAfter = squareReachableBy(next, opponent, move.to);
  if (!attackedAfter) return true;
  return capturedValue >= movingValue;
}

/** Is `move` an active capture (destination holds an opposing piece)? */
function isCapture(board: readonly Cell[], move: JanggiMove): boolean {
  if (move.to === move.from) return false;
  return (board[move.to] as Cell) !== 0;
}

/**
 * Rule (1) palace-safety score for a candidate move (lower is better): after
 * the move, how many enemy legal moves land on/in the bot's own palace,
 * minus a small bonus for still keeping a Guard/General defending it. Used
 * only to rank among moves that already passed the safe-trade/exposure
 * filters (rules 2/3) — this is a tie-break/refinement layer, not a
 * lookahead search.
 */
function palaceSafetyScore(board: readonly Cell[], self: PlayerId, move: JanggiMove): number {
  const opponent = otherPlayer(self);
  const next = applyMove(board, move);
  const threats = palaceThreatCount(next, self, opponent);
  const defended = hasPalaceDefender(next, self) ? 1 : 0;
  return threats * 2 - defended;
}

/** Rule (4): how "advanced" a Soldier at `square` is toward the enemy back rank (higher = further advanced). */
function soldierAdvancement(self: PlayerId, square: number): number {
  return self === 0 ? ROWS - 1 - rowOf(square) : rowOf(square);
}

const janggiEngineBot: BotFactory<JanggiObservation, JanggiChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'janggi-engine-l3',
    decide(_decisionPoint, observation, legal) {
      const board = observation.board;
      const self = observation.self;

      // Rule (2)/(3): among legal moves, split into "safe or favorable"
      // (captures worth taking, or any move that doesn't newly expose the
      // moved piece) vs. "exposes a piece for no compensating gain". Prefer
      // the safe/favorable set unless it's empty (forced exposure).
      const safeMoves = legal.filter((move) => isSafeOrFavorable(board, self, move));
      const pool = safeMoves.length > 0 ? safeMoves : legal;

      // Within the safe/favorable pool, actively seek genuine captures
      // first (rule 2's "actively sought" trades) — ranked by captured
      // piece value, highest first, ties broken by best palace-safety score.
      const safeCaptures = pool.filter((move) => isCapture(board, move));
      if (safeCaptures.length > 0) {
        let bestValue = -Infinity;
        let bestSafety = Infinity;
        let candidates: JanggiMove[] = [];
        for (const move of safeCaptures) {
          const captured = board[move.to] as Cell;
          const value = PIECE_VALUE[pieceType(captured)] as number;
          const safety = palaceSafetyScore(board, self, move);
          if (value > bestValue || (value === bestValue && safety < bestSafety)) {
            bestValue = value;
            bestSafety = safety;
            candidates = [move];
          } else if (value === bestValue && safety === bestSafety) {
            candidates.push(move);
          }
        }
        return pickDeterministic(candidates, rng);
      }

      // Rule (1): among the remaining safe (non-capture) pool, prefer moves
      // that most reduce enemy reach into the bot's own palace / keep it
      // defended. Only apply this as a preference filter (top palace-safety
      // score), not as the sole criterion, since rule (4) still needs a say
      // when palace safety is already flat across candidates.
      let bestSafety = Infinity;
      for (const move of pool) {
        const safety = palaceSafetyScore(board, self, move);
        if (safety < bestSafety) bestSafety = safety;
      }
      const safestPool = pool.filter((move) => palaceSafetyScore(board, self, move) === bestSafety);

      // Rule (4): organized soldier advance — prefer moving the LEAST
      // advanced soldier among safestPool's soldier moves (keep the line
      // even), rather than the single highest-scoring move.
      const soldierMoves = safestPool.filter((move) => pieceType(board[move.from] as Cell) === SOLDIER);
      if (soldierMoves.length > 0) {
        let leastAdvanced = Infinity;
        let candidates: JanggiMove[] = [];
        for (const move of soldierMoves) {
          const advancement = soldierAdvancement(self, move.from);
          if (advancement < leastAdvanced) {
            leastAdvanced = advancement;
            candidates = [move];
          } else if (advancement === leastAdvanced) {
            candidates.push(move);
          }
        }
        return pickDeterministic(candidates, rng);
      }

      // Rule (5): deterministic fallback — lowest encoded key among the
      // safest pool (or the forced pool if that's all there was), tie-broken
      // by the seeded RNG only for genuine ties.
      return pickDeterministic(safestPool.length > 0 ? safestPool : pool, rng);
    },
  };
};

/** Deterministic pick: lowest encoded `${from}-${to}` key wins; RNG only breaks true ties. */
function pickDeterministic(moves: readonly JanggiMove[], rng: { nextInt(bound: number): number }): JanggiChoice {
  if (moves.length === 1) return moves[0] as JanggiChoice;
  const sorted = [...moves].sort((a, b) => (encodeMove(a) < encodeMove(b) ? -1 : 1));
  return sorted[rng.nextInt(sorted.length)] as JanggiChoice;
}

export { janggiEngineBot };
