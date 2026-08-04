/**
 * wingspan-engine-bot — L3 holdout anchor ('wingspan-engine-l3').
 *
 * REDESIGN NOTICE: this file previously implemented a "food-economy →
 * endgame point-spurt" philosophy (two-phase, turn-count-gated). Measured
 * against ../experiments/wingspan-opus-bot.ts (L2) on the fixed heuristic
 * self-play probe (20 games, 400 decision points, seeds 1_023_000-1_023_019),
 * it agreed with L2 on 84.0% of decision points — far above the calibrated
 * gate's ~68.5% ceiling (docs/adr/0015-calibrated-l3-fingerprint-gate.md,
 * with this game's independent-pair agreement floor measured at 37.0%). The
 * reason: both the old L3 and L2 reasoned about "points per food efficiency"
 * over the same 20-bird pool, and this game's narrow 4-action-kind space
 * gives any two efficiency-reasoning bots very little room to diverge. This
 * rewrite (still designed WITHOUT ever reading
 * ../experiments/wingspan-opus-bot.ts — see below) replaces the philosophy
 * with one that is structurally uncorrelated with points-per-food ranking,
 * per the project lead's diagnosis, rather than merely a different
 * efficiency threshold.
 *
 * Designed WITHOUT reading ../experiments/wingspan-opus-bot.ts (the L2
 * anchor this bot must remain independent from) — its logic below was
 * derived solely from ../wingspan.ts (the GameAdapter: rules, types,
 * baselines) plus the general house style visible in
 * ../experiments/splendor-engine-bot.ts and ../experiments/splendor-mid-bot.ts
 * as structural templates. Same rule splendor-engine-bot.ts's own header
 * states for splendor-opus-bot.ts, and gomoku-positional-bot.ts states for
 * gomoku-opus-bot.ts.
 *
 * Philosophy — "habitat specialization": in the real boardgame Wingspan (not
 * what this adapter implements — see below), a habitat specialist commits to
 * birds of one habitat type and mostly ignores birds of other habitats even
 * when they would be individually more valuable, instead of always taking
 * the objectively best available bird. This is deliberately NOT an
 * efficiency-shaped philosophy: the old L3's failure mode was that
 * "efficiency-with-different-tuning" still converges with any other
 * efficiency-reasoning bot (L2 included). Habitat commitment is an axis
 * orthogonal to points-per-food ranking, so it cannot converge the same way.
 *
 * IMPORTANT HONEST ADAPTATION: ../wingspan.ts's own file header documents
 * that the adapter's actual source game (a stripped RL-training environment)
 * has no habitat field at all — every one of the 20 core birds is fully
 * described by just `(name, points, foodCost)`, nothing more. A literal
 * "habitat" therefore cannot be read off any bird. The translation used here
 * partitions the fixed 20-bird pool by `foodCost` into a "target set" (the
 * bot's committed habitat) versus everything else:
 *   - TARGET_SET (cost 0-1, 8 birds): turkey-vulture, california-condor,
 *     black-vulture, mourning-dove, house-wren, purple-martin,
 *     american-crow, northern-harrier.
 *   - Everything else (cost 2-3, 12 birds) is treated as "off-habitat" and
 *     is, with one narrow endgame exception below, never played, never
 *     drafted from the tray, and never chased.
 * This is a genuinely different decision *shape* than any efficiency
 * threshold: american-crow (4 points / 1 food = 4.0 efficiency) is IN the
 * habitat and red-tailed-hawk (5 points / 2 food = 2.5 efficiency) is OUT,
 * even though hawk's raw efficiency is lower than crow's but well above many
 * in-habitat birds like mourning-dove (0 points / 1 food = 0 efficiency,
 * still in-habitat) — membership, not value, decides. Concretely:
 *   - `playBird`: only ever plays a bird whose id is in TARGET_SET, even if
 *     a much better off-habitat bird sits unplayed in hand. An off-habitat
 *     bird that lands in hand (e.g. from a blind deck draw) is simply never
 *     played for the remainder of the game outside the endgame relax below
 *     — there is no discard/tuck action in this adapter, so "tucking"
 *     translates to permanently declining to play it, exactly the honest
 *     translation the task brief calls for.
 *   - `drawTray`: only ever drafts a tray bird whose id is in TARGET_SET,
 *     even when a visible tray bird outside the set is individually more
 *     valuable. The specialist does not chase specific off-habitat birds
 *     even when it can see them sitting in the tray — it prefers gainFood or
 *     drawDeck instead (a blind deck draw might land outside the habitat
 *     too, but the specialist doesn't avoid that risk the way it avoids a
 *     *known* off-habitat tray pick).
 *   - `drawDeck`: left unrestricted (blind by construction — no id is known
 *     until it lands in hand, at which point the playBird restriction above
 *     still applies), since it is legal turn-filler when no in-habitat tray
 *     bird nor good play is available.
 *
 * Gate 1 (must still beat wingspanAdapter.baselines.heuristic,
 * winRateCI.lower > 0.5 over N=100): a pure "never play off-habitat, no
 * other logic" bot risks stalling if only off-habitat birds are affordable
 * in hand for many turns, so two modest additions keep this a genuinely
 * decent player without diluting the dominant habitat-commitment trait:
 *   1) Within TARGET_SET, playBird/drawTray still rank candidates by
 *      points-per-food (habitat governs *which* birds are eligible at all;
 *      once eligible, still pick the better one — this does not reintroduce
 *      cross-habitat convergence with L2 because the eligible pool itself is
 *      the orthogonal, structurally different axis).
 *   2) ENDGAME_RELAX_TURNS: with this few of the player's own turns left,
 *      if no in-habitat bird is playable AND at least one off-habitat bird
 *      in hand *is* affordable, the bot relaxes the habitat restriction and
 *      plays the highest-point affordable bird regardless of habitat — a
 *      stranded off-habitat bird late in hand can never be converted to
 *      points otherwise, and this narrow exception still leaves the
 *      dominant trait ("ignore off-habitat even when better") in force
 *      across the large majority of the game's 10 turns per player.
 * Outside this narrow relax window, food banking (gainFood when short of the
 * cheapest unaffordable in-habitat bird) keeps the bot actually building
 * toward in-habitat plays rather than stalling.
 *
 * ENDGAME_RELAX_TURNS justification: 2 out of TOTAL_MY_TURNS = 10 (20%) —
 * narrow enough that the habitat-ignoring trait still governs roughly 80% of
 * this bot's turns (the dominant-trait requirement from the design brief),
 * while still wide enough to salvage 1-2 turns' worth of otherwise-dead
 * off-habitat cards for Gate 1's win-rate requirement.
 *
 * Determinism: `decide` is a pure function of (decisionPoint, observation,
 * legal) closed over a single `createRng(seed)` instance plus a `myTurn`
 * closure counter (the standard BotFactory pattern used across
 * reference/experiments/*-bot.ts for tracking a bot's own turn count). The
 * rng is only ever drawn from to break truly equal-score ties. No
 * Date.now()/Math.random(). Layer: reference/experiments — imports only
 * contract/kernel types plus sibling ../wingspan types.
 */

import type { BotFactory, Rng } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import type { WingspanChoice, WingspanObservation } from '../wingspan';

/** NUM_TURNS_PER_PLAYER from wingspan.ts — this player gets exactly this many decisions. */
const TOTAL_MY_TURNS = 10;
/** See file header for why the final 2 of the player's own turns are the habitat-relax window. */
const ENDGAME_RELAX_TURNS = 2;
/** Bank food up to this level while waiting on an in-habitat play, rather than idling on drawDeck. */
const FOOD_BUFFER_TARGET = 2;
const EPS = 1e-9;

// Transcribed inline from ../wingspan.ts's BIRD_DEFS (id -> [points, foodCost]),
// same "no cross-module data import" convention this directory's other bots
// use, to stay fully decoupled from the adapter module (this file
// intentionally imports only *types* from ../wingspan).
const BIRD_STATS: Readonly<Record<string, readonly [points: number, foodCost: number]>> = {
  'turkey-vulture': [1, 0],
  'california-condor': [1, 0],
  'black-vulture': [2, 0],
  'mourning-dove': [0, 1],
  'house-wren': [1, 1],
  'purple-martin': [2, 1],
  'american-crow': [4, 1],
  'northern-harrier': [3, 1],
  'american-robin': [1, 2],
  'carolina-wren': [1, 2],
  killdeer: [1, 2],
  mallard: [0, 2],
  bushtit: [2, 2],
  'american-goldfinch': [3, 2],
  'blue-jay': [3, 2],
  'red-tailed-hawk': [5, 2],
  'great-blue-heron': [5, 2],
  'song-sparrow': [0, 3],
  'american-woodcock': [9, 3],
  'bald-eagle': [9, 3],
};

/** The committed "habitat" — see file header for the foodCost 0-1 partition rule. */
const TARGET_SET: ReadonlySet<string> = new Set([
  'turkey-vulture',
  'california-condor',
  'black-vulture',
  'mourning-dove',
  'house-wren',
  'purple-martin',
  'american-crow',
  'northern-harrier',
]);

function isTarget(cardId: string): boolean {
  return TARGET_SET.has(cardId);
}

function pointsOf(cardId: string): number {
  const stats = BIRD_STATS[cardId];
  if (!stats) throw new Error(`wingspan-engine-bot: unknown bird id ${cardId}`);
  return stats[0];
}

function foodCostOf(cardId: string): number {
  const stats = BIRD_STATS[cardId];
  if (!stats) throw new Error(`wingspan-engine-bot: unknown bird id ${cardId}`);
  return stats[1];
}

function efficiency(cardId: string): number {
  const cost = foodCostOf(cardId);
  return cost === 0 ? pointsOf(cardId) + 1 : pointsOf(cardId) / cost;
}

/** Cheapest foodCost among all in-habitat birds — used to size the gainFood buffer. */
const CHEAPEST_TARGET_COST = Math.min(...[...TARGET_SET].map((id) => foodCostOf(id)));

/** Picks the max-score item, breaking truly equal-score ties via `rng` (same shape as splendor-engine-bot.ts's pickBest). */
function pickBest<T>(items: readonly T[], scoreOf: (item: T) => number, encode: (item: T) => string, rng: Rng): T {
  let bestScore = -Infinity;
  for (const item of items) {
    const s = scoreOf(item);
    if (s > bestScore) bestScore = s;
  }
  const tied = items
    .filter((item) => Math.abs(scoreOf(item) - bestScore) < EPS)
    .slice()
    .sort((a, b) => (encode(a) < encode(b) ? -1 : encode(a) > encode(b) ? 1 : 0));
  return tied[rng.nextInt(tied.length)] as T;
}

type PlayChoice = Extract<WingspanChoice, { kind: 'playBird' }>;
type TrayChoice = Extract<WingspanChoice, { kind: 'drawTray' }>;

export const wingspanEngineBot: BotFactory<WingspanObservation, WingspanChoice> = (seed) => {
  const rng = createRng(seed);
  let myTurn = 0;
  return {
    id: 'wingspan-engine-l3',
    decide(_decisionPoint, observation, legal) {
      const turnsRemaining = TOTAL_MY_TURNS - myTurn;
      myTurn += 1;

      const plays = legal.filter((c): c is PlayChoice => c.kind === 'playBird');
      const targetPlays = plays.filter((c) => isTarget(c.cardId));

      // Dominant trait: if any in-habitat bird is playable, always play the
      // best in-habitat option — never a non-target bird, regardless of the
      // non-target bird's value.
      if (targetPlays.length > 0) {
        return pickBest(targetPlays, (c) => efficiency(c.cardId), (c) => c.cardId, rng);
      }

      // Narrow endgame relax (see file header): only this close to the end,
      // and only when no in-habitat bird is playable, salvage an otherwise
      // permanently-unplayed off-habitat bird for points.
      if (turnsRemaining <= ENDGAME_RELAX_TURNS && plays.length > 0) {
        return pickBest(plays, (c) => pointsOf(c.cardId), (c) => c.cardId, rng);
      }

      const myFood = observation.food[0];
      const gainFood = legal.find((c) => c.kind === 'gainFood');
      const trayDraws = legal.filter((c): c is TrayChoice => c.kind === 'drawTray');
      const targetTrayDraws = trayDraws.filter((c) => isTarget(c.cardId));
      const deckDraw = legal.find((c) => c.kind === 'drawDeck');

      // Bank food toward the cheapest in-habitat bird before spending a turn
      // on anything else, so accumulated food is never wasted idling above
      // what any in-habitat bird would ever need.
      if (myFood < Math.max(CHEAPEST_TARGET_COST, FOOD_BUFFER_TARGET) && gainFood) {
        return gainFood;
      }

      // Draft only visible in-habitat tray birds — the specialist does not
      // chase a known off-habitat bird sitting in the tray even though it
      // can see it, per the file header's translation of the philosophy.
      if (targetTrayDraws.length > 0) {
        return pickBest(targetTrayDraws, (c) => efficiency(c.cardId), (c) => c.cardId, rng);
      }

      // No in-habitat tray option: prefer a blind deck draw (unseen, so no
      // habitat violation is being *chosen*) over drafting a known
      // off-habitat tray bird.
      if (deckDraw) return deckDraw;
      if (gainFood) return gainFood;

      // Defense-in-depth fallback (should be unreachable: gainFood is
      // unconditionally legal every turn per wingspan.ts's file header).
      if (targetPlays.length === 0 && plays.length > 0) {
        return pickBest(plays, (c) => efficiency(c.cardId), (c) => c.cardId, rng);
      }
      if (trayDraws.length > 0) {
        return pickBest(trayDraws, (c) => efficiency(c.cardId), (c) => c.cardId, rng);
      }
      return legal[0] as WingspanChoice;
    },
  };
};
