import { parseGameProfile, profileWarnings, type GameProfile } from '../profile';

function validProfileInput(): unknown {
  return {
    gameId: 'mini-trick',
    summary: 'A minimal 2-player trick-taking game.',
    playerCount: 2,
    phases: [{ id: 'play', description: 'Six tricks are played.' }],
    decisionPoints: [
      {
        id: 'play',
        description: 'Play a legal card.',
        hiddenInfoVisible: 'none',
      },
    ],
    randomnessSources: [
      { id: 'shuffle', description: 'Initial deal shuffle.', seedable: true },
    ],
    hiddenInformation: [
      {
        id: 'opponent-hand',
        description: "Opponent's hand.",
        hiddenFrom: 'the other player',
      },
    ],
    outcomeRule: 'Most tricks won wins.',
    existingAiLocations: [
      { path: 'src/reference/mini-trick.ts', description: 'Baselines + strategy flags.' },
    ],
    uiCouplingNotes: [],
    knownIssues: [],
  };
}

describe('parseGameProfile', () => {
  it('parses a fully valid profile', () => {
    const profile = parseGameProfile(validProfileInput());
    expect(profile.gameId).toBe('mini-trick');
    expect(profile.playerCount).toBe(2);
    expect(profile.phases).toHaveLength(1);
  });

  it('allows empty arrays for list fields', () => {
    const input = validProfileInput() as Record<string, unknown>;
    input.phases = [];
    input.decisionPoints = [];
    input.randomnessSources = [];
    input.hiddenInformation = [];
    input.existingAiLocations = [];
    const profile = parseGameProfile(input);
    expect(profile.phases).toEqual([]);
    expect(profile.decisionPoints).toEqual([]);
  });

  it('throws naming the field when gameId is missing', () => {
    const input = validProfileInput() as Record<string, unknown>;
    delete input.gameId;
    expect(() => parseGameProfile(input)).toThrow(/gameId/);
  });

  it('throws naming the field when playerCount is not a positive integer', () => {
    const input = validProfileInput() as Record<string, unknown>;
    input.playerCount = 0;
    expect(() => parseGameProfile(input)).toThrow(/playerCount/);
  });

  it('throws naming the field when playerCount has the wrong type', () => {
    const input = validProfileInput() as Record<string, unknown>;
    input.playerCount = '2';
    expect(() => parseGameProfile(input)).toThrow(/playerCount/);
  });

  it('throws naming the nested field when a decision point is malformed', () => {
    const input = validProfileInput() as Record<string, unknown>;
    input.decisionPoints = [{ id: 'play' }]; // missing description/hiddenInfoVisible
    expect(() => parseGameProfile(input)).toThrow(/decisionPoints\[0\]/);
  });

  it('throws naming the field when a randomness source seedable flag has the wrong type', () => {
    const input = validProfileInput() as Record<string, unknown>;
    input.randomnessSources = [
      { id: 'shuffle', description: 'x', seedable: 'yes' },
    ];
    expect(() => parseGameProfile(input)).toThrow(/randomnessSources\[0\]/);
  });

  it('throws when the root value is not an object', () => {
    expect(() => parseGameProfile('not-an-object')).toThrow(/<root>/);
    expect(() => parseGameProfile(null)).toThrow(/<root>/);
    expect(() => parseGameProfile([1, 2, 3])).toThrow(/<root>/);
  });

  it('throws naming the field when uiCouplingNotes contains a non-string', () => {
    const input = validProfileInput() as Record<string, unknown>;
    input.uiCouplingNotes = ['fine', 42];
    expect(() => parseGameProfile(input)).toThrow(/uiCouplingNotes\[1\]/);
  });
});

describe('profileWarnings', () => {
  it('returns no warnings when every randomness source is seedable', () => {
    const profile = parseGameProfile(validProfileInput());
    expect(profileWarnings(profile)).toEqual([]);
  });

  it('warns when a randomness source is not seedable, but the profile stays valid', () => {
    const input = validProfileInput() as Record<string, unknown>;
    input.randomnessSources = [
      { id: 'shuffle', description: 'Initial deal shuffle.', seedable: true },
      { id: 'weather', description: 'External weather API.', seedable: false },
    ];
    const profile: GameProfile = parseGameProfile(input);
    const warnings = profileWarnings(profile);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/weather/);
  });
});
