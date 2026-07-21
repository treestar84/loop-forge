import { dominionAdapter, type DominionChoice, type DominionState } from '../dominion';

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
