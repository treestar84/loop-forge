/**
 * dominion round-4 IS-MCTS candidate specs (GAP-11 Phase 6, main-loop design
 * spec: scratchpad/dominion-round4-design-spec.md).
 *
 * Factored into `shared/` (rather than inlined in the portfolio runner the way
 * round 3 did) because round 4 needs the *champion* spec in two places: the
 * loss-mining runner mines registry v5 (`ismcts-s64-v2buy-prior`), and the
 * portfolio runner uses that same flag as its regression opponent and lineage
 * baseline. A drifted second copy of the config would silently mine a
 * different bot than the one the wave regresses against — the exact failure
 * `shared/dominion-ismcts-flag.ts`'s own doc comment exists to prevent.
 *
 * Candidates (design spec §3's bucket table):
 *   - champion / regression opponent: `ismcts-s64-v2buy-prior` (v5, round 3's
 *     adoption — reproduced here verbatim from dominion-portfolio-round3.ts's
 *     `dominionIsmctsV2BuyPriorFlagSpec`: s64, uctC 1.4, rolloutCount 1,
 *     heuristic rollout, priorWeight 16, priorEvaluator =
 *     dominionV2BuyPriorEvaluator).
 *   - B3-deep: `ismcts-s64-v2buy-adaptivetrash-prior` — identical to the
 *     champion in every field except `priorEvaluator`, which becomes
 *     `dominionV2BuyAdaptiveTrashPriorEvaluator` (chapelEconomyV3's adaptive
 *     Copper-trash floor knowledge on the trash axis only, V2's buy knowledge
 *     untouched). The design spec's "부분 교체" combination.
 *   - B1-exploit x2: `ismcts-s64-v2buy-prior-w8` / `-w32` — the champion with
 *     priorWeight 16 -> 8 and 16 -> 32, the two points bracketing round 3's
 *     fixed choice (A5 axis local-optimum curve, the spec's own B1 brief).
 *   - B4-explore: `ismcts-s64-v2buy-prior-precheck` — A3 (전술 프리체크), an
 *     axis dominion has never tried (design-brief-round3.ts's axis matrix:
 *     A3 미시도; A1/A2/A5/A8/A10 all already tried, so ADR-0009's
 *     "same-axis manual retry" ban is respected).
 *
 * Lives under reference/runners/, so it is an app boundary (determinism-
 * exempt, may wire every layer including search/) per
 * src/__tests__/dependency-rules.test.ts's APP_BOUNDARY_PREFIXES.
 */

import type { AnyGameAdapter, GameBot, PlayerId, StrategyFlagSpec } from '../../../contract/types';
import { ismctsBotFactory } from '../../../search/ismcts';
import type { MctsConfig } from '../../../search/mcts';
import {
  dominionV2BuyPriorEvaluator,
  dominionV2BuyAdaptiveTrashPriorEvaluator,
  dominionV2ActionPriorEvaluator,
  type DominionState,
  type DominionChoice,
  type DominionObservation,
} from '../../dominion';

/** v5 champion (round 3 adoption) — also this round's regression opponent. */
export const DOMINION_V5_CHAMPION_FLAG = 'ismcts-s64-v2buy-prior';
/** B3-deep (this round's main-loop-specified design). */
export const DOMINION_R4_B3_FLAG = 'ismcts-s64-v2buy-adaptivetrash-prior';
/** B1-exploit priorWeight sweep. */
export const DOMINION_R4_B1_W8_FLAG = 'ismcts-s64-v2buy-prior-w8';
export const DOMINION_R4_B1_W32_FLAG = 'ismcts-s64-v2buy-prior-w32';
/** B2-opponent (target re-selected from round 4's own mining: action 19.9%). */
export const DOMINION_R4_B2_FLAG = 'ismcts-s64-v2action-prior';
/** B4-explore (A3 tactical precheck). */
export const DOMINION_R4_B4_FLAG = 'ismcts-s64-v2buy-prior-precheck';

/** Champion's priorWeight — the fixed value round 3 adopted without sweeping. */
export const DOMINION_R4_CHAMPION_PRIOR_WEIGHT = 16;

/**
 * Widens a `DominionState`/`DominionChoice`-typed evaluator to the erased
 * `MctsConfig.priorEvaluator` signature — same type-level-cast-only pattern as
 * gomoku's `erasePriorEvaluator` (shared/gomoku-round1-candidates.ts) and
 * dominion-portfolio-round3.ts's own `eraseDominionPriorEvaluator`.
 */
function eraseDominionPriorEvaluator(
  evaluator: (state: DominionState, player: PlayerId, choices: readonly DominionChoice[]) => readonly number[],
): (state: unknown, player: PlayerId, choices: readonly unknown[]) => readonly number[] {
  return (state, player, choices) => evaluator(state as DominionState, player, choices as readonly DominionChoice[]);
}

function ismctsConfig(
  label: string,
  priorWeight: number,
  evaluator: (state: DominionState, player: PlayerId, choices: readonly DominionChoice[]) => readonly number[],
): MctsConfig {
  return {
    simulations: 64,
    uctC: 1.4,
    rolloutCount: 1,
    rolloutPolicy: 'heuristic',
    label,
    priorWeight,
    priorEvaluator: eraseDominionPriorEvaluator(evaluator),
  };
}

/**
 * The round-3 champion, reproduced field-for-field from
 * dominion-portfolio-round3.ts's `dominionIsmctsV2BuyPriorFlagSpec` (that
 * file's own doc comment carries the original design rationale). `apply()`
 * ignores `base` entirely — the convention every search-based flag spec in
 * this codebase follows.
 */
export function dominionIsmctsV2BuyPriorFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  const config = ismctsConfig('s64-v2buy-prior', DOMINION_R4_CHAMPION_PRIOR_WEIGHT, dominionV2BuyPriorEvaluator);
  return {
    flag: DOMINION_V5_CHAMPION_FLAG,
    description:
      'B4 explore (A5 tree prior, GAP-11 Phase 5, new combination per ADR-0009): SO-ISMCTS search candidate using dominionV2BuyPriorEvaluator (chapelEconomyV2\'s own buy-priority knowledge, injected via MctsConfig.priorEvaluator) as its prior, s64 simulation budget unchanged from every prior dominion ismcts wave; ignores the base bot entirely. Adopted as registry v5 in round 3 — round 4 reuses it as champion/regression opponent.',
    apply: () => ismctsBotFactory(adapter, config),
    assembly: 'terminal',
  };
}

/**
 * B3-deep (main-loop spec, the one combination round 3 recorded as untried):
 * the champion config with **only** `priorEvaluator` swapped for
 * `dominionV2BuyAdaptiveTrashPriorEvaluator` — V2's buy knowledge kept, the
 * trash axis alone re-expressed with chapelEconomyV3's adaptive floor. Not a
 * re-attempt of chapelEconomyV3 standalone (measured and rejected in round 3);
 * the hypothesis under test is specifically the interaction, i.e. that the
 * adaptive floor only pays off *on top of* the IS-MCTS/V2-buy-prior base.
 */
export function dominionIsmctsAdaptiveTrashPriorFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  const config = ismctsConfig(
    's64-v2buy-adaptivetrash-prior',
    DOMINION_R4_CHAMPION_PRIOR_WEIGHT,
    dominionV2BuyAdaptiveTrashPriorEvaluator,
  );
  return {
    flag: DOMINION_R4_B3_FLAG,
    description:
      "B3 deep design (GAP-11 Phase 6 round-4, main-loop spec — the combination round 3 explicitly left untried): registry v5's prior with only the trashCard branch replaced by chapelEconomyV3's adaptive Copper-trash floor knowledge (progress = max(Province drawdown, turnsTaken/18), floor interpolated 2->4), buy/playAction scoring byte-identical to v5's. Targets round 3's finding that chapelTrash's re-emergence was an interaction effect of V2's buy/action redesign, not a standalone policy defect. Ignores the base bot entirely.",
    apply: () => ismctsBotFactory(adapter, config),
    assembly: 'terminal',
  };
}

/**
 * B2-opponent (target re-selected from round 4's own loss-mining, as the
 * design spec's bucket table explicitly allows — "반드시 이번 라운드
 * 데이터로 재선정"): round 4's mining puts `action` at 19.9% (803/4044), the
 * champion's top mismatch decision point, ahead of `buy` (18.9%) and far
 * ahead of `chapelTrash` (0.0%). This candidate is the champion with **only**
 * the playAction branch of the prior replaced by chapelEconomyV2's own action
 * knowledge (`dominionV2ActionPriorEvaluator`) — the same "re-express the
 * converged heuristic as the prior" treatment that produced v5 on the buy
 * axis. See dominion.ts's own round-4 B2 doc comment for the divergence pairs
 * this responds to.
 */
export function dominionIsmctsV2ActionPriorFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  const config = ismctsConfig('s64-v2action-prior', DOMINION_R4_CHAMPION_PRIOR_WEIGHT, dominionV2ActionPriorEvaluator);
  return {
    flag: DOMINION_R4_B2_FLAG,
    description:
      "B2 opponent-info design (GAP-11 Phase 6 round-4, target re-selected from this round's own mining: action 19.9%, the champion's top mismatch decision point): registry v5's prior with only the playAction branch replaced by chapelEconomyV2's action knowledge (Witch scored high only while Curses remain, Chapel gated on real junk-in-hand). buy/trashCard scoring byte-identical to v5's. Ignores the base bot entirely.",
    apply: () => ismctsBotFactory(adapter, config),
    assembly: 'terminal',
  };
}

/** B1-exploit: the champion with priorWeight swept to `priorWeight`. */
export function dominionIsmctsPriorWeightSweepFlagSpec(
  adapter: AnyGameAdapter,
  flag: string,
  priorWeight: number,
): StrategyFlagSpec<unknown, unknown> {
  const config = ismctsConfig(`s64-v2buy-prior-w${priorWeight}`, priorWeight, dominionV2BuyPriorEvaluator);
  return {
    flag,
    description:
      `B1 mechanical variant of registry v5 (GAP-11 Phase 6 round-4, A5 axis local-optimum sweep): identical to ismcts-s64-v2buy-prior except priorWeight ${DOMINION_R4_CHAMPION_PRIOR_WEIGHT} -> ${priorWeight}. Round 3 fixed priorWeight at ${DOMINION_R4_CHAMPION_PRIOR_WEIGHT} without measuring the curve; this candidate supplies one of the two bracketing points. Ignores the base bot entirely.`,
    apply: () => ismctsBotFactory(adapter, config),
    assembly: 'terminal',
  };
}

/**
 * The A3 precheck rule set: three decisions where dominion's own kingdom is
 * unambiguous and every strong policy on file (chapelEconomyV2, chapelEconomy,
 * dominion-opus-bot) already agrees, so spending 64 simulations to rediscover
 * them is pure budget waste (and, worse, occasionally loses them to search
 * noise — v5's prior scores Province 100 / Curse-trash 100 but the prior only
 * biases early exploration and decays with visits, so search can still walk
 * away from them).
 *   1. buy phase, coins >= 8, Province still in supply -> buy Province.
 *   2. chapelTrash, a Curse is trashable -> trash the Curse.
 *   3. action phase, Witch playable while Curses remain in supply -> play it.
 * Returns `undefined` when no rule fires (the overwhelming majority of
 * decisions), in which case the search bot decides as usual.
 */
function dominionTacticalPrecheck(
  decisionPoint: string,
  observation: DominionObservation,
  legal: readonly DominionChoice[],
): DominionChoice | undefined {
  if (decisionPoint === 'buy') {
    if (observation.coins >= 8 && (observation.supply.Province ?? 0) > 0) {
      const province = legal.find((c) => c.kind === 'buy' && c.card === 'Province');
      if (province) return province;
    }
    return undefined;
  }
  if (decisionPoint === 'chapelTrash') {
    const curse = legal.find((c) => c.kind === 'trashCard' && c.card === 'Curse');
    if (curse) return curse;
    return undefined;
  }
  if (decisionPoint === 'action') {
    if ((observation.supply.Curse ?? 0) > 0) {
      const witch = legal.find((c) => c.kind === 'playAction' && c.card === 'Witch');
      if (witch) return witch;
    }
    return undefined;
  }
  return undefined;
}

/**
 * B4-explore (A3 전술 프리체크 — dominion's axis matrix has this as 미시도,
 * so it satisfies ADR-0009's ban on repeating an already-judged axis): the
 * champion bot wrapped in a deterministic precheck (`dominionTacticalPrecheck`
 * above). Search runs unchanged on every decision no rule fires for; the
 * wrapper never modifies the search config, so any measured difference is
 * attributable to the precheck alone. `apply()` ignores `base` entirely, same
 * as the search specs it wraps.
 */
export function dominionIsmctsPrecheckFlagSpec(adapter: AnyGameAdapter): StrategyFlagSpec<unknown, unknown> {
  const config = ismctsConfig('s64-v2buy-prior', DOMINION_R4_CHAMPION_PRIOR_WEIGHT, dominionV2BuyPriorEvaluator);
  const searchFactory = ismctsBotFactory(adapter, config);
  return {
    flag: DOMINION_R4_B4_FLAG,
    description:
      'B4 explore (A3 전술 프리체크, dominion 미시도 축 — ADR-0009 준수): registry v5 unchanged, wrapped in a deterministic pre-search check for three decisions every strong dominion policy on file already agrees on (buy Province at coins>=8, trash a Curse whenever one is trashable, play Witch while Curses remain). Search decides everything else with an unmodified config. Ignores the base bot entirely.',
    apply: () => (seed: number) => {
      const searchBot = searchFactory(seed);
      const bot: GameBot<unknown, unknown> = {
        id: `${searchBot.id}+precheck`,
        decide(decisionPoint, observation, legal) {
          const forced = dominionTacticalPrecheck(
            decisionPoint,
            observation as DominionObservation,
            legal as readonly DominionChoice[],
          );
          if (forced !== undefined) return forced as unknown;
          return searchBot.decide(decisionPoint, observation, legal);
        },
      };
      return bot;
    },
    assembly: 'terminal',
  };
}
