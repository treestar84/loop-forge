/**
 * Single-Observer Information Set Monte Carlo Tree Search (SO-ISMCTS).
 *
 * Faithful port of the SO-ISMCTS algorithm from Cowling, Powley & Whitehouse
 * (2012), "Information Set Monte Carlo Tree Search" (IEEE Transactions on
 * Computational Intelligence and AI in Games), cross-checked against
 * OpenSpiel's `is_mcts` C++ family (open_spiel/algorithms/is_mcts.{h,cc};
 * Apache-2.0 — see docs/CREDITS.md, docs/FIX-BACKLOG.md P4). Ported
 * semantics: one information-set tree keyed by the root player's own action
 * sequence, one fresh determinization sampled per simulation via
 * `adapter.sampleStateFromObservation`, descent restricted to edges legal in
 * that simulation's determinization, and UCB1 selection using
 * *availability counts* (how many simulations offered this action) rather
 * than the parent's total visit count as the denominator inside the log term
 * — the one piece of SO-ISMCTS that has no analogue in perfect-information
 * UCT (`src/search/mcts.ts`), because not every determinization offers the
 * same legal actions at the same tree node.
 *
 * Deliberate simplification (documented, not hidden): information-set nodes
 * here are keyed purely by the sequence of `encodeChoice` keys from the
 * root — i.e. a plain action-sequence tree — rather than merging histories
 * that are genuinely indistinguishable to the root player but reached via
 * different action sequences (full information-set clustering). This is the
 * same simplification OpenSpiel's `is_mcts` C++ implementation makes in
 * practice and is explicitly what was asked for (docs/FIX-BACKLOG.md P4):
 * "노드는 (루트 관찰 기준) 행동 열 키".
 *
 * Rollout evaluation reuses `evaluate`/`MctsConfig` from `src/search/mcts.ts`
 * verbatim (same rollout policies, same reward convention: win/loss from
 * `Outcome.winners`, co-winners split 1/winners.length) rather than
 * duplicating that logic — see mcts.ts's own doc comment for the full
 * "deliberate differences from mcts.py" list, which applies here unchanged.
 *
 * Like `src/search/mcts.ts`, this module folds all chance into the seed
 * passed to `createInitialState`/`sampleStateFromObservation`, supports
 * multi-player max^n reward accumulation (not just two-player zero-sum), and
 * has no solver, no policy prior, and no explicit chance/simultaneous-move
 * nodes.
 */

import type { AnyBotFactory, AnyGameAdapter, PlayerId, Rng } from '../contract/types';
import { canonicalJson } from '../kernel/digest';
import { createRng, shuffled } from '../kernel/rng';
import { evaluate, type MctsConfig } from './mcts';

/** One edge in the information-set tree: an action taken from some node, keyed by `encodeChoice`. */
interface IsEdge {
  readonly choice: unknown;
  readonly key: string;
  /** The player who made this move — reward is accumulated from this player's perspective (mirrors mcts.ts's SearchNode.mover). */
  readonly mover: PlayerId;
  readonly node: IsNode;
  /** Times this action was actually selected from its parent node. */
  visits: number;
  /** Times this action was *legal* (available) when its parent node was visited — SO-ISMCTS's UCB1 denominator, distinct from `visits`. */
  availability: number;
  totalReward: number;
}

/** One information-set node: a map from `encodeChoice` key to the edge for that action. Persists across simulations. */
class IsNode {
  readonly children = new Map<string, IsEdge>();
}

interface LegalEntry {
  readonly choice: unknown;
  readonly key: string;
}

/** UCB1 with availability-count denominators (Cowling et al. 2012) among `node`'s currently-legal children — never called while any legal child is still untried (visits === 0). */
function selectByAvailabilityUcb(legal: readonly LegalEntry[], node: IsNode, uctC: number): IsEdge {
  let best: IsEdge | null = null;
  let bestValue = -Infinity;
  for (const { key } of legal) {
    const edge = node.children.get(key);
    if (edge === undefined) {
      throw new Error(`ismctsSearch selectByAvailabilityUcb: missing edge for legal key "${key}"`);
    }
    const exploit = edge.totalReward / edge.visits;
    const explore = uctC * Math.sqrt(Math.log(edge.availability) / edge.visits);
    const value = exploit + explore;
    if (value > bestValue) {
      bestValue = value;
      best = edge;
    }
  }
  if (best === null) {
    throw new Error('ismctsSearch selectByAvailabilityUcb: node has no legal children to select from');
  }
  return best;
}

/**
 * Run SO-ISMCTS from `rootObservation` (the root player's own observation —
 * never a full state, since the whole point of IS-MCTS is not needing one)
 * and return the chosen root-level choice. `rootPlayer` is the information
 * set's owner: every determinization is sampled as if `rootPlayer` were the
 * one asking (`adapter.sampleStateFromObservation(rootObservation,
 * rootPlayer, ...)`), and the returned choice is one legal at the root
 * decision under whichever determinization won the search — callers must
 * match it back to their own `legal` array by `encodeChoice`, exactly as
 * `mctsBotFactory` does for `mctsSearch` (see `ismctsBotFactory` below).
 *
 * Final action selection mirrors `mctsSearch`'s tie-break order
 * (docs/FIX-BACKLOG.md P5): most visits, then highest accumulated reward,
 * then lowest `encodeChoice` key as a fully deterministic last resort.
 */
export function ismctsSearch(
  adapter: AnyGameAdapter,
  rootObservation: unknown,
  rootPlayer: PlayerId,
  config: MctsConfig,
  rng: Rng,
): unknown {
  const sampleStateFromObservation = adapter.sampleStateFromObservation;
  if (sampleStateFromObservation === undefined) {
    throw new Error(
      `ismctsSearch: adapter "${adapter.spec.gameId}" does not declare sampleStateFromObservation — ` +
        'IS-MCTS needs a determinization hook (see contract/types.ts GameAdapter.sampleStateFromObservation)',
    );
  }

  const root = new IsNode();

  for (let sim = 0; sim < config.simulations; sim += 1) {
    // Each simulation draws its own determinization — a fresh, independent
    // rng stream so sampling one simulation's full state never perturbs the
    // shuffle/rollout draws any other simulation makes (fork does not mutate
    // the parent stream, kernel/rng.ts).
    const determinizationRng = rng.fork(`ismcts-determinization-${sim}`);
    let state = sampleStateFromObservation(rootObservation, rootPlayer, determinizationRng);
    if (adapter.currentDecision(state) === null) {
      throw new Error(
        'ismctsSearch: sampleStateFromObservation returned a state with no pending decision (already terminal) — adapter defect',
      );
    }

    let node = root;
    const path: IsEdge[] = [];
    let expanded = false;

    while (!expanded) {
      const decision = adapter.currentDecision(state);
      if (decision === null) {
        break; // this determinization's rollout descended straight into a terminal state
      }
      const legalChoices = adapter.getLegalChoices(state);
      const legal: LegalEntry[] = legalChoices.map((choice) => ({ choice, key: adapter.encodeChoice(choice) }));

      // Every action legal under this determinization gets an edge (created
      // lazily on first sight) and its availability count bumped — the
      // "available this many times" denominator SO-ISMCTS's UCB1 needs,
      // independent of whether the action ends up selected this simulation.
      for (const { choice, key } of legal) {
        let edge = node.children.get(key);
        if (edge === undefined) {
          edge = { choice, key, mover: decision.player, node: new IsNode(), visits: 0, availability: 0, totalReward: 0 };
          node.children.set(key, edge);
        }
        edge.availability += 1;
      }

      const untried = legal.filter((entry) => (node.children.get(entry.key) as IsEdge).visits === 0);
      let selected: IsEdge;
      if (untried.length > 0) {
        // rng-shuffled expansion order (docs/FIX-BACKLOG.md P5 lesson — never
        // FIFO over an adapter-ordered legal-choices array).
        const pick = shuffled(untried, rng)[0] as LegalEntry;
        selected = node.children.get(pick.key) as IsEdge;
        expanded = true;
      } else {
        selected = selectByAvailabilityUcb(legal, node, config.uctC);
      }
      selected.visits += 1;
      path.push(selected);
      state = adapter.applyChoice(state, selected.choice);
      node = selected.node;
    }

    const rewards = evaluate(adapter, state, config.rolloutCount, rng, config);
    for (const edge of path) {
      edge.totalReward += rewards[edge.mover] as number;
    }
  }

  if (root.children.size === 0) {
    throw new Error('ismctsSearch: root produced no children after search');
  }

  let best: IsEdge | null = null;
  for (const edge of root.children.values()) {
    if (
      best === null ||
      edge.visits > best.visits ||
      (edge.visits === best.visits && edge.totalReward > best.totalReward) ||
      (edge.visits === best.visits && edge.totalReward === best.totalReward && edge.key < best.key)
    ) {
      best = edge;
    }
  }
  return (best as IsEdge).choice;
}

/**
 * Determine which `PlayerId` an observation belongs to, purely from the
 * generic contract (no game-specific field access): try every seat and keep
 * the one for which `sampleStateFromObservation(observation, candidate,
 * ...)` round-trips back through `getObservation(sampled, candidate)` to an
 * observation canonically identical to the input. This is exactly the
 * invariant `sampleStateFromObservation`'s own contract doc comment requires
 * of a correct implementation, so this doubles as a live conformance check
 * of the hook, not just a player-detection trick.
 */
function detectViewer(
  adapter: AnyGameAdapter,
  sampleStateFromObservation: (observation: unknown, player: PlayerId, rng: Rng) => unknown,
  observation: unknown,
  detectRng: Rng,
): PlayerId {
  const target = canonicalJson(observation);
  for (let candidate = 0; candidate < adapter.spec.playerCount; candidate += 1) {
    const sampled = sampleStateFromObservation(observation, candidate, detectRng.fork(`ismcts-viewer-probe-${candidate}`));
    const reobserved = adapter.getObservation(sampled, candidate);
    if (canonicalJson(reobserved) === target) {
      return candidate;
    }
  }
  throw new Error(
    'ismctsBotFactory: could not determine the viewing player from the observation — ' +
      'sampleStateFromObservation(observation, player, rng) must satisfy ' +
      'getObservation(sampled, player) === observation for the correct player (contract/types.ts doc comment)',
  );
}

/**
 * Wrap an adapter's `sampleStateFromObservation` (hidden-information games,
 * see contract/types.ts) into a search-bot BotFactory. Unlike
 * `mctsBotFactory`, this never sees a full state — `decide` only ever
 * receives the observation the harness built for this bot's own player
 * (`GameBot.decide`'s contract), so the viewing player is detected once (via
 * `detectViewer`) and cached for the lifetime of this bot instance (one seat,
 * for one game — the player identity cannot change mid-game). `decide` then
 * runs `ismctsSearch` and maps the result back to the caller-supplied
 * `legal` array by `encodeChoice` match, exactly like `mctsBotFactory`.
 */
export function ismctsBotFactory(adapter: AnyGameAdapter, config: MctsConfig): AnyBotFactory {
  const sampleStateFromObservation = adapter.sampleStateFromObservation;
  if (sampleStateFromObservation === undefined) {
    throw new Error(
      `ismctsBotFactory: adapter "${adapter.spec.gameId}" does not declare sampleStateFromObservation — ` +
        'IS-MCTS needs a determinization hook (see contract/types.ts GameAdapter.sampleStateFromObservation)',
    );
  }

  return (seed) => {
    const rng = createRng(seed);
    const id = `ismcts-${config.label}-${seed}`;
    let cachedPlayer: PlayerId | null = null;

    return {
      id,
      decide(_decisionPoint, observation, legal) {
        if (cachedPlayer === null) {
          cachedPlayer = detectViewer(adapter, sampleStateFromObservation, observation, rng.fork('ismcts-viewer-detect'));
        }
        const choice = ismctsSearch(adapter, observation, cachedPlayer, config, rng);
        const key = adapter.encodeChoice(choice);
        const matched = legal.find((candidate) => adapter.encodeChoice(candidate) === key);
        if (matched === undefined) {
          throw new Error(
            `ismctsBotFactory: IS-MCTS-selected choice "${key}" was not found in the provided legal array`,
          );
        }
        return matched;
      },
    };
  };
}
