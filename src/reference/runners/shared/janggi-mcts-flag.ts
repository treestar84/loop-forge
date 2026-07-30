/**
 * Shared MCTS strategy-flag specs for janggi, factored out so every runner
 * that needs to reconstruct an MCTS candidate (registered into
 * `runs/janggi/registry.json` by `reference/runners/janggi.ts`'s MCTS waves)
 * does so with the exact same config — mirrors
 * `reference/runners/shared/gomoku-mcts-flag.ts`'s rationale (a mismatched
 * simulation budget/uctC/rolloutCount/rolloutPolicy would silently reproduce
 * a differently-behaved bot under the same flag name).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-exempt,
 * may wire every layer, including search/) per
 * src/__tests__/dependency-rules.test.ts's APP_BOUNDARY_PREFIXES.
 *
 * Generation note (docs/FIX-BACKLOG.md P2/P5): mcts-wave-1's `mcts-s16`
 * (random rollout, simulations=16) was measured pre-P2/pre-P5 and failed
 * smoke 0.000 (runs/janggi/mcts-wave-1) — both because the move-generation
 * throughput was ~18s/game at the time (making even 16 simulations
 * expensive) and because 16 simulations never came close to exceeding
 * janggi's branching factor (see MCTS2_S128_HR_CONFIG's comment below for
 * the actual measured range). After P2's move-generation/check-detection
 * optimization (commit 28476bc) and P5's search/mcts.ts tie-break/expansion
 * fix, this file's `mcts2-s128-hr` is the re-attempt: a new logic
 * generation gets a new flag name (`mcts2-...`) rather than reusing
 * `mcts-s16`, per the naming convention gomoku's mcts2-* flags established.
 */

import type { AnyGameAdapter, StrategyFlagSpec } from '../../../contract/types';
import { mctsBotFactory, type MctsConfig } from '../../../search/mcts';

/**
 * simulations=128 was chosen from a direct throughput+branching-factor
 * measurement (scratch script, not checked in; nice -n 10, single process,
 * post-P2 janggi adapter, post-P5 search/mcts.ts):
 *   - random self-play (post-P2): ~18.7ms/game (was ~17.8s/game pre-P2 —
 *     roughly a 950x speedup, confirming P2's optimization).
 *   - branching factor sampled across 5 seeds at plies
 *     0/10/20/30/45/60/80/100/130/160: ranged 8-62, with most midgame plies
 *     in the 40-60 range and a single observed peak of 62 (seed 1/3, ply 60).
 *   - simulations=64 (heuristic rollout) barely exceeds that peak (64 vs 62)
 *     — too close to the P5 "budget must clearly exceed branching factor"
 *     lesson (mcts-s64-hr/mcts-s64 in gomoku screened out as a no-op at a
 *     budget that only marginally covered the branching factor). 128 gives
 *     roughly 2x headroom over every sampled branching factor instead.
 *   - throughput at simulations=128 (heuristic rollout) vs heuristic:
 *     ~14.6s/game average (12.4-18.3s observed over 3 games) — see
 *     janggi.ts's mcts-wave-2 comment for the resulting tier-size budget
 *     arithmetic.
 * rolloutPolicy 'heuristic' (not 'random') is used directly this wave —
 * gomoku's wave history (P1/P5) showed random-rollout mcts candidates lose
 * the C-column Opus matchup and that heuristic rollout is the credible
 * evaluator; there is no cheaper-but-weaker random-rollout janggi candidate
 * queued ahead of this one.
 */
export const JANGGI_MCTS2_S128_HR_CONFIG: MctsConfig = {
  simulations: 128,
  uctC: 1.4,
  rolloutCount: 1,
  label: 's128-hr',
  rolloutPolicy: 'heuristic',
};
export const JANGGI_MCTS2_S128_HR_FLAG = 'mcts2-s128-hr';

/**
 * Build an MCTS StrategyFlagSpec for `adapter` under `flag`/`config` —
 * apply() ignores its `base` argument entirely (see search/mcts.ts's
 * mctsBotFactory doc comment): an MCTS candidate builds its decision from
 * search, not by modulating a base bot's choice.
 */
export function janggiMctsFlagSpecFor(
  adapter: AnyGameAdapter,
  config: MctsConfig,
  flag: string,
): StrategyFlagSpec<unknown, unknown> {
  return {
    flag,
    description: `UCT MCTS search candidate "${flag}" (docs/GAP-ANALYSIS-7.md O5/O6, docs/FIX-BACKLOG.md P2/P5); ignores the base bot entirely.`,
    apply: () => mctsBotFactory(adapter, config),
    assembly: 'terminal',
  };
}
