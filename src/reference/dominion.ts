/**
 * dominion — reference GameAdapter implementation onboarding a real open-source
 * game (https://github.com/rspeer/dominiate, gameState.coffee + cards.coffee)
 * onto Loop Forge.
 *
 * 2-player configuration only (see docs/ONBOARDING-GUIDE.md §2 "어댑터 1개 =
 * 게임 설정 1개"), Base-set-only card pool, and a deliberately incomplete card
 * subset (see "Card subset" below — docs/ONBOARDING-GUIDE.md §5.7 incremental
 * onboarding strategy for content-heavy games).
 *
 * Card subset (12 kingdom cards out of the ~25-card Base set, chosen for
 * simple, non-branching effects plus a light attack/reaction/sub-decision
 * surface so the multistep-turn pattern gets exercised):
 *   - Vanilla +cards/+actions/+coins/+buys: Village, Smithy, Laboratory,
 *     Festival, Market, Woodcutter, CouncilRoom (7).
 *   - Attacks: Witch (opponent gains a Curse), Militia (opponent discards
 *     down to 3 cards) (2).
 *   - Reaction: Moat (blocks attacks passively while in hand — no decision;
 *     it does not need to be *played* to react) (1).
 *   - Sub-decision cards: Chapel (trash up to 4 cards from hand), Workshop
 *     (gain one card costing <=4) (2).
 * Every game's 10-card kingdom is a seeded random 10-of-12 draw from this
 * pool (docs/GAP-ANALYSIS-2.md F8: kingdom selection is itself a good seed-
 * diversity source). The 13 cards NOT implemented (Bureaucrat, Remodel, Mine,
 * Throne Room, Council-Room-style duration cards, etc.) simply never appear —
 * per §5.7, unimplemented content is not declared anywhere in this adapter.
 *
 * Turn model, transcribed from the reference source (gameState.coffee
 * `doPlay`/`playActions`/`buyPhase`/`cleanup`) rather than the printed
 * Dominion rulebook:
 *   - action phase: play action cards (each name is one decision regardless
 *     of how many copies are in hand — copies are fungible) while
 *     actions > 0, or end the phase.
 *   - buy phase: all treasures in hand are auto-played (deliberate deviation,
 *     documented in the onboarding report — no implemented treasure has a
 *     variable/conditional effect, so playing all of them is always at least
 *     as good and removes a zero-information decision, the same rationale
 *     Splendor's `takeDone` synthesis uses for a different reason). Then buy
 *     cards while buys > 0 and coins allow, or end the phase.
 *   - cleanup: automatic — hand + play area go to discard, draw 5, reset
 *     actions/buys/coins, advance the active player. No decision point (the
 *     reference source's cleanup phase is unconditional bookkeeping).
 *
 * Hidden information: **not** perfect-information. A player's hand and draw-
 * pile order are hidden from the opponent in real Dominion (this differs
 * from Splendor, where the whole board is public) — only card *counts* are
 * exposed for the opponent in `getObservation`, and `hiddenInfoProbe`
 * reshuffles the opponent's hand+deck pool to prove the observation doesn't
 * depend on which specific cards sit in which of those two hidden zones.
 */

import type {
  BotFactory,
  GameAdapter,
  GameBot,
  HiddenInfoProbe,
  Outcome,
  PendingDecision,
  PlayerId,
  ReplayFixture,
  Rng,
  StrategyFlagSpec,
} from '../contract/types';
import { createRng, shuffled } from '../kernel/rng';
// `../experiments/dominion-opus-bot` is still the `reference` layer (only the
// top-level directory matters for src/__tests__/dependency-rules.test.ts's
// layer check), so this edge is allowed; the reverse edge
// (dominion-opus-bot.ts importing CardName/DominionChoice/DominionObservation
// from this file) is `import type`-only and erased at compile time, so there
// is no runtime circular import. Used only by `opusCloneDominion` below
// (GAP-11 Phase 4-C B4) to wrap the L2 feedback anchor as a strategy flag
// with zero drift risk from a hand-copied re-derivation.
import { dominionOpusBot } from './experiments/dominion-opus-bot';

export type CardName =
  | 'Copper'
  | 'Silver'
  | 'Gold'
  | 'Estate'
  | 'Duchy'
  | 'Province'
  | 'Curse'
  | 'Village'
  | 'Smithy'
  | 'Laboratory'
  | 'Festival'
  | 'Market'
  | 'Woodcutter'
  | 'CouncilRoom'
  | 'Witch'
  | 'Militia'
  | 'Moat'
  | 'Chapel'
  | 'Workshop';

interface CardDef {
  readonly name: CardName;
  readonly cost: number;
  readonly isAction: boolean;
  readonly isTreasure: boolean;
  readonly isVictory: boolean;
  readonly isAttack: boolean;
  readonly isReaction: boolean;
  readonly actions: number;
  readonly cards: number;
  readonly coins: number;
  readonly buys: number;
  readonly vp: number;
}

function card(name: CardName, props: Partial<Omit<CardDef, 'name'>>): CardDef {
  return {
    name,
    cost: 0,
    isAction: false,
    isTreasure: false,
    isVictory: false,
    isAttack: false,
    isReaction: false,
    actions: 0,
    cards: 0,
    coins: 0,
    buys: 0,
    vp: 0,
    ...props,
  };
}

const CARD_DEFS: Readonly<Record<CardName, CardDef>> = {
  Copper: card('Copper', { cost: 0, isTreasure: true, coins: 1 }),
  Silver: card('Silver', { cost: 3, isTreasure: true, coins: 2 }),
  Gold: card('Gold', { cost: 6, isTreasure: true, coins: 3 }),
  Estate: card('Estate', { cost: 2, isVictory: true, vp: 1 }),
  Duchy: card('Duchy', { cost: 5, isVictory: true, vp: 3 }),
  Province: card('Province', { cost: 8, isVictory: true, vp: 6 }),
  Curse: card('Curse', { cost: 0, vp: -1 }),
  Village: card('Village', { cost: 3, isAction: true, actions: 2, cards: 1 }),
  Smithy: card('Smithy', { cost: 4, isAction: true, cards: 3 }),
  Laboratory: card('Laboratory', { cost: 5, isAction: true, actions: 1, cards: 2 }),
  Festival: card('Festival', { cost: 5, isAction: true, actions: 2, coins: 2, buys: 1 }),
  Market: card('Market', { cost: 5, isAction: true, actions: 1, cards: 1, coins: 1, buys: 1 }),
  Woodcutter: card('Woodcutter', { cost: 3, isAction: true, coins: 2, buys: 1 }),
  CouncilRoom: card('CouncilRoom', { cost: 5, isAction: true, cards: 4, buys: 1 }),
  Witch: card('Witch', { cost: 5, isAction: true, isAttack: true, cards: 2 }),
  Militia: card('Militia', { cost: 4, isAction: true, isAttack: true, coins: 2 }),
  Moat: card('Moat', { cost: 2, isAction: true, isReaction: true, cards: 2 }),
  Chapel: card('Chapel', { cost: 2, isAction: true }),
  Workshop: card('Workshop', { cost: 3, isAction: true }),
};

const BASIC_CARDS: readonly CardName[] = ['Copper', 'Silver', 'Gold', 'Estate', 'Duchy', 'Province', 'Curse'];
const KINGDOM_POOL: readonly CardName[] = [
  'Village',
  'Smithy',
  'Laboratory',
  'Festival',
  'Market',
  'Woodcutter',
  'CouncilRoom',
  'Witch',
  'Militia',
  'Moat',
  'Chapel',
  'Workshop',
];
const KINGDOM_SIZE = 10;
const PLAYER_COUNT = 2;
const STARTING_COPPER = 7;
const STARTING_ESTATE = 3;
const STARTING_HAND_SIZE = 5;
const KINGDOM_SUPPLY = 10;
const TURN_CAP = 200; // total turns across both players; stalemate safety net (see G-Profile note below).

// Base-set 2-player starting supply counts (gameState.coffee startingSupply()).
const BASIC_STARTING_SUPPLY: Readonly<Record<CardName, number>> = {
  Copper: 60,
  Silver: 40,
  Gold: 30,
  Estate: 8,
  Duchy: 8,
  Province: 8,
  Curse: 10,
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

// Total universe count per card (market supply + any copies dealt directly
// into starting decks, which are not drawn from the market pile) — used by
// the card-conservation invariant.
function totalUniverse(card: CardName, kingdomCards: readonly CardName[]): number {
  if (card === 'Copper') return BASIC_STARTING_SUPPLY.Copper + STARTING_COPPER * PLAYER_COUNT;
  if (card === 'Estate') return BASIC_STARTING_SUPPLY.Estate + STARTING_ESTATE * PLAYER_COUNT;
  if (BASIC_STARTING_SUPPLY[card] > 0) return BASIC_STARTING_SUPPLY[card];
  return kingdomCards.includes(card) ? KINGDOM_SUPPLY : 0;
}

export interface PlayerState {
  readonly deck: readonly CardName[]; // draw pile; index 0 is the top card.
  readonly hand: readonly CardName[];
  readonly discard: readonly CardName[];
  readonly play: readonly CardName[]; // cards played this turn, face-up (public).
  readonly turnsTaken: number;
}

export type PendingSubdecision =
  | { readonly kind: 'chapelTrash'; readonly player: PlayerId; readonly remaining: number }
  | { readonly kind: 'workshopGain'; readonly player: PlayerId }
  | { readonly kind: 'militiaDiscard'; readonly player: PlayerId; readonly remaining: number };

export interface DominionState {
  readonly seed: number;
  readonly players: readonly [PlayerState, PlayerState];
  readonly supply: Readonly<Record<CardName, number>>;
  readonly kingdomCards: readonly CardName[];
  readonly active: PlayerId;
  readonly phase: 'action' | 'buy';
  readonly actions: number;
  readonly buys: number;
  readonly coins: number;
  readonly pending: PendingSubdecision | null;
  readonly reshuffleSeq: readonly [number, number];
  readonly gameOver: boolean;
  readonly playedKingdom: readonly CardName[];
  readonly trash: readonly CardName[];
}

export interface DominionObservation {
  readonly self: PlayerId;
  readonly active: PlayerId;
  readonly phase: 'action' | 'buy';
  readonly actions: number;
  readonly buys: number;
  readonly coins: number;
  readonly supply: Readonly<Record<CardName, number>>;
  readonly kingdomCards: readonly CardName[];
  readonly pending: PendingSubdecision | null;
  /**
   * Trash pile contents — public in real Dominion (any player may inspect
   * it), unlike either player's deck or the opponent's hand. Needed (see
   * `sampleStateFromObservation` below) so the card-conservation arithmetic
   * that separates "known" cards from the opponent's hidden hand+deck pool
   * has a place to put trashed cards; without it they'd silently get
   * miscounted into that hidden pool.
   */
  readonly trash: readonly CardName[];
  readonly own: {
    readonly hand: readonly CardName[];
    readonly discard: readonly CardName[];
    readonly play: readonly CardName[];
    readonly deckCount: number;
    /**
     * Multiset of card names in the viewer's own draw pile — order-free by
     * construction (a `Record`, not an array), since a real player knows
     * every card they've ever gained/drawn/discarded and therefore knows
     * their own deck's *composition*, but not the exact top-to-bottom draw
     * *order* (see `deck` doc comment on `PlayerState`: "index 0 is the top
     * card" — that ordering is exactly what stays hidden, even from the
     * owning player, and is what `sampleStateFromObservation` reshuffles).
     */
    readonly deckComposition: Readonly<Partial<Record<CardName, number>>>;
    readonly turnsTaken: number;
  };
  readonly opponent: {
    readonly handCount: number;
    readonly discard: readonly CardName[];
    readonly play: readonly CardName[];
    readonly deckCount: number;
    readonly turnsTaken: number;
  };
}

export type DominionChoice =
  | { readonly kind: 'playAction'; readonly card: CardName }
  | { readonly kind: 'endActions' }
  | { readonly kind: 'buy'; readonly card: CardName }
  | { readonly kind: 'endBuy' }
  | { readonly kind: 'trashCard'; readonly card: CardName }
  | { readonly kind: 'doneTrash' }
  | { readonly kind: 'gainCard'; readonly card: CardName }
  | { readonly kind: 'discardCard'; readonly card: CardName };

function otherPlayer(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

function getPlayer(state: DominionState, id: PlayerId): PlayerState {
  const player = state.players[id];
  if (!player) throw new Error(`getPlayer: no such player ${id}`);
  return player;
}

function withPlayer(
  state: DominionState,
  player: PlayerId,
  update: (p: PlayerState) => PlayerState,
): DominionState {
  const players: [PlayerState, PlayerState] = [...state.players];
  players[player] = update(getPlayer(state, player));
  return { ...state, players };
}

function uniqueNames(cards: readonly CardName[]): CardName[] {
  return [...new Set(cards)];
}

function countOf(cards: readonly CardName[], name: CardName): number {
  return cards.reduce((sum, c) => sum + (c === name ? 1 : 0), 0);
}

function removeOne(cards: readonly CardName[], name: CardName): CardName[] {
  const index = cards.indexOf(name);
  if (index === -1) throw new Error(`removeOne: ${name} not present`);
  return [...cards.slice(0, index), ...cards.slice(index + 1)];
}

function playerVP(player: PlayerState): number {
  const all = [...player.deck, ...player.hand, ...player.discard, ...player.play];
  return all.reduce((sum, c) => sum + CARD_DEFS[c].vp, 0);
}

// --- Deck management --------------------------------------------------

function reshuffle(state: DominionState, player: PlayerId): DominionState {
  const p = getPlayer(state, player);
  if (p.discard.length === 0) return state;
  const seq = state.reshuffleSeq[player] ?? 0;
  const rng = createRng(state.seed).fork('reshuffle').fork(`p${player}-${seq}`);
  const newDeck = shuffled(p.discard, rng);
  const reshuffleSeq: [number, number] = [...state.reshuffleSeq];
  reshuffleSeq[player] = seq + 1;
  return withPlayer({ ...state, reshuffleSeq }, player, (pl) => ({
    ...pl,
    deck: [...pl.deck, ...newDeck],
    discard: [],
  }));
}

function drawCards(state: DominionState, player: PlayerId, count: number): DominionState {
  let next = state;
  for (let i = 0; i < count; i += 1) {
    let p = getPlayer(next, player);
    if (p.deck.length === 0) {
      if (p.discard.length === 0) break; // deck genuinely exhausted; draw fewer, as the reference source allows.
      next = reshuffle(next, player);
      p = getPlayer(next, player);
      if (p.deck.length === 0) break;
    }
    const drawn = p.deck[0] as CardName;
    next = withPlayer(next, player, (pl) => ({ ...pl, deck: pl.deck.slice(1), hand: [...pl.hand, drawn] }));
  }
  return next;
}

// --- Setup --------------------------------------------------------------

export function createInitialState(seed: number): DominionState {
  const rng = createRng(seed);
  const kingdomCards = shuffled(KINGDOM_POOL, rng.fork('kingdom')).slice(0, KINGDOM_SIZE) as CardName[];

  const supply: Record<CardName, number> = { ...BASIC_STARTING_SUPPLY };
  for (const c of kingdomCards) supply[c] = KINGDOM_SUPPLY;

  const startingDeckFor = (index: number): CardName[] => {
    const raw: CardName[] = [
      ...Array(STARTING_COPPER).fill('Copper' as CardName),
      ...Array(STARTING_ESTATE).fill('Estate' as CardName),
    ];
    return shuffled(raw, rng.fork(`start-deck-${index}`));
  };

  const makePlayer = (index: number): PlayerState => ({
    deck: startingDeckFor(index),
    hand: [],
    discard: [],
    play: [],
    turnsTaken: 0,
  });

  let state: DominionState = {
    seed,
    players: [makePlayer(0), makePlayer(1)],
    supply,
    kingdomCards,
    active: 0,
    phase: 'action',
    actions: 1,
    buys: 1,
    coins: 0,
    pending: null,
    reshuffleSeq: [0, 0],
    gameOver: false,
    playedKingdom: [],
    trash: [],
  };

  state = drawCards(state, 0, STARTING_HAND_SIZE);
  state = drawCards(state, 1, STARTING_HAND_SIZE);
  return state;
}

// --- Decisions ------------------------------------------------------------

function currentDecision(state: DominionState): PendingDecision | null {
  if (state.gameOver) return null;
  if (state.pending) return { player: state.pending.player, decisionPoint: state.pending.kind };
  return { player: state.active, decisionPoint: state.phase };
}

function actionPhaseChoices(state: DominionState): DominionChoice[] {
  const choices: DominionChoice[] = [{ kind: 'endActions' }];
  if (state.actions > 0) {
    const hand = getPlayer(state, state.active).hand;
    for (const name of uniqueNames(hand)) {
      if (CARD_DEFS[name].isAction) choices.push({ kind: 'playAction', card: name });
    }
  }
  return choices;
}

function buyPhaseChoices(state: DominionState): DominionChoice[] {
  const choices: DominionChoice[] = [{ kind: 'endBuy' }];
  if (state.buys > 0) {
    for (const name of uniqueNames([...BASIC_CARDS, ...state.kingdomCards])) {
      if (state.supply[name] > 0 && CARD_DEFS[name].cost <= state.coins) {
        choices.push({ kind: 'buy', card: name });
      }
    }
  }
  return choices;
}

function chapelTrashChoices(state: DominionState, pending: Extract<PendingSubdecision, { kind: 'chapelTrash' }>): DominionChoice[] {
  const hand = getPlayer(state, pending.player).hand;
  const choices: DominionChoice[] = [{ kind: 'doneTrash' }];
  for (const name of uniqueNames(hand)) choices.push({ kind: 'trashCard', card: name });
  return choices;
}

function workshopGainChoices(state: DominionState): DominionChoice[] {
  const choices: DominionChoice[] = [];
  for (const name of uniqueNames([...BASIC_CARDS, ...state.kingdomCards])) {
    if (state.supply[name] > 0 && CARD_DEFS[name].cost <= 4) {
      choices.push({ kind: 'gainCard', card: name });
    }
  }
  return choices;
}

function militiaDiscardChoices(state: DominionState, pending: Extract<PendingSubdecision, { kind: 'militiaDiscard' }>): DominionChoice[] {
  const hand = getPlayer(state, pending.player).hand;
  return uniqueNames(hand).map((name) => ({ kind: 'discardCard', card: name }) as const);
}

function getLegalChoices(state: DominionState): readonly DominionChoice[] {
  if (state.gameOver) throw new Error('getLegalChoices: game is already over');
  if (state.pending) {
    const pending = state.pending;
    if (pending.kind === 'chapelTrash') return chapelTrashChoices(state, pending);
    if (pending.kind === 'workshopGain') return workshopGainChoices(state);
    return militiaDiscardChoices(state, pending);
  }
  return state.phase === 'action' ? actionPhaseChoices(state) : buyPhaseChoices(state);
}

function sameChoice(a: DominionChoice, b: DominionChoice): boolean {
  return encodeChoice(a) === encodeChoice(b);
}

// --- Card effects -----------------------------------------------------

function isBlockedByMoat(state: DominionState, defender: PlayerId): boolean {
  return getPlayer(state, defender).hand.includes('Moat');
}

function playAction(state: DominionState, cardName: CardName): DominionState {
  const def = CARD_DEFS[cardName];
  const active = state.active;
  let next: DominionState = withPlayer(state, active, (p) => ({
    ...p,
    hand: removeOne(p.hand, cardName),
    play: [...p.play, cardName],
  }));
  next = {
    ...next,
    actions: next.actions - 1 + def.actions,
    buys: next.buys + def.buys,
    coins: next.coins + def.coins,
    playedKingdom: state.kingdomCards.includes(cardName) ? [...next.playedKingdom, cardName] : next.playedKingdom,
  };
  if (def.cards > 0) next = drawCards(next, active, def.cards);

  switch (cardName) {
    case 'CouncilRoom': {
      next = drawCards(next, otherPlayer(active), 1);
      break;
    }
    case 'Witch': {
      const opponent = otherPlayer(active);
      if (!isBlockedByMoat(next, opponent) && next.supply.Curse > 0) {
        next = { ...next, supply: { ...next.supply, Curse: next.supply.Curse - 1 } };
        next = withPlayer(next, opponent, (p) => ({ ...p, discard: [...p.discard, 'Curse'] }));
      }
      break;
    }
    case 'Militia': {
      const opponent = otherPlayer(active);
      if (!isBlockedByMoat(next, opponent)) {
        const handSize = getPlayer(next, opponent).hand.length;
        if (handSize > 3) {
          next = { ...next, pending: { kind: 'militiaDiscard', player: opponent, remaining: handSize - 3 } };
        }
      }
      break;
    }
    case 'Chapel': {
      next = { ...next, pending: { kind: 'chapelTrash', player: active, remaining: 4 } };
      break;
    }
    case 'Workshop': {
      next = { ...next, pending: { kind: 'workshopGain', player: active } };
      break;
    }
    default:
      break;
  }
  return next;
}

function playAllTreasures(state: DominionState): DominionState {
  const player = getPlayer(state, state.active);
  let coins = state.coins;
  const remainingHand: CardName[] = [];
  const played: CardName[] = [];
  for (const c of player.hand) {
    if (CARD_DEFS[c].isTreasure) {
      coins += CARD_DEFS[c].coins;
      played.push(c);
    } else {
      remainingHand.push(c);
    }
  }
  return withPlayer({ ...state, coins }, state.active, (p) => ({
    ...p,
    hand: remainingHand,
    play: [...p.play, ...played],
  }));
}

function checkGameOver(state: DominionState): DominionState {
  const emptyPiles = uniqueNames([...BASIC_CARDS, ...state.kingdomCards]).filter((c) => state.supply[c] === 0);
  const totalTurns = state.players[0].turnsTaken + state.players[1].turnsTaken;
  const over = emptyPiles.length >= 3 || state.supply.Province === 0 || totalTurns >= TURN_CAP;
  return over ? { ...state, gameOver: true } : state;
}

function cleanupAndAdvance(state: DominionState): DominionState {
  const active = state.active;
  let next: DominionState = withPlayer(state, active, (p) => ({
    ...p,
    discard: [...p.discard, ...p.hand, ...p.play],
    hand: [],
    play: [],
    turnsTaken: p.turnsTaken + 1,
  }));
  next = drawCards(next, active, STARTING_HAND_SIZE);
  next = {
    ...next,
    active: otherPlayer(active),
    phase: 'action',
    actions: 1,
    buys: 1,
    coins: 0,
  };
  return checkGameOver(next);
}

function applyChoice(state: DominionState, choice: DominionChoice): DominionState {
  if (state.gameOver) throw new Error('applyChoice: game is already over');
  const legal = getLegalChoices(state);
  if (!legal.some((c) => sameChoice(c, choice))) {
    throw new Error(`applyChoice: ${encodeChoice(choice)} is not a legal choice`);
  }

  if (state.pending) {
    const pending = state.pending;
    if (pending.kind === 'chapelTrash') {
      if (choice.kind === 'doneTrash') return { ...state, pending: null };
      if (choice.kind === 'trashCard') {
        let next = withPlayer(state, pending.player, (p) => ({ ...p, hand: removeOne(p.hand, choice.card) }));
        next = { ...next, trash: [...next.trash, choice.card] };
        const remaining = pending.remaining - 1;
        next = { ...next, pending: remaining > 0 ? { ...pending, remaining } : null };
        return next;
      }
    }
    if (pending.kind === 'workshopGain' && choice.kind === 'gainCard') {
      let next: DominionState = {
        ...state,
        supply: { ...state.supply, [choice.card]: state.supply[choice.card] - 1 },
        pending: null,
      };
      next = withPlayer(next, pending.player, (p) => ({ ...p, discard: [...p.discard, choice.card] }));
      return next;
    }
    if (pending.kind === 'militiaDiscard' && choice.kind === 'discardCard') {
      let next = withPlayer(state, pending.player, (p) => ({
        ...p,
        hand: removeOne(p.hand, choice.card),
        discard: [...p.discard, choice.card],
      }));
      const remaining = pending.remaining - 1;
      next = { ...next, pending: remaining > 0 ? { ...pending, remaining } : null };
      return next;
    }
    throw new Error(`applyChoice: choice ${encodeChoice(choice)} does not match pending ${pending.kind}`);
  }

  if (state.phase === 'action') {
    if (choice.kind === 'endActions') return playAllTreasures({ ...state, phase: 'buy' });
    if (choice.kind === 'playAction') return playAction(state, choice.card);
    throw new Error(`applyChoice: unexpected choice ${encodeChoice(choice)} in action phase`);
  }

  // buy phase
  if (choice.kind === 'endBuy') return cleanupAndAdvance(state);
  if (choice.kind === 'buy') {
    const def = CARD_DEFS[choice.card];
    let next: DominionState = {
      ...state,
      supply: { ...state.supply, [choice.card]: state.supply[choice.card] - 1 },
      coins: state.coins - def.cost,
      buys: state.buys - 1,
    };
    next = withPlayer(next, state.active, (p) => ({ ...p, discard: [...p.discard, choice.card] }));
    return next;
  }
  throw new Error(`applyChoice: unexpected choice ${encodeChoice(choice)} in buy phase`);
}

// --- Observation / outcome -----------------------------------------------

function countsOf(cards: readonly CardName[]): Partial<Record<CardName, number>> {
  const counts: Partial<Record<CardName, number>> = {};
  for (const c of cards) counts[c] = (counts[c] ?? 0) + 1;
  return counts;
}

function expandCounts(counts: Readonly<Partial<Record<CardName, number>>>): CardName[] {
  const result: CardName[] = [];
  for (const [name, count] of Object.entries(counts) as Array<[CardName, number]>) {
    for (let i = 0; i < count; i += 1) result.push(name);
  }
  return result;
}

function getObservation(state: DominionState, player: PlayerId): DominionObservation {
  const self = getPlayer(state, player);
  const opponent = getPlayer(state, otherPlayer(player));
  return {
    self: player,
    active: state.active,
    phase: state.phase,
    actions: state.actions,
    buys: state.buys,
    coins: state.coins,
    supply: state.supply,
    kingdomCards: state.kingdomCards,
    pending: state.pending,
    trash: state.trash,
    own: {
      hand: self.hand,
      discard: self.discard,
      play: self.play,
      deckCount: self.deck.length,
      deckComposition: countsOf(self.deck),
      turnsTaken: self.turnsTaken,
    },
    opponent: {
      handCount: opponent.hand.length,
      discard: opponent.discard,
      play: opponent.play,
      deckCount: opponent.deck.length,
      turnsTaken: opponent.turnsTaken,
    },
  };
}

/**
 * IS-MCTS determinization hook (docs/FIX-BACKLOG.md P4, contract/types.ts's
 * `GameAdapter.sampleStateFromObservation` doc comment). Unlike Splendor
 * (perfect information — every zone is public, only deck *draw order* is
 * hidden), Dominion is a real hidden-information game: the opponent's hand
 * composition is never visible, and this adapter's `own` observation only
 * ever exposed deck *counts*, never composition, forcing a design decision
 * about what "the viewer's own deck" even means here.
 *
 * What is preserved byte-for-byte (the viewer already knows all of it):
 *   - own hand, own discard, own play area (exact card lists)
 *   - the market supply, both players' discard piles, both players' play
 *     areas, the trash pile (all public zones in real Dominion)
 *   - every zone's *card count* (own deck, opponent hand, opponent deck)
 *   - `active`/`phase`/`actions`/`buys`/`coins`/`pending`/`kingdomCards`
 *     (all directly observable turn state, not hidden information at all)
 *   - each player's `turnsTaken` (own and opponent) — public bookkeeping
 *     needed downstream for the TURN_CAP stalemate check and the
 *     fewer-turns-wins tiebreak in `getOutcome`, so it must resample
 *     identically to the real value, not a default.
 *
 * What gets resampled (the only two things the viewer truly does not know):
 *   - the viewer's own deck *order* — composition is knowable (a real player
 *     has tracked every card they've gained over the game) via
 *     `own.deckComposition`, but the exact top-to-bottom sequence isn't
 *     (nobody peeks ahead at their own future draws), so it is reshuffled
 *     fresh per determinization. This also matters for search soundness:
 *     if `own.deck`'s true order were exposed and reused as-is, IS-MCTS
 *     would get to see its own upcoming draws during rollouts — an
 *     information leak beyond what `getObservation` actually grants.
 *   - the opponent's hand + deck, *both* composition and order — resolved
 *     together as a single pool (mirrors `dominionHiddenInfoProbe` below),
 *     since a viewer cannot distinguish "in opponent's hand" from "in
 *     opponent's deck" for any specific unseen card, only the aggregate pool
 *     those two zones share. The pool is derived by conservation: for each
 *     card name, `totalUniverse(name) - (every public/self count already
 *     known)` must equal exactly what's left for the opponent's hidden hand
 *     + deck combined — this is why `trash` and `turnsTaken` had to be added
 *     to the observation (P4 note: without `trash`, trashed cards would get
 *     silently miscounted into the opponent's hidden pool, corrupting every
 *     later conservation invariant on the sampled state).
 */
function sampleStateFromObservation(observation: DominionObservation, viewer: PlayerId, rng: Rng): DominionState {
  const allNames = uniqueNames([...BASIC_CARDS, ...observation.kingdomCards]);

  const ownDeck = shuffled(expandCounts(observation.own.deckComposition), rng.fork('dominion-determinize-own-deck'));
  if (ownDeck.length !== observation.own.deckCount) {
    throw new Error(
      `sampleStateFromObservation: own deck composition sums to ${ownDeck.length} cards but deckCount reports ${observation.own.deckCount}`,
    );
  }

  const pool: CardName[] = [];
  for (const name of allNames) {
    const universe = totalUniverse(name, observation.kingdomCards);
    const known =
      observation.supply[name] +
      countOf(observation.trash, name) +
      countOf(observation.own.hand, name) +
      countOf(observation.own.discard, name) +
      countOf(observation.own.play, name) +
      (observation.own.deckComposition[name] ?? 0) +
      countOf(observation.opponent.discard, name) +
      countOf(observation.opponent.play, name);
    const remaining = universe - known;
    if (remaining < 0) {
      throw new Error(
        `sampleStateFromObservation: card accounting mismatch for ${name} — ${known} known copies exceeds the ` +
          `${universe}-copy universe. This indicates the observation is internally inconsistent.`,
      );
    }
    for (let i = 0; i < remaining; i += 1) pool.push(name);
  }
  const expectedPoolSize = observation.opponent.handCount + observation.opponent.deckCount;
  if (pool.length !== expectedPoolSize) {
    throw new Error(
      `sampleStateFromObservation: opponent hidden pool size mismatch — conservation leaves ${pool.length} unseen ` +
        `cards but observation reports handCount+deckCount=${expectedPoolSize}.`,
    );
  }
  const shuffledPool = shuffled(pool, rng.fork('dominion-determinize-opponent'));
  const opponentHand = shuffledPool.slice(0, observation.opponent.handCount);
  const opponentDeck = shuffledPool.slice(observation.opponent.handCount);

  const opponentId = otherPlayer(viewer);
  const players: [PlayerState, PlayerState] = [
    { deck: [], hand: [], discard: [], play: [], turnsTaken: 0 },
    { deck: [], hand: [], discard: [], play: [], turnsTaken: 0 },
  ];
  players[viewer] = {
    deck: ownDeck,
    hand: observation.own.hand,
    discard: observation.own.discard,
    play: observation.own.play,
    turnsTaken: observation.own.turnsTaken,
  };
  players[opponentId] = {
    deck: opponentDeck,
    hand: opponentHand,
    discard: observation.opponent.discard,
    play: observation.opponent.play,
    turnsTaken: observation.opponent.turnsTaken,
  };

  return {
    // A fresh, RNG-derived seed — never the real game's seed (not part of the
    // observation, and reusing any fixed value across many per-simulation
    // determinizations would correlate their future reshuffle draws).
    seed: rng.nextInt(2 ** 31),
    players,
    supply: observation.supply,
    kingdomCards: observation.kingdomCards,
    active: observation.active,
    phase: observation.phase,
    actions: observation.actions,
    buys: observation.buys,
    coins: observation.coins,
    pending: observation.pending,
    reshuffleSeq: [0, 0],
    gameOver: false,
    // Content-coverage bookkeeping only (see `exercisedContent`), not read by
    // any gameplay/legality logic — safe to reset for a determinization that
    // only ever exists for the duration of one search simulation.
    playedKingdom: [],
    trash: observation.trash,
  };
}

function getOutcome(state: DominionState): Outcome | null {
  if (currentDecision(state) !== null) return null;
  const vps = state.players.map((p) => playerVP(p));
  // Reference source's tiebreak: fewer turns taken wins if VP is tied.
  const tiebreak = state.players.map((p, i) => vps[i]! * 1000 - p.turnsTaken);
  const best = Math.max(...tiebreak);
  const winners: PlayerId[] = [];
  tiebreak.forEach((t, id) => {
    if (t === best) winners.push(id);
  });
  return { scores: vps, winners };
}

function encodeChoice(choice: DominionChoice): string {
  switch (choice.kind) {
    case 'playAction':
      return `playAction:${choice.card}`;
    case 'endActions':
      return 'endActions';
    case 'buy':
      return `buy:${choice.card}`;
    case 'endBuy':
      return 'endBuy';
    case 'trashCard':
      return `trashCard:${choice.card}`;
    case 'doneTrash':
      return 'doneTrash';
    case 'gainCard':
      return `gainCard:${choice.card}`;
    case 'discardCard':
      return `discardCard:${choice.card}`;
    default: {
      const exhaustive: never = choice;
      throw new Error(`encodeChoice: unhandled choice ${JSON.stringify(exhaustive)}`);
    }
  }
}

// --- Invariants -------------------------------------------------------

function cardConservationInvariant(state: DominionState): string | null {
  const allNames = uniqueNames([...BASIC_CARDS, ...state.kingdomCards]);
  for (const name of allNames) {
    const inPlayers = state.players.reduce(
      (sum, p) => sum + countOf(p.deck, name) + countOf(p.hand, name) + countOf(p.discard, name) + countOf(p.play, name),
      0,
    );
    const total = state.supply[name] + inPlayers + countOf(state.trash, name);
    const expected = totalUniverse(name, state.kingdomCards);
    if (total !== expected) {
      return `card conservation violated for ${name}: total is ${total}, expected ${expected}`;
    }
  }
  return null;
}

function nonNegativeSupplyInvariant(state: DominionState): string | null {
  for (const [name, count] of Object.entries(state.supply)) {
    if (count < 0) return `supply for ${name} went negative: ${count}`;
  }
  return null;
}

function nonNegativeResourcesInvariant(state: DominionState): string | null {
  if (state.actions < 0) return `actions went negative: ${state.actions}`;
  if (state.buys < 0) return `buys went negative: ${state.buys}`;
  if (state.coins < 0) return `coins went negative: ${state.coins}`;
  return null;
}

// --- Content coverage ---------------------------------------------------

function exercisedContent(finalState: DominionState): readonly string[] {
  return uniqueNames(finalState.playedKingdom);
}

const contentInventory = KINGDOM_POOL.map((name) => ({
  name,
  id: name,
  description: `kingdom card ${name} (cost ${CARD_DEFS[name].cost})`,
})).map(({ id, description }) => ({ id, description }));

// --- Hidden information --------------------------------------------------

const dominionHiddenInfoProbe: HiddenInfoProbe<DominionState> = {
  mutateHidden(state, viewer, rng) {
    const opponent = otherPlayer(viewer);
    const opp = getPlayer(state, opponent);
    const pool = [...opp.hand, ...opp.deck];
    if (pool.length === 0) return null;
    const shuffledPool = shuffled(pool, rng);
    const hand = shuffledPool.slice(0, opp.hand.length);
    const deck = shuffledPool.slice(opp.hand.length);
    return withPlayer(state, opponent, (p) => ({ ...p, hand, deck }));
  },
};

// --- Baselines ------------------------------------------------------------

const randomBaseline: BotFactory<DominionObservation, DominionChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'dominion-random',
    decide(_decisionPoint, _observation, legal) {
      return legal[rng.nextInt(legal.length)] as DominionChoice;
    },
  };
};

// Fixed, deterministic play priority for the heuristic baseline's action and
// buy phases (highest-priority card first). Not meant to be strong play —
// an "engine first" bot that prefers cantrips/economy over attacks and
// defers victory-point purchases until nothing better is affordable. Deliberately
// distinct from the playCheapestActionFirst/rushProvinces strategy flags below (C6 needs
// the flags to change heuristic-base behavior observably, which a flag whose
// preference the heuristic baseline already implements cannot do).
const ACTION_PRIORITY: readonly CardName[] = [
  'Village',
  'Laboratory',
  'Festival',
  'Market',
  'CouncilRoom',
  'Smithy',
  'Chapel',
  'Workshop',
  'Woodcutter',
  'Witch',
  'Militia',
  'Moat',
];
const BUY_PRIORITY: readonly CardName[] = [
  'Gold',
  'Witch',
  'Laboratory',
  'CouncilRoom',
  'Festival',
  'Market',
  'Chapel',
  'Silver',
  'Village',
  'Smithy',
  'Woodcutter',
  'Militia',
  'Moat',
  'Workshop',
  'Province',
  'Duchy',
  'Estate',
];

function heuristicPick(
  decisionPoint: string,
  _observation: DominionObservation,
  legal: readonly DominionChoice[],
): DominionChoice {
  if (decisionPoint === 'action') {
    for (const name of ACTION_PRIORITY) {
      const found = legal.find((c) => c.kind === 'playAction' && c.card === name);
      if (found) return found;
    }
    return legal.find((c) => c.kind === 'endActions') ?? (legal[0] as DominionChoice);
  }
  if (decisionPoint === 'buy') {
    for (const name of BUY_PRIORITY) {
      const found = legal.find((c) => c.kind === 'buy' && c.card === name);
      if (found) return found;
    }
    return legal.find((c) => c.kind === 'endBuy') ?? (legal[0] as DominionChoice);
  }
  if (decisionPoint === 'chapelTrash') {
    // Deliberately does NOT trash Copper by default (kept as early money) —
    // see trashCoppersEagerly's doc comment for why this matters for C6.
    for (const name of ['Curse', 'Estate'] as const) {
      const found = legal.find((c) => c.kind === 'trashCard' && c.card === name);
      if (found) return found;
    }
    return legal.find((c) => c.kind === 'doneTrash') ?? (legal[0] as DominionChoice);
  }
  if (decisionPoint === 'workshopGain') {
    for (const name of BUY_PRIORITY) {
      const found = legal.find((c) => c.kind === 'gainCard' && c.card === name);
      if (found) return found;
    }
    return legal[0] as DominionChoice;
  }
  if (decisionPoint === 'militiaDiscard') {
    for (const name of ['Curse', 'Estate', 'Copper'] as const) {
      const found = legal.find((c) => c.kind === 'discardCard' && c.card === name);
      if (found) return found;
    }
    return legal[0] as DominionChoice;
  }
  return legal[0] as DominionChoice;
}

const heuristicBaseline: BotFactory<DominionObservation, DominionChoice> = (_seed) => ({
  id: 'dominion-heuristic',
  decide: heuristicPick,
});

function wrapBotId(bot: GameBot<DominionObservation, DominionChoice>, suffix: string): string {
  return `${bot.id}+${suffix}`;
}

/** Strategy flag: marginal. Always buys Province the instant it's affordable, even over Gold. */
const rushProvinces: StrategyFlagSpec<DominionObservation, DominionChoice> = {
  flag: 'rushProvinces',
  description: 'On the buy phase, always buy Province when affordable, before any other priority.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot, 'rushProvinces'),
        decide(decisionPoint, observation, legal) {
          if (decisionPoint === 'buy') {
            const province = legal.find((c) => c.kind === 'buy' && c.card === 'Province');
            if (province) return province;
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/**
 * Strategy flag: effective. Always plays the cheapest legal action card first
 * (tie-break alphabetically), instead of the heuristic baseline's fixed
 * cantrips-before-attacks priority order. An earlier "always play Witch/
 * Militia first" version of this flag turned out to be a near-always no-op
 * in practice: the heuristic baseline's BUY_PRIORITY rarely reaches Witch/
 * Militia at all (several cheaper cost-5 cantrips outrank them), so the two
 * attack cards essentially never end up in the same hand as another action
 * card during a probe-seed game. Cost-ordering, by contrast, reliably
 * disagrees with the baseline's fixed order whenever 2+ action cards are
 * legal at once (verified empirically to be common — see the onboarding
 * report), which is what a strategy-surface probe actually needs.
 */
const playCheapestActionFirst: StrategyFlagSpec<DominionObservation, DominionChoice> = {
  flag: 'playCheapestActionFirst',
  description: 'On the action phase, always play the cheapest legal action card (ties broken alphabetically).',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot, 'playCheapestActionFirst'),
        decide(decisionPoint, observation, legal) {
          if (decisionPoint === 'action') {
            const actions = legal.filter(
              (c): c is Extract<DominionChoice, { kind: 'playAction' }> => c.kind === 'playAction',
            );
            if (actions.length > 0) {
              const sorted = [...actions].sort(
                (a, b) => CARD_DEFS[a.card].cost - CARD_DEFS[b.card].cost || (a.card < b.card ? -1 : 1),
              );
              return sorted[0]!;
            }
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/** Strategy flag: marginal. On a Chapel trash sub-decision, always trashes a Copper if one is legal. */
const trashCoppersEagerly: StrategyFlagSpec<DominionObservation, DominionChoice> = {
  flag: 'trashCoppersEagerly',
  description: 'On a chapelTrash decision, always trash a Copper if legal, before any other choice.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot, 'trashCoppersEagerly'),
        decide(decisionPoint, observation, legal) {
          if (decisionPoint === 'chapelTrash') {
            const copper = legal.find((c) => c.kind === 'trashCard' && c.card === 'Copper');
            if (copper) return copper;
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

// --- GAP-11 Phase 3-C A8 domain redesign (design-brief-round1.md / main-loop
// spec runs/dominion/design-brief-round1.md's own doc comment references) ---
//
// LossReport evidence (dominion-loss-mining.ts, this round): v2's
// (rushProvinces) top mismatched decision point is chapelTrash (67.4%), far
// above buy (18.1%) and action (6.8%) — v2 has a buy-priority axis but no
// deck-density management at all. `chapelEconomy` below is the main loop's
// own B3 design spec implemented verbatim (see the spec's own doc comment,
// preserved in git history under runs/dominion/ as the round's design
// input) — a from-scratch policy (does not layer on `base`, matching the
// spec's explicit "합성 순서 함정 회피를 위해 단독 평가" instruction), plus
// two mechanical parameter variants (B1) and one independent B2 design.
//
// Observation-range check (spec's own instruction, before implementing):
// `DominionObservation.own.deckComposition` only covers the viewer's own
// *draw pile* (this file's own doc comment on the field, above); hand/
// discard/play are separate arrays. A viewer's full personal deck (the set
// every "deck density" heuristic below needs) is therefore
// hand + discard + play + deckComposition — all four are public to the
// viewer themselves (no opponent information used, no approximation needed:
// composition, not draw order, is all these heuristics require).

/** Count of `name` across every zone of the *viewer's own* full deck
 * (draw pile composition + hand + discard + play) — see the observation-
 * range note above. */
function ownCardCount(observation: DominionObservation, name: CardName): number {
  return (
    countOf(observation.own.hand, name) +
    countOf(observation.own.discard, name) +
    countOf(observation.own.play, name) +
    (observation.own.deckComposition[name] ?? 0)
  );
}

/** Total card count across the viewer's own full deck (all four zones). */
function ownDeckSize(observation: DominionObservation): number {
  return (
    observation.own.hand.length +
    observation.own.discard.length +
    observation.own.play.length +
    observation.own.deckCount
  );
}

/** Real (not draw-order-dependent) money density: total coin value of owned
 * treasures / total deck size. Matches the design spec's "실질 화폐 밀도". */
function ownMoneyDensity(observation: DominionObservation): number {
  const size = ownDeckSize(observation);
  if (size === 0) return 0;
  let money = 0;
  for (const name of ['Copper', 'Silver', 'Gold'] as const) {
    money += ownCardCount(observation, name) * CARD_DEFS[name].coins;
  }
  return money / size;
}

interface ChapelEconomyOptions {
  /** Density threshold gating the 5-7 coin buy tier (spec default 1.0). */
  readonly densityThreshold: number;
  /** Remaining-Province count at/below which the "전환기" (transition)
   * policy applies; above it is "성장기" (growth) (spec default 4). */
  readonly transitionRemaining: number;
}

const CHAPEL_ECONOMY_DEFAULT: ChapelEconomyOptions = { densityThreshold: 1.0, transitionRemaining: 4 };

function chapelEconomyIsGrowthPhase(observation: DominionObservation, options: ChapelEconomyOptions): boolean {
  return (observation.supply.Province ?? 0) > options.transitionRemaining;
}

/**
 * chapelTrash policy (spec §2, the round's primary target — chapelTrash is
 * the 67.4% mismatch decision point): growth phase trashes Estate > Copper
 * (only if the deck's total money value stays >= 3 after trashing it) >
 * Curse, in that literal priority order (the spec's own order, not
 * "most useless first" — implemented as written, not re-derived).
 * Transition phase stops trashing entirely except Curse.
 */
function chapelEconomyTrashChoice(
  observation: DominionObservation,
  legal: readonly DominionChoice[],
  growth: boolean,
): DominionChoice | undefined {
  const findTrash = (name: CardName): DominionChoice | undefined =>
    legal.find((c) => c.kind === 'trashCard' && c.card === name);
  const doneTrash = legal.find((c) => c.kind === 'doneTrash');

  if (!growth) {
    return findTrash('Curse') ?? doneTrash;
  }

  const estate = findTrash('Estate');
  if (estate) return estate;

  const copper = findTrash('Copper');
  if (copper) {
    const totalMoney =
      ownCardCount(observation, 'Copper') * CARD_DEFS.Copper.coins +
      ownCardCount(observation, 'Silver') * CARD_DEFS.Silver.coins +
      ownCardCount(observation, 'Gold') * CARD_DEFS.Gold.coins;
    if (totalMoney - CARD_DEFS.Copper.coins >= 3) return copper;
  }

  const curse = findTrash('Curse');
  if (curse) return curse;

  return doneTrash;
}

/**
 * Buy policy (spec §3, density-derived): Province at 8+ always; at 5-7,
 * Gold-then-Silver when density is below threshold, else Duchy but only in
 * the transition phase; at 3-4, one-time Chapel (if not yet owned) else
 * Silver in growth phase; transition-phase endgame (remaining Province <= 2)
 * also takes Estate for VP mop-up. Returns undefined when no rule fires (the
 * caller falls through to the standalone heuristic fallback).
 */
function chapelEconomyBuyChoice(
  observation: DominionObservation,
  legal: readonly DominionChoice[],
  options: ChapelEconomyOptions,
): DominionChoice | undefined {
  const findBuy = (name: CardName): DominionChoice | undefined =>
    legal.find((c) => c.kind === 'buy' && c.card === name);
  const remainingProvince = observation.supply.Province ?? 0;
  const growth = chapelEconomyIsGrowthPhase(observation, options);
  const coins = observation.coins;

  if (coins >= 8) {
    const province = findBuy('Province');
    if (province) return province;
  }

  if (!growth && remainingProvince <= 2) {
    const estate = findBuy('Estate');
    if (estate) return estate;
  }

  if (coins >= 5 && coins <= 7) {
    const density = ownMoneyDensity(observation);
    if (density < options.densityThreshold) {
      const gold = findBuy('Gold');
      if (gold) return gold;
      const silver = findBuy('Silver');
      if (silver) return silver;
    } else if (!growth) {
      const duchy = findBuy('Duchy');
      if (duchy) return duchy;
    }
  }

  if (coins >= 3 && coins <= 4) {
    const ownsChapel = ownCardCount(observation, 'Chapel') > 0;
    if (!ownsChapel) {
      const chapel = findBuy('Chapel');
      if (chapel) return chapel;
    } else if (growth) {
      const silver = findBuy('Silver');
      if (silver) return silver;
    }
  }

  return undefined;
}

/** action policy (spec §4): Chapel only in the growth phase, everything else
 * via the standalone fallback's existing order (draw/coin cards first). */
function chapelEconomyActionLegal(
  observation: DominionObservation,
  legal: readonly DominionChoice[],
  options: ChapelEconomyOptions,
): readonly DominionChoice[] {
  if (chapelEconomyIsGrowthPhase(observation, options)) return legal;
  const filtered = legal.filter((c) => !(c.kind === 'playAction' && c.card === 'Chapel'));
  return filtered.length > 0 ? filtered : legal;
}

/**
 * Builds a `chapelEconomy*` StrategyFlagSpec. Standalone (ignores `base`
 * entirely, per the spec's "단독 평가" instruction) — ungoverned decision
 * points (workshopGain, militiaDiscard, and any buy/action/chapelTrash case
 * none of the rules above fire on) fall through to a fresh
 * `heuristicBaseline` instance, never to `base`.
 */
function chapelEconomyFlagSpec(
  flag: string,
  options: ChapelEconomyOptions,
  description: string,
): StrategyFlagSpec<DominionObservation, DominionChoice> {
  return {
    flag,
    description,
    apply() {
      return (seed) => {
        const fallback = heuristicBaseline(seed);
        return {
          id: `dominion-heuristic+${flag}`,
          decide(decisionPoint, observation, legal) {
            if (decisionPoint === 'chapelTrash') {
              const growth = chapelEconomyIsGrowthPhase(observation, options);
              return chapelEconomyTrashChoice(observation, legal, growth) ?? fallback.decide(decisionPoint, observation, legal);
            }
            if (decisionPoint === 'buy') {
              return chapelEconomyBuyChoice(observation, legal, options) ?? fallback.decide(decisionPoint, observation, legal);
            }
            if (decisionPoint === 'action') {
              return fallback.decide(decisionPoint, observation, chapelEconomyActionLegal(observation, legal, options));
            }
            return fallback.decide(decisionPoint, observation, legal);
          },
        };
      };
    },
  };
}

/** B3-deep (main loop design, this round's primary A8 candidate). */
const chapelEconomy = chapelEconomyFlagSpec(
  'chapelEconomy',
  CHAPEL_ECONOMY_DEFAULT,
  'B3 deep design (GAP-11 Phase 3-C A8, main-loop spec): deck-money-density-aware Chapel trash policy + density-derived buy policy, standalone. Targets the LossReport\'s #1 mismatched decision point (chapelTrash, 67.4%). See runs/dominion/design-brief-round1.md.',
);

/** B1-exploit mechanical variant: lower density trigger (more eager Gold/Silver). */
const chapelEconomyD08 = chapelEconomyFlagSpec(
  'chapelEconomy-d08',
  { densityThreshold: 0.8, transitionRemaining: 4 },
  'B1 mechanical variant of chapelEconomy: density threshold 1.0 -> 0.8 (earlier Gold/Silver reinforcement trigger).',
);

/** B1-exploit mechanical variant: later transition trigger (longer growth phase). */
const chapelEconomyLate3 = chapelEconomyFlagSpec(
  'chapelEconomy-late3',
  { densityThreshold: 1.0, transitionRemaining: 3 },
  'B1 mechanical variant of chapelEconomy: transition trigger remaining-Province 4 -> 3 (growth phase runs one Province longer).',
);

/**
 * B2-opponent (this round's own design, GAP-11 Phase 3-C — deliberately a
 * different approach from B3's dense trash+density policy): the LossReport's
 * #2 mismatched decision point is `buy` (18.1%); this candidate targets it
 * directly with a plain money-first buy order and sidesteps the #1
 * mismatched point (chapelTrash, 67.4%) entirely by never trashing anything
 * (always `doneTrash` immediately) rather than trying to get the trash
 * policy right — a genuinely different bet than B3's "fix chapelTrash"
 * approach: "avoid the risky decision, win on a simpler curve instead."
 * Standalone (same convention as chapelEconomy above).
 */
const simpleEconomyNoTrash: StrategyFlagSpec<DominionObservation, DominionChoice> = {
  flag: 'simpleEconomyNoTrash',
  description:
    'B2 opponent-info design (GAP-11 Phase 3-C): plain money-first buy order (Province>=8, Gold>=6, late Duchy>=5, Silver>=3, late Estate mop-up) targeting the buy mismatch (18.1%); never trashes (always doneTrash immediately), sidestepping the chapelTrash mismatch (67.4%) rather than fixing it. Standalone.',
  apply() {
    return (seed) => {
      const fallback = heuristicBaseline(seed);
      return {
        id: 'dominion-heuristic+simpleEconomyNoTrash',
        decide(decisionPoint, observation, legal) {
          if (decisionPoint === 'chapelTrash') {
            const doneTrash = legal.find((c) => c.kind === 'doneTrash');
            if (doneTrash) return doneTrash;
            return fallback.decide(decisionPoint, observation, legal);
          }
          if (decisionPoint === 'buy') {
            const findBuy = (name: CardName): DominionChoice | undefined =>
              legal.find((c) => c.kind === 'buy' && c.card === name);
            const remainingProvince = observation.supply.Province ?? 0;
            const coins = observation.coins;

            if (coins >= 8) {
              const province = findBuy('Province');
              if (province) return province;
            }
            if (coins >= 6) {
              const gold = findBuy('Gold');
              if (gold) return gold;
            }
            if (remainingProvince <= 4 && coins >= 5) {
              const duchy = findBuy('Duchy');
              if (duchy) return duchy;
            }
            if (coins >= 3) {
              const silver = findBuy('Silver');
              if (silver) return silver;
            }
            if (remainingProvince <= 2) {
              const estate = findBuy('Estate');
              if (estate) return estate;
            }
            return fallback.decide(decisionPoint, observation, legal);
          }
          return fallback.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

// --- GAP-11 Phase 4-C round-2 candidate batch (main-loop design spec,
// scratchpad/dominion-round2-design-spec.md, "그대로 구현" — implemented
// verbatim, no ad-hoc deviation) ---
//
// Evidence this batch responds to (dominion-loss-mining-round2.ts /
// design-brief-round2.md): (1) v3 (=plain chapelEconomy, composeBot's
// override semantics collapse the v3 flag list to this single flag) scored
// L2=16.8%; (2) chapelTrash mismatch fell from 67.4% (v2) to 3.2% (v3) — A8's
// trash redesign already converged with L2, leave it untouched; (3) the
// mismatch bottleneck moved to action (19.4%) and buy (16.4%); (4) gomoku's
// Phase 4-A/4-B/4-B2 lesson (design-brief-round2.md's own "오목 2·3회전
// 교훈" section): imitation transfers best at the prior/evaluation level, not
// as a literal action-by-action copy.
//
// IMPORTANT caveat carried over from dominion-loss-mining-round2.ts's own doc
// comment: loss-mining.ts rebuilds the anchor bot fresh at *every single*
// decisionIndex (its "per-decision anchor derivation" convention, needed so
// scoreAgainstProbes can replay one decision in isolation) — so
// dominion-opus-bot.ts's internal `owned` card tally is always reset to the
// turn-1 starting deck when queried this way. A LossReport divergence like
// "candidate bought Silver, anchor would have bought Chapel/Witch/Laboratory"
// deep into a real game is largely this reconstruction artifact (the L2
// snapshot always "thinks" it is still early game), not a real L2 policy the
// candidates below should imitate verbatim. The B3/B1 designs below were
// built by reading dominion-opus-bot.ts's *source* for buy/action elements
// v1 chapelEconomy structurally lacks (Witch/Laboratory awareness, Duchy-pile
// contesting timing, junk-gated Chapel), not by copying the raw divergence
// pairs — the two LossReport patterns that are NOT artifacts (real
// observation-driven, not owned-tally-driven) are (a) buy:Estate/Gold/Silver
// vs buy:Duchy (415/1160 buy mismatches) — v1's Duchy trigger is gated behind
// its money-density check and rarely fires, while dominion-opus-bot.ts's
// Duchy trigger is purely `provinceLeft <= 4`, no density gate — and (b) the
// action-phase Chapel gating pairs (781/1005 action mismatches,
// endActions<->playAction:Chapel both directions) — v1 bans Chapel outright
// once transitioning, while dominion-opus-bot.ts's `chooseAction` gates
// Chapel on real hand contents (`junkInHand`, unaffected by the tally quirk
// since it reads `observation.own.hand` directly) in every phase.

/** B3 redesign's buy tier count caps — mirrors dominion-opus-bot.ts's
 * MAX_WITCHES=2/MAX_LABS=3, kept slightly more conservative on Labs (2, not
 * 3) since chapelEconomyV2 still contests Provinces earlier via its Duchy
 * reorder below and does not want to over-invest turns in card-smoothing at
 * the expense of that. */
const CHAPEL_ECONOMY_V2_MAX_WITCHES = 2;
const CHAPEL_ECONOMY_V2_MAX_LABS = 2;

/**
 * B3 buy redesign (design-spec §"buy 재설계"). Keeps chapelEconomy's
 * Province-at-8 and one-time-Chapel rules verbatim; changes two things read
 * directly off dominion-opus-bot.ts's source:
 *   1. Endgame greening reordered: contest the Duchy pile at coins>=5 as soon
 *      as the transition phase starts (remainingProvince<=options.
 *      transitionRemaining), matching dominion-opus-bot.ts's
 *      `provinceLeft <= 4` trigger — NOT gated behind the money-density
 *      check v1 used (v1's Duchy branch only fired when density stayed >=
 *      threshold, a rare state early in the transition phase, so v1
 *      chronically under-bought Duchy relative to L2). Estate mop-up
 *      (remainingProvince<=2) is now a fallback for when Duchy is
 *      unaffordable/depleted, not a competing priority that fires first.
 *   2. Witch (up to CHAPEL_ECONOMY_V2_MAX_WITCHES copies, while Curses remain
 *      in supply) and Laboratory (up to CHAPEL_ECONOMY_V2_MAX_LABS copies)
 *      added ahead of the density-gated Silver fallback at the 5-7 coin
 *      tier — v1 chapelEconomy had no attack-card or draw-smoothing
 *      awareness whatsoever.
 * `includeGreeningReorder=false` (chapelEconomyV2-noGreen, B1) drops item 1
 * entirely (no Duchy/Estate buying at all outside the Province-at-8 rule) —
 * an element-contribution isolation, not a standalone design of its own.
 */
function chapelEconomyV2BuyChoice(
  observation: DominionObservation,
  legal: readonly DominionChoice[],
  options: ChapelEconomyOptions,
  includeGreeningReorder: boolean,
): DominionChoice | undefined {
  const findBuy = (name: CardName): DominionChoice | undefined =>
    legal.find((c) => c.kind === 'buy' && c.card === name);
  const remainingProvince = observation.supply.Province ?? 0;
  const growth = chapelEconomyIsGrowthPhase(observation, options);
  const coins = observation.coins;

  if (coins >= 8) {
    const province = findBuy('Province');
    if (province) return province;
  }

  if (includeGreeningReorder && !growth) {
    if (coins >= 5) {
      const duchy = findBuy('Duchy');
      if (duchy) return duchy;
    }
    if (remainingProvince <= 2) {
      const estate = findBuy('Estate');
      if (estate) return estate;
    }
  }

  if (coins >= 6) {
    const gold = findBuy('Gold');
    if (gold) return gold;
  }

  if (coins >= 5) {
    if (ownCardCount(observation, 'Witch') < CHAPEL_ECONOMY_V2_MAX_WITCHES && (observation.supply.Curse ?? 0) > 0) {
      const witch = findBuy('Witch');
      if (witch) return witch;
    }
    if (ownCardCount(observation, 'Laboratory') < CHAPEL_ECONOMY_V2_MAX_LABS) {
      const lab = findBuy('Laboratory');
      if (lab) return lab;
    }
    const density = ownMoneyDensity(observation);
    if (density < options.densityThreshold) {
      const silver = findBuy('Silver');
      if (silver) return silver;
    }
  }

  if (coins >= 3 && coins <= 4) {
    const ownsChapel = ownCardCount(observation, 'Chapel') > 0;
    if (!ownsChapel) {
      const chapel = findBuy('Chapel');
      if (chapel) return chapel;
    } else if (growth) {
      const silver = findBuy('Silver');
      if (silver) return silver;
    }
  }

  return undefined;
}

/**
 * B3 action redesign (design-spec §"action 재설계"), read off
 * dominion-opus-bot.ts's `chooseAction`: Witch gets immediate priority over
 * every other action while Curses remain in supply (v1 had no attack-card
 * awareness in the action phase at all), and Chapel's eligibility is gated
 * on real junk actually being in hand (`observation.own.hand`, unaffected by
 * the per-decision-anchor-freshness caveat above since it reads the true
 * observation) in *every* phase — replacing v1's blanket
 * `chapelEconomyActionLegal` transition-phase ban, which was the round2
 * LossReport's single largest action mismatch (781/1005 decisions, both
 * `endActions`<->`playAction:Chapel` directions: v1 sometimes plays a
 * pointless Chapel in growth phase with no junk to trash, and sometimes
 * refuses to play a genuinely useful late Chapel purely because it has
 * transitioned).
 */
function chapelEconomyV2ActionChoice(
  observation: DominionObservation,
  legal: readonly DominionChoice[],
): DominionChoice | undefined {
  if ((observation.supply.Curse ?? 0) > 0) {
    const witch = legal.find((c) => c.kind === 'playAction' && c.card === 'Witch');
    if (witch) return witch;
  }
  return undefined;
}

function chapelEconomyV2ActionLegal(
  observation: DominionObservation,
  legal: readonly DominionChoice[],
): readonly DominionChoice[] {
  const hand = observation.own.hand;
  const junkInHand = hand.some((c) => c === 'Curse' || c === 'Estate' || c === 'Copper');
  if (junkInHand) return legal;
  const filtered = legal.filter((c) => !(c.kind === 'playAction' && c.card === 'Chapel'));
  return filtered.length > 0 ? filtered : legal;
}

interface ChapelEconomyV2Options {
  readonly includeGreeningReorder: boolean;
  readonly useV2Action: boolean;
}

/**
 * Builds a `chapelEconomyV2*` StrategyFlagSpec. Standalone (ignores `base`
 * entirely, same convention as chapelEconomy) — chapelTrash is always
 * chapelEconomy's own policy verbatim (design-spec: "트래시 정책은
 * chapelEconomy 그대로 보존"), buy/action are gated by `v2Options` so the two
 * B1 element-isolation variants can toggle one piece of the redesign off
 * without duplicating this whole function.
 */
function chapelEconomyV2FlagSpec(
  flag: string,
  description: string,
  v2Options: ChapelEconomyV2Options,
): StrategyFlagSpec<DominionObservation, DominionChoice> {
  return {
    flag,
    description,
    apply() {
      return (seed) => {
        const fallback = heuristicBaseline(seed);
        return {
          id: `dominion-heuristic+${flag}`,
          decide(decisionPoint, observation, legal) {
            if (decisionPoint === 'chapelTrash') {
              const growth = chapelEconomyIsGrowthPhase(observation, CHAPEL_ECONOMY_DEFAULT);
              return (
                chapelEconomyTrashChoice(observation, legal, growth) ?? fallback.decide(decisionPoint, observation, legal)
              );
            }
            if (decisionPoint === 'buy') {
              return (
                chapelEconomyV2BuyChoice(observation, legal, CHAPEL_ECONOMY_DEFAULT, v2Options.includeGreeningReorder) ??
                fallback.decide(decisionPoint, observation, legal)
              );
            }
            if (decisionPoint === 'action') {
              if (v2Options.useV2Action) {
                const witchChoice = chapelEconomyV2ActionChoice(observation, legal);
                if (witchChoice) return witchChoice;
                return fallback.decide(decisionPoint, observation, chapelEconomyV2ActionLegal(observation, legal));
              }
              return fallback.decide(
                decisionPoint,
                observation,
                chapelEconomyActionLegal(observation, legal, CHAPEL_ECONOMY_DEFAULT),
              );
            }
            return fallback.decide(decisionPoint, observation, legal);
          },
        };
      };
    },
  };
}

/** B3-deep round 2 (main-loop design, this round's primary A8 follow-up). */
const chapelEconomyV2 = chapelEconomyV2FlagSpec(
  'chapelEconomyV2',
  "B3 deep redesign v2 (GAP-11 Phase 4-C A8 follow-up, main-loop spec): preserves chapelEconomy's chapelTrash policy verbatim (already near-converged with L2 in round 2, mismatch 67.4%->3.2%) and rebuilds buy/action using elements read from dominion-opus-bot.ts (L2 feedback anchor — imitation axis, L3 holdout never consulted): (1) endgame greening reordered to contest Duchy at coins>=5 once transitioning (provinceLeft-gated like L2, not density-gated like v1), Estate mop-up as fallback only; (2) Witch (<=2 copies while Curses remain) and Laboratory (<=2 copies) added at the 5-7 coin tier; (3) action phase gives Witch immediate priority while Curses remain, and gates Chapel's eligibility on real junk-in-hand in every phase instead of v1's blanket transition-phase ban. See dominion.ts's own 'GAP-11 Phase 4-C round-2 candidate batch' doc comment above for the LossReport-artifact caveat this design deliberately avoids naively imitating.",
  { includeGreeningReorder: true, useV2Action: true },
);

/** B1-exploit mechanical variant (element-contribution isolation): removes
 * the endgame-greening reorder entirely — no Duchy contesting, no Estate
 * mop-up, VP buying relies solely on the Province-at-8 rule. */
const chapelEconomyV2NoGreen = chapelEconomyV2FlagSpec(
  'chapelEconomyV2-noGreen',
  'B1 mechanical variant of chapelEconomyV2 (GAP-11 Phase 4-C, element-contribution isolation): removes the endgame-greening reorder entirely (no Duchy contest, no Estate mop-up) — isolates whether V2\'s gain (if any) comes from the greening-timing fix or from the Witch/Laboratory/action redesign.',
  { includeGreeningReorder: false, useV2Action: true },
);

/** B1-exploit mechanical variant (element-contribution isolation): keeps
 * V2's buy redesign in full but reverts the action phase to v1
 * chapelEconomy's original blanket transition-phase Chapel ban (no Witch
 * attack priority, no junk-gating). */
const chapelEconomyV2CloneBuy = chapelEconomyV2FlagSpec(
  'chapelEconomyV2-clonebuy',
  "B1 mechanical variant of chapelEconomyV2 (GAP-11 Phase 4-C, element-contribution isolation): buy is V2's redesign in full (greening reorder + Witch/Laboratory); action reverts to v1 chapelEconomy's original blanket transition-phase Chapel ban (no Witch priority, no junk-gating) — isolates whether V2's gain comes from the buy side or the action side.",
  { includeGreeningReorder: true, useV2Action: false },
);

/**
 * B2-opponent (this round's own design, GAP-11 Phase 4-C — deliberately a
 * different bet from B3's "preserve trash, fix buy/action" approach): round
 * 1's B2 (simpleEconomyNoTrash) sidestepped the chapelTrash mismatch by never
 * trashing and won on a plain money curve; this round's B2 keeps that
 * never-trash simplicity but spends the buys a trash-heavy deck would have
 * spent on early Chapels into a Witch/Laboratory tempo axis instead — a
 * kingdom-card axis the entire chapelEconomy family (v1 and V2 alike) never
 * touches. Standalone (same convention as every other candidate here).
 */
const WITCH_RUSH_MAX_WITCHES = 3;
const WITCH_RUSH_MAX_LABS = 2;

const witchRushNoTrash: StrategyFlagSpec<DominionObservation, DominionChoice> = {
  flag: 'witchRushNoTrash',
  description:
    "B2 opponent-info design (GAP-11 Phase 4-C, deliberately distinct from B3's trash-preserving approach): never trashes (always doneTrash immediately, round1 B2's own bet, kept unchanged) but adds a Witch(<=3, attack+draw)/Laboratory(<=2) tempo axis chapelEconomy family never touches, ahead of plain Silver/Duchy at the 5-7 coin tier. Standalone.",
  apply() {
    return (seed) => {
      const fallback = heuristicBaseline(seed);
      return {
        id: 'dominion-heuristic+witchRushNoTrash',
        decide(decisionPoint, observation, legal) {
          if (decisionPoint === 'chapelTrash') {
            const doneTrash = legal.find((c) => c.kind === 'doneTrash');
            if (doneTrash) return doneTrash;
            return fallback.decide(decisionPoint, observation, legal);
          }
          if (decisionPoint === 'action') {
            if ((observation.supply.Curse ?? 0) > 0) {
              const witch = legal.find((c) => c.kind === 'playAction' && c.card === 'Witch');
              if (witch) return witch;
            }
            return fallback.decide(decisionPoint, observation, legal);
          }
          if (decisionPoint === 'buy') {
            const findBuy = (name: CardName): DominionChoice | undefined =>
              legal.find((c) => c.kind === 'buy' && c.card === name);
            const remainingProvince = observation.supply.Province ?? 0;
            const coins = observation.coins;

            if (coins >= 8) {
              const province = findBuy('Province');
              if (province) return province;
            }
            if (coins >= 6) {
              const gold = findBuy('Gold');
              if (gold) return gold;
            }
            if (coins >= 5) {
              if (ownCardCount(observation, 'Witch') < WITCH_RUSH_MAX_WITCHES && (observation.supply.Curse ?? 0) > 0) {
                const witch = findBuy('Witch');
                if (witch) return witch;
              }
              if (ownCardCount(observation, 'Laboratory') < WITCH_RUSH_MAX_LABS) {
                const lab = findBuy('Laboratory');
                if (lab) return lab;
              }
              if (remainingProvince <= 4) {
                const duchy = findBuy('Duchy');
                if (duchy) return duchy;
              }
            }
            if (coins >= 3) {
              const silver = findBuy('Silver');
              if (silver) return silver;
            }
            if (remainingProvince <= 2) {
              const estate = findBuy('Estate');
              if (estate) return estate;
            }
            return fallback.decide(decisionPoint, observation, legal);
          }
          return fallback.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/**
 * B4-explore (A10 full imitation, GAP-11 Phase 4-C — the analogous bet to
 * gomoku's opusclone axis, but as a *literal* clone rather than a search
 * prior since dominion's own candidates are all pure heuristics with no
 * search layer): wraps dominion-opus-bot.ts (the L2 feedback anchor) itself
 * as a strategy flag. `apply()` returns `dominionOpusBot` directly — not a
 * hand-copied re-derivation — so there is zero drift risk between "the L2
 * anchor" and "this imitation candidate": whatever dominion-opus-bot.ts does,
 * this flag does, by construction. Unlike loss-mining.ts's per-decision
 * anchor reconstruction (this file's own doc comment on the batch above),
 * this bot is created once per real game via the normal `BotFactory(seed)`
 * contract and plays that one game start-to-finish, so its internal `owned`
 * tally stays accurate throughout — none of the reconstruction-artifact
 * caveat applies here. What IS still live: kingdom-card randomization
 * (10-of-12 KINGDOM_POOL draw per game) and seating/shuffle asymmetry are
 * dominion-specific variance sources a literal clone must still contend with
 * even in an otherwise mirror-policy matchup against the L2 anchor itself.
 */
const opusCloneDominion: StrategyFlagSpec<DominionObservation, DominionChoice> = {
  flag: 'opusCloneDominion',
  description:
    "B4 explore (A10 full imitation, GAP-11 Phase 4-C): wraps dominion-opus-bot.ts (the L2 feedback anchor) verbatim as a strategy flag (apply() returns dominionOpusBot itself, zero drift risk from a re-derived copy). Ignores base entirely (imitation axis, same convention as chapelEconomy). See dominion.ts's own doc comment on this flag for why the per-decision-anchor-freshness caveat that affects loss-mining.ts's LossReport does NOT apply to this candidate's actual gameplay.",
  apply: () => dominionOpusBot,
};

/**
 * B4-explore (A5 tree prior, this round's untried axis): static per-choice
 * value evaluator (ADR-0011) for use as an IS-MCTS `priorSource:
 * 'choiceEvaluator'` — buy value tiers roughly mirroring the opus bot's own
 * priorities, trash value tiers (Curse/Estate/Copper preferred), and a light
 * cantrip-synergy score for playAction; every other choice kind (endActions,
 * endBuy, doneTrash, gainCard, discardCard) is left neutral (score 0) since
 * this evaluator's job is only to bias search toward promising buy/trash/
 * action choices, not to fully replace the rollout policy.
 */
function dominionBuyValueScore(card: CardName, state: DominionState, player: PlayerId): number {
  const remainingProvince = state.supply.Province ?? 0;
  if (card === 'Province') return 100;
  if (card === 'Curse') return -50;
  if (card === 'Gold') return 70;
  if (card === 'Duchy') return remainingProvince <= 4 ? 55 : 20;
  if (card === 'Silver') return 40;
  if (card === 'Estate') return remainingProvince <= 2 ? 25 : 5;
  if (card === 'Chapel') {
    const owns = getPlayer(state, player).deck.some((c) => c === 'Chapel') ||
      getPlayer(state, player).hand.some((c) => c === 'Chapel') ||
      getPlayer(state, player).discard.some((c) => c === 'Chapel') ||
      getPlayer(state, player).play.some((c) => c === 'Chapel');
    return owns ? 10 : 45;
  }
  const def = CARD_DEFS[card];
  return 30 + def.cards * 5 + def.actions * 5 + def.coins * 3 + def.buys * 3 + (def.isAttack ? 10 : 0);
}

function dominionTrashValueScore(card: CardName): number {
  if (card === 'Curse') return 100;
  if (card === 'Estate') return 60;
  if (card === 'Copper') return 40;
  return -50;
}

function dominionChoiceEvaluator(
  state: DominionState,
  player: PlayerId,
  choices: readonly DominionChoice[],
): readonly number[] {
  return choices.map((choice) => {
    if (choice.kind === 'buy') return dominionBuyValueScore(choice.card, state, player);
    if (choice.kind === 'trashCard') return dominionTrashValueScore(choice.card);
    if (choice.kind === 'playAction') {
      const def = CARD_DEFS[choice.card];
      return def.cards * 5 + def.actions * 5 + def.coins * 3 + def.buys * 3 + (def.isAttack ? 10 : 0);
    }
    return 0;
  });
}

/**
 * Replay fixtures: random-vs-random self-play, captured by actually running
 * this adapter (see src/reference/__tests__/dominion.test.ts generation
 * note) and hardcoded here — not hand-simulated. No parity source from the
 * reference project was available in headless-replayable form (dominiate has
 * no recorded-game format to transcribe), so per docs/ONBOARDING-GUIDE.md §4
 * these are reproducibility fixtures, not true parity fixtures against the
 * original engine — the C7 report reflects that downgrade.
 */
const replayFixtures: readonly ReplayFixture[] = [
  {
    id: 'dominion-2p-seed-11',
    seed: 11,
    choiceKeys: [
      'endActions', 'buy:Village', 'endBuy', 'endActions', 'buy:Village', 'endBuy', 'endActions',
      'buy:Woodcutter', 'endBuy', 'endActions', 'buy:Silver', 'endBuy', 'endActions', 'buy:Estate',
      'endBuy', 'endActions', 'endBuy', 'endActions', 'buy:Curse', 'endBuy', 'endActions',
      'buy:Laboratory', 'endBuy', 'endActions', 'buy:Village', 'endBuy', 'playAction:Laboratory',
      'playAction:Village', 'endActions', 'buy:Witch', 'endBuy', 'endActions', 'buy:Copper', 'endBuy',
      'endActions', 'buy:Chapel', 'endBuy', 'endActions', 'buy:Copper', 'endBuy', 'playAction:Laboratory',
      'endActions', 'buy:Smithy', 'endBuy', 'endActions', 'buy:Market', 'endBuy', 'endActions',
      'buy:Estate', 'endBuy', 'playAction:Village', 'playAction:Woodcutter', 'playAction:Village',
      'endActions', 'buy:Curse', 'buy:Market', 'endBuy', 'playAction:Witch', 'endActions', 'buy:Silver',
      'endBuy', 'endActions', 'buy:Village', 'endBuy', 'endActions', 'buy:Curse', 'endBuy', 'endActions',
      'buy:Copper', 'endBuy', 'playAction:Laboratory', 'playAction:Chapel', 'trashCard:Copper',
      'trashCard:Copper', 'trashCard:Estate', 'trashCard:Estate', 'endActions', 'endBuy', 'endActions',
      'buy:Copper', 'endBuy', 'endActions', 'buy:Chapel', 'endBuy', 'playAction:Market', 'endActions',
      'buy:Chapel', 'buy:Chapel', 'endBuy', 'playAction:Witch', 'endActions', 'buy:Witch', 'endBuy',
      'endActions', 'endBuy', 'playAction:Chapel', 'trashCard:Estate', 'trashCard:Curse', 'doneTrash',
      'endActions', 'buy:Curse', 'endBuy', 'playAction:Village', 'endActions', 'buy:Curse', 'endBuy',
      'endActions', 'buy:Curse', 'endBuy', 'playAction:Village', 'playAction:Chapel', 'doneTrash',
      'endActions', 'endBuy', 'playAction:Smithy', 'endActions', 'buy:Silver', 'endBuy', 'playAction:Market',
      'playAction:Village', 'endActions', 'buy:Curse', 'buy:Curse', 'endBuy', 'endActions', 'buy:Smithy',
      'endBuy', 'endActions', 'buy:Estate', 'endBuy', 'endActions', 'buy:Chapel', 'endBuy', 'endActions',
      'buy:Copper', 'endBuy', 'playAction:Chapel', 'trashCard:Silver', 'trashCard:Copper', 'trashCard:Copper',
      'trashCard:Copper', 'endActions', 'buy:Copper', 'endBuy', 'playAction:Woodcutter', 'endActions',
      'buy:Copper', 'buy:Copper', 'endBuy', 'endActions', 'buy:Copper', 'endBuy', 'playAction:Village',
      'endActions', 'buy:Estate', 'endBuy', 'endActions', 'buy:Smithy', 'endBuy', 'playAction:Market',
      'playAction:Chapel', 'trashCard:Curse', 'trashCard:Estate', 'trashCard:Curse', 'trashCard:Copper',
      'endActions', 'endBuy', 'playAction:Chapel', 'doneTrash', 'endActions', 'buy:Copper', 'endBuy',
      'playAction:Market', 'endActions', 'buy:Chapel', 'buy:Copper', 'endBuy', 'endActions', 'buy:Copper',
      'endBuy', 'endActions', 'endBuy', 'endActions', 'buy:Woodcutter', 'endBuy', 'endActions', 'buy:Estate',
      'endBuy', 'playAction:Chapel', 'trashCard:Copper', 'trashCard:Silver', 'trashCard:Estate',
      'trashCard:Copper', 'endActions', 'buy:Copper', 'endBuy', 'endActions', 'buy:Copper', 'endBuy',
      'playAction:Chapel', 'trashCard:Laboratory', 'doneTrash', 'endActions', 'endBuy', 'playAction:Chapel',
      'trashCard:Curse', 'trashCard:Copper', 'trashCard:Copper', 'trashCard:Curse', 'endActions', 'endBuy',
      'playAction:Smithy', 'endActions', 'buy:Estate', 'endBuy', 'playAction:Chapel', 'trashCard:Copper',
      'trashCard:Curse', 'trashCard:Estate', 'doneTrash', 'endActions', 'buy:Copper', 'endBuy', 'endActions',
      'buy:Copper', 'endBuy', 'endActions', 'buy:Smithy', 'endBuy', 'playAction:Smithy', 'endActions',
      'endBuy', 'playAction:Market', 'playAction:Market', 'endActions', 'buy:Silver', 'buy:Copper', 'endBuy',
      'playAction:Chapel', 'trashCard:Silver', 'trashCard:Copper', 'trashCard:Copper', 'trashCard:Copper',
      'endActions', 'buy:Copper', 'endBuy', 'playAction:Village', 'endActions', 'buy:Estate', 'endBuy',
      'playAction:Smithy', 'endActions', 'endBuy', 'endActions', 'buy:Estate', 'endBuy', 'playAction:Woodcutter',
      'endActions', 'endBuy', 'endActions', 'buy:Copper', 'endBuy', 'endActions', 'buy:Copper', 'endBuy',
      'playAction:Chapel', 'doneTrash', 'endActions', 'buy:Chapel', 'endBuy', 'endActions', 'buy:Copper',
      'endBuy', 'playAction:Chapel', 'trashCard:Village', 'doneTrash', 'endActions', 'buy:Silver', 'endBuy',
      'endActions', 'endBuy', 'endActions', 'endBuy', 'endActions', 'endBuy', 'endActions', 'buy:Chapel',
      'endBuy', 'endActions', 'endBuy', 'endActions', 'buy:Chapel', 'endBuy', 'playAction:Witch', 'endActions',
      'buy:Chapel', 'endBuy',
    ],
    finalScores: [5, -1],
  },
  {
    id: 'dominion-2p-seed-22',
    seed: 22,
    choiceKeys: [
      'endActions', 'buy:Silver', 'endBuy', 'endActions', 'buy:Estate', 'endBuy', 'endActions', 'buy:Estate',
      'endBuy', 'endActions', 'buy:Smithy', 'endBuy', 'endActions', 'buy:Moat', 'endBuy', 'endActions',
      'buy:Smithy', 'endBuy', 'endActions', 'buy:Copper', 'endBuy', 'endActions', 'buy:Curse', 'endBuy',
      'endActions', 'buy:Estate', 'endBuy', 'playAction:Smithy', 'endActions', 'buy:Woodcutter', 'endBuy',
      'endActions', 'buy:Estate', 'endBuy', 'endActions', 'buy:Copper', 'endBuy', 'endActions', 'buy:Chapel',
      'endBuy', 'playAction:Woodcutter', 'endActions', 'buy:Copper', 'buy:Copper', 'endBuy', 'endActions',
      'buy:Witch', 'endBuy', 'playAction:Smithy', 'endActions', 'buy:Curse', 'endBuy', 'endActions', 'endBuy',
      'endActions', 'buy:Moat', 'endBuy', 'playAction:Moat', 'endActions', 'buy:Silver', 'endBuy', 'endActions',
      'buy:Silver', 'endBuy', 'playAction:Chapel', 'doneTrash', 'endActions', 'endBuy', 'endActions',
      'buy:Copper', 'endBuy', 'endActions', 'endBuy', 'endActions', 'buy:Silver', 'endBuy', 'endActions',
      'buy:Copper', 'endBuy', 'playAction:Moat', 'endActions', 'buy:Curse', 'endBuy', 'endActions', 'endBuy',
      'endActions', 'buy:Woodcutter', 'endBuy', 'endActions', 'endBuy', 'endActions', 'buy:Smithy', 'endBuy',
      'playAction:Moat', 'endActions', 'endBuy', 'endActions', 'buy:Laboratory', 'endBuy', 'endActions',
      'buy:Curse', 'endBuy', 'playAction:Woodcutter', 'endActions', 'buy:Chapel', 'endBuy', 'playAction:Chapel',
      'doneTrash', 'endActions', 'buy:Moat', 'endBuy', 'playAction:Woodcutter', 'endActions', 'buy:Estate',
      'buy:Estate', 'endBuy', 'endActions', 'buy:Estate', 'endBuy', 'playAction:Smithy', 'endActions',
      'buy:Silver', 'endBuy', 'endActions', 'buy:Chapel', 'endBuy', 'playAction:Smithy', 'endActions',
      'buy:Estate', 'endBuy', 'playAction:Moat', 'endActions', 'buy:Moat', 'endBuy', 'playAction:Woodcutter',
      'endActions', 'buy:Festival', 'buy:Chapel', 'endBuy', 'endActions', 'buy:Woodcutter', 'endBuy',
      'playAction:Moat', 'endActions', 'buy:Moat', 'endBuy', 'endActions', 'buy:Curse', 'endBuy',
      'playAction:Woodcutter', 'endActions', 'buy:Copper', 'buy:Silver', 'endBuy', 'playAction:Moat',
      'endActions', 'buy:Copper', 'endBuy', 'playAction:Smithy', 'endActions', 'buy:Copper', 'endBuy',
      'endActions', 'buy:Moat', 'endBuy', 'endActions', 'buy:Woodcutter', 'endBuy', 'endActions', 'buy:Copper',
      'endBuy', 'endActions', 'buy:Moat', 'endBuy', 'endActions', 'buy:Moat', 'endBuy', 'playAction:Chapel',
      'trashCard:Copper', 'doneTrash', 'endActions', 'buy:Curse', 'endBuy', 'endActions', 'endBuy',
      'playAction:Woodcutter', 'endActions', 'buy:Festival', 'buy:Copper', 'endBuy', 'endActions', 'buy:Copper',
      'endBuy', 'endActions', 'buy:Silver', 'endBuy', 'playAction:Moat', 'endActions', 'buy:Market', 'endBuy',
      'endActions', 'buy:Chapel', 'endBuy', 'playAction:Moat', 'endActions', 'buy:Village', 'endBuy',
      'endActions', 'buy:Village', 'endBuy', 'endActions', 'buy:Curse', 'endBuy', 'endActions', 'buy:Market',
      'endBuy', 'endActions', 'endBuy', 'playAction:Chapel', 'doneTrash', 'endActions', 'endBuy',
      'playAction:Chapel', 'doneTrash', 'endActions', 'buy:Copper', 'endBuy', 'playAction:Festival',
      'endActions', 'buy:Village', 'endBuy', 'playAction:Moat', 'endActions', 'buy:Chapel', 'endBuy',
      'endActions', 'endBuy', 'endActions', 'endBuy', 'playAction:Woodcutter', 'endActions', 'buy:Duchy',
      'buy:Curse', 'endBuy', 'playAction:Market', 'endActions', 'buy:Chapel', 'buy:Copper', 'endBuy',
      'endActions', 'buy:Copper', 'endBuy', 'playAction:Village', 'playAction:Market', 'playAction:Moat',
      'playAction:Moat', 'endActions', 'buy:Laboratory', 'endBuy', 'playAction:Woodcutter', 'endActions',
      'buy:Chapel', 'buy:Copper', 'endBuy', 'endActions', 'buy:Curse', 'endBuy', 'playAction:Smithy',
      'endActions', 'buy:Market', 'endBuy', 'playAction:Witch', 'endActions', 'buy:Moat', 'endBuy',
      'endActions', 'buy:Curse', 'endBuy', 'endActions', 'buy:Copper', 'endBuy', 'endActions', 'buy:Copper',
      'endBuy', 'playAction:Chapel', 'trashCard:Moat', 'trashCard:Copper', 'trashCard:Moat', 'doneTrash',
      'endActions', 'endBuy', 'endActions', 'buy:Village', 'endBuy', 'playAction:Chapel', 'trashCard:Estate',
      'trashCard:Curse', 'trashCard:Copper', 'doneTrash', 'endActions', 'endBuy', 'endActions', 'buy:Copper',
      'endBuy', 'playAction:Moat', 'endActions', 'buy:Copper', 'endBuy', 'endActions', 'buy:Village', 'endBuy',
      'endActions', 'buy:Smithy', 'endBuy', 'playAction:Chapel', 'trashCard:Village', 'trashCard:Copper',
      'doneTrash', 'endActions', 'endBuy', 'playAction:Witch', 'endActions', 'endBuy', 'playAction:Festival',
      'playAction:Village', 'playAction:Market', 'endActions', 'buy:Smithy', 'buy:Silver', 'buy:Copper',
      'endBuy', 'endActions', 'buy:Copper', 'endBuy', 'playAction:Chapel', 'trashCard:Copper', 'trashCard:Moat',
      'trashCard:Smithy', 'trashCard:Silver', 'endActions', 'endBuy', 'endActions', 'buy:Chapel', 'endBuy',
      'endActions', 'endBuy', 'endActions', 'buy:Chapel', 'endBuy',
    ],
    finalScores: [3, 4],
  },
  {
    id: 'dominion-2p-seed-33',
    seed: 33,
    choiceKeys: [
      'endActions', 'buy:Moat', 'endBuy', 'endActions', 'buy:Militia', 'endBuy', 'endActions', 'buy:Village',
      'endBuy', 'endActions', 'buy:Copper', 'endBuy', 'endActions', 'buy:Village', 'endBuy', 'endActions',
      'buy:Village', 'endBuy', 'playAction:Village', 'endActions', 'buy:Moat', 'endBuy', 'endActions',
      'buy:Woodcutter', 'endBuy', 'playAction:Moat', 'endActions', 'buy:Village', 'endBuy', 'endActions',
      'buy:Village', 'endBuy', 'endActions', 'endBuy', 'playAction:Woodcutter', 'endActions', 'buy:Village',
      'endBuy', 'endActions', 'buy:Curse', 'endBuy', 'endActions', 'buy:Village', 'endBuy', 'endActions',
      'buy:Market', 'endBuy', 'playAction:Woodcutter', 'endActions', 'buy:Copper', 'endBuy', 'playAction:Village',
      'playAction:Village', 'endActions', 'buy:Curse', 'endBuy', 'playAction:Village', 'endActions',
      'buy:Woodcutter', 'endBuy', 'playAction:Moat', 'endActions', 'buy:Estate', 'endBuy', 'endActions',
      'buy:Estate', 'endBuy', 'playAction:Village', 'playAction:Market', 'endActions', 'endBuy', 'endActions',
      'buy:Copper', 'endBuy', 'playAction:Moat', 'endActions', 'buy:Moat', 'endBuy', 'playAction:Woodcutter',
      'endActions', 'buy:Silver', 'buy:Village', 'endBuy', 'endActions', 'buy:Chapel', 'endBuy',
      'playAction:Militia', 'endActions', 'buy:Estate', 'endBuy', 'playAction:Moat', 'endActions', 'buy:Chapel',
      'endBuy', 'playAction:Village', 'endActions', 'buy:Estate', 'endBuy', 'endActions', 'endBuy',
      'playAction:Woodcutter', 'endActions', 'buy:Copper', 'buy:Silver', 'endBuy', 'playAction:Moat',
      'endActions', 'buy:Village', 'endBuy', 'playAction:Woodcutter', 'endActions', 'buy:Chapel', 'buy:Village',
      'endBuy', 'endActions', 'buy:Copper', 'endBuy', 'endActions', 'buy:Chapel', 'endBuy', 'playAction:Village',
      'endActions', 'buy:Woodcutter', 'endBuy', 'endActions', 'buy:Chapel', 'endBuy', 'playAction:Moat',
      'endActions', 'endBuy', 'endActions', 'endBuy', 'playAction:Village', 'playAction:Moat', 'playAction:Village',
      'playAction:Chapel', 'doneTrash', 'endActions', 'endBuy', 'endActions', 'buy:Copper', 'endBuy',
      'playAction:Moat', 'endActions', 'buy:Curse', 'endBuy', 'endActions', 'buy:Curse', 'endBuy',
      'playAction:Chapel', 'trashCard:Copper', 'trashCard:Copper', 'trashCard:Copper', 'doneTrash', 'endActions',
      'endBuy', 'playAction:Woodcutter', 'endActions', 'buy:Militia', 'buy:Curse', 'endBuy', 'playAction:Woodcutter',
      'endActions', 'buy:Workshop', 'buy:Copper', 'endBuy', 'endActions', 'buy:Curse', 'endBuy', 'playAction:Village',
      'endActions', 'buy:Estate', 'endBuy', 'endActions', 'buy:Chapel', 'endBuy', 'endActions', 'buy:Copper',
      'endBuy', 'endActions', 'buy:Copper', 'endBuy', 'playAction:Market', 'playAction:Moat', 'endActions',
      'buy:Copper', 'buy:Chapel', 'endBuy', 'playAction:Village', 'playAction:Woodcutter', 'endActions',
      'buy:Militia', 'buy:Curse', 'endBuy', 'endActions', 'buy:Curse', 'endBuy', 'playAction:Village',
      'endActions', 'buy:Workshop', 'endBuy', 'endActions', 'buy:Workshop', 'endBuy', 'playAction:Village',
      'playAction:Village', 'endActions', 'buy:Moat', 'endBuy', 'endActions', 'buy:Copper', 'endBuy',
      'endActions', 'buy:Copper', 'endBuy', 'endActions', 'buy:Chapel', 'endBuy', 'endActions', 'buy:Copper',
      'endBuy', 'endActions', 'endBuy', 'playAction:Chapel', 'trashCard:Copper', 'trashCard:Copper', 'doneTrash',
      'endActions', 'buy:Copper', 'endBuy', 'playAction:Chapel', 'trashCard:Market', 'trashCard:Curse',
      'doneTrash', 'endActions', 'buy:Curse', 'endBuy', 'playAction:Village', 'playAction:Chapel',
      'trashCard:Curse', 'trashCard:Copper', 'trashCard:Copper', 'trashCard:Copper', 'endActions', 'buy:Copper',
      'endBuy', 'endActions', 'buy:Curse', 'endBuy', 'endActions', 'endBuy', 'playAction:Village',
      'playAction:Woodcutter', 'endActions', 'buy:Estate', 'buy:Copper', 'endBuy', 'endActions', 'buy:Copper',
      'endBuy', 'endActions', 'buy:Chapel', 'endBuy', 'playAction:Chapel', 'doneTrash', 'endActions', 'buy:Moat',
      'endBuy', 'endActions', 'endBuy', 'endActions', 'buy:Moat', 'endBuy', 'endActions', 'endBuy',
      'playAction:Workshop', 'gainCard:Chapel', 'endActions', 'buy:Copper', 'endBuy',
    ],
    finalScores: [1, 3],
  },
];

export const dominionAdapter: GameAdapter<DominionState, DominionObservation, DominionChoice> = {
  spec: {
    gameId: 'dominion-2p-core',
    playerCount: PLAYER_COUNT,
    decisionPoints: [
      { id: 'action', description: 'Play an action card from hand, or end the action phase.' },
      { id: 'buy', description: 'Buy a card from the supply (treasures auto-played), or end the buy phase.' },
      { id: 'chapelTrash', description: 'Trash up to 4 cards from hand after playing Chapel, one at a time.' },
      { id: 'workshopGain', description: 'Gain one card costing 4 or less after playing Workshop.' },
      { id: 'militiaDiscard', description: 'Discard down to 3 cards after an opponent plays Militia (unblocked).' },
    ],
    seatingPlan: [
      [0, 1],
      [1, 0],
    ],
    maxDecisionsPerGame: 800,
  },
  createInitialState,
  currentDecision,
  getObservation,
  getLegalChoices,
  applyChoice,
  getOutcome,
  encodeChoice,
  sampleStateFromObservation,
  invariants: [cardConservationInvariant, nonNegativeSupplyInvariant, nonNegativeResourcesInvariant],
  contentInventory,
  exercisedContent,
  hiddenInfoProbe: dominionHiddenInfoProbe,
  replayFixtures,
  baselines: {
    random: randomBaseline,
    heuristic: heuristicBaseline,
  },
  strategySurface: [
    rushProvinces,
    playCheapestActionFirst,
    trashCoppersEagerly,
    chapelEconomy,
    chapelEconomyD08,
    chapelEconomyLate3,
    simpleEconomyNoTrash,
    chapelEconomyV2,
    chapelEconomyV2NoGreen,
    chapelEconomyV2CloneBuy,
    witchRushNoTrash,
    opusCloneDominion,
  ],
  choiceEvaluator: dominionChoiceEvaluator,
};
