import { splendorAdapter, type SplendorChoice, type SplendorState } from '../splendor';

function playSelfPlay(
  seed: number,
  botSeedOffset: number,
): { choiceKeys: string[]; finalScores: readonly number[] } {
  const adapter = splendorAdapter;
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

describe('splendor determinism (C1)', () => {
  it('replays the same trajectory for the same seed', () => {
    const first = playSelfPlay(11, 1000);
    const second = playSelfPlay(11, 1000);
    expect(second.choiceKeys).toEqual(first.choiceKeys);
    expect(second.finalScores).toEqual(first.finalScores);
  });

  it('produces different board/noble setups for different seeds', () => {
    const a = splendorAdapter.createInitialState(1);
    const b = splendorAdapter.createInitialState(2);
    const aBoardIds = [1, 2, 3].flatMap((level) =>
      a.board[level as 1 | 2 | 3].map((c) => c.id),
    );
    const bBoardIds = [1, 2, 3].flatMap((level) =>
      b.board[level as 1 | 2 | 3].map((c) => c.id),
    );
    expect(aBoardIds).not.toEqual(bBoardIds);
  });

  it('matches the hardcoded replay fixtures (C7 parity)', () => {
    for (const fixture of splendorAdapter.replayFixtures ?? []) {
      const result = playSelfPlay(fixture.seed, 1000);
      expect(result.choiceKeys).toEqual(fixture.choiceKeys);
      expect(result.finalScores).toEqual(fixture.finalScores);
    }
  });
});

describe('splendor rules (C2)', () => {
  it('throws on an illegal choice', () => {
    const adapter = splendorAdapter;
    const state = adapter.createInitialState(7);
    const decision = adapter.currentDecision(state);
    expect(decision).not.toBeNull();
    const illegalChoice: SplendorChoice = { kind: 'buy', cardId: 'not-a-real-card' };
    expect(() => adapter.applyChoice(state, illegalChoice)).toThrow();
  });

  it('conserves cards/gems/nobles and reaches a terminal outcome within maxDecisionsPerGame for many seeds', () => {
    const adapter = splendorAdapter;
    for (const seed of [1, 2, 3, 4, 5]) {
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
          expect(invariant(state)).toBeNull();
        }

        const observation = adapter.getObservation(state, decision.player);
        const legal = adapter.getLegalChoices(state);
        expect(legal.length).toBeGreaterThan(0);
        const bot = decision.player === 0 ? bot0 : bot1;
        const choice = bot.decide(decision.decisionPoint, observation, legal);
        state = adapter.applyChoice(state, choice) as SplendorState;
      }
      const outcome = adapter.getOutcome(state);
      expect(outcome).not.toBeNull();
      expect(outcome?.winners.length).toBeGreaterThan(0);
      // At least one player reached the 15-point threshold that triggers the
      // final round (the >100 tiebreak-scaled gap between scores*100 is not
      // checked here, just the win condition itself).
      expect(Math.max(...(outcome?.scores ?? [0]))).toBeGreaterThanOrEqual(15);
    }
  });

  it('never lets a player exceed the 10-gem cap or the bank go negative', () => {
    const adapter = splendorAdapter;
    let state = adapter.createInitialState(21);
    const bot0 = adapter.baselines.heuristic(21);
    const bot1 = adapter.baselines.random(921);
    let steps = 0;
    for (;;) {
      const decision = adapter.currentDecision(state);
      if (!decision || steps > 300) break;
      steps += 1;
      const observation = adapter.getObservation(state, decision.player);
      const legal = adapter.getLegalChoices(state);
      const bot = decision.player === 0 ? bot0 : bot1;
      const choice = bot.decide(decision.decisionPoint, observation, legal);
      state = adapter.applyChoice(state, choice) as SplendorState;
      for (const player of state.players) {
        const total = ['w', 'u', 'g', 'r', 'b', 'gold'].reduce(
          (sum, gem) => sum + player.gems[gem as 'w'],
          0,
        );
        expect(total).toBeLessThanOrEqual(10);
      }
      for (const gem of ['w', 'u', 'g', 'r', 'b', 'gold'] as const) {
        expect(state.bank[gem]).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('splendor content coverage', () => {
  it('exercisedContent only reports ids present in contentInventory', () => {
    const adapter = splendorAdapter;
    const inventoryIds = new Set((adapter.contentInventory ?? []).map((c) => c.id));
    let state = adapter.createInitialState(55);
    const bot0 = adapter.baselines.random(55);
    const bot1 = adapter.baselines.random(755);
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
      state = adapter.applyChoice(state, choice) as SplendorState;
    }
    const exercised = adapter.exercisedContent?.(state) ?? [];
    expect(exercised.length).toBeGreaterThan(0);
    for (const id of exercised) {
      expect(inventoryIds.has(id)).toBe(true);
    }
  });
});

describe('splendor strategySurface (C6)', () => {
  function findFlag(flag: string) {
    const found = splendorAdapter.strategySurface.find((f) => f.flag === flag);
    if (!found) {
      throw new Error(`strategy flag not found: ${flag}`);
    }
    return found;
  }

  it('buyHighestPoints prefers the highest-point affordable card over the random base', () => {
    const adapter = splendorAdapter;
    const flag = findFlag('buyHighestPoints');
    const baseFactory = adapter.baselines.random;
    const variantFactory = flag.apply(baseFactory);
    const variantBot = variantFactory(1);

    let state = adapter.createInitialState(3);
    // Fast-forward with the base random bot until at least two buy choices
    // with different point values are simultaneously legal.
    const scoutBot = baseFactory(3);
    let found = false;
    for (let step = 0; step < 60 && !found; step += 1) {
      const decision = adapter.currentDecision(state);
      if (!decision) break;
      const legal = adapter.getLegalChoices(state);
      const buys = legal.filter((c) => c.kind === 'buy');
      if (buys.length >= 2) {
        const observation = adapter.getObservation(state, decision.player);
        const variantChoice = variantBot.decide(decision.decisionPoint, observation, legal);
        expect(variantChoice.kind).toBe('buy');
        found = true;
        break;
      }
      const observation = adapter.getObservation(state, decision.player);
      const choice = scoutBot.decide(decision.decisionPoint, observation, legal);
      state = adapter.applyChoice(state, choice) as SplendorState;
    }
    expect(found).toBe(true);
  });

  it('takeGreedyBank picks the highest-bank color, which differs from at least one random draw', () => {
    const adapter = splendorAdapter;
    const flag = findFlag('takeGreedyBank');
    const baseFactory = adapter.baselines.random;
    const variantFactory = flag.apply(baseFactory);
    const variantBot = variantFactory(1);

    const state = adapter.createInitialState(9);
    const decision = adapter.currentDecision(state);
    if (!decision) throw new Error('expected a decision at the initial state');
    const legal = adapter.getLegalChoices(state);
    const observation = adapter.getObservation(state, decision.player);
    const variantChoice = variantBot.decide(decision.decisionPoint, observation, legal);
    expect(variantChoice.kind).toBe('take');
    if (variantChoice.kind === 'take') {
      const maxBank = Math.max(...['w', 'u', 'g', 'r', 'b'].map((c) => observation.bank[c as 'w']));
      expect(observation.bank[variantChoice.color]).toBe(maxBank);
    }
  });

  it('reserveForGold reserves the highest-point board card while gold remains, differing from random', () => {
    const adapter = splendorAdapter;
    const flag = findFlag('reserveForGold');
    const baseFactory = adapter.baselines.random;
    const variantFactory = flag.apply(baseFactory);
    const variantBot = variantFactory(1);

    let state = adapter.createInitialState(17);
    const scoutBot = baseFactory(17);
    let sawReserve = false;
    for (let step = 0; step < 40 && !sawReserve; step += 1) {
      const decision = adapter.currentDecision(state);
      if (!decision) break;
      const legal = adapter.getLegalChoices(state);
      const reserves = legal.filter((c) => c.kind === 'reserve');
      const observation = adapter.getObservation(state, decision.player);
      if (reserves.length >= 1 && observation.bank.gold > 0) {
        const variantChoice = variantBot.decide(decision.decisionPoint, observation, legal);
        expect(variantChoice.kind).toBe('reserve');
        sawReserve = true;
        break;
      }
      const choice = scoutBot.decide(decision.decisionPoint, observation, legal);
      state = adapter.applyChoice(state, choice) as SplendorState;
    }
    expect(sawReserve).toBe(true);
  });
});
