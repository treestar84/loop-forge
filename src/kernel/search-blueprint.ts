/**
 * Search/learn candidate-recommendation blueprint: `deriveBlueprint`'s sister
 * function for the tree-search/IS-MCTS/CFR family choice, budget, rollout
 * tier, and tactical-precheck depth an onboarding wave should try first
 * (docs/GAP-ANALYSIS-9.md — the algorithm/budget/rollout-tier choice that,
 * before this module, lived only in an agent's scratch measurements per
 * game, re-derived from nothing every time a new game onboarded).
 *
 * Output is pure data (no MctsConfig/IsmctsConfig/MccfrConfig, no imports
 * from search/ or learn/) so this stays inside the kernel layer's allowed
 * import set (kernel -> contract only, src/__tests__/dependency-rules.test.ts).
 * Translating a recommendation into a real bot-factory config is
 * reference/runners/shared/search-candidate.ts's job — an app boundary that
 * is allowed to import search/learn directly.
 */

import type { GameClassification } from './classify';

export type SearchFamily =
  | 'tree-search'
  | 'information-set-tree-search'
  | 'counterfactual-regret'
  | 'none';

/** Flat capability signal: which of the adapter's optional search hooks it declares, not the hooks themselves (kernel never touches an adapter instance). */
export interface SearchCapabilities {
  readonly hasReconstructState: boolean;
  readonly hasSampleStateFromObservation: boolean;
  readonly hasInformationStateKey: boolean;
  readonly utilityDeclared: 'zero-sum' | 'general' | undefined;
  readonly playerCount: number;
}

/** One measured (simulations, wall-clock cost) point, supplied by the app boundary that actually ran the throughput probe. */
export interface ThroughputSample {
  readonly simulations: number;
  readonly msPerGame: number;
}

export interface SearchCandidateRecommendation {
  readonly family: SearchFamily;
  readonly simulations: number;
  readonly rolloutTier: 'random' | 'heuristic';
  readonly tacticalPrecheckDepth: 0 | 1 | 2;
  /** Deterministic, reproducible flag-name string — see `flagLabelFor`'s doc comment for the exact generation rule. */
  readonly flagLabel: string;
  readonly rationale: string;
}

export interface DeriveSearchBlueprintOptions {
  /** Mean legal-choice count per decision (`loop/calibrate.ts`'s `measureAverageLegalChoiceCount`/`NoiseFloorResult.averageLegalChoiceCount`, G2). Omitted means "no branching-factor signal available" — the tactical-precheck rule below then stays conservative (depth 1, never 2). */
  readonly averageLegalChoiceCount?: number;
}

/**
 * Approximate number of self-play games one strategySurface candidate costs
 * across a full onboarding wave (screen -> smoke -> prune -> holdout ->
 * regression, docs/GAP-ANALYSIS-9.md §2 / ONBOARDING-GUIDE.md's wave
 * stages) — each stage's actual block count is itself calibration-derived
 * (`kernel/blueprint.ts`'s `recommendBlockCount`), so this is a documented
 * approximation, not a stage-by-stage sum. Observed wave sizes across the
 * onboarded games in docs/GAP-ANALYSIS-8.md's sweep cluster around 90-120
 * games; picking the high end here is the conservative choice for budget
 * selection below — it never *under*-estimates a wave's cost, so the chosen
 * simulation count never turns out slower than projected once every stage
 * actually runs.
 */
const APPROXIMATE_WAVE_GAME_COUNT = 120;

/**
 * `search/mcts.ts`'s `MctsConfig.tacticalDepth: 2` opponent-reply check costs
 * O(legalChoiceCount^2) per root decision (`applyChoice`+`getOutcome` only,
 * no simulation) — gomoku's `mcts2-s256-tactical` flag measured
 * legal^2≈40,000 as tolerable at ~1.6s/game (docs/GAP-ANALYSIS-8.md §4.8).
 * This ceiling is a conservative fraction of that empirically-tolerable
 * value, applied generically instead of re-deriving it per game.
 */
const TACTICAL_DEPTH_2_LEGAL_SQUARED_CEILING = 10_000;

function deriveFamily(capabilities: SearchCapabilities): SearchFamily {
  // sampleStateFromObservation takes priority: a hidden-information adapter
  // may never declare reconstructState (contract/types.ts's doc comment
  // forbids it), but nothing stops a perfect-information adapter from
  // declaring both — IS-MCTS is still the right choice there since it is
  // the strictly more general algorithm (its determinization degenerates to
  // the single true state when there is nothing hidden to sample over).
  if (capabilities.hasSampleStateFromObservation) {
    return 'information-set-tree-search';
  }
  if (capabilities.hasReconstructState) {
    return 'tree-search';
  }
  return 'none';
}

function selectSimulationBudget(
  throughputSamples: readonly ThroughputSample[],
  waveTimeBudgetMs: number,
): { readonly simulations: number; readonly rationale: string } {
  if (throughputSamples.length === 0) {
    throw new Error(
      'deriveSearchBlueprint: throughputSamples must not be empty when a search family was derived — ' +
        'run a throughput probe first (the app boundary that calls this function is responsible for measuring it)',
    );
  }
  const sorted = [...throughputSamples].sort((a, b) => a.simulations - b.simulations);

  // Highest simulations whose projected wave cost still fits the budget.
  let chosen: ThroughputSample | null = null;
  for (const sample of sorted) {
    const projectedWaveMs = sample.msPerGame * APPROXIMATE_WAVE_GAME_COUNT;
    if (projectedWaveMs <= waveTimeBudgetMs) {
      chosen = sample;
    }
  }
  if (chosen !== null) {
    const projectedWaveMs = Math.round(chosen.msPerGame * APPROXIMATE_WAVE_GAME_COUNT);
    return {
      simulations: chosen.simulations,
      rationale:
        `simulations=${chosen.simulations} projects to ~${projectedWaveMs}ms across a ` +
        `~${APPROXIMATE_WAVE_GAME_COUNT}-game wave, within the ${waveTimeBudgetMs}ms budget.`,
    };
  }

  // Every sample exceeds the budget: fall back to the cheapest measured
  // budget and say so, rather than silently picking a number nobody measured.
  const smallest = sorted[0] as ThroughputSample;
  const projectedWaveMs = Math.round(smallest.msPerGame * APPROXIMATE_WAVE_GAME_COUNT);
  return {
    simulations: smallest.simulations,
    rationale:
      `WARNING: every measured throughput sample exceeds the ${waveTimeBudgetMs}ms wave budget, ` +
      `even at the smallest simulations=${smallest.simulations} (~${projectedWaveMs}ms projected). ` +
      'Falling back to the smallest measured budget; expect this wave to run over budget, or shrink it.',
  };
}

function deriveTacticalPrecheckDepth(
  family: SearchFamily,
  classification: GameClassification,
  averageLegalChoiceCount: number | undefined,
): 0 | 1 | 2 {
  const isTreeSearchFamily = family === 'tree-search' || family === 'information-set-tree-search';
  if (!isTreeSearchFamily || classification.matchStructure !== 'two-player') {
    return 0;
  }
  // Depth 1 (immediate-win check) is effectively free — one applyChoice+
  // getOutcome per root-legal choice, no simulation — so it is always at
  // least this once the family/match-structure gate above passes.
  if (
    averageLegalChoiceCount !== undefined &&
    averageLegalChoiceCount ** 2 <= TACTICAL_DEPTH_2_LEGAL_SQUARED_CEILING
  ) {
    return 2;
  }
  return 1;
}

/**
 * Deterministic flag-name generation: `${familyPrefix}-s${simulations}-hr`
 * for tree-search/IS-MCTS families (the `-hr` suffix records that
 * `rolloutTier` is always 'heuristic' here — see the rule below), or
 * `mccfr-os-auto` for counterfactual-regret (CFR has no per-decision
 * simulation budget to stamp into its label — see that recommendation's
 * `rationale` for why).
 */
function flagLabelFor(family: SearchFamily, simulations: number): string {
  switch (family) {
    case 'tree-search':
      return `mcts-s${simulations}-hr`;
    case 'information-set-tree-search':
      return `ismcts-s${simulations}-hr`;
    case 'counterfactual-regret':
      return 'mccfr-os-auto';
    case 'none':
      throw new Error('flagLabelFor: no flag label for family "none"');
  }
}

/**
 * Derive first-attempt search/learn candidate recommendations from a game's
 * classification, declared search capabilities, and measured throughput —
 * the same judgment call an agent previously made by hand (3-game scratch
 * measurement, docs/GAP-ANALYSIS-9.md §1) for every onboarded game,
 * factored into a reusable, pure function.
 *
 * Deliberately narrow in scope (docs/GAP-ANALYSIS-9.md §3): this recommends
 * a *first* candidate to try, not a champion-rollout or already-adopted
 * baseline — those remain the onboarding wave's job, same as before.
 */
export function deriveSearchBlueprint(
  classification: GameClassification,
  capabilities: SearchCapabilities,
  throughputSamples: readonly ThroughputSample[],
  waveTimeBudgetMs: number,
  options?: DeriveSearchBlueprintOptions,
): readonly SearchCandidateRecommendation[] {
  const recommendations: SearchCandidateRecommendation[] = [];
  const family = deriveFamily(capabilities);

  if (family === 'none') {
    // Neither reconstructState nor sampleStateFromObservation is declared —
    // no search family can build a simulation root for this adapter yet.
    // This is the extension point for future determinization/reconstruction
    // work on such an adapter: once one of those hooks is implemented,
    // re-running this function will surface a tree-search/IS-MCTS candidate
    // automatically, with no change needed here.
  } else {
    const { simulations, rationale } = selectSimulationBudget(throughputSamples, waveTimeBudgetMs);
    const tacticalPrecheckDepth = deriveTacticalPrecheckDepth(
      family,
      classification,
      options?.averageLegalChoiceCount,
    );
    const capabilitySource =
      family === 'tree-search'
        ? 'reconstructState declared (perfect-information simulation root)'
        : 'sampleStateFromObservation declared (hidden-information determinization)';
    recommendations.push({
      family,
      simulations,
      // 'heuristic' is the default rollout tier whenever a family is
      // recommended at all: P1 (docs/FIX-BACKLOG.md) already established
      // that random rollout is a much weaker evaluator than the adapter's
      // own heuristic baseline once one exists. 'champion' rollout tiers
      // are deliberately out of scope here — they require an already-adopted
      // baseline to build a composite bot from, which only exists after a
      // wave has run (docs/GAP-ANALYSIS-9.md §2's §6.1 escalation path).
      rolloutTier: 'heuristic',
      tacticalPrecheckDepth,
      flagLabel: flagLabelFor(family, simulations),
      rationale: `${family} recommended: ${capabilitySource}. ${rationale}`,
    });
  }

  // CFR eligibility is independent of the tree-search/IS-MCTS branch above —
  // both can be recommended in parallel for the same game (docs/GAP-ANALYSIS-9.md
  // §2: "트리서치 계열과 배타적이지 않음, 병행"), since a CFR-trained policy
  // table and a per-decision search bot are two entirely different candidate
  // types a wave can try side by side.
  const cfrEligible =
    capabilities.playerCount === 2 &&
    capabilities.utilityDeclared === 'zero-sum' &&
    capabilities.hasInformationStateKey;
  if (cfrEligible) {
    recommendations.push({
      family: 'counterfactual-regret',
      // CFR's budget is training iterations (learn/mccfr.ts's
      // MccfrConfig.iterations), not a per-decision search simulation count,
      // and training must fully complete before a bot exists at all (unlike
      // MCTS/IS-MCTS, which search fresh on every decide() call) — so it is
      // not sized from the same per-game throughputSamples/waveTimeBudgetMs
      // arithmetic the tree-search branch above uses. 0 is a placeholder;
      // the training step picks its own iteration count (memory-bounded, see
      // docs/FIX-BACKLOG.md P3's heapUsed staircase measurement for mini-trick).
      simulations: 0,
      rolloutTier: 'heuristic',
      // CFR has no notion of a root-level tactical precheck (that machinery
      // is specific to search/mcts.ts's/search/ismcts.ts's per-decision
      // search loop) — always 0 for this family.
      tacticalPrecheckDepth: 0,
      flagLabel: flagLabelFor('counterfactual-regret', 0),
      rationale:
        'counterfactual-regret recommended alongside any tree-search/IS-MCTS candidate above (not exclusive ' +
        'with it): playerCount===2, utility declared zero-sum, and informationStateKey declared are exactly the ' +
        'preconditions outcome-sampling MCCFR (src/learn/mccfr.ts) needs for a sound convergence guarantee. ' +
        'Training must run separately before a bot exists (reference/runners/shared/search-candidate.ts leaves ' +
        'this family out of scope and throws if asked to translate it).',
    });
  }

  return recommendations;
}
