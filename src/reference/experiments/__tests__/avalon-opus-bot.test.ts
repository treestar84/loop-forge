import { avalonOpusBot } from '../avalon-opus-bot';
import type {
  AssassinateChoice,
  AvalonObservation,
  MissionCardChoice,
  ProposeTeamChoice,
  VoteChoice,
} from '../../avalon';
import { combinations } from '../../avalon';

const BASE: AvalonObservation = {
  self: 0,
  role: 'servant',
  round: 0,
  leader: 0,
  phase: 'propose',
  roundRejections: 0,
  pendingTeam: null,
  proposals: [],
  missions: [],
  winner: null,
  assassinTarget: null,
};

function proposeChoices(size: number): ProposeTeamChoice[] {
  return combinations([0, 1, 2, 3, 4], size).map((team) => ({ kind: 'proposeTeam', team }));
}

const VOTE_CHOICES: readonly VoteChoice[] = [
  { kind: 'vote', approve: true },
  { kind: 'vote', approve: false },
];

describe('avalonOpusBot determinism (C1)', () => {
  it('returns the same decision for the same seed and observation, repeated', () => {
    const bot1 = avalonOpusBot(777);
    const bot2 = avalonOpusBot(777);
    const observation: AvalonObservation = { ...BASE, self: 0, role: 'merlin', evilSeats: [1, 2] };
    const legal = proposeChoices(2);
    expect(bot1.decide('proposeTeam', observation, legal)).toEqual(bot2.decide('proposeTeam', observation, legal));
  });
});

describe('avalonOpusBot — Merlin', () => {
  it('rejects a team containing both known-evil seats', () => {
    const bot = avalonOpusBot(1);
    const observation: AvalonObservation = {
      ...BASE,
      self: 0,
      role: 'merlin',
      evilSeats: [1, 2],
      pendingTeam: [1, 2, 3],
    };
    const choice = bot.decide('vote', observation, VOTE_CHOICES) as VoteChoice;
    expect(choice.approve).toBe(false);
  });

  it('approves a team with zero known-evil seats', () => {
    const bot = avalonOpusBot(2);
    const observation: AvalonObservation = {
      ...BASE,
      self: 0,
      role: 'merlin',
      evilSeats: [1, 2],
      pendingTeam: [0, 3, 4],
    };
    const choice = bot.decide('vote', observation, VOTE_CHOICES) as VoteChoice;
    expect(choice.approve).toBe(true);
  });

  it('proposes a team with no known-evil seats when one is legally available', () => {
    const bot = avalonOpusBot(3);
    const observation: AvalonObservation = {
      ...BASE,
      self: 0,
      role: 'merlin',
      evilSeats: [1, 2],
    };
    const legal = proposeChoices(3);
    const choice = bot.decide('proposeTeam', observation, legal) as ProposeTeamChoice;
    expect(choice.team.some((seat) => observation.evilSeats?.includes(seat))).toBe(false);
  });
});

describe('avalonOpusBot — evil (minion/assassin)', () => {
  it('proposes a team containing exactly one of {self, teammate}', () => {
    const bot = avalonOpusBot(4);
    const observation: AvalonObservation = {
      ...BASE,
      self: 1,
      role: 'minion',
      evilTeammates: [{ seat: 3, role: 'assassin' }],
    };
    const legal = proposeChoices(3);
    const choice = bot.decide('proposeTeam', observation, legal) as ProposeTeamChoice;
    const hasSelf = choice.team.includes(1);
    const hasTeammate = choice.team.includes(3);
    expect(hasSelf !== hasTeammate).toBe(true);
  });

  it('always plays fail on a mission card once round index reaches the delayed-fail threshold', () => {
    const bot = avalonOpusBot(5);
    const observation: AvalonObservation = {
      ...BASE,
      self: 1,
      role: 'assassin',
      round: 3,
      evilTeammates: [{ seat: 3, role: 'minion' }],
    };
    const legal: MissionCardChoice[] = [
      { kind: 'missionCard', success: true },
      { kind: 'missionCard', success: false },
    ];
    const choice = bot.decide('missionCard', observation, legal) as MissionCardChoice;
    expect(choice.success).toBe(false);
  });

  it('plays success on an early mission card (round 0) before the delayed-fail threshold', () => {
    const bot = avalonOpusBot(6);
    const observation: AvalonObservation = {
      ...BASE,
      self: 1,
      role: 'minion',
      round: 0,
      evilTeammates: [{ seat: 3, role: 'assassin' }],
    };
    const legal: MissionCardChoice[] = [
      { kind: 'missionCard', success: true },
      { kind: 'missionCard', success: false },
    ];
    const choice = bot.decide('missionCard', observation, legal) as MissionCardChoice;
    expect(choice.success).toBe(true);
  });
});

describe('avalonOpusBot — every decision stays within the legal set', () => {
  it('proposeTeam/vote/missionCard/assassinate all return a legal choice', () => {
    const bot = avalonOpusBot(9);

    const proposeObs: AvalonObservation = { ...BASE, self: 2, role: 'servant' };
    const proposeLegal = proposeChoices(2);
    expect(proposeLegal).toContainEqual(bot.decide('proposeTeam', proposeObs, proposeLegal));

    const voteObs: AvalonObservation = { ...BASE, self: 2, role: 'servant', pendingTeam: [0, 1] };
    expect(VOTE_CHOICES).toContainEqual(bot.decide('vote', voteObs, VOTE_CHOICES));

    const missionObs: AvalonObservation = { ...BASE, self: 2, role: 'servant' };
    const missionLegal: MissionCardChoice[] = [{ kind: 'missionCard', success: true }];
    expect(missionLegal).toContainEqual(bot.decide('missionCard', missionObs, missionLegal));

    const assassinateObs: AvalonObservation = {
      ...BASE,
      self: 3,
      role: 'assassin',
      evilTeammates: [{ seat: 1, role: 'minion' }],
      proposals: [
        { leader: 0, team: [0, 2], votes: [true, false, true, true, false], approved: true },
      ],
    };
    const assassinateLegal: AssassinateChoice[] = [0, 2, 4].map((target) => ({
      kind: 'assassinate',
      target,
    }));
    expect(assassinateLegal).toContainEqual(bot.decide('assassinate', assassinateObs, assassinateLegal));
  });
});
