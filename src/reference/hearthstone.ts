/**
 * hearthstone — reference GameAdapter onboarding a reduced Hearthstone-style
 * card game onto Loop Forge, transcribed from
 * https://github.com/danielyule/hearthbreaker (Python, headless Hearthstone
 * engine used for ML/data-mining, `hearthbreaker/cards/base.py`,
 * `hearthbreaker/cards/minions/neutral.py`, `hearthbreaker/cards/spells/*.py`,
 * `hearthbreaker/engine.py`).
 *
 * Deliberate scope reduction (docs/ONBOARDING-GUIDE.md §5.7 "덱/로드아웃은
 * 좌석에 결합하라"), documented rather than silently assumed:
 *
 *   - **Mirror match only**: both seats play the exact same fixed 12-card
 *     pool (2 copies each = 24-card deck). Deck-building/exploration is a
 *     roadmap item, not this onboarding pass.
 *   - **Neutral cards only, no class cards, no weapons**: the reference
 *     source's spells (Frostbolt, Fireball, Mind Blast, ...) are all
 *     class-specific. To include *any* spell in a class-less neutral-only
 *     pool this adapter defines two simplified neutral spells whose damage
 *     numbers are borrowed from real neutral-equivalent effects (see
 *     `CARD_DEFS` comments below) — a deliberate deviation, not a scrape.
 *     Similarly the single hero power (2 mana, 1 damage to any enemy
 *     character) is modeled on the simplest basic hero power in the real
 *     game (Mage's Fireblast) but made class-less here.
 *   - **No mulligan step**: opening hands are dealt directly from the seeded
 *     shuffle (source: `Game.pre_game` deals + lets each player mulligan).
 *     Second player gets a 4th card as their only compensation for going
 *     second (no "The Coin" card implemented) — a simplification of the
 *     real game's coin mechanic.
 *   - **No deathrattle, no silence, no taunt, no freeze, no divine shield,
 *     no windfury**: complex keywords out of scope per the task brief. The
 *     only minion keyword implemented is **charge** (`Stonetusk Boar`),
 *     since it is required to make the vanilla-minion set non-trivial and is
 *     a single boolean.
 *   - **Fatigue** (source: `Player.draw`, `engine.py:398-412`) and the
 *     **10-card hand burn** (source: `Player.draw`, same method) are
 *     implemented exactly as in the reference engine.
 *   - **Board cap (7 minions)** and **10-card hand cap** are the real game's
 *     limits, both implemented.
 *   - Anti-stall: `MAX_TOTAL_TURNS` forces game-over via a hero-health
 *     tiebreak if neither hero dies naturally (the reference game has no
 *     turn limit; a bounded conformance playout budget needs one, in the
 *     spirit of the same deviation documented in splendor.ts).
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

// --- Card pool --------------------------------------------------------

export type BattlecryEffect =
  | { readonly kind: 'none' }
  | { readonly kind: 'damageEnemy'; readonly amount: number }
  | { readonly kind: 'drawCard'; readonly count: number }
  | { readonly kind: 'buffFriendlyMinion'; readonly attack: number; readonly health: number }
  | { readonly kind: 'healOwnHero'; readonly amount: number };

export interface MinionDef {
  readonly kind: 'minion';
  readonly id: string;
  readonly name: string;
  readonly cost: number;
  readonly attack: number;
  readonly health: number;
  readonly charge: boolean;
  readonly battlecry: BattlecryEffect;
}

export type SpellEffect =
  | { readonly kind: 'damageEnemy'; readonly amount: number }
  | { readonly kind: 'drawCard'; readonly count: number };

export interface SpellDef {
  readonly kind: 'spell';
  readonly id: string;
  readonly name: string;
  readonly cost: number;
  readonly effect: SpellEffect;
}

export type CardDef = MinionDef | SpellDef;

// Stats transcribed from hearthbreaker/cards/minions/neutral.py; battlecry
// numbers transcribed from the same file's Battlecry(...) constructors,
// except the two spells (see file header deviation note).
export const CARD_DEFS: readonly CardDef[] = [
  { kind: 'minion', id: 'stonetusk-boar', name: 'Stonetusk Boar', cost: 1, attack: 1, health: 1, charge: true, battlecry: { kind: 'none' } },
  { kind: 'minion', id: 'elven-archer', name: 'Elven Archer', cost: 1, attack: 1, health: 1, charge: false, battlecry: { kind: 'damageEnemy', amount: 1 } },
  { kind: 'minion', id: 'river-crocolisk', name: 'River Crocolisk', cost: 2, attack: 2, health: 3, charge: false, battlecry: { kind: 'none' } },
  { kind: 'minion', id: 'novice-engineer', name: 'Novice Engineer', cost: 2, attack: 1, health: 1, charge: false, battlecry: { kind: 'drawCard', count: 1 } },
  { kind: 'spell', id: 'spark-bolt', name: 'Spark Bolt', cost: 2, effect: { kind: 'damageEnemy', amount: 3 } },
  { kind: 'minion', id: 'magma-rager', name: 'Magma Rager', cost: 3, attack: 5, health: 1, charge: false, battlecry: { kind: 'none' } },
  { kind: 'minion', id: 'shattered-sun-cleric', name: 'Shattered Sun Cleric', cost: 3, attack: 2, health: 2, charge: false, battlecry: { kind: 'buffFriendlyMinion', attack: 1, health: 1 } },
  { kind: 'spell', id: 'quick-study', name: 'Quick Study', cost: 3, effect: { kind: 'drawCard', count: 2 } },
  { kind: 'minion', id: 'chillwind-yeti', name: 'Chillwind Yeti', cost: 4, attack: 4, health: 5, charge: false, battlecry: { kind: 'none' } },
  { kind: 'minion', id: 'darkscale-healer', name: 'Darkscale Healer', cost: 5, attack: 4, health: 5, charge: false, battlecry: { kind: 'healOwnHero', amount: 2 } },
  { kind: 'minion', id: 'boulderfist-ogre', name: 'Boulderfist Ogre', cost: 6, attack: 6, health: 7, charge: false, battlecry: { kind: 'none' } },
  { kind: 'minion', id: 'war-golem', name: 'War Golem', cost: 7, attack: 7, health: 7, charge: false, battlecry: { kind: 'none' } },
];

const CARD_DEFS_BY_ID: ReadonlyMap<string, CardDef> = new Map(CARD_DEFS.map((def) => [def.id, def]));

const DECK_COPIES = 2;
const STARTING_HERO_HEALTH = 30;
const MAX_MANA = 10;
const MAX_HAND_SIZE = 10;
const MAX_BOARD_SIZE = 7;
const FIRST_PLAYER_HAND_SIZE = 3;
const SECOND_PLAYER_HAND_SIZE = 4;
const HERO_POWER_COST = 2;
const HERO_POWER_DAMAGE = 1;
// Anti-stall bound; not part of the reference source (see file header).
const MAX_TOTAL_TURNS = 80;

// --- State --------------------------------------------------------

export interface CardInstance {
  readonly instanceId: string;
  readonly defId: string;
}

export interface MinionInstance {
  readonly instanceId: string;
  readonly defId: string;
  readonly attack: number;
  readonly health: number;
  readonly maxHealth: number;
  readonly summoningSick: boolean;
  readonly hasAttacked: boolean;
}

export interface HeroState {
  readonly health: number;
}

export interface HearthstonePlayerState {
  readonly hero: HeroState;
  readonly hand: readonly CardInstance[];
  readonly deck: readonly CardInstance[];
  readonly board: readonly MinionInstance[];
  readonly manaMax: number;
  readonly manaCurrent: number;
  readonly fatigue: number;
  readonly heroPowerUsed: boolean;
  /**
   * Cards permanently removed from this player's play area — played spells
   * (consumed on cast, tracked nowhere else), minions that have died
   * (`pruneDeadMinions` drops them from `board` with no other record), and
   * cards burned by drawing into a full 10-card hand (`drawCardFor`; the
   * card leaves the deck but never enters the hand). A public zone: both
   * players observe a spell being cast, a minion dying, or a burn happening,
   * same rationale as dominion's `trash` (src/reference/dominion.ts's P4
   * doc comment) — needed so `sampleStateFromObservation` below can account
   * for every card in this player's fixed 24-card universe (`buildDeck`)
   * without silently miscounting a dead/played/burned card back into the
   * hidden pool.
   */
  readonly graveyard: readonly CardInstance[];
}

export interface HearthstoneState {
  readonly players: readonly [HearthstonePlayerState, HearthstonePlayerState];
  readonly active: PlayerId;
  readonly turnNumber: number;
  readonly gameOver: boolean;
  /** defIds of every card played this game, across both players (may repeat). */
  readonly playedCardIds: readonly string[];
  readonly usedHeroPower: boolean;
}

export interface HearthstoneObservation {
  readonly self: PlayerId;
  readonly active: PlayerId;
  readonly turnNumber: number;
  readonly myHero: HeroState;
  readonly myMana: { readonly current: number; readonly max: number };
  readonly myHeroPowerUsed: boolean;
  readonly myHand: readonly CardInstance[];
  readonly myBoard: readonly MinionInstance[];
  readonly myDeckSize: number;
  readonly myFatigue: number;
  /** Own graveyard — see `HearthstonePlayerState.graveyard` doc comment. */
  readonly myGraveyard: readonly CardInstance[];
  readonly opponentHero: HeroState;
  readonly opponentMana: { readonly current: number; readonly max: number };
  readonly opponentHeroPowerUsed: boolean;
  readonly opponentBoard: readonly MinionInstance[];
  readonly opponentHandSize: number;
  readonly opponentDeckSize: number;
  readonly opponentFatigue: number;
  /** Opponent graveyard — public zone, same doc comment as `myGraveyard`. */
  readonly opponentGraveyard: readonly CardInstance[];
}

export type HearthstoneChoice =
  | { readonly kind: 'play'; readonly cardInstanceId: string; readonly targetId?: string }
  | { readonly kind: 'heroPower'; readonly targetId: string }
  | { readonly kind: 'attack'; readonly attackerId: string; readonly targetId: string }
  | { readonly kind: 'endTurn' };

function otherPlayer(player: PlayerId): PlayerId {
  return player === 0 ? 1 : 0;
}

function getPlayer(state: HearthstoneState, id: PlayerId): HearthstonePlayerState {
  const player = state.players[id];
  if (!player) throw new Error(`getPlayer: no such player ${id}`);
  return player;
}

function heroTargetId(player: PlayerId): string {
  return `hero:${player}`;
}

function isHeroTargetFor(targetId: string, player: PlayerId): boolean {
  return targetId === heroTargetId(player);
}

function enemyTargets(opponentPlayer: PlayerId, opponent: HearthstonePlayerState): string[] {
  return [heroTargetId(opponentPlayer), ...opponent.board.map((m) => m.instanceId)];
}

function buildDeck(playerIndex: PlayerId): CardInstance[] {
  const deck: CardInstance[] = [];
  for (const def of CARD_DEFS) {
    for (let copy = 1; copy <= DECK_COPIES; copy += 1) {
      deck.push({ instanceId: `p${playerIndex}-${def.id}-${copy}`, defId: def.id });
    }
  }
  return deck;
}

export function createInitialState(seed: number): HearthstoneState {
  const rng = createRng(seed);
  const deck0 = shuffled(buildDeck(0), rng.fork('deck0'));
  const deck1 = shuffled(buildDeck(1), rng.fork('deck1'));

  const player0: HearthstonePlayerState = {
    hero: { health: STARTING_HERO_HEALTH },
    hand: deck0.slice(0, FIRST_PLAYER_HAND_SIZE),
    deck: deck0.slice(FIRST_PLAYER_HAND_SIZE),
    board: [],
    manaMax: 1,
    manaCurrent: 1,
    fatigue: 0,
    heroPowerUsed: false,
    graveyard: [],
  };
  const player1: HearthstonePlayerState = {
    hero: { health: STARTING_HERO_HEALTH },
    hand: deck1.slice(0, SECOND_PLAYER_HAND_SIZE),
    deck: deck1.slice(SECOND_PLAYER_HAND_SIZE),
    board: [],
    manaMax: 0,
    manaCurrent: 0,
    fatigue: 0,
    heroPowerUsed: false,
    graveyard: [],
  };

  return {
    players: [player0, player1],
    active: 0,
    turnNumber: 1,
    gameOver: false,
    playedCardIds: [],
    usedHeroPower: false,
  };
}

function withPlayer(
  state: HearthstoneState,
  player: PlayerId,
  update: (p: HearthstonePlayerState) => HearthstonePlayerState,
): HearthstoneState {
  const players: [HearthstonePlayerState, HearthstonePlayerState] = [...state.players];
  players[player] = update(getPlayer(state, player));
  return { ...state, players };
}

function withPlayerState(
  state: HearthstoneState,
  player: PlayerId,
  next: HearthstonePlayerState,
): HearthstoneState {
  return withPlayer(state, player, () => next);
}

function currentDecision(state: HearthstoneState): PendingDecision | null {
  if (state.gameOver) return null;
  return { player: state.active, decisionPoint: 'action' };
}

function locate(
  state: HearthstoneState,
  targetId: string,
): { readonly type: 'hero'; readonly player: PlayerId } | { readonly type: 'minion'; readonly player: PlayerId; readonly minion: MinionInstance } {
  if (targetId.startsWith('hero:')) {
    const player = Number(targetId.slice('hero:'.length)) as PlayerId;
    return { type: 'hero', player };
  }
  for (const player of [0, 1] as const) {
    const minion = getPlayer(state, player).board.find((m) => m.instanceId === targetId);
    if (minion) return { type: 'minion', player, minion };
  }
  throw new Error(`locate: no such target ${targetId}`);
}

function pruneOneDead(p: HearthstonePlayerState): HearthstonePlayerState {
  const dead = p.board.filter((m) => m.health <= 0);
  if (dead.length === 0) return p;
  return {
    ...p,
    board: p.board.filter((m) => m.health > 0),
    graveyard: [...p.graveyard, ...dead.map((m) => ({ instanceId: m.instanceId, defId: m.defId }))],
  };
}

function pruneDeadMinions(state: HearthstoneState): HearthstoneState {
  const players: [HearthstonePlayerState, HearthstonePlayerState] = [
    pruneOneDead(state.players[0]),
    pruneOneDead(state.players[1]),
  ];
  return { ...state, players };
}

function checkGameOver(state: HearthstoneState): HearthstoneState {
  const dead = state.players.some((p) => p.hero.health <= 0);
  return dead ? { ...state, gameOver: true } : state;
}

function applyDamage(state: HearthstoneState, targetId: string, amount: number): HearthstoneState {
  const loc = locate(state, targetId);
  if (loc.type === 'hero') {
    const next = withPlayer(state, loc.player, (p) => ({ ...p, hero: { health: p.hero.health - amount } }));
    return checkGameOver(next);
  }
  const next = withPlayer(state, loc.player, (p) => ({
    ...p,
    board: p.board.map((m) => (m.instanceId === loc.minion.instanceId ? { ...m, health: m.health - amount } : m)),
  }));
  return pruneDeadMinions(next);
}

function drawCardFor(state: HearthstoneState, player: PlayerId): HearthstoneState {
  const p = getPlayer(state, player);
  if (p.deck.length === 0) {
    const fatigue = p.fatigue + 1;
    const next = withPlayerState(state, player, {
      ...p,
      fatigue,
      hero: { health: p.hero.health - fatigue },
    });
    return checkGameOver(next);
  }
  const card = p.deck[0] as CardInstance;
  const restDeck = p.deck.slice(1);
  // A draw into a full hand burns the card (real Hearthstone behavior — see
  // file header's "10-card hand burn" note): it leaves the deck but does not
  // enter the hand. It still has to land in `graveyard` (a burn is a public
  // event, same as a played spell or a dead minion) — otherwise it vanishes
  // from every tracked zone and `sampleStateFromObservation`'s conservation
  // accounting (own-universe minus hand/board/graveyard === deck size)
  // silently drifts out of sync with the real deck size.
  if (p.hand.length >= MAX_HAND_SIZE) {
    return withPlayerState(state, player, { ...p, deck: restDeck, graveyard: [...p.graveyard, card] });
  }
  const hand = [...p.hand, card];
  return withPlayerState(state, player, { ...p, deck: restDeck, hand });
}

function applyBattlecry(
  state: HearthstoneState,
  player: PlayerId,
  effect: BattlecryEffect,
  targetId: string | undefined,
): HearthstoneState {
  switch (effect.kind) {
    case 'none':
      return state;
    case 'damageEnemy': {
      if (targetId === undefined) {
        throw new Error('applyBattlecry: damageEnemy requires a targetId');
      }
      return applyDamage(state, targetId, effect.amount);
    }
    case 'drawCard': {
      let next = state;
      for (let i = 0; i < effect.count; i += 1) {
        next = drawCardFor(next, player);
      }
      return next;
    }
    case 'buffFriendlyMinion': {
      if (targetId === undefined) return state;
      return withPlayer(state, player, (p) => ({
        ...p,
        board: p.board.map((m) =>
          m.instanceId === targetId
            ? { ...m, attack: m.attack + effect.attack, health: m.health + effect.health, maxHealth: m.maxHealth + effect.health }
            : m,
        ),
      }));
    }
    case 'healOwnHero': {
      return withPlayer(state, player, (p) => ({
        ...p,
        hero: { health: Math.min(STARTING_HERO_HEALTH, p.hero.health + effect.amount) },
      }));
    }
    default: {
      const exhaustive: never = effect;
      throw new Error(`applyBattlecry: unhandled effect ${JSON.stringify(exhaustive)}`);
    }
  }
}

function applySpellEffect(
  state: HearthstoneState,
  player: PlayerId,
  effect: SpellEffect,
  targetId: string | undefined,
): HearthstoneState {
  switch (effect.kind) {
    case 'damageEnemy': {
      if (targetId === undefined) {
        throw new Error('applySpellEffect: damageEnemy requires a targetId');
      }
      return applyDamage(state, targetId, effect.amount);
    }
    case 'drawCard': {
      let next = state;
      for (let i = 0; i < effect.count; i += 1) {
        next = drawCardFor(next, player);
      }
      return next;
    }
    default: {
      const exhaustive: never = effect;
      throw new Error(`applySpellEffect: unhandled effect ${JSON.stringify(exhaustive)}`);
    }
  }
}

function applyPlay(state: HearthstoneState, choice: Extract<HearthstoneChoice, { kind: 'play' }>): HearthstoneState {
  const player = state.active;
  const ps = getPlayer(state, player);
  const cardInstance = ps.hand.find((c) => c.instanceId === choice.cardInstanceId);
  if (!cardInstance) throw new Error(`applyPlay: no such card ${choice.cardInstanceId} in hand`);
  const def = CARD_DEFS_BY_ID.get(cardInstance.defId);
  if (!def) throw new Error(`applyPlay: unknown card def ${cardInstance.defId}`);

  let next = withPlayer(state, player, (p) => ({
    ...p,
    hand: p.hand.filter((c) => c.instanceId !== cardInstance.instanceId),
    manaCurrent: p.manaCurrent - def.cost,
  }));
  next = { ...next, playedCardIds: [...next.playedCardIds, def.id] };

  if (def.kind === 'minion') {
    const newMinion: MinionInstance = {
      instanceId: cardInstance.instanceId,
      defId: def.id,
      attack: def.attack,
      health: def.health,
      maxHealth: def.health,
      summoningSick: !def.charge,
      hasAttacked: false,
    };
    next = withPlayer(next, player, (p) => ({ ...p, board: [...p.board, newMinion] }));
    next = applyBattlecry(next, player, def.battlecry, choice.targetId);
  } else {
    next = applySpellEffect(next, player, def.effect, choice.targetId);
    // Spells are consumed on cast — they don't sit on the board where death
    // would already send them to the graveyard, so record them here instead.
    next = withPlayer(next, player, (p) => ({
      ...p,
      graveyard: [...p.graveyard, { instanceId: cardInstance.instanceId, defId: cardInstance.defId }],
    }));
  }
  return checkGameOver(next);
}

function applyHeroPower(state: HearthstoneState, targetId: string): HearthstoneState {
  const player = state.active;
  let next = withPlayer(state, player, (p) => ({
    ...p,
    manaCurrent: p.manaCurrent - HERO_POWER_COST,
    heroPowerUsed: true,
  }));
  next = { ...next, usedHeroPower: true };
  next = applyDamage(next, targetId, HERO_POWER_DAMAGE);
  return checkGameOver(next);
}

function applyAttack(state: HearthstoneState, attackerId: string, targetId: string): HearthstoneState {
  const attackerPlayer = state.active;
  const attacker = getPlayer(state, attackerPlayer).board.find((m) => m.instanceId === attackerId);
  if (!attacker) throw new Error(`applyAttack: no such attacker ${attackerId}`);
  const loc = locate(state, targetId);

  let next = state;
  if (loc.type === 'hero') {
    next = withPlayer(next, loc.player, (p) => ({ ...p, hero: { health: p.hero.health - attacker.attack } }));
  } else {
    const defender = loc.minion;
    next = withPlayer(next, loc.player, (p) => ({
      ...p,
      board: p.board.map((m) => (m.instanceId === defender.instanceId ? { ...m, health: m.health - attacker.attack } : m)),
    }));
    next = withPlayer(next, attackerPlayer, (p) => ({
      ...p,
      board: p.board.map((m) => (m.instanceId === attacker.instanceId ? { ...m, health: m.health - defender.attack } : m)),
    }));
  }
  next = withPlayer(next, attackerPlayer, (p) => ({
    ...p,
    board: p.board.map((m) => (m.instanceId === attacker.instanceId ? { ...m, hasAttacked: true } : m)),
  }));
  next = pruneDeadMinions(next);
  return checkGameOver(next);
}

function startNextTurn(state: HearthstoneState): HearthstoneState {
  const nextActive = otherPlayer(state.active);
  let next: HearthstoneState = { ...state, active: nextActive, turnNumber: state.turnNumber + 1 };
  next = withPlayer(next, nextActive, (p) => {
    const manaMax = Math.min(MAX_MANA, p.manaMax + 1);
    return {
      ...p,
      manaMax,
      manaCurrent: manaMax,
      heroPowerUsed: false,
      board: p.board.map((m) => ({ ...m, summoningSick: false, hasAttacked: false })),
    };
  });
  next = drawCardFor(next, nextActive);
  if (next.turnNumber > MAX_TOTAL_TURNS) {
    next = { ...next, gameOver: true };
  }
  return next;
}

function pushMinionPlayChoices(
  choices: HearthstoneChoice[],
  card: CardInstance,
  def: MinionDef,
  ps: HearthstonePlayerState,
  opponentPlayer: PlayerId,
  opp: HearthstonePlayerState,
): void {
  switch (def.battlecry.kind) {
    case 'none':
    case 'drawCard':
    case 'healOwnHero':
      choices.push({ kind: 'play', cardInstanceId: card.instanceId });
      return;
    case 'damageEnemy':
      for (const targetId of enemyTargets(opponentPlayer, opp)) {
        choices.push({ kind: 'play', cardInstanceId: card.instanceId, targetId });
      }
      return;
    case 'buffFriendlyMinion':
      if (ps.board.length === 0) {
        choices.push({ kind: 'play', cardInstanceId: card.instanceId });
      } else {
        for (const minion of ps.board) {
          choices.push({ kind: 'play', cardInstanceId: card.instanceId, targetId: minion.instanceId });
        }
      }
      return;
    default: {
      const exhaustive: never = def.battlecry;
      throw new Error(`pushMinionPlayChoices: unhandled battlecry ${JSON.stringify(exhaustive)}`);
    }
  }
}

function pushSpellPlayChoices(
  choices: HearthstoneChoice[],
  card: CardInstance,
  def: SpellDef,
  opponentPlayer: PlayerId,
  opp: HearthstonePlayerState,
): void {
  if (def.effect.kind === 'damageEnemy') {
    for (const targetId of enemyTargets(opponentPlayer, opp)) {
      choices.push({ kind: 'play', cardInstanceId: card.instanceId, targetId });
    }
  } else {
    choices.push({ kind: 'play', cardInstanceId: card.instanceId });
  }
}

function getLegalChoices(state: HearthstoneState): readonly HearthstoneChoice[] {
  const decision = currentDecision(state);
  if (!decision) throw new Error('getLegalChoices: game is already over');
  const player = state.active;
  const opponentPlayer = otherPlayer(player);
  const ps = getPlayer(state, player);
  const opp = getPlayer(state, opponentPlayer);
  const choices: HearthstoneChoice[] = [];

  for (const card of ps.hand) {
    const def = CARD_DEFS_BY_ID.get(card.defId);
    if (!def || def.cost > ps.manaCurrent) continue;
    if (def.kind === 'minion') {
      if (ps.board.length >= MAX_BOARD_SIZE) continue;
      pushMinionPlayChoices(choices, card, def, ps, opponentPlayer, opp);
    } else {
      pushSpellPlayChoices(choices, card, def, opponentPlayer, opp);
    }
  }

  if (!ps.heroPowerUsed && ps.manaCurrent >= HERO_POWER_COST) {
    for (const targetId of enemyTargets(opponentPlayer, opp)) {
      choices.push({ kind: 'heroPower', targetId });
    }
  }

  for (const minion of ps.board) {
    if (minion.summoningSick || minion.hasAttacked || minion.attack <= 0) continue;
    for (const targetId of enemyTargets(opponentPlayer, opp)) {
      choices.push({ kind: 'attack', attackerId: minion.instanceId, targetId });
    }
  }

  choices.push({ kind: 'endTurn' });
  return choices;
}

function encodeChoice(choice: HearthstoneChoice): string {
  switch (choice.kind) {
    case 'play':
      return `play:${choice.cardInstanceId}:${choice.targetId ?? '-'}`;
    case 'heroPower':
      return `heroPower:${choice.targetId}`;
    case 'attack':
      return `attack:${choice.attackerId}->${choice.targetId}`;
    case 'endTurn':
      return 'endTurn';
    default: {
      const exhaustive: never = choice;
      throw new Error(`encodeChoice: unhandled choice ${JSON.stringify(exhaustive)}`);
    }
  }
}

function applyChoice(state: HearthstoneState, choice: HearthstoneChoice): HearthstoneState {
  const decision = currentDecision(state);
  if (!decision) throw new Error('applyChoice: game is already over');
  const legal = getLegalChoices(state);
  if (!legal.some((candidate) => encodeChoice(candidate) === encodeChoice(choice))) {
    throw new Error(`applyChoice: ${encodeChoice(choice)} is not a legal choice`);
  }
  switch (choice.kind) {
    case 'play':
      return applyPlay(state, choice);
    case 'heroPower':
      return applyHeroPower(state, choice.targetId);
    case 'attack':
      return applyAttack(state, choice.attackerId, choice.targetId);
    case 'endTurn':
      return startNextTurn(state);
    default: {
      const exhaustive: never = choice;
      throw new Error(`applyChoice: unhandled choice ${JSON.stringify(exhaustive)}`);
    }
  }
}

function getObservation(state: HearthstoneState, viewer: PlayerId): HearthstoneObservation {
  const me = getPlayer(state, viewer);
  const opp = getPlayer(state, otherPlayer(viewer));
  return {
    self: viewer,
    active: state.active,
    turnNumber: state.turnNumber,
    myHero: me.hero,
    myMana: { current: me.manaCurrent, max: me.manaMax },
    myHeroPowerUsed: me.heroPowerUsed,
    myHand: me.hand,
    myBoard: me.board,
    myDeckSize: me.deck.length,
    myFatigue: me.fatigue,
    myGraveyard: me.graveyard,
    opponentHero: opp.hero,
    opponentMana: { current: opp.manaCurrent, max: opp.manaMax },
    opponentHeroPowerUsed: opp.heroPowerUsed,
    opponentBoard: opp.board,
    opponentHandSize: opp.hand.length,
    opponentDeckSize: opp.deck.length,
    opponentFatigue: opp.fatigue,
    opponentGraveyard: opp.graveyard,
  };
}

function getOutcome(state: HearthstoneState): Outcome | null {
  if (currentDecision(state) !== null) return null;
  const health0 = getPlayer(state, 0).hero.health;
  const health1 = getPlayer(state, 1).hero.health;
  const scores = [Math.max(0, health0), Math.max(0, health1)];
  const dead0 = health0 <= 0;
  const dead1 = health1 <= 0;
  let winners: PlayerId[];
  if (dead0 && dead1) winners = [0, 1];
  else if (dead0) winners = [1];
  else if (dead1) winners = [0];
  else if (health0 === health1) winners = [0, 1];
  else winners = health0 > health1 ? [0] : [1];
  return { scores, winners };
}

/**
 * IS-MCTS determinization hook (docs/FIX-BACKLOG.md P4, contract/types.ts's
 * `GameAdapter.sampleStateFromObservation` doc comment). Hearthstone's
 * hidden structure differs from both splendor (perfect information — every
 * zone public) and dominion (anonymous multiset cards, needing an explicit
 * `deckComposition` field, src/reference/dominion.ts's own doc comment):
 * every card here carries a globally unique, *deterministic* instanceId
 * (`buildDeck`'s `p{playerIndex}-{defId}-{copy}` scheme, fixed by the mirror
 * deck's card pool — independent of the game's random seed, which only ever
 * controls shuffle order). That determinism means each side's full 24-card
 * instance universe can be reconstructed directly from `buildDeck(player)`
 * without needing any extra composition bookkeeping in the observation.
 *
 * What is preserved byte-for-byte (the viewer already knows all of it):
 *   - own hero health, own mana, own heroPowerUsed, own hand (full
 *     CardInstance list), own board (full MinionInstance list with exact
 *     stats)
 *   - opponent hero health/mana/heroPowerUsed, opponent board (minions are
 *     summoned face-up — always public in this adapter)
 *   - both players' graveyards (`myGraveyard`/`opponentGraveyard`) — a
 *     played spell or a minion's death is an observable public event, same
 *     "public zone" rationale as dominion's `trash` (P4 note: without it,
 *     dead/played cards would get silently miscounted back into a hidden
 *     pool, corrupting the conservation check below)
 *   - `active`/`turnNumber` and both sides' `fatigue` counters — directly
 *     observable bookkeeping, not hidden information
 *
 * What gets resampled (the only things the viewer truly does not know):
 *   - the viewer's own deck *order*: composition is fully knowable (their
 *     own fixed instance universe minus hand/board/graveyard) but a real
 *     player doesn't see their own future draws, so it's reshuffled fresh
 *     per determinization — same reasoning, and the same information-leak
 *     concern (IS-MCTS peeking at its own future draws) as dominion's
 *     own-deck reshuffle.
 *   - the opponent's hand + deck, both composition and order: resolved
 *     together as a single pool by conservation (opponent's full 24-instance
 *     universe minus their known public zones — board + graveyard) — mirrors
 *     `hiddenInfoProbe` below and dominion's opponent-pool derivation, since
 *     a viewer cannot distinguish "in opponent's hand" from "in opponent's
 *     deck" for any specific unseen card, only the aggregate pool those two
 *     zones share.
 *
 * `viewer` governs only *where* the reconstructed data lands in the
 * returned state's `players` tuple, never which cards belong to "own" vs
 * "opponent" — that is always `observation.self` (the true owner baked into
 * the observation itself by `getObservation`), independent of whatever
 * `viewer` a caller passes in. This matters for `ismcts.ts`'s `detectViewer`
 * probe, which deliberately calls this function with the *wrong* candidate
 * player to rule it out via a failed `getObservation` round-trip — if the
 * own/opponent instance-id universes were derived from `viewer` instead,
 * a wrong-candidate probe would try to reconcile the wrong player's
 * `p{viewer}-*` id namespace against `observation.myHand`'s actual
 * `p{self}-*` ids and throw instead of just producing a (correctly)
 * non-matching state.
 */
function sampleStateFromObservation(observation: HearthstoneObservation, viewer: PlayerId, rng: Rng): HearthstoneState {
  const selfPlayer = observation.self;
  const opponentOfSelf = otherPlayer(selfPlayer);

  function idsOf(cards: readonly { readonly instanceId: string }[]): Set<string> {
    return new Set(cards.map((c) => c.instanceId));
  }

  // --- own deck: full 24-card universe minus hand/board/graveyard, order resampled.
  const ownUniverse = buildDeck(selfPlayer);
  const ownKnown = new Set<string>([
    ...idsOf(observation.myHand),
    ...idsOf(observation.myBoard),
    ...idsOf(observation.myGraveyard),
  ]);
  const ownDeckInstances = ownUniverse.filter((c) => !ownKnown.has(c.instanceId));
  if (ownDeckInstances.length !== observation.myDeckSize) {
    throw new Error(
      `sampleStateFromObservation: own deck reconstruction has ${ownDeckInstances.length} cards but ` +
        `myDeckSize reports ${observation.myDeckSize} — observation is internally inconsistent.`,
    );
  }
  const ownDeck = shuffled(ownDeckInstances, rng.fork('hearthstone-determinize-own-deck'));

  // --- opponent hand+deck pool: full universe minus known public zones (board + graveyard).
  const opponentUniverse = buildDeck(opponentOfSelf);
  const opponentKnown = new Set<string>([...idsOf(observation.opponentBoard), ...idsOf(observation.opponentGraveyard)]);
  const opponentPool = opponentUniverse.filter((c) => !opponentKnown.has(c.instanceId));
  const expectedPoolSize = observation.opponentHandSize + observation.opponentDeckSize;
  if (opponentPool.length !== expectedPoolSize) {
    throw new Error(
      `sampleStateFromObservation: opponent hidden pool reconstruction has ${opponentPool.length} cards but ` +
        `observation reports handSize+deckSize=${expectedPoolSize} — observation is internally inconsistent.`,
    );
  }
  const shuffledPool = shuffled(opponentPool, rng.fork('hearthstone-determinize-opponent'));
  const opponentHand = shuffledPool.slice(0, observation.opponentHandSize);
  const opponentDeck = shuffledPool.slice(observation.opponentHandSize);

  const players: [HearthstonePlayerState, HearthstonePlayerState] = [
    { hero: { health: 0 }, hand: [], deck: [], board: [], manaMax: 0, manaCurrent: 0, fatigue: 0, heroPowerUsed: false, graveyard: [] },
    { hero: { health: 0 }, hand: [], deck: [], board: [], manaMax: 0, manaCurrent: 0, fatigue: 0, heroPowerUsed: false, graveyard: [] },
  ];
  players[viewer] = {
    hero: observation.myHero,
    hand: observation.myHand,
    deck: ownDeck,
    board: observation.myBoard,
    manaMax: observation.myMana.max,
    manaCurrent: observation.myMana.current,
    fatigue: observation.myFatigue,
    heroPowerUsed: observation.myHeroPowerUsed,
    graveyard: observation.myGraveyard,
  };
  players[otherPlayer(viewer)] = {
    hero: observation.opponentHero,
    hand: opponentHand,
    deck: opponentDeck,
    board: observation.opponentBoard,
    manaMax: observation.opponentMana.max,
    manaCurrent: observation.opponentMana.current,
    fatigue: observation.opponentFatigue,
    heroPowerUsed: observation.opponentHeroPowerUsed,
    graveyard: observation.opponentGraveyard,
  };

  return {
    players,
    active: observation.active,
    turnNumber: observation.turnNumber,
    gameOver: false,
    // Content-coverage bookkeeping only (see `exercisedContent`), not read by
    // any legality/gameplay logic — safe to reset for a determinization that
    // only ever exists for the duration of one search simulation (same
    // rationale as dominion's `playedKingdom` reset in its own
    // `sampleStateFromObservation`).
    playedCardIds: [],
    usedHeroPower: false,
  };
}

// --- Invariants -------------------------------------------------------

function noDuplicateInstanceIdsInvariant(state: HearthstoneState): string | null {
  const seen = new Set<string>();
  for (const p of state.players) {
    for (const c of [...p.hand, ...p.deck, ...p.graveyard]) {
      if (seen.has(c.instanceId)) return `duplicate card instance ${c.instanceId} found in hand/deck/graveyard`;
      seen.add(c.instanceId);
    }
    for (const m of p.board) {
      if (seen.has(m.instanceId)) return `duplicate instance ${m.instanceId} found on board`;
      seen.add(m.instanceId);
    }
  }
  return null;
}

function manaBoundsInvariant(state: HearthstoneState): string | null {
  for (const p of state.players) {
    if (p.manaMax < 0 || p.manaMax > MAX_MANA) return `manaMax out of bounds: ${p.manaMax}`;
    if (p.manaCurrent < 0 || p.manaCurrent > p.manaMax) {
      return `manaCurrent ${p.manaCurrent} out of bounds for manaMax ${p.manaMax}`;
    }
  }
  return null;
}

function boardSizeInvariant(state: HearthstoneState): string | null {
  for (const p of state.players) {
    if (p.board.length > MAX_BOARD_SIZE) return `board exceeds cap of ${MAX_BOARD_SIZE} minions`;
  }
  return null;
}

function handSizeInvariant(state: HearthstoneState): string | null {
  for (const p of state.players) {
    if (p.hand.length > MAX_HAND_SIZE) return `hand exceeds cap of ${MAX_HAND_SIZE} cards`;
  }
  return null;
}

function heroHealthCeilingInvariant(state: HearthstoneState): string | null {
  for (const p of state.players) {
    if (p.hero.health > STARTING_HERO_HEALTH) {
      return `hero health ${p.hero.health} exceeds starting max ${STARTING_HERO_HEALTH}`;
    }
  }
  return null;
}

// --- Content coverage ---------------------------------------------------

function exercisedContent(finalState: HearthstoneState): readonly string[] {
  const ids = new Set(finalState.playedCardIds);
  if (finalState.usedHeroPower) ids.add('hero-power');
  return [...ids];
}

const contentInventory = [
  ...CARD_DEFS.map((def) => ({
    id: def.id,
    description:
      def.kind === 'minion'
        ? `${def.cost}-mana ${def.attack}/${def.health} minion "${def.name}"`
        : `${def.cost}-mana spell "${def.name}"`,
  })),
  { id: 'hero-power', description: `${HERO_POWER_COST}-mana hero power dealing ${HERO_POWER_DAMAGE} damage to a target character` },
];

// --- Hidden information -------------------------------------------------

function sameCardSequence(a: readonly CardInstance[], b: readonly CardInstance[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((card, index) => b[index] !== undefined && card.instanceId === b[index]!.instanceId);
}

const hiddenInfoProbe: HiddenInfoProbe<HearthstoneState> = {
  mutateHidden(state, viewer, rng) {
    const opponentPlayer = otherPlayer(viewer);
    const opp = getPlayer(state, opponentPlayer);
    const pool = [...opp.hand, ...opp.deck];
    if (pool.length <= 1) {
      // 0 or 1 hidden cards: no reshuffle can change anything meaningful.
      return null;
    }
    let shuffledPool = shuffled(pool, rng);
    if (sameCardSequence(shuffledPool, pool)) {
      const swapped = shuffledPool.slice();
      const first = swapped[0];
      const second = swapped[1];
      if (first !== undefined && second !== undefined) {
        swapped[0] = second;
        swapped[1] = first;
      }
      shuffledPool = swapped;
    }
    const newHand = shuffledPool.slice(0, opp.hand.length);
    const newDeck = shuffledPool.slice(opp.hand.length);
    return withPlayerState(state, opponentPlayer, { ...opp, hand: newHand, deck: newDeck });
  },
};

// --- Baselines ------------------------------------------------------------

const randomBaseline: BotFactory<HearthstoneObservation, HearthstoneChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'hearthstone-random',
    decide(_decisionPoint, _observation, legal) {
      return legal[rng.nextInt(legal.length)] as HearthstoneChoice;
    },
  };
};

function findMinion(board: readonly MinionInstance[], instanceId: string): MinionInstance | undefined {
  return board.find((m) => m.instanceId === instanceId);
}

function handDefId(observation: HearthstoneObservation, cardInstanceId: string): string | undefined {
  return observation.myHand.find((c) => c.instanceId === cardInstanceId)?.defId;
}

function attackerStats(observation: HearthstoneObservation, attackerId: string): MinionInstance | undefined {
  return findMinion(observation.myBoard, attackerId);
}

function heuristicPick(
  _decisionPoint: string,
  observation: HearthstoneObservation,
  legal: readonly HearthstoneChoice[],
): HearthstoneChoice {
  const enemyPlayer = otherPlayer(observation.self);

  const lethal = legal.find((c) => {
    if (c.kind !== 'attack' || !isHeroTargetFor(c.targetId, enemyPlayer)) return false;
    const attacker = attackerStats(observation, c.attackerId);
    return attacker !== undefined && attacker.attack >= observation.opponentHero.health;
  });
  if (lethal) return lethal;

  const plays = legal.filter((c): c is Extract<HearthstoneChoice, { kind: 'play' }> => c.kind === 'play');
  if (plays.length > 0) {
    const byCost = plays
      .map((c) => ({ choice: c, cost: CARD_DEFS_BY_ID.get(handDefId(observation, c.cardInstanceId) ?? '')?.cost ?? 0 }))
      .sort((a, b) => b.cost - a.cost || (a.choice.cardInstanceId < b.choice.cardInstanceId ? -1 : 1));
    return byCost[0]!.choice;
  }

  const heroPowers = legal.filter((c): c is Extract<HearthstoneChoice, { kind: 'heroPower' }> => c.kind === 'heroPower');
  if (heroPowers.length > 0) {
    return heroPowers.find((c) => isHeroTargetFor(c.targetId, enemyPlayer)) ?? (heroPowers[0] as HearthstoneChoice);
  }

  const attacks = legal.filter((c): c is Extract<HearthstoneChoice, { kind: 'attack' }> => c.kind === 'attack');
  if (attacks.length > 0) {
    const goodTrades = attacks.filter((c) => {
      const target = findMinion(observation.opponentBoard, c.targetId);
      if (!target) return false;
      const attacker = attackerStats(observation, c.attackerId);
      if (!attacker) return false;
      return attacker.attack >= target.health && target.attack < attacker.health;
    });
    if (goodTrades.length > 0) return goodTrades[0] as HearthstoneChoice;
    const faceAttacks = attacks.filter((c) => isHeroTargetFor(c.targetId, enemyPlayer));
    if (faceAttacks.length > 0) return faceAttacks[0] as HearthstoneChoice;
    return attacks[0] as HearthstoneChoice;
  }

  return (legal.find((c) => c.kind === 'endTurn') ?? legal[0]) as HearthstoneChoice;
}

const heuristicBaseline: BotFactory<HearthstoneObservation, HearthstoneChoice> = (_seed) => {
  return {
    id: 'hearthstone-heuristic',
    decide: heuristicPick,
  };
};

function wrapBotId(bot: GameBot<HearthstoneObservation, HearthstoneChoice>, suffix: string): string {
  return `${bot.id}+${suffix}`;
}

/** Strategy flag: effective. Whenever an attack on the enemy hero is legal, always
 * take it over any minion trade; delegates to base otherwise. */
const faceRush: StrategyFlagSpec<HearthstoneObservation, HearthstoneChoice> = {
  flag: 'faceRush',
  description: 'Whenever attacking the enemy hero directly is legal, always do that instead of trading with minions.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot, 'faceRush'),
        decide(decisionPoint, observation, legal) {
          const enemyPlayer = otherPlayer(observation.self);
          const faceAttacks = legal.filter(
            (c): c is Extract<HearthstoneChoice, { kind: 'attack' }> =>
              c.kind === 'attack' && isHeroTargetFor(c.targetId, enemyPlayer),
          );
          if (faceAttacks.length > 0) return faceAttacks[0] as HearthstoneChoice;
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/** Strategy flag: marginal. On the fresh action phase, always plays the cheapest
 * affordable card instead of the priciest (opposite of the heuristic baseline's
 * curve-out preference). */
const curveDump: StrategyFlagSpec<HearthstoneObservation, HearthstoneChoice> = {
  flag: 'curveDump',
  description: 'Whenever a play choice is legal, always play the cheapest affordable card instead of the priciest.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot, 'curveDump'),
        decide(decisionPoint, observation, legal) {
          const plays = legal.filter((c): c is Extract<HearthstoneChoice, { kind: 'play' }> => c.kind === 'play');
          if (plays.length > 0) {
            const byCost = plays
              .map((c) => ({ choice: c, cost: CARD_DEFS_BY_ID.get(handDefId(observation, c.cardInstanceId) ?? '')?.cost ?? 0 }))
              .sort((a, b) => a.cost - b.cost || (a.choice.cardInstanceId < b.choice.cardInstanceId ? -1 : 1));
            return byCost[0]!.choice;
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/** Strategy flag: effective. Always uses the hero power on the enemy face
 * whenever it is legal, ahead of any other consideration. */
const heroPowerSpam: StrategyFlagSpec<HearthstoneObservation, HearthstoneChoice> = {
  flag: 'heroPowerSpam',
  description: 'Whenever the hero power is usable, always fire it at the enemy hero before anything else.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot, 'heroPowerSpam'),
        decide(decisionPoint, observation, legal) {
          const enemyPlayer = otherPlayer(observation.self);
          const facePower = legal.find(
            (c): c is Extract<HearthstoneChoice, { kind: 'heroPower' }> =>
              c.kind === 'heroPower' && isHeroTargetFor(c.targetId, enemyPlayer),
          );
          if (facePower) return facePower;
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/**
 * Replay fixtures: random-vs-random self-play, captured by actually running
 * this adapter (see the generation note in
 * src/reference/__tests__/hearthstone.test.ts) and hardcoded here — not
 * hand-simulated.
 */
const replayFixtures: readonly ReplayFixture[] = [
  {
    id: 'hearthstone-2p-seed-11',
    seed: 11,
    choiceKeys: [
      'endTurn', 'endTurn', 'heroPower:hero:1', 'endTurn', 'endTurn', 'play:p0-shattered-sun-cleric-2:-',
      'endTurn', 'endTurn', 'heroPower:hero:1', 'play:p0-river-crocolisk-2:-', 'endTurn',
      'heroPower:p0-shattered-sun-cleric-2', 'play:p1-elven-archer-2:p0-shattered-sun-cleric-2', 'endTurn',
      'heroPower:p1-elven-archer-2', 'play:p0-elven-archer-2:hero:1', 'attack:p0-river-crocolisk-2->hero:1',
      'endTurn', 'play:p1-magma-rager-1:-', 'heroPower:hero:0', 'endTurn', 'heroPower:hero:1',
      'attack:p0-elven-archer-2->hero:1', 'attack:p0-river-crocolisk-2->hero:1', 'play:p0-novice-engineer-1:-',
      'play:p0-river-crocolisk-1:-', 'endTurn', 'attack:p1-magma-rager-1->p0-novice-engineer-1',
      'play:p1-chillwind-yeti-1:-', 'heroPower:p0-river-crocolisk-2', 'endTurn', 'play:p0-war-golem-2:-',
      'attack:p0-elven-archer-2->hero:1', 'attack:p0-river-crocolisk-1->hero:1', 'attack:p0-river-crocolisk-2->hero:1',
      'endTurn', 'play:p1-darkscale-healer-2:-', 'attack:p1-chillwind-yeti-1->p0-river-crocolisk-1',
      'heroPower:p0-river-crocolisk-2', 'endTurn', 'attack:p0-river-crocolisk-2->p1-chillwind-yeti-1',
      'heroPower:hero:1', 'attack:p0-war-golem-2->p1-darkscale-healer-2', 'attack:p0-elven-archer-2->p1-chillwind-yeti-1',
      'play:p0-magma-rager-2:-', 'play:p0-shattered-sun-cleric-1:p0-war-golem-2', 'endTurn', 'endTurn',
      'play:p0-darkscale-healer-2:-', 'play:p0-chillwind-yeti-1:-', 'attack:p0-shattered-sun-cleric-1->hero:1',
      'endTurn', 'heroPower:hero:0', 'play:p1-darkscale-healer-1:-', 'play:p1-river-crocolisk-1:-', 'endTurn',
      'attack:p0-war-golem-2->hero:1', 'play:p0-chillwind-yeti-2:-', 'attack:p0-darkscale-healer-2->p1-river-crocolisk-1',
      'attack:p0-magma-rager-2->hero:1', 'attack:p0-shattered-sun-cleric-1->p1-darkscale-healer-1',
      'attack:p0-chillwind-yeti-1->hero:1',
    ],
    finalScores: [29, 0],
  },
  {
    id: 'hearthstone-2p-seed-22',
    seed: 22,
    choiceKeys: [
      'endTurn', 'endTurn', 'play:p0-spark-bolt-1:hero:1', 'endTurn', 'play:p1-river-crocolisk-1:-', 'endTurn',
      'play:p0-novice-engineer-1:-', 'endTurn', 'endTurn', 'endTurn', 'attack:p1-river-crocolisk-1->hero:0',
      'play:p1-quick-study-1:-', 'endTurn', 'heroPower:hero:1', 'attack:p0-novice-engineer-1->hero:1',
      'play:p0-stonetusk-boar-1:-', 'play:p0-river-crocolisk-2:-', 'attack:p0-stonetusk-boar-1->hero:1', 'endTurn',
      'attack:p1-river-crocolisk-1->hero:0', 'endTurn', 'play:p0-shattered-sun-cleric-1:p0-novice-engineer-1',
      'attack:p0-novice-engineer-1->p1-river-crocolisk-1', 'play:p0-magma-rager-1:-',
      'attack:p0-river-crocolisk-2->hero:1', 'attack:p0-stonetusk-boar-1->hero:1', 'endTurn',
      'play:p1-shattered-sun-cleric-1:p1-river-crocolisk-1', 'heroPower:p0-river-crocolisk-2', 'endTurn',
      'attack:p0-shattered-sun-cleric-1->p1-shattered-sun-cleric-1', 'attack:p0-river-crocolisk-2->hero:1',
      'attack:p0-magma-rager-1->hero:1', 'play:p0-quick-study-2:-', 'attack:p0-stonetusk-boar-1->hero:1',
      'heroPower:hero:1', 'play:p0-elven-archer-2:hero:1', 'endTurn', 'heroPower:p0-elven-archer-2',
      'play:p1-elven-archer-2:p0-stonetusk-boar-1', 'attack:p1-river-crocolisk-1->p0-magma-rager-1',
      'play:p1-river-crocolisk-2:-', 'play:p1-spark-bolt-1:p0-river-crocolisk-2', 'endTurn', 'heroPower:hero:1',
      'play:p0-darkscale-healer-1:-', 'endTurn', 'endTurn', 'play:p0-novice-engineer-2:-',
      'attack:p0-darkscale-healer-1->p1-elven-archer-2', 'play:p0-boulderfist-ogre-1:-', 'endTurn',
      'attack:p1-river-crocolisk-2->p0-novice-engineer-2', 'heroPower:p0-darkscale-healer-1',
      'play:p1-chillwind-yeti-1:-', 'play:p1-stonetusk-boar-2:-', 'play:p1-novice-engineer-2:-', 'endTurn',
      'play:p0-war-golem-2:-', 'heroPower:p1-river-crocolisk-2', 'attack:p0-darkscale-healer-1->p1-stonetusk-boar-2',
      'attack:p0-boulderfist-ogre-1->hero:1', 'endTurn', 'attack:p1-river-crocolisk-2->p0-war-golem-2',
      'play:p1-shattered-sun-cleric-2:p1-chillwind-yeti-1', 'attack:p1-chillwind-yeti-1->p0-war-golem-2',
      'play:p1-elven-archer-1:p0-darkscale-healer-1', 'attack:p1-novice-engineer-2->hero:0',
      'play:p1-boulderfist-ogre-1:-', 'endTurn', 'heroPower:p1-shattered-sun-cleric-2', 'play:p0-chillwind-yeti-2:-',
      'play:p0-quick-study-1:-', 'attack:p0-darkscale-healer-1->p1-boulderfist-ogre-1', 'attack:p0-boulderfist-ogre-1->hero:1',
    ],
    finalScores: [27, 0],
  },
  {
    id: 'hearthstone-2p-seed-33',
    seed: 33,
    choiceKeys: [
      'endTurn', 'endTurn', 'endTurn', 'endTurn', 'heroPower:hero:1', 'endTurn', 'endTurn', 'play:p0-magma-rager-1:-',
      'endTurn', 'play:p1-spark-bolt-2:p0-magma-rager-1', 'play:p1-stonetusk-boar-2:-', 'endTurn',
      'play:p0-chillwind-yeti-1:-', 'endTurn', 'play:p1-quick-study-2:-', 'heroPower:p0-chillwind-yeti-1',
      'attack:p1-stonetusk-boar-2->hero:0', 'endTurn', 'attack:p0-chillwind-yeti-1->p1-stonetusk-boar-2', 'endTurn',
      'play:p1-novice-engineer-1:-', 'play:p1-spark-bolt-1:hero:0', 'play:p1-river-crocolisk-2:-', 'endTurn',
      'play:p0-boulderfist-ogre-1:-', 'endTurn', 'play:p1-quick-study-1:-', 'play:p1-elven-archer-2:p0-boulderfist-ogre-1',
      'play:p1-shattered-sun-cleric-2:p1-river-crocolisk-2', 'attack:p1-river-crocolisk-2->p0-chillwind-yeti-1',
      'attack:p1-novice-engineer-1->hero:0', 'endTurn', 'play:p0-river-crocolisk-2:-',
      'attack:p0-boulderfist-ogre-1->p1-elven-archer-2', 'heroPower:p1-shattered-sun-cleric-2',
      'play:p0-novice-engineer-1:-', 'endTurn', 'heroPower:p0-novice-engineer-1', 'attack:p1-novice-engineer-1->p0-boulderfist-ogre-1',
      'play:p1-novice-engineer-2:-', 'attack:p1-shattered-sun-cleric-2->hero:0', 'play:p1-chillwind-yeti-2:-', 'endTurn',
      'play:p0-boulderfist-ogre-2:-', 'play:p0-quick-study-2:-', 'attack:p0-boulderfist-ogre-1->p1-novice-engineer-2',
      'endTurn', 'endTurn', 'play:p0-elven-archer-2:p1-shattered-sun-cleric-2', 'attack:p0-river-crocolisk-2->hero:1',
      'heroPower:hero:1', 'play:p0-darkscale-healer-2:-', 'attack:p0-boulderfist-ogre-2->hero:1', 'endTurn',
      'play:p1-elven-archer-1:p0-boulderfist-ogre-2', 'attack:p1-chillwind-yeti-2->p0-boulderfist-ogre-1',
      'play:p1-war-golem-1:-', 'heroPower:p0-boulderfist-ogre-2', 'endTurn', 'attack:p0-boulderfist-ogre-2->p1-elven-archer-1',
      'play:p0-shattered-sun-cleric-2:p0-elven-archer-2', 'attack:p0-elven-archer-2->hero:1',
      'attack:p0-darkscale-healer-2->p1-war-golem-1', 'heroPower:p1-war-golem-1', 'play:p0-magma-rager-2:-', 'endTurn',
      'heroPower:p0-boulderfist-ogre-2', 'play:p1-darkscale-healer-2:-', 'play:p1-stonetusk-boar-1:-',
      'attack:p1-stonetusk-boar-1->p0-boulderfist-ogre-2', 'attack:p1-war-golem-1->p0-shattered-sun-cleric-2', 'endTurn',
      'attack:p0-magma-rager-2->hero:1', 'heroPower:p1-darkscale-healer-2', 'attack:p0-river-crocolisk-2->hero:1',
      'play:p0-war-golem-2:-', 'attack:p0-boulderfist-ogre-2->hero:1', 'play:p0-elven-archer-1:hero:1',
      'attack:p0-elven-archer-2->p1-darkscale-healer-2', 'endTurn', 'play:p1-chillwind-yeti-1:-',
      'attack:p1-darkscale-healer-2->hero:0', 'heroPower:p0-magma-rager-2', 'endTurn', 'play:p0-stonetusk-boar-1:-',
      'attack:p0-stonetusk-boar-1->p1-darkscale-healer-2', 'attack:p0-elven-archer-1->p1-darkscale-healer-2',
      'attack:p0-war-golem-2->p1-chillwind-yeti-1', 'heroPower:hero:1', 'endTurn', 'heroPower:p0-boulderfist-ogre-2',
      'play:p1-war-golem-2:-', 'endTurn', 'heroPower:hero:1', 'play:p0-darkscale-healer-1:-',
      'play:p0-novice-engineer-2:-', 'attack:p0-river-crocolisk-2->p1-war-golem-2', 'play:p0-stonetusk-boar-2:-',
      'attack:p0-stonetusk-boar-2->hero:1', 'attack:p0-war-golem-2->hero:1',
    ],
    finalScores: [23, 0],
  },
];

export const hearthstoneAdapter: GameAdapter<HearthstoneState, HearthstoneObservation, HearthstoneChoice> = {
  spec: {
    gameId: 'hearthstone-mirror-2p',
    playerCount: 2,
    decisionPoints: [
      {
        id: 'action',
        description: 'Play a card, use the hero power, attack with a minion, or end the turn.',
      },
    ],
    seatingPlan: [
      [0, 1],
      [1, 0],
    ],
    maxDecisionsPerGame: 500,
  },
  createInitialState,
  currentDecision,
  getObservation,
  getLegalChoices,
  applyChoice,
  getOutcome,
  encodeChoice,
  sampleStateFromObservation,
  invariants: [
    noDuplicateInstanceIdsInvariant,
    manaBoundsInvariant,
    boardSizeInvariant,
    handSizeInvariant,
    heroHealthCeilingInvariant,
  ],
  contentInventory,
  exercisedContent,
  hiddenInfoProbe,
  replayFixtures,
  baselines: {
    random: randomBaseline,
    heuristic: heuristicBaseline,
  },
  strategySurface: [faceRush, curveDump, heroPowerSpam],
};
