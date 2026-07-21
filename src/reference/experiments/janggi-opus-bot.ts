/**
 * janggi-opus-bot — a one-shot "just ask the LLM to design a good bot" entry
 * for the 3-column benchmark experiment (docs/BENCHMARK-EXPERIMENT.md, column
 * A/C). This is DELIBERATELY NOT a Loop Forge pipeline artifact: it was
 * designed in a single pass from the rules of Janggi, and is never tuned by
 * scoreAdapter / waves / gates. It is the "unaided Opus" control the
 * experiment measures Loop Forge against.
 *
 * Why it should beat `janggiAdapter.baselines.heuristic`: the baseline is a
 * pure 1-ply scorer — it weighs a capture against a single crude "is my
 * landing square attacked?" exposure flag. This bot instead:
 *   1. Prunes to a beam of the most promising moves by a cheap 1-ply score
 *      (capture value + light position + gives-check), then
 *   2. Evaluates that beam with a real 2-ply material minimax-lite: apply the
 *      move, look at the opponent's actual legal replies, and subtract the
 *      opponent's best immediate capture (true recapture/hang detection via
 *      the adapter's own legality, not a geometric approximation), and
 *   3. Detects forced mate/stalemate (opponent left with zero legal moves is
 *      a loss in Janggi) and scores it as winning.
 * Ties are broken by the bot's own seeded RNG so two of these bots do not lock
 * into an infinite shuffle (the same degenerate-repetition concern the
 * baseline's own comment calls out).
 *
 * Layer note: this file lives under `reference/` so it may import only from
 * `contract`, `kernel`, and other `reference` files. All randomness flows
 * through `createRng` (kernel) — no Date.now()/Math.random() (C1 determinism
 * rule, enforced by src/__tests__/dependency-rules.test.ts).
 */

import type { BotFactory } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import {
  CHARIOT,
  CANNON,
  HORSE,
  ELEPHANT,
  GUARD,
  SOLDIER,
  GENERAL,
  ROWS,
  COLS,
  applyMove,
  isPlayerInCheck,
  legalMovesFor,
  type JanggiObservation,
  type JanggiChoice,
  type JanggiMove,
  type Cell,
} from '../janggi';

/** Material values (points). Chariot dominant, then Cannon/Horse, minor pieces. */
const VALUE: Readonly<Record<number, number>> = {
  [GENERAL]: 1000,
  [CHARIOT]: 13,
  [CANNON]: 7,
  [HORSE]: 5,
  [ELEPHANT]: 3,
  [GUARD]: 3,
  [SOLDIER]: 2,
};

const BEAM = 10; // how many top cheap-scored moves get the (costlier) 2-ply eval
const CHECK_BONUS = 2; // non-mating check: forcing, worth a minor-piece nudge
const MATE_SCORE = 1_000_000;
const ADVANCE_WEIGHT = 0.3;
const CENTER_WEIGHT = 0.1;
const GENERAL_WANDER_PENALTY = 0.5;

function typeOf(cell: Cell): number {
  return Math.abs(cell);
}

function ownerOf(cell: Cell): number | null {
  if (cell === 0) return null;
  return cell > 0 ? 0 : 1;
}

function rowOf(i: number): number {
  return Math.floor(i / COLS);
}

function colOf(i: number): number {
  return i % COLS;
}

function valueOf(cell: Cell): number {
  return cell === 0 ? 0 : (VALUE[typeOf(cell)] ?? 0);
}

/** Positional term: forward progress + center pull, minus needless general wandering. */
function positional(observation: JanggiObservation, move: JanggiMove, inCheck: boolean): number {
  const self = observation.self;
  const to = move.to;
  const advance = self === 0 ? ROWS - 1 - rowOf(to) : rowOf(to);
  const center = 4 - Math.abs(4 - colOf(to));
  let score = advance * ADVANCE_WEIGHT + center * CENTER_WEIGHT;
  const movingType = typeOf(observation.board[move.from] as Cell);
  // Shuffling the general around for no reason weakens the palace; only tolerate
  // it when actually in check (where it may be the only escape).
  if (movingType === GENERAL && !inCheck && move.from !== move.to) {
    score -= GENERAL_WANDER_PENALTY;
  }
  return score;
}

/** Cheap 1-ply score used only to pick the beam. */
function cheapScore(
  observation: JanggiObservation,
  move: JanggiMove,
  opponent: number,
  inCheck: boolean,
): number {
  const board = observation.board;
  const captured = move.to === move.from ? 0 : (board[move.to] as Cell);
  let score = valueOf(captured);
  const next = applyMove(board, move);
  if (isPlayerInCheck(next, opponent)) score += CHECK_BONUS;
  return score + positional(observation, move, inCheck);
}

/**
 * Full 2-ply material eval for a single candidate: my capture, minus the
 * opponent's best immediate reply-capture, with forced-mate/stalemate scored
 * as a win. Uses the adapter's own legalMovesFor so the opponent's "best grab"
 * respects pins and self-check (a hanging-looking piece defended by a pin is
 * correctly not counted).
 */
function deepScore(
  observation: JanggiObservation,
  move: JanggiMove,
  self: number,
  opponent: number,
  inCheck: boolean,
): number {
  const board = observation.board;
  const myCapture = move.to === move.from ? 0 : valueOf(board[move.to] as Cell);
  const next = applyMove(board, move);
  const givesCheck = isPlayerInCheck(next, opponent);

  const oppMoves = legalMovesFor(next, opponent);
  if (oppMoves.length === 0) {
    // Opponent to move with no legal move loses in Janggi (checkmate or
    // stalemate alike) — a forced win regardless of the material line.
    return MATE_SCORE;
  }

  let oppBestGrab = 0;
  for (const reply of oppMoves) {
    if (reply.to === reply.from) continue;
    const target = next[reply.to] as Cell;
    if (target === 0 || ownerOf(target) !== self) continue;
    const v = valueOf(target);
    if (v > oppBestGrab) oppBestGrab = v;
  }

  let score = myCapture - oppBestGrab;
  if (givesCheck) score += CHECK_BONUS;
  return score + positional(observation, move, inCheck);
}

/**
 * The one-shot Opus bot factory. Deterministic given `seed`.
 */
export const janggiOpusBot: BotFactory<JanggiObservation, JanggiChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'janggi-opus',
    decide(_decisionPoint, observation, legal) {
      const self = observation.self;
      const opponent = self === 0 ? 1 : 0;
      const inCheck = isPlayerInCheck(observation.board, self);

      // Beam: rank all legal moves by the cheap score, keep the top BEAM.
      const ranked = legal.map((move) => ({
        move,
        cheap: cheapScore(observation, move as JanggiMove, opponent, inCheck),
      }));
      ranked.sort((a, b) => b.cheap - a.cheap);
      const beam = ranked.slice(0, Math.min(BEAM, ranked.length));

      // Evaluate the beam with the full 2-ply score; pick the best, RNG tie-break.
      let bestScore = -Infinity;
      let candidates: JanggiChoice[] = [];
      for (const { move } of beam) {
        const score = deepScore(observation, move as JanggiMove, self, opponent, inCheck);
        if (score > bestScore) {
          bestScore = score;
          candidates = [move];
        } else if (score === bestScore) {
          candidates.push(move);
        }
      }
      return candidates[rng.nextInt(candidates.length)] as JanggiChoice;
    },
  };
};
