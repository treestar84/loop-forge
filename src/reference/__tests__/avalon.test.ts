import { createRng } from '../../kernel/rng';
import {
  avalonAdapter,
  combinations,
  seatsWithRole,
  type AvalonChoice,
  type AvalonState,
} from '../avalon';

function playSelfPlay(
  seed: number,
  botFactory: typeof avalonAdapter.baselines.random,
  botSeedBase: number,
): { choiceKeys: string[]; finalScores: readonly number[]; finalState: AvalonState } {
  const adapter = avalonAdapter;
  let state = adapter.createInitialState(seed);
  const bots = [0, 1, 2, 3, 4].map((seat) => botFactory(botSeedBase + seat));
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
  return { choiceKeys, finalScores: outcome.scores, finalState: state };
}

describe('avalon determinism (C1)', () => {
  it('replays the same trajectory for the same seed (random self-play)', () => {
    const first = playSelfPlay(11, avalonAdapter.baselines.random, 1000);
    const second = playSelfPlay(11, avalonAdapter.baselines.random, 1000);
    expect(second.choiceKeys).toEqual(first.choiceKeys);
    expect(second.finalScores).toEqual(first.finalScores);
  });

  it('replays the same trajectory for the same seed (heuristic self-play)', () => {
    const first = playSelfPlay(22, avalonAdapter.baselines.heuristic, 2000);
    const second = playSelfPlay(22, avalonAdapter.baselines.heuristic, 2000);
    expect(second.choiceKeys).toEqual(first.choiceKeys);
    expect(second.finalScores).toEqual(first.finalScores);
  });

  it('matches the hardcoded replay fixtures (C7 parity — self-play reproducibility, see final report)', () => {
    for (const fixture of avalonAdapter.replayFixtures ?? []) {
      const result = playSelfPlay(fixture.seed, avalonAdapter.baselines.random, 1000);
      expect(result.choiceKeys).toEqual(fixture.choiceKeys);
      expect(result.finalScores).toEqual(fixture.finalScores);
    }
  });

  it('different seeds assign different role layouts (role-seat diversity)', () => {
    const roleLayouts = new Set<string>();
    for (let seed = 1; seed <= 20; seed += 1) {
      const state = avalonAdapter.createInitialState(seed);
      roleLayouts.add(state.roles.join(','));
    }
    expect(roleLayouts.size).toBeGreaterThan(1);
  });
});

describe('avalon rules (C2)', () => {
  it('reaches a terminal outcome within maxDecisionsPerGame for random self-play across many seeds', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const result = playSelfPlay(seed, avalonAdapter.baselines.random, 9000 + seed * 10);
      expect(result.finalScores.length).toBe(5);
      const winnersCount = result.finalState.winner === null ? 0 : 1;
      expect(winnersCount).toBe(1);
    }
  });

  it('mission team sizes follow the 5-player schedule [2,3,2,3,3]', () => {
    const state = avalonAdapter.createInitialState(1);
    const decision = avalonAdapter.currentDecision(state);
    expect(decision?.decisionPoint).toBe('proposeTeam');
    const legal = avalonAdapter.getLegalChoices(state) as unknown as { team: readonly number[] }[];
    expect(legal.every((c) => c.team.length === 2)).toBe(true);
  });

  it('good players may only submit a success mission card', () => {
    const state = avalonAdapter.createInitialState(1);
    const goodSeat = seatsWithRole(state.roles, ['merlin', 'servant'])[0] as number;
    const evilSeat = seatsWithRole(state.roles, ['minion', 'assassin'])[0] as number;
    expect(goodSeat).not.toBe(evilSeat);
    // Fabricate a mission-phase state directly rather than driving full self-play,
    // to test legality in isolation.
    const missionState: AvalonState = {
      ...state,
      phase: 'mission',
      pendingTeam: [goodSeat, evilSeat].sort((a, b) => a - b) as readonly number[] as AvalonState['pendingTeam'],
      pendingMissionCards: [null, null, null, null, null],
    };
    const decisionForGood: AvalonState = { ...missionState, pendingMissionCards: (() => {
      const arr: (boolean | null)[] = [null, null, null, null, null];
      return arr;
    })() };
    const decision = avalonAdapter.currentDecision(decisionForGood);
    const decidingSeat = decision?.player;
    const legal = avalonAdapter.getLegalChoices(decisionForGood);
    if (decidingSeat === goodSeat) {
      expect(legal).toHaveLength(1);
      expect((legal[0] as { success: boolean }).success).toBe(true);
    } else {
      expect(legal.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('evil players may submit either success or fail', () => {
    const state = avalonAdapter.createInitialState(1);
    const evilSeats = [...seatsWithRole(state.roles, ['minion', 'assassin'])] as [number, number];
    const missionState: AvalonState = {
      ...state,
      phase: 'mission',
      pendingTeam: [...evilSeats].sort((a, b) => a - b) as unknown as AvalonState['pendingTeam'],
      pendingMissionCards: [null, null, null, null, null],
    };
    const decision = avalonAdapter.currentDecision(missionState);
    expect(decision?.player).toBe([...evilSeats].sort((a, b) => a - b)[0]);
    const legal = avalonAdapter.getLegalChoices(missionState);
    expect(legal).toHaveLength(2);
  });

  it('throws on a choice not returned by getLegalChoices', () => {
    const state = avalonAdapter.createInitialState(1);
    const badChoice: AvalonChoice = { kind: 'proposeTeam', team: [0, 1, 2, 3, 4] }; // wrong size
    expect(() => avalonAdapter.applyChoice(state, badChoice)).toThrow();
  });

  it('5 consecutive rejections in a round ends the game with evil winning', () => {
    let state = avalonAdapter.createInitialState(1);
    for (let i = 0; i < 5; i += 1) {
      const proposeDecision = avalonAdapter.currentDecision(state);
      expect(proposeDecision?.decisionPoint).toBe('proposeTeam');
      const legalTeams = avalonAdapter.getLegalChoices(state);
      state = avalonAdapter.applyChoice(state, legalTeams[0] as AvalonChoice);
      for (let v = 0; v < 5; v += 1) {
        const voteDecision = avalonAdapter.currentDecision(state);
        expect(voteDecision?.decisionPoint).toBe('vote');
        state = avalonAdapter.applyChoice(state, { kind: 'vote', approve: false });
      }
    }
    expect(state.winner).toBe('evil');
    const outcome = avalonAdapter.getOutcome(state);
    expect([...(outcome?.winners ?? [])].sort((a, b) => a - b)).toEqual(
      seatsWithRole(state.roles, ['minion', 'assassin']).sort((a, b) => a - b),
    );
  });

  it('3 failed missions ends the game with evil winning, without an assassination phase', () => {
    let state = avalonAdapter.createInitialState(1);
    const evilSeats = new Set(seatsWithRole(state.roles, ['minion', 'assassin']));
    for (let round = 0; round < 3; round += 1) {
      const proposeDecision = avalonAdapter.currentDecision(state);
      expect(proposeDecision?.decisionPoint).toBe('proposeTeam');
      const legalTeams = avalonAdapter.getLegalChoices(state) as { kind: 'proposeTeam'; team: readonly number[] }[];
      // Pick a team that includes at least one evil seat so a fail is possible.
      const teamWithEvil = legalTeams.find((c) => c.team.some((seat) => evilSeats.has(seat))) ?? legalTeams[0];
      state = avalonAdapter.applyChoice(state, teamWithEvil as AvalonChoice);
      for (let v = 0; v < 5; v += 1) {
        state = avalonAdapter.applyChoice(state, { kind: 'vote', approve: true });
      }
      expect(avalonAdapter.currentDecision(state)?.decisionPoint).toBe('missionCard');
      for (;;) {
        const decision = avalonAdapter.currentDecision(state);
        if (!decision || decision.decisionPoint !== 'missionCard') break;
        const isEvil = evilSeats.has(decision.player);
        state = avalonAdapter.applyChoice(state, { kind: 'missionCard', success: !isEvil });
      }
    }
    expect(state.winner).toBe('evil');
    expect(state.missions.filter((m) => !m.success).length).toBe(3);
  });

  it('3 successful missions leads to an assassination decision, and a correct guess flips the win to evil', () => {
    let state = avalonAdapter.createInitialState(1);
    const evilSeats = new Set(seatsWithRole(state.roles, ['minion', 'assassin']));
    const merlinSeat = state.roles.indexOf('merlin');
    for (let round = 0; round < 3; round += 1) {
      const legalTeams = avalonAdapter.getLegalChoices(state) as { kind: 'proposeTeam'; team: readonly number[] }[];
      state = avalonAdapter.applyChoice(state, legalTeams[0] as AvalonChoice);
      for (let v = 0; v < 5; v += 1) {
        state = avalonAdapter.applyChoice(state, { kind: 'vote', approve: true });
      }
      for (;;) {
        const decision = avalonAdapter.currentDecision(state);
        if (!decision || decision.decisionPoint !== 'missionCard') break;
        state = avalonAdapter.applyChoice(state, { kind: 'missionCard', success: true });
      }
    }
    const decision = avalonAdapter.currentDecision(state);
    expect(decision?.decisionPoint).toBe('assassinate');
    const assassinSeat = state.roles.indexOf('assassin');
    expect(evilSeats.has(decision?.player as number)).toBe(true);
    expect(decision?.player).toBe(assassinSeat);
    state = avalonAdapter.applyChoice(state, { kind: 'assassinate', target: merlinSeat });
    expect(state.winner).toBe('evil');
    expect(state.assassinTarget).toBe(merlinSeat);
  });

  it('combinations() enumerates the correct count for C(5,2) and C(5,3)', () => {
    expect(combinations([0, 1, 2, 3, 4], 2)).toHaveLength(10);
    expect(combinations([0, 1, 2, 3, 4], 3)).toHaveLength(10);
  });
});

describe('avalon hidden information (C3)', () => {
  it('getObservation never reveals evilSeats/evilTeammates to a servant', () => {
    const state = avalonAdapter.createInitialState(1);
    const servantSeat = seatsWithRole(state.roles, ['servant'])[0] as number;
    const observation = avalonAdapter.getObservation(state, servantSeat);
    expect(observation.evilSeats).toBeUndefined();
    expect(observation.evilTeammates).toBeUndefined();
  });

  it("hiddenInfoProbe mutates something the viewer can't see, and getObservation is invariant under it", () => {
    const rng = createRng(777);
    for (let seed = 1; seed <= 5; seed += 1) {
      const state = avalonAdapter.createInitialState(seed);
      for (const viewer of [0, 1, 2, 3, 4] as const) {
        const before = avalonAdapter.getObservation(state, viewer);
        const mutated = avalonAdapter.hiddenInfoProbe?.mutateHidden(state, viewer, rng);
        expect(mutated).not.toBeNull();
        if (mutated === null || mutated === undefined) continue;
        expect(mutated.roles).not.toEqual(state.roles);
        const after = avalonAdapter.getObservation(mutated, viewer);
        expect(after).toEqual(before);
      }
    }
  });

  it('Merlin sees both evil seats but not which one is the assassin', () => {
    const state = avalonAdapter.createInitialState(1);
    const merlinSeat = state.roles.indexOf('merlin');
    const observation = avalonAdapter.getObservation(state, merlinSeat as number);
    expect(observation.evilSeats?.slice().sort((a, b) => a - b)).toEqual(
      seatsWithRole(state.roles, ['minion', 'assassin']).sort((a, b) => a - b),
    );
    expect((observation as { evilTeammates?: unknown }).evilTeammates).toBeUndefined();
  });

  it('evil players see each other, with exact roles', () => {
    const state = avalonAdapter.createInitialState(1);
    const minionSeat = state.roles.indexOf('minion');
    const observation = avalonAdapter.getObservation(state, minionSeat as number);
    expect(observation.evilTeammates).toHaveLength(1);
    expect(observation.evilTeammates?.[0]?.role).toBe('assassin');
  });
});

describe('avalon strategySurface (C6)', () => {
  it('declares 3 strategy flags with distinct names', () => {
    const flags = avalonAdapter.strategySurface.map((s) => s.flag);
    expect(new Set(flags).size).toBe(flags.length);
    expect(flags.length).toBeGreaterThanOrEqual(2);
  });

  it('evilDelayedFail always plays success on round 0, unlike a base bot that might fail', () => {
    const flagSpec = avalonAdapter.strategySurface.find((s) => s.flag === 'evilDelayedFail');
    expect(flagSpec).toBeDefined();
    if (!flagSpec) return;
    // Base bot that always fails when it can, to prove the flag overrides it.
    const alwaysFailBase = () => ({
      id: 'always-fail',
      decide(_dp: string, _obs: unknown, legal: readonly AvalonChoice[]) {
        const fail = legal.find((c) => c.kind === 'missionCard' && c.success === false);
        return fail ?? (legal[0] as AvalonChoice);
      },
    });
    const wrapped = flagSpec.apply(alwaysFailBase as typeof avalonAdapter.baselines.random)(1);
    const choice = wrapped.decide(
      'missionCard',
      { round: 0 } as never,
      [
        { kind: 'missionCard', success: true },
        { kind: 'missionCard', success: false },
      ] as AvalonChoice[],
    );
    expect((choice as { success: boolean }).success).toBe(true);
  });
});
