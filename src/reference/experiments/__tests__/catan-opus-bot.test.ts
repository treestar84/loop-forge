import { catanOpusBot } from '../catan-opus-bot';
import type { CatanChoice, CatanObservation, Resource } from '../../catan';
import { EDGE_VERTICES, VERTEX_HEXES } from '../../catan';

const EMPTY_HAND: Readonly<Record<Resource, number>> = { brick: 0, wood: 0, sheep: 0, wheat: 0, ore: 0 };
const FULL_BANK: Readonly<Record<Resource, number>> = { brick: 19, wood: 19, sheep: 19, wheat: 19, ore: 19 };

function tilesWithTwoHexes(
  highHex: number,
  highNumber: number,
  lowHex: number,
  lowNumber: number,
): CatanObservation['tiles'] {
  return Array.from({ length: 19 }, (_, hex) => {
    if (hex === highHex) return { resource: 'ore' as const, number: highNumber };
    if (hex === lowHex) return { resource: 'brick' as const, number: lowNumber };
    return { resource: 'desert' as const, number: null };
  });
}

/** First vertex touching `hex` but not `excludeHex` (real board topology from ../catan). */
function vertexTouchingOnly(hex: number, excludeHex: number): number {
  const idx = VERTEX_HEXES.findIndex((hexes) => hexes.includes(hex) && !hexes.includes(excludeHex));
  if (idx === -1) throw new Error(`no vertex touches hex ${hex} without also touching hex ${excludeHex}`);
  return idx;
}

/** First edge with at least one endpoint touching `hex` and neither endpoint touching `excludeHex`. */
function edgeTouchingOnly(hex: number, excludeHex: number): number {
  const idx = EDGE_VERTICES.findIndex(([a, b]) => {
    const hexesA = VERTEX_HEXES[a] as number[];
    const hexesB = VERTEX_HEXES[b] as number[];
    const touches = hexesA.includes(hex) || hexesB.includes(hex);
    const excludes = !hexesA.includes(excludeHex) && !hexesB.includes(excludeHex);
    return touches && excludes;
  });
  if (idx === -1) throw new Error(`no edge touches hex ${hex} without also touching hex ${excludeHex}`);
  return idx;
}

function baseObservation(overrides: Partial<CatanObservation>): CatanObservation {
  return {
    self: 0,
    active: 0,
    phase: 'build',
    turnNumber: 1,
    tiles: tilesWithTwoHexes(0, 6, 1, 2),
    robberHex: 18,
    buildings: Array.from({ length: 54 }, () => null),
    roads: Array.from({ length: 72 }, () => null),
    bank: FULL_BANK,
    ownHand: EMPTY_HAND,
    opponentHandCounts: [
      { player: 1, count: 0 },
      { player: 2, count: 0 },
      { player: 3, count: 0 },
    ],
    scores: [0, 0, 0, 0],
    pendingDiscarders: [],
    discardRemaining: null,
    lastInitialSettlement: null,
    winner: null,
    ...overrides,
  };
}

describe('catanOpusBot determinism (C1)', () => {
  it('returns the same decision for the same seed and observation, repeated', () => {
    const bot1 = catanOpusBot(111);
    const bot2 = catanOpusBot(111);
    const highVertex = vertexTouchingOnly(0, 1);
    const lowVertex = vertexTouchingOnly(1, 0);
    const observation = baseObservation({ phase: 'initial' });
    const legal: CatanChoice[] = [
      { kind: 'placeSettlement', vertex: highVertex },
      { kind: 'placeSettlement', vertex: lowVertex },
    ];
    expect(bot1.decide('buildInitial', observation, legal)).toEqual(bot2.decide('buildInitial', observation, legal));
  });
});

describe('catanOpusBot — initial placement', () => {
  it('prefers the vertex touching the higher production-probability hex (6 over 2)', () => {
    const bot = catanOpusBot(1);
    const highVertex = vertexTouchingOnly(0, 1); // hex 0 rolls on 6 (pip 5)
    const lowVertex = vertexTouchingOnly(1, 0); // hex 1 rolls on 2 (pip 1)
    const observation = baseObservation({ phase: 'initial' });
    const legal: CatanChoice[] = [
      { kind: 'placeSettlement', vertex: lowVertex },
      { kind: 'placeSettlement', vertex: highVertex },
    ];
    const choice = bot.decide('buildInitial', observation, legal) as Extract<CatanChoice, { kind: 'placeSettlement' }>;
    expect(choice.vertex).toBe(highVertex);
  });
});

describe('catanOpusBot — build phase', () => {
  it('builds a city over a settlement when both are legal (victory-point-density priority)', () => {
    const bot = catanOpusBot(2);
    const observation = baseObservation({});
    const legal: CatanChoice[] = [
      { kind: 'buildSettlement', vertex: 10 },
      { kind: 'buildCity', vertex: 5 },
      { kind: 'buildRoad', edge: 3 },
      { kind: 'toTrade' },
    ];
    const choice = bot.decide('build', observation, legal);
    expect(choice).toEqual({ kind: 'buildCity', vertex: 5 });
  });

  it('builds a road toward a hex producing a resource this player still needs (settlement target), not toward pure ore', () => {
    const bot = catanOpusBot(3);
    // Player owns no settlement yet -> next goal is a settlement (needs brick/wood/sheep/wheat,
    // NOT ore — SETTLEMENT_COST.ore === 0). Tile 0 is high-pip (6) ore-only; tile 1 is
    // low-pip (2) brick. Even though the ore edge has a higher raw pip count, brick is on the
    // settlement want-vector and ore is not (weight 0), so the brick-adjacent edge must win.
    const edgeTowardOre = edgeTouchingOnly(0, 1);
    const edgeTowardBrick = edgeTouchingOnly(1, 0);
    const observation = baseObservation({});
    const legal: CatanChoice[] = [
      { kind: 'buildRoad', edge: edgeTowardOre },
      { kind: 'buildRoad', edge: edgeTowardBrick },
      { kind: 'toTrade' },
    ];
    const choice = bot.decide('build', observation, legal) as Extract<CatanChoice, { kind: 'buildRoad' }>;
    expect(choice.edge).toBe(edgeTowardBrick);
  });
});

describe('catanOpusBot — robber targets the leader', () => {
  it('moves onto the leading opponent\'s production tile and steals from them', () => {
    const bot = catanOpusBot(4);
    const observation = baseObservation({ active: 0, scores: [2, 5, 1, 0] });
    const legal: CatanChoice[] = [
      { kind: 'moveRobberAndSteal', hex: 2, target: 2 },
      { kind: 'moveRobberAndSteal', hex: 3, target: 1 },
      { kind: 'moveRobberAndSteal', hex: 4, target: null },
    ];
    const choice = bot.decide('moveRobberAndSteal', observation, legal);
    expect(choice).toEqual({ kind: 'moveRobberAndSteal', hex: 3, target: 1 });
  });
});

describe('catanOpusBot — every decision stays within the legal set', () => {
  it('bankTrade and discardHalf both return a legal choice', () => {
    const bot = catanOpusBot(5);

    const tradeObs = baseObservation({ phase: 'trade', ownHand: { ...EMPTY_HAND, brick: 4 } });
    const tradeLegal: CatanChoice[] = [
      { kind: 'bankTrade', give: 'brick', get: 'wheat' },
      { kind: 'endTurn' },
    ];
    expect(tradeLegal).toContainEqual(bot.decide('bankTrade', tradeObs, tradeLegal));

    const discardObs = baseObservation({
      phase: 'discard',
      self: 1,
      ownHand: { brick: 2, wood: 3, sheep: 0, wheat: 1, ore: 2 },
      pendingDiscarders: [1],
      discardRemaining: 4,
    });
    const discardLegal: CatanChoice[] = [
      { kind: 'discard', resource: 'brick' },
      { kind: 'discard', resource: 'wood' },
      { kind: 'discard', resource: 'wheat' },
      { kind: 'discard', resource: 'ore' },
    ];
    expect(discardLegal).toContainEqual(bot.decide('discardHalf', discardObs, discardLegal));
  });
});
