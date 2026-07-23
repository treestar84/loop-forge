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
  strategySurface: [rushProvinces, playCheapestActionFirst, trashCoppersEagerly],
};
