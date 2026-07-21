/**
 * wingspan — reference GameAdapter implementation onboarding an open-source
 * "Wingspan" project (https://github.com/keithgw/wingspan, src/entities/*.py
 * + src/game.py) onto Loop Forge.
 *
 * IMPORTANT DEVIATION FROM THE ASSIGNMENT BRIEF, DOCUMENTED UP FRONT (source
 * is ground truth here — see splendor.ts's header for the same principle):
 * the brief assumed the linked repository implements the real Wingspan
 * boardgame (3 habitats, egg-laying, cached food, per-card "when played /
 * once / repeatable" trigger powers, bonus/goal cards, 4 rounds with a
 * shrinking action count per round). It does not. Reading the actual source
 * shows a deliberately stripped RL-training environment:
 *   - `Bird.activate()` (src/entities/bird.py) is a stub — `pass`, never
 *     called anywhere in the codebase. There are no card powers at all.
 *   - There is exactly one `GameBoard` per player (capacity 5), not three
 *     habitat rows — `src/entities/gameboard.py`.
 *   - `Player.actions` (src/entities/player.py) is
 *     `["play_a_bird", "gain_food", "draw_a_bird"]` with a comment
 *     `# lay_eggs not implemented yet`. No eggs, no cached food, no
 *     bonus/goal cards anywhere in the source.
 *   - Turn structure is a flat counter (`GameState.game_turn`,
 *     `src/entities/game_state.py`), not 4 rounds of shrinking per-round
 *     actions — `is_game_over()` is simply
 *     `game_turn == num_turns * num_players`.
 *   - Each `Bird` (data/bird_list.py, 180 entries) is fully described by
 *     `(name, points, food_cost)` — a pure resource-engine card, nothing more.
 * Given this, onboarding "real Wingspan" would mean inventing rules with no
 * source backing, which contradicts the project's source-is-ground-truth
 * convention. This adapter instead onboards the actual game the reference
 * repository implements: a food-engine-building race where each turn is
 * "play a bird you can afford", "take 1 food from the shared feeder", or
 * "draw a bird into your hand (from the tray or blind from the deck)".
 *
 * Content-heavy reduction (docs/ONBOARDING-GUIDE.md §5.7 "증분 온보딩
 * 전략" — wingspan is the guide's own named example): the source ships 180
 * unique birds, but since every bird is structurally identical (just a
 * points/food_cost pair with no behavioural difference), including all 180
 * would inflate contentInventory size without adding any adapter complexity
 * or exercising any new code path. This adapter selects a 20-bird
 * "wingspan-core" subset (BIRD_DEFS below) spanning the full cost/point
 * range in the source (free 0-cost birds, cheap junk 0-point birds, and an
 * expensive premium tier) so a full playout's coverage numbers are
 * meaningful without requiring an unreasonably long game to exercise them.
 *
 * Turn model: one turn is exactly one of playBird / gainFood / drawTray /
 * drawDeck (transcribed 1:1 from `Player._enumerate_legal_actions` +
 * `Player.play_a_bird`/`gain_food`/`draw_a_bird`). Unlike Splendor's
 * multi-step turn, choosing "play a bird" and choosing *which* bird happen
 * with no intervening observable state change in the source (the action
 * menu and the bird choice are decided back-to-back before anything
 * mutates), so this adapter flattens them into one decision point
 * (`turn`) whose choices already carry the specific bird/card — this
 * matches the flattening splendor.ts uses for `reserve:<cardId>` etc.,
 * just applied one level earlier since there's no gem-taking sub-loop here.
 *
 * Hidden information: `GameState.MCTSGameState._represent_player` (the
 * source's own state-hashing helper) stores opponent hands as a *count*,
 * not contents — "Handles hidden information: opponent hands are stored as
 * counts (not contents)" per its docstring. That is the source's own
 * confirmation that hand contents are private. `spec.perfectInformation` is
 * therefore *not* declared and this adapter ships a `hiddenInfoProbe`
 * (reshuffles the active viewer's opponent's hand against the undrawn deck,
 * mirroring mini-trick.ts's probe shape) — deck order (future tray reveals)
 * is also hidden but has only marginal strategic weight, same reasoning the
 * guide gives for treating pure future-shuffle order as immaterial; the
 * probe still covers it since hand+deck are reshuffled together.
 *
 * Determinism: the source shuffles with bare `random.shuffle` (Deck._shuffle,
 * src/entities/deck.py) — banned here. All randomness in this adapter flows
 * from `createRng(seed)`/`shuffled` (src/kernel/rng.ts) exactly once, at
 * `createInitialState`.
 *
 * Termination: `GameState.is_game_over` uses a hard decision-count cap
 * (`num_turns * num_players`, both fixed constants here), not a
 * progress-based rule — already a genuine end-guarantee per
 * ONBOARDING-GUIDE.md §1/§5 ("원본 소스를 규칙북의 정확한 구현으로 신뢰하지
 * 말고, 종국 보장 규칙이 실제로 존재하는지 소스에서 직접 검증하라"), no
 * synthetic stalemate rule needed: `gainFood` is unconditionally legal every
 * turn (source: "Player can always gain food"), so no dead end is reachable.
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
  StrategyFlagSpec,
} from '../contract/types';
import { createRng, shuffled } from '../kernel/rng';

const PLAYER_COUNT = 2;
const BOARD_CAPACITY = 5; // GameBoard(capacity=5), src/entities/gameboard.py.
const TRAY_CAPACITY = 3; // Tray(capacity=3), src/entities/tray.py.
const FEEDER_CAPACITY = 5; // BirdFeeder.reroll sets food_count=5, src/entities/birdfeeder.py.
const NUM_STARTING_CARDS = 2; // DEFAULT_NUM_STARTING_CARDS, src/game.py.
const TOTAL_ALLOWED_IN_STARTING_HAND = 5; // src/game.py constant.
const NUM_TURNS_PER_PLAYER = 10; // DEFAULT_NUM_TURNS, src/game.py.
const TOTAL_TURNS = NUM_TURNS_PER_PLAYER * PLAYER_COUNT;

export interface WingspanBirdDef {
  readonly id: string;
  readonly name: string;
  readonly points: number;
  readonly foodCost: number;
}

// A 20-bird subset of data/bird_list.py (180 entries), selected to span the
// full cost/point range actually present in the source: free 0-cost birds,
// a couple of intentionally weak "junk" birds (0 points, non-zero cost —
// American source has several, e.g. Mallard/Song Sparrow), a broad midrange,
// and an expensive premium tier (cost 3, 9 points). See file header for why
// a subset rather than all 180.
const BIRD_DEFS: readonly WingspanBirdDef[] = [
  { id: 'turkey-vulture', name: 'Turkey Vulture', points: 1, foodCost: 0 },
  { id: 'california-condor', name: 'California Condor', points: 1, foodCost: 0 },
  { id: 'black-vulture', name: 'Black Vulture', points: 2, foodCost: 0 },
  { id: 'mourning-dove', name: 'Mourning Dove', points: 0, foodCost: 1 },
  { id: 'house-wren', name: 'House Wren', points: 1, foodCost: 1 },
  { id: 'purple-martin', name: 'Purple Martin', points: 2, foodCost: 1 },
  { id: 'american-crow', name: 'American Crow', points: 4, foodCost: 1 },
  { id: 'northern-harrier', name: 'Northern Harrier', points: 3, foodCost: 1 },
  { id: 'american-robin', name: 'American Robin', points: 1, foodCost: 2 },
  { id: 'carolina-wren', name: 'Carolina Wren', points: 1, foodCost: 2 },
  { id: 'killdeer', name: 'Killdeer', points: 1, foodCost: 2 },
  { id: 'mallard', name: 'Mallard', points: 0, foodCost: 2 },
  { id: 'bushtit', name: 'Bushtit', points: 2, foodCost: 2 },
  { id: 'american-goldfinch', name: 'American Goldfinch', points: 3, foodCost: 2 },
  { id: 'blue-jay', name: 'Blue Jay', points: 3, foodCost: 2 },
  { id: 'red-tailed-hawk', name: 'Red-Tailed Hawk', points: 5, foodCost: 2 },
  { id: 'great-blue-heron', name: 'Great Blue Heron', points: 5, foodCost: 2 },
  { id: 'song-sparrow', name: 'Song Sparrow', points: 0, foodCost: 3 },
  { id: 'american-woodcock', name: 'American Woodcock', points: 9, foodCost: 3 },
  { id: 'bald-eagle', name: 'Bald Eagle', points: 9, foodCost: 3 },
];

const BIRD_IDS: readonly string[] = BIRD_DEFS.map((b) => b.id);
const BIRD_BY_ID = new Map(BIRD_DEFS.map((b) => [b.id, b] as const));

function birdDef(id: string): WingspanBirdDef {
  const def = BIRD_BY_ID.get(id);
  if (!def) throw new Error(`birdDef: unknown bird id ${id}`);
  return def;
}

export interface WingspanPlayerState {
  readonly hand: readonly string[];
  readonly board: readonly string[];
  readonly food: number;
}

export interface WingspanState {
  readonly players: readonly [WingspanPlayerState, WingspanPlayerState];
  readonly deck: readonly string[]; // front (index 0) is the top of the deck.
  readonly tray: readonly string[];
  readonly feederFood: number;
  readonly active: PlayerId;
  readonly gameTurn: number;
  readonly gameOver: boolean;
  /** Bird ids ever played onto a board, across both players (for content coverage). */
  readonly playedBirdIds: readonly string[];
}

export interface WingspanObservation {
  readonly self: PlayerId;
  readonly selfHand: readonly string[];
  readonly opponentHandCount: number;
  readonly boards: readonly [readonly string[], readonly string[]];
  readonly food: readonly [number, number];
  readonly tray: readonly string[];
  readonly feederFood: number;
  readonly deckCount: number;
  readonly active: PlayerId;
}

export type WingspanChoice =
  | { readonly kind: 'playBird'; readonly cardId: string }
  | { readonly kind: 'gainFood' }
  | { readonly kind: 'drawTray'; readonly cardId: string }
  | { readonly kind: 'drawDeck' };

function otherPlayer(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

function getPlayer(state: WingspanState, id: PlayerId): WingspanPlayerState {
  const player = state.players[id];
  if (!player) throw new Error(`getPlayer: no such player ${id}`);
  return player;
}

function withPlayer(
  state: WingspanState,
  player: PlayerId,
  update: (p: WingspanPlayerState) => WingspanPlayerState,
): WingspanState {
  const players: [WingspanPlayerState, WingspanPlayerState] = [...state.players];
  players[player] = update(getPlayer(state, player));
  return { ...state, players };
}

function score(player: WingspanPlayerState): number {
  return player.board.reduce((sum, id) => sum + birdDef(id).points, 0);
}

export function createInitialState(seed: number): WingspanState {
  const rng = createRng(seed);
  const pool = shuffled(BIRD_IDS, rng.fork('deck'));
  let cursor = 0;
  const draw = (count: number): string[] => {
    const slice = pool.slice(cursor, cursor + count);
    cursor += count;
    return slice;
  };

  const hand0 = draw(NUM_STARTING_CARDS);
  const hand1 = draw(NUM_STARTING_CARDS);
  const tray = draw(TRAY_CAPACITY);
  const deck = pool.slice(cursor);

  const startingFood = TOTAL_ALLOWED_IN_STARTING_HAND - NUM_STARTING_CARDS;
  const makePlayer = (hand: readonly string[]): WingspanPlayerState => ({
    hand,
    board: [],
    food: startingFood,
  });

  return {
    players: [makePlayer(hand0), makePlayer(hand1)],
    deck,
    tray,
    feederFood: FEEDER_CAPACITY,
    active: 0,
    gameTurn: 0,
    gameOver: false,
    playedBirdIds: [],
  };
}

function currentDecision(state: WingspanState): PendingDecision | null {
  if (state.gameOver) return null;
  return { player: state.active, decisionPoint: 'turn' };
}

function getLegalChoices(state: WingspanState): readonly WingspanChoice[] {
  if (state.gameOver) throw new Error('getLegalChoices: game is already over');
  const player = getPlayer(state, state.active);
  const choices: WingspanChoice[] = [];

  if (player.board.length < BOARD_CAPACITY) {
    for (const cardId of player.hand) {
      if (birdDef(cardId).foodCost <= player.food) {
        choices.push({ kind: 'playBird', cardId });
      }
    }
  }

  choices.push({ kind: 'gainFood' });

  if (state.tray.length > 0 || state.deck.length > 0) {
    for (const cardId of state.tray) {
      choices.push({ kind: 'drawTray', cardId });
    }
    if (state.deck.length > 0) {
      choices.push({ kind: 'drawDeck' });
    }
  }

  return choices;
}

function sameChoice(a: WingspanChoice, b: WingspanChoice): boolean {
  return encodeChoice(a) === encodeChoice(b);
}

function refillTray(state: WingspanState): WingspanState {
  let tray = state.tray;
  let deck = state.deck;
  while (tray.length < TRAY_CAPACITY && deck.length > 0) {
    tray = [...tray, deck[0] as string];
    deck = deck.slice(1);
  }
  return { ...state, tray, deck };
}

function endTurn(state: WingspanState): WingspanState {
  const refilled = refillTray(state);
  const gameTurn = refilled.gameTurn + 1;
  return {
    ...refilled,
    gameTurn,
    active: otherPlayer(refilled.active),
    gameOver: gameTurn >= TOTAL_TURNS,
  };
}

function applyPlayBird(state: WingspanState, cardId: string): WingspanState {
  const def = birdDef(cardId);
  const next = withPlayer(state, state.active, (p) => ({
    ...p,
    hand: p.hand.filter((id) => id !== cardId),
    board: [...p.board, cardId],
    food: p.food - def.foodCost,
  }));
  return endTurn({ ...next, playedBirdIds: [...state.playedBirdIds, cardId] });
}

function applyGainFood(state: WingspanState): WingspanState {
  // src/entities/birdfeeder.py BirdFeeder.take_food: decrement, and reroll
  // (reset to capacity) immediately if that decrement empties the feeder.
  let feederFood = state.feederFood - 1;
  if (feederFood === 0) feederFood = FEEDER_CAPACITY;
  const next = withPlayer(state, state.active, (p) => ({ ...p, food: p.food + 1 }));
  return endTurn({ ...next, feederFood });
}

function applyDrawTray(state: WingspanState, cardId: string): WingspanState {
  const tray = state.tray.filter((id) => id !== cardId);
  const next = withPlayer(state, state.active, (p) => ({ ...p, hand: [...p.hand, cardId] }));
  return endTurn({ ...next, tray });
}

function applyDrawDeck(state: WingspanState): WingspanState {
  const cardId = state.deck[0];
  if (!cardId) throw new Error('applyDrawDeck: deck is empty');
  const deck = state.deck.slice(1);
  const next = withPlayer(state, state.active, (p) => ({ ...p, hand: [...p.hand, cardId] }));
  return endTurn({ ...next, deck });
}

function applyChoice(state: WingspanState, choice: WingspanChoice): WingspanState {
  if (state.gameOver) throw new Error('applyChoice: game is already over');
  const legal = getLegalChoices(state);
  if (!legal.some((candidate) => sameChoice(candidate, choice))) {
    throw new Error(`applyChoice: ${encodeChoice(choice)} is not a legal choice`);
  }

  switch (choice.kind) {
    case 'playBird':
      return applyPlayBird(state, choice.cardId);
    case 'gainFood':
      return applyGainFood(state);
    case 'drawTray':
      return applyDrawTray(state, choice.cardId);
    case 'drawDeck':
      return applyDrawDeck(state);
    default: {
      const exhaustive: never = choice;
      throw new Error(`applyChoice: unhandled choice ${JSON.stringify(exhaustive)}`);
    }
  }
}

function getObservation(state: WingspanState, player: PlayerId): WingspanObservation {
  const self = getPlayer(state, player);
  const opponent = getPlayer(state, otherPlayer(player));
  const boards: [readonly string[], readonly string[]] =
    player === 0 ? [state.players[0].board, state.players[1].board] : [state.players[1].board, state.players[0].board];
  const food: [number, number] =
    player === 0 ? [state.players[0].food, state.players[1].food] : [state.players[1].food, state.players[0].food];
  return {
    self: player,
    selfHand: self.hand,
    opponentHandCount: opponent.hand.length,
    boards,
    food,
    tray: state.tray,
    feederFood: state.feederFood,
    deckCount: state.deck.length,
    active: state.active,
  };
}

function getOutcome(state: WingspanState): Outcome | null {
  if (!state.gameOver) return null;
  const scores = state.players.map((p) => score(p));
  const maxScore = Math.max(...scores);
  const winners: PlayerId[] = [];
  scores.forEach((s, id) => {
    if (s === maxScore) winners.push(id);
  });
  return { scores, winners };
}

function encodeChoice(choice: WingspanChoice): string {
  switch (choice.kind) {
    case 'playBird':
      return `playBird:${choice.cardId}`;
    case 'gainFood':
      return 'gainFood';
    case 'drawTray':
      return `drawTray:${choice.cardId}`;
    case 'drawDeck':
      return 'drawDeck';
    default: {
      const exhaustive: never = choice;
      throw new Error(`encodeChoice: unhandled choice ${JSON.stringify(exhaustive)}`);
    }
  }
}

// --- Invariants -------------------------------------------------------

function cardConservationInvariant(state: WingspanState): string | null {
  const total =
    state.deck.length +
    state.tray.length +
    state.players.reduce((sum, p) => sum + p.hand.length + p.board.length, 0);
  return total === BIRD_IDS.length
    ? null
    : `card conservation violated: total tracked cards is ${total}, expected ${BIRD_IDS.length}`;
}

function noDuplicateCardsInvariant(state: WingspanState): string | null {
  const seen = new Set<string>();
  const allIds = [
    ...state.deck,
    ...state.tray,
    ...state.players.flatMap((p) => [...p.hand, ...p.board]),
  ];
  for (const id of allIds) {
    if (seen.has(id)) return `duplicate bird ${id} found among tracked cards`;
    seen.add(id);
  }
  return null;
}

function foodNonNegativeInvariant(state: WingspanState): string | null {
  for (const player of state.players) {
    if (player.food < 0) return `player holds negative food (${player.food})`;
  }
  return null;
}

function boardCapacityInvariant(state: WingspanState): string | null {
  for (const player of state.players) {
    if (player.board.length > BOARD_CAPACITY) {
      return `player board holds ${player.board.length} birds, exceeding capacity ${BOARD_CAPACITY}`;
    }
  }
  return null;
}

function feederRangeInvariant(state: WingspanState): string | null {
  if (state.feederFood < 1 || state.feederFood > FEEDER_CAPACITY) {
    return `feeder food ${state.feederFood} outside expected range [1, ${FEEDER_CAPACITY}]`;
  }
  return null;
}

function turnBoundInvariant(state: WingspanState): string | null {
  if (state.gameTurn > TOTAL_TURNS) {
    return `gameTurn ${state.gameTurn} exceeds TOTAL_TURNS ${TOTAL_TURNS}`;
  }
  return null;
}

// --- Content coverage ---------------------------------------------------

const contentInventory = BIRD_DEFS.map((bird) => ({
  id: bird.id,
  description: `${bird.name} — ${bird.points} points, food cost ${bird.foodCost}`,
}));

function exercisedContent(finalState: WingspanState): readonly string[] {
  return [...new Set(finalState.playedBirdIds)];
}

// --- Hidden information --------------------------------------------------

function arraysOfIdsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

const hiddenInfoProbe: HiddenInfoProbe<WingspanState> = {
  mutateHidden(state, viewer, rng) {
    const opponentId = otherPlayer(viewer);
    const opponent = getPlayer(state, opponentId);
    const pool = [...opponent.hand, ...state.deck];
    if (pool.length <= 1) {
      // 0 or 1 hidden cards: no reshuffle can change anything meaningful.
      return null;
    }

    let shuffledPool = shuffled(pool, rng);
    if (arraysOfIdsEqual(shuffledPool, pool)) {
      const swapped = shuffledPool.slice();
      const first = swapped[0];
      const second = swapped[1];
      if (first !== undefined && second !== undefined) {
        swapped[0] = second;
        swapped[1] = first;
      }
      shuffledPool = swapped;
    }

    const newOpponentHand = shuffledPool.slice(0, opponent.hand.length);
    const newDeck = shuffledPool.slice(opponent.hand.length);
    return withPlayer({ ...state, deck: newDeck }, opponentId, (p) => ({ ...p, hand: newOpponentHand }));
  },
};

// --- Baselines ------------------------------------------------------------

const randomBaseline: BotFactory<WingspanObservation, WingspanChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'wingspan-random',
    decide(_decisionPoint, _observation, legal) {
      return legal[rng.nextInt(legal.length)] as WingspanChoice;
    },
  };
};

function birdEfficiency(cardId: string): number {
  const def = birdDef(cardId);
  return def.foodCost === 0 ? def.points + 0.5 : def.points / def.foodCost;
}

function heuristicPick(
  _decisionPoint: string,
  _observation: WingspanObservation,
  legal: readonly WingspanChoice[],
): WingspanChoice {
  const plays = legal.filter((c): c is Extract<WingspanChoice, { kind: 'playBird' }> => c.kind === 'playBird');
  if (plays.length > 0) {
    const sorted = [...plays].sort((a, b) => {
      const diff = birdEfficiency(b.cardId) - birdEfficiency(a.cardId);
      if (diff !== 0) return diff;
      return a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0;
    });
    return sorted[0] as WingspanChoice;
  }

  const trayDraws = legal.filter((c): c is Extract<WingspanChoice, { kind: 'drawTray' }> => c.kind === 'drawTray');
  if (trayDraws.length > 0) {
    const sorted = [...trayDraws].sort((a, b) => {
      const diff = birdDef(b.cardId).points - birdDef(a.cardId).points;
      if (diff !== 0) return diff;
      return a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0;
    });
    return sorted[0] as WingspanChoice;
  }

  const deckDraw = legal.find((c) => c.kind === 'drawDeck');
  if (deckDraw) return deckDraw;

  const gainFood = legal.find((c) => c.kind === 'gainFood');
  return gainFood ?? (legal[0] as WingspanChoice);
}

const heuristicBaseline: BotFactory<WingspanObservation, WingspanChoice> = (_seed) => {
  return {
    id: 'wingspan-heuristic',
    decide: heuristicPick,
  };
};

function wrapBotId(bot: GameBot<WingspanObservation, WingspanChoice>, suffix: string): string {
  return `${bot.id}+${suffix}`;
}

/** Strategy flag: marginal. Always plays the highest points-per-food bird when one is affordable. */
const playHighestPoints: StrategyFlagSpec<WingspanObservation, WingspanChoice> = {
  flag: 'playHighestPoints',
  description: 'Whenever a playBird choice is legal, always play the highest-points affordable bird.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot, 'playHighestPoints'),
        decide(decisionPoint, observation, legal) {
          const plays = legal.filter(
            (c): c is Extract<WingspanChoice, { kind: 'playBird' }> => c.kind === 'playBird',
          );
          if (plays.length > 0) {
            const sorted = [...plays].sort((a, b) => {
              const diff = birdDef(b.cardId).points - birdDef(a.cardId).points;
              if (diff !== 0) return diff;
              return a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0;
            });
            return sorted[0] as WingspanChoice;
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/** Strategy flag: marginal. Whenever drawing from the tray, always take the highest-point bird visible. */
const drawHighestPointTray: StrategyFlagSpec<WingspanObservation, WingspanChoice> = {
  flag: 'drawHighestPointTray',
  description: 'Whenever a drawTray choice is legal, always take the highest-point bird visible in the tray.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot, 'drawHighestPointTray'),
        decide(decisionPoint, observation, legal) {
          const trayDraws = legal.filter(
            (c): c is Extract<WingspanChoice, { kind: 'drawTray' }> => c.kind === 'drawTray',
          );
          if (trayDraws.length > 0) {
            const sorted = [...trayDraws].sort((a, b) => {
              const diff = birdDef(b.cardId).points - birdDef(a.cardId).points;
              if (diff !== 0) return diff;
              return a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0;
            });
            return sorted[0] as WingspanChoice;
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/**
 * Strategy flag: effective. Always gainFood when legal, ignoring any
 * play/draw opportunity. gainFood is unconditionally legal every turn
 * (see file header), so this flag deterministically forces every decision —
 * a deliberately extreme counterpoint to the heuristic baseline, which only
 * ever falls back to gainFood when nothing else is legal.
 */
const gainFoodFirst: StrategyFlagSpec<WingspanObservation, WingspanChoice> = {
  flag: 'gainFoodFirst',
  description: 'Always gainFood when legal, ignoring any playBird or draw opportunity.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot, 'gainFoodFirst'),
        decide(decisionPoint, observation, legal) {
          const gainFood = legal.find((c) => c.kind === 'gainFood');
          if (gainFood) return gainFood;
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/**
 * Replay fixtures: random-vs-random self-play, captured by actually running
 * this adapter (see src/reference/__tests__/wingspan.test.ts generation
 * note) and hardcoded here — not hand-simulated.
 */
const replayFixtures: readonly ReplayFixture[] = [
  {
    id: 'wingspan-core-2p-seed-11',
    seed: 11,
    choiceKeys: [
      'drawTray:bald-eagle', 'drawDeck', 'drawTray:american-robin', 'drawTray:red-tailed-hawk',
      'drawTray:killdeer', 'drawDeck', 'gainFood', 'drawTray:american-woodcock',
      'drawTray:american-crow', 'playBird:red-tailed-hawk', 'playBird:american-crow',
      'drawTray:great-blue-heron', 'playBird:purple-martin', 'gainFood', 'drawTray:mourning-dove',
      'playBird:carolina-wren', 'drawTray:california-condor', 'gainFood', 'playBird:california-condor',
      'drawDeck',
    ],
    finalScores: [7, 6],
  },
  {
    id: 'wingspan-core-2p-seed-22',
    seed: 22,
    choiceKeys: [
      'drawTray:song-sparrow', 'drawDeck', 'playBird:american-woodcock', 'gainFood',
      'drawTray:house-wren', 'drawTray:killdeer', 'drawTray:california-condor', 'drawDeck',
      'drawTray:purple-martin', 'drawTray:blue-jay', 'drawDeck', 'gainFood',
      'drawTray:american-robin', 'drawTray:bushtit', 'drawTray:mourning-dove', 'drawTray:mallard',
      'drawTray:great-blue-heron', 'drawTray:carolina-wren', 'playBird:california-condor',
      'playBird:american-goldfinch',
    ],
    finalScores: [10, 3],
  },
  {
    id: 'wingspan-core-2p-seed-33',
    seed: 33,
    choiceKeys: [
      'drawTray:turkey-vulture', 'drawTray:blue-jay', 'drawTray:song-sparrow', 'drawTray:bald-eagle',
      'drawTray:american-crow', 'drawDeck', 'playBird:american-woodcock', 'playBird:blue-jay',
      'drawTray:california-condor', 'playBird:purple-martin', 'drawTray:great-blue-heron', 'drawDeck',
      'playBird:california-condor', 'drawTray:american-robin', 'drawTray:bushtit',
      'drawTray:american-goldfinch', 'drawTray:black-vulture', 'gainFood', 'drawTray:mallard',
      'playBird:northern-harrier',
    ],
    finalScores: [10, 8],
  },
];

export const wingspanAdapter: GameAdapter<WingspanState, WingspanObservation, WingspanChoice> = {
  spec: {
    gameId: 'wingspan-core-2p',
    playerCount: PLAYER_COUNT,
    decisionPoints: [
      {
        id: 'turn',
        description: 'Play an affordable bird, gain 1 food from the feeder, or draw a bird from the tray/deck.',
      },
    ],
    seatingPlan: [
      [0, 1],
      [1, 0],
    ],
    maxDecisionsPerGame: TOTAL_TURNS,
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
    foodNonNegativeInvariant,
    boardCapacityInvariant,
    feederRangeInvariant,
    turnBoundInvariant,
  ],
  contentInventory,
  exercisedContent,
  hiddenInfoProbe,
  replayFixtures,
  baselines: {
    random: randomBaseline,
    heuristic: heuristicBaseline,
  },
  strategySurface: [playHighestPoints, drawHighestPointTray, gainFoodFirst],
};
