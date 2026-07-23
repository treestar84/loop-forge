/**
 * Shared IS-MCTS strategy-flag spec for splendor (docs/FIX-BACKLOG.md P4),
 * factored out so any runner that needs to reconstruct this candidate
 * (registered into `runs/splendor/registry.json` by
 * `reference/runners/splendor.ts`'s ismcts-wave-1) does so with the exact
 * same config — a mismatched determinization/simulation budget would
 * silently reproduce a differently-behaved bot under the same flag name
 * (same rationale as `shared/gomoku-mcts-flag.ts`'s doc comment).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-exempt,
 * may wire every layer, including search/) per
 * src/__tests__/dependency-rules.test.ts's APP_BOUNDARY_PREFIXES.
 */

import type { AnyGameAdapter, StrategyFlagSpec } from '../../../contract/types';
import { ismctsBotFactory } from '../../../search/ismcts';
import type { MctsConfig } from '../../../search/mcts';

/**
 * simulations=128 (== the number of fresh determinizations sampled per
 * `decide()` call, docs/FIX-BACKLOG.md P4 — SO-ISMCTS draws one
 * determinization per simulation): throughput measurement (scratch script,
 * not checked in; nice -n 10, single process, 3 games/matchup) showed
 * ismcts-s64-hr costs ~569ms/game vs heuristic (~504ms/game in the cheaper
 * regression matchup vs the v2 `buyHighestPoints` baseline) while
 * ismcts-s128-hr costs ~1,259ms/game vs heuristic (~974ms/game vs v2). 128
 * was chosen over 64 for the extra search depth headroom it buys while
 * staying comfortably inside the 30-minute wave budget (see
 * reference/runners/splendor.ts's ismcts-wave-1 comment for the full
 * block-count arithmetic). rolloutPolicy 'heuristic' (not 'random') so
 * rollouts are driven by splendor's own `baselines.heuristic` bot rather
 * than uniform-random gem/card choices — matching the P1/P5 lesson from
 * gomoku's MCTS waves that random rollout is a much weaker evaluator once a
 * decent heuristic exists to swap in instead.
 */
export const SPLENDOR_ISMCTS_S128_HR_CONFIG: MctsConfig = {
  simulations: 128,
  uctC: 1.4,
  rolloutCount: 1,
  label: 's128-hr',
  rolloutPolicy: 'heuristic',
};
export const SPLENDOR_ISMCTS_S128_HR_FLAG = 'ismcts-s128-hr';

/**
 * Build the `ismcts-s128-hr` StrategyFlagSpec for `adapter` — `apply()`
 * ignores its `base` argument entirely (mirrors `mctsBotFactory`'s doc
 * comment in search/mcts.ts): an IS-MCTS candidate builds its decision from
 * search over sampled determinizations, not by modulating a base bot's
 * choice.
 */
export function splendorIsmctsFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  return {
    flag: SPLENDOR_ISMCTS_S128_HR_FLAG,
    description:
      'SO-ISMCTS search candidate over sampled deck-order determinizations (docs/FIX-BACKLOG.md P4); ignores the base bot entirely.',
    apply: () => ismctsBotFactory(adapter, SPLENDOR_ISMCTS_S128_HR_CONFIG),
  };
}
