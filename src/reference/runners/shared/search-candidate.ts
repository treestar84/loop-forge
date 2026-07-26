/**
 * Single translation helper: turns a `kernel/search-blueprint.ts`
 * `SearchCandidateRecommendation` (pure data — no search/learn imports
 * allowed at that layer) into an actual `StrategyFlagSpec` a runner can add
 * to an adapter's strategySurface via `withStrategyFlags` (docs/GAP-ANALYSIS-9.md
 * §2, docs/FIX-BACKLOG.md G3).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-exempt,
 * may wire every layer, including search/) per
 * src/__tests__/dependency-rules.test.ts's APP_BOUNDARY_PREFIXES.
 *
 * Scope: new games only. The 6 existing per-game `*-mcts-flag.ts`/
 * `*-ismcts-flag.ts` files under this same directory are NOT replaced by
 * this helper — they reproduce already-adopted baselines and must not
 * change behavior underneath a registry that has already graduated a
 * candidate built from them (docs/GAP-ANALYSIS-9.md §3).
 */

import type { AnyGameAdapter, StrategyFlagSpec } from '../../../contract/types';
import type { SearchCandidateRecommendation } from '../../../kernel/search-blueprint';
import { ismctsBotFactory } from '../../../search/ismcts';
import { mctsBotFactory, type MctsConfig } from '../../../search/mcts';

/**
 * Translate `recommendation` into an `MctsConfig` shared by both the
 * tree-search and information-set-tree-search branches below — the fields
 * `SearchCandidateRecommendation` carries map 1:1 onto `MctsConfig`'s own
 * fields (`rolloutTier` -> `rolloutPolicy`, `tacticalPrecheckDepth` ->
 * `tacticalDepth`), `uctC` is left at the same 1.4 constant every existing
 * shared flag file already uses (gomoku-mcts-flag.ts, splendor-ismcts-flag.ts,
 * …), and `rolloutCount` is fixed at 1 — every existing 'heuristic'-tier
 * shared flag already settled on rolloutCount=1 once heuristic rollouts
 * replaced random ones (gomoku-mcts-flag.ts's GOMOKU_MCTS_HR_CONFIG doc
 * comment: rolloutCount=2 was only ever needed for the weaker random-rollout
 * evaluator).
 */
function toMctsConfig(recommendation: SearchCandidateRecommendation): MctsConfig {
  return {
    simulations: recommendation.simulations,
    uctC: 1.4,
    rolloutCount: 1,
    label: recommendation.flagLabel.replace(/^(mcts|ismcts)-/, ''),
    rolloutPolicy: recommendation.rolloutTier,
    tacticalDepth: recommendation.tacticalPrecheckDepth,
  };
}

/**
 * Build a `StrategyFlagSpec` from `recommendation` for `adapter`. `apply()`
 * ignores its `base` argument entirely, exactly like every existing
 * MCTS/IS-MCTS shared flag spec (`mctsBotFactory`/`ismctsBotFactory` build
 * their decision from search, not by modulating a base bot's choice) —
 * see gomoku-mcts-flag.ts's/splendor-ismcts-flag.ts's doc comments.
 *
 * `counterfactual-regret` is out of scope: unlike MCTS/IS-MCTS, a CFR bot
 * needs a trained `PolicyTable` (learn/mccfr.ts) before a bot factory can
 * even be constructed — there is no config this helper could translate a
 * recommendation into on the spot. Callers must run CFR training separately
 * (see `learn/mccfr.ts` and any existing `*-mccfr.ts` runner for the
 * pattern) and are expected never to pass a CFR recommendation here.
 */
export function searchCandidateFlagSpec(
  adapter: AnyGameAdapter,
  recommendation: SearchCandidateRecommendation,
): StrategyFlagSpec<unknown, unknown> {
  if (recommendation.family === 'counterfactual-regret') {
    throw new Error(
      'searchCandidateFlagSpec: counterfactual-regret recommendations are out of scope for this helper — ' +
        'a CFR bot requires a trained PolicyTable (learn/mccfr.ts) before a StrategyFlagSpec can exist. ' +
        'Train a policy table separately and wire its resulting bot factory in by hand.',
    );
  }
  if (recommendation.family === 'none') {
    throw new Error(
      'searchCandidateFlagSpec: recommendation.family is "none" — deriveSearchBlueprint returns no ' +
        'entries at all for this case (kernel/search-blueprint.ts), so this call site has a bug: ' +
        'nothing should ever construct a "none" recommendation to pass here.',
    );
  }

  const config = toMctsConfig(recommendation);
  const factory =
    recommendation.family === 'tree-search'
      ? () => mctsBotFactory(adapter, config)
      : () => ismctsBotFactory(adapter, config);

  return {
    flag: recommendation.flagLabel,
    description:
      `Auto-derived ${recommendation.family} search candidate "${recommendation.flagLabel}" ` +
      `(kernel/search-blueprint.ts's deriveSearchBlueprint, docs/GAP-ANALYSIS-9.md); ignores the base bot entirely. ${recommendation.rationale}`,
    apply: factory,
  };
}
