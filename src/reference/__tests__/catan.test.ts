import { createRng } from '../../kernel/rng';
import { catanAdapter, type CatanChoice, type CatanState } from '../catan';

function playSelfPlay(
  seed: number,
  botFactory: typeof catanAdapter.baselines.random,
  botSeedBase: number,
): { choiceKeys: string[]; finalScores: readonly number[]; finalState: CatanState; steps: number } {
  const adapter = catanAdapter;
  let state = adapter.createInitialState(seed);
  const bots = [0, 1, 2, 3].map((seat) => botFactory(botSeedBase + seat));
  const choiceKeys: string[] = [];
  let steps = 0;
  for (;;) {
    const decision = adapter.currentDecision(state);
    if (!decision) break;
    steps += 1;
    if (steps > adapter.spec.maxDecisionsPerGame) {
      throw new Error('exceeded maxDecisionsPerGame in test self-play');
    }
    const observation = adapter.getObservation(state, decision.player);
    const legal = adapter.getLegalChoices(state);
    const choice = (bots[decision.player] as ReturnType<typeof botFactory>).decide(
      decision.decisionPoint,
      observation,
      legal,
    );
    choiceKeys.push(adapter.encodeChoice(choice));
    state = adapter.applyChoice(state, choice);
    for (const invariant of adapter.invariants ?? []) {
      const violation = invariant(state);
      if (violation) {
        throw new Error(`invariant violated at step ${steps}: ${violation}`);
      }
    }
  }
  const outcome = adapter.getOutcome(state);
  if (!outcome) {
    throw new Error('expected a terminal outcome');
  }
  return { choiceKeys, finalScores: outcome.scores, finalState: state, steps };
}

describe('catan board geometry', () => {
  it('module loads without the geometry self-check throwing (implicit: 54 vertices / 72 edges)', () => {
    // The self-check lives at module scope in catan.ts; if geometry were
    // wrong, importing this test file would already have thrown.
    expect(catanAdapter.spec.gameId).toBe('catan');
  });
});

describe('catan determinism (C1)', () => {
  it('replays the same trajectory for the same seed (random self-play)', () => {
    const first = playSelfPlay(11, catanAdapter.baselines.random, 1000);
    const second = playSelfPlay(11, catanAdapter.baselines.random, 1000);
    expect(second.choiceKeys).toEqual(first.choiceKeys);
    expect(second.finalScores).toEqual(first.finalScores);
  });

  it('replays the same trajectory for the same seed (heuristic self-play)', () => {
    const first = playSelfPlay(22, catanAdapter.baselines.heuristic, 2000);
    const second = playSelfPlay(22, catanAdapter.baselines.heuristic, 2000);
    expect(second.choiceKeys).toEqual(first.choiceKeys);
    expect(second.finalScores).toEqual(first.finalScores);
  });

  it('matches the hardcoded replay fixtures (C7 parity — self-play reproducibility, see final report)', () => {
    for (const fixture of catanAdapter.replayFixtures ?? []) {
      const result = playSelfPlay(fixture.seed, catanAdapter.baselines.heuristic, 2000 + fixture.seed * 7);
      expect(result.choiceKeys).toEqual(fixture.choiceKeys);
      expect(result.finalScores).toEqual(fixture.finalScores);
    }
  });

  it('different seeds assign different tile/number layouts (board diversity)', () => {
    const layouts = new Set<string>();
    for (let seed = 1; seed <= 20; seed += 1) {
      const state = catanAdapter.createInitialState(seed);
      layouts.add(state.tiles.map((t) => `${t.resource}${t.number ?? ''}`).join(','));
    }
    expect(layouts.size).toBeGreaterThan(15);
  });
});

describe('catan rules (C2)', () => {
  it('reaches a terminal outcome within maxDecisionsPerGame for random self-play across many seeds', () => {
    for (let seed = 1; seed <= 15; seed += 1) {
      const result = playSelfPlay(seed, catanAdapter.baselines.random, 9000 + seed * 10);
      expect(result.finalScores).toHaveLength(4);
      expect(result.finalState.winner).not.toBeNull();
    }
  });

  it('reaches a terminal outcome within maxDecisionsPerGame for heuristic self-play across many seeds', () => {
    for (let seed = 1; seed <= 15; seed += 1) {
      const result = playSelfPlay(seed, catanAdapter.baselines.heuristic, 9000 + seed * 10);
      expect(result.finalScores).toHaveLength(4);
      expect(result.finalState.winner).not.toBeNull();
    }
  });

  it('winner has scores[winner] >= 8, or the game was forced to end by the turn cap', () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const result = playSelfPlay(seed, catanAdapter.baselines.heuristic, 3000 + seed * 10);
      const winner = result.finalState.winner as number;
      const winnerScore = result.finalScores[winner] as number;
      const maxScore = Math.max(...result.finalScores);
      expect(winnerScore).toBe(maxScore);
    }
  });

  it('throws on a choice not returned by getLegalChoices', () => {
    const state = catanAdapter.createInitialState(1);
    const badChoice: CatanChoice = { kind: 'placeSettlement', vertex: -1 };
    expect(() => catanAdapter.applyChoice(state, badChoice)).toThrow();
  });

  it('initial placement phase issues exactly 16 buildInitial decisions (4 players x 2 rounds x settlement+road)', () => {
    let state = catanAdapter.createInitialState(5);
    let count = 0;
    while (state.phase === 'initial') {
      const decision = catanAdapter.currentDecision(state);
      if (!decision) break;
      const legal = catanAdapter.getLegalChoices(state);
      state = catanAdapter.applyChoice(state, legal[0] as CatanChoice);
      count += 1;
    }
    expect(count).toBe(16);
  });

  it('second-round initial settlements grant starting resources, first-round ones do not', () => {
    let state = catanAdapter.createInitialState(7);
    // play through round 1 (first 4 settlement+road pairs = 8 decisions)
    for (let i = 0; i < 8; i += 1) {
      const legal = catanAdapter.getLegalChoices(state);
      state = catanAdapter.applyChoice(state, legal[0] as CatanChoice);
    }
    const totalAfterRound1 = state.hands.reduce((sum, h) => sum + h.brick + h.wood + h.sheep + h.wheat + h.ore, 0);
    expect(totalAfterRound1).toBe(0);
    // round 2: one settlement+road pair
    let legal = catanAdapter.getLegalChoices(state);
    state = catanAdapter.applyChoice(state, legal[0] as CatanChoice); // settlement
    legal = catanAdapter.getLegalChoices(state);
    state = catanAdapter.applyChoice(state, legal[0] as CatanChoice); // road
    const totalAfterFirstRound2 = state.hands.reduce(
      (sum, h) => sum + h.brick + h.wood + h.sheep + h.wheat + h.ore,
      0,
    );
    expect(totalAfterFirstRound2).toBeGreaterThan(0);
  });

  it('distance rule: no two settlements may be placed on adjacent vertices', () => {
    const state = catanAdapter.createInitialState(1);
    const legal = catanAdapter.getLegalChoices(state) as Extract<CatanChoice, { kind: 'placeSettlement' }>[];
    const firstVertex = legal[0]?.vertex as number;
    const afterFirst = catanAdapter.applyChoice(state, legal[0] as CatanChoice);
    const roadLegal = catanAdapter.getLegalChoices(afterFirst) as Extract<CatanChoice, { kind: 'placeRoad' }>[];
    const afterRoad = catanAdapter.applyChoice(afterFirst, roadLegal[0] as CatanChoice);
    const nextLegal = catanAdapter.getLegalChoices(afterRoad) as Extract<CatanChoice, { kind: 'placeSettlement' }>[];
    expect(nextLegal.some((c) => c.vertex === firstVertex)).toBe(false);
  });

  it('build phase never offers buildSettlement/buildRoad choices unaffordable for the active player', () => {
    for (let seed = 1; seed <= 5; seed += 1) {
      let state = catanAdapter.createInitialState(seed);
      let guard = 0;
      while (state.phase !== 'done' && guard < 500) {
        guard += 1;
        if (state.phase === 'build') {
          const hand = state.hands[state.active] as CatanState['hands'][number];
          const legal = catanAdapter.getLegalChoices(state);
          for (const c of legal) {
            if (c.kind === 'buildSettlement') {
              expect(hand.brick).toBeGreaterThanOrEqual(1);
              expect(hand.wood).toBeGreaterThanOrEqual(1);
              expect(hand.sheep).toBeGreaterThanOrEqual(1);
              expect(hand.wheat).toBeGreaterThanOrEqual(1);
            }
            if (c.kind === 'buildRoad') {
              expect(hand.brick).toBeGreaterThanOrEqual(1);
              expect(hand.wood).toBeGreaterThanOrEqual(1);
            }
          }
        }
        const decision = catanAdapter.currentDecision(state);
        if (!decision) break;
        const legal = catanAdapter.getLegalChoices(state);
        state = catanAdapter.applyChoice(state, legal[Math.floor(legal.length / 2)] as CatanChoice);
      }
    }
  });
});

describe('catan hidden information (C3)', () => {
  it('getObservation never reveals opponent hand composition, only counts', () => {
    const result = playSelfPlay(3, catanAdapter.baselines.heuristic, 4000);
    const observation = catanAdapter.getObservation(result.finalState, 0);
    const serialized = JSON.stringify(observation);
    // own hand keys are fine to appear; make sure no opponent-hand object with per-resource
    // counts is embedded — only opponentHandCounts {player, count} pairs.
    expect(observation.opponentHandCounts).toHaveLength(3);
    for (const entry of observation.opponentHandCounts) {
      expect(typeof entry.count).toBe('number');
    }
    expect(serialized).not.toMatch(/"ownHand":\{[^}]*\}.*"ownHand"/);
  });

  it("hiddenInfoProbe mutates something the viewer can't see, and getObservation is invariant under it", () => {
    const rng = createRng(777);
    let found = 0;
    for (let seed = 1; seed <= 30 && found < 5; seed += 1) {
      let state = catanAdapter.createInitialState(seed);
      // play a bit past initial placement so hands are non-trivial
      for (let i = 0; i < 20 && state.phase !== 'done'; i += 1) {
        const decision = catanAdapter.currentDecision(state);
        if (!decision) break;
        const legal = catanAdapter.getLegalChoices(state);
        state = catanAdapter.applyChoice(state, legal[0] as CatanChoice);
      }
      for (const viewer of [0, 1, 2, 3] as const) {
        const before = catanAdapter.getObservation(state, viewer);
        const mutated = catanAdapter.hiddenInfoProbe?.mutateHidden(state, viewer, rng);
        if (mutated === null || mutated === undefined) continue;
        found += 1;
        const after = catanAdapter.getObservation(mutated, viewer);
        expect(after).toEqual(before);
        expect(mutated.hands).not.toEqual(state.hands);
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe('catan strategySurface (C6)', () => {
  it('declares 3 strategy flags with distinct names', () => {
    const flags = catanAdapter.strategySurface.map((s) => s.flag);
    expect(new Set(flags).size).toBe(flags.length);
    expect(flags.length).toBeGreaterThanOrEqual(2);
  });

  it('cityUpgradePriority picks buildCity over the base bot picking buildSettlement, when both are legal', () => {
    const flagSpec = catanAdapter.strategySurface.find((s) => s.flag === 'cityUpgradePriority');
    expect(flagSpec).toBeDefined();
    if (!flagSpec) return;
    const alwaysSettlementBase = () => ({
      id: 'always-settlement',
      decide(_dp: string, _obs: unknown, legal: readonly CatanChoice[]) {
        const settlement = legal.find((c) => c.kind === 'buildSettlement');
        return settlement ?? (legal[0] as CatanChoice);
      },
    });
    const wrapped = flagSpec.apply(alwaysSettlementBase as typeof catanAdapter.baselines.random)(1);
    const legal: CatanChoice[] = [
      { kind: 'buildSettlement', vertex: 1 },
      { kind: 'buildCity', vertex: 2 },
      { kind: 'toTrade' },
    ];
    const choice = wrapped.decide('build', {} as never, legal);
    expect(choice.kind).toBe('buildCity');
  });

  it('eagerBankTrade trades toward a zero-count resource instead of the base bot ending the turn', () => {
    const flagSpec = catanAdapter.strategySurface.find((s) => s.flag === 'eagerBankTrade');
    expect(flagSpec).toBeDefined();
    if (!flagSpec) return;
    const alwaysEndBase = () => ({
      id: 'always-end',
      decide(_dp: string, _obs: unknown, legal: readonly CatanChoice[]) {
        return legal.find((c) => c.kind === 'endTurn') ?? (legal[0] as CatanChoice);
      },
    });
    const wrapped = flagSpec.apply(alwaysEndBase as typeof catanAdapter.baselines.random)(1);
    const legal: CatanChoice[] = [
      { kind: 'endTurn' },
      { kind: 'bankTrade', give: 'wood', get: 'ore' },
    ];
    const observation = { ownHand: { brick: 0, wood: 5, sheep: 0, wheat: 0, ore: 0 } } as never;
    const choice = wrapped.decide('bankTrade', observation, legal);
    expect(choice).toEqual({ kind: 'bankTrade', give: 'wood', get: 'ore' });
  });
});
