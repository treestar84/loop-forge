/**
 * wingspan-opus-bot — a ONE-SHOT "Opus 설계봇" for the benchmark experiment
 * of docs/BENCHMARK-EXPERIMENT.md, column A. This bot was designed in a single
 * pass from the actual rules implemented in ../wingspan.ts (the stripped
 * food-engine race — NOT real Wingspan; see that file's header) and was NOT
 * tuned or validated against the Loop Forge scoring/wave/gate pipeline. It is
 * the "just ask the LLM to design a good bot" control arm.
 *
 * Lives in reference/experiments/, so it may only import contract + kernel
 * (dependency-rules.test.ts). It reproduces the 20-bird stat table inline
 * (the designer read BIRD_DEFS from wingspan.ts) rather than importing it, so
 * that this control bot stays conceptually decoupled from the adapter it is
 * being measured against.
 *
 * Design rationale (the "rules I reasoned from"):
 *  - Exactly 10 turns per player. Each turn is ONE of: play an affordable bird
 *    (+points, −foodCost, permanent), gain 1 food, or draw a card. Score is
 *    the sum of points of birds on your board (capacity 5). Turns — not food —
 *    are the truly scarce resource.
 *  - The reference `baselines.heuristic` has one structural flaw this bot
 *    targets: it never *proactively* gains food (it only gainFoods as a last
 *    resort), and it orders plays by points/food efficiency — so it will burn
 *    its starting 3 food on a cheap high-efficiency bird (american-crow, 4/1)
 *    and then be unable to afford a 9-point cost-3 bird it is holding. This
 *    bot instead (a) orders plays by RAW points (locking in the biggest board
 *    gain per play-turn), and (b) proactively gains food to *realize*
 *    high-value birds it already holds, as long as the horizon allows it.
 *  - Horizon awareness: never draw a card there is no time left to play, and
 *    once the board is full, stop trying to score.
 */

import type { BotFactory } from '../../contract/types';
import { createRng } from '../../kernel/rng';

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

const BOARD_CAPACITY = 5;
const TOTAL_MY_TURNS = 10;

/** Minimum point advantage a held-but-unaffordable bird must have over the
 * best immediately-playable bird before we skip the immediate play to gain
 * food toward it. Keeps us from over-investing on marginal upgrades. */
const INVEST_MARGIN = 3;

function pointsOf(id: string): number {
  return BIRD_STATS[id]?.points ?? 0;
}

function costOf(id: string): number {
  return BIRD_STATS[id]?.foodCost ?? 0;
}

// Deterministic ordering: highest points first, then cheaper (frees food),
// then id for a stable final tiebreak.
function betterBird(a: string, b: string): number {
  const dp = pointsOf(b) - pointsOf(a);
  if (dp !== 0) return dp;
  const dc = costOf(a) - costOf(b);
  if (dc !== 0) return dc;
  return a < b ? -1 : a > b ? 1 : 0;
}

type Obs = {
  readonly food: readonly [number, number];
  readonly boards: readonly [readonly string[], readonly string[]];
  readonly selfHand: readonly string[];
  readonly tray: readonly string[];
  readonly deckCount: number;
};

type Choice =
  | { readonly kind: 'playBird'; readonly cardId: string }
  | { readonly kind: 'gainFood' }
  | { readonly kind: 'drawTray'; readonly cardId: string }
  | { readonly kind: 'drawDeck' };

export const wingspanOpusBot: BotFactory<Obs, Choice> = (seed) => {
  // rng honours the BotFactory contract; used only as a last-ditch tiebreak
  // when two choices are otherwise identical in value. All primary decisions
  // are deterministic.
  const rng = createRng(seed);
  let myTurn = 0;

  return {
    id: 'wingspan-opus',
    decide(_decisionPoint: string, observation: Obs, legal: readonly Choice[]): Choice {
      const turnsRemaining = TOTAL_MY_TURNS - myTurn; // includes the current turn
      myTurn += 1;

      const selfFood = observation.food[0];
      const myBoard = observation.boards[0];
      const space = BOARD_CAPACITY - myBoard.length;

      const gainFood = legal.find((c) => c.kind === 'gainFood');
      const plays = legal.filter(
        (c): c is Extract<Choice, { kind: 'playBird' }> => c.kind === 'playBird',
      );
      const trayDraws = legal.filter(
        (c): c is Extract<Choice, { kind: 'drawTray' }> => c.kind === 'drawTray',
      );
      const deckDraw = legal.find((c) => c.kind === 'drawDeck');

      const fallback = (): Choice => gainFood ?? (legal[0] as Choice);

      // Board is full: no further scoring is possible, so no action improves
      // our score. gainFood is harmless and always legal.
      if (space <= 0) return fallback();

      // Best bird we can play right now, ordered by raw points.
      const bestPlay =
        plays.length > 0
          ? [...plays].sort((a, b) => betterBird(a.cardId, b.cardId))[0]
          : undefined;

      // Highest-value bird we already hold but cannot yet afford — a candidate
      // to gain food toward.
      const unaffordableHeld = [...observation.selfHand]
        .filter((id) => costOf(id) > selfFood)
        .sort(betterBird);
      const target = unaffordableHeld[0];

      let investWorthwhile = false;
      if (target && gainFood && space >= 1) {
        const foodNeeded = costOf(target) - selfFood;
        const turnsToRealize = foodNeeded + 1; // gainFood turns + one play turn
        if (turnsRemaining >= turnsToRealize) {
          const bestPlayPoints = bestPlay ? pointsOf(bestPlay.cardId) : 0;
          // Invest if the target is much better than the best immediate play,
          // or if there is nothing worth playing right now at all.
          if (!bestPlay || pointsOf(target) - bestPlayPoints >= INVEST_MARGIN) {
            investWorthwhile = true;
          }
        }
      }

      if (investWorthwhile && gainFood) return gainFood;
      if (bestPlay) return bestPlay;

      // Nothing to play and no worthwhile food investment. Draw a bird only if
      // there is still time to actually play it (a draw plus at least one play)
      // and a board slot to hold it.
      if (turnsRemaining >= 2 && space >= 1 && trayDraws.length > 0) {
        // Prefer the highest-point tray bird we can realistically play in the
        // remaining turns: affordable now, or affordable after gaining food
        // within the turns left (reserve 1 turn to draw + 1 to play).
        const realizable = [...trayDraws]
          .filter((c) => costOf(c.cardId) <= selfFood + Math.max(0, turnsRemaining - 2))
          .sort((a, b) => betterBird(a.cardId, b.cardId));
        if (realizable.length > 0 && pointsOf(realizable[0]!.cardId) > 0) {
          return realizable[0]!;
        }
      }

      // Early game with slack: a blind deck draw can still turn into points.
      if (deckDraw && turnsRemaining >= 5 && space >= 1 && selfFood >= 1) {
        return deckDraw;
      }

      // Default: bank food toward future plays rather than waste the turn on an
      // unplayable draw.
      if (gainFood) return gainFood;

      // Absolute last resort (should be unreachable — gainFood is always legal).
      return legal[rng.nextInt(legal.length)] ?? (legal[0] as Choice);
    },
  };
};
