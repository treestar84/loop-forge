/**
 * catan — reference GameAdapter implementation (headless onboarding of
 * "Settlers of Catan", standard 4-player base rules, core scope only).
 *
 * Structural reference: rpjohnst/catan (github.com/rpjohnst/catan, license
 * unstated in the repository) was consulted only for how a headless engine
 * for this game is typically shaped (hex-board data model, turn/phase
 * machine) — no code from that project was copied; the rules below are
 * reimplemented from scratch against the publicly standardized "Settlers of
 * Catan" base rules. See docs/CREDITS.md.
 *
 * Scope reduction (deliberate, documented per docs/ONBOARDING-GUIDE.md §7
 * "협상·거래 게임 (카탄류)"):
 *   - Player-to-player negotiation/trading is entirely out of scope. Only
 *     bank trades (4:1) are modeled as a decision point. Free-form offers are
 *     the kind of unstructured action space the guide explicitly excludes;
 *     discretized peer offers are a roadmap item, not implemented here.
 *   - Ports are NOT implemented (no 3:1 or 2:1 harbor trades) — every trade
 *     with the bank is 4:1. This narrows the scope further than the port
 *     rules would otherwise require and is called out here and in
 *     docs/CREDITS.md.
 *   - Development cards (knight/progress/victory-point cards) are NOT
 *     implemented. Longest Road and Largest Army bonuses are therefore also
 *     absent (they depend on development cards / would otherwise need a
 *     separate road-length computation this pass doesn't need). Victory
 *     points come from settlements (1) and cities (2) only.
 *   - Victory threshold is lowered to 8 points (vs. the official 10) —
 *     without development-card victory points and the two 2-point bonuses,
 *     10 would take unrealistically long for a first onboarding pass; 8 is a
 *     starting point to be revisited once real throughput/game-length data
 *     is measured (see the runner's report).
 *
 * Board: the classic 19-hex / 54-vertex / 72-edge Catan board topology is
 * FIXED (only which resource+number token lands on which hex position is
 * randomized per seed) — this file computes that fixed graph once at module
 * load from hex axial coordinates using plain trigonometry (Math.cos/sin/sqrt
 * are pure functions, not banned by the C1 determinism rule — only
 * Date.now()/Math.random() are). A self-check throws if the computed vertex
 * (54) / edge (72) counts don't match the known-correct values, so a
 * geometry bug fails loudly at import time rather than silently producing a
 * malformed board.
 *
 * Hidden information: a player's own hand is exact; opponents' hands are
 * exposed only as a card COUNT (never composition) — this matches real
 * Catan, where hand contents are secret but the board (every settlement,
 * city, and road) is fully public. `hiddenInfoProbe` redistributes the
 * pooled, unseen opponent cards while preserving each opponent's total hand
 * size, which is exactly what `getObservation` exposes and therefore must
 * stay invariant under the probe.
 *
 * Turn / multistep-turn modeling (ONBOARDING-GUIDE.md §2 "멀티스텝 턴"):
 * one active-player turn is a state machine with its own `phase` field
 * (separate from the decision-point id), covering: dice roll (internal,
 * automatic — not a decision), discard-on-7 (decisionPoint 'discardHalf',
 * one card at a time, forced count = floor(handSize/2)), robber move + steal
 * (decisionPoint 'moveRobberAndSteal'), the build sub-phase (decisionPoint
 * 'build': any number of settlement/city/road purchases, or move on to
 * trading), and the bank-trade sub-phase (decisionPoint 'bankTrade': any
 * number of 4:1 trades, or end the turn). The build→trade transition is
 * one-directional per turn (no going back to building after entering trade)
 * — a simplification that still exercises both decision points every turn
 * without needing a third "which sub-phase am I in" toggle choice.
 *
 * Stalemate safety net (ONBOARDING-GUIDE.md §1: verify a real end-guarantee
 * exists, don't trust the source blindly): the official rules have no formal
 * turn cap, but a purely rule-following headless implementation with no
 * player negotiation could in principle stall well short of 8 points if the
 * board/seed is unlucky. TURN_CAP forces the game to end (score-leader wins,
 * ties broken by lowest seat id) after TURN_CAP total turns, exactly like
 * dominion.ts's TURN_CAP pattern.
 */

import type {
  BotFactory,
  GameAdapter,
  HiddenInfoProbe,
  Outcome,
  PendingDecision,
  PlayerId,
  ReplayFixture,
  StrategyFlagSpec,
} from '../contract/types';
import { createRng, shuffled } from '../kernel/rng';

// -----------------------------------------------------------------------
// Board geometry — fixed 19-hex / 54-vertex / 72-edge topology, computed
// once at module load. Only the resource/number assignment to hex ids is
// randomized (in createInitialState); the graph itself never changes.
// -----------------------------------------------------------------------

interface Axial {
  readonly q: number;
  readonly r: number;
}

const HEX_COORDS: readonly Axial[] = (() => {
  const coords: Axial[] = [];
  for (let q = -2; q <= 2; q += 1) {
    for (let r = -2; r <= 2; r += 1) {
      const x = q;
      const z = r;
      const y = -x - z;
      if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) <= 2) {
        coords.push({ q, r });
      }
    }
  }
  return coords;
})();

function axialToPixel(a: Axial): { x: number; y: number } {
  return {
    x: Math.sqrt(3) * a.q + (Math.sqrt(3) / 2) * a.r,
    y: 1.5 * a.r,
  };
}

function hexCorner(center: { x: number; y: number }, i: number): { x: number; y: number } {
  const angleDeg = 60 * i - 30;
  const angleRad = (Math.PI / 180) * angleDeg;
  return { x: center.x + Math.cos(angleRad), y: center.y + Math.sin(angleRad) };
}

function vertexKey(p: { x: number; y: number }): string {
  return `${Math.round(p.x * 1000)}:${Math.round(p.y * 1000)}`;
}

const HEX_VERTICES: number[][] = [];
const VERTEX_HEXES: number[][] = [];
{
  const keyToId = new Map<string, number>();
  HEX_COORDS.forEach((coord, hexId) => {
    const center = axialToPixel(coord);
    const verts: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const corner = hexCorner(center, i);
      const key = vertexKey(corner);
      let vid = keyToId.get(key);
      if (vid === undefined) {
        vid = VERTEX_HEXES.length;
        keyToId.set(key, vid);
        VERTEX_HEXES.push([]);
      }
      verts.push(vid);
      const hexList = VERTEX_HEXES[vid] as number[];
      if (!hexList.includes(hexId)) hexList.push(hexId);
    }
    HEX_VERTICES.push(verts);
  });
}

const VERTEX_COUNT = VERTEX_HEXES.length;

const EDGE_VERTICES: [number, number][] = [];
const HEX_EDGES: number[][] = [];
{
  const keyToId = new Map<string, number>();
  HEX_COORDS.forEach((_coord, hexId) => {
    const verts = HEX_VERTICES[hexId] as number[];
    const edges: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const a = verts[i] as number;
      const b = verts[(i + 1) % 6] as number;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      let eid = keyToId.get(key);
      if (eid === undefined) {
        eid = EDGE_VERTICES.length;
        keyToId.set(key, eid);
        EDGE_VERTICES.push(a < b ? [a, b] : [b, a]);
      }
      edges.push(eid);
    }
    HEX_EDGES.push(edges);
  });
}

const EDGE_COUNT = EDGE_VERTICES.length;

if (VERTEX_COUNT !== 54 || EDGE_COUNT !== 72) {
  throw new Error(
    `catan board geometry self-check failed: computed ${VERTEX_COUNT} vertices / ${EDGE_COUNT} edges, expected 54 / 72`,
  );
}

const VERTEX_EDGES: number[][] = Array.from({ length: VERTEX_COUNT }, () => []);
EDGE_VERTICES.forEach(([a, b], eid) => {
  (VERTEX_EDGES[a] as number[]).push(eid);
  (VERTEX_EDGES[b] as number[]).push(eid);
});

const VERTEX_NEIGHBORS: number[][] = Array.from({ length: VERTEX_COUNT }, () => []);
EDGE_VERTICES.forEach(([a, b]) => {
  (VERTEX_NEIGHBORS[a] as number[]).push(b);
  (VERTEX_NEIGHBORS[b] as number[]).push(a);
});

// -----------------------------------------------------------------------
// Game constants
// -----------------------------------------------------------------------

export type Resource = 'brick' | 'wood' | 'sheep' | 'wheat' | 'ore';
export type TileResource = Resource | 'desert';

const RESOURCES: readonly Resource[] = ['brick', 'wood', 'sheep', 'wheat', 'ore'];
const PLAYER_COUNT = 4;
const ALL_SEATS: readonly PlayerId[] = [0, 1, 2, 3];

// Standard 19-tile resource mix: 3 hills(brick)/4 forest(wood)/4 pasture(sheep)/
// 4 fields(wheat)/3 mountains(ore)/1 desert.
const TILE_BAG: readonly TileResource[] = [
  ...Array(3).fill('brick' as const),
  ...Array(4).fill('wood' as const),
  ...Array(4).fill('sheep' as const),
  ...Array(4).fill('wheat' as const),
  ...Array(3).fill('ore' as const),
  'desert',
];

// Standard 18 number tokens for the 18 non-desert hexes.
const NUMBER_BAG: readonly number[] = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

// Standard 19-card-per-resource bank (95 resource cards total).
const BANK_START = 19;

const SETTLEMENT_COST: Readonly<Record<Resource, number>> = { brick: 1, wood: 1, sheep: 1, wheat: 1, ore: 0 };
const CITY_COST: Readonly<Record<Resource, number>> = { brick: 0, wood: 0, sheep: 0, wheat: 2, ore: 3 };
const ROAD_COST: Readonly<Record<Resource, number>> = { brick: 1, wood: 1, sheep: 0, wheat: 0, ore: 0 };

const MAX_SETTLEMENTS = 5;
const MAX_CITIES = 4;
const MAX_ROADS = 15;
const VICTORY_POINTS = 8;
const TURN_CAP = 300;

type ResHand = Readonly<Record<Resource, number>>;

function freshHand(): Record<Resource, number> {
  return { brick: 0, wood: 0, sheep: 0, wheat: 0, ore: 0 };
}

function totalHand(hand: ResHand): number {
  return RESOURCES.reduce((sum, r) => sum + hand[r], 0);
}

function handOf(hands: readonly [ResHand, ResHand, ResHand, ResHand], player: PlayerId): ResHand {
  return hands[player] as ResHand;
}

function handsEqual(a: ResHand, b: ResHand): boolean {
  return RESOURCES.every((r) => a[r] === b[r]);
}

function pipCount(n: number | null): number {
  if (n === null) return 0;
  return 6 - Math.abs(7 - n);
}

// -----------------------------------------------------------------------
// State / observation / choice types
// -----------------------------------------------------------------------

export interface Building {
  readonly owner: PlayerId;
  readonly type: 'settlement' | 'city';
}

export interface CatanState {
  readonly seed: number;
  /** Indexed by hex id 0..18 (fixed HEX_COORDS order). */
  readonly tiles: readonly { readonly resource: TileResource; readonly number: number | null }[];
  readonly robberHex: number;
  /** Indexed by vertex id 0..53. */
  readonly buildings: readonly (Building | null)[];
  /** Indexed by edge id 0..71; value is the owning player, or null if unbuilt. */
  readonly roads: readonly (PlayerId | null)[];
  readonly hands: readonly [ResHand, ResHand, ResHand, ResHand];
  readonly bank: ResHand;
  readonly active: PlayerId;
  readonly turnNumber: number;
  readonly phase: 'initial' | 'build' | 'trade' | 'discard' | 'robber' | 'done';
  readonly initialRound: 1 | 2;
  readonly initialQueue: readonly PlayerId[];
  readonly initialSubStep: 'settlement' | 'road' | null;
  readonly lastInitialSettlement: number | null;
  readonly pendingDiscarders: readonly PlayerId[];
  readonly discardRemaining: number | null;
  readonly winner: PlayerId | null;
}

export interface CatanObservation {
  readonly self: PlayerId;
  readonly active: PlayerId;
  readonly phase: CatanState['phase'];
  readonly turnNumber: number;
  readonly tiles: CatanState['tiles'];
  readonly robberHex: number;
  readonly buildings: CatanState['buildings'];
  readonly roads: CatanState['roads'];
  readonly bank: ResHand;
  readonly ownHand: ResHand;
  readonly opponentHandCounts: ReadonlyArray<{ readonly player: PlayerId; readonly count: number }>;
  readonly scores: readonly number[];
  readonly pendingDiscarders: readonly PlayerId[];
  readonly discardRemaining: number | null;
  readonly lastInitialSettlement: number | null;
  readonly winner: PlayerId | null;
}

export type CatanChoice =
  | { readonly kind: 'placeSettlement'; readonly vertex: number }
  | { readonly kind: 'placeRoad'; readonly edge: number }
  | { readonly kind: 'buildSettlement'; readonly vertex: number }
  | { readonly kind: 'buildCity'; readonly vertex: number }
  | { readonly kind: 'buildRoad'; readonly edge: number }
  | { readonly kind: 'toTrade' }
  | { readonly kind: 'bankTrade'; readonly give: Resource; readonly get: Resource }
  | { readonly kind: 'endTurn' }
  | { readonly kind: 'discard'; readonly resource: Resource }
  | { readonly kind: 'moveRobberAndSteal'; readonly hex: number; readonly target: PlayerId | null };

// -----------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------

function createInitialState(seed: number): CatanState {
  const rng = createRng(seed);
  const tileBag = shuffled(TILE_BAG, rng.fork('tiles'));
  const numberBag = shuffled(NUMBER_BAG, rng.fork('numbers'));
  let numIdx = 0;
  const tiles = tileBag.map((resource) => {
    if (resource === 'desert') return { resource, number: null };
    const number = numberBag[numIdx] as number;
    numIdx += 1;
    return { resource, number };
  });
  const desertHex = tiles.findIndex((t) => t.resource === 'desert');
  return {
    seed,
    tiles,
    robberHex: desertHex,
    buildings: Array.from({ length: VERTEX_COUNT }, () => null),
    roads: Array.from({ length: EDGE_COUNT }, () => null),
    hands: [freshHand(), freshHand(), freshHand(), freshHand()],
    bank: { brick: BANK_START, wood: BANK_START, sheep: BANK_START, wheat: BANK_START, ore: BANK_START },
    active: 0,
    turnNumber: 0,
    phase: 'initial',
    initialRound: 1,
    initialQueue: [0, 1, 2, 3],
    initialSubStep: 'settlement',
    lastInitialSettlement: null,
    pendingDiscarders: [],
    discardRemaining: null,
    winner: null,
  };
}

// -----------------------------------------------------------------------
// Decisions
// -----------------------------------------------------------------------

function currentDecision(state: CatanState): PendingDecision | null {
  switch (state.phase) {
    case 'initial': {
      const player = state.initialQueue[0];
      if (player === undefined) throw new Error('currentDecision: initial phase with empty queue');
      return { player, decisionPoint: 'buildInitial' };
    }
    case 'build':
      return { player: state.active, decisionPoint: 'build' };
    case 'trade':
      return { player: state.active, decisionPoint: 'bankTrade' };
    case 'discard': {
      const player = state.pendingDiscarders[0];
      if (player === undefined) throw new Error('currentDecision: discard phase with empty queue');
      return { player, decisionPoint: 'discardHalf' };
    }
    case 'robber':
      return { player: state.active, decisionPoint: 'moveRobberAndSteal' };
    case 'done':
      return null;
  }
}

function isVertexFreeForSettlement(state: CatanState, v: number): boolean {
  if (state.buildings[v] !== null) return false;
  for (const n of VERTEX_NEIGHBORS[v] as number[]) {
    if (state.buildings[n] !== null) return false;
  }
  return true;
}

function isVertexConnectedToPlayerRoad(state: CatanState, v: number, player: PlayerId): boolean {
  for (const eid of VERTEX_EDGES[v] as number[]) {
    if (state.roads[eid] === player) return true;
  }
  return false;
}

function isEdgeConnectedToPlayer(state: CatanState, e: number, player: PlayerId): boolean {
  const [a, b] = EDGE_VERTICES[e] as [number, number];
  for (const v of [a, b]) {
    const building = state.buildings[v] as Building | null;
    if (building !== null && building.owner === player) return true;
    for (const adjEdge of VERTEX_EDGES[v] as number[]) {
      if (state.roads[adjEdge] === player) return true;
    }
  }
  return false;
}

function countBuildingsOfType(state: CatanState, player: PlayerId, type: 'settlement' | 'city'): number {
  return state.buildings.filter((b) => b !== null && b.owner === player && b.type === type).length;
}

function countRoadsOf(state: CatanState, player: PlayerId): number {
  return state.roads.filter((r) => r === player).length;
}

function affordAll(hand: ResHand, cost: Readonly<Record<Resource, number>>): boolean {
  return RESOURCES.every((r) => hand[r] >= cost[r]);
}

function legalInitialChoices(state: CatanState): CatanChoice[] {
  if (state.initialSubStep === 'settlement') {
    const choices: CatanChoice[] = [];
    for (let v = 0; v < VERTEX_COUNT; v += 1) {
      if (isVertexFreeForSettlement(state, v)) choices.push({ kind: 'placeSettlement', vertex: v });
    }
    return choices;
  }
  const settlementVertex = state.lastInitialSettlement as number;
  const choices: CatanChoice[] = [];
  for (const eid of VERTEX_EDGES[settlementVertex] as number[]) {
    if (state.roads[eid] === null) choices.push({ kind: 'placeRoad', edge: eid });
  }
  return choices;
}

function legalBuildChoices(state: CatanState): CatanChoice[] {
  const player = state.active;
  const hand = state.hands[player] as ResHand;
  const choices: CatanChoice[] = [{ kind: 'toTrade' }];
  if (affordAll(hand, SETTLEMENT_COST) && countBuildingsOfType(state, player, 'settlement') < MAX_SETTLEMENTS) {
    for (let v = 0; v < VERTEX_COUNT; v += 1) {
      if (isVertexFreeForSettlement(state, v) && isVertexConnectedToPlayerRoad(state, v, player)) {
        choices.push({ kind: 'buildSettlement', vertex: v });
      }
    }
  }
  if (affordAll(hand, CITY_COST) && countBuildingsOfType(state, player, 'city') < MAX_CITIES) {
    for (let v = 0; v < VERTEX_COUNT; v += 1) {
      const b = state.buildings[v] as Building | null;
      if (b !== null && b.owner === player && b.type === 'settlement') {
        choices.push({ kind: 'buildCity', vertex: v });
      }
    }
  }
  if (affordAll(hand, ROAD_COST) && countRoadsOf(state, player) < MAX_ROADS) {
    for (let e = 0; e < EDGE_COUNT; e += 1) {
      if (state.roads[e] === null && isEdgeConnectedToPlayer(state, e, player)) {
        choices.push({ kind: 'buildRoad', edge: e });
      }
    }
  }
  return choices;
}

function legalBankTradeChoices(state: CatanState): CatanChoice[] {
  const player = state.active;
  const hand = state.hands[player] as ResHand;
  const choices: CatanChoice[] = [{ kind: 'endTurn' }];
  for (const give of RESOURCES) {
    if (hand[give] < 4) continue;
    for (const get of RESOURCES) {
      if (get === give) continue;
      if (state.bank[get] > 0) choices.push({ kind: 'bankTrade', give, get });
    }
  }
  return choices;
}

function legalDiscardChoices(state: CatanState): CatanChoice[] {
  const player = state.pendingDiscarders[0] as PlayerId;
  const hand = state.hands[player] as ResHand;
  return RESOURCES.filter((r) => hand[r] > 0).map((resource) => ({ kind: 'discard', resource }) as const);
}

function legalRobberChoices(state: CatanState): CatanChoice[] {
  const player = state.active;
  const choices: CatanChoice[] = [];
  for (let hex = 0; hex < HEX_COORDS.length; hex += 1) {
    if (hex === state.robberHex) continue;
    const victims = new Set<PlayerId>();
    for (const v of HEX_VERTICES[hex] as number[]) {
      const b = state.buildings[v] as Building | null;
      if (b !== null && b.owner !== player && totalHand(handOf(state.hands, b.owner)) > 0) {
        victims.add(b.owner);
      }
    }
    if (victims.size === 0) {
      choices.push({ kind: 'moveRobberAndSteal', hex, target: null });
    } else {
      for (const target of victims) {
        choices.push({ kind: 'moveRobberAndSteal', hex, target });
      }
    }
  }
  return choices;
}

function getLegalChoices(state: CatanState): readonly CatanChoice[] {
  if (state.phase === 'done') throw new Error('getLegalChoices: game is already over');
  switch (state.phase) {
    case 'initial':
      return legalInitialChoices(state);
    case 'build':
      return legalBuildChoices(state);
    case 'trade':
      return legalBankTradeChoices(state);
    case 'discard':
      return legalDiscardChoices(state);
    case 'robber':
      return legalRobberChoices(state);
    default:
      throw new Error(`getLegalChoices: unhandled phase ${state.phase as string}`);
  }
}

function encodeChoice(choice: CatanChoice): string {
  switch (choice.kind) {
    case 'placeSettlement':
      return `placeSettlement:${choice.vertex}`;
    case 'placeRoad':
      return `placeRoad:${choice.edge}`;
    case 'buildSettlement':
      return `buildSettlement:${choice.vertex}`;
    case 'buildCity':
      return `buildCity:${choice.vertex}`;
    case 'buildRoad':
      return `buildRoad:${choice.edge}`;
    case 'toTrade':
      return 'toTrade';
    case 'bankTrade':
      return `bankTrade:${choice.give}->${choice.get}`;
    case 'endTurn':
      return 'endTurn';
    case 'discard':
      return `discard:${choice.resource}`;
    case 'moveRobberAndSteal':
      return `moveRobberAndSteal:${choice.hex}:${choice.target ?? 'none'}`;
    default: {
      const exhaustive: never = choice;
      throw new Error(`encodeChoice: unhandled choice ${JSON.stringify(exhaustive)}`);
    }
  }
}

// -----------------------------------------------------------------------
// Transitions
// -----------------------------------------------------------------------

function computeScores(state: CatanState): number[] {
  const scores = Array(PLAYER_COUNT).fill(0);
  for (const b of state.buildings) {
    if (b === null) continue;
    scores[b.owner] += b.type === 'city' ? 2 : 1;
  }
  return scores;
}

function forceEndByTurnCap(state: CatanState): CatanState {
  const scores = computeScores(state);
  let best: PlayerId = 0;
  for (let p = 1; p < PLAYER_COUNT; p += 1) {
    if ((scores[p] as number) > (scores[best] as number)) best = p as PlayerId;
  }
  return { ...state, phase: 'done', winner: best };
}

function distributeResources(state: CatanState, roll: number): CatanState {
  const bank: Record<Resource, number> = { ...state.bank };
  const hands = state.hands.map((h) => ({ ...h })) as [
    Record<Resource, number>,
    Record<Resource, number>,
    Record<Resource, number>,
    Record<Resource, number>,
  ];
  for (let hex = 0; hex < state.tiles.length; hex += 1) {
    if (hex === state.robberHex) continue;
    const tile = state.tiles[hex] as { resource: TileResource; number: number | null };
    if (tile.resource === 'desert' || tile.number !== roll) continue;
    const resource = tile.resource as Resource;
    for (const v of HEX_VERTICES[hex] as number[]) {
      const b = state.buildings[v] as Building | null;
      if (b === null) continue;
      const amount = b.type === 'city' ? 2 : 1;
      const give = Math.min(amount, bank[resource]);
      if (give <= 0) continue;
      (hands[b.owner] as Record<Resource, number>)[resource] += give;
      bank[resource] -= give;
    }
  }
  return { ...state, hands, bank };
}

function grantInitialResources(state: CatanState, vertex: number, player: PlayerId): CatanState {
  const bank: Record<Resource, number> = { ...state.bank };
  const hand: Record<Resource, number> = { ...handOf(state.hands, player) };
  for (const hex of VERTEX_HEXES[vertex] as number[]) {
    const tile = state.tiles[hex] as { resource: TileResource; number: number | null };
    if (tile.resource === 'desert') continue;
    const resource = tile.resource as Resource;
    if (bank[resource] > 0) {
      bank[resource] -= 1;
      hand[resource] += 1;
    }
  }
  const hands = state.hands.slice() as [ResHand, ResHand, ResHand, ResHand];
  hands[player] = hand;
  return { ...state, bank, hands };
}

function beginTurn(state: CatanState, player: PlayerId, turnNumber: number): CatanState {
  if (turnNumber > TURN_CAP) {
    return forceEndByTurnCap({ ...state, active: player, turnNumber });
  }
  const rng = createRng(state.seed).fork('dice').fork(`turn-${turnNumber}`);
  const die1 = 1 + rng.nextInt(6);
  const die2 = 1 + rng.nextInt(6);
  const roll = die1 + die2;
  const base: CatanState = { ...state, active: player, turnNumber };
  if (roll === 7) {
    const discarders = ALL_SEATS.filter((p) => totalHand(handOf(base.hands, p)) > 7);
    if (discarders.length === 0) {
      return { ...base, phase: 'robber', pendingDiscarders: [], discardRemaining: null };
    }
    const first = discarders[0] as PlayerId;
    return {
      ...base,
      phase: 'discard',
      pendingDiscarders: discarders,
      discardRemaining: Math.floor(totalHand(handOf(base.hands, first)) / 2),
    };
  }
  const distributed = distributeResources(base, roll);
  return { ...distributed, phase: 'build' };
}

function checkVictory(state: CatanState, player: PlayerId): CatanState {
  const scores = computeScores(state);
  if ((scores[player] as number) >= VICTORY_POINTS) {
    return { ...state, phase: 'done', winner: player };
  }
  return state;
}

function payCost(state: CatanState, player: PlayerId, cost: Readonly<Record<Resource, number>>): CatanState {
  const hand: Record<Resource, number> = { ...handOf(state.hands, player) };
  const bank: Record<Resource, number> = { ...state.bank };
  for (const r of RESOURCES) {
    hand[r] -= cost[r];
    bank[r] += cost[r];
  }
  const hands = state.hands.slice() as [ResHand, ResHand, ResHand, ResHand];
  hands[player] = hand;
  return { ...state, hands, bank };
}

function applyBuildInitial(state: CatanState, choice: CatanChoice): CatanState {
  const player = state.initialQueue[0] as PlayerId;
  if (choice.kind === 'placeSettlement') {
    const buildings = state.buildings.slice();
    buildings[choice.vertex] = { owner: player, type: 'settlement' };
    return { ...state, buildings, initialSubStep: 'road', lastInitialSettlement: choice.vertex };
  }
  if (choice.kind === 'placeRoad') {
    const roads = state.roads.slice();
    roads[choice.edge] = player;
    let next: CatanState = { ...state, roads, initialSubStep: 'settlement' };
    if (state.initialRound === 2) {
      next = grantInitialResources(next, state.lastInitialSettlement as number, player);
    }
    next = { ...next, lastInitialSettlement: null };
    const queue = state.initialQueue.slice(1);
    if (queue.length > 0) {
      return { ...next, initialQueue: queue };
    }
    if (state.initialRound === 1) {
      return { ...next, initialRound: 2, initialQueue: [3, 2, 1, 0] };
    }
    return beginTurn({ ...next, initialQueue: [] }, 0, 1);
  }
  throw new Error('applyBuildInitial: unexpected choice');
}

function applyBuild(state: CatanState, choice: CatanChoice): CatanState {
  const player = state.active;
  if (choice.kind === 'toTrade') return { ...state, phase: 'trade' };
  if (choice.kind === 'buildSettlement') {
    let next = payCost(state, player, SETTLEMENT_COST);
    const buildings = next.buildings.slice();
    buildings[choice.vertex] = { owner: player, type: 'settlement' };
    next = { ...next, buildings };
    return checkVictory(next, player);
  }
  if (choice.kind === 'buildCity') {
    let next = payCost(state, player, CITY_COST);
    const buildings = next.buildings.slice();
    buildings[choice.vertex] = { owner: player, type: 'city' };
    next = { ...next, buildings };
    return checkVictory(next, player);
  }
  if (choice.kind === 'buildRoad') {
    const next = payCost(state, player, ROAD_COST);
    const roads = next.roads.slice();
    roads[choice.edge] = player;
    return { ...next, roads };
  }
  throw new Error('applyBuild: unexpected choice');
}

function applyBankTrade(state: CatanState, choice: CatanChoice): CatanState {
  const player = state.active;
  if (choice.kind === 'endTurn') {
    const nextPlayer = ((player + 1) % PLAYER_COUNT) as PlayerId;
    return beginTurn(state, nextPlayer, state.turnNumber + 1);
  }
  if (choice.kind === 'bankTrade') {
    const hand: Record<Resource, number> = { ...handOf(state.hands, player) };
    const bank: Record<Resource, number> = { ...state.bank };
    hand[choice.give] -= 4;
    bank[choice.give] += 4;
    hand[choice.get] -= 1;
    bank[choice.get] += 1;
    const hands = state.hands.slice() as [ResHand, ResHand, ResHand, ResHand];
    hands[player] = hand;
    return { ...state, hands, bank };
  }
  throw new Error('applyBankTrade: unexpected choice');
}

function applyDiscard(state: CatanState, choice: CatanChoice): CatanState {
  if (choice.kind !== 'discard') throw new Error('applyDiscard: unexpected choice');
  const player = state.pendingDiscarders[0] as PlayerId;
  const hand: Record<Resource, number> = { ...handOf(state.hands, player) };
  hand[choice.resource] -= 1;
  const bank: Record<Resource, number> = { ...state.bank };
  bank[choice.resource] += 1;
  const hands = state.hands.slice() as [ResHand, ResHand, ResHand, ResHand];
  hands[player] = hand;
  const remaining = (state.discardRemaining as number) - 1;
  if (remaining > 0) {
    return { ...state, hands, bank, discardRemaining: remaining };
  }
  const queue = state.pendingDiscarders.slice(1);
  if (queue.length > 0) {
    const nextPlayer = queue[0] as PlayerId;
    return {
      ...state,
      hands,
      bank,
      pendingDiscarders: queue,
      discardRemaining: Math.floor(totalHand(handOf(hands, nextPlayer)) / 2),
    };
  }
  return { ...state, hands, bank, pendingDiscarders: [], discardRemaining: null, phase: 'robber' };
}

function applyRobber(state: CatanState, choice: CatanChoice): CatanState {
  if (choice.kind !== 'moveRobberAndSteal') throw new Error('applyRobber: unexpected choice');
  let next: CatanState = { ...state, robberHex: choice.hex };
  if (choice.target !== null) {
    const victim = choice.target;
    const rng = createRng(state.seed).fork('steal').fork(`turn-${state.turnNumber}`);
    const pool: Resource[] = [];
    for (const r of RESOURCES) {
      for (let i = 0; i < handOf(state.hands, victim)[r]; i += 1) pool.push(r);
    }
    if (pool.length > 0) {
      const picked = pool[rng.nextInt(pool.length)] as Resource;
      const victimHand: Record<Resource, number> = { ...handOf(next.hands, victim) };
      victimHand[picked] -= 1;
      const activeHand: Record<Resource, number> = { ...handOf(next.hands, state.active) };
      activeHand[picked] += 1;
      const hands = next.hands.slice() as [ResHand, ResHand, ResHand, ResHand];
      hands[victim] = victimHand;
      hands[state.active] = activeHand;
      next = { ...next, hands };
    }
  }
  return { ...next, phase: 'build' };
}

function applyChoice(state: CatanState, choice: CatanChoice): CatanState {
  const legal = getLegalChoices(state);
  const key = encodeChoice(choice);
  if (!legal.some((candidate) => encodeChoice(candidate) === key)) {
    throw new Error(`applyChoice: choice ${key} is not among the legal choices at this decision`);
  }
  switch (state.phase) {
    case 'initial':
      return applyBuildInitial(state, choice);
    case 'build':
      return applyBuild(state, choice);
    case 'trade':
      return applyBankTrade(state, choice);
    case 'discard':
      return applyDiscard(state, choice);
    case 'robber':
      return applyRobber(state, choice);
    case 'done':
      throw new Error('applyChoice: game is already over');
    default:
      throw new Error(`applyChoice: unhandled phase ${state.phase as string}`);
  }
}

function getOutcome(state: CatanState): Outcome | null {
  if (state.phase !== 'done' || state.winner === null) return null;
  const scores = computeScores(state);
  return { scores, winners: [state.winner] };
}

// -----------------------------------------------------------------------
// Observation
// -----------------------------------------------------------------------

function getObservation(state: CatanState, player: PlayerId): CatanObservation {
  return {
    self: player,
    active: state.active,
    phase: state.phase,
    turnNumber: state.turnNumber,
    tiles: state.tiles,
    robberHex: state.robberHex,
    buildings: state.buildings,
    roads: state.roads,
    bank: state.bank,
    ownHand: handOf(state.hands, player),
    opponentHandCounts: ALL_SEATS.filter((p) => p !== player).map((p) => ({
      player: p,
      count: totalHand(handOf(state.hands, p)),
    })),
    scores: computeScores(state),
    pendingDiscarders: state.pendingDiscarders,
    discardRemaining: state.discardRemaining,
    lastInitialSettlement: state.lastInitialSettlement,
    winner: state.winner,
  };
}

// -----------------------------------------------------------------------
// Invariants
// -----------------------------------------------------------------------

function resourceConservationInvariant(state: CatanState): string | null {
  for (const r of RESOURCES) {
    const inHands = state.hands.reduce((sum, h) => sum + h[r], 0);
    const total = inHands + state.bank[r];
    if (total !== BANK_START) {
      return `resource conservation violated for ${r}: total=${total}, expected ${BANK_START}`;
    }
  }
  return null;
}

function distanceRuleInvariant(state: CatanState): string | null {
  for (let v = 0; v < VERTEX_COUNT; v += 1) {
    if (state.buildings[v] === null) continue;
    for (const n of VERTEX_NEIGHBORS[v] as number[]) {
      if (state.buildings[n] !== null) {
        return `distance rule violated: adjacent buildings at vertices ${v} and ${n}`;
      }
    }
  }
  return null;
}

function pieceLimitInvariant(state: CatanState): string | null {
  for (let p = 0; p < PLAYER_COUNT; p += 1) {
    const player = p as PlayerId;
    const settlements = countBuildingsOfType(state, player, 'settlement');
    const cities = countBuildingsOfType(state, player, 'city');
    const roads = countRoadsOf(state, player);
    if (settlements > MAX_SETTLEMENTS) return `player ${p} exceeds settlement limit: ${settlements}`;
    if (cities > MAX_CITIES) return `player ${p} exceeds city limit: ${cities}`;
    if (roads > MAX_ROADS) return `player ${p} exceeds road limit: ${roads}`;
  }
  return null;
}

// -----------------------------------------------------------------------
// Hidden information probe (C3)
// -----------------------------------------------------------------------

const catanHiddenInfoProbe: HiddenInfoProbe<CatanState> = {
  mutateHidden(state, viewer, rng) {
    const opponents = ALL_SEATS.filter((p) => p !== viewer);
    const pool: Resource[] = [];
    for (const opp of opponents) {
      for (const r of RESOURCES) {
        for (let i = 0; i < handOf(state.hands, opp)[r]; i += 1) pool.push(r);
      }
    }
    if (pool.length === 0) return null;
    const shuffledPool = shuffled(pool, rng);
    let idx = 0;
    const hands = state.hands.slice() as [ResHand, ResHand, ResHand, ResHand];
    let changed = false;
    for (const opp of opponents) {
      const size = totalHand(handOf(state.hands, opp));
      const slice = shuffledPool.slice(idx, idx + size);
      idx += size;
      const newHand = freshHand();
      for (const r of slice) newHand[r] += 1;
      if (!handsEqual(newHand, handOf(state.hands, opp))) changed = true;
      hands[opp] = newHand;
    }
    if (!changed) return null;
    return { ...state, hands };
  },
};

// -----------------------------------------------------------------------
// Baselines
// -----------------------------------------------------------------------

const randomBaseline: BotFactory<CatanObservation, CatanChoice> = (seed) => {
  const rng = createRng(seed);
  return {
    id: 'catan-random',
    decide(_decisionPoint, _observation, legal) {
      return legal[rng.nextInt(legal.length)] as CatanChoice;
    },
  };
};

/**
 * Heuristic baseline: minimal common sense, not meant to be strong.
 *   - Initial settlement: maximizes total pip count (production probability)
 *     of adjacent hexes, ignoring the desert (pip 0).
 *   - Initial road: first legal option touching the settlement just placed.
 *   - Build phase: settlement > city > road > move to trading (priority
 *     order deliberately differs from the cityUpgradePriority and
 *     roadExpansionPriority strategy flags below, so those flags actually
 *     change observable behavior — C6 needs that).
 *   - Bank trade: never trades, always ends the turn immediately (kept
 *     dumb on purpose — eagerBankTrade's whole point is to be the flag that
 *     makes trading happen).
 *   - Discard: discards whichever resource type this player currently holds
 *     the most of, one card at a time.
 *   - Robber: targets the hex touching the current victory-point leader
 *     (excluding self), stealing from them when a valid target exists.
 */
function heuristicPick(
  decisionPoint: string,
  observation: CatanObservation,
  legal: readonly CatanChoice[],
): CatanChoice {
  switch (decisionPoint) {
    case 'buildInitial': {
      const first = legal[0];
      if (first?.kind === 'placeSettlement') {
        let best = first;
        let bestScore = -1;
        for (const c of legal as Extract<CatanChoice, { kind: 'placeSettlement' }>[]) {
          const score = (VERTEX_HEXES[c.vertex] as number[]).reduce(
            (sum, hex) => sum + pipCount(observation.tiles[hex]?.number ?? null),
            0,
          );
          if (score > bestScore) {
            bestScore = score;
            best = c;
          }
        }
        return best;
      }
      return legal[0] as CatanChoice;
    }
    case 'build': {
      const settlement = legal.find((c) => c.kind === 'buildSettlement');
      if (settlement) return settlement;
      const city = legal.find((c) => c.kind === 'buildCity');
      if (city) return city;
      const road = legal.find((c) => c.kind === 'buildRoad');
      if (road) return road;
      return legal.find((c) => c.kind === 'toTrade') as CatanChoice;
    }
    case 'bankTrade':
      return legal.find((c) => c.kind === 'endTurn') as CatanChoice;
    case 'discardHalf': {
      let best = legal[0] as Extract<CatanChoice, { kind: 'discard' }>;
      let bestCount = -1;
      for (const c of legal as Extract<CatanChoice, { kind: 'discard' }>[]) {
        const count = observation.ownHand[c.resource];
        if (count > bestCount) {
          bestCount = count;
          best = c;
        }
      }
      return best;
    }
    case 'moveRobberAndSteal': {
      const scores = observation.scores;
      let bestPlayer = -1;
      let bestScore = -1;
      for (let p = 0; p < scores.length; p += 1) {
        if (p === observation.active) continue;
        if ((scores[p] as number) > bestScore) {
          bestScore = scores[p] as number;
          bestPlayer = p;
        }
      }
      const targeted = (legal as Extract<CatanChoice, { kind: 'moveRobberAndSteal' }>[]).find(
        (c) => c.target === bestPlayer,
      );
      if (targeted) return targeted;
      return legal[0] as CatanChoice;
    }
    default:
      return legal[0] as CatanChoice;
  }
}

const heuristicBaseline: BotFactory<CatanObservation, CatanChoice> = (_seed) => ({
  id: 'catan-heuristic',
  decide: heuristicPick,
});

// -----------------------------------------------------------------------
// Strategy surface
// -----------------------------------------------------------------------

function wrapBotId(id: string, suffix: string): string {
  return `${id}+${suffix}`;
}

/** Strategy flag: effective. Always builds a city over a settlement/road when legal. */
const cityUpgradePriority: StrategyFlagSpec<CatanObservation, CatanChoice> = {
  flag: 'cityUpgradePriority',
  description:
    'On the build decision, always builds a city over a settlement or road when legal, overriding the base priority.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot.id, 'cityUpgradePriority'),
        decide(decisionPoint, observation, legal) {
          if (decisionPoint === 'build') {
            const city = legal.find((c) => c.kind === 'buildCity');
            if (city) return city;
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/** Strategy flag: effective. Always builds a road over a settlement/city when legal — board presence over immediate points. */
const roadExpansionPriority: StrategyFlagSpec<CatanObservation, CatanChoice> = {
  flag: 'roadExpansionPriority',
  description:
    'On the build decision, always builds a road when legal (before settlement/city), overriding the base priority.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot.id, 'roadExpansionPriority'),
        decide(decisionPoint, observation, legal) {
          if (decisionPoint === 'build') {
            const road = legal.find((c) => c.kind === 'buildRoad');
            if (road) return road;
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/** Strategy flag: effective. Trades 4:1 toward a currently-empty resource instead of always ending the turn immediately. */
const eagerBankTrade: StrategyFlagSpec<CatanObservation, CatanChoice> = {
  flag: 'eagerBankTrade',
  description:
    'On the bank-trade decision, trades 4:1 toward a currently-empty resource instead of always ending the turn immediately.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot.id, 'eagerBankTrade'),
        decide(decisionPoint, observation, legal) {
          if (decisionPoint === 'bankTrade') {
            const tradeChoices = legal.filter(
              (c): c is Extract<CatanChoice, { kind: 'bankTrade' }> => c.kind === 'bankTrade',
            );
            const deficient = tradeChoices.find((c) => observation.ownHand[c.get] === 0);
            if (deficient) return deficient;
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/**
 * Strategy flag: effective. `catanScarcityWeightedTrade` — the A8
 * domain-redesign card (docs/GAP-ANALYSIS-12.md §7,
 * scratchpad/catan-a8-first-adoption-design-spec.md). Unifies the 'build'
 * and 'bankTrade' decision points behind a single "need vector" evaluation
 * instead of overriding either one with a fixed rule (cityUpgradePriority/
 * roadExpansionPriority/eagerBankTrade are each a single-rule override — all
 * three screened-out/failed; this flag scores against build-target resource
 * cost instead).
 *
 * Reinterpretation from the original card intent (verified against the code
 * before implementing, per the design brief's instruction): the original
 * "부족 자원일수록 거래를 적극적으로 받아들인다" card assumed a
 * player-to-player trade-offer mechanism. `legalBankTradeChoices` (line
 * ~469) proves this adapter has none — bank trades are a fixed 4:1 ratio,
 * no ports, no peer offers (see this file's top doc comment, "Scope
 * reduction"). Reinterpreted for the bank-trade context: "only give away
 * genuine surplus, only ask for genuine need" — this directly targets
 * eagerBankTrade's flaw (it trades toward any *currently-empty* resource
 * regardless of whether that resource is actually needed for anything, and
 * gives away resources that might be needed elsewhere).
 *
 * Also corrects a decision-point-shape assumption in the original brief: the
 * brief said "no immediate build -> choose endTurn", but `legalBuildChoices`
 * (line ~440) never includes `endTurn` — only `legalBankTradeChoices` (line
 * ~469) does. The 'build' decision's only non-build option is `toTrade`
 * (moves to the bank-trade sub-phase); `endTurn` only exists inside
 * 'bankTrade'. This flag uses `toTrade` in the 'build' branch accordingly.
 *
 * "Need vector" (`computeNeedSurplus`, pure, recomputed every decision — no
 * persisted state across calls):
 *   - Priority build target order is city > settlement > road (matching the
 *     cityUpgradePriority/roadExpansionPriority convention), with one
 *     adjustment from the brief's literal wording, recorded here because it
 *     changes behavior: city is only the target when the player actually
 *     owns an upgradeable settlement (`catanBuildPriorityTarget` checks
 *     `observation.buildings` for one owned by `self` with
 *     `type: 'settlement'`) — coveting CITY_COST's wheat/ore forever with no
 *     settlement to upgrade would be a strictly worse heuristic than falling
 *     back to the settlement target. When no upgradeable settlement exists,
 *     the target is always `SETTLEMENT_COST` — road is deliberately never
 *     the need-vector target (it's the cheapest, always-attainable-soonest
 *     option, so accumulating resource preference for it specifically has no
 *     value). MAX_CITIES/MAX_SETTLEMENTS caps are intentionally ignored in
 *     target *selection* (an edge case late in the game); the actual
 *     buildCity/buildSettlement legality (and thus the immediate-build check
 *     below) already enforces those caps via `legal`.
 *   - `need[r] = max(0, targetCost[r] - hand[r])`,
 *     `surplus[r] = max(0, hand[r] - targetCost[r])` (a resource the target
 *     doesn't use at all, i.e. `targetCost[r] === 0`, is entirely surplus).
 *
 * 'build' decision: buildCity > buildSettlement > buildRoad, whichever is
 * legal first (same priority order as the need-vector target, so a target
 * that becomes affordable is built immediately rather than held for a
 * "better" trade). If none are legal, `toTrade`.
 *
 * 'bankTrade' decision: among legal `bankTrade` choices, keep only those
 * where `surplus[give] > 0` AND `need[get] > 0`; among survivors, pick the
 * one with the largest `need[get]` (ties broken by encounter order, which
 * follows `legalBankTradeChoices`'s fixed RESOURCES-array iteration order —
 * deterministic). If no choice survives the filter, `endTurn` — no trade,
 * unlike eagerBankTrade which always finds *some* deficient resource to
 * chase. Note (recorded, not "fixed", per the brief's literal formula): the
 * `surplus[give] > 0` check does not require `surplus[give] >= 4` even
 * though a bank trade always moves exactly 4 units of `give` — a hand with,
 * say, 1 unit of surplus wood still qualifies, which can eat 3 units of
 * would-be-reserved wood. This is the brief's literal condition, kept as
 * specified; a stricter `>= 4` gate is a candidate refinement for a future
 * card, not implemented here.
 */
function catanBuildPriorityTarget(observation: CatanObservation): Readonly<Record<Resource, number>> {
  const hasUpgradeableSettlement = observation.buildings.some(
    (b) => b !== null && b.owner === observation.self && b.type === 'settlement',
  );
  return hasUpgradeableSettlement ? CITY_COST : SETTLEMENT_COST;
}

function computeNeedSurplus(
  hand: ResHand,
  targetCost: Readonly<Record<Resource, number>>,
): { readonly need: Record<Resource, number>; readonly surplus: Record<Resource, number> } {
  const need = freshHand();
  const surplus = freshHand();
  for (const r of RESOURCES) {
    need[r] = Math.max(0, targetCost[r] - hand[r]);
    surplus[r] = Math.max(0, hand[r] - targetCost[r]);
  }
  return { need, surplus };
}

const catanScarcityWeightedTrade: StrategyFlagSpec<CatanObservation, CatanChoice> = {
  flag: 'catanScarcityWeightedTrade',
  description:
    'Unifies build and bankTrade behind one need-vector evaluation: builds city>settlement>road when immediately legal; otherwise on bankTrade, only trades surplus (unneeded-by-target) resources for a resource the current priority build target actually needs, and does not trade at all if no such trade exists.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot.id, 'catanScarcityWeightedTrade'),
        decide(decisionPoint, observation, legal) {
          if (decisionPoint === 'build') {
            const city = legal.find((c) => c.kind === 'buildCity');
            if (city) return city;
            const settlement = legal.find((c) => c.kind === 'buildSettlement');
            if (settlement) return settlement;
            const road = legal.find((c) => c.kind === 'buildRoad');
            if (road) return road;
            return legal.find((c) => c.kind === 'toTrade') as CatanChoice;
          }
          if (decisionPoint === 'bankTrade') {
            const targetCost = catanBuildPriorityTarget(observation);
            const { need, surplus } = computeNeedSurplus(observation.ownHand, targetCost);
            const tradeChoices = legal.filter(
              (c): c is Extract<CatanChoice, { kind: 'bankTrade' }> => c.kind === 'bankTrade',
            );
            let best: Extract<CatanChoice, { kind: 'bankTrade' }> | undefined;
            let bestNeed = 0;
            for (const c of tradeChoices) {
              if (surplus[c.give] > 0 && need[c.get] > 0 && need[c.get] > bestNeed) {
                best = c;
                bestNeed = need[c.get];
              }
            }
            if (best) return best;
            return legal.find((c) => c.kind === 'endTurn') as CatanChoice;
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

/**
 * Strategy flag: effective. `catanPipWeightedBuild` — the A8 round-2 card
 * (docs/GAP-11-ROUNDS.md "카탄 A8 2차 시도(건설/거래 분리)",
 * scratchpad/catan-a8-round2-design-spec.md). Both prior catan A8 attempts
 * (`eagerBankTrade`, `catanScarcityWeightedTrade`) touched the bankTrade
 * decision and both screened out/failed — this card deliberately isolates
 * the other axis instead: it never overrides `bankTrade` (or any decision
 * point other than `build`), delegating everything else straight to
 * `bot.decide(...)`. It also keeps the *type* priority on `build`
 * identical to `heuristicPick` (settlement > city > road > toTrade) — the
 * only change is *which coordinate* to pick within a type, replacing
 * `heuristicPick`'s `legal.find(...)` (first legal candidate, no
 * evaluation) with the same "sum of adjacent hex pips" evaluation function
 * `heuristicPick`'s own `buildInitial` branch already uses for initial
 * settlement placement (`pipScore`, via the now-exported `pipCount`) —
 * reusing a function already proven to change behavior in the initial
 * phase, rather than inventing a new evaluation from scratch.
 *
 * - settlement/city groups: among legal candidates of that kind, pick the
 *   vertex with the highest `pipScore` (ties keep the first-encountered
 *   candidate, matching `legal`'s iteration order, so play stays
 *   deterministic). The city group in practice rarely has more than one or
 *   two legal candidates (at most one upgradeable settlement per decision
 *   is typical), so this group is often a near no-op — kept anyway for
 *   scoring consistency with settlement/road.
 * - road group: each candidate edge's two endpoint vertices are scored via
 *   `isFreeForSettlement(observation, v) ? pipScore(v) : 0`, and the edge
 *   takes the *larger* of its two endpoint scores. The edge with the
 *   highest score wins (ties: first-encountered). Known, accepted
 *   approximation (not attempted to fix here): this is a one-hop-sighted
 *   evaluation — it rewards a road that touches an open, high-pip vertex
 *   right now, but cannot see a high-value vertex that is two roads away.
 *   If every candidate edge scores 0 (no candidate touches a currently-open
 *   settlement spot), the first legal road is used, identical to
 *   `heuristicPick`'s "any road" fallback.
 * - `isFreeForSettlement` reimplements `isVertexFreeForSettlement`
 *   (catan.ts:385-391) against `CatanObservation` instead of `CatanState`,
 *   because `StrategyFlagSpec.apply`'s `decide` only receives an
 *   observation (same constraint `catanScarcityWeightedTrade` operates
 *   under, above) — the distance-rule check (no adjacent building) is
 *   otherwise byte-for-byte identical.
 */
function isFreeForSettlement(observation: CatanObservation, v: number): boolean {
  if (observation.buildings[v] !== null) return false;
  for (const n of VERTEX_NEIGHBORS[v] as number[]) {
    if (observation.buildings[n] !== null) return false;
  }
  return true;
}

function pipScore(observation: CatanObservation, vertex: number): number {
  return (VERTEX_HEXES[vertex] as number[]).reduce(
    (sum, hex) => sum + pipCount(observation.tiles[hex]?.number ?? null),
    0,
  );
}

function bestByPipScore<C extends CatanChoice>(
  candidates: readonly C[],
  score: (candidate: C) => number,
): C | undefined {
  let best: C | undefined;
  let bestScore = -1;
  for (const candidate of candidates) {
    const s = score(candidate);
    if (s > bestScore) {
      bestScore = s;
      best = candidate;
    }
  }
  return best;
}

const catanPipWeightedBuild: StrategyFlagSpec<CatanObservation, CatanChoice> = {
  flag: 'catanPipWeightedBuild',
  description:
    'On the build decision, keeps the base settlement>city>road>toTrade type priority but replaces first-legal-candidate coordinate selection with the pip-sum evaluation heuristicPick already uses for initial settlement placement. Never touches bankTrade or any other decision point.',
  apply(base) {
    return (seed) => {
      const bot = base(seed);
      return {
        id: wrapBotId(bot.id, 'catanPipWeightedBuild'),
        decide(decisionPoint, observation, legal) {
          if (decisionPoint === 'build') {
            const settlements = legal.filter(
              (c): c is Extract<CatanChoice, { kind: 'buildSettlement' }> => c.kind === 'buildSettlement',
            );
            if (settlements.length > 0) {
              return bestByPipScore(settlements, (c) => pipScore(observation, c.vertex)) as CatanChoice;
            }
            const cities = legal.filter(
              (c): c is Extract<CatanChoice, { kind: 'buildCity' }> => c.kind === 'buildCity',
            );
            if (cities.length > 0) {
              return bestByPipScore(cities, (c) => pipScore(observation, c.vertex)) as CatanChoice;
            }
            const roads = legal.filter(
              (c): c is Extract<CatanChoice, { kind: 'buildRoad' }> => c.kind === 'buildRoad',
            );
            if (roads.length > 0) {
              return bestByPipScore(roads, (c) => {
                const [a, b] = EDGE_VERTICES[c.edge] as [number, number];
                const scoreA = isFreeForSettlement(observation, a) ? pipScore(observation, a) : 0;
                const scoreB = isFreeForSettlement(observation, b) ? pipScore(observation, b) : 0;
                return Math.max(scoreA, scoreB);
              }) as CatanChoice;
            }
            return legal.find((c) => c.kind === 'toTrade') as CatanChoice;
          }
          return bot.decide(decisionPoint, observation, legal);
        },
      };
    };
  },
};

// -----------------------------------------------------------------------
// Replay fixtures — generated by running this adapter's own random-vs-random
// self-play (see src/reference/__tests__/catan.test.ts's generation note). No
// original-game engine/replay source exists for a from-scratch reimplementation,
// so — same caveat as avalon's/dominion's fixtures — these prove
// reproducibility, not cross-implementation parity, and C7 is capped at 60
// accordingly (docs/ONBOARDING-GUIDE.md §4).
// -----------------------------------------------------------------------

const replayFixtures: readonly ReplayFixture[] = [
  {
    id: 'catan-seed-3',
    seed: 3,
    choiceKeys: [
    'placeSettlement:0', 'placeRoad:0', 'placeSettlement:6', 'placeRoad:6', 'placeSettlement:21', 'placeRoad:24',
    'placeSettlement:39', 'placeRoad:49', 'placeSettlement:18', 'placeRoad:21', 'placeSettlement:34',
    'placeRoad:42', 'placeSettlement:2', 'placeRoad:1', 'placeSettlement:14', 'placeRoad:16', 'buildRoad:5',
    'toTrade', 'endTurn', 'buildRoad:2', 'toTrade', 'endTurn', 'moveRobberAndSteal:0:0', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'moveRobberAndSteal:3:0', 'buildRoad:25',
    'toTrade', 'endTurn', 'buildRoad:22', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildRoad:3', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'buildRoad:10', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'discard:wood', 'discard:wood', 'discard:wood', 'discard:wood', 'discard:ore', 'discard:ore',
    'discard:ore', 'discard:ore', 'moveRobberAndSteal:0:0', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:wheat', 'moveRobberAndSteal:1:1', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildRoad:4', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'buildRoad:23', 'toTrade', 'endTurn', 'buildCity:0', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildRoad:17', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:brick', 'discard:brick', 'discard:brick', 'discard:brick',
    'discard:brick', 'discard:ore', 'discard:sheep', 'discard:ore', 'discard:sheep', 'discard:ore',
    'discard:sheep', 'discard:ore', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:sheep',
    'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:wheat', 'discard:ore', 'discard:ore',
    'discard:ore', 'discard:ore', 'discard:ore', 'discard:sheep', 'discard:ore', 'moveRobberAndSteal:0:0',
    'buildRoad:26', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'discard:sheep', 'discard:ore', 'discard:brick', 'discard:sheep', 'discard:sheep',
    'discard:sheep', 'discard:sheep', 'discard:wood', 'discard:sheep', 'moveRobberAndSteal:1:1', 'toTrade',
    'endTurn', 'moveRobberAndSteal:0:0', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'buildRoad:7', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildRoad:37', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildCity:18', 'toTrade', 'endTurn',
    'buildCity:14', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:wheat',
    'discard:wheat', 'discard:wheat', 'discard:wheat', 'discard:wheat', 'discard:wood', 'discard:wood',
    'discard:wood', 'discard:wood', 'discard:ore', 'discard:wood', 'discard:sheep', 'discard:sheep',
    'discard:wheat', 'discard:sheep', 'discard:wheat', 'discard:wood', 'discard:sheep', 'discard:wheat',
    'discard:sheep', 'discard:ore', 'discard:sheep', 'discard:ore', 'discard:sheep', 'discard:ore',
    'moveRobberAndSteal:3:0', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'discard:brick', 'discard:ore', 'discard:brick', 'discard:ore', 'discard:ore', 'discard:sheep',
    'discard:ore', 'discard:wood', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:wood',
    'discard:sheep', 'discard:wheat', 'discard:ore', 'discard:ore', 'discard:ore', 'discard:wood', 'discard:sheep',
    'moveRobberAndSteal:0:0', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildRoad:8', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'buildCity:39', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:sheep',
    'discard:sheep', 'discard:wheat', 'discard:ore', 'moveRobberAndSteal:3:0', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'discard:wheat', 'discard:wheat', 'discard:wheat', 'discard:ore', 'discard:ore', 'discard:wood',
    'discard:sheep', 'discard:ore', 'discard:sheep', 'discard:sheep', 'discard:wood', 'discard:sheep',
    'discard:wood', 'discard:ore', 'discard:ore', 'discard:wheat', 'discard:ore', 'moveRobberAndSteal:0:0',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:wood', 'discard:sheep',
    'discard:wood', 'discard:sheep', 'moveRobberAndSteal:3:0', 'toTrade', 'endTurn', 'moveRobberAndSteal:0:0',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'discard:wood', 'discard:sheep', 'discard:wood', 'discard:sheep', 'discard:wood',
    'discard:sheep', 'discard:sheep', 'discard:wood', 'discard:sheep', 'discard:ore', 'discard:wood',
    'discard:sheep', 'moveRobberAndSteal:3:0', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'buildSettlement:4', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildRoad:18',
    'buildRoad:19', 'toTrade', 'endTurn', 'discard:ore', 'discard:ore', 'discard:brick', 'discard:wood',
    'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:wood', 'discard:sheep', 'discard:wood',
    'discard:sheep', 'discard:wood', 'discard:wheat', 'discard:ore', 'discard:wood', 'discard:wheat',
    'discard:ore', 'discard:wood', 'discard:wheat', 'discard:ore', 'discard:wood', 'moveRobberAndSteal:0:0',
    'buildRoad:9', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:wheat',
    'discard:wheat', 'discard:wheat', 'discard:wheat', 'discard:wheat', 'discard:brick', 'discard:sheep',
    'discard:sheep', 'discard:wood', 'discard:sheep', 'discard:wheat', 'discard:wood', 'discard:wheat',
    'discard:wheat', 'discard:wheat', 'discard:wood', 'discard:wheat', 'discard:wood', 'discard:wheat',
    'moveRobberAndSteal:3:0', 'toTrade', 'endTurn', 'discard:ore', 'discard:wood', 'discard:wheat', 'discard:ore',
    'moveRobberAndSteal:0:0', 'buildRoad:11', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'moveRobberAndSteal:4:3',
    'toTrade', 'endTurn', 'buildRoad:14', 'buildRoad:13', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'buildRoad:12', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'buildRoad:15', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'buildSettlement:16', 'buildRoad:20', 'buildRoad:32', 'buildRoad:31', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildRoad:29',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildRoad:36', 'buildRoad:38', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'discard:wheat', 'discard:wheat', 'discard:wheat', 'discard:wheat', 'discard:wheat',
    'discard:wheat', 'discard:brick', 'discard:wheat', 'discard:sheep', 'discard:sheep', 'discard:wood',
    'discard:sheep', 'discard:wheat', 'discard:wood', 'discard:sheep', 'discard:wheat', 'discard:ore',
    'discard:ore', 'discard:wheat', 'discard:ore', 'discard:sheep', 'discard:wheat', 'discard:ore', 'discard:wood',
    'discard:sheep', 'discard:wheat', 'moveRobberAndSteal:0:0', 'buildRoad:28', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'buildRoad:40', 'buildSettlement:32', 'toTrade', 'endTurn', 'buildRoad:33', 'buildRoad:34',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildCity:32', 'toTrade', 'endTurn',
    'buildCity:16', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:wheat', 'discard:wheat', 'discard:wheat',
    'discard:wheat', 'discard:brick', 'discard:ore', 'discard:ore', 'discard:sheep', 'discard:ore',
    'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:wheat', 'discard:wood',
    'discard:ore', 'discard:ore', 'discard:brick', 'discard:ore', 'moveRobberAndSteal:3:0', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'discard:sheep', 'discard:wheat', 'discard:sheep', 'discard:wheat',
    'moveRobberAndSteal:4:3', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:wheat', 'discard:wheat',
    'discard:wheat', 'discard:wheat', 'discard:ore', 'discard:wheat', 'moveRobberAndSteal:0:0', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildRoad:39', 'buildRoad:41',
    'buildRoad:44', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'buildRoad:50', 'buildRoad:52', 'toTrade', 'endTurn', 'buildSettlement:25', 'buildCity:25',
    ],
    finalScores: [8, 3, 2, 6],
    provenance: 'self-play',
  },
  {
    id: 'catan-seed-6',
    seed: 6,
    choiceKeys: [
    'placeSettlement:43', 'placeRoad:56', 'placeSettlement:41', 'placeRoad:53', 'placeSettlement:10',
    'placeRoad:11', 'placeSettlement:0', 'placeRoad:0', 'placeSettlement:22', 'placeRoad:27', 'placeSettlement:8',
    'placeRoad:7', 'placeSettlement:14', 'placeRoad:16', 'placeSettlement:29', 'placeRoad:36',
    'moveRobberAndSteal:3:1', 'buildRoad:37', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'moveRobberAndSteal:7:1', 'buildSettlement:18', 'toTrade', 'endTurn', 'buildRoad:17',
    'toTrade', 'endTurn', 'moveRobberAndSteal:4:0', 'buildRoad:6', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildCity:0', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildCity:18', 'buildRoad:21', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:brick', 'discard:sheep', 'discard:wheat',
    'discard:brick', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:wheat', 'discard:sheep',
    'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:sheep',
    'moveRobberAndSteal:8:0', 'toTrade', 'endTurn', 'discard:sheep', 'discard:sheep', 'discard:sheep',
    'discard:wheat', 'moveRobberAndSteal:0:3', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildRoad:5', 'toTrade', 'endTurn', 'buildSettlement:6',
    'toTrade', 'endTurn', 'buildCity:22', 'toTrade', 'endTurn', 'buildRoad:22', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'discard:wheat', 'discard:brick', 'discard:wheat', 'discard:brick', 'discard:wheat',
    'discard:brick', 'discard:wheat', 'discard:sheep', 'discard:wheat', 'discard:sheep', 'discard:wheat',
    'moveRobberAndSteal:4:0', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:wheat',
    'discard:wheat', 'discard:sheep', 'discard:wheat', 'discard:sheep', 'discard:sheep', 'discard:sheep',
    'discard:sheep', 'discard:wheat', 'discard:sheep', 'moveRobberAndSteal:8:0', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'buildRoad:10', 'toTrade', 'endTurn', 'discard:sheep', 'discard:wheat',
    'discard:sheep', 'discard:wheat', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:ore',
    'discard:sheep', 'discard:wheat', 'moveRobberAndSteal:4:0', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'buildRoad:1', 'toTrade', 'endTurn', 'buildRoad:4', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:sheep', 'discard:wheat', 'discard:sheep',
    'discard:wheat', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:ore',
    'discard:ore', 'discard:ore', 'discard:ore', 'discard:ore', 'discard:sheep', 'discard:ore', 'discard:sheep',
    'discard:ore', 'moveRobberAndSteal:8:0', 'buildSettlement:4', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:wheat',
    'discard:wheat', 'discard:wheat', 'discard:wheat', 'discard:wheat', 'discard:wheat', 'discard:wheat',
    'discard:wheat', 'discard:sheep', 'discard:wheat', 'discard:ore', 'discard:sheep', 'moveRobberAndSteal:4:0',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildRoad:3', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:brick', 'discard:brick', 'discard:sheep', 'discard:wheat',
    'discard:wheat', 'discard:wheat', 'discard:wood', 'discard:sheep', 'discard:ore', 'discard:ore', 'discard:ore',
    'discard:wheat', 'discard:ore', 'moveRobberAndSteal:8:0', 'buildRoad:2', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'buildCity:29', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildSettlement:2', 'toTrade', 'endTurn',
    'discard:sheep', 'discard:sheep', 'discard:wheat', 'discard:sheep', 'discard:sheep', 'discard:sheep',
    'discard:wheat', 'discard:sheep', 'discard:wheat', 'discard:sheep', 'discard:sheep', 'discard:sheep',
    'discard:wheat', 'discard:ore', 'discard:sheep', 'discard:wheat', 'discard:ore', 'discard:sheep',
    'discard:wheat', 'moveRobberAndSteal:4:0', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'buildRoad:9', 'toTrade', 'endTurn', 'buildRoad:8', 'buildRoad:12', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:sheep', 'discard:ore', 'discard:sheep', 'discard:ore',
    'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:sheep',
    'discard:wood', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:ore', 'discard:sheep',
    'discard:ore', 'discard:sheep', 'discard:ore', 'discard:sheep', 'moveRobberAndSteal:8:0', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:sheep', 'discard:sheep', 'discard:wheat', 'discard:sheep',
    'discard:wheat', 'discard:wheat', 'discard:wheat', 'discard:ore', 'discard:sheep', 'moveRobberAndSteal:4:0',
    'toTrade', 'endTurn', 'moveRobberAndSteal:8:0', 'toTrade', 'endTurn', 'moveRobberAndSteal:4:0', 'toTrade',
    'endTurn', 'moveRobberAndSteal:0:1', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:wheat',
    'discard:wheat', 'discard:wheat', 'discard:ore', 'moveRobberAndSteal:4:0', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:sheep', 'discard:wheat', 'discard:sheep',
    'discard:wheat', 'discard:wood', 'discard:sheep', 'discard:wood', 'discard:wood', 'discard:wheat',
    'discard:wood', 'discard:wheat', 'discard:wood', 'discard:sheep', 'discard:sheep', 'discard:sheep',
    'discard:sheep', 'moveRobberAndSteal:8:0', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:sheep', 'discard:sheep', 'discard:wood', 'discard:sheep',
    'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:wheat', 'discard:wood', 'discard:sheep',
    'discard:sheep', 'discard:sheep', 'discard:wheat', 'discard:sheep', 'discard:sheep', 'discard:sheep',
    'discard:sheep', 'discard:ore', 'moveRobberAndSteal:4:0', 'toTrade', 'endTurn', 'moveRobberAndSteal:0:1',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:sheep', 'discard:sheep',
    'discard:wheat', 'discard:ore', 'discard:sheep', 'moveRobberAndSteal:4:0', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'buildRoad:18', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:wood', 'discard:wood', 'discard:wood',
    'discard:wheat', 'discard:wood', 'discard:sheep', 'discard:wheat', 'discard:sheep', 'discard:sheep',
    'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:wheat', 'discard:wheat', 'discard:wood',
    'discard:wheat', 'discard:wood', 'discard:wheat', 'discard:sheep', 'discard:wheat', 'discard:sheep',
    'discard:wheat', 'discard:ore', 'discard:sheep', 'discard:wheat', 'discard:ore', 'discard:sheep',
    'discard:wheat', 'moveRobberAndSteal:8:0', 'toTrade', 'endTurn', 'discard:wheat', 'discard:ore',
    'discard:sheep', 'discard:wheat', 'discard:ore', 'discard:sheep', 'moveRobberAndSteal:0:1', 'toTrade',
    'endTurn', 'moveRobberAndSteal:4:0', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:brick',
    'discard:brick', 'discard:wheat', 'discard:brick', 'discard:sheep', 'moveRobberAndSteal:8:0', 'toTrade',
    'endTurn', 'buildRoad:23', 'toTrade', 'endTurn', 'buildSettlement:16', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'discard:sheep', 'discard:sheep', 'discard:wheat', 'discard:ore', 'discard:wheat', 'discard:ore',
    'discard:wheat', 'discard:ore', 'discard:sheep', 'moveRobberAndSteal:4:0', 'toTrade', 'endTurn', 'toTrade',
    'endTurn', 'buildRoad:19', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildRoad:26',
    'buildRoad:24', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'buildCity:43', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:sheep', 'discard:sheep', 'discard:wheat',
    'discard:brick', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:wheat',
    'discard:wood', 'discard:sheep', 'discard:wood', 'discard:wood', 'discard:wood', 'discard:sheep',
    'discard:wheat', 'discard:wood', 'discard:wheat', 'discard:wheat', 'discard:ore', 'discard:sheep',
    'discard:wheat', 'discard:ore', 'discard:sheep', 'discard:wheat', 'discard:ore', 'moveRobberAndSteal:8:0',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn',
    'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:wheat', 'discard:wheat', 'discard:wheat', 'discard:wheat',
    'discard:sheep', 'discard:sheep', 'discard:wood', 'discard:sheep', 'discard:wheat', 'discard:wood',
    'discard:sheep', 'discard:sheep', 'discard:wheat', 'discard:sheep', 'discard:wheat', 'discard:sheep',
    'discard:ore', 'discard:sheep', 'discard:ore', 'discard:sheep', 'discard:wheat', 'discard:ore',
    'discard:sheep', 'discard:wheat', 'discard:ore', 'moveRobberAndSteal:4:0', 'buildRoad:20', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildRoad:32', 'buildRoad:31',
    'toTrade', 'endTurn', 'discard:brick', 'discard:brick', 'discard:wheat', 'discard:brick', 'discard:sheep',
    'discard:wheat', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:wheat',
    'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:wheat',
    'discard:ore', 'moveRobberAndSteal:8:0', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildSettlement:20',
    'buildRoad:25', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'discard:sheep',
    'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:wood', 'discard:wood',
    'discard:sheep', 'discard:wheat', 'discard:sheep', 'discard:sheep', 'discard:sheep', 'discard:wheat',
    'discard:ore', 'discard:sheep', 'discard:wheat', 'moveRobberAndSteal:4:0', 'toTrade', 'endTurn', 'discard:ore',
    'discard:wood', 'discard:sheep', 'discard:wheat', 'moveRobberAndSteal:0:1', 'buildRoad:15', 'toTrade',
    'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'toTrade', 'endTurn', 'buildCity:20',
    ],
    finalScores: [8, 5, 3, 4],
    provenance: 'self-play',
  },
];

// -----------------------------------------------------------------------
// Seating plan: 4 rotations so the candidate (bot index 0) experiences every
// seat/turn-order position across the plan.
// -----------------------------------------------------------------------

const seatingPlan: readonly (readonly PlayerId[])[] = [
  [0, 1, 2, 3],
  [1, 2, 3, 0],
  [2, 3, 0, 1],
  [3, 0, 1, 2],
];

export const catanAdapter: GameAdapter<CatanState, CatanObservation, CatanChoice> = {
  spec: {
    gameId: 'catan',
    playerCount: PLAYER_COUNT,
    decisionPoints: [
      { id: 'buildInitial', description: 'Initial placement: settlement then road, snake order across both rounds.' },
      { id: 'build', description: 'Build a settlement/city/road, or move on to the bank-trade sub-phase.' },
      { id: 'bankTrade', description: 'Trade 4:1 with the bank, or end the turn.' },
      {
        id: 'discardHalf',
        description:
          'After a 7 roll, players holding more than 7 cards discard down by half (rounded down), one card at a time.',
      },
      {
        id: 'moveRobberAndSteal',
        description: "The active player (after a 7 roll) moves the robber to a hex and steals one random card from an adjacent opponent.",
      },
    ],
    seatingPlan,
    scoreMargin: 'scored',
    utility: 'general',
    maxDecisionsPerGame: 4000,
  },
  createInitialState,
  currentDecision,
  getObservation,
  getLegalChoices,
  applyChoice,
  getOutcome,
  encodeChoice,
  invariants: [resourceConservationInvariant, distanceRuleInvariant, pieceLimitInvariant],
  hiddenInfoProbe: catanHiddenInfoProbe,
  replayFixtures,
  baselines: {
    random: randomBaseline,
    heuristic: heuristicBaseline,
  },
  strategySurface: [
    cityUpgradePriority,
    roadExpansionPriority,
    eagerBankTrade,
    catanScarcityWeightedTrade,
    catanPipWeightedBuild,
  ],
};

export {
  VERTEX_COUNT,
  EDGE_COUNT,
  VERTEX_HEXES,
  HEX_VERTICES,
  VERTEX_EDGES,
  VERTEX_NEIGHBORS,
  EDGE_VERTICES,
  pipCount,
};
