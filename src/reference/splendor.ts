/**
 * splendor — reference GameAdapter implementation onboarding a real open-source
 * game (https://github.com/caeleel/splendor, server/player_and_game.py +
 * server/splendor.py) onto Loop Forge.
 *
 * 2-player configuration only (see docs/ONBOARDING-GUIDE.md §2 "어댑터 1개 =
 * 게임 설정 1개" — 3p/4p would need sibling adapters sharing this core logic;
 * out of scope for this onboarding pass).
 *
 * Turn model, transcribed from the reference source rather than the printed
 * Splendor rulebook (deliberate — the source is ground truth here, and it
 * differs from the rulebook in a few places, documented inline below):
 *
 *   - A turn is one of: take gems, buy a card, or reserve a card, followed by
 *     an optional forced discard step baked into the "reserve while at 10
 *     gems" case.
 *   - Taking gems is itself a short sequence of 1-3 sub-decisions (up to 3
 *     distinct colors, or exactly 2 of one color from a pile of >=4). The
 *     reference server has NO explicit "stop taking" action — once you take
 *     a first gem you are only released from the sub-loop by hitting one of
 *     the two completion conditions. That would make some legal true-Splendor
 *     turns (take just 1 or 2 gems and stop) unreachable and can dead-end a
 *     playout, so this adapter adds a synthetic `takeDone` choice once at
 *     least one gem has been taken. Documented as a deliberate deviation in
 *     the onboarding report, not a silent guess.
 *   - `discard` never ends a turn in the reference source (`Game.discard`
 *     does not call `next_turn`); it exists purely so a player sitting at 10
 *     gems can shed one before `reserve` (which is blocked at >9 gems whenever
 *     the gold pile is non-empty). This adapter only offers `discard` as a
 *     legal choice when the active player is at >=10 gems, which is the only
 *     situation in which it is ever useful; the source technically allows it
 *     unconditionally, but doing so would let a bot discard forever with no
 *     legal-set boundary tying it to a purpose, which is undesirable for a
 *     bounded conformance playout budget.
 *   - Noble visits are automatic when exactly one noble qualifies (checked at
 *     start-of-turn and right after a `buy`). When multiple nobles qualify at
 *     once (only possible right after a `buy`, since gems never grant a
 *     noble), the player must choose — a real, if rare, decision point.
 */

import type {
  BotFactory,
  GameAdapter,
  GameBot,
  Outcome,
  PendingDecision,
  PlayerId,
  ReplayFixture,
  StrategyFlagSpec,
} from '../contract/types';
import { createRng, shuffled } from '../kernel/rng';

export type Color = 'w' | 'u' | 'g' | 'r' | 'b';
export type Gem = Color | 'gold';
export type Level = 1 | 2 | 3;

const COLORS: readonly Color[] = ['w', 'u', 'g', 'r', 'b'];
const GEMS: readonly Gem[] = [...COLORS, 'gold'];
const LEVELS: readonly Level[] = [1, 2, 3];
const PLAYER_COUNT = 2;
const STARTING_GEMS_PER_COLOR = 4; // 2-player count, per Game.add_player.
const STARTING_GOLD = 5;
const NOBLES_ON_BOARD = PLAYER_COUNT + 1; // 3 for 2 players.
const WIN_SCORE = 15;
const MAX_RESERVED = 3;
const MAX_GEMS = 10;
const STALE_TURN_LIMIT = 40; // see SplendorState.staleTurns doc comment.

export interface SplendorCard {
  readonly id: string;
  readonly level: Level;
  readonly color: Color;
  readonly points: number;
  readonly cost: Readonly<Record<Color, number>>;
}

export interface SplendorNoble {
  readonly id: string;
  readonly points: number;
  readonly requirement: Readonly<Record<Color, number>>;
}

function cost(w: number, u: number, g: number, r: number, b: number): Record<Color, number> {
  return { w, u, g, r, b };
}

// Transcribed positional args are (color, points, w, u, g, r, b) in the
// reference source's Card(c, p, w=0, u=0, g=0, r=0, b=0).
const LEVEL_1_RAW: ReadonlyArray<[Color, number, number, number, number, number, number]> = [
  ['b', 0, 1, 1, 1, 1, 0],
  ['b', 0, 1, 2, 1, 1, 0],
  ['b', 0, 2, 2, 0, 1, 0],
  ['b', 0, 0, 0, 1, 3, 1],
  ['b', 0, 0, 0, 2, 1, 0],
  ['b', 0, 2, 0, 2, 0, 0],
  ['b', 0, 0, 0, 3, 0, 0],
  ['b', 1, 0, 4, 0, 0, 0],
  ['u', 0, 1, 0, 1, 1, 1],
  ['u', 0, 1, 0, 1, 2, 1],
  ['u', 0, 1, 0, 2, 2, 0],
  ['u', 0, 0, 1, 3, 1, 0],
  ['u', 0, 1, 0, 0, 0, 2],
  ['u', 0, 0, 0, 2, 0, 2],
  ['u', 0, 0, 0, 0, 0, 3],
  ['u', 1, 0, 0, 0, 4, 0],
  ['w', 0, 0, 1, 1, 1, 1],
  ['w', 0, 0, 1, 2, 1, 1],
  ['w', 0, 0, 2, 2, 0, 1],
  ['w', 0, 3, 1, 0, 0, 1],
  ['w', 0, 0, 0, 0, 2, 1],
  ['w', 0, 0, 2, 0, 0, 2],
  ['w', 0, 0, 3, 0, 0, 0],
  ['w', 1, 0, 0, 4, 0, 0],
  ['g', 0, 1, 1, 0, 1, 1],
  ['g', 0, 1, 1, 0, 1, 2],
  ['g', 0, 0, 1, 0, 2, 2],
  ['g', 0, 1, 3, 1, 0, 0],
  ['g', 0, 2, 1, 0, 0, 0],
  ['g', 0, 0, 2, 0, 2, 0],
  ['g', 0, 0, 0, 0, 3, 0],
  ['g', 1, 0, 0, 0, 0, 4],
  ['r', 0, 1, 1, 1, 0, 1],
  ['r', 0, 2, 1, 1, 0, 1],
  ['r', 0, 2, 0, 1, 0, 2],
  ['r', 0, 1, 0, 0, 1, 3],
  ['r', 0, 0, 2, 1, 0, 0],
  ['r', 0, 2, 0, 0, 2, 0],
  ['r', 0, 3, 0, 0, 0, 0],
  ['r', 1, 4, 0, 0, 0, 0],
];

const LEVEL_2_RAW: ReadonlyArray<[Color, number, number, number, number, number, number]> = [
  ['b', 1, 3, 2, 2, 0, 0],
  ['b', 1, 3, 0, 3, 0, 2],
  ['b', 2, 0, 1, 4, 2, 0],
  ['b', 2, 0, 0, 5, 3, 0],
  ['b', 2, 5, 0, 0, 0, 0],
  ['b', 3, 0, 0, 0, 0, 6],
  ['u', 1, 0, 2, 2, 3, 0],
  ['u', 1, 0, 2, 3, 0, 3],
  ['u', 2, 5, 3, 0, 0, 0],
  ['u', 2, 2, 0, 0, 1, 4],
  ['u', 2, 0, 5, 0, 0, 0],
  ['u', 3, 0, 6, 0, 0, 0],
  ['w', 1, 0, 0, 3, 2, 2],
  ['w', 1, 2, 3, 0, 3, 0],
  ['w', 2, 0, 0, 1, 4, 2],
  ['w', 2, 0, 0, 0, 5, 3],
  ['w', 2, 0, 0, 0, 5, 0],
  ['w', 3, 6, 0, 0, 0, 0],
  ['g', 1, 3, 0, 2, 3, 0],
  ['g', 1, 2, 3, 0, 0, 2],
  ['g', 2, 4, 2, 0, 0, 1],
  ['g', 2, 0, 5, 3, 0, 0],
  ['g', 2, 0, 0, 5, 0, 0],
  ['g', 3, 0, 0, 6, 0, 0],
  ['r', 1, 2, 0, 0, 2, 3],
  ['r', 1, 0, 3, 0, 2, 3],
  ['r', 2, 1, 4, 2, 0, 0],
  ['r', 2, 3, 0, 0, 0, 5],
  ['r', 2, 0, 0, 0, 0, 5],
  ['r', 3, 0, 0, 0, 6, 0],
];

const LEVEL_3_RAW: ReadonlyArray<[Color, number, number, number, number, number, number]> = [
  ['b', 3, 3, 3, 5, 3, 0],
  ['b', 4, 0, 0, 0, 7, 0],
  ['b', 4, 0, 0, 3, 6, 3],
  ['b', 5, 0, 0, 0, 7, 3],
  ['u', 3, 3, 0, 3, 3, 5],
  ['u', 4, 7, 0, 0, 0, 0],
  ['u', 4, 6, 3, 0, 0, 3],
  ['u', 5, 7, 3, 0, 0, 0],
  ['w', 3, 0, 3, 3, 5, 3],
  ['w', 4, 0, 0, 0, 0, 7],
  ['w', 4, 3, 0, 0, 3, 6],
  ['w', 5, 3, 0, 0, 0, 7],
  ['g', 3, 5, 3, 0, 3, 3],
  ['g', 4, 0, 7, 0, 0, 0],
  ['g', 4, 3, 6, 3, 0, 0],
  ['g', 5, 0, 7, 3, 0, 0],
  ['r', 3, 3, 5, 3, 0, 3],
  ['r', 4, 0, 0, 7, 0, 0],
  ['r', 4, 0, 3, 6, 3, 0],
  ['r', 5, 0, 0, 7, 3, 0],
];

function buildLevel(raw: typeof LEVEL_1_RAW, level: Level, prefix: string): SplendorCard[] {
  return raw.map(([color, points, w, u, g, r, b], index) => ({
    id: `${prefix}-${String(index).padStart(2, '0')}`,
    level,
    color,
    points,
    cost: cost(w, u, g, r, b),
  }));
}

const ALL_LEVEL_1 = buildLevel(LEVEL_1_RAW, 1, 'L1');
const ALL_LEVEL_2 = buildLevel(LEVEL_2_RAW, 2, 'L2');
const ALL_LEVEL_3 = buildLevel(LEVEL_3_RAW, 3, 'L3');

const NOBLE_DEFS: ReadonlyArray<{
  readonly id: string;
  readonly requirement: Record<Color, number>;
}> = [
  { id: 'N0', requirement: cost(0, 0, 0, 4, 4) },
  { id: 'N1', requirement: cost(0, 0, 3, 3, 3) },
  { id: 'N2', requirement: cost(0, 4, 4, 0, 0) },
  { id: 'N3', requirement: cost(4, 4, 0, 0, 0) },
  { id: 'N4', requirement: cost(3, 3, 0, 0, 3) },
  { id: 'N5', requirement: cost(0, 0, 4, 4, 0) },
  { id: 'N6', requirement: cost(0, 3, 3, 3, 0) },
  { id: 'N7', requirement: cost(4, 0, 0, 0, 4) },
  { id: 'N8', requirement: cost(3, 3, 3, 0, 0) },
  { id: 'N9', requirement: cost(3, 0, 0, 3, 3) },
];

const ALL_NOBLES: SplendorNoble[] = NOBLE_DEFS.map((def) => ({
  id: def.id,
  points: 3,
  requirement: def.requirement,
}));

const ALL_CARDS: readonly SplendorCard[] = [...ALL_LEVEL_1, ...ALL_LEVEL_2, ...ALL_LEVEL_3];
const TOTAL_CARDS = ALL_CARDS.length; // 90

export interface PlayerState {
  readonly gems: Readonly<Record<Gem, number>>;
  readonly cards: Readonly<Record<Color, readonly SplendorCard[]>>;
  readonly reserved: readonly SplendorCard[];
  readonly nobles: readonly SplendorNoble[];
}

export interface SplendorState {
  readonly players: readonly [PlayerState, PlayerState];
  readonly board: Readonly<Record<Level, readonly SplendorCard[]>>;
  readonly decks: Readonly<Record<Level, readonly SplendorCard[]>>;
  readonly noblePool: readonly SplendorNoble[];
  readonly revealedNobleIds: readonly string[];
  readonly bank: Readonly<Record<Gem, number>>;
  readonly active: PlayerId;
  readonly takenColors: readonly Color[];
  readonly pendingNobleChoices: readonly string[] | null;
  readonly isLastRound: boolean;
  readonly gameOver: boolean;
  readonly revealedCardIds: readonly string[];
  /**
   * Consecutive turn-advances since either player last bought a card.
   * Reference source has no anti-stall rule (ONBOARDING-GUIDE.md §5 "종국
   * 규칙 구현 필수"), and a real dead position is reachable: both players at
   * the 10-gem cap with 3 reserved cards and no affordable purchase can
   * cycle discard->take forever, since discard refunds the bank and take
   * only requires an empty slot. STALE_TURN_LIMIT ends the game as a
   * stalemate (scored via the normal tiebreak) instead of running out the
   * decision budget as an undifferentiated defect.
   */
  readonly staleTurns: number;
}

export interface SplendorObservation {
  readonly self: PlayerId;
  readonly players: readonly [PlayerState, PlayerState];
  readonly board: Readonly<Record<Level, readonly SplendorCard[]>>;
  readonly deckCounts: Readonly<Record<Level, number>>;
  readonly nobles: readonly SplendorNoble[];
  readonly bank: Readonly<Record<Gem, number>>;
  readonly active: PlayerId;
  readonly takenColors: readonly Color[];
  readonly pendingNobleChoices: readonly string[] | null;
}

export type SplendorChoice =
  | { readonly kind: 'take'; readonly color: Color }
  | { readonly kind: 'takeDone' }
  | { readonly kind: 'buy'; readonly cardId: string }
  | { readonly kind: 'reserve'; readonly cardId: string }
  | { readonly kind: 'reserveBlind'; readonly level: Level }
  | { readonly kind: 'discard'; readonly gem: Gem }
  | { readonly kind: 'noble'; readonly nobleId: string };

function otherPlayer(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

function getPlayer(state: SplendorState, id: PlayerId): PlayerState {
  const player = state.players[id];
  if (!player) throw new Error(`getPlayer: no such player ${id}`);
  return player;
}

function totalGems(player: PlayerState): number {
  return GEMS.reduce((sum, gem) => sum + player.gems[gem], 0);
}

function power(player: PlayerState, color: Color): number {
  return player.gems[color] + player.cards[color].length;
}

function score(player: PlayerState): number {
  const cardPoints = COLORS.reduce(
    (sum, color) => sum + player.cards[color].reduce((s, card) => s + card.points, 0),
    0,
  );
  const noblePoints = player.nobles.reduce((sum, noble) => sum + noble.points, 0);
  return cardPoints + noblePoints;
}

function ownedCardCount(player: PlayerState): number {
  return COLORS.reduce((sum, color) => sum + player.cards[color].length, 0);
}

function tiebreakScore(player: PlayerState): number {
  return score(player) * 100 - ownedCardCount(player);
}

function qualifyingNobles(player: PlayerState, pool: readonly SplendorNoble[]): SplendorNoble[] {
  return pool.filter((noble) => COLORS.every((c) => player.cards[c].length >= noble.requirement[c]));
}

function findBoardCard(state: SplendorState, cardId: string): { level: Level; card: SplendorCard } | null {
  for (const level of LEVELS) {
    const found = state.board[level].find((c) => c.id === cardId);
    if (found) return { level, card: found };
  }
  return null;
}

function findReservedCard(player: PlayerState, cardId: string): SplendorCard | null {
  return player.reserved.find((c) => c.id === cardId) ?? null;
}

function withPlayer(
  state: SplendorState,
  player: PlayerId,
  update: (p: PlayerState) => PlayerState,
): SplendorState {
  const players: [PlayerState, PlayerState] = [...state.players];
  players[player] = update(getPlayer(state, player));
  return { ...state, players };
}

function refillBoard(state: SplendorState): SplendorState {
  const board: Record<Level, readonly SplendorCard[]> = { ...state.board };
  const decks: Record<Level, readonly SplendorCard[]> = { ...state.decks };
  let revealedCardIds = state.revealedCardIds;
  for (const level of LEVELS) {
    let boardLevel = board[level];
    let deckLevel = decks[level];
    while (boardLevel.length < 4 && deckLevel.length > 0) {
      const drawn = deckLevel[deckLevel.length - 1] as SplendorCard;
      deckLevel = deckLevel.slice(0, -1);
      boardLevel = [...boardLevel, drawn];
      revealedCardIds = [...revealedCardIds, drawn.id];
    }
    board[level] = boardLevel;
    decks[level] = deckLevel;
  }
  return { ...state, board, decks, revealedCardIds };
}

export function createInitialState(seed: number): SplendorState {
  const rng = createRng(seed);
  const level1 = shuffled(ALL_LEVEL_1, rng.fork('tier1'));
  const level2 = shuffled(ALL_LEVEL_2, rng.fork('tier2'));
  const level3 = shuffled(ALL_LEVEL_3, rng.fork('tier3'));
  const nobles = shuffled(ALL_NOBLES, rng.fork('nobles')).slice(0, NOBLES_ON_BOARD);

  const bank: Record<Gem, number> = { w: 0, u: 0, g: 0, r: 0, b: 0, gold: STARTING_GOLD };
  for (const color of COLORS) bank[color] = STARTING_GEMS_PER_COLOR;

  const emptyPlayer: PlayerState = {
    gems: { w: 0, u: 0, g: 0, r: 0, b: 0, gold: 0 },
    cards: { w: [], u: [], g: [], r: [], b: [] },
    reserved: [],
    nobles: [],
  };

  const decks: Record<Level, readonly SplendorCard[]> = { 1: level1, 2: level2, 3: level3 };
  const board: Record<Level, readonly SplendorCard[]> = { 1: [], 2: [], 3: [] };

  const initial: SplendorState = {
    players: [emptyPlayer, emptyPlayer],
    board,
    decks,
    noblePool: nobles,
    revealedNobleIds: nobles.map((n) => n.id),
    bank,
    active: 0,
    takenColors: [],
    pendingNobleChoices: null,
    isLastRound: false,
    gameOver: false,
    staleTurns: 0,
    revealedCardIds: [],
  };

  return refillBoard(initial);
}

function currentDecision(state: SplendorState): PendingDecision | null {
  if (state.gameOver) return null;
  if (state.pendingNobleChoices) return { player: state.active, decisionPoint: 'noble' };
  if (state.takenColors.length > 0) return { player: state.active, decisionPoint: 'take' };
  return { player: state.active, decisionPoint: 'action' };
}

function affordable(player: PlayerState, card: SplendorCard): boolean {
  let owed = 0;
  for (const color of COLORS) {
    const deficit = card.cost[color] - power(player, color);
    if (deficit > 0) owed += deficit;
  }
  return owed <= player.gems.gold;
}

function takeContinuationChoices(state: SplendorState): SplendorChoice[] {
  const player = getPlayer(state, state.active);
  const taken = state.takenColors;
  const choices: SplendorChoice[] = [];
  if (taken.length <= 2 && totalGems(player) <= 9) {
    for (const color of COLORS) {
      if (state.bank[color] <= 0) continue;
      if (taken.length > 1 && taken.includes(color)) continue;
      if (taken.length === 1 && taken[0] === color && state.bank[color] < 3) continue;
      choices.push({ kind: 'take', color });
    }
  }
  if (taken.length >= 1) choices.push({ kind: 'takeDone' });
  return choices;
}

function actionPhaseChoices(state: SplendorState): SplendorChoice[] {
  const player = getPlayer(state, state.active);
  const choices: SplendorChoice[] = [];

  if (totalGems(player) <= 9) {
    for (const color of COLORS) {
      if (state.bank[color] > 0) choices.push({ kind: 'take', color });
    }
  }

  for (const level of LEVELS) {
    for (const card of state.board[level]) {
      if (affordable(player, card)) choices.push({ kind: 'buy', cardId: card.id });
    }
  }
  for (const card of player.reserved) {
    if (affordable(player, card)) choices.push({ kind: 'buy', cardId: card.id });
  }

  const reserveBlocked = state.bank.gold > 0 && totalGems(player) > 9;
  if (player.reserved.length < MAX_RESERVED && !reserveBlocked) {
    for (const level of LEVELS) {
      for (const card of state.board[level]) {
        choices.push({ kind: 'reserve', cardId: card.id });
      }
      if (state.decks[level].length > 0) choices.push({ kind: 'reserveBlind', level });
    }
  }

  if (totalGems(player) >= MAX_GEMS) {
    for (const gem of GEMS) {
      if (player.gems[gem] > 0) choices.push({ kind: 'discard', gem });
    }
  }

  return choices;
}

function getLegalChoices(state: SplendorState): readonly SplendorChoice[] {
  const decision = currentDecision(state);
  if (!decision) throw new Error('getLegalChoices: game is already over');
  if (decision.decisionPoint === 'noble') {
    return (state.pendingNobleChoices ?? []).map((nobleId) => ({ kind: 'noble', nobleId }) as const);
  }
  if (decision.decisionPoint === 'take') {
    return takeContinuationChoices(state);
  }
  return actionPhaseChoices(state);
}

function sameChoice(a: SplendorChoice, b: SplendorChoice): boolean {
  return encodeChoice(a) === encodeChoice(b);
}

function advanceTurn(state: SplendorState): SplendorState {
  const finishingPlayer = getPlayer(state, state.active);
  let isLastRound = state.isLastRound;
  if (!isLastRound && score(finishingPlayer) >= WIN_SCORE) {
    isLastRound = true;
  }
  const staleTurns = state.staleTurns + 1;
  const nextActive = otherPlayer(state.active);
  if (isLastRound && nextActive === 0) {
    return { ...state, isLastRound, gameOver: true, takenColors: [], staleTurns };
  }
  if (staleTurns >= STALE_TURN_LIMIT) {
    return { ...state, gameOver: true, takenColors: [], staleTurns };
  }
  return refillBoard({
    ...state,
    active: nextActive,
    isLastRound,
    takenColors: [],
    staleTurns,
  });
}

function applyTake(state: SplendorState, color: Color): SplendorState {
  const bank = { ...state.bank, [color]: state.bank[color] - 1 };
  const withGem = withPlayer(state, state.active, (p) => ({
    ...p,
    gems: { ...p.gems, [color]: p.gems[color] + 1 },
  }));
  const takenColors = [...state.takenColors, color];
  const next = { ...withGem, bank, takenColors };

  const completesThree = takenColors.length === 3;
  const completesPair = takenColors.length === 2 && takenColors[0] === takenColors[1];
  if (completesThree || completesPair) {
    return advanceTurn(next);
  }
  return next;
}

function afterCardAcquired(state: SplendorState, playerId: PlayerId): SplendorState {
  const qualifying = qualifyingNobles(getPlayer(state, playerId), state.noblePool);
  if (qualifying.length === 0) return advanceTurn(state);
  if (qualifying.length === 1) {
    const noble = qualifying[0] as SplendorNoble;
    const awarded = withPlayer(state, playerId, (p) => ({ ...p, nobles: [...p.nobles, noble] }));
    const noblePool = state.noblePool.filter((n) => n.id !== noble.id);
    return advanceTurn({ ...awarded, noblePool });
  }
  return { ...state, pendingNobleChoices: qualifying.map((n) => n.id) };
}

function applyBuy(state: SplendorState, cardId: string): SplendorState {
  const player = getPlayer(state, state.active);
  const board = findBoardCard(state, cardId);
  const card = board ? board.card : findReservedCard(player, cardId);
  if (!card) throw new Error(`applyBuy: no such card ${cardId}`);

  let owed = 0;
  for (const color of COLORS) {
    const deficit = card.cost[color] - power(player, color);
    if (deficit > 0) owed += deficit;
  }

  const gems: Record<Gem, number> = { ...player.gems };
  const bankUpdate: Record<Gem, number> = { ...state.bank };
  gems.gold -= owed;
  bankUpdate.gold += owed;
  for (const color of COLORS) {
    const deficit = card.cost[color] - player.cards[color].length;
    if (deficit > 0) {
      const pay = Math.min(deficit, player.gems[color]);
      gems[color] -= pay;
      bankUpdate[color] += pay;
    }
  }

  const cards: Record<Color, readonly SplendorCard[]> = {
    ...player.cards,
    [card.color]: [...player.cards[card.color], card],
  };

  let nextState: SplendorState = withPlayer(state, state.active, () => ({
    ...player,
    gems,
    cards,
    reserved: player.reserved.filter((c) => c.id !== card.id),
  }));
  nextState = { ...nextState, bank: bankUpdate };

  if (board) {
    const { level } = board;
    nextState = {
      ...nextState,
      board: { ...nextState.board, [level]: nextState.board[level].filter((c) => c.id !== card.id) },
    };
  }

  return afterCardAcquired({ ...nextState, staleTurns: 0 }, state.active);
}

function applyReserve(state: SplendorState, cardId: string): SplendorState {
  const board = findBoardCard(state, cardId);
  if (!board) throw new Error(`applyReserve: no such board card ${cardId}`);
  const grantsGold = state.bank.gold > 0;

  let nextState: SplendorState = withPlayer(state, state.active, (p) => ({
    ...p,
    reserved: [...p.reserved, board.card],
    gems: grantsGold ? { ...p.gems, gold: p.gems.gold + 1 } : p.gems,
  }));
  nextState = {
    ...nextState,
    board: { ...nextState.board, [board.level]: nextState.board[board.level].filter((c) => c.id !== cardId) },
    bank: grantsGold ? { ...nextState.bank, gold: nextState.bank.gold - 1 } : nextState.bank,
  };
  return advanceTurn(nextState);
}

function applyReserveBlind(state: SplendorState, level: Level): SplendorState {
  const deck = state.decks[level];
  const drawn = deck[deck.length - 1];
  if (!drawn) throw new Error(`applyReserveBlind: level ${level} deck is empty`);
  const grantsGold = state.bank.gold > 0;

  let nextState: SplendorState = withPlayer(state, state.active, (p) => ({
    ...p,
    reserved: [...p.reserved, drawn],
    gems: grantsGold ? { ...p.gems, gold: p.gems.gold + 1 } : p.gems,
  }));
  nextState = {
    ...nextState,
    decks: { ...nextState.decks, [level]: deck.slice(0, -1) },
    bank: grantsGold ? { ...nextState.bank, gold: nextState.bank.gold - 1 } : nextState.bank,
    revealedCardIds: [...nextState.revealedCardIds, drawn.id],
  };
  return advanceTurn(nextState);
}

function applyDiscard(state: SplendorState, gem: Gem): SplendorState {
  const nextState = withPlayer(state, state.active, (p) => ({ ...p, gems: { ...p.gems, [gem]: p.gems[gem] - 1 } }));
  return { ...nextState, bank: { ...nextState.bank, [gem]: nextState.bank[gem] + 1 } };
}

function applyNoble(state: SplendorState, nobleId: string): SplendorState {
  const noble = state.noblePool.find((n) => n.id === nobleId);
  if (!noble) throw new Error(`applyNoble: no such noble ${nobleId}`);
  const awarded = withPlayer(state, state.active, (p) => ({ ...p, nobles: [...p.nobles, noble] }));
  const noblePool = state.noblePool.filter((n) => n.id !== nobleId);
  return advanceTurn({ ...awarded, noblePool, pendingNobleChoices: null });
}

function applyChoice(state: SplendorState, choice: SplendorChoice): SplendorState {
  const decision = currentDecision(state);
  if (!decision) throw new Error('applyChoice: game is already over');
  const legal = getLegalChoices(state);
  if (!legal.some((candidate) => sameChoice(candidate, choice))) {
    throw new Error(`applyChoice: ${encodeChoice(choice)} is not a legal choice`);
  }

  switch (choice.kind) {
    case 'take':
      return applyTake(state, choice.color);
    case 'takeDone':
      return advanceTurn(state);
    case 'buy':
      return applyBuy(state, choice.cardId);
    case 'reserve':
      return applyReserve(state, choice.cardId);
    case 'reserveBlind':
      return applyReserveBlind(state, choice.level);
    case 'discard':
      return applyDiscard(state, choice.gem);
    case 'noble':
      return applyNoble(state, choice.nobleId);
    default: {
      const exhaustive: never = choice;
      throw new Error(`applyChoice: unhandled choice ${JSON.stringify(exhaustive)}`);
    }
  }
}

function getObservation(state: SplendorState, player: PlayerId): SplendorObservation {
  return {
    self: player,
    players: state.players,
    board: state.board,
    deckCounts: { 1: state.decks[1].length, 2: state.decks[2].length, 3: state.decks[3].length },
    nobles: state.noblePool,
    bank: state.bank,
    active: state.active,
    takenColors: state.takenColors,
    pendingNobleChoices: state.pendingNobleChoices,
  };
}

function getOutcome(state: SplendorState): Outcome | null {
  if (currentDecision(state) !== null) return null;
  const scores = state.players.map((p) => score(p));
  const tiebreaks = state.players.map((p) => tiebreakScore(p));
  const maxTiebreak = Math.max(...tiebreaks);
  const winners: PlayerId[] = [];
  tiebreaks.forEach((t, id) => {
    if (t === maxTiebreak) winners.push(id);
  });
  return { scores, winners };
}

function encodeChoice(choice: SplendorChoice): string {
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
    default: {
      const exhaustive: never = choice;
      throw new Error(`encodeChoice: unhandled choice ${JSON.stringify(exhaustive)}`);
    }
  }
}

// --- Invariants -------------------------------------------------------

function cardConservationInvariant(state: SplendorState): string | null {
  const boardCount = LEVELS.reduce((sum, level) => sum + state.board[level].length, 0);
  const deckCount = LEVELS.reduce((sum, level) => sum + state.decks[level].length, 0);
  const ownedCount = state.players.reduce((sum, p) => sum + ownedCardCount(p) + p.reserved.length, 0);
  const total = boardCount + deckCount + ownedCount;
  return total === TOTAL_CARDS
    ? null
    : `card conservation violated: total visible+held cards is ${total}, expected ${TOTAL_CARDS}`;
}

function noDuplicateCardsInvariant(state: SplendorState): string | null {
  const seen = new Set<string>();
  const allIds = [
    ...LEVELS.flatMap((level) => state.board[level].map((c) => c.id)),
    ...LEVELS.flatMap((level) => state.decks[level].map((c) => c.id)),
    ...state.players.flatMap((p) => COLORS.flatMap((c) => p.cards[c].map((card) => card.id))),
    ...state.players.flatMap((p) => p.reserved.map((c) => c.id)),
  ];
  for (const id of allIds) {
    if (seen.has(id)) return `duplicate card ${id} found among tracked cards`;
    seen.add(id);
  }
  return null;
}

function gemConservationInvariant(state: SplendorState): string | null {
  for (const gem of GEMS) {
    const initial = gem === 'gold' ? STARTING_GOLD : STARTING_GEMS_PER_COLOR;
    const total = state.bank[gem] + state.players.reduce((sum, p) => sum + p.gems[gem], 0);
    if (total !== initial) {
      return `gem conservation violated for ${gem}: total is ${total}, expected ${initial}`;
    }
  }
  return null;
}

function nobleConservationInvariant(state: SplendorState): string | null {
  const claimed = state.players.reduce((sum, p) => sum + p.nobles.length, 0);
  const total = state.noblePool.length + claimed;
  return total === state.revealedNobleIds.length
    ? null
    : `noble conservation violated: pool+claimed is ${total}, expected ${state.revealedNobleIds.length}`;
}

function gemCapInvariant(state: SplendorState): string | null {
  for (const player of state.players) {
    if (totalGems(player) > MAX_GEMS) {
      return `player holds ${totalGems(player)} gems, exceeding the ${MAX_GEMS}-gem cap`;
    }
  }
  return null;
}

// --- Content coverage ---------------------------------------------------

function exercisedContent(finalState: SplendorState): readonly string[] {
  return [...finalState.revealedCardIds, ...finalState.revealedNobleIds];
}

const contentInventory = [
  ...ALL_CARDS.map((card) => ({
    id: card.id,
    description: `level ${card.level} ${card.color} card worth ${card.points} points`,
  })),
  ...ALL_NOBLES.map((noble) => ({ id: noble.id, description: `noble ${noble.id} worth ${noble.points} points` })),
];

// --- Baselines ------------------------------------------------------------

const randomBaseline: BotFactory<SplendorObservation, SplendorChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'splendor-random',
    decide(_decisionPoint, _observation, legal) {
      return legal[rng.nextInt(legal.length)] as SplendorChoice;
    },
  };
};

function heuristicPick(
  decisionPoint: string,
  observation: SplendorObservation,
  legal: readonly SplendorChoice[],
): SplendorChoice {
  if (decisionPoint === 'noble') {
    const sorted = [...legal].sort((a, b) => {
      if (a.kind !== 'noble' || b.kind !== 'noble') return 0;
      return a.nobleId < b.nobleId ? -1 : a.nobleId > b.nobleId ? 1 : 0;
    });
    return sorted[0] as SplendorChoice;
  }

  // Heuristic buy priority is deliberately "cheapest first" (efficient,
  // low-risk play), distinct from the buyHighestPoints strategy flag below —
  // otherwise wrapping the heuristic baseline in that flag would be a no-op.
  const buys = legal.filter((c): c is Extract<SplendorChoice, { kind: 'buy' }> => c.kind === 'buy');
  if (buys.length > 0) {
    const byCost = buys
      .map((c) => {
        const card = findBoardCardAny(observation, c.cardId);
        const totalCost = card ? COLORS.reduce((sum, color) => sum + card.cost[color], 0) : 0;
        return { choice: c, totalCost };
      })
      .sort((a, b) => a.totalCost - b.totalCost || (a.choice.cardId < b.choice.cardId ? -1 : 1));
    return byCost[0]!.choice;
  }

  const takes = legal.filter((c): c is Extract<SplendorChoice, { kind: 'take' }> => c.kind === 'take');
  if (takes.length > 0) {
    const byBank = takes
      .map((c) => ({ choice: c, bank: observation.bank[c.color] }))
      .sort((a, b) => b.bank - a.bank || (a.choice.color < b.choice.color ? -1 : 1));
    return byBank[0]!.choice;
  }

  const reserves = legal.filter((c): c is Extract<SplendorChoice, { kind: 'reserve' }> => c.kind === 'reserve');
  if (reserves.length > 0) {
    const byPoints = reserves
      .map((c) => {
        const board = findBoardCardAny(observation, c.cardId);
        return { choice: c, points: board?.points ?? 0 };
      })
      .sort((a, b) => b.points - a.points || (a.choice.cardId < b.choice.cardId ? -1 : 1));
    return byPoints[0]!.choice;
  }

  const doneChoice = legal.find((c) => c.kind === 'takeDone');
  if (doneChoice) return doneChoice;

  return legal[0] as SplendorChoice;
}

function findBoardCardAny(observation: SplendorObservation, cardId: string): SplendorCard | undefined {
  for (const level of LEVELS) {
    const found = observation.board[level].find((c) => c.id === cardId);
    if (found) return found;
  }
  for (const player of observation.players) {
    const found = player.reserved.find((c) => c.id === cardId);
    if (found) return found;
  }
  return undefined;
}

const heuristicBaseline: BotFactory<SplendorObservation, SplendorChoice> = (_seed) => {
  return {
    id: 'splendor-heuristic',
    decide: heuristicPick,
  };
};

function wrapBotId(bot: GameBot<SplendorObservation, SplendorChoice>, suffix: string): string {
  return `${bot.id}+${suffix}`;
}

/** Strategy flag: marginal. Always buys the highest-point affordable card when one is legal. */
const buyHighestPoints: StrategyFlagSpec<SplendorObservation, SplendorChoice> = {
  flag: 'buyHighestPoints',
  description: 'On the fresh action phase, always buy the highest-point affordable card if one is legal.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot, 'buyHighestPoints'),
        decide(decisionPoint, observation, legal) {
          const buys = legal.filter((c): c is Extract<SplendorChoice, { kind: 'buy' }> => c.kind === 'buy');
          if (buys.length > 0) {
            const byPoints = buys
              .map((c) => ({ choice: c, points: findBoardCardAny(observation, c.cardId)?.points ?? 0 }))
              .sort((a, b) => b.points - a.points || (a.choice.cardId < b.choice.cardId ? -1 : 1));
            return byPoints[0]!.choice;
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/** Strategy flag: effective. Always takes from the color with the largest bank pile. */
const takeGreedyBank: StrategyFlagSpec<SplendorObservation, SplendorChoice> = {
  flag: 'takeGreedyBank',
  description: 'Whenever a take choice is legal, always take from the color with the most gems remaining in bank.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot, 'takeGreedyBank'),
        decide(decisionPoint, observation, legal) {
          const takes = legal.filter((c): c is Extract<SplendorChoice, { kind: 'take' }> => c.kind === 'take');
          if (takes.length > 0) {
            const byBank = takes
              .map((c) => ({ choice: c, bank: observation.bank[c.color] }))
              .sort((a, b) => b.bank - a.bank || (a.choice.color < b.choice.color ? -1 : 1));
            return byBank[0]!.choice;
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/** Strategy flag: marginal. Reserves the highest-point board card whenever gold remains and reserving is legal. */
const reserveForGold: StrategyFlagSpec<SplendorObservation, SplendorChoice> = {
  flag: 'reserveForGold',
  description: 'On the fresh action phase, reserve the highest-point board card whenever gold remains in the bank.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot, 'reserveForGold'),
        decide(decisionPoint, observation, legal) {
          if (observation.bank.gold > 0) {
            const reserves = legal.filter(
              (c): c is Extract<SplendorChoice, { kind: 'reserve' }> => c.kind === 'reserve',
            );
            if (reserves.length > 0) {
              const byPoints = reserves
                .map((c) => ({ choice: c, points: findBoardCardAny(observation, c.cardId)?.points ?? 0 }))
                .sort((a, b) => b.points - a.points || (a.choice.cardId < b.choice.cardId ? -1 : 1));
              return byPoints[0]!.choice;
            }
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/**
 * Replay fixtures: random-vs-random self-play, captured by actually running
 * this adapter (see src/reference/__tests__/splendor.test.ts generation
 * note) and hardcoded here — not hand-simulated.
 */
const replayFixtures: readonly ReplayFixture[] = [
  {
    id: 'splendor-2p-seed-11',
    seed: 11,
    choiceKeys: [
      'reserve:L2-08', 'reserveBlind:3', 'reserve:L2-29', 'reserve:L2-02', 'reserve:L2-12',
      'reserve:L3-18', 'take:b', 'takeDone', 'take:b', 'take:u', 'take:g', 'take:b', 'take:w',
      'take:r', 'take:g', 'take:w', 'take:u', 'buy:L1-16', 'buy:L1-24', 'take:g', 'take:r',
      'takeDone', 'take:g', 'take:r', 'take:b', 'take:r', 'take:b', 'takeDone', 'take:u',
      'takeDone', 'take:w', 'take:u', 'take:r', 'take:u', 'takeDone', 'discard:w', 'take:b',
      'takeDone', 'buy:L2-02', 'buy:L1-02', 'reserve:L2-15', 'take:g', 'take:r', 'take:u',
      'take:r', 'take:w', 'takeDone', 'take:g', 'takeDone', 'take:g', 'take:w', 'take:u',
      'discard:r', 'take:r', 'takeDone', 'take:w', 'takeDone', 'buy:L2-12', 'discard:r',
      'take:r', 'takeDone', 'take:g', 'take:b', 'takeDone', 'buy:L2-26', 'reserve:L1-06',
      'take:u', 'takeDone', 'take:u', 'take:r', 'take:g', 'take:u', 'take:r', 'takeDone',
      'discard:u', 'buy:L1-19', 'buy:L1-28', 'buy:L2-24', 'buy:L1-03', 'take:w', 'takeDone',
      'take:r', 'take:r', 'take:b', 'take:u', 'take:w', 'take:u', 'take:g', 'takeDone',
      'take:w', 'takeDone', 'take:r', 'take:b', 'take:u', 'take:r', 'take:g', 'takeDone',
      'buy:L2-25', 'discard:u', 'buy:L1-35', 'take:w', 'takeDone', 'take:u', 'take:b',
      'take:r', 'buy:L2-14', 'discard:u', 'buy:L1-39', 'buy:L1-13', 'buy:L1-06', 'take:w',
      'take:u', 'take:b', 'reserveBlind:1', 'buy:L2-07', 'take:r', 'take:g', 'take:u',
      'take:g', 'take:b', 'takeDone', 'buy:L2-29', 'take:b', 'takeDone', 'reserve:L1-00',
      'take:g', 'take:r', 'take:u', 'buy:L2-08', 'buy:L2-28', 'buy:L1-08', 'take:b', 'take:g',
      'takeDone', 'reserve:L2-13', 'take:r', 'take:g', 'takeDone', 'buy:L2-13', 'buy:L2-15',
      'reserve:L3-06', 'reserve:L2-23', 'take:b', 'take:w', 'take:r', 'buy:L3-17',
    ],
    finalScores: [9, 16],
  },
  {
    id: 'splendor-2p-seed-22',
    seed: 22,
    choiceKeys: [
      'reserve:L2-17', 'reserve:L3-01', 'take:b', 'take:u', 'take:w', 'reserve:L1-22',
      'reserve:L1-00', 'reserve:L2-02', 'reserve:L3-17', 'buy:L1-22', 'take:b', 'take:r',
      'take:g', 'reserveBlind:2', 'take:w', 'take:u', 'takeDone', 'take:r', 'take:b',
      'takeDone', 'buy:L1-27', 'take:b', 'take:w', 'take:r', 'take:g', 'take:w', 'take:r',
      'buy:L1-26', 'take:g', 'take:r', 'takeDone', 'take:r', 'take:g', 'takeDone', 'discard:g',
      'buy:L2-12', 'take:g', 'take:u', 'take:b', 'take:w', 'take:b', 'take:g', 'buy:L1-16',
      'take:u', 'take:u', 'buy:L1-38', 'buy:L1-39', 'take:b', 'take:u', 'take:w', 'take:r',
      'take:w', 'take:g', 'take:b', 'takeDone', 'buy:L1-20', 'buy:L1-19', 'take:w', 'take:r',
      'take:u', 'take:u', 'take:b', 'take:r', 'take:r', 'takeDone', 'buy:L1-33', 'buy:L1-15',
      'take:u', 'take:r', 'take:w', 'take:b', 'take:r', 'take:w', 'take:b', 'take:r',
      'takeDone', 'buy:L1-36', 'buy:L1-08', 'buy:L1-05', 'take:b', 'take:u', 'takeDone',
      'take:g', 'takeDone', 'discard:w', 'buy:L1-34', 'buy:L1-37', 'buy:L1-11', 'take:w',
      'takeDone', 'buy:L2-29', 'buy:L1-00', 'take:g', 'takeDone', 'buy:L1-32', 'buy:L1-28',
      'discard:g', 'buy:L1-18', 'take:g', 'take:b', 'take:u', 'reserve:L1-24', 'buy:L2-02',
      'buy:L3-07', 'reserve:L3-16', 'take:b', 'takeDone', 'take:g', 'take:r', 'take:u',
      'take:b', 'take:w', 'take:g', 'buy:L2-10', 'buy:L1-01', 'take:w', 'take:r', 'takeDone',
      'buy:L1-04', 'buy:L1-14', 'buy:L1-12', 'take:b', 'take:u', 'takeDone', 'buy:L1-35',
      'take:g', 'take:w', 'take:r', 'buy:L3-11', 'buy:L3-01', 'take:u', 'take:g', 'takeDone',
      'reserveBlind:2', 'take:u', 'take:w', 'take:r', 'buy:L1-23',
    ],
    finalScores: [13, 15],
  },
  {
    id: 'splendor-2p-seed-33',
    seed: 33,
    choiceKeys: [
      'reserve:L2-20', 'reserveBlind:2', 'reserveBlind:2', 'reserve:L3-12', 'reserve:L2-15',
      'reserve:L3-13', 'take:w', 'take:g', 'takeDone', 'take:u', 'take:w', 'takeDone',
      'take:g', 'take:r', 'takeDone', 'take:u', 'take:b', 'take:w', 'buy:L1-09', 'take:w',
      'take:b', 'take:g', 'take:u', 'takeDone', 'buy:L1-36', 'take:u', 'takeDone', 'take:r',
      'take:u', 'take:g', 'buy:L1-27', 'buy:L1-12', 'take:r', 'take:g', 'take:w', 'buy:L1-10',
      'take:w', 'take:g', 'takeDone', 'take:g', 'take:w', 'take:b', 'take:g', 'take:b',
      'take:r', 'buy:L1-07', 'take:b', 'take:r', 'takeDone', 'take:b', 'take:r', 'take:u',
      'discard:r', 'take:r', 'takeDone', 'take:u', 'takeDone', 'discard:b', 'buy:L1-23',
      'take:b', 'takeDone', 'take:g', 'takeDone', 'buy:L1-00', 'buy:L1-05', 'take:g', 'take:u',
      'take:w', 'take:g', 'take:u', 'take:w', 'buy:L1-24', 'buy:L1-29', 'take:g', 'takeDone',
      'take:u', 'take:r', 'takeDone', 'discard:g', 'buy:L1-35', 'take:g', 'takeDone', 'take:w',
      'take:b', 'takeDone', 'buy:L1-08', 'buy:L2-06', 'buy:L2-19', 'buy:L1-32', 'take:b',
      'takeDone', 'take:u', 'take:w', 'takeDone', 'take:r', 'take:w', 'take:g', 'take:g',
      'take:w', 'takeDone', 'buy:L1-28', 'buy:L3-13', 'take:w', 'take:r', 'take:u',
      'reserve:L1-03', 'buy:L1-37', 'take:r', 'take:w', 'take:u', 'buy:L1-18', 'discard:u',
      'buy:L1-02', 'buy:L2-23', 'buy:L3-09', 'buy:L1-26', 'buy:L1-20', 'buy:L3-17',
      'buy:L2-12', 'take:b', 'take:b', 'take:b', 'take:r', 'take:g', 'buy:L1-13', 'take:r',
      'takeDone', 'buy:L2-26', 'buy:L1-03', 'take:w', 'take:r', 'take:b', 'take:u', 'take:u',
      'buy:L2-20', 'buy:L1-39',
    ],
    finalScores: [16, 12],
  },
];

export const splendorAdapter: GameAdapter<SplendorState, SplendorObservation, SplendorChoice> = {
  spec: {
    gameId: 'splendor-2p',
    playerCount: PLAYER_COUNT,
    decisionPoints: [
      { id: 'action', description: 'Take gems, buy a card, reserve a card, or discard down from 10 gems.' },
      { id: 'take', description: 'Continue or stop an in-progress gem-taking action.' },
      { id: 'noble', description: 'Choose which noble to accept when more than one qualifies at once.' },
    ],
    seatingPlan: [
      [0, 1],
      [1, 0],
    ],
    perfectInformation: true,
    maxDecisionsPerGame: 600,
  },
  createInitialState,
  currentDecision,
  getObservation,
  getLegalChoices,
  applyChoice,
  getOutcome,
  encodeChoice,
  invariants: [
    cardConservationInvariant,
    noDuplicateCardsInvariant,
    gemConservationInvariant,
    nobleConservationInvariant,
    gemCapInvariant,
  ],
  contentInventory,
  exercisedContent,
  replayFixtures,
  baselines: {
    random: randomBaseline,
    heuristic: heuristicBaseline,
  },
  strategySurface: [buyHighestPoints, takeGreedyBank, reserveForGold],
};
