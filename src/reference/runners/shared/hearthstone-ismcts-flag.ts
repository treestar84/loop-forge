/**
 * Shared IS-MCTS strategy-flag spec for hearthstone (docs/FIX-BACKLOG.md P4),
 * factored out so any runner that needs to reconstruct this candidate (registered
 * into `runs/hearthstone/registry.json` by `reference/runners/hearthstone.ts`'s
 * ismcts-wave-1) does so with the exact same config — a mismatched
 * determinization/simulation budget would silently reproduce a
 * differently-behaved bot under the same flag name (same rationale as
 * `shared/dominion-ismcts-flag.ts`'s doc comment, the precedent this file
 * mirrors).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-exempt,
 * may wire every layer, including search/) per
 * src/__tests__/dependency-rules.test.ts's APP_BOUNDARY_PREFIXES.
 */

import type { AnyBotFactory, AnyGameAdapter, StrategyFlagSpec } from '../../../contract/types';
import { ismctsBotFactory } from '../../../search/ismcts';
import type { MctsConfig } from '../../../search/mcts';

/**
 * simulations=128: throughput measurement (scratch script, not checked in;
 * nice -n 10, single process, 3 seeds/matchup, both seats — ismcts-hr vs
 * heuristic and heuristic vs ismcts-hr) showed:
 *   ismcts-s32-hr  ~71.2ms/game
 *   ismcts-s64-hr  ~141.7ms/game
 *   ismcts-s128-hr ~287.8ms/game
 * roughly linear in simulation count (no steep slope the way dominion's
 * s64->s128 jump was, shared/dominion-ismcts-flag.ts's doc comment) — this
 * mirror-match card pool's games tend to end quickly (heuristic's lethal
 * check and small 12-card neutral pool keep games short relative to
 * maxDecisionsPerGame=500), so even the most expensive candidate here costs
 * roughly 1/10th what dominion's s64-hr did per game. 128 was chosen over 64
 * or 32 to get the strongest available search budget while still leaving the
 * wave (smoke+prune+holdout+regression, see reference/runners/hearthstone.ts's
 * ismcts-wave-1 comment for the full block-count arithmetic) far inside the
 * 30-minute wave budget — unlike dominion/splendor, cost was not the binding
 * constraint for this game. rolloutPolicy 'heuristic' (not 'random') for the
 * same P1/P5 reason dominion's and splendor's configs document: rollouts
 * driven by hearthstone's own `baselines.heuristic` bot (which already
 * detects lethal and prefers good trades) are a much stronger evaluator than
 * uniform-random play/attack/heroPower choices.
 */
export const HEARTHSTONE_ISMCTS_S128_HR_CONFIG: MctsConfig = {
  simulations: 128,
  uctC: 1.4,
  rolloutCount: 1,
  label: 's128-hr',
  rolloutPolicy: 'heuristic',
};
export const HEARTHSTONE_ISMCTS_S128_HR_FLAG = 'ismcts-s128-hr';

/**
 * Build the `ismcts-s128-hr` StrategyFlagSpec for `adapter` — `apply()`
 * ignores its `base` argument entirely (mirrors `mctsBotFactory`'s doc
 * comment in search/mcts.ts and dominionIsmctsFlagSpec's precedent): an
 * IS-MCTS candidate builds its decision from search over sampled
 * determinizations, not by modulating a base bot's choice.
 */
export function hearthstoneIsmctsFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  return {
    flag: HEARTHSTONE_ISMCTS_S128_HR_FLAG,
    description:
      'SO-ISMCTS search candidate over sampled hand/deck determinizations (docs/FIX-BACKLOG.md P4); ignores the base bot entirely.',
    apply: () => ismctsBotFactory(adapter, HEARTHSTONE_ISMCTS_S128_HR_CONFIG),
    assembly: 'terminal',
  };
}

/**
 * Build any `MctsConfig`-driven StrategyFlagSpec for hearthstone (GAP-11
 * Phase 7 B1/B3/B4 — priorWeight sweep + rolloutFactory variants), same
 * "`apply()` ignores `base` entirely" convention as `hearthstoneIsmctsFlagSpec`
 * above and every other search-based flag spec in this codebase.
 */
export function hearthstoneIsmctsFlagSpecFor(
  adapter: AnyGameAdapter,
  config: MctsConfig,
  flag: string,
  description: string,
): StrategyFlagSpec<unknown, unknown> {
  return {
    flag,
    description,
    apply: () => ismctsBotFactory(adapter, config),
    assembly: 'terminal',
  };
}

/**
 * B3 본안 (GAP-11 Phase 7 design spec, main-loop): `ismcts-s128-hr`'s exact
 * budget/rollout config plus a tree prior sourced from
 * `hearthstoneAdapter.choiceEvaluator` (ADR-0011, ../../hearthstone.ts) —
 * `priorSource` left at its default (`'choiceEvaluator'`) rather than set via
 * `priorEvaluator`, since the prior knowledge here lives on the adapter
 * itself, not a standalone evaluator function (unlike gomoku's chain/
 * defensive evaluators or dominion's buy-priority evaluator).
 */
export function hearthstoneTempoPriorConfig(priorWeight: number, label: string): MctsConfig {
  return {
    ...HEARTHSTONE_ISMCTS_S128_HR_CONFIG,
    label,
    priorWeight,
  };
}

/**
 * B4 (GAP-11 Phase 7 design spec, "미시도 축" A2 rollout-policy replace):
 * `ismcts-s128-hr`'s exact budget, but rollouts driven by `rolloutFactory`
 * (search/mcts.ts's doc comment — takes precedence over `rolloutPolicy`)
 * instead of the adapter's own `baselines.heuristic`. `rolloutFactory` is
 * supplied by the caller (composeBot-assembled `hearthstoneMidBot`, same
 * "compose then inject" pattern as gomoku-portfolio-round4.ts's own
 * `championRollout` rolloutFactory) so this file stays independent of any
 * one experiment module.
 */
export function hearthstoneL1RolloutConfig(rolloutFactory: AnyBotFactory, label: string): MctsConfig {
  return {
    simulations: 128,
    uctC: 1.4,
    rolloutCount: 1,
    label,
    rolloutFactory,
  };
}
