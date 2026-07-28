/**
 * dominion-engine-bot — L3 holdout anchor for the dominion anchor ladder
 * (docs/GAP-ANALYSIS-11.md D3 / docs/adr/0012, Phase 1-D).
 *
 * Designed WITHOUT reading the L2 Opus bot (../dominion-opus-bot.ts) or the L1
 * mid bot (../dominion-mid-bot.ts) — the whole point of a holdout anchor is that
 * its decision fingerprint is independent of the anchors already in the ladder,
 * so this file's strategy was written from the game rules alone. It is measured
 * against L2 only through the fingerprint-distance gate in
 * ../runners/dominion-anchor-ladder.ts (agreementRate < 0.7), never by copying.
 *
 * Style ("third style", deliberately not a Province rush and not a big-money
 * mirror): grow the economy/engine first, convert to victory points late.
 *   - Growth phase (Province pile >= 5 left): buy Gold > the strongest drawing
 *     kingdom action > Silver, and never buy a victory card (deck pollution).
 *   - Endgame phase (Province pile <= 4 left): buy Province > Duchy > Estate
 *     (Estate only when the pile is nearly out) > Silver.
 *   - Action phase (both phases): play drawing actions first, then coin actions,
 *     cheapest first so cantrip/village effects resolve before terminals.
 *
 * Determinism: pure function of (decisionPoint, observation, legal). Every tie
 * is broken by card name (alphabetical), so no RNG is consumed at all — the
 * `seed` parameter exists only to satisfy BotFactory. No Date.now/Math.random
 * (banned outside app boundaries by src/__tests__/dependency-rules.test.ts).
 */

import type { BotFactory, GameBot } from '../../contract/types';
import type { CardName, DominionChoice, DominionObservation } from '../dominion';

const BOT_ID = 'dominion-engine-l3';

/** Province pile size at or above which we are still in the growth phase. */
const GROWTH_PROVINCE_FLOOR = 5;
/** Province pile size at or below which Estate is worth buying in the endgame. */
const ESTATE_PROVINCE_FLOOR = 2;
/** Duchy is bought in the endgame only inside this coin window. */
const DUCHY_COIN_MIN = 5;
const DUCHY_COIN_MAX = 7;
/** Never Chapel the deck below this many Coppers — trashing the economy loses. */
const MIN_COPPERS_KEPT = 3;
/** Cards cheaper than this are not worth a fallback buy. */
const FALLBACK_MIN_COST = 3;

interface CardInfo {
  readonly cost: number;
  readonly isAction: boolean;
  readonly isVictoryOrCurse: boolean;
  readonly cards: number;
  readonly coins: number;
}

/**
 * Local copy of the fields this bot needs from ../dominion's CARD_DEFS, which
 * is module-private there. Kept minimal on purpose (cost/type/+cards/+coins).
 */
const CARD_INFO: Readonly<Record<CardName, CardInfo>> = {
  Copper: { cost: 0, isAction: false, isVictoryOrCurse: false, cards: 0, coins: 1 },
  Silver: { cost: 3, isAction: false, isVictoryOrCurse: false, cards: 0, coins: 2 },
  Gold: { cost: 6, isAction: false, isVictoryOrCurse: false, cards: 0, coins: 3 },
  Estate: { cost: 2, isAction: false, isVictoryOrCurse: true, cards: 0, coins: 0 },
  Duchy: { cost: 5, isAction: false, isVictoryOrCurse: true, cards: 0, coins: 0 },
  Province: { cost: 8, isAction: false, isVictoryOrCurse: true, cards: 0, coins: 0 },
  Curse: { cost: 0, isAction: false, isVictoryOrCurse: true, cards: 0, coins: 0 },
  Village: { cost: 3, isAction: true, isVictoryOrCurse: false, cards: 1, coins: 0 },
  Smithy: { cost: 4, isAction: true, isVictoryOrCurse: false, cards: 3, coins: 0 },
  Laboratory: { cost: 5, isAction: true, isVictoryOrCurse: false, cards: 2, coins: 0 },
  Festival: { cost: 5, isAction: true, isVictoryOrCurse: false, cards: 0, coins: 2 },
  Market: { cost: 5, isAction: true, isVictoryOrCurse: false, cards: 1, coins: 1 },
  Woodcutter: { cost: 3, isAction: true, isVictoryOrCurse: false, cards: 0, coins: 2 },
  CouncilRoom: { cost: 5, isAction: true, isVictoryOrCurse: false, cards: 4, coins: 0 },
  Witch: { cost: 5, isAction: true, isVictoryOrCurse: false, cards: 2, coins: 0 },
  Militia: { cost: 4, isAction: true, isVictoryOrCurse: false, cards: 0, coins: 2 },
  Moat: { cost: 2, isAction: true, isVictoryOrCurse: false, cards: 2, coins: 0 },
  Chapel: { cost: 2, isAction: true, isVictoryOrCurse: false, cards: 0, coins: 0 },
  Workshop: { cost: 3, isAction: true, isVictoryOrCurse: false, cards: 0, coins: 0 },
};

type BuyChoice = Extract<DominionChoice, { kind: 'buy' }>;
type PlayChoice = Extract<DominionChoice, { kind: 'playAction' }>;
type TrashChoice = Extract<DominionChoice, { kind: 'trashCard' }>;
type GainChoice = Extract<DominionChoice, { kind: 'gainCard' }>;
type DiscardChoice = Extract<DominionChoice, { kind: 'discardCard' }>;

function ofKind<K extends DominionChoice['kind']>(
  legal: readonly DominionChoice[],
  kind: K,
): Extract<DominionChoice, { kind: K }>[] {
  return legal.filter((choice): choice is Extract<DominionChoice, { kind: K }> => choice.kind === kind);
}

function firstOfKind(legal: readonly DominionChoice[], kind: DominionChoice['kind']): DominionChoice | undefined {
  return legal.find((choice) => choice.kind === kind);
}

/** Deterministic ordering key: cheapest first (or dearest first), name breaks ties. */
function orderByCost<T extends { readonly card: CardName }>(choices: readonly T[], dearestFirst: boolean): T[] {
  return [...choices].sort((a, b) => {
    const costDiff = CARD_INFO[a.card].cost - CARD_INFO[b.card].cost;
    if (costDiff !== 0) return dearestFirst ? -costDiff : costDiff;
    return a.card < b.card ? -1 : a.card > b.card ? 1 : 0;
  });
}

function buyOf(buys: readonly BuyChoice[], card: CardName): BuyChoice | undefined {
  return buys.find((choice) => choice.card === card);
}

/** Total copies of `card` the bot owns across hand, play, discard and draw pile. */
function ownedCount(observation: DominionObservation, card: CardName): number {
  const own = observation.own;
  const inZone = (zone: readonly CardName[]): number => zone.reduce((sum, c) => sum + (c === card ? 1 : 0), 0);
  return inZone(own.hand) + inZone(own.play) + inZone(own.discard) + (own.deckComposition[card] ?? 0);
}

function isGrowthPhase(observation: DominionObservation): boolean {
  return observation.supply.Province >= GROWTH_PROVINCE_FLOOR;
}

/** Play drawing actions first, then coin actions; cheapest first inside each tier. */
function chooseAction(legal: readonly DominionChoice[]): DominionChoice {
  const plays: PlayChoice[] = ofKind(legal, 'playAction');
  const drawers = plays.filter((choice) => CARD_INFO[choice.card].cards > 0);
  const coiners = plays.filter((choice) => CARD_INFO[choice.card].cards === 0 && CARD_INFO[choice.card].coins > 0);
  const tier = drawers.length > 0 ? drawers : coiners;
  const best = orderByCost(tier, false)[0];
  if (best) return best;
  return firstOfKind(legal, 'endActions') ?? (legal[0] as DominionChoice);
}

/**
 * Last-resort buy (spec item 6): dearest affordable non-Curse card. Only
 * reachable if `endBuy` is somehow not offered — buyPhaseChoices always offers
 * it — so this exists purely so the bot can never return an illegal choice.
 */
function fallbackBuy(buys: readonly BuyChoice[], legal: readonly DominionChoice[]): DominionChoice {
  const affordable = buys.filter(
    (choice) => choice.card !== 'Curse' && CARD_INFO[choice.card].cost >= FALLBACK_MIN_COST,
  );
  return orderByCost(affordable, true)[0] ?? firstOfKind(legal, 'endBuy') ?? (legal[0] as DominionChoice);
}

function chooseBuy(observation: DominionObservation, legal: readonly DominionChoice[]): DominionChoice {
  const buys: BuyChoice[] = ofKind(legal, 'buy');
  const endBuy = firstOfKind(legal, 'endBuy');

  if (isGrowthPhase(observation)) {
    // Growth: Gold > strongest drawing action > Silver. Never a victory card.
    const gold = buyOf(buys, 'Gold');
    if (gold) return gold;
    const drawEngine = buys.filter(
      (choice) => CARD_INFO[choice.card].isAction && CARD_INFO[choice.card].cards > 0,
    );
    const bestEngine = orderByCost(drawEngine, true)[0];
    if (bestEngine) return bestEngine;
    const silver = buyOf(buys, 'Silver');
    if (silver) return silver;
    return endBuy ?? fallbackBuy(buys, legal);
  }

  // Endgame: green out, hardest card first.
  const province = buyOf(buys, 'Province');
  if (province) return province;
  const duchy = buyOf(buys, 'Duchy');
  if (duchy && observation.coins >= DUCHY_COIN_MIN && observation.coins <= DUCHY_COIN_MAX) return duchy;
  const estate = buyOf(buys, 'Estate');
  if (estate && observation.supply.Province <= ESTATE_PROVINCE_FLOOR) return estate;
  const silver = buyOf(buys, 'Silver');
  if (silver) return silver;
  return endBuy ?? fallbackBuy(buys, legal);
}

/** Chapel: trash Curse, then Estate, then surplus Copper. Stop otherwise. */
function chooseTrash(observation: DominionObservation, legal: readonly DominionChoice[]): DominionChoice {
  const trashables: TrashChoice[] = ofKind(legal, 'trashCard');
  const done = firstOfKind(legal, 'doneTrash');
  const curse = trashables.find((choice) => choice.card === 'Curse');
  if (curse) return curse;
  const estate = trashables.find((choice) => choice.card === 'Estate');
  if (estate) return estate;
  const copper = trashables.find((choice) => choice.card === 'Copper');
  if (copper && ownedCount(observation, 'Copper') > MIN_COPPERS_KEPT) return copper;
  return done ?? (legal[0] as DominionChoice);
}

/** Workshop: take the dearest gain on offer (the engine caps cost at 4). */
function chooseGain(legal: readonly DominionChoice[]): DominionChoice {
  const gains: GainChoice[] = ofKind(legal, 'gainCard');
  const wanted = gains.filter((choice) => choice.card !== 'Curse');
  return orderByCost(wanted, true)[0] ?? orderByCost(gains, true)[0] ?? (legal[0] as DominionChoice);
}

/** Militia defence: pitch dead cards (victory/Curse) first, then the cheapest card. */
function chooseDiscard(legal: readonly DominionChoice[]): DominionChoice {
  const discards: DiscardChoice[] = ofKind(legal, 'discardCard');
  const dead = discards.filter((choice) => CARD_INFO[choice.card].isVictoryOrCurse);
  const tier = dead.length > 0 ? dead : discards;
  return orderByCost(tier, false)[0] ?? (legal[0] as DominionChoice);
}

export const dominionEngineBot: BotFactory<DominionObservation, DominionChoice> = (
  _seed: number,
): GameBot<DominionObservation, DominionChoice> => ({
  id: BOT_ID,
  decide(_decisionPoint, observation, legal) {
    if (legal.length === 0) throw new Error(`${BOT_ID}: no legal choices`);
    if (legal.some((choice) => choice.kind === 'trashCard' || choice.kind === 'doneTrash')) {
      return chooseTrash(observation, legal);
    }
    if (legal.some((choice) => choice.kind === 'gainCard')) return chooseGain(legal);
    if (legal.some((choice) => choice.kind === 'discardCard')) return chooseDiscard(legal);
    if (legal.some((choice) => choice.kind === 'endActions' || choice.kind === 'playAction')) {
      return chooseAction(legal);
    }
    if (legal.some((choice) => choice.kind === 'endBuy' || choice.kind === 'buy')) {
      return chooseBuy(observation, legal);
    }
    return legal[0] as DominionChoice;
  },
});
