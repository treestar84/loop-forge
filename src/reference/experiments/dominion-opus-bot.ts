/**
 * dominion-opus-bot — a from-scratch heuristic Dominion bot designed in ONE
 * pass ("what would a strong Dominion player do with this 12-card kingdom?"),
 * WITHOUT ever touching Loop Forge's scoring / wave / gate machinery. This is
 * the "just ask the LLM to design a bot" arm of the benchmark experiment
 * (docs/BENCHMARK-EXPERIMENT.md, column A) — a comparison subject deliberately
 * kept OUT of the game adapter's strategySurface so it is never confused with a
 * pipeline-validated strategy.
 *
 * Layer: lives in `reference/` and imports only from `contract`, `kernel`, and
 * its sibling `../dominion` (types + card metadata) — the reference layer's
 * allowed edges (src/__tests__/dependency-rules.test.ts). All randomness flows
 * through `createRng(seed)` (used only for deterministic tie-breaking); no
 * Date.now()/Math.random() (determinism rule).
 *
 * Design — "Witch–Big-Money with light engine + Chapel thinning":
 *
 *   The single biggest weakness of the adapter's heuristic baseline is its buy
 *   order: it treats Province/Duchy/Estate as the LOWEST priority ("buy only
 *   when nothing else is affordable"), so it hoards Gold and cantrips and almost
 *   never actually greens — it cannot close a game on victory points. A
 *   competent human does the opposite: buy the Province the instant you can
 *   afford it, and race the pile down.
 *
 *   Buy policy (highest priority first):
 *     1. Province at >= 8 coins — always. Winning needs VP on the board.
 *     2. Endgame greening: once the Province pile is low, start taking Duchies
 *        (and finally Estates) to win the pile-out / VP split.
 *     3. Gold at >= 6.
 *     4. At 5 coins: Witch (the strongest card in this pool — +2 cards AND
 *        junks the opponent's deck with a Curse) up to 2 copies, then a couple
 *        of Laboratories for smoother draws, otherwise Silver.
 *     5. One early Chapel to trash starting Estates and surplus Coppers so the
 *        deck reliably hits 8 coins for Provinces.
 *     6. Silver at >= 3.
 *
 *   Action policy: play all non-terminal cantrips first (drawing ones first, so
 *   they can dig into more actions), then spend the last action on the best
 *   terminal — Witch > Council Room > Smithy > Militia — playing Chapel only
 *   when there is genuine junk to trash and Workshop only when a gain helps.
 *
 *   Because the adapter only exposes the bot's OWN hand/discard/play (the draw
 *   pile is hidden — this is not a perfect-information game), the bot keeps an
 *   internal, fully-deterministic tally of every card it has acquired or
 *   trashed so it can reason about how many Witches/Labs/Coppers it owns. The
 *   tally is per-game closure state (a fresh factory instance is created for
 *   every match), so nothing leaks between games.
 */

import type { BotFactory } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import type {
  CardName,
  DominionChoice,
  DominionObservation,
} from '../dominion';

// Local copy of the cards' salient stats. The adapter does not export CARD_DEFS,
// and per the layer rules this file may not reach into the adapter's internals,
// so the handful of facts the policy needs are transcribed here.
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

// Non-terminal action cards (grant >= 1 action back, so they never cost the
// turn), ordered by how many cards they draw — draw first so a cantrip can dig
// into further actions before a terminal is committed.
const NONTERMINAL_ORDER: readonly CardName[] = ['Laboratory', 'Village', 'Market', 'Festival'];

// Terminal action cards, best first. Witch both draws and junks the opponent;
// Council Room and Smithy are pure draw; Militia is a mild attack. Chapel and
// Workshop are handled separately (they are only worth an action conditionally).
const TERMINAL_ORDER: readonly CardName[] = ['Witch', 'CouncilRoom', 'Smithy', 'Militia'];

// When forced to discard to Militia, shed the most useless cards first and keep
// treasures / actions.
const MILITIA_DISCARD_ORDER: readonly CardName[] = [
  'Curse',
  'Estate',
  'Copper',
  'Moat',
  'Workshop',
  'Woodcutter',
  'Chapel',
  'Militia',
  'Duchy',
  'Province',
  'Village',
  'Smithy',
  'Festival',
  'Market',
  'CouncilRoom',
  'Laboratory',
  'Witch',
  'Silver',
  'Gold',
];

const MAX_WITCHES = 2;
const MAX_LABS = 3;
const KEEP_COPPERS = 3; // never Chapel below this many Coppers — economy floor.
// "Early game" for the one-time Chapel buy = economy not yet developed. Derived
// from the owned tally (deterministic) rather than a turn counter, because a
// turn that ends with buys already spent never routes through an endBuy
// decision this bot can observe.
const EARLY_ECONOMY_LIMIT = 2; // still early while owning <= this many Silver+Gold.

function has(legal: readonly DominionChoice[], predicate: (c: DominionChoice) => boolean): DominionChoice | undefined {
  return legal.find(predicate);
}

function buyOf(legal: readonly DominionChoice[], card: CardName): DominionChoice | undefined {
  return has(legal, (c) => c.kind === 'buy' && c.card === card);
}

export const dominionOpusBot: BotFactory<DominionObservation, DominionChoice> = (seed) => {
  const rng = createRng(seed);

  // Deterministic per-game tally of every card this bot owns. Seeded with the
  // fixed Dominion starting deck (7 Copper + 3 Estate); updated whenever the bot
  // decides to buy/gain (adds) or trash (removes) a card. Every choice the bot
  // returns is applied by the engine, so this stays exactly in sync with the
  // (partly hidden) real deck.
  const owned: Record<CardName, number> = {
    Copper: 7,
    Silver: 0,
    Gold: 0,
    Estate: 3,
    Duchy: 0,
    Province: 0,
    Curse: 0,
    Village: 0,
    Smithy: 0,
    Laboratory: 0,
    Festival: 0,
    Market: 0,
    Woodcutter: 0,
    CouncilRoom: 0,
    Witch: 0,
    Militia: 0,
    Moat: 0,
    Chapel: 0,
    Workshop: 0,
  };

  function chooseBuy(observation: DominionObservation, legal: readonly DominionChoice[]): DominionChoice {
    const supply = observation.supply;
    const coins = observation.coins;
    const provinceLeft = supply.Province ?? 0;

    // 1. Always take a Province when you can afford it.
    if (coins >= COST.Province) {
      const province = buyOf(legal, 'Province');
      if (province) return record(province);
    }

    // 2. Endgame greening. Once Provinces run low, victory density wins the
    //    pile-out and the VP split, so start banking Duchies then Estates.
    if (provinceLeft <= 4) {
      const duchy = buyOf(legal, 'Duchy');
      if (duchy && coins >= COST.Duchy) return record(duchy);
    }
    if (provinceLeft <= 2) {
      const estate = buyOf(legal, 'Estate');
      if (estate && coins >= COST.Estate) return record(estate);
    }

    // 3. Gold is the economy engine of Big Money.
    if (coins >= COST.Gold) {
      const gold = buyOf(legal, 'Gold');
      if (gold) return record(gold);
    }

    // 4. The 5-cost slot: Witch first (attack + draw), then a few Labs, else Silver.
    if (coins >= 5) {
      if (owned.Witch < MAX_WITCHES) {
        const witch = buyOf(legal, 'Witch');
        if (witch) return record(witch);
      }
      if (owned.Laboratory < MAX_LABS) {
        const lab = buyOf(legal, 'Laboratory');
        if (lab) return record(lab);
      }
    }

    // 5. An early Chapel to thin starting Estates/Coppers so the deck reliably
    //    reaches 8 coins for Provinces.
    if (owned.Chapel === 0 && owned.Silver + owned.Gold <= EARLY_ECONOMY_LIMIT && coins >= COST.Chapel) {
      const chapel = buyOf(legal, 'Chapel');
      if (chapel) return record(chapel);
    }

    // 6. Silver whenever nothing better is affordable.
    if (coins >= COST.Silver) {
      const silver = buyOf(legal, 'Silver');
      if (silver) return record(silver);
    }

    // Nothing worth buying (e.g. only Copper/Curse left) — end the phase.
    return has(legal, (c) => c.kind === 'endBuy') ?? (legal[0] as DominionChoice);
  }

  function record(choice: DominionChoice): DominionChoice {
    if (choice.kind === 'buy' || choice.kind === 'gainCard') {
      owned[choice.card] += 1;
    }
    return choice;
  }

  function chooseAction(observation: DominionObservation, legal: readonly DominionChoice[]): DominionChoice {
    const hand = observation.own.hand;

    // Non-terminal cantrips first (they cost no net action), draw-heavy first.
    for (const name of NONTERMINAL_ORDER) {
      const found = has(legal, (c) => c.kind === 'playAction' && c.card === name);
      if (found) return found;
    }

    // Best terminal next.
    for (const name of TERMINAL_ORDER) {
      if (name === 'Witch' && (observation.supply.Curse ?? 0) === 0) {
        continue; // Witch with no Curses left is just a weak Smithy; defer to real draw.
      }
      const found = has(legal, (c) => c.kind === 'playAction' && c.card === name);
      if (found) return found;
    }

    // Chapel: only worth an action when there is real junk to shed.
    const junkInHand = hand.some((c) => c === 'Curse' || c === 'Estate') || countIn(hand, 'Copper') > 0;
    if (junkInHand) {
      const chapel = has(legal, (c) => c.kind === 'playAction' && c.card === 'Chapel');
      if (chapel) return chapel;
    }

    // Workshop: gain a Silver (or a late Estate) — worth an action while it ramps.
    const workshop = has(legal, (c) => c.kind === 'playAction' && c.card === 'Workshop');
    if (workshop) return workshop;

    return has(legal, (c) => c.kind === 'endActions') ?? (legal[0] as DominionChoice);
  }

  function chooseTrash(_observation: DominionObservation, legal: readonly DominionChoice[]): DominionChoice {
    // Trash order: Curse (dead weight) > Estate (dead early) > surplus Copper.
    const curse = has(legal, (c) => c.kind === 'trashCard' && c.card === 'Curse');
    if (curse) return removeCard(curse);
    const estate = has(legal, (c) => c.kind === 'trashCard' && c.card === 'Estate');
    if (estate) return removeCard(estate);
    if (owned.Copper > KEEP_COPPERS) {
      const copper = has(legal, (c) => c.kind === 'trashCard' && c.card === 'Copper');
      if (copper) return removeCard(copper);
    }
    return has(legal, (c) => c.kind === 'doneTrash') ?? (legal[0] as DominionChoice);
  }

  function removeCard(choice: DominionChoice): DominionChoice {
    if (choice.kind === 'trashCard') {
      owned[choice.card] = Math.max(0, owned[choice.card] - 1);
    }
    return choice;
  }

  function chooseGain(observation: DominionObservation, legal: readonly DominionChoice[]): DominionChoice {
    const provinceLeft = observation.supply.Province ?? 0;
    // Late game: a Workshop'd Estate is board VP. Otherwise take Silver for economy.
    if (provinceLeft <= 2) {
      const estate = has(legal, (c) => c.kind === 'gainCard' && c.card === 'Estate');
      if (estate) return record(estate);
    }
    const silver = has(legal, (c) => c.kind === 'gainCard' && c.card === 'Silver');
    if (silver) return record(silver);
    // Fall back to the most expensive gainable card (best raw value).
    let best: DominionChoice = legal[0] as DominionChoice;
    let bestCost = -1;
    for (const c of legal) {
      if (c.kind === 'gainCard' && COST[c.card] > bestCost) {
        bestCost = COST[c.card];
        best = c;
      }
    }
    return record(best);
  }

  function chooseDiscard(_observation: DominionObservation, legal: readonly DominionChoice[]): DominionChoice {
    for (const name of MILITIA_DISCARD_ORDER) {
      const found = has(legal, (c) => c.kind === 'discardCard' && c.card === name);
      if (found) return found;
    }
    return legal[0] as DominionChoice;
  }

  return {
    id: 'dominion-opus',
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
          // Unknown decision point: fall back to a deterministic legal choice.
          return legal[rng.nextInt(legal.length)] as DominionChoice;
      }
    },
  };
};

function countIn(cards: readonly CardName[], name: CardName): number {
  return cards.reduce((sum, c) => sum + (c === name ? 1 : 0), 0);
}
