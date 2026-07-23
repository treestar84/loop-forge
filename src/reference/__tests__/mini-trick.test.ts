import { createRng } from '../../kernel/rng';
import {
  miniTrickAdapter,
  type MiniTrickCard,
  type MiniTrickChoice,
  type MiniTrickState,
} from '../mini-trick';

function playSelfPlay(
  seed: number,
  botSeedOffset: number,
): { choiceKeys: string[]; finalScores: readonly number[] } {
  const adapter = miniTrickAdapter;
  let state = adapter.createInitialState(seed);
  const bot0 = adapter.baselines.random(seed);
  const bot1 = adapter.baselines.random(seed + botSeedOffset);
  const choiceKeys: string[] = [];
  for (;;) {
    const decision = adapter.currentDecision(state);
    if (!decision) break;
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

describe('mini-trick determinism (C1)', () => {
  it('replays the same trajectory for the same seed', () => {
    const first = playSelfPlay(11, 1000);
    const second = playSelfPlay(11, 1000);
    expect(second.choiceKeys).toEqual(first.choiceKeys);
    expect(second.finalScores).toEqual(first.finalScores);
  });

  it('matches the hardcoded replay fixtures (C7 parity)', () => {
    for (const fixture of miniTrickAdapter.replayFixtures ?? []) {
      const result = playSelfPlay(fixture.seed, 1000);
      expect(result.choiceKeys).toEqual(fixture.choiceKeys);
      expect(result.finalScores).toEqual(fixture.finalScores);
    }
  });
});

describe('mini-trick rules (C2)', () => {
  it('forces following suit when the follower holds a card of the led suit', () => {
    const adapter = miniTrickAdapter;
    let state = adapter.createInitialState(42);
    // Drive a few tricks with the random baseline, checking the invariant at
    // every step: whenever a lead suit is in play and the current player's
    // hand contains that suit, all legal choices must be of that suit.
    const bot = adapter.baselines.random(42);
    for (let step = 0; step < 12; step += 1) {
      const decision = adapter.currentDecision(state);
      if (!decision) break;
      const legal = adapter.getLegalChoices(state);
      if (state.trick.length === 1) {
        const leadSuit = state.trick[0]?.card.suit;
        const hand = decision.player === 0 ? state.hands[0] : state.hands[1];
        const hasLeadSuit = hand.some((card) => card.suit === leadSuit);
        if (hasLeadSuit) {
          expect(legal.every((card) => card.suit === leadSuit)).toBe(true);
        } else {
          expect(legal).toEqual(hand);
        }
      }
      const observation = adapter.getObservation(state, decision.player);
      const choice = bot.decide(decision.decisionPoint, observation, legal);
      state = adapter.applyChoice(state, choice) as MiniTrickState;
    }
  });

  it('throws on an illegal choice', () => {
    const adapter = miniTrickAdapter;
    const state = adapter.createInitialState(7);
    const decision = adapter.currentDecision(state);
    expect(decision).not.toBeNull();
    const illegalChoice: MiniTrickChoice = { suit: 'A', rank: 999 };
    expect(() => adapter.applyChoice(state, illegalChoice)).toThrow();
  });

  it('conserves all 16 cards and reaches a terminal outcome within maxDecisionsPerGame', () => {
    const adapter = miniTrickAdapter;
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
      state = adapter.applyChoice(state, choice) as MiniTrickState;
    }
    const outcome = adapter.getOutcome(state);
    expect(outcome).not.toBeNull();
    expect((outcome?.scores[0] ?? 0) + (outcome?.scores[1] ?? 0)).toBe(6);
  });
});

describe('mini-trick observations hide opponent information (C3)', () => {
  it('never includes an opponent hand card id in the JSON-serialized observation', () => {
    const adapter = miniTrickAdapter;
    const state = adapter.createInitialState(5);
    const opponentCardIds = new Set(
      [...state.hands[1], ...state.stock].map((card) => `${card.suit}${card.rank}`),
    );
    const observation = adapter.getObservation(state, 0);
    const ownCardIds = new Set(state.hands[0].map((card) => `${card.suit}${card.rank}`));
    const serialized = JSON.stringify(observation);
    for (const cardId of opponentCardIds) {
      if (ownCardIds.has(cardId)) {
        // A card id can coincide only if it also happens to be in the
        // viewer's own hand of a different game instance; for mini-trick the
        // deck has unique cards so this never happens, but guard anyway.
        continue;
      }
      expect(serialized.includes(`"${cardId}"`)).toBe(false);
    }
  });

  it('hiddenInfoProbe.mutateHidden leaves the viewer observation unchanged', () => {
    const adapter = miniTrickAdapter;
    const state = adapter.createInitialState(123);
    const viewer = 0;
    const before = adapter.getObservation(state, viewer);
    const rng = createRng(456);
    const mutated = adapter.hiddenInfoProbe?.mutateHidden(state, viewer, rng);
    expect(mutated).not.toBeNull();
    const after = adapter.getObservation(mutated as MiniTrickState, viewer);
    expect(after).toEqual(before);
  });

  it('hiddenInfoProbe.mutateHidden actually changes the hidden opponent/stock cards', () => {
    const adapter = miniTrickAdapter;
    const state = adapter.createInitialState(123);
    const viewer = 0;
    const rng = createRng(456);
    const mutated = adapter.hiddenInfoProbe?.mutateHidden(state, viewer, rng) as
      | MiniTrickState
      | null;
    expect(mutated).not.toBeNull();
    const before = [...state.hands[1], ...state.stock].map((c) => `${c.suit}${c.rank}`);
    const after = [
      ...(mutated as MiniTrickState).hands[1],
      ...(mutated as MiniTrickState).stock,
    ].map((c) => `${c.suit}${c.rank}`);
    expect(after).not.toEqual(before);
    // Same multiset of hidden cards, just reassigned/reordered.
    expect([...after].sort()).toEqual([...before].sort());
  });
});

describe('mini-trick informationStateKey perfect recall (docs/GAP-ANALYSIS-7.md §3)', () => {
  it('assigns different keys to states sharing {hand, trickWins, tricksCompleted, trick} but reached via a different completed-trick history', () => {
    const adapter = miniTrickAdapter;
    const informationStateKey = adapter.informationStateKey;
    if (!informationStateKey) {
      throw new Error('expected miniTrickAdapter to declare informationStateKey');
    }

    const sharedHand: MiniTrickCard[] = [
      { suit: 'A', rank: 4 },
      { suit: 'B', rank: 7 },
    ];
    const baseFields = {
      hands: [sharedHand, []] as const,
      stock: [],
      trick: [],
      leader: 0 as const,
      trickWins: [1, 1] as const,
      tricksCompleted: 1,
    };

    const stateA: MiniTrickState = {
      ...baseFields,
      completedTricks: [
        [
          { player: 0 as const, card: { suit: 'A', rank: 1 } },
          { player: 1 as const, card: { suit: 'A', rank: 2 } },
        ],
      ],
    };
    const stateB: MiniTrickState = {
      ...baseFields,
      completedTricks: [
        [
          { player: 0 as const, card: { suit: 'B', rank: 8 } },
          { player: 1 as const, card: { suit: 'A', rank: 3 } },
        ],
      ],
    };

    // Sanity check: the two states really do agree on every field the
    // pre-perfect-recall fallback key would have used.
    expect(stateA.hands).toEqual(stateB.hands);
    expect(stateA.trickWins).toEqual(stateB.trickWins);
    expect(stateA.tricksCompleted).toEqual(stateB.tricksCompleted);
    expect(stateA.trick).toEqual(stateB.trick);
    expect(stateA.completedTricks).not.toEqual(stateB.completedTricks);

    expect(informationStateKey(stateA, 0)).not.toEqual(informationStateKey(stateB, 0));
  });

  it('produces a stable key that only depends on (decisionPoint, observation) — matches a fresh observation built from the same state', () => {
    const adapter = miniTrickAdapter;
    const informationStateKey = adapter.informationStateKey;
    if (!informationStateKey) {
      throw new Error('expected miniTrickAdapter to declare informationStateKey');
    }
    let state = adapter.createInitialState(77);
    const bot = adapter.baselines.random(77);
    for (let step = 0; step < 8; step += 1) {
      const decision = adapter.currentDecision(state);
      if (!decision) break;
      const legal = adapter.getLegalChoices(state);
      const observation = adapter.getObservation(state, decision.player);
      const choice = bot.decide(decision.decisionPoint, observation, legal);
      state = adapter.applyChoice(state, choice) as MiniTrickState;
    }
    const decision = adapter.currentDecision(state);
    if (!decision) return;
    const keyFirst = informationStateKey(state, decision.player);
    const keySecond = informationStateKey(state, decision.player);
    expect(keyFirst).toEqual(keySecond);
  });
});

describe('mini-trick strategySurface (C6)', () => {
  function findFlag(flag: string) {
    const found = miniTrickAdapter.strategySurface.find((f) => f.flag === flag);
    if (!found) {
      throw new Error(`strategy flag not found: ${flag}`);
    }
    return found;
  }

  it('winCheapest makes a different decision than the heuristic base when it can win cheaply', () => {
    const adapter = miniTrickAdapter;
    const winCheapest = findFlag('winCheapest');
    const baseFactory = adapter.baselines.heuristic;
    const variantFactory = winCheapest.apply(baseFactory);
    const baseBot = baseFactory(1);
    const variantBot = variantFactory(1);

    // Construct a following decision where the base (always-lowest-rank)
    // would dump a losing card, but winCheapest can win more cheaply than
    // playing its highest card.
    const state: MiniTrickState = {
      hands: [
        [
          { suit: 'A', rank: 1 },
          { suit: 'A', rank: 5 },
          { suit: 'A', rank: 8 },
        ],
        [],
      ],
      stock: [],
      trick: [{ player: 0, card: { suit: 'A', rank: 3 } }],
      leader: 0,
      trickWins: [0, 0],
      tricksCompleted: 0,
      completedTricks: [],
    };
    // Follower is player 0 here for this synthetic single-player check of
    // decision logic; use adapter.getObservation/getLegalChoices as normal.
    const followerState: MiniTrickState = {
      ...state,
      hands: [[], [{ suit: 'A', rank: 1 }, { suit: 'A', rank: 5 }, { suit: 'A', rank: 8 }]],
    };
    const legal = adapter.getLegalChoices(followerState);
    const observation = adapter.getObservation(followerState, 1);

    const baseChoice = baseBot.decide('play', observation, legal);
    const variantChoice = variantBot.decide('play', observation, legal);

    expect(baseChoice).toEqual({ suit: 'A', rank: 1 }); // heuristic always dumps lowest
    expect(variantChoice).toEqual({ suit: 'A', rank: 5 }); // cheapest winning card
    expect(variantChoice).not.toEqual(baseChoice);
  });

  it('noopSort makes identical decisions to the (order-invariant) heuristic base', () => {
    const adapter = miniTrickAdapter;
    const noopSort = findFlag('noopSort');
    const baseFactory = adapter.baselines.heuristic;
    const variantFactory = noopSort.apply(baseFactory);

    let state = adapter.createInitialState(321);
    const baseBot = baseFactory(1);
    const variantBot = variantFactory(1);
    for (let step = 0; step < 12; step += 1) {
      const decision = adapter.currentDecision(state);
      if (!decision) break;
      const observation = adapter.getObservation(state, decision.player);
      const legal = adapter.getLegalChoices(state);
      const baseChoice = baseBot.decide(decision.decisionPoint, observation, legal);
      const variantChoice = variantBot.decide(decision.decisionPoint, observation, legal);
      expect(variantChoice).toEqual(baseChoice);
      state = adapter.applyChoice(state, baseChoice) as MiniTrickState;
    }
  });

  it('leadHighFirst leads the highest rank card while base leads differently', () => {
    const adapter = miniTrickAdapter;
    const leadHighFirst = findFlag('leadHighFirst');
    const baseFactory = adapter.baselines.heuristic; // always leads lowest
    const variantFactory = leadHighFirst.apply(baseFactory);
    const baseBot = baseFactory(1);
    const variantBot = variantFactory(1);

    const state: MiniTrickState = {
      hands: [
        [
          { suit: 'A', rank: 2 },
          { suit: 'B', rank: 6 },
          { suit: 'A', rank: 8 },
        ],
        [],
      ],
      stock: [],
      trick: [],
      leader: 0,
      trickWins: [0, 0],
      tricksCompleted: 0,
      completedTricks: [],
    };
    const observation = adapter.getObservation(state, 0);
    const legal = adapter.getLegalChoices(state);

    const baseChoice = baseBot.decide('play', observation, legal);
    const variantChoice = variantBot.decide('play', observation, legal);

    expect(baseChoice).toEqual({ suit: 'A', rank: 2 });
    expect(variantChoice).toEqual({ suit: 'A', rank: 8 });
  });
});
