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
import { composeBot } from '../../../loop/compose';
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

/**
 * ismcts-wave-3 (docs/GAP-ANALYSIS-8.md §4.5's near-miss, DESIGN.md §6.1
 * near-miss loop retry): "champion rollout" — same lever as
 * `splendor-ismcts-flag.ts`'s `splendorIsmctsChampionRolloutFlagSpec` (that
 * file's doc comment has the full rationale): rollouts driven by a
 * composeBot-assembled composite of the CURRENT registry champion's own flags
 * (`rushProvinces`, dominion's only adopted flag as of v2) instead of raw
 * heuristic, via `search/mcts.ts`'s `rolloutFactory` option (already
 * accepted by `ismcts.ts` with no code change there, since it reuses
 * `MctsConfig`/`evaluate` verbatim). New flag name (`ismcts-s64-cr`, not a
 * reuse of `ismcts-s64-hr`) per DESIGN.md §6.1's "이미 판정된 이름 재사용
 * 금지" rule. `adapter` here must be the plain game adapter (its own
 * strategySurface, not yet extended with any IS-MCTS flags) so composeBot can
 * resolve `rushProvinces`.
 */
export const DOMINION_CHAMPION_ROLLOUT_FLAGS = ['rushProvinces'] as const;

export const DOMINION_ISMCTS_S64_CR_FLAG = 'ismcts-s64-cr';

/**
 * Build the `ismcts-s64-cr` StrategyFlagSpec: simulations=64 (matching
 * `ismcts-s64-hr`'s budget for a clean rollout-policy-only comparison),
 * rolloutFactory = the current champion composite bot.
 */
export function dominionIsmctsChampionRolloutFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  const config: MctsConfig = {
    simulations: 64,
    uctC: 1.4,
    rolloutCount: 1,
    label: 's64-cr',
    rolloutFactory: composeBot(adapter, [...DOMINION_CHAMPION_ROLLOUT_FLAGS]),
  };
  return {
    flag: DOMINION_ISMCTS_S64_CR_FLAG,
    description:
      'SO-ISMCTS search candidate whose rollouts are driven by the current champion composite bot instead of raw heuristic (DESIGN.md §6.1 near-miss retry); ignores the base bot entirely.',
    apply: () => ismctsBotFactory(adapter, config),
  };
}

/**
 * ismcts-wave-4 (docs/GAP-ANALYSIS-8.md §4.5/§4.7's third retry, DESIGN.md
 * §6.1 near-miss loop, untried axis): both prior retries kept the simulation
 * budget fixed at 64 — ismcts-s64-hr (raw heuristic rollout, §4.5) and
 * ismcts-s64-cr (champion-mimicking rollout, §4.7) — and both lost the
 * regression tier against the champion (`rushProvinces`) at winRate 0.275
 * and 0.100 respectively. This candidate instead keeps the rollout policy
 * pure heuristic (no champion mimicry — §4.7's own postmortem theorized that
 * mimicking `rushProvinces` inside the rollout may have been *leaking*
 * information to the true rushProvinces opponent, so champion-rollout is not
 * repeated here) and raises only the simulation budget: 64 -> 256.
 *
 * Diagnostic head-to-head (scratch script, not checked in; nice -n 10,
 * single process, N=60, gate-free) run before this candidate was wired into
 * a wave, per the task's explicit go/no-go gate ("must beat the prior 0.275
 * to proceed"):
 *   - ismcts-s128-hr vs champion: winRate=0.258 (CI [0.150,0.375]) — no
 *     improvement over 0.275 (well within the same CI), so 128 was dropped.
 *   - ismcts-s256-hr vs champion: winRate=0.417 (CI [0.300,0.533]) — a real
 *     improvement over 0.275, with the CI's upper bound crossing 0.5 (still
 *     not a proven win, but the first budget-increase attempt that moved the
 *     needle at all across three total retries). This is why 256 (not 128)
 *     is the candidate wired into the wave below.
 *
 * Throughput measurement (same scratch script, 3 games/matchup):
 *   - ismcts-s256-hr vs heuristic (smoke/prune/holdout matchup):  ~9,965ms/game
 *   - ismcts-s256-hr vs v2 champion (regression matchup):        ~10,267ms/game
 * New flag name per §6.1's "이미 판정된 이름 재사용 금지" rule (distinct
 * from both `ismcts-s64-hr` and `ismcts-s64-cr`).
 */
export const DOMINION_ISMCTS_S256_HR_CONFIG: MctsConfig = {
  simulations: 256,
  uctC: 1.4,
  rolloutCount: 1,
  label: 's256-hr',
  rolloutPolicy: 'heuristic',
};
export const DOMINION_ISMCTS_S256_HR_FLAG = 'ismcts-s256-hr';

export function dominionIsmctsS256FlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  return {
    flag: DOMINION_ISMCTS_S256_HR_FLAG,
    description:
      'SO-ISMCTS search candidate with a 4x larger simulation budget (256 vs the 64 both prior retries used), raw heuristic rollout (no champion mimicry) — DESIGN.md §6.1 near-miss retry, third attempt, untried budget-increase axis; ignores the base bot entirely.',
    apply: () => ismctsBotFactory(adapter, DOMINION_ISMCTS_S256_HR_CONFIG),
  };
}
