/**
 * UCT Monte Carlo Tree Search — a faithful port of OpenSpiel's
 * `open_spiel/python/algorithms/mcts.py` (Apache-2.0; see docs/CREDITS.md,
 * docs/GAP-ANALYSIS-7.md O5). Ported semantics: UCT child selection
 * (exploit + uctC * sqrt(ln(parentCount)/childCount), unvisited children
 * expanded before any UCT comparison happens), a random-rollout evaluator,
 * and "most-visited root child wins" final action selection.
 *
 * Deliberate differences from mcts.py:
 *   - Reward is win/loss taken from `Outcome.winners` (co-winners split
 *     1/winners.length, non-winners score 0), not `Outcome.scores`/returns —
 *     this keeps the search game-neutral across the games onboarded here,
 *     several of which declare `scoreMargin: 'none'` (no comparable score
 *     margin at all).
 *   - Multi-player (>2) support is max^n rather than the two-player
 *     zero-sum assumption mcts.py's comments lean on: every tree node stores
 *     `mover`, the player who made the move that created it, and
 *     accumulates reward from exactly that player's perspective, so each
 *     player's own decision points optimize their own reward independently.
 *   - No solver (backward-induction proven values), no policy prior, no
 *     simultaneous-move nodes, no explicit chance nodes — all out of scope
 *     for this port (docs/GAP-ANALYSIS-7.md O5's "범위 밖" list). Loop Forge
 *     folds all chance into the seed passed to `createInitialState`, so
 *     there is nothing here that plays the OpenSpiel chance-node role.
 */

import type { AnyBotFactory, AnyGameAdapter, Outcome, PlayerId, Rng } from '../contract/types';
import { createRng } from '../kernel/rng';

export interface MctsConfig {
  readonly simulations: number;
  readonly uctC: number;
  readonly rolloutCount: number;
  /** Stamped into bot ids (e.g. "s64") so the sim budget is legible in adoption records and comparabilityKey-adjacent labels. */
  readonly label: string;
}

interface ChildEdge {
  readonly choice: unknown;
  readonly key: string;
  readonly node: SearchNode;
}

/**
 * One tree node. `mover` is the player whose move created this node (null
 * only for the search root, which has no creating move) — `totalReward`
 * therefore always means "average reward for `mover`", never a fixed root
 * player's reward, which is what makes multi-player max^n selection correct.
 */
class SearchNode {
  readonly mover: PlayerId | null;
  exploreCount = 0;
  totalReward = 0;
  readonly children: ChildEdge[] = [];
  readonly untried: unknown[];

  constructor(mover: PlayerId | null, untried: readonly unknown[]) {
    this.mover = mover;
    this.untried = [...untried];
  }
}

function rewardOf(outcome: Outcome, player: PlayerId): number {
  if (!outcome.winners.includes(player)) {
    return 0;
  }
  return 1 / outcome.winners.length;
}

/** One random rollout from `state` to a terminal state, using `rng` for uniform legal-choice draws. */
function rolloutOnce(adapter: AnyGameAdapter, state: unknown, rng: Rng): Outcome {
  let current = state;
  let decisions = 0;
  while (adapter.currentDecision(current) !== null) {
    if (decisions >= adapter.spec.maxDecisionsPerGame) {
      throw new Error(
        `mcts rollout: exceeded maxDecisionsPerGame (${adapter.spec.maxDecisionsPerGame}) without reaching a terminal state — adapter defect`,
      );
    }
    const legal = adapter.getLegalChoices(current);
    const choice = legal[rng.nextInt(legal.length)];
    current = adapter.applyChoice(current, choice);
    decisions += 1;
  }
  const outcome = adapter.getOutcome(current);
  if (outcome === null) {
    throw new Error('mcts rollout: terminal state produced a null Outcome — adapter defect');
  }
  return outcome;
}

/** RandomRolloutEvaluator (mcts.py): average per-player reward across `rolloutCount` independent rollouts. */
function evaluate(adapter: AnyGameAdapter, state: unknown, rolloutCount: number, rng: Rng): readonly number[] {
  const playerCount = adapter.spec.playerCount;
  const totals = new Array<number>(playerCount).fill(0);
  for (let i = 0; i < rolloutCount; i += 1) {
    const outcome = rolloutOnce(adapter, state, rng);
    for (let player = 0; player < playerCount; player += 1) {
      totals[player] = (totals[player] as number) + rewardOf(outcome, player);
    }
  }
  return totals.map((total) => total / rolloutCount);
}

/** UCT selection among `node`'s (already-expanded) children — never called while untried moves remain. */
function selectChild(node: SearchNode, uctC: number): ChildEdge {
  const logParent = Math.log(node.exploreCount);
  let best: ChildEdge | null = null;
  let bestValue = -Infinity;
  for (const child of node.children) {
    const exploit = child.node.totalReward / child.node.exploreCount;
    const explore = uctC * Math.sqrt(logParent / child.node.exploreCount);
    const value = exploit + explore;
    if (value > bestValue) {
      bestValue = value;
      best = child;
    }
  }
  if (best === null) {
    throw new Error('mcts selectChild: node has no expanded children to select from');
  }
  return best;
}

/**
 * Run UCT MCTS from `rootState` (which must have a pending decision) and
 * return the chosen root-level choice — the child with the most visits,
 * matching mcts.py's final action selection. Ties broken by the lower
 * `encodeChoice` key for determinism.
 */
export function mctsSearch(
  adapter: AnyGameAdapter,
  rootState: unknown,
  config: MctsConfig,
  rng: Rng,
): unknown {
  const rootDecision = adapter.currentDecision(rootState);
  if (rootDecision === null) {
    throw new Error('mctsSearch: rootState has no pending decision (already terminal)');
  }
  const root = new SearchNode(null, adapter.getLegalChoices(rootState));

  for (let sim = 0; sim < config.simulations; sim += 1) {
    let state = rootState;
    let node = root;
    const path: SearchNode[] = [root];

    for (;;) {
      const decision = adapter.currentDecision(state);
      if (decision === null) {
        break; // descended straight into a terminal state
      }
      if (node.untried.length > 0) {
        // Unvisited children are always expanded before any UCT comparison
        // (mcts.py's tree policy) — one expansion per simulation.
        const choice = node.untried.shift();
        const childState = adapter.applyChoice(state, choice);
        const childDecision = adapter.currentDecision(childState);
        const childUntried = childDecision === null ? [] : adapter.getLegalChoices(childState);
        const childNode = new SearchNode(decision.player, childUntried);
        node.children.push({ choice, key: adapter.encodeChoice(choice), node: childNode });
        path.push(childNode);
        state = childState;
        node = childNode;
        break;
      }
      if (node.children.length === 0) {
        // Non-terminal state with no legal choices would violate the
        // contract (getLegalChoices is documented non-empty until
        // terminal) — guard rather than loop forever on an adapter defect.
        break;
      }
      const selected = selectChild(node, config.uctC);
      state = adapter.applyChoice(state, selected.choice);
      node = selected.node;
      path.push(node);
    }

    const rewards = evaluate(adapter, state, config.rolloutCount, rng);
    for (const visited of path) {
      visited.exploreCount += 1;
      if (visited.mover !== null) {
        visited.totalReward += rewards[visited.mover] as number;
      }
    }
  }

  if (root.children.length === 0) {
    throw new Error('mctsSearch: root produced no children after search');
  }
  let best = root.children[0] as ChildEdge;
  for (const child of root.children) {
    if (
      child.node.exploreCount > best.node.exploreCount ||
      (child.node.exploreCount === best.node.exploreCount && child.key < best.key)
    ) {
      best = child;
    }
  }
  return best.choice;
}

/**
 * Wrap an adapter's `reconstructState` (perfect-information only, see
 * contract/types.ts) into a search-bot BotFactory. `base` is ignored — an
 * MCTS bot builds its own decision from scratch via search, not by
 * modulating a base bot's choice, so `withStrategyFlags`' composeBot wiring
 * (which always calls `apply(base)`) intentionally discards `base` here.
 * `decide` reconstructs a simulation root from the observation it is given,
 * searches, then maps the search result back to the caller-supplied `legal`
 * array by `encodeChoice` match — the bot contract requires returning one
 * element of that exact array, never a freshly-synthesized choice value.
 */
export function mctsBotFactory(adapter: AnyGameAdapter, config: MctsConfig): AnyBotFactory {
  if (adapter.reconstructState === undefined) {
    throw new Error(
      `mctsBotFactory: adapter "${adapter.spec.gameId}" does not declare reconstructState — ` +
        'MCTS needs a perfect-information simulation root (see contract/types.ts GameAdapter.reconstructState)',
    );
  }
  const reconstructState = adapter.reconstructState;

  return (seed) => {
    const rng = createRng(seed);
    const id = `mcts-${config.label}-${seed}`;
    return {
      id,
      decide(_decisionPoint, observation, legal) {
        const rootState = reconstructState(observation);
        const choice = mctsSearch(adapter, rootState, config, rng);
        const key = adapter.encodeChoice(choice);
        const matched = legal.find((candidate) => adapter.encodeChoice(candidate) === key);
        if (matched === undefined) {
          throw new Error(
            `mctsBotFactory: MCTS-selected choice "${key}" was not found in the provided legal array`,
          );
        }
        return matched;
      },
    };
  };
}
