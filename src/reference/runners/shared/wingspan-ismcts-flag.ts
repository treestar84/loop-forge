/**
 * Shared IS-MCTS strategy-flag spec for wingspan (docs/FIX-BACKLOG.md P4),
 * factored out so any runner that needs to reconstruct this candidate
 * (registered into `runs/wingspan/registry.json` by
 * `reference/runners/wingspan.ts`'s ismcts-wave-1) does so with the exact
 * same config — a mismatched determinization/simulation budget would
 * silently reproduce a differently-behaved bot under the same flag name
 * (same rationale as `shared/hearthstone-ismcts-flag.ts`'s doc comment, the
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
 * simulations=256: throughput measurement (scratch script, not checked in;
 * nice -n 10, single process, 3 seeds/matchup, both seats — ismcts-hr vs
 * heuristic and heuristic vs ismcts-hr) showed:
 *   ismcts-s32-hr   ~4.3ms/game
 *   ismcts-s64-hr   ~7.2ms/game
 *   ismcts-s128-hr  ~9.3ms/game
 *   ismcts-s256-hr ~17.3ms/game
 *   ismcts-s512-hr ~36.2ms/game
 * roughly linear in simulation count, and dramatically cheaper per-game than
 * every other onboarded game so far (hearthstone's most expensive candidate,
 * ismcts-s128-hr, cost ~287.8ms/game — shared/hearthstone-ismcts-flag.ts's
 * doc comment): wingspan's game is short (TOTAL_TURNS=20 decisions max, no
 * combat/board-state branching) and every legal choice is a flat playBird/
 * gainFood/drawTray/drawDeck pick, so even a decently sized search tree
 * resolves fast. 256 was chosen — double hearthstone's picked budget — since
 * cost is nowhere near the binding constraint here; the full wave
 * (smoke+prune+holdout+regression, see
 * reference/runners/wingspan.ts's ismcts-wave-1 comment for the block-count
 * arithmetic) stays on the order of seconds, not the tens of minutes the
 * 30-minute wave ceiling allows. rolloutPolicy 'heuristic' (not 'random')
 * for the same P1/P5 reason every other game's ismcts-wave-1 config
 * documents: rollouts driven by wingspan's own `baselines.heuristic` bot
 * (points-per-food efficiency) are a much stronger evaluator than
 * uniform-random play/draw/gainFood choices.
 */
export const WINGSPAN_ISMCTS_S256_HR_CONFIG: MctsConfig = {
  simulations: 256,
  uctC: 1.4,
  rolloutCount: 1,
  label: 's256-hr',
  rolloutPolicy: 'heuristic',
};
export const WINGSPAN_ISMCTS_S256_HR_FLAG = 'ismcts-s256-hr';

/**
 * Build the `ismcts-s256-hr` StrategyFlagSpec for `adapter` — `apply()`
 * ignores its `base` argument entirely (mirrors `mctsBotFactory`'s doc
 * comment in search/mcts.ts and hearthstoneIsmctsFlagSpec's precedent): an
 * IS-MCTS candidate builds its decision from search over sampled
 * determinizations, not by modulating a base bot's choice.
 */
export function wingspanIsmctsFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  return {
    flag: WINGSPAN_ISMCTS_S256_HR_FLAG,
    description:
      'SO-ISMCTS search candidate over sampled opponent-hand/deck determinizations (docs/FIX-BACKLOG.md P4); ignores the base bot entirely.',
    apply: () => ismctsBotFactory(adapter, WINGSPAN_ISMCTS_S256_HR_CONFIG),
  };
}
