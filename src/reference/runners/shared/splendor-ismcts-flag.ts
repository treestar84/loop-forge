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
import { composeBot } from '../../../loop/compose';
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

/**
 * ismcts-wave-3 (docs/GAP-ANALYSIS-8.md §4.5's near-miss, DESIGN.md §6.1
 * near-miss loop retry): "champion rollout" — instead of
 * `adapter.baselines.heuristic` driving rollouts (the 'heuristic'
 * rolloutPolicy that `ismcts-s128-hr` used and which lost to the current
 * champion 0.325 in ismcts-wave-2's regression tier), a composeBot-assembled
 * composite of the CURRENT registry champion's own flags (`buyHighestPoints`,
 * splendor's only adopted flag as of v2) drives rollouts via
 * `search/mcts.ts`'s `rolloutFactory` option — the same lever
 * `gomoku-mcts-flag.ts`'s `GOMOKU_MCTS2_S256_CR_FLAG` used, now applied to
 * IS-MCTS since `ismcts.ts` reuses `MctsConfig`/`evaluate` verbatim (see
 * `search/ismcts.ts`'s doc comment) and therefore already accepts
 * `rolloutFactory` with no code change there. A new flag name (`ismcts-s128-cr`,
 * not a reuse of `ismcts-s128-hr`) because the rollout-policy logic is
 * genuinely different (DESIGN.md §6.1's "이미 판정된 이름 재사용 금지" rule).
 * `adapter` here must be the plain game adapter (its own strategySurface, not
 * yet extended with any IS-MCTS flags) so composeBot can resolve
 * `buyHighestPoints` — the same `adapter` splendor.ts already threads into
 * `splendorIsmctsFlagSpec` above.
 */
export const SPLENDOR_CHAMPION_ROLLOUT_FLAGS = ['buyHighestPoints'] as const;

export const SPLENDOR_ISMCTS_S128_CR_FLAG = 'ismcts-s128-cr';

/**
 * Build the `ismcts-s128-cr` StrategyFlagSpec: simulations=128 (matching
 * `ismcts-s128-hr`'s budget for a clean rollout-policy-only comparison),
 * rolloutFactory = the current champion composite bot.
 */
export function splendorIsmctsChampionRolloutFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  const config: MctsConfig = {
    simulations: 128,
    uctC: 1.4,
    rolloutCount: 1,
    label: 's128-cr',
    rolloutFactory: composeBot(adapter, [...SPLENDOR_CHAMPION_ROLLOUT_FLAGS]),
  };
  return {
    flag: SPLENDOR_ISMCTS_S128_CR_FLAG,
    description:
      'SO-ISMCTS search candidate whose rollouts are driven by the current champion composite bot instead of raw heuristic (DESIGN.md §6.1 near-miss retry); ignores the base bot entirely.',
    apply: () => ismctsBotFactory(adapter, config),
  };
}
