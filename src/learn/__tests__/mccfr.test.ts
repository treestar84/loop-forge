import type { BotFactory, GameAdapter, PendingDecision, PlayerId } from '../../contract/types';
import { createRng } from '../../kernel/rng';
import { eraseAdapter } from '../../loop/erase';
import { policyBotFactory, policyTableDigest, trainOutcomeSamplingMccfr } from '../mccfr';

/**
 * Fixture: a tiny 2-decision, perfect-information, 2-player game with a
 * clear correct answer, used to check that MCCFR concentrates the average
 * strategy on it.
 *
 *   - Player 0 picks 'A' or 'B'.
 *   - If 0 picked 'A', the game ends immediately: 0 always wins (dominant
 *     strategy for 0, independent of anything player 1 could do).
 *   - If 0 picked 'B', player 1 picks 'X' or 'Y': 'X' wins for player 1,
 *     'Y' hands the win back to player 0 (so 1's correct reply, on
 *     reaching that branch, is 'X').
 */
type Choice = 'A' | 'B' | 'X' | 'Y';

interface FixtureState {
  readonly p0: 'A' | 'B' | null;
  readonly p1: 'X' | 'Y' | null;
}

function makeFixtureAdapter(): GameAdapter<FixtureState, { readonly p0: FixtureState['p0'] }, Choice> {
  const randomBaseline: BotFactory<{ readonly p0: FixtureState['p0'] }, Choice> = (seed) => {
    const rng = createRng(seed);
    return {
      id: 'fixture-random',
      decide(_decisionPoint, _observation, legal) {
        return legal[rng.nextInt(legal.length)] as Choice;
      },
    };
  };

  return {
    spec: {
      gameId: 'mccfr-fixture',
      playerCount: 2,
      decisionPoints: [
        { id: 'p0choose', description: 'Player 0 picks A or B.' },
        { id: 'p1choose', description: 'Player 1 picks X or Y.' },
      ],
      seatingPlan: [[0, 1]],
      maxDecisionsPerGame: 2,
      utility: 'zero-sum',
    },
    createInitialState(_seed) {
      return { p0: null, p1: null };
    },
    currentDecision(state): PendingDecision | null {
      if (state.p0 === null) return { player: 0, decisionPoint: 'p0choose' };
      if (state.p1 === null) return { player: 1, decisionPoint: 'p1choose' };
      return null;
    },
    getObservation(state, _player) {
      return { p0: state.p0 };
    },
    getLegalChoices(state) {
      return state.p0 === null ? ['A', 'B'] : ['X', 'Y'];
    },
    applyChoice(state, choice) {
      if (state.p0 === null) {
        return { ...state, p0: choice as 'A' | 'B' };
      }
      return { ...state, p1: choice as 'X' | 'Y' };
    },
    getOutcome(state) {
      if (state.p0 === null) return null;
      if (state.p0 === 'A') {
        return { scores: [1, 0], winners: [0] };
      }
      if (state.p1 === null) return null;
      return state.p1 === 'X' ? { scores: [0, 1], winners: [1] } : { scores: [1, 0], winners: [0] };
    },
    encodeChoice(choice) {
      return choice;
    },
    informationStateKey(state, player: PlayerId) {
      return `${player}:${state.p0 ?? ''}:${state.p1 ?? ''}`;
    },
    baselines: {
      random: randomBaseline,
      heuristic: randomBaseline,
    },
    strategySurface: [],
  };
}

describe('trainOutcomeSamplingMccfr', () => {
  it('is deterministic: the same config produces a bit-identical table', () => {
    const adapter = eraseAdapter(makeFixtureAdapter());
    const config = { iterations: 500, seed: 7 };
    const first = trainOutcomeSamplingMccfr(adapter, config);
    const second = trainOutcomeSamplingMccfr(adapter, config);
    expect(policyTableDigest(second)).toBe(policyTableDigest(first));
  });

  it('concentrates player 0\'s average strategy on the dominant action A', () => {
    const adapter = eraseAdapter(makeFixtureAdapter());
    const table = trainOutcomeSamplingMccfr(adapter, { iterations: 4000, seed: 11 });
    const rootKey = '0::'; // player 0, no choices made yet
    const distribution = table.entries[rootKey];
    expect(distribution).toBeDefined();
    expect(distribution?.['A']).toBeGreaterThan(0.85);
    expect(table.meta.infosetKeySource).toBe('adapter');
    expect(table.meta.infosetCount).toBeGreaterThan(0);
  });

  it('rejects games with more than two players', () => {
    const adapter = eraseAdapter(makeFixtureAdapter());
    const threePlayerAdapter = { ...adapter, spec: { ...adapter.spec, playerCount: 3 } };
    expect(() => trainOutcomeSamplingMccfr(threePlayerAdapter, { iterations: 10, seed: 1 })).toThrow(
      /two-player only/,
    );
  });
});

describe('policyBotFactory', () => {
  it('always returns an element of the legal array, and falls back to uniform on an unregistered infoset', () => {
    const adapter = eraseAdapter(makeFixtureAdapter());
    const table = trainOutcomeSamplingMccfr(adapter, { iterations: 2000, seed: 21 });
    const bot = policyBotFactory(adapter, table, 99);

    // Registered infoset: decide should still return a legal element every time.
    for (let trial = 0; trial < 20; trial += 1) {
      const choice = bot.decide('p0choose', { p0: null }, ['A', 'B']);
      expect(['A', 'B']).toContain(choice);
    }

    // Unregistered infoset (a decisionPoint/observation combination the
    // table never saw): must fall back to uniform over legal, not throw.
    const fallbackChoice = bot.decide('never-seen-decision-point', { irrelevant: true }, ['A', 'B']);
    expect(['A', 'B']).toContain(fallbackChoice);
  });
});
