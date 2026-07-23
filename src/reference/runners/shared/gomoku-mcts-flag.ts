/**
 * Shared MCTS strategy-flag specs for gomoku, factored out so every runner
 * that needs to reconstruct an MCTS candidate (registered into
 * `runs/gomoku/registry.json` by `reference/runners/gomoku.ts`'s MCTS waves)
 * does so with the exact same config — a mismatched simulation
 * budget/uctC/rolloutCount/rolloutPolicy would silently reproduce a
 * differently-behaved bot under the same flag name.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-exempt,
 * may wire every layer, including search/) per
 * src/__tests__/dependency-rules.test.ts's APP_BOUNDARY_PREFIXES.
 *
 * NOT imported by reference/runners/gomoku.ts itself for the s64 spec (left
 * untouched — another agent may have it running) — this only re-derives the
 * identical config for other runners (docs/GAP-ANALYSIS-7.md O6/O7 follow-up).
 * `gomoku.ts` DOES import the generalized `gomokuMctsFlagSpecFor` helper for
 * its mcts-wave-2 (docs/FIX-BACKLOG.md P1), passing GOMOKU_MCTS_CONFIG and
 * GOMOKU_MCTS_HR_CONFIG explicitly so both candidates resolve consistently.
 */

import type { AnyGameAdapter, StrategyFlagSpec } from '../../../contract/types';
import { mctsBotFactory, type MctsConfig } from '../../../search/mcts';

/**
 * Must match reference/runners/gomoku.ts's GOMOKU_MCTS_CONFIG exactly.
 *
 * P5 BEHAVIOR CHANGE NOTICE (docs/FIX-BACKLOG.md P5): the search/mcts.ts fix
 * for the budget<branching-factor pathology (reward-aware final-selection
 * tie-break + rng-shuffled expansion order, replacing the old
 * encodeChoice-key-only tie-break + getLegalChoices FIFO expansion) changes
 * what bot this flag/config pair actually plays, even though the flag name
 * and config values here are unchanged. Reconstructing "mcts-s64" from
 * registry v3 post-fix reproduces a genuinely different bot than the one that
 * was measured when v3 was adopted.
 */
export const GOMOKU_MCTS_CONFIG: MctsConfig = { simulations: 64, uctC: 1.4, rolloutCount: 2, label: 's64' };
export const GOMOKU_MCTS_FLAG = 'mcts-s64';

/**
 * P1 (docs/FIX-BACKLOG.md): heuristic-rollout variant — same sim budget/uctC
 * as mcts-s64, but rollouts are driven by `adapter.baselines.heuristic`
 * instead of uniform-random draws (search/mcts.ts's rolloutPolicy option).
 * rolloutCount=1 (not 2, like mcts-s64): throughput measurement
 * (docs/BENCHMARK-LEADERBOARD.md follow-up, GAP-ANALYSIS-7 O10 regression-tier
 * matchup is MCTS-vs-MCTS on both sides, the expensive case) showed
 * mcts-s64-hr vs mcts-s64 costs ~1.1s/game at rolloutCount=1 vs ~1.5s/game at
 * rolloutCount=2 — rolloutCount=1 keeps the regression tier's budget well
 * inside the 30-minute wave ceiling (see gomoku.ts's mcts-wave-2 comment for
 * the full throughput table and block-count arithmetic).
 */
export const GOMOKU_MCTS_HR_CONFIG: MctsConfig = {
  simulations: 64,
  uctC: 1.4,
  rolloutCount: 1,
  label: 's64-hr',
  rolloutPolicy: 'heuristic',
};
export const GOMOKU_MCTS_HR_FLAG = 'mcts-s64-hr';

/**
 * P5 (docs/FIX-BACKLOG.md): mcts-wave-3 candidates, re-attempting the search
 * family after mcts-s64-hr screened out as a behavioral no-op (100% identical
 * to mcts-s64 across 27 shared moves) — root-caused to search/mcts.ts's
 * budget<branching-factor pathology, now fixed there. simulations=256 was
 * chosen because gomoku's branching factor is ~220 legal moves on an empty
 * 15x15 board and shrinks slowly; 256 simulations is the first budget in the
 * s64/s128/s256 doubling sequence that exceeds that branching factor, so UCT
 * revisits (the actual point of tree search, as opposed to one rollout per
 * legal move) start happening at the root. uctC=1.4 and rolloutCount=1 match
 * the values already used by mcts-s64/mcts-s64-hr for continuity.
 */
export const GOMOKU_MCTS2_S256_CONFIG: MctsConfig = { simulations: 256, uctC: 1.4, rolloutCount: 1, label: 's256' };
export const GOMOKU_MCTS2_S256_FLAG = 'mcts2-s256';

export const GOMOKU_MCTS2_S256_HR_CONFIG: MctsConfig = {
  simulations: 256,
  uctC: 1.4,
  rolloutCount: 1,
  label: 's256-hr',
  rolloutPolicy: 'heuristic',
};
export const GOMOKU_MCTS2_S256_HR_FLAG = 'mcts2-s256-hr';

/**
 * Build an MCTS StrategyFlagSpec for `adapter` under `flag`/`config` —
 * apply() ignores its `base` argument entirely (see search/mcts.ts's
 * mctsBotFactory doc comment): an MCTS candidate builds its decision from
 * search, not by modulating a base bot's choice.
 */
export function gomokuMctsFlagSpecFor(
  adapter: AnyGameAdapter,
  config: MctsConfig,
  flag: string,
): StrategyFlagSpec<unknown, unknown> {
  return {
    flag,
    description: `UCT MCTS search candidate "${flag}" (docs/GAP-ANALYSIS-7.md O5/O6, docs/FIX-BACKLOG.md P1); ignores the base bot entirely.`,
    apply: () => mctsBotFactory(adapter, config),
  };
}

/** Build the mcts-s64 StrategyFlagSpec for `adapter` (back-compat wrapper around gomokuMctsFlagSpecFor). */
export function gomokuMctsFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  return gomokuMctsFlagSpecFor(adapter, GOMOKU_MCTS_CONFIG, GOMOKU_MCTS_FLAG);
}

/** Build the mcts-s64-hr StrategyFlagSpec for `adapter` (docs/FIX-BACKLOG.md P1). */
export function gomokuMctsHrFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  return gomokuMctsFlagSpecFor(adapter, GOMOKU_MCTS_HR_CONFIG, GOMOKU_MCTS_HR_FLAG);
}
