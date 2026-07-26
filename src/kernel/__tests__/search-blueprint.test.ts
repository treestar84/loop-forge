import { classifyGame } from '../classify';
import {
  deriveSearchBlueprint,
  type SearchCapabilities,
  type ThroughputSample,
} from '../search-blueprint';
import { gomokuAdapter } from '../../reference/gomoku';
import { janggiAdapter } from '../../reference/janggi';
import { splendorAdapter } from '../../reference/splendor';
import { dominionAdapter } from '../../reference/dominion';
import { hearthstoneAdapter } from '../../reference/hearthstone';
import { wingspanAdapter } from '../../reference/wingspan';
import { miniTrickAdapter } from '../../reference/mini-trick';

const NO_CAPABILITIES: SearchCapabilities = {
  hasReconstructState: false,
  hasSampleStateFromObservation: false,
  hasInformationStateKey: false,
  utilityDeclared: undefined,
  playerCount: 2,
};

const TREE_SEARCH_SAMPLES: readonly ThroughputSample[] = [
  { simulations: 64, msPerGame: 100 },
  { simulations: 256, msPerGame: 400 },
  { simulations: 512, msPerGame: 900 },
];

const twoPlayerZeroSumClassification = classifyGame(gomokuAdapter.spec);

describe('deriveSearchBlueprint: family selection', () => {
  it('recommends tree-search when reconstructState is declared and sampleStateFromObservation is not', () => {
    const capabilities: SearchCapabilities = { ...NO_CAPABILITIES, hasReconstructState: true };
    const result = deriveSearchBlueprint(
      twoPlayerZeroSumClassification,
      capabilities,
      TREE_SEARCH_SAMPLES,
      30 * 60 * 1000,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.family).toBe('tree-search');
    expect(result[0]?.flagLabel).toMatch(/^mcts-s\d+-hr$/);
  });

  it('recommends information-set-tree-search when sampleStateFromObservation is declared, taking priority over reconstructState', () => {
    const capabilities: SearchCapabilities = {
      ...NO_CAPABILITIES,
      hasReconstructState: true,
      hasSampleStateFromObservation: true,
    };
    const result = deriveSearchBlueprint(
      twoPlayerZeroSumClassification,
      capabilities,
      TREE_SEARCH_SAMPLES,
      30 * 60 * 1000,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.family).toBe('information-set-tree-search');
    expect(result[0]?.flagLabel).toMatch(/^ismcts-s\d+-hr$/);
  });

  it('recommends no tree-search/IS-MCTS candidate when neither hook is declared', () => {
    const result = deriveSearchBlueprint(
      twoPlayerZeroSumClassification,
      NO_CAPABILITIES,
      TREE_SEARCH_SAMPLES,
      30 * 60 * 1000,
    );
    expect(result).toEqual([]);
  });

  it('returns an empty array when neither a search family nor CFR eligibility applies', () => {
    const capabilities: SearchCapabilities = { ...NO_CAPABILITIES, playerCount: 4 };
    const result = deriveSearchBlueprint(
      classifyGame({ ...gomokuAdapter.spec, playerCount: 4 }),
      capabilities,
      TREE_SEARCH_SAMPLES,
      30 * 60 * 1000,
    );
    expect(result).toEqual([]);
  });
});

describe('deriveSearchBlueprint: CFR eligibility (parallel to tree-search/IS-MCTS, not exclusive)', () => {
  const cfrCapabilities: SearchCapabilities = {
    ...NO_CAPABILITIES,
    hasInformationStateKey: true,
    utilityDeclared: 'zero-sum',
    playerCount: 2,
  };

  it('adds a counterfactual-regret candidate when playerCount===2, zero-sum, and informationStateKey are all present', () => {
    const result = deriveSearchBlueprint(
      twoPlayerZeroSumClassification,
      cfrCapabilities,
      TREE_SEARCH_SAMPLES,
      30 * 60 * 1000,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.family).toBe('counterfactual-regret');
    expect(result[0]?.flagLabel).toBe('mccfr-os-auto');
    expect(result[0]?.tacticalPrecheckDepth).toBe(0);
  });

  it('appends the CFR candidate alongside a tree-search candidate rather than replacing it', () => {
    const capabilities: SearchCapabilities = { ...cfrCapabilities, hasReconstructState: true };
    const result = deriveSearchBlueprint(
      twoPlayerZeroSumClassification,
      capabilities,
      TREE_SEARCH_SAMPLES,
      30 * 60 * 1000,
    );
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.family)).toEqual(
      expect.arrayContaining(['tree-search', 'counterfactual-regret']),
    );
  });

  it('does not recommend CFR when utility is not declared zero-sum', () => {
    const capabilities: SearchCapabilities = { ...cfrCapabilities, utilityDeclared: 'general' };
    const result = deriveSearchBlueprint(
      twoPlayerZeroSumClassification,
      capabilities,
      TREE_SEARCH_SAMPLES,
      30 * 60 * 1000,
    );
    expect(result).toEqual([]);
  });

  it('does not recommend CFR when informationStateKey is not declared', () => {
    const capabilities: SearchCapabilities = { ...cfrCapabilities, hasInformationStateKey: false };
    const result = deriveSearchBlueprint(
      twoPlayerZeroSumClassification,
      capabilities,
      TREE_SEARCH_SAMPLES,
      30 * 60 * 1000,
    );
    expect(result).toEqual([]);
  });

  it('does not recommend CFR for a non-2-player game', () => {
    const capabilities: SearchCapabilities = { ...cfrCapabilities, playerCount: 4 };
    const result = deriveSearchBlueprint(
      classifyGame({ ...gomokuAdapter.spec, playerCount: 4 }),
      capabilities,
      TREE_SEARCH_SAMPLES,
      30 * 60 * 1000,
    );
    expect(result).toEqual([]);
  });
});

describe('deriveSearchBlueprint: budget selection from throughputSamples', () => {
  const capabilities: SearchCapabilities = { ...NO_CAPABILITIES, hasReconstructState: true };

  it('picks the highest simulations whose projected wave cost fits the budget', () => {
    // 120-game approximation: s64 -> 12,000ms, s256 -> 48,000ms, s512 -> 108,000ms.
    const result = deriveSearchBlueprint(
      twoPlayerZeroSumClassification,
      capabilities,
      TREE_SEARCH_SAMPLES,
      60_000,
    );
    expect(result[0]?.simulations).toBe(256);
  });

  it('picks a larger budget when the wave time budget is generous', () => {
    const result = deriveSearchBlueprint(
      twoPlayerZeroSumClassification,
      capabilities,
      TREE_SEARCH_SAMPLES,
      30 * 60 * 1000,
    );
    expect(result[0]?.simulations).toBe(512);
  });

  it('falls back to the smallest measured budget with a warning rationale when every sample exceeds the budget', () => {
    const result = deriveSearchBlueprint(twoPlayerZeroSumClassification, capabilities, TREE_SEARCH_SAMPLES, 1);
    expect(result[0]?.simulations).toBe(64);
    expect(result[0]?.rationale).toMatch(/WARNING/);
  });

  it('is order-independent over an unsorted throughputSamples input', () => {
    const shuffled = [TREE_SEARCH_SAMPLES[2], TREE_SEARCH_SAMPLES[0], TREE_SEARCH_SAMPLES[1]] as ThroughputSample[];
    const result = deriveSearchBlueprint(twoPlayerZeroSumClassification, capabilities, shuffled, 60_000);
    expect(result[0]?.simulations).toBe(256);
  });

  it('throws when a search family was derived but no throughput samples were supplied', () => {
    expect(() =>
      deriveSearchBlueprint(twoPlayerZeroSumClassification, capabilities, [], 60_000),
    ).toThrow(/throughputSamples/);
  });
});

describe('deriveSearchBlueprint: tacticalPrecheckDepth', () => {
  const capabilities: SearchCapabilities = { ...NO_CAPABILITIES, hasReconstructState: true };

  it('defaults to depth 1 for a two-player tree-search family with no branching-factor signal', () => {
    const result = deriveSearchBlueprint(
      twoPlayerZeroSumClassification,
      capabilities,
      TREE_SEARCH_SAMPLES,
      30 * 60 * 1000,
    );
    expect(result[0]?.tacticalPrecheckDepth).toBe(1);
  });

  it('escalates to depth 2 when averageLegalChoiceCount squared fits the conservative ceiling', () => {
    const result = deriveSearchBlueprint(
      twoPlayerZeroSumClassification,
      capabilities,
      TREE_SEARCH_SAMPLES,
      30 * 60 * 1000,
      { averageLegalChoiceCount: 50 }, // 50^2 = 2,500 <= 10,000
    );
    expect(result[0]?.tacticalPrecheckDepth).toBe(2);
  });

  it('stays at depth 1 when averageLegalChoiceCount squared exceeds the ceiling', () => {
    const result = deriveSearchBlueprint(
      twoPlayerZeroSumClassification,
      capabilities,
      TREE_SEARCH_SAMPLES,
      30 * 60 * 1000,
      { averageLegalChoiceCount: 200 }, // 200^2 = 40,000 > 10,000
    );
    expect(result[0]?.tacticalPrecheckDepth).toBe(1);
  });

  it('stays at depth 0 for a non-two-player match structure even with reconstructState declared', () => {
    const ffaClassification = classifyGame({ ...gomokuAdapter.spec, playerCount: 4, scoreMargin: 'none' });
    const result = deriveSearchBlueprint(ffaClassification, capabilities, TREE_SEARCH_SAMPLES, 30 * 60 * 1000, {
      averageLegalChoiceCount: 10,
    });
    expect(result[0]?.tacticalPrecheckDepth).toBe(0);
  });

  it('stays at depth 0 for the information-set-tree-search family regardless of match structure or legal-choice signal', () => {
    const ismctsCapabilities: SearchCapabilities = { ...NO_CAPABILITIES, hasSampleStateFromObservation: true };
    const result = deriveSearchBlueprint(
      twoPlayerZeroSumClassification,
      ismctsCapabilities,
      TREE_SEARCH_SAMPLES,
      30 * 60 * 1000,
      { averageLegalChoiceCount: 5 },
    );
    // information-set-tree-search IS a tree-search-family per the rule, so
    // depth escalates the same way tree-search does — this asserts that
    // behavior explicitly rather than assuming it.
    expect(result[0]?.tacticalPrecheckDepth).toBe(2);
  });
});

/**
 * G4 (docs/FIX-BACKLOG.md): regression fixtures built from the 7 onboarded
 * games' *real* classification + declared capabilities + this round's
 * measured throughput (docs/GAP-ANALYSIS-8.md §1/§4.6/§4.7), asserting that
 * `deriveSearchBlueprint`'s family/rolloutTier direction matches the
 * algorithm family a human actually chose for that game. Exact simulation
 * counts are NOT asserted — this checks direction, not reproduction of a
 * specific historical choice (docs/GAP-ANALYSIS-9.md §3: the point is to
 * validate the design against precedent, not to re-litigate exact past
 * budgets). Purely data-driven, so this costs nothing to run.
 */
describe('deriveSearchBlueprint: G4 regression fixtures (7 onboarded games)', () => {
  const WAVE_BUDGET_MS = 30 * 60 * 1000;

  it('gomoku: perfect info + reconstructState -> tree-search, heuristic rollout (matches mcts2-s256-hr, adopted v4)', () => {
    const classification = classifyGame(gomokuAdapter.spec);
    const capabilities: SearchCapabilities = {
      hasReconstructState: gomokuAdapter.reconstructState !== undefined,
      hasSampleStateFromObservation: gomokuAdapter.sampleStateFromObservation !== undefined,
      hasInformationStateKey: gomokuAdapter.informationStateKey !== undefined,
      utilityDeclared: classification.utilityDeclared ? classification.utilityStructure : undefined,
      playerCount: gomokuAdapter.spec.playerCount,
    };
    // docs/GAP-ANALYSIS-8.md §4.6: mcts2-s256-cr ~88ms/game, mcts2-s512-hr ~530ms/game.
    const throughputSamples: ThroughputSample[] = [
      { simulations: 64, msPerGame: 40 },
      { simulations: 256, msPerGame: 88 },
      { simulations: 512, msPerGame: 530 },
    ];
    const result = deriveSearchBlueprint(classification, capabilities, throughputSamples, WAVE_BUDGET_MS);
    expect(result.some((r) => r.family === 'tree-search' && r.rolloutTier === 'heuristic')).toBe(true);
    expect(result.some((r) => r.family === 'counterfactual-regret')).toBe(false);
  });

  it('janggi: perfect info + reconstructState -> tree-search, heuristic rollout (matches mcts2-s128-hr attempt)', () => {
    const classification = classifyGame(janggiAdapter.spec);
    const capabilities: SearchCapabilities = {
      hasReconstructState: janggiAdapter.reconstructState !== undefined,
      hasSampleStateFromObservation: janggiAdapter.sampleStateFromObservation !== undefined,
      hasInformationStateKey: janggiAdapter.informationStateKey !== undefined,
      utilityDeclared: classification.utilityDeclared ? classification.utilityStructure : undefined,
      playerCount: janggiAdapter.spec.playerCount,
    };
    const throughputSamples: ThroughputSample[] = [
      { simulations: 64, msPerGame: 200 },
      { simulations: 128, msPerGame: 380 },
    ];
    const result = deriveSearchBlueprint(classification, capabilities, throughputSamples, WAVE_BUDGET_MS);
    expect(result.some((r) => r.family === 'tree-search' && r.rolloutTier === 'heuristic')).toBe(true);
  });

  it('splendor: hidden info + sampleStateFromObservation -> information-set-tree-search (matches ismcts-s128-hr/-cr)', () => {
    const classification = classifyGame(splendorAdapter.spec);
    const capabilities: SearchCapabilities = {
      hasReconstructState: splendorAdapter.reconstructState !== undefined,
      hasSampleStateFromObservation: splendorAdapter.sampleStateFromObservation !== undefined,
      hasInformationStateKey: splendorAdapter.informationStateKey !== undefined,
      utilityDeclared: classification.utilityDeclared ? classification.utilityStructure : undefined,
      playerCount: splendorAdapter.spec.playerCount,
    };
    // docs/GAP-ANALYSIS-8.md §4.7: ismcts-s128-cr ~1,441ms/game.
    const throughputSamples: ThroughputSample[] = [
      { simulations: 64, msPerGame: 700 },
      { simulations: 128, msPerGame: 1441 },
    ];
    const result = deriveSearchBlueprint(classification, capabilities, throughputSamples, WAVE_BUDGET_MS);
    expect(result.some((r) => r.family === 'information-set-tree-search' && r.rolloutTier === 'heuristic')).toBe(
      true,
    );
    expect(result.some((r) => r.family === 'counterfactual-regret')).toBe(false);
  });

  it('dominion: hidden info + sampleStateFromObservation -> information-set-tree-search (matches ismcts-s64-hr/-cr)', () => {
    const classification = classifyGame(dominionAdapter.spec);
    const capabilities: SearchCapabilities = {
      hasReconstructState: dominionAdapter.reconstructState !== undefined,
      hasSampleStateFromObservation: dominionAdapter.sampleStateFromObservation !== undefined,
      hasInformationStateKey: dominionAdapter.informationStateKey !== undefined,
      utilityDeclared: classification.utilityDeclared ? classification.utilityStructure : undefined,
      playerCount: dominionAdapter.spec.playerCount,
    };
    // docs/GAP-ANALYSIS-8.md §4.7: ismcts-s64-cr ~1,848ms/game.
    const throughputSamples: ThroughputSample[] = [
      { simulations: 64, msPerGame: 1848 },
    ];
    const result = deriveSearchBlueprint(classification, capabilities, throughputSamples, WAVE_BUDGET_MS);
    expect(result.some((r) => r.family === 'information-set-tree-search' && r.rolloutTier === 'heuristic')).toBe(
      true,
    );
  });

  it('hearthstone: hidden info + sampleStateFromObservation -> information-set-tree-search (matches ismcts-s128-hr, adopted v2)', () => {
    const classification = classifyGame(hearthstoneAdapter.spec);
    const capabilities: SearchCapabilities = {
      hasReconstructState: hearthstoneAdapter.reconstructState !== undefined,
      hasSampleStateFromObservation: hearthstoneAdapter.sampleStateFromObservation !== undefined,
      hasInformationStateKey: hearthstoneAdapter.informationStateKey !== undefined,
      utilityDeclared: classification.utilityDeclared ? classification.utilityStructure : undefined,
      playerCount: hearthstoneAdapter.spec.playerCount,
    };
    const throughputSamples: ThroughputSample[] = [{ simulations: 128, msPerGame: 1259 }];
    const result = deriveSearchBlueprint(classification, capabilities, throughputSamples, WAVE_BUDGET_MS);
    expect(result.some((r) => r.family === 'information-set-tree-search' && r.rolloutTier === 'heuristic')).toBe(
      true,
    );
  });

  it('wingspan: hidden info + sampleStateFromObservation -> information-set-tree-search (matches ismcts-s256-hr, adopted v2)', () => {
    const classification = classifyGame(wingspanAdapter.spec);
    const capabilities: SearchCapabilities = {
      hasReconstructState: wingspanAdapter.reconstructState !== undefined,
      hasSampleStateFromObservation: wingspanAdapter.sampleStateFromObservation !== undefined,
      hasInformationStateKey: wingspanAdapter.informationStateKey !== undefined,
      utilityDeclared: classification.utilityDeclared ? classification.utilityStructure : undefined,
      playerCount: wingspanAdapter.spec.playerCount,
    };
    const throughputSamples: ThroughputSample[] = [{ simulations: 256, msPerGame: 1500 }];
    const result = deriveSearchBlueprint(classification, capabilities, throughputSamples, WAVE_BUDGET_MS);
    expect(result.some((r) => r.family === 'information-set-tree-search' && r.rolloutTier === 'heuristic')).toBe(
      true,
    );
  });

  it('mini-trick: neither reconstructState nor sampleStateFromObservation, but informationStateKey + 2p + zero-sum -> counterfactual-regret only (matches mccfr-os-150000-pr)', () => {
    const classification = classifyGame(miniTrickAdapter.spec);
    const capabilities: SearchCapabilities = {
      hasReconstructState: miniTrickAdapter.reconstructState !== undefined,
      hasSampleStateFromObservation: miniTrickAdapter.sampleStateFromObservation !== undefined,
      hasInformationStateKey: miniTrickAdapter.informationStateKey !== undefined,
      utilityDeclared: classification.utilityDeclared ? classification.utilityStructure : undefined,
      playerCount: miniTrickAdapter.spec.playerCount,
    };
    const result = deriveSearchBlueprint(classification, capabilities, [], WAVE_BUDGET_MS);
    expect(result).toHaveLength(1);
    expect(result[0]?.family).toBe('counterfactual-regret');
  });
});
