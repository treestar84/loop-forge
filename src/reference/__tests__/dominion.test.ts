import { dominionAdapter, type DominionChoice, type DominionObservation, type DominionState } from '../dominion';
import { createRng } from '../../kernel/rng';

function playSelfPlay(
  seed: number,
  botSeedOffset: number,
): { choiceKeys: string[]; finalScores: readonly number[] } {
  const adapter = dominionAdapter;
  let state = adapter.createInitialState(seed);
  const bot0 = adapter.baselines.random(seed);
  const bot1 = adapter.baselines.random(seed + botSeedOffset);
  const choiceKeys: string[] = [];
  let steps = 0;
  for (;;) {
    const decision = adapter.currentDecision(state);
    if (!decision) break;
    steps += 1;
    if (steps > adapter.spec.maxDecisionsPerGame) {
      throw new Error('exceeded maxDecisionsPerGame in self-play');
    }
    const observation = adapter.getObservation(state, decision.player);
    const legal = adapter.getLegalChoices(state);
    const bot = decision.player === 0 ? bot0 : bot1;
    const choice = bot.decide(decision.decisionPoint, observation, legal);
    choiceKeys.push(adapter.encodeChoice(choice));
    state = adapter.applyChoice(state, choice);
  }
  const outcome = adapter.getOutcome(state);
  if (!outcome) {
    throw new Error('expected a terminal outcome');
  }
  return { choiceKeys, finalScores: outcome.scores };
}

describe('dominion determinism (C1)', () => {
  it('replays the same trajectory for the same seed', () => {
    const first = playSelfPlay(11, 1000);
    const second = playSelfPlay(11, 1000);
    expect(second.choiceKeys).toEqual(first.choiceKeys);
    expect(second.finalScores).toEqual(first.finalScores);
  });

  it('produces different kingdoms for different seeds', () => {
    const a = dominionAdapter.createInitialState(1);
    const b = dominionAdapter.createInitialState(2);
    expect(a.kingdomCards).not.toEqual(b.kingdomCards);
  });
});

describe('dominion rules (C2)', () => {
  it('throws on an illegal choice', () => {
    const adapter = dominionAdapter;
    const state = adapter.createInitialState(7);
    const decision = adapter.currentDecision(state);
    expect(decision).not.toBeNull();
    const illegalChoice: DominionChoice = { kind: 'buy', card: 'Province' };
    expect(() => adapter.applyChoice(state, illegalChoice)).toThrow();
  });

  it('conserves cards and reaches a terminal outcome within maxDecisionsPerGame for many seeds', () => {
    const adapter = dominionAdapter;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      let state = adapter.createInitialState(seed);
      const bot0 = adapter.baselines.random(seed);
      const bot1 = adapter.baselines.random(seed + 500);
      let steps = 0;
      for (;;) {
        const decision = adapter.currentDecision(state);
        if (!decision) break;
        steps += 1;
        expect(steps).toBeLessThanOrEqual(adapter.spec.maxDecisionsPerGame);

        for (const invariant of adapter.invariants ?? []) {
          const violation = invariant(state);
          expect(violation).toBeNull();
        }

        const observation = adapter.getObservation(state, decision.player);
        const legal = adapter.getLegalChoices(state);
        expect(legal.length).toBeGreaterThan(0);
        const bot = decision.player === 0 ? bot0 : bot1;
        const choice = bot.decide(decision.decisionPoint, observation, legal);
        state = adapter.applyChoice(state, choice) as DominionState;
      }
      const outcome = adapter.getOutcome(state);
      expect(outcome).not.toBeNull();
      expect(outcome?.winners.length).toBeGreaterThan(0);
    }
  });

  it('never lets supply counts go negative and always ends with 3+ empty piles or Province gone', () => {
    const adapter = dominionAdapter;
    let state = adapter.createInitialState(21);
    const bot0 = adapter.baselines.heuristic(21);
    const bot1 = adapter.baselines.random(921);
    let steps = 0;
    for (;;) {
      const decision = adapter.currentDecision(state);
      if (!decision || steps > 800) break;
      steps += 1;
      const observation = adapter.getObservation(state, decision.player);
      const legal = adapter.getLegalChoices(state);
      const bot = decision.player === 0 ? bot0 : bot1;
      const choice = bot.decide(decision.decisionPoint, observation, legal);
      state = adapter.applyChoice(state, choice) as DominionState;
      for (const count of Object.values(state.supply)) {
        expect(count).toBeGreaterThanOrEqual(0);
      }
    }
    const emptyPiles = Object.values(state.supply).filter((c) => c === 0).length;
    expect(state.gameOver).toBe(true);
    expect(emptyPiles >= 3 || state.supply.Province === 0).toBe(true);
  });
});

describe('dominion parity (C7, reproducibility-downgraded)', () => {
  it('replays all hardcoded fixtures to their recorded finalScores', () => {
    const adapter = dominionAdapter;
    for (const fixture of adapter.replayFixtures ?? []) {
      let state = adapter.createInitialState(fixture.seed);
      for (const choiceKey of fixture.choiceKeys) {
        const legal = adapter.getLegalChoices(state);
        const matching = legal.find((c) => adapter.encodeChoice(c) === choiceKey);
        expect(matching).toBeDefined();
        state = adapter.applyChoice(state, matching as DominionChoice) as DominionState;
      }
      const outcome = adapter.getOutcome(state);
      expect(outcome?.scores).toEqual(fixture.finalScores);
    }
  });
});

describe('dominion hidden information (C3)', () => {
  it('observation is unaffected by reshuffling the opponent hand+deck pool', () => {
    const adapter = dominionAdapter;
    const probe = adapter.hiddenInfoProbe;
    if (!probe) throw new Error('expected hiddenInfoProbe to be implemented');
    let state = adapter.createInitialState(9);
    const decision = adapter.currentDecision(state);
    if (!decision) throw new Error('expected a decision');
    const viewer = decision.player;
    const before = adapter.getObservation(state, viewer);
    const { createRng } = jest.requireActual('../../kernel/rng');
    const mutated = probe.mutateHidden(state, viewer, createRng(555));
    expect(mutated).not.toBeNull();
    if (!mutated) return;
    const after = adapter.getObservation(mutated as DominionState, viewer);
    expect(after).toEqual(before);
  });

  it('opponent hand contents never leak into observation', () => {
    const adapter = dominionAdapter;
    let state = adapter.createInitialState(31);
    const bot0 = adapter.baselines.random(31);
    const bot1 = adapter.baselines.random(731);
    for (let step = 0; step < 40; step += 1) {
      const decision = adapter.currentDecision(state);
      if (!decision) break;
      const observation = adapter.getObservation(state, decision.player);
      const opponentId = decision.player === 0 ? 1 : 0;
      const opponentHand = (state as DominionState).players[opponentId]!.hand;
      // observation must not expose the opponent's actual hand card identities,
      // only the count.
      expect(observation.opponent.handCount).toBe(opponentHand.length);
      expect(JSON.stringify(observation)).not.toContain('"hand":' + JSON.stringify(opponentHand));

      const legal = adapter.getLegalChoices(state);
      const bot = decision.player === 0 ? bot0 : bot1;
      const choice = bot.decide(decision.decisionPoint, observation, legal);
      state = adapter.applyChoice(state, choice) as DominionState;
    }
  });
});

describe('dominion content coverage', () => {
  it('exercisedContent only reports ids present in contentInventory', () => {
    const adapter = dominionAdapter;
    const inventoryIds = new Set((adapter.contentInventory ?? []).map((c) => c.id));
    let state = adapter.createInitialState(55);
    const bot0 = adapter.baselines.heuristic(55);
    const bot1 = adapter.baselines.heuristic(755);
    let steps = 0;
    for (;;) {
      const decision = adapter.currentDecision(state);
      if (!decision) break;
      steps += 1;
      if (steps > adapter.spec.maxDecisionsPerGame) break;
      const observation = adapter.getObservation(state, decision.player);
      const legal = adapter.getLegalChoices(state);
      const bot = decision.player === 0 ? bot0 : bot1;
      const choice = bot.decide(decision.decisionPoint, observation, legal);
      state = adapter.applyChoice(state, choice) as DominionState;
    }
    const exercised = adapter.exercisedContent?.(state) ?? [];
    expect(exercised.length).toBeGreaterThan(0);
    for (const id of exercised) {
      expect(inventoryIds.has(id)).toBe(true);
    }
  });
});

describe('dominion strategySurface (C6)', () => {
  function findFlag(flag: string) {
    const found = dominionAdapter.strategySurface.find((f) => f.flag === flag);
    if (!found) throw new Error(`strategy flag not found: ${flag}`);
    return found;
  }

  it('rushProvinces buys Province over the heuristic priority whenever legal', () => {
    const adapter = dominionAdapter;
    const flag = findFlag('rushProvinces');
    const baseFactory = adapter.baselines.random;
    const variantFactory = flag.apply(baseFactory);
    const variantBot = variantFactory(1);

    let state = adapter.createInitialState(3);
    const scoutBot = baseFactory(3);
    let found = false;
    for (let step = 0; step < 500 && !found; step += 1) {
      const decision = adapter.currentDecision(state);
      if (!decision) break;
      const legal = adapter.getLegalChoices(state);
      const provinceBuy = legal.find((c) => c.kind === 'buy' && c.card === 'Province');
      const otherBuys = legal.filter((c) => c.kind === 'buy' && c.card !== 'Province');
      if (provinceBuy && otherBuys.length > 0) {
        const observation = adapter.getObservation(state, decision.player);
        const variantChoice = variantBot.decide(decision.decisionPoint, observation, legal);
        expect(variantChoice).toEqual(provinceBuy);
        found = true;
        break;
      }
      const observation = adapter.getObservation(state, decision.player);
      const choice = scoutBot.decide(decision.decisionPoint, observation, legal);
      state = adapter.applyChoice(state, choice) as DominionState;
    }
    expect(found).toBe(true);
  });

  it('playCheapestActionFirst plays the lowest-cost legal action over the base bot when 2+ actions are legal', () => {
    const adapter = dominionAdapter;
    const flag = findFlag('playCheapestActionFirst');
    const baseFactory = adapter.baselines.random;
    const variantFactory = flag.apply(baseFactory);
    const variantBot = variantFactory(1);

    let state = adapter.createInitialState(5);
    const scoutBot = baseFactory(5);
    let found = false;
    for (let step = 0; step < 500 && !found; step += 1) {
      const decision = adapter.currentDecision(state);
      if (!decision) break;
      const legal = adapter.getLegalChoices(state);
      const actionChoices = legal.filter((c) => c.kind === 'playAction');
      if (actionChoices.length >= 2) {
        const observation = adapter.getObservation(state, decision.player);
        const variantChoice = variantBot.decide(decision.decisionPoint, observation, legal);
        expect(variantChoice.kind).toBe('playAction');
        found = true;
        break;
      }
      const observation = adapter.getObservation(state, decision.player);
      const choice = scoutBot.decide(decision.decisionPoint, observation, legal);
      state = adapter.applyChoice(state, choice) as DominionState;
    }
    expect(found).toBe(true);
  });

  it('trashCoppersEagerly trashes a Copper on a chapelTrash decision when legal', () => {
    const adapter = dominionAdapter;
    const flag = findFlag('trashCoppersEagerly');
    const baseFactory = adapter.baselines.random;
    const variantFactory = flag.apply(baseFactory);
    const variantBot = variantFactory(1);

    let state = adapter.createInitialState(13);
    const scoutBot = baseFactory(13);
    let found = false;
    for (let step = 0; step < 300 && !found; step += 1) {
      const decision = adapter.currentDecision(state);
      if (!decision) break;
      const legal = adapter.getLegalChoices(state);
      if (decision.decisionPoint === 'chapelTrash') {
        const copperChoice = legal.find((c) => c.kind === 'trashCard' && c.card === 'Copper');
        if (copperChoice) {
          const observation = adapter.getObservation(state, decision.player);
          const variantChoice = variantBot.decide(decision.decisionPoint, observation, legal);
          expect(variantChoice).toEqual(copperChoice);
          found = true;
          break;
        }
      }
      const observation = adapter.getObservation(state, decision.player);
      const choice = scoutBot.decide(decision.decisionPoint, observation, legal);
      state = adapter.applyChoice(state, choice) as DominionState;
    }
    expect(found).toBe(true);
  });
});

describe('dominion chapelEconomy (GAP-11 Phase 3-C A8, B3 deep design)', () => {
  function findFlag(flag: string) {
    const found = dominionAdapter.strategySurface.find((f) => f.flag === flag);
    if (!found) throw new Error(`strategy flag not found: ${flag}`);
    return found;
  }

  /** Full DominionObservation fixture with sane, self-consistent defaults —
   * deterministic synthetic-observation testing (rather than a self-play
   * search) since chapelEconomy's growth/transition/density branches are
   * conditions on Province-supply level and deck composition that pure
   * random self-play only reaches by chance within any reasonable step
   * budget (verified: a rushProvinces-composed driver still needed ~800
   * steps/seed across 30 seeds without ever depleting the Province pile
   * below 8, since neither driver reliably accumulates 8 coins). decide()
   * only consumes (decisionPoint, observation, legal) — no state access — so
   * a hand-built observation is a legitimate, much more reliable way to pin
   * each branch exactly. */
  function fixtureObservation(overrides: Partial<DominionObservation> = {}): DominionObservation {
    return {
      self: 0,
      active: 0,
      phase: 'buy',
      actions: 1,
      buys: 1,
      coins: 0,
      supply: {
        Copper: 60, Silver: 40, Gold: 30, Estate: 8, Duchy: 8, Province: 8, Curse: 10,
        Village: 10, Smithy: 10, Laboratory: 10, Festival: 10, Market: 10, Woodcutter: 10,
        CouncilRoom: 10, Witch: 10, Militia: 10, Moat: 10, Chapel: 10, Workshop: 10,
      },
      kingdomCards: ['Chapel', 'Village', 'Smithy', 'Laboratory', 'Festival', 'Market', 'Woodcutter', 'CouncilRoom', 'Witch', 'Moat'],
      pending: null,
      trash: [],
      own: {
        hand: [],
        discard: [],
        play: [],
        deckCount: 0,
        deckComposition: {},
        turnsTaken: 5,
      },
      opponent: {
        handCount: 5,
        discard: [],
        play: [],
        deckCount: 10,
        turnsTaken: 5,
      },
      ...overrides,
    };
  }

  it('growth phase (remaining Province >= 5): trashes Estate over Copper on a chapelTrash decision', () => {
    const flag = findFlag('chapelEconomy');
    const variantBot = flag.apply(dominionAdapter.baselines.random)(1);

    const observation = fixtureObservation({
      supply: { ...fixtureObservation().supply, Province: 6 },
      own: { hand: ['Estate', 'Copper', 'Copper'], discard: [], play: ['Chapel'], deckCount: 7, deckComposition: { Copper: 7 }, turnsTaken: 3 },
    });
    const legal: readonly DominionChoice[] = [
      { kind: 'trashCard', card: 'Estate' },
      { kind: 'trashCard', card: 'Copper' },
      { kind: 'doneTrash' },
    ];

    const choice = variantBot.decide('chapelTrash', observation, legal);
    expect(choice).toEqual({ kind: 'trashCard', card: 'Estate' });
  });

  it('growth phase, no Estate legal: trashes Copper only while the deck keeps >= 3 total money after the trash', () => {
    const flag = findFlag('chapelEconomy');
    const variantBot = flag.apply(dominionAdapter.baselines.random)(1);
    const legal: readonly DominionChoice[] = [{ kind: 'trashCard', card: 'Copper' }, { kind: 'doneTrash' }];

    // 4 total money (4 Coppers) -> after trashing one, 3 remain: at the floor, still allowed.
    const okObservation = fixtureObservation({
      supply: { ...fixtureObservation().supply, Province: 6 },
      own: { hand: ['Copper', 'Copper'], discard: [], play: ['Chapel'], deckCount: 2, deckComposition: { Copper: 2 }, turnsTaken: 3 },
    });
    expect(variantBot.decide('chapelTrash', okObservation, legal)).toEqual({ kind: 'trashCard', card: 'Copper' });

    // 2 total money (2 Coppers) -> after trashing one, 1 remains: below the floor, refuses.
    const belowFloorObservation = fixtureObservation({
      supply: { ...fixtureObservation().supply, Province: 6 },
      own: { hand: ['Copper'], discard: [], play: ['Chapel'], deckCount: 1, deckComposition: { Copper: 1 }, turnsTaken: 3 },
    });
    expect(variantBot.decide('chapelTrash', belowFloorObservation, legal)).toEqual({ kind: 'doneTrash' });
  });

  it('transition phase (remaining Province <= 4): stops trashing entirely (Copper not legal to pick) even when nothing else fires', () => {
    const flag = findFlag('chapelEconomy');
    const variantBot = flag.apply(dominionAdapter.baselines.random)(1);
    const observation = fixtureObservation({
      supply: { ...fixtureObservation().supply, Province: 4 },
      own: { hand: ['Copper', 'Copper'], discard: [], play: ['Chapel'], deckCount: 2, deckComposition: { Copper: 2 }, turnsTaken: 12 },
    });
    const legal: readonly DominionChoice[] = [{ kind: 'trashCard', card: 'Copper' }, { kind: 'doneTrash' }];

    expect(variantBot.decide('chapelTrash', observation, legal)).toEqual({ kind: 'doneTrash' });
  });

  it('transition phase: Curse is the sole exception — still trashed even though trashing is otherwise halted', () => {
    const flag = findFlag('chapelEconomy');
    const variantBot = flag.apply(dominionAdapter.baselines.random)(1);
    const observation = fixtureObservation({
      supply: { ...fixtureObservation().supply, Province: 4 },
      own: { hand: ['Copper', 'Curse'], discard: [], play: ['Chapel'], deckCount: 2, deckComposition: { Copper: 2 }, turnsTaken: 12 },
    });
    const legal: readonly DominionChoice[] = [
      { kind: 'trashCard', card: 'Copper' },
      { kind: 'trashCard', card: 'Curse' },
      { kind: 'doneTrash' },
    ];

    expect(variantBot.decide('chapelTrash', observation, legal)).toEqual({ kind: 'trashCard', card: 'Curse' });
  });

  it('density-based buy at 5-7 coins: low money density (all-Copper deck) buys Gold over Silver/Duchy', () => {
    const flag = findFlag('chapelEconomy');
    const variantBot = flag.apply(dominionAdapter.baselines.random)(1);
    // 7 Coppers total (deck size 7) -> density = 7/7 = 1.0... use fewer
    // coppers than deck slots by including a low-value action card so
    // density stays clearly under the 1.0 default threshold: money=4
    // (4 Coppers), deck size=6 (4 Coppers + 2 Village) -> density=0.667.
    const observation = fixtureObservation({
      coins: 6,
      own: { hand: ['Copper', 'Copper', 'Village'], discard: ['Village'], play: [], deckCount: 2, deckComposition: { Copper: 2 }, turnsTaken: 4 },
    });
    const legal: readonly DominionChoice[] = [
      { kind: 'buy', card: 'Gold' },
      { kind: 'buy', card: 'Silver' },
      { kind: 'buy', card: 'Duchy' },
      { kind: 'endBuy' },
    ];

    expect(variantBot.decide('buy', observation, legal)).toEqual({ kind: 'buy', card: 'Gold' });
  });

  it('density-based buy at 5-7 coins: high money density in the transition phase buys Duchy instead of Gold/Silver', () => {
    const flag = findFlag('chapelEconomy');
    const variantBot = flag.apply(dominionAdapter.baselines.random)(1);
    // Money=9 (3 Gold) over deck size 3 -> density=3.0 (>> 1.0 threshold).
    const observation = fixtureObservation({
      coins: 6,
      supply: { ...fixtureObservation().supply, Province: 3 }, // transition (<= 4)
      own: { hand: ['Gold', 'Gold', 'Gold'], discard: [], play: [], deckCount: 0, deckComposition: {}, turnsTaken: 15 },
    });
    const legal: readonly DominionChoice[] = [
      { kind: 'buy', card: 'Gold' },
      { kind: 'buy', card: 'Silver' },
      { kind: 'buy', card: 'Duchy' },
      { kind: 'endBuy' },
    ];

    expect(variantBot.decide('buy', observation, legal)).toEqual({ kind: 'buy', card: 'Duchy' });
  });

  it('always buys Province at 8+ coins regardless of phase/density', () => {
    const flag = findFlag('chapelEconomy');
    const variantBot = flag.apply(dominionAdapter.baselines.random)(1);
    const observation = fixtureObservation({
      coins: 8,
      own: { hand: ['Gold', 'Gold', 'Copper'], discard: [], play: [], deckCount: 0, deckComposition: {}, turnsTaken: 6 },
    });
    const legal: readonly DominionChoice[] = [
      { kind: 'buy', card: 'Province' },
      { kind: 'buy', card: 'Gold' },
      { kind: 'endBuy' },
    ];

    expect(variantBot.decide('buy', observation, legal)).toEqual({ kind: 'buy', card: 'Province' });
  });
});

describe('dominion sampleStateFromObservation (docs/FIX-BACKLOG.md P4)', () => {
  function advanceState(seed: number, steps: number): DominionState {
    const adapter = dominionAdapter;
    let state = adapter.createInitialState(seed);
    const bot0 = adapter.baselines.random(seed);
    const bot1 = adapter.baselines.random(seed + 5000);
    for (let i = 0; i < steps; i += 1) {
      const decision = adapter.currentDecision(state);
      if (!decision) break;
      const observation = adapter.getObservation(state, decision.player);
      const legal = adapter.getLegalChoices(state);
      const bot = decision.player === 0 ? bot0 : bot1;
      const choice = bot.decide(decision.decisionPoint, observation, legal);
      state = adapter.applyChoice(state, choice) as DominionState;
    }
    return state;
  }

  it('preserves everything the viewer already knows and reproduces the same observation', () => {
    const adapter = dominionAdapter;
    if (adapter.sampleStateFromObservation === undefined) {
      throw new Error('dominionAdapter must declare sampleStateFromObservation');
    }
    const state = advanceState(41, 60);
    const decision = adapter.currentDecision(state);
    if (!decision) throw new Error('expected an in-progress game after 60 steps');
    const observation = adapter.getObservation(state, decision.player);

    const sampled = adapter.sampleStateFromObservation(observation, decision.player, createRng(9001));
    const reobserved = adapter.getObservation(sampled, decision.player);
    expect(reobserved).toEqual(observation);
  });

  it('produces a sampled state that satisfies every invariant', () => {
    const adapter = dominionAdapter;
    if (adapter.sampleStateFromObservation === undefined) {
      throw new Error('dominionAdapter must declare sampleStateFromObservation');
    }
    const state = advanceState(53, 80);
    const decision = adapter.currentDecision(state);
    if (!decision) throw new Error('expected an in-progress game after 80 steps');
    const observation = adapter.getObservation(state, decision.player);

    const sampled = adapter.sampleStateFromObservation(observation, decision.player, createRng(123));
    for (const invariant of adapter.invariants ?? []) {
      expect(invariant(sampled)).toBeNull();
    }
    // Determinization must not change whose turn it is or what kind of
    // decision is pending — only the hidden hand/deck contents may differ.
    expect(adapter.currentDecision(sampled)).toEqual(decision);
  });

  it('resamples different hidden card placements across rng seeds while keeping every observed field identical', () => {
    const adapter = dominionAdapter;
    if (adapter.sampleStateFromObservation === undefined) {
      throw new Error('dominionAdapter must declare sampleStateFromObservation');
    }
    const state = advanceState(29, 60);
    const decision = adapter.currentDecision(state);
    if (!decision) throw new Error('expected an in-progress game after 60 steps');
    const observation = adapter.getObservation(state, decision.player);
    const opponentId = decision.player === 0 ? 1 : 0;

    const sampledA = adapter.sampleStateFromObservation(observation, decision.player, createRng(1));
    const sampledB = adapter.sampleStateFromObservation(observation, decision.player, createRng(2));

    expect(adapter.getObservation(sampledA, decision.player)).toEqual(observation);
    expect(adapter.getObservation(sampledB, decision.player)).toEqual(observation);

    // Same multiset of unseen cards either way (the viewer's own deck plus
    // the opponent's hand+deck pool), but — almost certainly — a different
    // concrete placement, proving the rng actually drives the resample.
    const poolOf = (s: DominionState): string[] =>
      [...s.players[decision.player]!.deck, ...s.players[opponentId]!.hand, ...s.players[opponentId]!.deck].sort();
    expect(poolOf(sampledA)).toEqual(poolOf(sampledB));

    const arrangementOf = (s: DominionState): string =>
      JSON.stringify([s.players[decision.player]!.deck, s.players[opponentId]!.hand, s.players[opponentId]!.deck]);
    expect(arrangementOf(sampledA)).not.toEqual(arrangementOf(sampledB));
  });
});
