import { createRng } from '../../kernel/rng';
import {
  hearthstoneAdapter,
  type CardInstance,
  type HearthstoneChoice,
  type HearthstonePlayerState,
  type HearthstoneState,
  type MinionInstance,
} from '../hearthstone';

function playSelfPlay(
  seed: number,
  botSeedOffset: number,
): { choiceKeys: string[]; finalScores: readonly number[]; steps: number } {
  const adapter = hearthstoneAdapter;
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
    state = adapter.applyChoice(state, choice) as HearthstoneState;
  }
  const outcome = adapter.getOutcome(state);
  if (!outcome) {
    throw new Error('expected a terminal outcome');
  }
  return { choiceKeys, finalScores: outcome.scores, steps };
}

function minion(overrides: Partial<MinionInstance> & Pick<MinionInstance, 'instanceId' | 'defId'>): MinionInstance {
  return {
    attack: 1,
    health: 1,
    maxHealth: 1,
    summoningSick: false,
    hasAttacked: false,
    ...overrides,
  };
}

function card(instanceId: string, defId: string): CardInstance {
  return { instanceId, defId };
}

function player(overrides: Partial<HearthstonePlayerState> = {}): HearthstonePlayerState {
  return {
    hero: { health: 30 },
    hand: [],
    deck: [],
    board: [],
    manaMax: 10,
    manaCurrent: 10,
    fatigue: 0,
    heroPowerUsed: false,
    graveyard: [],
    ...overrides,
  };
}

function customState(
  players: readonly [HearthstonePlayerState, HearthstonePlayerState],
  overrides: Partial<HearthstoneState> = {},
): HearthstoneState {
  return {
    players,
    active: 0,
    turnNumber: 5,
    gameOver: false,
    playedCardIds: [],
    usedHeroPower: false,
    ...overrides,
  };
}

describe('hearthstone determinism (C1)', () => {
  it('replays the same trajectory for the same seed', () => {
    const first = playSelfPlay(11, 1000);
    const second = playSelfPlay(11, 1000);
    expect(second.choiceKeys).toEqual(first.choiceKeys);
    expect(second.finalScores).toEqual(first.finalScores);
  });

  it('matches the hardcoded replay fixtures (C7 parity)', () => {
    for (const fixture of hearthstoneAdapter.replayFixtures ?? []) {
      const result = playSelfPlay(fixture.seed, 1000);
      expect(result.choiceKeys).toEqual(fixture.choiceKeys);
      expect(result.finalScores).toEqual(fixture.finalScores);
    }
  });
});

describe('hearthstone rules (C2)', () => {
  it('throws on an illegal choice', () => {
    const adapter = hearthstoneAdapter;
    const state = adapter.createInitialState(7);
    const decision = adapter.currentDecision(state);
    expect(decision).not.toBeNull();
    const illegalChoice: HearthstoneChoice = { kind: 'attack', attackerId: 'nope', targetId: 'hero:1' };
    expect(() => adapter.applyChoice(state, illegalChoice)).toThrow();
  });

  it('reaches a terminal outcome within maxDecisionsPerGame while all invariants hold', () => {
    const adapter = hearthstoneAdapter;
    let state = adapter.createInitialState(99);
    const bot0 = adapter.baselines.random(99);
    const bot1 = adapter.baselines.random(199);
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
      state = adapter.applyChoice(state, choice) as HearthstoneState;
    }
    for (const invariant of adapter.invariants ?? []) {
      expect(invariant(state)).toBeNull();
    }
    const outcome = adapter.getOutcome(state);
    expect(outcome).not.toBeNull();
  });

  it('a newly summoned non-charge minion cannot attack the same turn; charge minions can', () => {
    const adapter = hearthstoneAdapter;
    const state = customState([
      player({
        hand: [card('h-boar', 'stonetusk-boar'), card('h-croc', 'river-crocolisk')],
        manaCurrent: 5,
        manaMax: 5,
      }),
      player(),
    ]);
    const legal = adapter.getLegalChoices(state);
    const playBoar = legal.find(
      (c) => c.kind === 'play' && c.cardInstanceId === 'h-boar',
    ) as Extract<HearthstoneChoice, { kind: 'play' }>;
    const afterBoar = adapter.applyChoice(state, playBoar) as HearthstoneState;
    const boarChoices = adapter.getLegalChoices(afterBoar);
    expect(boarChoices.some((c) => c.kind === 'attack' && c.attackerId === 'h-boar')).toBe(true);

    const playCroc = adapter.getLegalChoices(afterBoar).find(
      (c) => c.kind === 'play' && c.cardInstanceId === 'h-croc',
    ) as Extract<HearthstoneChoice, { kind: 'play' }>;
    const afterCroc = adapter.applyChoice(afterBoar, playCroc) as HearthstoneState;
    const crocChoices = adapter.getLegalChoices(afterCroc);
    expect(crocChoices.some((c) => c.kind === 'attack' && c.attackerId === 'h-croc')).toBe(false);
  });

  it('combat deals mutual damage between minions and removes the dead one', () => {
    const adapter = hearthstoneAdapter;
    const state = customState([
      player({ board: [minion({ instanceId: 'm0', defId: 'river-crocolisk', attack: 2, health: 3, maxHealth: 3 })] }),
      player({ board: [minion({ instanceId: 'm1', defId: 'stonetusk-boar', attack: 1, health: 1, maxHealth: 1 })] }),
    ]);
    const choice: HearthstoneChoice = { kind: 'attack', attackerId: 'm0', targetId: 'm1' };
    const next = adapter.applyChoice(state, choice) as HearthstoneState;
    expect(next.players[1].board).toHaveLength(0); // 1hp boar dies to 2 damage
    const attacker = next.players[0].board.find((m) => m.instanceId === 'm0');
    expect(attacker?.health).toBe(2); // took 1 damage back from the boar
    expect(attacker?.hasAttacked).toBe(true);
  });

  it('attacking the enemy hero directly deals damage with no retaliation', () => {
    const adapter = hearthstoneAdapter;
    const state = customState([
      player({ board: [minion({ instanceId: 'm0', defId: 'chillwind-yeti', attack: 4, health: 5, maxHealth: 5 })] }),
      player({ hero: { health: 30 } }),
    ]);
    const choice: HearthstoneChoice = { kind: 'attack', attackerId: 'm0', targetId: 'hero:1' };
    const next = adapter.applyChoice(state, choice) as HearthstoneState;
    expect(next.players[1].hero.health).toBe(26);
    expect(next.players[0].board[0]?.health).toBe(5); // unharmed, hero doesn't retaliate
  });

  it('battlecry damageEnemy requires a target choice and applies the damage', () => {
    const adapter = hearthstoneAdapter;
    const state = customState([
      player({ hand: [card('h-archer', 'elven-archer')], manaCurrent: 1, manaMax: 1 }),
      player({ hero: { health: 30 } }),
    ]);
    const legal = adapter.getLegalChoices(state);
    const playToFace = legal.find(
      (c) => c.kind === 'play' && c.cardInstanceId === 'h-archer' && c.targetId === 'hero:1',
    );
    expect(playToFace).toBeDefined();
    const next = adapter.applyChoice(state, playToFace as HearthstoneChoice) as HearthstoneState;
    expect(next.players[1].hero.health).toBe(29);
    expect(next.players[0].board).toHaveLength(1);
  });

  it('battlecry buffFriendlyMinion offers no target choice when the board is empty, and buffs when a target exists', () => {
    const adapter = hearthstoneAdapter;
    const emptyBoardState = customState([
      player({ hand: [card('h-cleric', 'shattered-sun-cleric')], manaCurrent: 3, manaMax: 3 }),
      player(),
    ]);
    const legalEmpty = adapter.getLegalChoices(emptyBoardState);
    const playChoices = legalEmpty.filter((c) => c.kind === 'play' && c.cardInstanceId === 'h-cleric');
    expect(playChoices).toHaveLength(1);
    expect((playChoices[0] as Extract<HearthstoneChoice, { kind: 'play' }>).targetId).toBeUndefined();

    const withFriendlyState = customState([
      player({
        hand: [card('h-cleric', 'shattered-sun-cleric')],
        board: [minion({ instanceId: 'm-friend', defId: 'river-crocolisk', attack: 2, health: 3, maxHealth: 3 })],
        manaCurrent: 3,
        manaMax: 3,
      }),
      player(),
    ]);
    const legalWithFriendly = adapter.getLegalChoices(withFriendlyState);
    const buffChoice = legalWithFriendly.find(
      (c) => c.kind === 'play' && c.cardInstanceId === 'h-cleric' && c.targetId === 'm-friend',
    );
    expect(buffChoice).toBeDefined();
    const next = adapter.applyChoice(withFriendlyState, buffChoice as HearthstoneChoice) as HearthstoneState;
    const buffed = next.players[0].board.find((m) => m.instanceId === 'm-friend');
    expect(buffed?.attack).toBe(3);
    expect(buffed?.health).toBe(4);
  });

  it('fatigue damages the hero with an increasing counter once the deck is empty', () => {
    const adapter = hearthstoneAdapter;
    const state = customState([
      player({ deck: [], fatigue: 1, hero: { health: 30 } }),
      player(),
    ]);
    const choice: HearthstoneChoice = { kind: 'endTurn' };
    // active is 0; endTurn advances to player 1 who draws. Flip active to 1
    // so player 0 (the fatigued one) is the one drawing on the next endTurn.
    const flipped: HearthstoneState = { ...state, active: 1 };
    const next = adapter.applyChoice(flipped, choice) as HearthstoneState;
    expect(next.players[0].fatigue).toBe(2);
    expect(next.players[0].hero.health).toBe(28);
  });

  it('drawing beyond the 10-card hand cap burns the card instead of adding it', () => {
    const adapter = hearthstoneAdapter;
    const fullHand = Array.from({ length: 10 }, (_, i) => card(`h${i}`, 'stonetusk-boar'));
    const state = customState([
      player({ hand: fullHand, deck: [card('d0', 'war-golem')] }),
      player(),
    ]);
    const flipped: HearthstoneState = { ...state, active: 1 };
    const next = adapter.applyChoice(flipped, { kind: 'endTurn' }) as HearthstoneState;
    expect(next.players[0].hand).toHaveLength(10);
    expect(next.players[0].deck).toHaveLength(0); // still drawn/removed from deck, just burned
    expect(next.players[0].graveyard).toEqual([card('d0', 'war-golem')]); // burned card is tracked, not vanished
  });

  it('the board cannot exceed 7 minions', () => {
    const adapter = hearthstoneAdapter;
    const fullBoard = Array.from({ length: 7 }, (_, i) =>
      minion({ instanceId: `b${i}`, defId: 'stonetusk-boar', attack: 1, health: 1, maxHealth: 1 }),
    );
    const state = customState([
      player({ hand: [card('h-extra', 'stonetusk-boar')], board: fullBoard, manaCurrent: 10, manaMax: 10 }),
      player(),
    ]);
    const legal = adapter.getLegalChoices(state);
    expect(legal.some((c) => c.kind === 'play' && c.cardInstanceId === 'h-extra')).toBe(false);
  });

  it('the hero power costs mana, can only be used once per turn, and deals damage', () => {
    const adapter = hearthstoneAdapter;
    const state = customState([player({ manaCurrent: 2, manaMax: 2 }), player()]);
    const choice: HearthstoneChoice = { kind: 'heroPower', targetId: 'hero:1' };
    const next = adapter.applyChoice(state, choice) as HearthstoneState;
    expect(next.players[0].manaCurrent).toBe(0);
    expect(next.players[0].heroPowerUsed).toBe(true);
    expect(next.players[1].hero.health).toBe(29);
    const legalAfter = adapter.getLegalChoices(next);
    expect(legalAfter.some((c) => c.kind === 'heroPower')).toBe(false);
  });

  it('game ends when a hero reaches 0 health, with the survivor as the winner', () => {
    const adapter = hearthstoneAdapter;
    const state = customState([
      player({ board: [minion({ instanceId: 'm0', defId: 'war-golem', attack: 7, health: 7, maxHealth: 7 })] }),
      player({ hero: { health: 5 } }),
    ]);
    const choice: HearthstoneChoice = { kind: 'attack', attackerId: 'm0', targetId: 'hero:1' };
    const next = adapter.applyChoice(state, choice) as HearthstoneState;
    expect(adapter.currentDecision(next)).toBeNull();
    const outcome = adapter.getOutcome(next);
    expect(outcome?.winners).toEqual([0]);
    expect(outcome?.scores[1]).toBe(0);
  });
});

describe('hearthstone observations hide opponent information (C3)', () => {
  it('never includes opponent hand/deck card instance ids in the JSON-serialized observation', () => {
    const adapter = hearthstoneAdapter;
    const state = adapter.createInitialState(5);
    const opponentHiddenIds = new Set(
      [...state.players[1].hand, ...state.players[1].deck].map((c) => c.instanceId),
    );
    const ownIds = new Set([...state.players[0].hand, ...state.players[0].deck].map((c) => c.instanceId));
    const observation = adapter.getObservation(state, 0);
    const serialized = JSON.stringify(observation);
    for (const id of opponentHiddenIds) {
      if (ownIds.has(id)) continue;
      expect(serialized.includes(`"${id}"`)).toBe(false);
    }
    // Only counts of the opponent's hand/deck should leak, never contents.
    expect(observation.opponentHandSize).toBe(state.players[1].hand.length);
    expect(observation.opponentDeckSize).toBe(state.players[1].deck.length);
  });

  it('hiddenInfoProbe.mutateHidden leaves the viewer observation unchanged', () => {
    const adapter = hearthstoneAdapter;
    const state = adapter.createInitialState(123);
    const viewer = 0;
    const before = adapter.getObservation(state, viewer);
    const rng = createRng(456);
    const mutated = adapter.hiddenInfoProbe?.mutateHidden(state, viewer, rng);
    expect(mutated).not.toBeNull();
    const after = adapter.getObservation(mutated as HearthstoneState, viewer);
    expect(after).toEqual(before);
  });

  it('hiddenInfoProbe.mutateHidden actually reshuffles the hidden opponent hand/deck', () => {
    const adapter = hearthstoneAdapter;
    const state = adapter.createInitialState(123);
    const viewer = 0;
    const rng = createRng(456);
    const mutated = adapter.hiddenInfoProbe?.mutateHidden(state, viewer, rng) as HearthstoneState | null;
    expect(mutated).not.toBeNull();
    const before = [...state.players[1].hand, ...state.players[1].deck].map((c) => c.instanceId);
    const after = [...(mutated as HearthstoneState).players[1].hand, ...(mutated as HearthstoneState).players[1].deck].map(
      (c) => c.instanceId,
    );
    expect(after).not.toEqual(before);
    // Same multiset of hidden cards, just reassigned/reordered between hand and deck.
    expect([...after].sort()).toEqual([...before].sort());
  });
});

describe('hearthstone strategySurface (C6)', () => {
  function findFlag(flag: string) {
    const found = hearthstoneAdapter.strategySurface.find((f) => f.flag === flag);
    if (!found) throw new Error(`strategy flag not found: ${flag}`);
    return found;
  }

  it('faceRush attacks the enemy hero even when a favorable minion trade is available', () => {
    const adapter = hearthstoneAdapter;
    const faceRush = findFlag('faceRush');
    const baseFactory = adapter.baselines.heuristic;
    const variantFactory = faceRush.apply(baseFactory);
    const baseBot = baseFactory(1);
    const variantBot = variantFactory(1);

    const state = customState([
      player({
        heroPowerUsed: true, // force the heuristic base past the hero-power step into attacks
        board: [minion({ instanceId: 'm0', defId: 'boulderfist-ogre', attack: 6, health: 7, maxHealth: 7 })],
      }),
      player({
        hero: { health: 30 },
        board: [minion({ instanceId: 'm1', defId: 'stonetusk-boar', attack: 1, health: 1, maxHealth: 1 })],
      }),
    ]);
    const observation = adapter.getObservation(state, 0);
    const legal = adapter.getLegalChoices(state);

    const baseChoice = baseBot.decide('action', observation, legal);
    const variantChoice = variantBot.decide('action', observation, legal);

    expect(baseChoice).toEqual({ kind: 'attack', attackerId: 'm0', targetId: 'm1' }); // heuristic prefers the free trade
    expect(variantChoice).toEqual({ kind: 'attack', attackerId: 'm0', targetId: 'hero:1' });
    expect(variantChoice).not.toEqual(baseChoice);
  });

  it('curveDump plays the cheapest affordable card while the heuristic base plays the priciest', () => {
    const adapter = hearthstoneAdapter;
    const curveDump = findFlag('curveDump');
    const baseFactory = adapter.baselines.heuristic;
    const variantFactory = curveDump.apply(baseFactory);
    const baseBot = baseFactory(1);
    const variantBot = variantFactory(1);

    const state = customState([
      player({
        hand: [card('h-boar', 'stonetusk-boar'), card('h-croc', 'river-crocolisk')],
        manaCurrent: 2,
        manaMax: 2,
      }),
      player(),
    ]);
    const observation = adapter.getObservation(state, 0);
    const legal = adapter.getLegalChoices(state);

    const baseChoice = baseBot.decide('action', observation, legal);
    const variantChoice = variantBot.decide('action', observation, legal);

    expect(baseChoice).toEqual({ kind: 'play', cardInstanceId: 'h-croc' }); // priciest (2 mana)
    expect(variantChoice).toEqual({ kind: 'play', cardInstanceId: 'h-boar' }); // cheapest (1 mana)
    expect(variantChoice).not.toEqual(baseChoice);
  });

  it('heroPowerSpam fires the hero power at face ahead of a card play the base would make', () => {
    const adapter = hearthstoneAdapter;
    const heroPowerSpam = findFlag('heroPowerSpam');
    const baseFactory = adapter.baselines.heuristic;
    const variantFactory = heroPowerSpam.apply(baseFactory);
    const baseBot = baseFactory(1);
    const variantBot = variantFactory(1);

    const state = customState([
      player({ hand: [card('h-boar', 'stonetusk-boar')], manaCurrent: 2, manaMax: 2 }),
      player(),
    ]);
    const observation = adapter.getObservation(state, 0);
    const legal = adapter.getLegalChoices(state);

    const baseChoice = baseBot.decide('action', observation, legal);
    const variantChoice = variantBot.decide('action', observation, legal);

    expect(baseChoice).toEqual({ kind: 'play', cardInstanceId: 'h-boar' });
    expect(variantChoice).toEqual({ kind: 'heroPower', targetId: 'hero:1' });
    expect(variantChoice).not.toEqual(baseChoice);
  });
});

describe('hearthstone sampleStateFromObservation (docs/FIX-BACKLOG.md P4)', () => {
  function advanceState(seed: number, steps: number): HearthstoneState {
    const adapter = hearthstoneAdapter;
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
      state = adapter.applyChoice(state, choice) as HearthstoneState;
    }
    return state;
  }

  it('preserves everything the viewer already knows and reproduces the same observation', () => {
    const adapter = hearthstoneAdapter;
    if (adapter.sampleStateFromObservation === undefined) {
      throw new Error('hearthstoneAdapter must declare sampleStateFromObservation');
    }
    const state = advanceState(41, 40);
    const decision = adapter.currentDecision(state);
    if (!decision) throw new Error('expected an in-progress game after 40 steps');
    const observation = adapter.getObservation(state, decision.player);

    const sampled = adapter.sampleStateFromObservation(observation, decision.player, createRng(9001));
    const reobserved = adapter.getObservation(sampled, decision.player);
    expect(reobserved).toEqual(observation);
  });

  it('produces a sampled state that satisfies every invariant', () => {
    const adapter = hearthstoneAdapter;
    if (adapter.sampleStateFromObservation === undefined) {
      throw new Error('hearthstoneAdapter must declare sampleStateFromObservation');
    }
    const state = advanceState(53, 55);
    const decision = adapter.currentDecision(state);
    if (!decision) throw new Error('expected an in-progress game after 55 steps');
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
    const adapter = hearthstoneAdapter;
    if (adapter.sampleStateFromObservation === undefined) {
      throw new Error('hearthstoneAdapter must declare sampleStateFromObservation');
    }
    const state = advanceState(29, 40);
    const decision = adapter.currentDecision(state);
    if (!decision) throw new Error('expected an in-progress game after 40 steps');
    const observation = adapter.getObservation(state, decision.player);
    const opponentId = decision.player === 0 ? 1 : 0;

    const sampledA = adapter.sampleStateFromObservation(observation, decision.player, createRng(1));
    const sampledB = adapter.sampleStateFromObservation(observation, decision.player, createRng(2));

    expect(adapter.getObservation(sampledA, decision.player)).toEqual(observation);
    expect(adapter.getObservation(sampledB, decision.player)).toEqual(observation);

    // Same multiset of unseen cards either way (the viewer's own deck plus
    // the opponent's hand+deck pool), but — almost certainly — a different
    // concrete placement, proving the rng actually drives the resample.
    const poolOf = (s: HearthstoneState): string[] =>
      [...s.players[decision.player]!.deck, ...s.players[opponentId]!.hand, ...s.players[opponentId]!.deck]
        .map((c) => c.instanceId)
        .sort();
    expect(poolOf(sampledA)).toEqual(poolOf(sampledB));

    const arrangementOf = (s: HearthstoneState): string =>
      JSON.stringify([
        s.players[decision.player]!.deck.map((c) => c.instanceId),
        s.players[opponentId]!.hand.map((c) => c.instanceId),
        s.players[opponentId]!.deck.map((c) => c.instanceId),
      ]);
    expect(arrangementOf(sampledA)).not.toEqual(arrangementOf(sampledB));
  });
});

describe('hearthstoneAdapter.choiceEvaluator (ADR-0011, GAP-11 Phase 7 B3)', () => {
  const evaluate = hearthstoneAdapter.choiceEvaluator;
  if (!evaluate) throw new Error('expected hearthstoneAdapter.choiceEvaluator to be declared');

  it('scores a lethal face attack strictly above every other option', () => {
    const state = customState([
      player({
        board: [minion({ instanceId: 'p0-yeti', defId: 'chillwind-yeti', attack: 4, health: 5 })],
        manaCurrent: 10,
      }),
      player({ hero: { health: 3 }, board: [minion({ instanceId: 'p1-croc', defId: 'river-crocolisk', attack: 2, health: 3 })] }),
    ]);
    const choices: HearthstoneChoice[] = [
      { kind: 'attack', attackerId: 'p0-yeti', targetId: 'hero:1' }, // lethal: 4 dmg >= 3 health
      { kind: 'attack', attackerId: 'p0-yeti', targetId: 'p1-croc' }, // favorable trade, but not lethal
      { kind: 'endTurn' },
    ];
    const scores = evaluate(state, 0, choices);
    expect(scores[0]).toBeGreaterThan(scores[1] as number);
    expect(scores[0]).toBeGreaterThan(scores[2] as number);
  });

  it('scores a favorable trade (kill, survive) above an unfavorable one (die, no kill)', () => {
    const state = customState([
      player({
        board: [
          minion({ instanceId: 'p0-golem', defId: 'war-golem', attack: 7, health: 7 }),
          minion({ instanceId: 'p0-boar', defId: 'stonetusk-boar', attack: 1, health: 1 }),
        ],
      }),
      player({
        board: [
          minion({ instanceId: 'p1-mage', defId: 'magma-rager', attack: 5, health: 1 }), // killable, but hits back for 5
          minion({ instanceId: 'p1-yeti', defId: 'chillwind-yeti', attack: 4, health: 5 }), // not killable by the 1/1 boar
        ],
      }),
    ]);
    const favorable: HearthstoneChoice = { kind: 'attack', attackerId: 'p0-golem', targetId: 'p1-mage' }; // 7 dmg kills the 5/1; golem (7hp) survives the 5 dmg back
    const unfavorable: HearthstoneChoice = { kind: 'attack', attackerId: 'p0-boar', targetId: 'p1-yeti' }; // boar (1 dmg) can't kill the 5-health yeti; boar dies to the 4 dmg back
    const scores = evaluate(state, 0, [favorable, unfavorable]);
    expect(scores[0]).toBeGreaterThan(scores[1] as number);
  });

  it('prioritizes killing the lowest-health, highest-attack enemy minion via removal', () => {
    const state = customState([
      player({
        hand: [card('h-spark', 'spark-bolt')],
        manaCurrent: 10,
      }),
      player({
        board: [
          minion({ instanceId: 'p1-yeti', defId: 'chillwind-yeti', attack: 4, health: 5 }), // not killable by 3 dmg
          minion({ instanceId: 'p1-mage', defId: 'magma-rager', attack: 5, health: 1 }), // killable, high attack
        ],
      }),
    ]);
    const killMage: HearthstoneChoice = { kind: 'play', cardInstanceId: 'h-spark', targetId: 'p1-mage' };
    const chipYeti: HearthstoneChoice = { kind: 'play', cardInstanceId: 'h-spark', targetId: 'p1-yeti' };
    const scores = evaluate(state, 0, [killMage, chipYeti]);
    expect(scores[0]).toBeGreaterThan(scores[1] as number);
  });

  it('scores developing the board above hitting face when nothing is lethal or a kill', () => {
    const state = customState([
      player({
        hand: [card('h-yeti', 'chillwind-yeti')],
        manaCurrent: 10,
      }),
      player({ hero: { health: 30 } }),
    ]);
    const develop: HearthstoneChoice = { kind: 'play', cardInstanceId: 'h-yeti' };
    const endTurn: HearthstoneChoice = { kind: 'endTurn' };
    const scores = evaluate(state, 0, [develop, endTurn]);
    expect(scores[0]).toBeGreaterThan(scores[1] as number);
  });

  it('ranks face damage below removal but above passing', () => {
    const state = customState([
      player({ hand: [card('h-spark', 'spark-bolt')], manaCurrent: 10 }),
      player({ hero: { health: 30 }, board: [minion({ instanceId: 'p1-mage', defId: 'magma-rager', attack: 5, health: 1 })] }),
    ]);
    const killMinion: HearthstoneChoice = { kind: 'play', cardInstanceId: 'h-spark', targetId: 'p1-mage' };
    const face: HearthstoneChoice = { kind: 'play', cardInstanceId: 'h-spark', targetId: 'hero:1' };
    const endTurn: HearthstoneChoice = { kind: 'endTurn' };
    const scores = evaluate(state, 0, [killMinion, face, endTurn]);
    expect(scores[0]).toBeGreaterThan(scores[1] as number);
    expect(scores[1]).toBeGreaterThan(scores[2] as number);
  });
});
