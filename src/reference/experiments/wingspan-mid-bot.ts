/**
 * wingspan-mid-bot — L1 anchor rung (docs/GAP-ANALYSIS-11.md D3/Phase 1-C,
 * scratchpad/wingspan-gap11-onramp-design-spec.md): an independent, one-shot
 * mid-skill design meant to sit strictly between `baselines.heuristic` and
 * the L2 anchor (../experiments/wingspan-opus-bot.ts) on the anchor ladder.
 * Designed from scratch by reading this game's adapter (../wingspan.ts) —
 * NOT by reading wingspan-opus-bot.ts, per the task brief's "no logic copy"
 * rule (mirrors dominion-mid-bot.ts / gomoku-mid-bot.ts / hearthstone-mid-bot.ts
 * / splendor-mid-bot.ts's identical doc-comment convention).
 *
 * The 20-bird stat table is transcribed inline from `BIRD_DEFS` in
 * ../wingspan.ts (not imported), same rationale as
 * wingspan-opus-bot.ts's file header: this bot stays conceptually decoupled
 * from the adapter it is being measured against.
 *
 * L1 grade — "plays for raw points and roughly tracks affordability, no
 * multi-turn investment planning":
 *   1. If any `playBird` choice is legal, play the highest RAW-points
 *      affordable bird (not points-per-food efficiency, unlike
 *      `baselines.heuristic` — a mid-skill player has learned "cash in the
 *      biggest score now" over "be efficient"). Ties broken by lower food
 *      cost (frees more food sooner), then bird id.
 *   2. Otherwise, if the board still has space and a tray bird is both
 *      already affordable (cost <= current food) AND worth playing
 *      (points > 0), draw it — unlike `baselines.heuristic`, which draws the
 *      highest-point tray bird regardless of whether it can ever be
 *      afforded. This is the one deliberate improvement over the adapter's
 *      own heuristic baseline.
 *   3. Otherwise, if food is scarce (< 2) and the board has space, gainFood
 *      to build toward being able to play something.
 *   4. Otherwise, if there is a blind deck draw available and the board has
 *      space, drawDeck (early/mid slack draw — no horizon-turns-remaining
 *      accounting at all, unlike L2's explicit `turnsRemaining` math).
 *   5. Fallback: gainFood.
 * Deliberately missing (the ceiling that keeps this below the L2 anchor):
 * no "invest food now toward an expensive held bird" reasoning, no
 * turns-remaining horizon awareness anywhere, no stopping draws once the
 * game is nearly over, no board-full early exit beyond what "no legal play"
 * already yields naturally at step 5.
 *
 * Layer: reference/ — imports only contract/kernel types plus sibling
 * ../wingspan for its exported observation/choice types
 * (dependency-rules.test.ts's reference-layer edges). Randomness flows
 * through createRng(seed), used only for a deterministic last-resort
 * tiebreak (C1 determinism rule) — it should never actually fire since
 * gainFood is always legal (../wingspan.ts's file header).
 */

import type { BotFactory } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import type { WingspanChoice, WingspanObservation } from '../wingspan';

// Transcribed from BIRD_DEFS in ../wingspan.ts (the 20-bird "wingspan-core"
// subset). id -> [points, foodCost].
const BIRD_STATS: Readonly<Record<string, { readonly points: number; readonly foodCost: number }>> = {
  'turkey-vulture': { points: 1, foodCost: 0 },
  'california-condor': { points: 1, foodCost: 0 },
  'black-vulture': { points: 2, foodCost: 0 },
  'mourning-dove': { points: 0, foodCost: 1 },
  'house-wren': { points: 1, foodCost: 1 },
  'purple-martin': { points: 2, foodCost: 1 },
  'american-crow': { points: 4, foodCost: 1 },
  'northern-harrier': { points: 3, foodCost: 1 },
  'american-robin': { points: 1, foodCost: 2 },
  'carolina-wren': { points: 1, foodCost: 2 },
  killdeer: { points: 1, foodCost: 2 },
  mallard: { points: 0, foodCost: 2 },
  bushtit: { points: 2, foodCost: 2 },
  'american-goldfinch': { points: 3, foodCost: 2 },
  'blue-jay': { points: 3, foodCost: 2 },
  'red-tailed-hawk': { points: 5, foodCost: 2 },
  'great-blue-heron': { points: 5, foodCost: 2 },
  'song-sparrow': { points: 0, foodCost: 3 },
  'american-woodcock': { points: 9, foodCost: 3 },
  'bald-eagle': { points: 9, foodCost: 3 },
};

function pointsOf(id: string): number {
  return BIRD_STATS[id]?.points ?? 0;
}

function costOf(id: string): number {
  return BIRD_STATS[id]?.foodCost ?? 0;
}

// Highest raw points first, then cheaper (frees food sooner), then id for a
// stable final tiebreak.
function betterBird(a: string, b: string): number {
  const dp = pointsOf(b) - pointsOf(a);
  if (dp !== 0) return dp;
  const dc = costOf(a) - costOf(b);
  if (dc !== 0) return dc;
  return a < b ? -1 : a > b ? 1 : 0;
}

const BOARD_CAPACITY = 5;
const LOW_FOOD_THRESHOLD = 2;

export const wingspanMidBot: BotFactory<WingspanObservation, WingspanChoice> = (seed) => {
  // rng honours the BotFactory contract; used only as an unreachable-in-
  // practice last-resort tiebreak (gainFood is always legal per
  // ../wingspan.ts's file header). All primary decisions are deterministic.
  const rng = createRng(seed);

  return {
    id: 'wingspan-mid',
    decide(_decisionPoint: string, observation: WingspanObservation, legal: readonly WingspanChoice[]): WingspanChoice {
      const selfFood = observation.food[0];
      const selfBoard = observation.boards[0];
      const space = BOARD_CAPACITY - selfBoard.length;

      const plays = legal.filter(
        (c): c is Extract<WingspanChoice, { kind: 'playBird' }> => c.kind === 'playBird',
      );
      const trayDraws = legal.filter(
        (c): c is Extract<WingspanChoice, { kind: 'drawTray' }> => c.kind === 'drawTray',
      );
      const deckDraw = legal.find((c) => c.kind === 'drawDeck');
      const gainFood = legal.find((c) => c.kind === 'gainFood');

      // 1) Play the highest raw-points affordable bird.
      if (plays.length > 0) {
        const sorted = [...plays].sort((a, b) => betterBird(a.cardId, b.cardId));
        return sorted[0] as WingspanChoice;
      }

      // 2) Draw a tray bird that is already affordable AND worth playing.
      if (space >= 1 && trayDraws.length > 0) {
        const realizable = trayDraws
          .filter((c) => costOf(c.cardId) <= selfFood && pointsOf(c.cardId) > 0)
          .sort((a, b) => betterBird(a.cardId, b.cardId));
        if (realizable.length > 0) {
          return realizable[0] as WingspanChoice;
        }
      }

      // 3) Scarce food: bank toward being able to play something.
      if (selfFood < LOW_FOOD_THRESHOLD && space >= 1 && gainFood) {
        return gainFood;
      }

      // 4) Slack draw from the deck — no horizon accounting.
      if (deckDraw && space >= 1) {
        return deckDraw;
      }

      // 5) Fallback: bank food.
      if (gainFood) return gainFood;

      // Absolute last resort (should be unreachable — gainFood is always legal).
      return legal[rng.nextInt(legal.length)] ?? (legal[0] as WingspanChoice);
    },
  };
};
