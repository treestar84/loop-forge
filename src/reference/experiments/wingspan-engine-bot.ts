/**
 * wingspan-engine-bot — L3 holdout anchor ('wingspan-engine-l3').
 *
 * Per docs/GAP-ANALYSIS-11.md D3 (anchor-ladder pattern): a holdout anchor's
 * entire purpose is judging other bots' *independent* skill without ever
 * having "seen" the L2 anchor bot's logic. Designed WITHOUT reading
 * ../experiments/wingspan-opus-bot.ts (the L2 anchor this bot must remain
 * independent from) — its logic below was derived solely from
 * ../wingspan.ts (the GameAdapter: rules, types, baselines) plus the general
 * house style visible in ../experiments/splendor-engine-bot.ts and
 * ../experiments/splendor-mid-bot.ts as structural templates. Same rule
 * splendor-engine-bot.ts's own header states for splendor-opus-bot.ts, and
 * gomoku-positional-bot.ts states for gomoku-opus-bot.ts.
 *
 * Design brief and its honest adaptation to this adapter's actual rules
 * (docs/GAP-ANALYSIS-11.md's main-loop design brief for the L3 slot):
 * "L3 설계 철학(메인 루프 지정): L2·챔피언과 다른 축 — 엔진/카드 시너지 체인
 * 우선이 이미 챔피언 스타일이라면, L3는 먹이(food) 경제 최적화 + 알(egg)
 * 스퍼트 마무리 철학(중반까지 자원 효율, 종반 알 집중)으로." i.e. a food-
 * economy-through-the-midgame, egg-focused-spurt-at-the-end philosophy, as a
 * different decision axis than an engine/synergy-chain-first champion style.
 *
 * IMPORTANT HONEST ADAPTATION: ../wingspan.ts's own file header documents
 * that the adapter's actual source game (a stripped RL-training environment)
 * has NO egg mechanic, no cached food, no card powers, and no habitats at
 * all — `Player.actions` in the source is exactly
 * `["play_a_bird", "gain_food", "draw_a_bird"]` with eggs explicitly marked
 * "not implemented yet". A literal "egg-focused spurt finish" therefore
 * cannot be built here — there is no egg resource to spurt into. The only
 * real scoring analog to "eggs" in this stripped game is bird points already
 * locked onto the board (`score()` in wingspan.ts sums exactly that), so the
 * philosophy is translated faithfully rather than literally:
 *   - Midgame ("food economy optimization"): while turnsRemaining is above
 *     SPURT_THRESHOLD, this bot behaves like a resource-accumulation engine —
 *     it only plays a bird when its efficiency (points per food, with 0-cost
 *     birds treated as strictly free value) clears ACCUMULATE_EFFICIENCY_MIN,
 *     it banks food up to FOOD_BUFFER_TARGET before spending idle turns on
 *     anything else, and it drafts tray/deck birds to build a hand of future
 *     good plays rather than dumping every affordable bird immediately (the
 *     naive-greedy shape this bot deliberately avoids).
 *   - Endgame "egg spurt" analog (turnsRemaining <= SPURT_THRESHOLD): the bot
 *     switches wholesale out of accumulation mode into pure scoring mode —
 *     every turn, it plays the highest-point affordable bird it holds
 *     regardless of food efficiency, and if nothing is affordable it gainFoods
 *     specifically to unlock the cheapest held bird next turn, since no
 *     drafted bird would have time to be played and scored once the spurt
 *     window is this narrow. This mirrors the real philosophy's
 *     resource-accumulation-then-conversion-burst shape even though the
 *     resource being "spent down" for points is board slots + food rather
 *     than eggs.
 *
 * SPURT_THRESHOLD justification: there are TOTAL_MY_TURNS = 10 turns for this
 * player (NUM_TURNS_PER_PLAYER in wingspan.ts). SPURT_THRESHOLD = 3 means the
 * spurt covers the final 3 of the player's own turns (~30% of the game) —
 * enough turns to clear a hand of 2-4 held birds (board capacity is 5, and a
 * typical accumulation-phase hand holds only a few birds at once) but short
 * enough that the accumulation phase still gets the large majority (70%) of
 * turns to actually build food surplus and draft plays, which is the whole
 * point of the "food economy through the midgame" half of the philosophy.
 *
 * This must be a genuinely different decision *shape* than "always play
 * highest points now" (a naive greedy bot) — the defining trait here is the
 * two-phase, turn-count-aware behavior switch (accumulate-and-optimize, then
 * dump-for-points), not just card-value ordering. Compare against wingspan.ts's
 * own baselines: `heuristicBaseline` always plays the best-efficiency
 * affordable bird with no phase awareness at all, and the `playHighestPoints`
 * strategy flag always maximizes points immediately with no accumulation
 * phase — neither has this bot's turn-count-gated mode switch.
 *
 * Determinism: `decide` is a pure function of (decisionPoint, observation,
 * legal) closed over a single `createRng(seed)` instance plus a `myTurn`
 * closure counter (the standard BotFactory pattern used across
 * reference/experiments/*-bot.ts for tracking a bot's own turn count). The
 * rng is only ever drawn from to break truly equal-score ties — gainFood is
 * unconditionally legal every turn per wingspan.ts's file header, so in
 * practice a full tie down to the rng fallback should be unreachable, but it
 * is wired for defense-in-depth like every other bot in this directory. No
 * Date.now()/Math.random(). Layer: reference/experiments — imports only
 * contract/kernel types plus sibling ../wingspan types.
 */

import type { BotFactory, Rng } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import type { WingspanChoice, WingspanObservation } from '../wingspan';

/** NUM_TURNS_PER_PLAYER from wingspan.ts — this player gets exactly this many decisions. */
const TOTAL_MY_TURNS = 10;
/** See file header for why the final 3 of the player's own turns are the spurt window. */
const SPURT_THRESHOLD = 3;
/** Minimum points-per-food (0-cost birds count as points+1) to play during accumulation. */
const ACCUMULATE_EFFICIENCY_MIN = 1.0;
/** Slightly relaxed bar for drafting a tray bird during accumulation (future play, not immediate). */
const DRAFT_EFFICIENCY_MIN = 0.7;
/** Bank food up to this level before spending turns on anything besides a good play, during accumulation. */
const FOOD_BUFFER_TARGET = 3;
const EPS = 1e-9;

// Transcribed inline from ../wingspan.ts's BIRD_DEFS (id -> [points, foodCost]),
// same "no cross-module data import" convention wingspan-mid-bot.ts and
// wingspan-opus-bot.ts already use, to stay fully decoupled from the adapter
// module (this file intentionally imports only *types* from ../wingspan).
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

/** Endgame spurt: dump the highest-point affordable bird onto the board, ignoring efficiency entirely. */
function decideSpurt(observation: WingspanObservation, legal: readonly WingspanChoice[], rng: Rng): WingspanChoice {
  const plays = legal.filter((c): c is PlayChoice => c.kind === 'playBird');
  if (plays.length > 0) {
    return pickBest(plays, (c) => pointsOf(c.cardId), (c) => c.cardId, rng);
  }

  // No affordable bird right now — spend the turn unlocking the cheapest held
  // bird for next turn rather than drafting (drafting has no time to pay off
  // this close to the end).
  const gainFood = legal.find((c) => c.kind === 'gainFood');
  if (observation.selfHand.length > 0 && gainFood) return gainFood;

  const trayDraws = legal.filter((c): c is TrayChoice => c.kind === 'drawTray');
  if (trayDraws.length > 0) {
    return pickBest(trayDraws, (c) => pointsOf(c.cardId), (c) => c.cardId, rng);
  }
  const deckDraw = legal.find((c) => c.kind === 'drawDeck');
  if (deckDraw) return deckDraw;
  if (gainFood) return gainFood;
  return legal[0] as WingspanChoice;
}

/** Midgame accumulation: play only efficient birds, bank food, draft good future plays. */
function decideAccumulate(observation: WingspanObservation, legal: readonly WingspanChoice[], rng: Rng): WingspanChoice {
  const plays = legal.filter((c): c is PlayChoice => c.kind === 'playBird');
  if (plays.length > 0) {
    const best = pickBest(plays, (c) => efficiency(c.cardId), (c) => c.cardId, rng);
    if (efficiency(best.cardId) >= ACCUMULATE_EFFICIENCY_MIN) return best;
  }

  const myFood = observation.food[0];
  const gainFood = legal.find((c) => c.kind === 'gainFood');
  if (myFood < FOOD_BUFFER_TARGET && gainFood) return gainFood;

  const trayDraws = legal.filter((c): c is TrayChoice => c.kind === 'drawTray');
  if (trayDraws.length > 0) {
    const bestTray = pickBest(trayDraws, (c) => efficiency(c.cardId), (c) => c.cardId, rng);
    if (efficiency(bestTray.cardId) >= DRAFT_EFFICIENCY_MIN) return bestTray;
  }

  const deckDraw = legal.find((c) => c.kind === 'drawDeck');
  if (deckDraw) return deckDraw;

  if (gainFood) return gainFood;
  if (plays.length > 0) return pickBest(plays, (c) => efficiency(c.cardId), (c) => c.cardId, rng);
  if (trayDraws.length > 0) return pickBest(trayDraws, (c) => efficiency(c.cardId), (c) => c.cardId, rng);
  return legal[0] as WingspanChoice;
}

export const wingspanEngineBot: BotFactory<WingspanObservation, WingspanChoice> = (seed) => {
  const rng = createRng(seed);
  let myTurn = 0;
  return {
    id: 'wingspan-engine-l3',
    decide(_decisionPoint, observation, legal) {
      const turnsRemaining = TOTAL_MY_TURNS - myTurn;
      myTurn += 1;

      if (turnsRemaining <= SPURT_THRESHOLD) {
        return decideSpurt(observation, legal, rng);
      }
      return decideAccumulate(observation, legal, rng);
    },
  };
};
