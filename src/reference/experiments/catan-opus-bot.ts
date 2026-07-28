/**
 * catan-opus-bot — a from-scratch heuristic Catan bot designed in ONE pass
 * ("what would a strong, informed player do at each decision point?"),
 * WITHOUT going through Loop Forge's scoring/wave/gate machinery. This is the
 * "just ask the LLM to design a bot" arm of the benchmark experiment
 * (docs/BENCHMARK-EXPERIMENT.md, column A) — deliberately kept OUT of the
 * game adapter's strategySurface so it is never confused with a
 * pipeline-validated strategy.
 *
 * Layer: this file lives in `reference/experiments/` and imports only from
 * `contract`, `kernel`, and its sibling `../catan` (types + board-topology
 * exports) — the reference layer's allowed edges
 * (src/__tests__/dependency-rules.test.ts). All randomness flows through
 * `createRng(seed)` (tie-breaking only); no Date.now()/Math.random()
 * (determinism rule).
 *
 * Design (single-shot heuristic, no lookahead search, no feedback from any
 * wave/gate — fixed after this one design pass), grounded in publicly known
 * standard Catan strategy:
 *
 *   - Initial placement (buildInitial, settlement step): scores every legal
 *     vertex by `pipSum` (sum of dice-probability "pips" — `6 - |7-n|`,
 *     so 6/8 score highest, 2/12 lowest — over the vertex's non-desert
 *     adjacent hexes) plus a `DIVERSITY_WEIGHT * distinctResourceCount` bonus
 *     (rewarding vertices that touch several different resource types over
 *     ones that stack the same resource three times), and picks the best
 *     (ties via the seeded RNG). This is the standard "maximize production
 *     probability, then diversify" opening heuristic. The road step's legal
 *     choices are already narrowed to edges touching the settlement just
 *     placed (see `legalInitialChoices` in ../catan), so any legal edge is
 *     equally fine there; picked via the RNG for determinism-with-variety
 *     rather than always index 0.
 *
 *   - Build phase (build): strict priority city > settlement > road >
 *     end-of-build ("toTrade"), i.e. always spend on the highest
 *     victory-point-density purchase available. Among multiple legal city/
 *     settlement vertices (rare but possible once several are affordable),
 *     re-uses the same pip+diversity scorer as placement. When neither a
 *     city nor a settlement is affordable, roads are scored by summing
 *     pip-weighted "need" (see `wantVector` below, targeting whichever of
 *     city/settlement is the next goal) over the resources produced by the
 *     hexes touching each edge's two vertices — i.e. "extend the road
 *     network toward the resources this player is short on for their next
 *     purchase," per the design brief, rather than toward board area in
 *     general.
 *
 *   - Bank trade (bankTrade): computes `wantVector` — the standard cost of
 *     whichever purchase is the player's next goal (a city if they already
 *     own an upgradeable settlement, else a settlement) — and its
 *     resource-by-resource shortfall against the current hand. Among legal
 *     4:1 trades, picks the one whose `get` resource has the largest
 *     shortfall, tie-broken by the largest surplus of the `give` resource;
 *     if no legal trade would reduce any shortfall (already able to afford
 *     the next goal, or no legal trade exists beyond ending the turn), ends
 *     the turn immediately rather than trading pointlessly.
 *
 *   - Discard-on-7 (discardHalf): mirrors bankTrade's `wantVector`/shortfall
 *     computation, but discards ONE CARD AT A TIME starting from whichever
 *     held resource is least needed for the next purchase (shortfall 0
 *     first, i.e. "the resource I'm not blocked on"), tie-broken by holding
 *     the largest quantity of it — "discard from the most-surplus pile,
 *     preferring resources that don't matter for what I'm building next," as
 *     specified.
 *
 *   - Robber (moveRobberAndSteal): identifies the current victory-point
 *     leader among opponents and, among legal (hex, target) choices that
 *     target that leader specifically, picks the hex with the highest pip
 *     count (their best production tile) — the standard "kingmaker
 *     suppression" move of hitting whoever is ahead where it hurts them
 *     most. If no legal choice targets the leader (e.g. the leader has no
 *     buildings adjacent to any legal hex, or holds no cards), falls back to
 *     targeting the highest-scoring opponent among the remaining legal
 *     choices; if every choice has a null target (nobody has cards), any
 *     legal choice is equally fine and the RNG picks among them.
 *
 * Every decision is deterministic given the bot's seed; the RNG is used only
 * to break genuine ties (initial-placement road step, robber choices with no
 * meaningful target) — never to imitate lookahead or planning.
 */

import type { BotFactory, PlayerId } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import type { CatanChoice, CatanObservation, Resource } from '../catan';
import { EDGE_VERTICES, VERTEX_HEXES } from '../catan';

type Rng = ReturnType<typeof createRng>;

const RESOURCES: readonly Resource[] = ['brick', 'wood', 'sheep', 'wheat', 'ore'];

/** Standard Catan base-game costs (public rules — not read off catan.ts's private consts). */
const SETTLEMENT_COST: Readonly<Record<Resource, number>> = { brick: 1, wood: 1, sheep: 1, wheat: 1, ore: 0 };
const CITY_COST: Readonly<Record<Resource, number>> = { brick: 0, wood: 0, sheep: 0, wheat: 2, ore: 3 };

/**
 * Weight applied to distinct-resource-type count when scoring a settlement
 * vertex, relative to pip sum (which ranges roughly 0-15 for a 3-hex
 * vertex). Kept modest so pip count (raw production probability) still
 * dominates, with diversity only nudging between otherwise-close options.
 */
const DIVERSITY_WEIGHT = 1.5;

function pipCount(n: number | null): number {
  if (n === null) return 0;
  return 6 - Math.abs(7 - n);
}

function bestByScore<T>(items: readonly T[], score: (item: T) => number, rng: Rng): T {
  let best: T[] = [];
  let bestScore = -Infinity;
  for (const item of items) {
    const s = score(item);
    if (s > bestScore) {
      bestScore = s;
      best = [item];
    } else if (s === bestScore) {
      best.push(item);
    }
  }
  return best[rng.nextInt(best.length)] as T;
}

function scoreSettlementVertex(vertex: number, tiles: CatanObservation['tiles']): number {
  const hexes = VERTEX_HEXES[vertex] as number[];
  let pipSum = 0;
  const seen = new Set<Resource>();
  for (const hex of hexes) {
    const tile = tiles[hex];
    if (tile === undefined || tile.resource === 'desert') continue;
    pipSum += pipCount(tile.number);
    seen.add(tile.resource as Resource);
  }
  return pipSum + seen.size * DIVERSITY_WEIGHT;
}

/** The resource cost of whichever purchase is this player's next goal:
 * a city if they already own an upgradeable settlement, else a settlement. */
function wantVector(observation: CatanObservation, self: PlayerId): Readonly<Record<Resource, number>> {
  const ownsSettlement = observation.buildings.some((b) => b !== null && b.owner === self && b.type === 'settlement');
  return ownsSettlement ? CITY_COST : SETTLEMENT_COST;
}

function shortfall(hand: CatanObservation['ownHand'], target: Readonly<Record<Resource, number>>): Record<Resource, number> {
  const result = {} as Record<Resource, number>;
  for (const r of RESOURCES) result[r] = Math.max(target[r] - hand[r], 0);
  return result;
}

// -----------------------------------------------------------------------
// buildInitial
// -----------------------------------------------------------------------

function decideBuildInitial(
  observation: CatanObservation,
  legal: readonly CatanChoice[],
  rng: Rng,
): CatanChoice {
  const first = legal[0];
  if (first?.kind === 'placeSettlement') {
    const settlementChoices = legal as Extract<CatanChoice, { kind: 'placeSettlement' }>[];
    return bestByScore(settlementChoices, (c) => scoreSettlementVertex(c.vertex, observation.tiles), rng);
  }
  // placeRoad: legal choices are already narrowed to edges touching the
  // settlement just placed — any of them is equally fine.
  return bestByScore(legal, () => 0, rng);
}

// -----------------------------------------------------------------------
// build
// -----------------------------------------------------------------------

function decideBuild(observation: CatanObservation, legal: readonly CatanChoice[], self: PlayerId, rng: Rng): CatanChoice {
  const cityChoices = legal.filter((c): c is Extract<CatanChoice, { kind: 'buildCity' }> => c.kind === 'buildCity');
  if (cityChoices.length > 0) {
    return bestByScore(cityChoices, (c) => scoreSettlementVertex(c.vertex, observation.tiles), rng);
  }
  const settlementChoices = legal.filter(
    (c): c is Extract<CatanChoice, { kind: 'buildSettlement' }> => c.kind === 'buildSettlement',
  );
  if (settlementChoices.length > 0) {
    return bestByScore(settlementChoices, (c) => scoreSettlementVertex(c.vertex, observation.tiles), rng);
  }
  const roadChoices = legal.filter((c): c is Extract<CatanChoice, { kind: 'buildRoad' }> => c.kind === 'buildRoad');
  if (roadChoices.length > 0) {
    const want = wantVector(observation, self);
    return bestByScore(
      roadChoices,
      (c) => {
        const [a, b] = EDGE_VERTICES[c.edge] as [number, number];
        let score = 0;
        for (const v of [a, b]) {
          for (const hex of VERTEX_HEXES[v] as number[]) {
            const tile = observation.tiles[hex];
            if (tile === undefined || tile.resource === 'desert') continue;
            score += pipCount(tile.number) * want[tile.resource as Resource];
          }
        }
        return score;
      },
      rng,
    );
  }
  return legal.find((c) => c.kind === 'toTrade') as CatanChoice;
}

// -----------------------------------------------------------------------
// bankTrade
// -----------------------------------------------------------------------

function decideBankTrade(observation: CatanObservation, legal: readonly CatanChoice[], self: PlayerId): CatanChoice {
  const tradeChoices = legal.filter((c): c is Extract<CatanChoice, { kind: 'bankTrade' }> => c.kind === 'bankTrade');
  const endTurn = legal.find((c) => c.kind === 'endTurn') as CatanChoice;
  if (tradeChoices.length === 0) return endTurn;
  const need = shortfall(observation.ownHand, wantVector(observation, self));
  let best: CatanChoice | null = null;
  let bestScore = 0;
  for (const c of tradeChoices) {
    const score = need[c.get] * 100 + observation.ownHand[c.give];
    if (need[c.get] > 0 && score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best ?? endTurn;
}

// -----------------------------------------------------------------------
// discardHalf
// -----------------------------------------------------------------------

function decideDiscard(observation: CatanObservation, legal: readonly CatanChoice[], rng: Rng): CatanChoice {
  const discardChoices = legal as Extract<CatanChoice, { kind: 'discard' }>[];
  const need = shortfall(observation.ownHand, wantVector(observation, observation.self));
  return bestByScore(discardChoices, (c) => -need[c.resource] * 1000 + observation.ownHand[c.resource], rng);
}

// -----------------------------------------------------------------------
// moveRobberAndSteal
// -----------------------------------------------------------------------

function decideRobber(observation: CatanObservation, legal: readonly CatanChoice[], self: PlayerId, rng: Rng): CatanChoice {
  const scores = observation.scores;
  let leader: PlayerId = -1 as PlayerId;
  let leaderScore = -1;
  for (let p = 0; p < scores.length; p += 1) {
    if (p === self) continue;
    if ((scores[p] as number) > leaderScore) {
      leaderScore = scores[p] as number;
      leader = p as PlayerId;
    }
  }
  const choices = legal as Extract<CatanChoice, { kind: 'moveRobberAndSteal' }>[];
  const onLeader = choices.filter((c) => c.target === leader);
  if (onLeader.length > 0) {
    return bestByScore(onLeader, (c) => pipCount(observation.tiles[c.hex]?.number ?? null), rng);
  }
  const anyTarget = choices.filter((c) => c.target !== null);
  if (anyTarget.length > 0) {
    return bestByScore(anyTarget, (c) => scores[c.target as number] ?? -1, rng);
  }
  return bestByScore(choices, () => 0, rng);
}

// -----------------------------------------------------------------------
// bot
// -----------------------------------------------------------------------

export const catanOpusBot: BotFactory<CatanObservation, CatanChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'catan-opus',
    decide(decisionPoint, observation, legal) {
      switch (decisionPoint) {
        case 'buildInitial':
          return decideBuildInitial(observation, legal as CatanChoice[], rng);
        case 'build':
          return decideBuild(observation, legal as CatanChoice[], observation.self, rng);
        case 'bankTrade':
          return decideBankTrade(observation, legal as CatanChoice[], observation.self);
        case 'discardHalf':
          return decideDiscard(observation, legal as CatanChoice[], rng);
        case 'moveRobberAndSteal':
          return decideRobber(observation, legal as CatanChoice[], observation.self, rng);
        default:
          throw new Error(`catan-opus: unknown decision point ${decisionPoint}`);
      }
    },
  };
};
