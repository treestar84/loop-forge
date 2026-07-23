/**
 * Outcome-sampling Monte Carlo CFR (MCCFR) — a faithful port of OpenSpiel's
 * `open_spiel/python/algorithms/outcome_sampling_mccfr.py` (Apache-2.0; see
 * docs/CREDITS.md, docs/GAP-ANALYSIS-7.md O7). Ported semantics: regret
 * matching per information set, epsilon-greedy sampling for the update
 * player (default epsilon=0.6, the original's default), importance-sampling
 * corrected regret and average-strategy updates.
 *
 * Deliberate difference from the original: OpenSpiel's outcome sampling
 * walks an explicit game tree with chance nodes and samples chance actions
 * as it descends. Loop Forge folds all randomness into the seed passed to
 * `createInitialState` — there is no chance-node API to sample from. Each
 * iteration instead samples a *game seed* from the training RNG and walks
 * the resulting fully-determined tree from root to a terminal state. This
 * is a structural substitution, not an approximation: a Loop Forge game
 * seed IS the chance outcome, so sampling seeds uniformly at the top of
 * each iteration plays exactly the role chance-node sampling plays in the
 * original algorithm.
 *
 * Two-player only: the regret/average-strategy bookkeeping and the
 * alternating-update-player loop below assume exactly two players (as does
 * outcome_sampling_mccfr.py's convergence guarantee, which additionally
 * assumes zero-sum/constant-sum payoffs). Games with more players raise
 * immediately rather than silently producing an unconverged table.
 */

import type { AnyBotFactory, AnyGameAdapter, GameBot, PlayerId, Rng } from '../contract/types';
import { createRng } from '../kernel/rng';
import { canonicalJson, sha256Digest } from '../kernel/digest';

export interface MccfrConfig {
  readonly iterations: number;
  /** Exploration mix for the update player's own sampling policy. Default 0.6 (OpenSpiel's default). */
  readonly epsilon?: number;
  readonly seed: number;
}

export interface PolicyTableMeta {
  readonly gameId: string;
  readonly iterations: number;
  readonly epsilon: number;
  readonly seed: number;
  /**
   * 'adapter' when the adapter declared `informationStateKey` (used during
   * training); 'fallback-observation' when the digest(decisionPoint +
   * canonical observation) fallback was used instead. The fallback does not
   * guarantee perfect recall — see contract/types.ts's doc comment on
   * `informationStateKey`.
   */
  readonly infosetKeySource: 'adapter' | 'fallback-observation';
  readonly infosetCount: number;
}

/** Average strategy: infoset key -> (choice key -> probability), normalized per infoset. */
export interface PolicyTable {
  readonly meta: PolicyTableMeta;
  readonly entries: Record<string, Record<string, number>>;
}

/** Canonical-JSON digest of a trained table, for sealing/comparison of persisted policy artifacts. */
export function policyTableDigest(table: PolicyTable): string {
  return sha256Digest(canonicalJson(table));
}

interface InfosetEntry {
  readonly actionKeys: readonly string[];
  readonly regretSum: number[];
  readonly strategySum: number[];
}

/**
 * Same digest formula as `policyBotFactory`'s decide-time key — see that
 * function's doc comment for why this must stay in sync with it.
 */
function fallbackKey(adapter: AnyGameAdapter, decisionPoint: string, observation: unknown): string {
  return sha256Digest(canonicalJson({ decisionPoint, observation }));
}

function infosetKeyOf(adapter: AnyGameAdapter, state: unknown, player: PlayerId): string {
  if (adapter.informationStateKey !== undefined) {
    return adapter.informationStateKey(state, player);
  }
  const decision = adapter.currentDecision(state);
  if (decision === null) {
    throw new Error('mccfr: infosetKeyOf called on a terminal state');
  }
  const observation = adapter.getObservation(state, player);
  return fallbackKey(adapter, decision.decisionPoint, observation);
}

/** Regret matching: positive regrets normalized to a distribution; uniform when no regret is positive. */
function regretMatchedStrategy(regretSum: readonly number[]): number[] {
  const positive = regretSum.map((value) => Math.max(0, value));
  const total = positive.reduce((sum, value) => sum + value, 0);
  if (total > 0) {
    return positive.map((value) => value / total);
  }
  const uniform = 1 / regretSum.length;
  return regretSum.map(() => uniform);
}

function sampleIndex(distribution: readonly number[], draw: number): number {
  let cumulative = 0;
  for (let index = 0; index < distribution.length; index += 1) {
    cumulative += distribution[index] as number;
    if (draw < cumulative) {
      return index;
    }
  }
  return distribution.length - 1; // floating-point rounding guard
}

interface KeyedChoice {
  readonly choice: unknown;
  readonly key: string;
}

/** Legal choices paired with their encodeChoice key, sorted by key so action indexing is
 * stable regardless of the order getLegalChoices happens to return them in. */
function keyedLegalChoices(adapter: AnyGameAdapter, state: unknown): KeyedChoice[] {
  const legal = adapter.getLegalChoices(state);
  return legal
    .map((choice) => ({ choice, key: adapter.encodeChoice(choice) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function lookupOrCreateEntry(
  table: Map<string, InfosetEntry>,
  infoKey: string,
  actionKeys: readonly string[],
): InfosetEntry {
  const existing = table.get(infoKey);
  if (existing !== undefined) {
    if (
      existing.actionKeys.length !== actionKeys.length ||
      !existing.actionKeys.every((key, index) => key === actionKeys[index])
    ) {
      throw new Error(
        `mccfr: infoset key "${infoKey}" was seen with two different action sets — this is an ` +
          'information-state key collision (either an adapter defect, or the fallback digest key ' +
          'colliding two genuinely distinct information sets; see contract/types.ts).',
      );
    }
    return existing;
  }
  const created: InfosetEntry = {
    actionKeys,
    regretSum: actionKeys.map(() => 0),
    strategySum: actionKeys.map(() => 0),
  };
  table.set(infoKey, created);
  return created;
}

/**
 * One outcome-sampling walk from `state` to a terminal state, updating
 * `updatePlayer`'s regrets and average-strategy accumulators along the way.
 *
 * Reach-probability bookkeeping (mirrors outcome_sampling_mccfr.py):
 *   - myReach: updatePlayer's own reach probability to `state` under the
 *     current (regret-matched) strategy profile.
 *   - oppReach: the other player's reach probability to `state` under the
 *     current strategy profile.
 *   - sampleReach: probability of the sampled path from the root to `state`
 *     under the *sampling* policy (which differs from the strategy profile
 *     at updatePlayer's own decision nodes, where it is epsilon-mixed).
 *
 * Returns u_updatePlayer(terminal) / sampleReach(root -> terminal) — an
 * importance-sampling-corrected value estimate that is unbiased in
 * expectation over the sampling distribution. The caller at the root reads
 * this as the tail value; it is used to form W (the counterfactual value
 * estimate) at each updatePlayer decision node encountered along the path,
 * using the oppReach passed *into* that node's call (i.e. excluding that
 * node's own action).
 */
function walk(
  adapter: AnyGameAdapter,
  state: unknown,
  updatePlayer: PlayerId,
  myReach: number,
  oppReach: number,
  sampleReach: number,
  rng: Rng,
  epsilon: number,
  table: Map<string, InfosetEntry>,
): number {
  const decision = adapter.currentDecision(state);
  if (decision === null) {
    const outcome = adapter.getOutcome(state);
    if (outcome === null) {
      throw new Error('mccfr walk: terminal state produced a null Outcome — adapter defect');
    }
    return (outcome.scores[updatePlayer] as number) / sampleReach;
  }

  const actor = decision.player;
  const keyed = keyedLegalChoices(adapter, state);
  const actionKeys = keyed.map((entry) => entry.key);
  const infoKey = infosetKeyOf(adapter, state, actor);
  const entry = lookupOrCreateEntry(table, infoKey, actionKeys);

  const strategy = regretMatchedStrategy(entry.regretSum);
  const numActions = strategy.length;
  const samplingPolicy =
    actor === updatePlayer
      ? strategy.map((probability) => (epsilon * 1) / numActions + (1 - epsilon) * probability)
      : strategy;

  const chosenIndex = sampleIndex(samplingPolicy, rng.next());
  const chosen = keyed[chosenIndex] as KeyedChoice;
  const actionProbability = samplingPolicy[chosenIndex] as number;
  const strategyProbability = strategy[chosenIndex] as number;

  const nextState = adapter.applyChoice(state, chosen.choice);
  const newMyReach = actor === updatePlayer ? myReach * strategyProbability : myReach;
  const newOppReach = actor === updatePlayer ? oppReach : oppReach * strategyProbability;
  const newSampleReach = sampleReach * actionProbability;

  const tailValue = walk(
    adapter,
    nextState,
    updatePlayer,
    newMyReach,
    newOppReach,
    newSampleReach,
    rng,
    epsilon,
    table,
  );

  if (actor === updatePlayer) {
    // Counterfactual value estimate for the sampled action, weighted by
    // oppReach as passed into this node (i.e. not yet including this
    // node's own action) — see the function doc comment.
    const w = tailValue * oppReach;
    for (let index = 0; index < numActions; index += 1) {
      const regretDelta = index === chosenIndex ? w * (1 - strategyProbability) : -w * strategyProbability;
      entry.regretSum[index] = (entry.regretSum[index] as number) + regretDelta;
    }
    // Importance-sampling corrected average-strategy accumulation: every
    // legal action gets a contribution proportional to the full regret-
    // matched strategy (not just the sampled action), reweighted by
    // myReach/sampleReach-to-this-node.
    for (let index = 0; index < numActions; index += 1) {
      entry.strategySum[index] =
        (entry.strategySum[index] as number) + (myReach * (strategy[index] as number)) / sampleReach;
    }
  }

  return tailValue;
}

const GAME_SEED_BOUND = 2 ** 31;

/**
 * Train an outcome-sampling MCCFR average strategy over `adapter`. Each
 * iteration samples a fresh game seed from the training RNG (see the file
 * header doc for why this stands in for chance-node sampling), alternates
 * which player is being updated, and walks the resulting deterministic tree
 * once. Deterministic given `config`: the same `{iterations, epsilon, seed}`
 * against the same adapter always produces a bit-identical table.
 */
export function trainOutcomeSamplingMccfr(adapter: AnyGameAdapter, config: MccfrConfig): PolicyTable {
  if (adapter.spec.playerCount !== 2) {
    throw new Error(
      `trainOutcomeSamplingMccfr: outcome-sampling MCCFR is two-player only (adapter ` +
        `"${adapter.spec.gameId}" declares playerCount=${adapter.spec.playerCount})`,
    );
  }
  const epsilon = config.epsilon ?? 0.6;
  const infosetKeySource: PolicyTableMeta['infosetKeySource'] =
    adapter.informationStateKey !== undefined ? 'adapter' : 'fallback-observation';

  const table = new Map<string, InfosetEntry>();
  const rng = createRng(config.seed);

  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    const updatePlayer: PlayerId = iteration % 2;
    const gameSeed = rng.nextInt(GAME_SEED_BOUND);
    const initialState = adapter.createInitialState(gameSeed);
    walk(adapter, initialState, updatePlayer, 1, 1, 1, rng, epsilon, table);
  }

  const entries: Record<string, Record<string, number>> = {};
  for (const [infoKey, entry] of table) {
    const total = entry.strategySum.reduce((sum, value) => sum + value, 0);
    const probabilities: Record<string, number> = {};
    if (total > 0) {
      entry.actionKeys.forEach((key, index) => {
        probabilities[key] = (entry.strategySum[index] as number) / total;
      });
    } else {
      const uniform = 1 / entry.actionKeys.length;
      entry.actionKeys.forEach((key) => {
        probabilities[key] = uniform;
      });
    }
    entries[infoKey] = probabilities;
  }

  return {
    meta: {
      gameId: adapter.spec.gameId,
      iterations: config.iterations,
      epsilon,
      seed: config.seed,
      infosetKeySource,
      infosetCount: table.size,
    },
    entries,
  };
}

/**
 * Build a policy bot from a trained `PolicyTable`. Per the bot contract
 * (contract/types.ts), `decide` only ever receives an observation, never a
 * state — so this cannot call `adapter.informationStateKey` (which needs
 * state) to reproduce the training-time key. Instead it always keys with
 * the same digest(decisionPoint + canonical observation) formula the
 * fallback path uses during training.
 *
 * This means policyBotFactory only reproduces training-time keys exactly
 * when the adapter's `informationStateKey` (if declared) is itself defined
 * to reduce to that same digest for every (state, player) pair — i.e. when
 * it depends only on information already present in `getObservation`'s
 * output plus the current decisionPoint. mini-trick's `informationStateKey`
 * (docs/GAP-ANALYSIS-7.md O7-b) satisfies this by construction. An adapter
 * whose declared informationStateKey depends on state fields absent from
 * its observation would train a table this function cannot correctly
 * replay; none of the adapters onboarded so far do that, but it is a real
 * constraint of this port, not a hidden one.
 */
export function policyBotFactory(
  adapter: AnyGameAdapter,
  table: PolicyTable,
  seed: number,
): GameBot<unknown, unknown> {
  const rng = createRng(seed);
  return {
    id: `mccfr-os-${table.meta.iterations}-${seed}`,
    decide(decisionPoint, observation, legal) {
      if (legal.length === 0) {
        throw new Error('policyBotFactory: decide called with an empty legal-choice array — adapter defect');
      }
      const key = fallbackKey(adapter, decisionPoint, observation);
      const keyed: KeyedChoice[] = legal.map((choice) => ({ choice, key: adapter.encodeChoice(choice) }));
      const distribution = table.entries[key];
      if (distribution === undefined) {
        return (keyed[rng.nextInt(keyed.length)] as KeyedChoice).choice;
      }
      const weights = keyed.map((entry) => distribution[entry.key] ?? 0);
      const total = weights.reduce((sum, value) => sum + value, 0);
      if (total <= 0) {
        return (keyed[rng.nextInt(keyed.length)] as KeyedChoice).choice;
      }
      const draw = rng.next() * total;
      let cumulative = 0;
      for (let index = 0; index < keyed.length; index += 1) {
        cumulative += weights[index] as number;
        if (draw < cumulative) {
          return (keyed[index] as KeyedChoice).choice;
        }
      }
      return (keyed[keyed.length - 1] as KeyedChoice).choice;
    },
  };
}

/**
 * Wrap `policyBotFactory` into an `AnyBotFactory` for use in a
 * `StrategyFlagSpec.apply` (see src/loop/compose.ts's `withStrategyFlags`
 * and src/search/mcts.ts's `mctsBotFactory` for the analogous pattern):
 * `apply` ignores its `base` argument entirely, since a policy bot builds
 * its decision from the trained table, not by modulating a base bot.
 */
export function policyBotFactoryFor(adapter: AnyGameAdapter, table: PolicyTable): AnyBotFactory {
  return (seed) => policyBotFactory(adapter, table, seed);
}
