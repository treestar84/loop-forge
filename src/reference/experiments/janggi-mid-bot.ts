/**
 * janggi-mid-bot — L1 anchor rung (docs/GAP-ANALYSIS-11.md D3/Phase 1-C,
 * scratchpad/janggi-gap11-onramp-design-spec.md step 2): an independent,
 * one-shot mid-skill design meant to sit strictly between
 * `janggiAdapter.baselines.heuristic` and the L2 anchor
 * (../experiments/janggi-opus-bot.ts) on the anchor ladder. Designed from
 * scratch by reading this game's adapter (../janggi.ts) only — NOT by reading
 * janggi-opus-bot.ts, per the repo convention (splendor-mid-bot.ts /
 * wingspan-mid-bot.ts's identical doc-comment rule).
 *
 * L1 grade — "sees one move further than the plain heuristic":
 * `janggiAdapter.baselines.heuristic` scores every legal move by
 * `captureValue*3 - exposureCost(own piece) + advance` with NO look at what
 * the opponent could do next turn beyond "is my destination attacked right
 * now" — it is a pure 0-ply evaluation. This bot keeps that same immediate
 * evaluation shape (capture value, safety, mild center/advance bonus) but
 * adds a genuine 1-ply opponent-reply anticipation on the top-K immediate
 * candidates: for each of the best few candidate moves, it simulates the
 * opponent's single best reply (by the SAME evaluation, mirrored to the
 * opponent's perspective) and subtracts that reply's value from the
 * candidate's own score. This is the "mid-skill" ceiling this bot is meant
 * to embody — a human novice (heuristic) reacts only to the current position;
 * a club-level player (this bot) also asks "and then what does my opponent
 * do to me?" for their best few options, without going further (no deeper
 * search, no multi-piece coordination, no long-term plans).
 *
 * Deliberately missing (the ceiling that keeps this below the L2 anchor):
 * no search beyond 1 ply, no evaluation of piece coordination/king safety
 * beyond "is this square attacked", no lookahead on any move outside the
 * top-K immediate candidates (a move that looks mediocre immediately but sets
 * up a strong follow-up is invisible to this bot), no positional planning
 * across multiple turns.
 *
 * Piece values used below are the standard real-world Janggi piece values
 * (public domain game knowledge, not read from janggi-opus-bot.ts or any
 * other file in this repo) — General excluded (never captured), Chariot 13,
 * Cannon 7, Horse 5, Guard 3, Elephant 3, Soldier 2.
 *
 * Layer: reference/experiments — imports only contract/kernel types plus
 * sibling ../janggi's exported types/constants/pure functions
 * (dependency-rules.test.ts's reference-layer edges). Randomness flows
 * through createRng(seed), used only for deterministic fallback tie-breaking
 * (C1 determinism rule).
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
  isPlayerInCheck,
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

const CENTER_COL = 4;
/** Only the best few immediate candidates get the (more expensive) 1-ply opponent-reply lookahead. */
const LOOKAHEAD_TOP_K = 3;
/**
 * Weight applied to the opponent's best 1-ply reply value when netting out a
 * candidate's score. Calibrated empirically (see this file's module doc):
 * the first cut (weight 0.8, TOP_K=6) measured at 46.0% win rate [39.0%,
 * 53.3%] against the L2 anchor — CI straddling 0.5, i.e. statistically
 * indistinguishable from L2 rather than clearly weaker, which fails this
 * ladder's Gate 2 requirement (L1 must LOSE to L2). Lowering both the
 * candidate breadth and the reply weight keeps the "sees one more move than
 * the plain heuristic" trait (still strictly more than heuristic's 0-ply
 * evaluation) while pulling the bot's overall strength back down toward the
 * "strictly between heuristic and L2" band the ladder requires.
 */
const OPPONENT_REPLY_WEIGHT = 0.3;

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

/**
 * Is `square` reachable by any of `attacker`'s legal moves on `board`? Uses
 * the adapter's own exported `legalMovesFor` (self-check-safe move
 * generation) rather than a from-scratch attack scanner — a slightly more
 * expensive but exactly-correct proxy for "the opponent could capture here
 * next turn with a real legal move."
 */
function squareReachableBy(board: readonly Cell[], attacker: PlayerId, square: number): boolean {
  return legalMovesFor(board, attacker).some((m) => m.to === square);
}

/**
 * 0-ply immediate evaluation of `move` from `mover`'s perspective — capture
 * value, safety of the destination after moving, a check bonus, and small
 * center-control / soldier-advance shaping terms. Mirrors the shape of
 * `janggiAdapter.baselines.heuristic`'s scoring (capture, risk, advance) but
 * is an independent re-derivation, not a copy (this bot's design brief
 * explicitly permits reading ../janggi.ts, just not janggi-opus-bot.ts).
 */
function immediateScore(board: readonly Cell[], mover: PlayerId, move: JanggiMove): number {
  const opponent = otherPlayer(mover);
  const captured = move.to === move.from ? 0 : (board[move.to] as Cell);
  const captureValue = captured === 0 ? 0 : (PIECE_VALUE[pieceType(captured)] as number);
  const next = applyMove(board, move);
  const movingType = pieceType(board[move.from] as Cell);
  const riskPenalty = squareReachableBy(next, opponent, move.to) ? (PIECE_VALUE[movingType] as number) : 0;
  const checkBonus = isPlayerInCheck(next, opponent) ? 4 : 0;
  const centerBonus =
    movingType === CHARIOT || movingType === CANNON || movingType === HORSE || movingType === ELEPHANT
      ? -Math.abs(colOf(move.to) - CENTER_COL) * 0.15
      : 0;
  const advanceBonus = movingType === SOLDIER ? (mover === 0 ? ROWS - 1 - rowOf(move.to) : rowOf(move.to)) * 0.4 : 0;
  return captureValue * 2.5 - riskPenalty + checkBonus + centerBonus + advanceBonus;
}

/** Best 0-ply immediate score `player` can achieve on `board` — used as the opponent's 1-ply reply value. */
function bestImmediateReplyValue(board: readonly Cell[], player: PlayerId): number {
  const replies = legalMovesFor(board, player);
  if (replies.length === 0) return 0;
  let best = -Infinity;
  for (const reply of replies) {
    const score = immediateScore(board, player, reply);
    if (score > best) best = score;
  }
  return best;
}

const janggiMidBot: BotFactory<JanggiObservation, JanggiChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'janggi-mid-l1',
    decide(_decisionPoint, observation, legal) {
      const board = observation.board;
      const self = observation.self;
      const opponent = otherPlayer(self);

      const scored = legal
        .map((move) => ({ move, immediate: immediateScore(board, self, move) }))
        .sort((a, b) => b.immediate - a.immediate);

      const topK = scored.slice(0, Math.min(LOOKAHEAD_TOP_K, scored.length));
      let bestNet = -Infinity;
      let candidates: JanggiMove[] = [];
      for (const { move, immediate } of topK) {
        const next = applyMove(board, move);
        // If the move ends the game (opponent has no legal reply — checkmate
        // or stalemate-equivalent loss for them), there is no reply to
        // anticipate; treat the opponent's reply value as 0 (pure win, no
        // penalty), which naturally makes such moves dominate.
        const opponentReply = bestImmediateReplyValue(next, opponent);
        const net = immediate - OPPONENT_REPLY_WEIGHT * opponentReply;
        if (net > bestNet) {
          bestNet = net;
          candidates = [move];
        } else if (net === bestNet) {
          candidates.push(move);
        }
      }

      if (candidates.length === 1) {
        return candidates[0] as JanggiChoice;
      }
      if (candidates.length === 0) {
        // Unreachable in practice (topK is always non-empty when legal is
        // non-empty), but keep a safe deterministic fallback.
        return scored[0]!.move as JanggiChoice;
      }
      const sorted = [...candidates].sort((a, b) => (encodeMove(a) < encodeMove(b) ? -1 : 1));
      return sorted[rng.nextInt(sorted.length)] as JanggiChoice;
    },
  };
};

export { janggiMidBot };
