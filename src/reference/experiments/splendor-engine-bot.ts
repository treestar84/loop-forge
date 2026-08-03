/**
 * splendor-engine-bot — L3 holdout anchor ('splendor-engine-l3').
 *
 * Designed WITHOUT reading ../experiments/splendor-opus-bot.ts (GAP-11 anchor
 * ladder / docs/adr's holdout-anchor convention, same rule gomoku-positional-bot.ts
 * follows for gomoku-opus-bot.ts): this bot's value as an independent judge
 * depends on its logic never having been derived from, or checked against,
 * that file. Designed purely from ../splendor.ts (the GameAdapter) plus the
 * general house style visible in splendor.ts's own baselines/strategy flags
 * and in dominion-mid-bot.ts / gomoku-positional-bot.ts as structural
 * templates.
 *
 * Philosophy — "엔진 우선(개발 카드 할인 축적→후반 폭발) + 귀족 타일 정렬":
 *   1) Engine phase (early game): when the player has not yet built decent
 *      color coverage AND no noble on the board is within near-term reach,
 *      buy/take/reserve decisions favor CHEAP cards that expand owned-color
 *      coverage/count (permanent gem discounts) over the highest point value
 *      available — i.e. sacrifice points now to buy engine pieces.
 *   2) Noble alignment: gems and cards are steered toward whichever color(s)
 *      the CLOSEST noble(s) on the board still need, using an inverse-
 *      distance-weighted blend across all nobles (not just the single
 *      nearest) so the bot hedges when two nobles are similarly close.
 *   3) Late/cash-in phase: once every noble is more than
 *      NOBLE_REACH_THRESHOLD color-pips away (nobody reachable soon) OR the
 *      player already produces COVERAGE_LATE_THRESHOLD+ colors (engine is
 *      "online"), point value is weighted much more heavily in buy scoring —
 *      the "후반 폭발" half of the philosophy: cash the accumulated discounts
 *      in for points.
 *   4) Reserve/take/discard all reuse the same engine+noble scoring function
 *      rather than a bank-quantity or point-maximizing rule, so this bot does
 *      not resemble either existing house baseline:
 *        - `heuristicBaseline` (splendor.ts) is cheapest-card-first with no
 *          noble awareness and no phase transition.
 *        - `buyHighestPoints` (splendor.ts strategy flag) always maximizes
 *          point value immediately, the opposite of "sacrifice points early".
 *
 * Determinism: `decide` is a pure function of (decisionPoint, observation,
 * legal) closed over a single `createRng(seed)` instance; the rng is only
 * ever drawn from to break truly equal-score ties (never for the scoring
 * logic itself). No Date.now()/Math.random(). Layer: reference/experiments —
 * imports only contract/kernel types plus sibling ../splendor types.
 */

import type { BotFactory, Rng } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import type {
  Color,
  Gem,
  Level,
  PlayerState,
  SplendorCard,
  SplendorChoice,
  SplendorNoble,
  SplendorObservation,
} from '../splendor';

const COLORS: readonly Color[] = ['w', 'u', 'g', 'r', 'b'];

/** Nobles farther than this many missing color-pips are treated as "not reachable soon". */
const NOBLE_REACH_THRESHOLD = 3;
/** Owning cards in this many distinct colors counts as "decent engine coverage". */
const COVERAGE_LATE_THRESHOLD = 3;
/** Scales how strongly noble-deficit colors pull buy/take/reserve scoring. */
const NOBLE_WEIGHT_SCALE = 6;
const EPS = 1e-9;

function totalCost(card: SplendorCard): number {
  return COLORS.reduce((sum, c) => sum + card.cost[c], 0);
}

function coverageCount(player: PlayerState): number {
  return COLORS.reduce((sum, c) => sum + (player.cards[c].length > 0 ? 1 : 0), 0);
}

function gapForNoble(player: PlayerState, noble: SplendorNoble): number {
  return COLORS.reduce((sum, c) => sum + Math.max(0, noble.requirement[c] - player.cards[c].length), 0);
}

function minNobleGap(player: PlayerState, nobles: readonly SplendorNoble[]): number {
  if (nobles.length === 0) return Infinity;
  return Math.min(...nobles.map((n) => gapForNoble(player, n)));
}

/**
 * Inverse-distance-weighted per-color pull toward whichever nearby noble(s)
 * still need that color — the "귀족 타일 정렬" half of the philosophy. Only
 * nobles within NOBLE_REACH_THRESHOLD contribute, so a noble that's hopeless
 * doesn't dilute the signal from one that's actually reachable.
 */
function nobleColorWeights(player: PlayerState, nobles: readonly SplendorNoble[]): Readonly<Record<Color, number>> {
  const weights: Record<Color, number> = { w: 0, u: 0, g: 0, r: 0, b: 0 };
  for (const noble of nobles) {
    const gap = gapForNoble(player, noble);
    if (gap > NOBLE_REACH_THRESHOLD) continue;
    const closeness = 1 / (gap + 1);
    for (const c of COLORS) {
      const deficit = noble.requirement[c] - player.cards[c].length;
      if (deficit > 0) weights[c] += closeness * NOBLE_WEIGHT_SCALE;
    }
  }
  return weights;
}

type Phase = 'engine' | 'late';

function phaseOf(player: PlayerState, nobles: readonly SplendorNoble[]): Phase {
  const nobleUnreachable = minNobleGap(player, nobles) > NOBLE_REACH_THRESHOLD;
  const engineOnline = coverageCount(player) >= COVERAGE_LATE_THRESHOLD;
  return nobleUnreachable || engineOnline ? 'late' : 'engine';
}

function colorNeedScore(color: Color, player: PlayerState, weights: Readonly<Record<Color, number>>): number {
  const engineBonus = player.cards[color].length === 0 ? 3 : 0;
  return engineBonus + weights[color];
}

function buyScore(
  card: SplendorCard,
  player: PlayerState,
  weights: Readonly<Record<Color, number>>,
  phase: Phase,
): number {
  const isNewColor = player.cards[card.color].length === 0;
  const engineWeightFactor = phase === 'engine' ? 3 : 1;
  const engineValue = (isNewColor ? 3 : 1) * engineWeightFactor;
  const nobleValue = weights[card.color];
  const costPenalty = totalCost(card) * (phase === 'engine' ? 0.4 : 0.1);
  const pointWeight = phase === 'engine' ? 0.5 : 3;
  return engineValue + nobleValue + pointWeight * card.points - costPenalty;
}

function reserveScore(
  card: SplendorCard,
  player: PlayerState,
  weights: Readonly<Record<Color, number>>,
  phase: Phase,
): number {
  // Reserving only secures future potential (plus a gold), so it is always
  // discounted relative to actually buying the same card now.
  return 0.45 * buyScore(card, player, weights, phase);
}

function reserveBlindScore(level: Level, phase: Phase): number {
  // No peeking at the unseen deck — a flat, phase-aware estimate: the engine
  // phase favors cheap low-level gambles, the late phase favors the higher
  // expected point payoff of deeper tiers.
  const engineTable: Readonly<Record<Level, number>> = { 1: 1.2, 2: 0.8, 3: 0.4 };
  const lateTable: Readonly<Record<Level, number>> = { 1: 0.6, 2: 1.0, 3: 1.4 };
  return (phase === 'engine' ? engineTable : lateTable)[level];
}

function discardNeedValue(gem: Gem, player: PlayerState, weights: Readonly<Record<Color, number>>): number {
  if (gem === 'gold') return 100; // gold is fungible for any color; never discard it voluntarily.
  const need = colorNeedScore(gem, player, weights);
  const surplus = player.gems[gem] * 0.1;
  return need - surplus;
}

function findCard(observation: SplendorObservation, cardId: string): SplendorCard | undefined {
  for (const level of [1, 2, 3] as const) {
    const found = observation.board[level].find((c) => c.id === cardId);
    if (found) return found;
  }
  for (const player of observation.players) {
    const found = player.reserved.find((c) => c.id === cardId);
    if (found) return found;
  }
  return undefined;
}

/** Picks the max-score item, breaking truly equal-score ties via `rng`. */
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

function encodeChoiceKey(choice: SplendorChoice): string {
  switch (choice.kind) {
    case 'take':
      return `take:${choice.color}`;
    case 'takeDone':
      return 'takeDone';
    case 'buy':
      return `buy:${choice.cardId}`;
    case 'reserve':
      return `reserve:${choice.cardId}`;
    case 'reserveBlind':
      return `reserveBlind:${choice.level}`;
    case 'discard':
      return `discard:${choice.gem}`;
    case 'noble':
      return `noble:${choice.nobleId}`;
    default:
      return 'unknown';
  }
}

export const splendorEngineBot: BotFactory<SplendorObservation, SplendorChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'splendor-engine-l3',
    decide(decisionPoint, observation, legal) {
      const self = observation.players[observation.self] as PlayerState;
      const nobles = observation.nobles;
      const weights = nobleColorWeights(self, nobles);
      const phase = phaseOf(self, nobles);

      if (decisionPoint === 'noble') {
        const nobleChoices = legal.filter(
          (c): c is Extract<SplendorChoice, { kind: 'noble' }> => c.kind === 'noble',
        );
        const opponent = observation.players[observation.self === 0 ? 1 : 0] as PlayerState;
        // Prefer the noble the opponent is currently farthest from qualifying
        // for — the least contested pick — then lowest id for determinism.
        return pickBest(
          nobleChoices,
          (c) => {
            const noble = nobles.find((n) => n.id === c.nobleId);
            return noble ? gapForNoble(opponent, noble) : 0;
          },
          (c) => c.nobleId,
          rng,
        );
      }

      if (decisionPoint === 'take') {
        const takes = legal.filter((c): c is Extract<SplendorChoice, { kind: 'take' }> => c.kind === 'take');
        const takeDone = legal.find((c) => c.kind === 'takeDone');
        if (takes.length === 0) return takeDone as SplendorChoice;
        const best = pickBest(takes, (c) => colorNeedScore(c.color, self, weights), (c) => c.color, rng);
        const bestScore = colorNeedScore(best.color, self, weights);
        if (bestScore <= 0 && takeDone) return takeDone;
        return best;
      }

      // decisionPoint === 'action'
      const buys = legal.filter((c): c is Extract<SplendorChoice, { kind: 'buy' }> => c.kind === 'buy');
      if (buys.length > 0) {
        return pickBest(
          buys,
          (c) => {
            const card = findCard(observation, c.cardId);
            return card ? buyScore(card, self, weights, phase) : -Infinity;
          },
          (c) => c.cardId,
          rng,
        );
      }

      const takes = legal.filter((c): c is Extract<SplendorChoice, { kind: 'take' }> => c.kind === 'take');
      if (takes.length > 0) {
        return pickBest(takes, (c) => colorNeedScore(c.color, self, weights), (c) => c.color, rng);
      }

      const reserves = legal.filter(
        (c): c is Extract<SplendorChoice, { kind: 'reserve' }> | Extract<SplendorChoice, { kind: 'reserveBlind' }> =>
          c.kind === 'reserve' || c.kind === 'reserveBlind',
      );
      if (reserves.length > 0) {
        return pickBest(
          reserves,
          (c) => {
            if (c.kind === 'reserve') {
              const card = findCard(observation, c.cardId);
              return card ? reserveScore(card, self, weights, phase) : -Infinity;
            }
            return reserveBlindScore(c.level, phase);
          },
          encodeChoiceKey,
          rng,
        );
      }

      const discards = legal.filter((c): c is Extract<SplendorChoice, { kind: 'discard' }> => c.kind === 'discard');
      if (discards.length > 0) {
        return pickBest(discards, (c) => -discardNeedValue(c.gem, self, weights), (c) => c.gem, rng);
      }

      const takeDone = legal.find((c) => c.kind === 'takeDone');
      if (takeDone) return takeDone;

      return legal[0] as SplendorChoice;
    },
  };
};
