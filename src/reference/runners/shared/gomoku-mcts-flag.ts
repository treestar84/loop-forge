/**
 * Shared MCTS strategy-flag spec for gomoku, factored out so every runner
 * that needs to reconstruct the `mcts-s64` candidate (registered into
 * `runs/gomoku/registry.json` by `reference/runners/gomoku.ts`'s
 * `mcts-wave-1`) does so with the exact same config — a mismatched
 * simulation budget/uctC/rolloutCount would silently reproduce a
 * differently-behaved bot under the same flag name.
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-exempt,
 * may wire every layer, including search/) per
 * src/__tests__/dependency-rules.test.ts's APP_BOUNDARY_PREFIXES.
 *
 * NOT imported by reference/runners/gomoku.ts itself (left untouched —
 * another agent may have it running) — this only re-derives the identical
 * config for other runners (docs/GAP-ANALYSIS-7.md O6/O7 follow-up).
 */

import type { AnyGameAdapter, StrategyFlagSpec } from '../../../contract/types';
import { mctsBotFactory, type MctsConfig } from '../../../search/mcts';

/** Must match reference/runners/gomoku.ts's GOMOKU_MCTS_CONFIG exactly. */
export const GOMOKU_MCTS_CONFIG: MctsConfig = { simulations: 64, uctC: 1.4, rolloutCount: 2, label: 's64' };
export const GOMOKU_MCTS_FLAG = 'mcts-s64';

/** Build the mcts-s64 StrategyFlagSpec for `adapter` — apply() ignores its
 * `base` argument entirely (see search/mcts.ts's mctsBotFactory doc comment):
 * an MCTS candidate builds its decision from search, not by modulating a
 * base bot's choice. */
export function gomokuMctsFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  return {
    flag: GOMOKU_MCTS_FLAG,
    description: 'UCT MCTS search candidate (docs/GAP-ANALYSIS-7.md O5/O6); ignores the base bot entirely.',
    apply: () => mctsBotFactory(adapter, GOMOKU_MCTS_CONFIG),
  };
}
