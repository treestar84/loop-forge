/**
 * gomoku-round1-candidates — portfolio-round1's candidate-batch builder
 * (docs/GAP-ANALYSIS-11.md §5.5 Phase 3-B), extracted from
 * ../gomoku-portfolio-round1.ts into its own side-effect-free shared module
 * (GAP-11 Phase 4-A) so a later round's runner (e.g. gomoku-loss-mining-
 * round2.ts, which needs to rebuild registry v6's 4 promoted dynamic flags —
 * mcts7-s256-opening6-prior-w16, mcts5-s256-chain-w16/w48, mcts9-s256-
 * defensive-w16 — to compose the exact same bot portfolio-round1.ts
 * measured) can import `buildCandidates` without importing
 * gomoku-portfolio-round1.ts itself. That file's own `main()` runs
 * unconditionally at module scope (this repo's runner convention — every
 * file under reference/runners/ is a standalone script, never a library
 * another runner imports), so importing it directly would re-execute its
 * entire round-1 pipeline (brief/wave/challenge) as a side effect — this
 * module exists purely to avoid that trap while keeping a single source of
 * truth for what v5→v6 actually promoted (no logic duplicated/re-derived).
 *
 * Behavior-preserving extraction only: every function/constant below is
 * copied verbatim from gomoku-portfolio-round1.ts (same seeds, same tier
 * constants, same design rationale — see that file's own doc comment for
 * the full B1-B4 design write-up); gomoku-portfolio-round1.ts now imports
 * `buildCandidates` from here instead of defining it locally.
 *
 * GAP-11 Phase 4-B addendum: every helper here was widened from
 * module-private to `export` (no other change) so
 * ./gomoku-round2-candidates.ts's B2 candidate can reuse
 * `gomokuOpeningThenPriorFlagSpec`/`openingPolicyMove`/`OPENING_WINDOW`/
 * `championRolloutPriorConfig`/`erasePriorEvaluator` instead of re-deriving
 * them — same "single source of truth" discipline this file's own doc
 * comment already follows for `buildCandidates` itself.
 */

import type { AnyGameAdapter, PlayerId, StrategyFlagSpec } from '../../../contract/types';
import { composeBot } from '../../../loop/compose';
import { createRng } from '../../../kernel/rng';
import type { BucketId } from '../../../artifacts/portfolio';
import { mctsBotFactory, type MctsConfig } from '../../../search/mcts';
import type { GomokuMove, GomokuObservation, GomokuState } from '../../gomoku';
import { gomokuChainEvaluator } from '../../experiments/gomoku-chain-evaluator';
import { gomokuDefensiveEvaluator } from '../../experiments/gomoku-defensive-evaluator';
import { GOMOKU_CHAMPION_ROLLOUT_FLAGS, gomokuMctsFlagSpecFor } from './gomoku-mcts-flag';

export interface RoundCandidate {
  readonly flag: string;
  readonly bucket: BucketId;
  readonly spec: StrategyFlagSpec<unknown, unknown>;
}

export function championRolloutPriorConfig(
  bareAdapter: AnyGameAdapter,
  priorWeight: number,
  label: string,
  extra?: Partial<MctsConfig>,
): MctsConfig {
  return {
    simulations: 256,
    uctC: 1.4,
    rolloutCount: 1,
    label,
    rolloutFactory: composeBot(bareAdapter, [...GOMOKU_CHAMPION_ROLLOUT_FLAGS]),
    priorWeight,
    priorSource: 'choiceEvaluator',
    ...extra,
  };
}

/**
 * Widens a gomoku-typed choice evaluator to the erased `MctsConfig.priorEvaluator`
 * signature — `search/mcts.ts` calls this only through `AnyGameAdapter`'s
 * already-erased state/choice types (the same widening `eraseAdapter` performs
 * for every other adapter field), so this is a type-level cast only, never a
 * behavior change.
 */
export function erasePriorEvaluator(
  evaluator: (state: GomokuState, player: PlayerId, choices: readonly GomokuMove[]) => readonly number[],
): (state: unknown, player: PlayerId, choices: readonly unknown[]) => readonly number[] {
  return (state, player, choices) => evaluator(state as GomokuState, player, choices as readonly GomokuMove[]);
}

/** B2's opening window (portfolio-round1.ts's own design — see that file's doc comment's LossReport rationale). */
export const OPENING_WINDOW = 6;

export function chebyshevDistance(a: GomokuMove, b: GomokuMove): number {
  return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
}

/**
 * "중앙 균형 전개" (B2's own design): among legal moves closest to board
 * center, prefer the one that maximizes its minimum distance to every
 * existing stone (spreads development out rather than clustering against a
 * single existing line this early) — final ties broken deterministically by
 * `rng`. Pure function of `observation`/`legal`, reused nowhere else.
 */
export function openingPolicyMove(
  observation: GomokuObservation,
  legal: readonly GomokuMove[],
  rng: ReturnType<typeof createRng>,
): GomokuMove {
  const center: GomokuMove = { row: 7, col: 7 };
  let bestCenterDistance = Infinity;
  let centerCandidates: GomokuMove[] = [];
  for (const move of legal) {
    const distance = chebyshevDistance(move, center);
    if (distance < bestCenterDistance) {
      bestCenterDistance = distance;
      centerCandidates = [move];
    } else if (distance === bestCenterDistance) {
      centerCandidates.push(move);
    }
  }
  if (centerCandidates.length === 1) {
    return centerCandidates[0] as GomokuMove;
  }

  const boardSize = Math.sqrt(observation.board.length);
  let bestSpread = -1;
  let spreadCandidates: GomokuMove[] = [];
  for (const move of centerCandidates) {
    let minStoneDistance = Infinity;
    for (let index = 0; index < observation.board.length; index += 1) {
      if (observation.board[index] === 0) {
        continue;
      }
      const row = Math.floor(index / boardSize);
      const col = index % boardSize;
      const distance = chebyshevDistance(move, { row, col });
      if (distance < minStoneDistance) {
        minStoneDistance = distance;
      }
    }
    const spread = minStoneDistance === Infinity ? 0 : minStoneDistance;
    if (spread > bestSpread) {
      bestSpread = spread;
      spreadCandidates = [move];
    } else if (spread === bestSpread) {
      spreadCandidates.push(move);
    }
  }
  if (spreadCandidates.length === 1) {
    return spreadCandidates[0] as GomokuMove;
  }
  return spreadCandidates[rng.nextInt(spreadCandidates.length)] as GomokuMove;
}

/**
 * B2 flag spec: `openingPolicyMove` for the game's first `openingMoves`
 * stones (`observation.moveCount < openingMoves`), then delegates to a
 * `mctsBotFactory(adapter, config)` instance for the rest of the game.
 * `apply()` ignores `base` entirely — same convention as every other MCTS
 * flag spec in ./gomoku-mcts-flag.ts (this candidate builds its own decision
 * from scratch, it does not modulate a base bot's choice).
 */
export function gomokuOpeningThenPriorFlagSpec(
  adapter: AnyGameAdapter,
  openingMoves: number,
  config: MctsConfig,
  flag: string,
): StrategyFlagSpec<unknown, unknown> {
  return {
    flag,
    description: `Opening policy (중앙 균형 전개, first ${openingMoves} stones) then prior-MCTS "${config.label}" (docs/GAP-ANALYSIS-11.md Phase 3-B B2); ignores the base bot entirely.`,
    apply: () => (seed) => {
      const rng = createRng(seed).fork('gomoku-opening-policy');
      const engine = mctsBotFactory(adapter, config)(seed);
      return {
        id: `gomoku-opening${openingMoves}-${config.label}-${seed}`,
        decide(decisionPoint, observation, legal) {
          const obs = observation as GomokuObservation;
          if (obs.moveCount < openingMoves) {
            return openingPolicyMove(obs, legal as readonly GomokuMove[], rng);
          }
          return engine.decide(decisionPoint, observation, legal);
        },
      };
    },
    assembly: 'terminal',
  };
}

/**
 * Rebuild portfolio-round1.ts's full 7-candidate batch (B1x3, B2x1, B3x2,
 * B4x1) against `bareAdapter` — same seeds/labels/tier constants as that
 * file's own `buildCandidates` (this module's doc comment).
 */
export function buildCandidates(bareAdapter: AnyGameAdapter): readonly RoundCandidate[] {
  const b1: RoundCandidate[] = [
    {
      flag: 'mcts6-s256-prior-w32',
      bucket: 'B1-exploit',
      spec: gomokuMctsFlagSpecFor(
        bareAdapter,
        championRolloutPriorConfig(bareAdapter, 32, 's256-prior-w32'),
        'mcts6-s256-prior-w32',
      ),
    },
    {
      flag: 'mcts6-s256-prior-w64',
      bucket: 'B1-exploit',
      spec: gomokuMctsFlagSpecFor(
        bareAdapter,
        championRolloutPriorConfig(bareAdapter, 64, 's256-prior-w64'),
        'mcts6-s256-prior-w64',
      ),
    },
    {
      flag: 'mcts6-s256-prior-w16-tactical2',
      bucket: 'B1-exploit',
      spec: gomokuMctsFlagSpecFor(
        bareAdapter,
        championRolloutPriorConfig(bareAdapter, 16, 's256-prior-w16-tactical2', { tacticalDepth: 2 }),
        'mcts6-s256-prior-w16-tactical2',
      ),
    },
  ];

  const b2: RoundCandidate[] = [
    {
      flag: 'mcts7-s256-opening6-prior-w16',
      bucket: 'B2-opponent',
      spec: gomokuOpeningThenPriorFlagSpec(
        bareAdapter,
        OPENING_WINDOW,
        championRolloutPriorConfig(bareAdapter, 16, 's256-opening6-prior-w16'),
        'mcts7-s256-opening6-prior-w16',
      ),
    },
  ];

  const chainConfig = (priorWeight: number, label: string): MctsConfig => ({
    simulations: 256,
    uctC: 1.4,
    rolloutCount: 1,
    label,
    rolloutFactory: composeBot(bareAdapter, [...GOMOKU_CHAMPION_ROLLOUT_FLAGS]),
    priorWeight,
    priorEvaluator: erasePriorEvaluator(gomokuChainEvaluator),
  });
  const b3: RoundCandidate[] = [
    {
      flag: 'mcts5-s256-chain-w16',
      bucket: 'B3-deep',
      spec: gomokuMctsFlagSpecFor(bareAdapter, chainConfig(16, 's256-chain-w16'), 'mcts5-s256-chain-w16'),
    },
    {
      flag: 'mcts5-s256-chain-w48',
      bucket: 'B3-deep',
      spec: gomokuMctsFlagSpecFor(bareAdapter, chainConfig(48, 's256-chain-w48'), 'mcts5-s256-chain-w48'),
    },
  ];

  const b4: RoundCandidate[] = [
    {
      flag: 'mcts9-s256-defensive-w16',
      bucket: 'B4-explore',
      spec: gomokuMctsFlagSpecFor(
        bareAdapter,
        {
          simulations: 256,
          uctC: 1.4,
          rolloutCount: 1,
          label: 's256-defensive-w16',
          rolloutFactory: composeBot(bareAdapter, [...GOMOKU_CHAMPION_ROLLOUT_FLAGS]),
          priorWeight: 16,
          priorEvaluator: erasePriorEvaluator(gomokuDefensiveEvaluator),
        },
        'mcts9-s256-defensive-w16',
      ),
    },
  ];

  return [...b1, ...b2, ...b3, ...b4];
}
