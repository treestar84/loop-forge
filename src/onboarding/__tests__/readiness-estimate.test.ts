import { estimateReadiness } from '../readiness-estimate';
import type { GameProfile } from '../profile';

/** Minimal valid profile; individual tests override fields as needed. */
function baseProfile(overrides: Partial<GameProfile> = {}): GameProfile {
  return {
    gameId: 'mini-trick',
    summary: 'A minimal 2-player trick-taking game.',
    playerCount: 2,
    phases: [{ id: 'play', description: 'Six tricks are played.' }],
    decisionPoints: [
      { id: 'play', description: 'Play a legal card.', hiddenInfoVisible: 'none', enumerable: true },
    ],
    randomnessSources: [
      { id: 'shuffle', description: 'Initial deal shuffle.', seedable: true },
    ],
    hiddenInformation: [],
    outcomeRule: 'Most tricks won wins.',
    existingAiLocations: [],
    uiCouplingNotes: [],
    knownIssues: [],
    ...overrides,
  };
}

describe('estimateReadiness — P1 gate', () => {
  it('passes the gate and produces an estimate when all scope flags are unset (default in-scope)', () => {
    const result = estimateReadiness(baseProfile());
    expect(result.verdict).toBe('estimate');
    expect(result.gate.passed).toBe(true);
    expect(result.gate.failureReasons).toEqual([]);
  });

  it('rules out real-time / dexterity games (turnBased: false) as impossible', () => {
    const result = estimateReadiness(baseProfile({ turnBased: false }));
    expect(result.verdict).toBe('impossible');
    expect(result.items).toBeUndefined();
    expect(result.totalScore).toBeUndefined();
    expect(result.gate.failureReasons.some((r) => r.includes('실시간'))).toBe(true);
    expect(result.gate.failureReasons.some((r) => r.includes('지원 계획 없음'))).toBe(true);
  });

  it('rules out solo/co-op games (competitive: false) as impossible, with roadmap framing', () => {
    const result = estimateReadiness(baseProfile({ competitive: false }));
    expect(result.verdict).toBe('impossible');
    expect(result.gate.failureReasons.some((r) => r.includes('협력'))).toBe(true);
    expect(result.gate.failureReasons.some((r) => r.includes('로드맵'))).toBe(true);
  });

  it('rules out legacy/campaign games (independentGames: false) as impossible', () => {
    const result = estimateReadiness(baseProfile({ independentGames: false }));
    expect(result.verdict).toBe('impossible');
    expect(result.gate.failureReasons.some((r) => r.includes('캠페인'))).toBe(true);
    expect(result.gate.failureReasons.some((r) => r.includes('독립'))).toBe(true);
  });

  it('rules out free-form negotiation (decisionsStructurable: false) as impossible', () => {
    const result = estimateReadiness(baseProfile({ decisionsStructurable: false }));
    expect(result.verdict).toBe('impossible');
    expect(result.gate.failureReasons.some((r) => r.includes('자유 대화 협상'))).toBe(true);
    expect(result.gate.failureReasons.some((r) => r.includes('getLegalChoices'))).toBe(true);
  });

  it('reports multiple gate failures together when more than one flag fails', () => {
    const result = estimateReadiness(baseProfile({ turnBased: false, competitive: false }));
    expect(result.verdict).toBe('impossible');
    expect(result.gate.failureReasons).toHaveLength(2);
  });
});

describe('estimateReadiness — P2 randomness seedability', () => {
  it('gives full P2 marks when there are no randomness sources', () => {
    const result = estimateReadiness(baseProfile({ randomnessSources: [] }));
    expect(result.verdict).toBe('estimate');
    const p2 = result.items?.find((item) => item.id === 'P2');
    expect(p2?.score).toBe(25);
  });

  it('gives full P2 marks when all randomness sources are seedable', () => {
    const result = estimateReadiness(
      baseProfile({
        randomnessSources: [
          { id: 'shuffle', description: 'deal', seedable: true },
          { id: 'draw', description: 'mid-game draw', seedable: true },
        ],
      }),
    );
    const p2 = result.items?.find((item) => item.id === 'P2');
    expect(p2?.score).toBe(25);
  });

  it('scales P2 down proportionally when some randomness sources are not seedable', () => {
    const result = estimateReadiness(
      baseProfile({
        randomnessSources: [
          { id: 'shuffle', description: 'deal', seedable: true },
          { id: 'draw', description: 'mid-game draw', seedable: false },
        ],
      }),
    );
    const p2 = result.items?.find((item) => item.id === 'P2');
    // 1 of 2 seedable => 50% of weight 25 => 13 (rounded)
    expect(p2?.score).toBe(13);
    expect(p2?.reason).toMatch(/시드 가능 1개/);
  });

  it('gives zero P2 marks when no randomness source is seedable', () => {
    const result = estimateReadiness(
      baseProfile({
        randomnessSources: [{ id: 'shuffle', description: 'deal', seedable: false }],
      }),
    );
    const p2 = result.items?.find((item) => item.id === 'P2');
    expect(p2?.score).toBe(0);
  });
});

describe('estimateReadiness — undeclared optional fields are scored conservatively', () => {
  it('treats an undeclared decisionPoints.enumerable as non-enumerable (P3 penalty)', () => {
    const result = estimateReadiness(
      baseProfile({
        decisionPoints: [
          { id: 'play', description: 'Play a card.', hiddenInfoVisible: 'none' },
        ],
      }),
    );
    const p3 = result.items?.find((item) => item.id === 'P3');
    expect(p3?.score).toBe(0);
    expect(p3?.reason).toMatch(/미기입/);
  });

  it('treats a missing terminationGuarantee as unguaranteed (P5 = 0)', () => {
    const result = estimateReadiness(baseProfile());
    const p5 = result.items?.find((item) => item.id === 'P5');
    expect(p5?.score).toBe(0);
  });

  it('treats a missing referenceImplementation as document-only (P7 = 0)', () => {
    const result = estimateReadiness(baseProfile());
    const p7 = result.items?.find((item) => item.id === 'P7');
    expect(p7?.score).toBe(0);
  });

  it('awards full P5 when terminationGuarantee is declared', () => {
    const result = estimateReadiness(
      baseProfile({ terminationGuarantee: '연속 100수 무진행 시 무승부 종료.' }),
    );
    const p5 = result.items?.find((item) => item.id === 'P5');
    expect(p5?.score).toBe(15);
  });

  it('awards full P7 when referenceImplementation is full-code', () => {
    const result = estimateReadiness(baseProfile({ referenceImplementation: 'full-code' }));
    const p7 = result.items?.find((item) => item.id === 'P7');
    expect(p7?.score).toBe(10);
  });
});

describe('estimateReadiness — reused profiles for existing onboarded games', () => {
  it('gomoku (perfect information, deterministic-friendly) scores highly', () => {
    const gomoku: GameProfile = {
      gameId: 'gomoku',
      summary: 'Two players alternate placing stones; five in a row wins.',
      playerCount: 2,
      phases: [{ id: 'place', description: 'Place one stone on an empty cell.' }],
      decisionPoints: [
        {
          id: 'place-stone',
          description: 'Choose an empty board cell to place a stone.',
          hiddenInfoVisible: 'none',
          enumerable: true,
        },
      ],
      randomnessSources: [],
      hiddenInformation: [],
      outcomeRule: 'Five in a row wins; a full board with no winner is a draw.',
      existingAiLocations: [
        { path: 'src/reference/gomoku.ts', description: 'random + heuristic baselines.' },
      ],
      uiCouplingNotes: [],
      knownIssues: [],
      turnBased: true,
      competitive: true,
      independentGames: true,
      decisionsStructurable: true,
      terminationGuarantee: 'Board is finite (15x15); full board with no five-in-a-row is a draw.',
      referenceImplementation: 'full-code',
    };
    const result = estimateReadiness(gomoku);
    expect(result.verdict).toBe('estimate');
    expect(result.totalScore).toBeGreaterThanOrEqual(90);
  });

  it('dominion (hidden information: opponent hands/deck) scores lower on P4 but is still viable', () => {
    const dominion: GameProfile = {
      gameId: 'dominion',
      summary: 'Deck-building card game with hidden hands and shuffled decks.',
      playerCount: 2,
      phases: [
        { id: 'action', description: 'Play action cards.' },
        { id: 'buy', description: 'Buy cards with coins.' },
        { id: 'cleanup', description: 'Discard hand and draw a new one.' },
      ],
      decisionPoints: [
        {
          id: 'play-action',
          description: 'Choose an action card to play or pass.',
          hiddenInfoVisible: 'own hand',
          enumerable: true,
        },
        {
          id: 'buy-card',
          description: 'Choose a supply card to buy or pass.',
          hiddenInfoVisible: 'own hand',
          enumerable: true,
        },
      ],
      randomnessSources: [
        { id: 'deck-shuffle', description: "Shuffling a player's discard into their deck.", seedable: true },
      ],
      hiddenInformation: [
        {
          id: 'opponent-hand',
          description: "Opponent's hand.",
          hiddenFrom: 'all opponents',
          boundaryExplicit: true,
        },
        {
          id: 'deck-order',
          description: 'The order of cards remaining in a deck.',
          hiddenFrom: 'all players',
          boundaryExplicit: true,
        },
      ],
      outcomeRule: 'Most victory points when the supply runs out wins.',
      existingAiLocations: [
        { path: 'src/reference/dominion.ts', description: 'random + heuristic baselines.' },
      ],
      uiCouplingNotes: [],
      knownIssues: [],
      turnBased: true,
      competitive: true,
      independentGames: true,
      decisionsStructurable: true,
      terminationGuarantee: 'Game ends when 3 supply piles (or Province pile) are empty.',
      referenceImplementation: 'full-code',
    };
    const result = estimateReadiness(dominion);
    expect(result.verdict).toBe('estimate');
    const p4 = result.items?.find((item) => item.id === 'P4');
    expect(p4?.score).toBe(15); // both hidden-info entries have boundaryExplicit: true
    expect(result.totalScore).toBeGreaterThanOrEqual(85);
  });

  it('catan (5-6 players, resource trading) scores reasonably given a large player count', () => {
    const catan: GameProfile = {
      gameId: 'catan',
      summary: 'Resource-trading settlement game for 3-4 (up to 6) players.',
      playerCount: 6,
      phases: [
        { id: 'roll', description: 'Roll dice and distribute resources.' },
        { id: 'trade', description: 'Trade resources with other players.' },
        { id: 'build', description: 'Build roads, settlements, or cities.' },
      ],
      decisionPoints: [
        {
          id: 'place-robber',
          description: 'Choose a hex to move the robber to.',
          hiddenInfoVisible: 'own hand',
          enumerable: true,
        },
        {
          id: 'propose-trade',
          description: 'Choose a discretized offer (resources for resources) to propose.',
          hiddenInfoVisible: 'own hand',
          enumerable: true,
        },
      ],
      randomnessSources: [
        { id: 'dice-roll', description: 'Two-dice roll each turn.', seedable: true },
        { id: 'dev-card-draw', description: 'Drawing from the development card deck.', seedable: true },
      ],
      hiddenInformation: [
        {
          id: 'resource-hand',
          description: "A player's resource cards.",
          hiddenFrom: 'all other players',
          boundaryExplicit: true,
        },
      ],
      outcomeRule: 'First to 10 victory points wins.',
      existingAiLocations: [
        { path: 'src/reference/catan.ts', description: 'random + heuristic baselines.' },
      ],
      uiCouplingNotes: [],
      knownIssues: [],
      turnBased: true,
      competitive: true,
      independentGames: true,
      decisionsStructurable: true,
      terminationGuarantee: 'First to 10 victory points ends the game immediately.',
      referenceImplementation: 'full-code',
    };
    const result = estimateReadiness(catan);
    expect(result.verdict).toBe('estimate');
    expect(result.totalScore).toBeGreaterThanOrEqual(90);
  });
});
