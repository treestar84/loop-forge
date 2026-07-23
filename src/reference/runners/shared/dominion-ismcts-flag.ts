/**
 * Shared IS-MCTS strategy-flag spec for dominion (docs/FIX-BACKLOG.md P4),
 * factored out so any runner that needs to reconstruct this candidate
 * (registered into `runs/dominion/registry.json` by
 * `reference/runners/dominion.ts`'s ismcts-wave-1) does so with the exact
 * same config — a mismatched determinization/simulation budget would
 * silently reproduce a differently-behaved bot under the same flag name
 * (same rationale as `shared/splendor-ismcts-flag.ts`'s doc comment, the
 * precedent this file mirrors).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-exempt,
 * may wire every layer, including search/) per
 * src/__tests__/dependency-rules.test.ts's APP_BOUNDARY_PREFIXES.
 */

import type { AnyGameAdapter, StrategyFlagSpec } from '../../../contract/types';
import { ismctsBotFactory } from '../../../search/ismcts';
import type { MctsConfig } from '../../../search/mcts';

/**
 * simulations=64: throughput measurement (scratch script, not checked in;
 * nice -n 10, single process, 3 seeds/matchup, both seats) showed
 * ismcts-s64-hr costs ~2,545ms/game vs heuristic, while ismcts-s128-hr costs
 * ~7,317ms/game vs heuristic — a much steeper simulations-to-cost slope than
 * splendor's (shared/splendor-ismcts-flag.ts's doc comment: ~569ms at s64 vs
 * ~1,259ms at s128, roughly linear), because dominion's branching factor is
 * far larger per decision (a buy-phase legal set can offer every affordable
 * card in the 10-card kingdom plus basics, vs splendor's handful of gem/buy/
 * reserve choices) and games run longer (maxDecisionsPerGame=800 vs
 * splendor's 600). 64 was chosen over 128 to keep the wave (smoke+prune+
 * holdout+regression, see reference/runners/dominion.ts's ismcts-wave-1
 * comment for the full block-count arithmetic) comfortably inside the
 * 30-minute wave budget; 128's ~2.9x cost jump for one extra doubling of
 * simulations was not worth the budget risk here the way it was for
 * splendor. rolloutPolicy 'heuristic' (not 'random') for the same P1/P5
 * reason splendor's config documents: rollouts driven by dominion's own
 * `baselines.heuristic` bot are a much stronger evaluator than uniform-random
 * action/buy choices.
 */
export const DOMINION_ISMCTS_S64_HR_CONFIG: MctsConfig = {
  simulations: 64,
  uctC: 1.4,
  rolloutCount: 1,
  label: 's64-hr',
  rolloutPolicy: 'heuristic',
};
export const DOMINION_ISMCTS_S64_HR_FLAG = 'ismcts-s64-hr';

/**
 * Build the `ismcts-s64-hr` StrategyFlagSpec for `adapter` — `apply()`
 * ignores its `base` argument entirely (mirrors `mctsBotFactory`'s doc
 * comment in search/mcts.ts and splendorIsmctsFlagSpec's precedent): an
 * IS-MCTS candidate builds its decision from search over sampled
 * determinizations, not by modulating a base bot's choice.
 */
export function dominionIsmctsFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  return {
    flag: DOMINION_ISMCTS_S64_HR_FLAG,
    description:
      'SO-ISMCTS search candidate over sampled hand/deck determinizations (docs/FIX-BACKLOG.md P4); ignores the base bot entirely.',
    apply: () => ismctsBotFactory(adapter, DOMINION_ISMCTS_S64_HR_CONFIG),
  };
}
