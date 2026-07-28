/**
 * dominion-mid-bot — L1 anchor rung (docs/GAP-ANALYSIS-11.md D3/Phase 1-C):
 * an independent, one-shot mid-skill design meant to sit strictly between
 * `baselines.heuristic` and the L2 anchor (../experiments/dominion-opus-bot.ts)
 * on the anchor ladder. Designed from scratch by reading this game's adapter
 * (../dominion.ts) — NOT by copying dominion-opus-bot.ts's owned-card tally,
 * endgame-greening logic, or Chapel-thinning heuristics, per the task brief's
 * "no logic copy" rule.
 *
 * L1 grade — "knows Big-Money-plus-Witch basics, no foresight":
 *   Buy priority (fixed, no memory of what has already been bought):
 *     1. Province whenever affordable (>= 8 coins) — a mid-skill player knows
 *        greening beats hoarding, unlike the adapter's own heuristic baseline,
 *        which treats Province as lowest priority.
 *     2. Gold at >= 6 coins.
 *     3. At 5 coins: Witch (the strongest single card in this pool) if the
 *        Curse supply is not empty, else Laboratory.
 *     4. Silver at >= 3 coins.
 *   Action priority (fixed order, no draw-vs-terminal cantrip sequencing):
 *     Village > Laboratory > Market > Festival > Witch > CouncilRoom > Smithy
 *     > Militia > Moat, else end the phase. Chapel/Workshop are only ever
 *     played reactively when nothing above is available (no deliberate
 *     thinning plan, no gain-target logic beyond "take the priciest legal
 *     gain").
 * Deliberately missing (the ceiling that keeps this below the L2 anchor):
 * no per-game card tally (so no "stop buying Witch #3", no pile-out
 * awareness beyond the flat Province rule above), no Chapel timing plan, no
 * endgame Duchy/Estate greening once Provinces run low, no discard-priority
 * refinement for Militia beyond junk-first.
 *
 * Layer: reference/ — imports only contract/kernel types plus sibling
 * ../dominion for its exported types (dependency-rules.test.ts's reference-
 * layer edges). Randomness flows through createRng(seed), used only for
 * deterministic fallback tie-breaking (C1 determinism rule).
 */

import type { BotFactory } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import type { CardName, DominionChoice, DominionObservation } from '../dominion';

const COST: Readonly<Record<CardName, number>> = {
  Copper: 0,
  Silver: 3,
  Gold: 6,
  Estate: 2,
  Duchy: 5,
  Province: 8,
  Curse: 0,
  Village: 3,
  Smithy: 4,
  Laboratory: 5,
  Festival: 5,
  Market: 5,
  Woodcutter: 3,
  CouncilRoom: 5,
  Witch: 5,
  Militia: 4,
  Moat: 2,
  Chapel: 2,
  Workshop: 3,
};

const ACTION_PRIORITY: readonly CardName[] = [
  'Village',
  'Laboratory',
  'Market',
  'Festival',
  'Witch',
  'CouncilRoom',
  'Smithy',
  'Militia',
  'Moat',
];

const DISCARD_JUNK_FIRST: readonly CardName[] = ['Curse', 'Estate', 'Copper'];

function has(legal: readonly DominionChoice[], predicate: (c: DominionChoice) => boolean): DominionChoice | undefined {
  return legal.find(predicate);
}

function buyOf(legal: readonly DominionChoice[], card: CardName): DominionChoice | undefined {
  return has(legal, (c) => c.kind === 'buy' && c.card === card);
}

function chooseBuy(observation: DominionObservation, legal: readonly DominionChoice[]): DominionChoice {
  const coins = observation.coins;

  // 1. Province the instant it is affordable — the one lesson this bot
  // learned that the heuristic baseline never did.
  if (coins >= COST.Province) {
    const province = buyOf(legal, 'Province');
    if (province) return province;
  }

  // 2. Gold funds everything else.
  if (coins >= COST.Gold) {
    const gold = buyOf(legal, 'Gold');
    if (gold) return gold;
  }

  // 3. The 5-cost slot: Witch while Curses remain (junking the opponent is
  // strictly good), else Laboratory for smoother draws.
  if (coins >= 5) {
    if ((observation.supply.Curse ?? 0) > 0) {
      const witch = buyOf(legal, 'Witch');
      if (witch) return witch;
    }
    const lab = buyOf(legal, 'Laboratory');
    if (lab) return lab;
  }

  // 4. Silver otherwise.
  if (coins >= COST.Silver) {
    const silver = buyOf(legal, 'Silver');
    if (silver) return silver;
  }

  return has(legal, (c) => c.kind === 'endBuy') ?? (legal[0] as DominionChoice);
}

function chooseAction(_observation: DominionObservation, legal: readonly DominionChoice[]): DominionChoice {
  for (const name of ACTION_PRIORITY) {
    const found = has(legal, (c) => c.kind === 'playAction' && c.card === name);
    if (found) return found;
  }
  // Chapel/Workshop have no dedicated plan for this bot — only played when
  // nothing on the fixed priority list is available.
  const chapel = has(legal, (c) => c.kind === 'playAction' && c.card === 'Chapel');
  if (chapel) return chapel;
  const workshop = has(legal, (c) => c.kind === 'playAction' && c.card === 'Workshop');
  if (workshop) return workshop;
  return has(legal, (c) => c.kind === 'endActions') ?? (legal[0] as DominionChoice);
}

function chooseTrash(_observation: DominionObservation, legal: readonly DominionChoice[]): DominionChoice {
  for (const name of ['Curse', 'Estate'] as const) {
    const found = has(legal, (c) => c.kind === 'trashCard' && c.card === name);
    if (found) return found;
  }
  return has(legal, (c) => c.kind === 'doneTrash') ?? (legal[0] as DominionChoice);
}

function chooseGain(_observation: DominionObservation, legal: readonly DominionChoice[]): DominionChoice {
  // No plan for what to gain — just take the priciest legal gain, same as
  // "money is always fine" reasoning without any pile-out or timing
  // awareness.
  let best: DominionChoice = legal[0] as DominionChoice;
  let bestCost = -1;
  for (const c of legal) {
    if (c.kind === 'gainCard' && COST[c.card] > bestCost) {
      bestCost = COST[c.card];
      best = c;
    }
  }
  return best;
}

function chooseDiscard(_observation: DominionObservation, legal: readonly DominionChoice[]): DominionChoice {
  for (const name of DISCARD_JUNK_FIRST) {
    const found = has(legal, (c) => c.kind === 'discardCard' && c.card === name);
    if (found) return found;
  }
  return legal[0] as DominionChoice;
}

export const dominionMidBot: BotFactory<DominionObservation, DominionChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'dominion-mid-l1',
    decide(decisionPoint, observation, legal) {
      if (legal.length === 1) return legal[0] as DominionChoice;
      switch (decisionPoint) {
        case 'buy':
          return chooseBuy(observation, legal);
        case 'action':
          return chooseAction(observation, legal);
        case 'chapelTrash':
          return chooseTrash(observation, legal);
        case 'workshopGain':
          return chooseGain(observation, legal);
        case 'militiaDiscard':
          return chooseDiscard(observation, legal);
        default:
          return legal[rng.nextInt(legal.length)] as DominionChoice;
      }
    },
  };
};
