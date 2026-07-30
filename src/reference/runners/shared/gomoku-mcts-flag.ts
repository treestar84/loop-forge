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

import type { AnyGameAdapter, PlayerId, StrategyFlagSpec } from '../../../contract/types';
import { composeBot } from '../../../loop/compose';
import { mctsBotFactory, type MctsConfig } from '../../../search/mcts';
import { gomokuForkDecision, type GomokuState, type GomokuMove } from '../../gomoku';

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
 * Adapter wiring for search/mcts.ts's `rootOverride` option
 * (docs/GAP-ANALYSIS-8.md gomoku C-column retry): connects
 * `gomokuForkDecision` (reference/gomoku.ts's pure fork-priority judgment) to
 * the `MctsConfig.rootOverride` signature — `unknown` state/legal/choice
 * types widened from `mctsSearch`'s erased-adapter call site, narrowed back
 * to gomoku's concrete types here since this file (reference/runners/) is a
 * game-specific app boundary, unlike search/mcts.ts itself. Ignores the
 * `adapter` parameter (gomokuForkDecision needs only state/legal/player).
 */
export function gomokuForkRootOverride(
  _adapter: AnyGameAdapter,
  state: unknown,
  legal: readonly unknown[],
  player: PlayerId,
): unknown | null {
  return gomokuForkDecision(state as GomokuState, legal as readonly GomokuMove[], player);
}

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
    assembly: 'terminal',
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

/**
 * mcts-wave-4 (docs/GAP-ANALYSIS-8.md gomoku C-column retry): "champion
 * rollout" — instead of `adapter.baselines.heuristic` driving rollouts (the
 * 'heuristic' rolloutPolicy), a composeBot-assembled composite of gomoku's
 * own strategySurface flags (blockImmediateThreat + centerProximity +
 * extendLongestLine, the same 3 flags composing the current v2+ baseline)
 * drives them via `search/mcts.ts`'s `rolloutFactory` option (game-neutral —
 * the search layer never sees these flag names, it only calls the resulting
 * bot factory through the same GameBot interface every other bot uses).
 * `adapter` here must be the plain game adapter (its own strategySurface,
 * not yet extended with any MCTS flags) so composeBot can resolve the 3
 * champion flags — the same `adapter` gomoku.ts already threads into every
 * `gomokuMctsFlagSpecFor` call above.
 */
export const GOMOKU_CHAMPION_ROLLOUT_FLAGS = ['blockImmediateThreat', 'centerProximity', 'extendLongestLine'] as const;

export const GOMOKU_MCTS2_S256_CR_FLAG = 'mcts2-s256-cr';
export const GOMOKU_MCTS2_S512_CR_FLAG = 'mcts2-s512-cr';

/**
 * Build the mcts2-s256-cr StrategyFlagSpec: simulations=256 (matching
 * mcts2-s256/mcts2-s256-hr's budget for a clean rollout-policy-only
 * comparison), rolloutFactory = the champion composite bot.
 */
export function gomokuMcts2S256CrFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  const config: MctsConfig = {
    simulations: 256,
    uctC: 1.4,
    rolloutCount: 1,
    label: 's256-cr',
    rolloutFactory: composeBot(adapter, [...GOMOKU_CHAMPION_ROLLOUT_FLAGS]),
  };
  return gomokuMctsFlagSpecFor(adapter, config, GOMOKU_MCTS2_S256_CR_FLAG);
}

/**
 * Build the mcts2-s512-cr StrategyFlagSpec: simulations=512 (budget doubled
 * on top of the champion rollout, testing whether budget adds anything once
 * rollout quality is already strong), rolloutFactory = the champion
 * composite bot.
 */
export function gomokuMcts2S512CrFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  const config: MctsConfig = {
    simulations: 512,
    uctC: 1.4,
    rolloutCount: 1,
    label: 's512-cr',
    rolloutFactory: composeBot(adapter, [...GOMOKU_CHAMPION_ROLLOUT_FLAGS]),
  };
  return gomokuMctsFlagSpecFor(adapter, config, GOMOKU_MCTS2_S512_CR_FLAG);
}

/**
 * mcts-wave-5 (docs/GAP-ANALYSIS-8.md §4.6 gomoku C-column retry, P7 tactical
 * precheck): same simulations/uctC/rolloutCount/rolloutFactory as
 * mcts2-s256-cr — the only difference is `tacticalDepth: 2`, the game-neutral
 * "immediate win / immediate must-block" safety net (search/mcts.ts's
 * MctsConfig doc comment). `tacticalBranchCap` left unset (no cap): gomoku's
 * branching factor is large early-game (~220 legal moves on an empty board),
 * but the depth-2 opponent-reply check only calls `applyChoice`+`getOutcome`
 * per candidate (no rollout, no simulation) — cheap enough per candidate that
 * a throughput measurement (see reference/runners/gomoku.ts's mcts-wave-5
 * comment) decided a cap was unnecessary.
 */
export const GOMOKU_MCTS2_S256_TACTICAL_FLAG = 'mcts2-s256-tactical';

export function gomokuMcts2S256TacticalFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  const config: MctsConfig = {
    simulations: 256,
    uctC: 1.4,
    rolloutCount: 1,
    label: 's256-tactical',
    rolloutFactory: composeBot(adapter, [...GOMOKU_CHAMPION_ROLLOUT_FLAGS]),
    tacticalDepth: 2,
  };
  return gomokuMctsFlagSpecFor(adapter, config, GOMOKU_MCTS2_S256_TACTICAL_FLAG);
}

/**
 * The same 4-flag rollout composite used by the prior diagnostic's
 * `mcts2-s256-fork` (scratch-n4/gomoku-fork-diag2.ts, not checked in) —
 * `GOMOKU_CHAMPION_ROLLOUT_FLAGS` plus `forkAwareness`. Kept as its own
 * constant (not folded into `GOMOKU_CHAMPION_ROLLOUT_FLAGS`) so every prior
 * champion-rollout candidate's rollout composite stays exactly what it was
 * when adopted/measured.
 */
export const GOMOKU_FORK_CHAMPION_ROLLOUT_FLAGS = [...GOMOKU_CHAMPION_ROLLOUT_FLAGS, 'forkAwareness'] as const;

/**
 * mcts-wave-6 diagnostic candidate (docs/GAP-ANALYSIS-8.md gomoku C-column
 * retry — MCTS rootOverride). Identical simulations/uctC/rolloutCount/
 * rolloutFactory to the prior diagnostic's `mcts2-s256-fork` (256 sims, the
 * 4-flag fork composite driving rollouts) — that candidate scored 0.0% vs
 * Opus, down from the pure (unsearched) 4-flag composite's 9.0%, because 256
 * shallow simulations dilute forkAwareness's deterministic fork verdict into
 * statistical noise. The only addition here is
 * `rootOverride: gomokuForkRootOverride`: the same fork-detection geometry
 * (reference/gomoku.ts's `gomokuForkDecision`) now bypasses the simulation
 * average entirely and decides the root move outright whenever it fires,
 * instead of merely biasing rollouts. Everything else held fixed so the
 * only variable versus the 0.0% baseline is whether the override recovers
 * the signal the search was diluting.
 */
export const GOMOKU_MCTS3_S256_OVERRIDE_FLAG = 'mcts3-s256-override';

export function gomokuMcts3S256OverrideFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  const config: MctsConfig = {
    simulations: 256,
    uctC: 1.4,
    rolloutCount: 1,
    label: 's256-override',
    rolloutFactory: composeBot(adapter, [...GOMOKU_FORK_CHAMPION_ROLLOUT_FLAGS]),
    rootOverride: gomokuForkRootOverride,
  };
  return gomokuMctsFlagSpecFor(adapter, config, GOMOKU_MCTS3_S256_OVERRIDE_FLAG);
}
