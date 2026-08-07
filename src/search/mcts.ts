/**
 * UCT Monte Carlo Tree Search — a faithful port of OpenSpiel's
 * `open_spiel/python/algorithms/mcts.py` (Apache-2.0; see docs/CREDITS.md,
 * docs/GAP-ANALYSIS-7.md O5). Ported semantics: UCT child selection
 * (exploit + uctC * sqrt(ln(parentCount)/childCount), unvisited children
 * expanded before any UCT comparison happens), a random-rollout evaluator,
 * and "most-visited root child wins, ties broken by total reward" final
 * action selection (docs/FIX-BACKLOG.md P5 — see mctsSearch's doc comment for
 * the mcts.py `SearchNode.sort_key` correspondence).
 *
 * P5 BEHAVIOR CHANGE NOTICE (docs/FIX-BACKLOG.md P5): this file previously (1)
 * broke visit-count ties by `encodeChoice` key alone, ignoring accumulated
 * reward, and (2) expanded `untried` children in `getLegalChoices` FIFO order,
 * which is a fidelity defect relative to mcts.py's `SearchNode.sort_key =
 * (outcome, explore_count, total_reward)` and — for adapters whose
 * `getLegalChoices` has positional structure (e.g. gomoku's board scan order)
 * — a source of systematic expansion bias. Both are fixed below. Any bot
 * built on `mctsBotFactory`/`mctsSearch` — including the already-registered
 * `mcts-s64` gomoku flag — now plays differently than before this fix, even
 * though its flag name and config are unchanged: registry v3 reconstruction
 * reproduces a genuinely different bot post-fix. This is the concrete
 * evidence for why source-closure digests (not just flag names) belong on
 * the roadmap for registry provenance.
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

import type { AnyBotFactory, AnyGameAdapter, GameBot, Outcome, PlayerId, Rng } from '../contract/types';
import { createRng, shuffled } from '../kernel/rng';

export interface MctsConfig {
  readonly simulations: number;
  readonly uctC: number;
  readonly rolloutCount: number;
  /** Stamped into bot ids (e.g. "s64") so the sim budget is legible in adoption records and comparabilityKey-adjacent labels. */
  readonly label: string;
  /**
   * Rollout evaluator policy (docs/FIX-BACKLOG.md P1). 'random' (default,
   * omitted preserves byte-for-byte pre-existing behavior) draws uniformly
   * from legal choices, matching mcts.py's RandomRolloutEvaluator. 'heuristic'
   * swaps in the adapter's own `baselines.heuristic` bot to drive every
   * rollout decision instead — the same "replace the evaluator" pattern
   * OpenSpiel's mcts.py documents (a RandomRolloutEvaluator is one choice of
   * evaluator; any policy can stand in for it). This does not let game
   * knowledge leak into the search layer: the adapter already bundles its own
   * baseline bot, and the search code only ever calls the adapter-supplied
   * `decide` through the same GameBot interface every other bot uses.
   */
  readonly rolloutPolicy?: 'random' | 'heuristic';
  /**
   * Rollout-policy override that takes precedence over `rolloutPolicy`
   * (docs/GAP-ANALYSIS-8.md gomoku C-column retry): when supplied, every
   * rollout decision is driven by a bot instantiated from this factory
   * instead of `adapter.baselines.heuristic` (the 'heuristic' policy above)
   * or a uniform-random draw (the 'random' policy). The evaluator-swap
   * pattern is the same one `rolloutPolicy: 'heuristic'` already documents —
   * this just widens the pool of eligible rollout policies to any
   * `AnyBotFactory`, e.g. a composeBot-assembled composite of several
   * strategySurface flags, so a stronger hand-authored bot can drive
   * rollouts instead of the adapter's single raw-heuristic baseline. Seeded
   * the same way the 'heuristic' path already is (`deriveHeuristicRolloutSeed`
   * forked off the search's injected `rng`), so supplying it stays fully
   * deterministic. Left `undefined` (the default), every existing flag's
   * behavior is byte-for-byte unchanged — this field is additive only.
   */
  readonly rolloutFactory?: AnyBotFactory;
  /**
   * Game-neutral tactical safety net (docs/GAP-ANALYSIS-8.md §4.6 gomoku
   * C-column retry — the "immediate win / immediate must-block" priority
   * that decided the C-column matchup turns out to need no game knowledge at
   * all: `applyChoice` + `getOutcome` alone can answer "does this move win
   * right now" and "does this move hand the opponent a win next turn" for
   * any adapter). Left `undefined` (equivalent to 0, the default), every
   * existing flag's behavior is byte-for-byte unchanged — `getLegalChoices`
   * is called exactly once at the root either way, so this field is
   * additive only.
   *   - 1: before running any simulation, check every root-legal choice for
   *     an immediate win (applying it yields a terminal Outcome whose
   *     winners include the deciding player). If found, that choice is
   *     returned immediately — no simulation, fully deterministic.
   *   - 2: when no immediate win exists, check every root-legal choice (or
   *     the `tacticalBranchCap`-limited sample of them, see below) for
   *     safety: does it leave the opponent an immediate win on their very
   *     next decision? Choices that do are dropped. If at least one safe
   *     choice remains, the root's candidate set is narrowed to just the
   *     safe ones — a safety net, not a forced pick, so ordinary MCTS still
   *     chooses among whichever safe choices remain. If every checked
   *     choice is unsafe (every move loses), the narrowing is skipped and
   *     the full legal set is used, exactly as if tacticalDepth were 0.
   */
  readonly tacticalDepth?: 0 | 1 | 2;
  /**
   * Caps how many root-legal choices the depth-2 opponent-reply check
   * examines (2-ply tactical prechecking is O(legal^2) in the worst case, so
   * a game with a large branching factor may need this to stay cheap). The
   * sampled subset is drawn deterministically via `rng` (a forked stream, so
   * it does not disturb any other rng consumption). Left `undefined`, every
   * root-legal choice is checked (no cap). Ignored when `tacticalDepth < 2`.
   */
  readonly tacticalBranchCap?: number;
  /**
   * Game-neutral root-decision override hook (docs/GAP-ANALYSIS-8.md gomoku
   * C-column retry — the "shallow MCTS dilutes a deterministic tactical
   * signal" fix). Called once per `mctsSearch` invocation with the root
   * state/legal-choices/mover; when it returns a non-null choice, that choice
   * is returned immediately and no simulation is run at all (deterministic,
   * exactly like `tacticalDepth`'s depth=1 immediate-win short-circuit).
   * Returning `null` falls through to ordinary search, unaffected.
   *
   * The hook itself is game-neutral infrastructure — `search/mcts.ts` never
   * inspects what the function does internally, it only calls it through this
   * signature — but the function a caller supplies is free to be full of game
   * knowledge (e.g. gomoku's fork-detection geometry). That split is the
   * point: this field lets a game-specific priority judgment bypass the
   * search's statistical averaging (the actual bug this targets — 256
   * shallow simulations diluting a deterministic "this move is a fork"
   * verdict into noise), while keeping that judgment's logic out of this
   * file, in the adapter layer where game knowledge belongs.
   *
   * Precedence (see `mctsSearch`'s body for exactly where this is called):
   *   1. `tacticalDepth >= 1`'s immediate-win check always wins first when it
   *      fires — an actual winning move is strictly better than any
   *      heuristic override, so it must never be shadowed by one.
   *   2. `rootOverride`, checked next (whether or not `tacticalDepth` is set
   *      at all — the two options are independent).
   *   3. `tacticalDepth >= 2`'s opponent-immediate-win safety net, which only
   *      narrows the legal set rather than deciding outright, so it runs
   *      after any override has already had the chance to decide outright.
   *   4. Ordinary UCT simulation.
   * Left `undefined` (the default), every existing flag's behavior is
   * byte-for-byte unchanged — this field is additive only.
   */
  readonly rootOverride?: (
    adapter: AnyGameAdapter,
    state: unknown,
    legal: readonly unknown[],
    player: PlayerId,
  ) => unknown | null;
  /**
   * PUCT-style progressive-bias prior weight (ADR-0011,
   * docs/GAP-ANALYSIS-11.md D2 — the R3 fix: before this, the only channels
   * for game knowledge to reach the tree were rollout-evaluator swaps
   * (diluted by averaging across rollouts) and `rootOverride` (all-or-nothing
   * at the root only) — neither injects knowledge into ordinary mid-tree
   * selection). Left `undefined` (equivalent to 0, the default), every
   * existing flag's behavior — including expansion order and child selection
   * — is byte-for-byte unchanged; this is the field's regression pin.
   *
   * When set to a positive number, `selectChild`'s UCB term becomes
   * `Q + uctC*sqrt(ln(N)/n) + priorWeight*P(c)/(1+n)` — the added term decays
   * as a child accumulates visits (`n` in its denominator), so the prior only
   * ever *guides* early exploration; accumulated statistics (`Q`, the explore
   * term) eventually dominate regardless of `priorWeight`'s magnitude. `P(c)`
   * is the softmax (numerically stabilized: max subtracted before `exp`) of
   * `priorSource`'s per-choice scores for the node's own (state, mover,
   * legal-choices) triple. Expansion order is also prior-descending (ties
   * broken by `encodeChoice` key, for determinism) instead of the rng-shuffled
   * order used when this is unset.
   */
  readonly priorWeight?: number;
  /**
   * Which per-choice evaluator supplies `priorWeight`'s scores. `v1` supports
   * only the adapter's own `choiceEvaluator` (contract/types.ts, ADR-0011) —
   * declared as a union of one literal so future prior sources are additive.
   * Throws a clear error at the start of `mctsSearch` when `priorWeight` is
   * a positive number (or this field is set at all) and the adapter does not
   * declare `choiceEvaluator` — a silent no-op prior would be worse than a
   * loud contract violation.
   */
  readonly priorSource?: 'choiceEvaluator';
  /**
   * Direct per-choice evaluator injection (docs/GAP-ANALYSIS-11.md Phase 3-B
   * B3, `gomoku-chain-evaluator.ts`): takes precedence over `priorSource`/
   * `adapter.choiceEvaluator` when supplied, so a caller can hand the search
   * a game-neutral function value directly instead of going through the
   * adapter's single `choiceEvaluator` field. This is what makes candidate-
   * level evaluator *variants* possible — `adapter.choiceEvaluator` is one
   * fixed field per adapter, so two candidates that want different evaluators
   * (e.g. `mcts5-s256-chain-w16` vs a future evaluator experiment) cannot both
   * express themselves through it, while each can supply its own
   * `priorEvaluator` function. Search never inspects what the function does
   * internally — same contract as `adapter.choiceEvaluator`, just supplied at
   * the config call site instead of the adapter definition, so this stays
   * game-neutral infrastructure even though the function itself is free to
   * encode game knowledge (see `resolvePriorEvaluator`). Left `undefined`
   * (the default), `priorSource`/`adapter.choiceEvaluator` resolution is
   * exactly as before — this field is additive only, the regression pin for
   * every existing `priorSource: 'choiceEvaluator'` caller.
   */
  readonly priorEvaluator?: (
    state: unknown,
    player: PlayerId,
    choices: readonly unknown[],
  ) => readonly number[];
  /**
   * Per-decision priorWeight override (GAP-11 Phase 4-B B3 처치 2, game-
   * neutral time-axis extension of `priorWeight`): when supplied, each
   * `decide()` call resolves an *effective* priorWeight from
   * `priorWeightSchedule(decisionIndex)` instead of the fixed `priorWeight`
   * field — `decisionIndex` counts how many decisions *this bot instance* has
   * already made (0 for its first move in the game, 1 for its second, …),
   * maintained by the bot factory (`mctsBotFactory`/`search/ismcts.ts`'s
   * `ismctsBotFactory`), not by `mctsSearch`/`ismctsSearch` themselves — both
   * search functions still only ever read the single `priorWeight` field, so
   * this is purely a config-resolution concern the bot factories share via
   * `applyPriorWeightSchedule` below (the "IS-MCTS shares MctsConfig
   * verbatim" invariant this file's `priorIsActive` doc comment already
   * documents extends to this field automatically). Left `undefined` (the
   * default), `applyPriorWeightSchedule` returns `config` completely
   * unchanged (same object reference, not just same values) — the regression
   * pin for every existing caller of either bot factory.
   */
  readonly priorWeightSchedule?: (decisionIndex: number) => number;
}

/**
 * Static diagnostics for the optional MCTS controls. `errors` denotes a
 * configuration the current runtime explicitly rejects; `warnings` denotes a
 * legal configuration whose precedence, implicit dependency, or no-op effect
 * deserves an intentional caller decision. This function is pure: it neither
 * calls a factory/evaluator/schedule nor inspects an adapter, so adapter- and
 * schedule-result-dependent checks remain the responsibility of the caller
 * that has those values.
 */
export interface MctsOptionsValidation {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * MctsConfig optional-field combination contract. IS-MCTS consumes this same
 * config, but only the rollout/prior fields affect it; root tactical controls
 * are intentionally MCTS-root-only.
 *
 * | Field(s) | Contract / precedence |
 * | --- | --- |
 * | `rolloutPolicy` | `'random'` is the default; `'heuristic'` uses the adapter heuristic in rollouts. |
 * | `rolloutFactory` + `rolloutPolicy` | Valid and intentional: `rolloutFactory` wins for every rollout. |
 * | `tacticalDepth` | MCTS-root-only precheck; independent of `rootOverride`. |
 * | `tacticalBranchCap` | Used only at `tacticalDepth: 2`; it is otherwise ignored, so validation warns. |
 * | `rootOverride` | MCTS-root-only; after an immediate-win check and before the depth-2 safety net. |
 * | `priorWeight` | Activates a prior only when positive. With no direct evaluator it defaults to `priorSource: 'choiceEvaluator'`; the search then requires the adapter evaluator. |
 * | `priorSource` | v1 accepts only `'choiceEvaluator'`; it has no effect while neither a positive fixed weight nor a schedule can activate a prior. |
 * | `priorEvaluator` | Takes precedence over `priorSource`/adapter evaluator, but likewise has no effect without an active fixed or scheduled weight. |
 * | `priorWeightSchedule` | Replaces the fixed weight per bot decision. By itself it can still activate the implicit `choiceEvaluator` path; its returned values cannot be checked without executing user code. |
 *
 * The validator is deliberately not called by `mctsSearch` or `ismctsSearch`:
 * the established searches retain their runtime behavior, including their
 * adapter-specific fail-fast check and schedule resolution. Runners may opt in
 * at configuration assembly time.
 */
export function validateMctsOptions(config: MctsConfig): MctsOptionsValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const hasFixedActivePrior = priorIsActive(config);
  const hasSchedule = config.priorWeightSchedule !== undefined;
  const hasPotentiallyActivePrior = hasFixedActivePrior || hasSchedule;

  // MctsConfig's TypeScript union makes this unreachable for normally typed
  // callers, but JSON/config-file input can still reach the runtime guard in
  // requireChoiceEvaluator. Keep this pure contract aligned with that guard.
  if (config.priorSource !== undefined && config.priorSource !== 'choiceEvaluator') {
    errors.push(`unknown priorSource "${String(config.priorSource)}"; v1 supports only 'choiceEvaluator'`);
  }

  if (config.tacticalBranchCap !== undefined && (config.tacticalDepth ?? 0) < 2) {
    warnings.push('tacticalBranchCap is ignored unless tacticalDepth is 2');
  }

  if (hasFixedActivePrior && config.priorSource === undefined && config.priorEvaluator === undefined) {
    warnings.push(
      "priorWeight uses the implicit priorSource 'choiceEvaluator'; mctsSearch/ismctsSearch will throw if the adapter lacks choiceEvaluator",
    );
  }

  if (hasSchedule && config.priorSource === undefined && config.priorEvaluator === undefined) {
    warnings.push(
      "priorWeightSchedule may activate the implicit priorSource 'choiceEvaluator'; its returned weights and adapter availability are runtime-dependent",
    );
  }

  if (!hasPotentiallyActivePrior && config.priorSource !== undefined) {
    warnings.push('priorSource is ignored because priorWeight is not positive and priorWeightSchedule is unset');
  }

  if (!hasPotentiallyActivePrior && config.priorEvaluator !== undefined) {
    warnings.push('priorEvaluator is ignored because priorWeight is not positive and priorWeightSchedule is unset');
  }

  return { errors, warnings };
}

/**
 * Resolve `config.priorWeightSchedule` (this file's `MctsConfig` doc comment)
 * against `decisionIndex` into an effective per-call config: when
 * `priorWeightSchedule` is set, returns a shallow copy with `priorWeight`
 * replaced by `priorWeightSchedule(decisionIndex)`; otherwise returns `config`
 * itself, unchanged, by reference — the byte-for-byte regression pin every
 * existing (schedule-unset) caller of `mctsBotFactory`/`ismctsBotFactory`
 * relies on. Exported so `search/ismcts.ts`'s `ismctsBotFactory` can share
 * this exact resolution instead of re-deriving it.
 */
export function applyPriorWeightSchedule(config: MctsConfig, decisionIndex: number): MctsConfig {
  if (config.priorWeightSchedule === undefined) {
    return config;
  }
  return { ...config, priorWeight: config.priorWeightSchedule(decisionIndex) };
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
  /**
   * Softmax prior per child `encodeChoice` key, computed once at node
   * creation time (the "evaluator called once per node, not per selection"
   * cost constraint — ADR-0011/GAP-11 D2) from this node's own (state, mover,
   * legal-choices) triple. `undefined` when priorWeight/priorSource are not
   * active for this search, so an inactive prior costs nothing beyond the
   * one extra optional field.
   */
  readonly priorByKey: ReadonlyMap<string, number> | undefined;

  constructor(mover: PlayerId | null, untried: readonly unknown[], priorByKey?: ReadonlyMap<string, number>) {
    this.mover = mover;
    this.untried = [...untried];
    this.priorByKey = priorByKey;
  }
}

/**
 * True iff `config.priorWeight` requests progressive-bias prior injection
 * (MctsConfig's doc comment) — the single switch every prior-related branch
 * below gates on. Exported so `search/ismcts.ts` can gate its own
 * availability-UCB prior term on the exact same condition (MctsConfig is
 * shared verbatim between the two search algorithms, docs/GAP-ANALYSIS-11.md
 * D2 — "IS-MCTS는 MctsConfig를 재사용하므로 자동 적용").
 */
export function priorIsActive(config: MctsConfig): boolean {
  return (config.priorWeight ?? 0) > 0;
}

/**
 * Resolve and validate the per-choice evaluator `priorWeight` needs (MctsConfig's
 * doc comment): only called when `priorIsActive(config)` is true. Throws a
 * clear, adapter-identifying error rather than silently disabling the prior
 * when the adapter has not declared `choiceEvaluator` (contract/types.ts,
 * ADR-0011) — `priorSource` is a single-literal union in v1, so there is
 * nothing else to branch on yet, but the check is written to fail loudly if
 * that ever changes.
 */
export function requireChoiceEvaluator(
  adapter: AnyGameAdapter,
  config: MctsConfig,
): (state: unknown, player: PlayerId, choices: readonly unknown[]) => readonly number[] {
  const source = config.priorSource ?? 'choiceEvaluator';
  if (source !== 'choiceEvaluator') {
    throw new Error(`mctsSearch: unknown priorSource "${source}" — v1 supports only 'choiceEvaluator'`);
  }
  if (adapter.choiceEvaluator === undefined) {
    throw new Error(
      `mctsSearch: priorWeight is set but adapter "${adapter.spec.gameId}" does not declare choiceEvaluator ` +
        '(required for priorSource \'choiceEvaluator\', see contract/types.ts GameAdapter.choiceEvaluator and docs/adr/0011-choice-evaluator-tree-prior.md)',
    );
  }
  return adapter.choiceEvaluator;
}

/**
 * Resolve the per-choice evaluator `priorWeight` needs (MctsConfig's doc
 * comment): `config.priorEvaluator` wins when supplied — it needs no
 * adapter-declared `choiceEvaluator` at all — otherwise falls back to
 * `requireChoiceEvaluator`'s existing `priorSource: 'choiceEvaluator'`
 * resolution (adapter.choiceEvaluator). Only called when `priorIsActive(config)`
 * is true, same discipline as `requireChoiceEvaluator`. Exported so
 * `search/ismcts.ts` shares the identical resolution order (MctsConfig is
 * shared verbatim between the two search algorithms).
 */
export function resolvePriorEvaluator(
  adapter: AnyGameAdapter,
  config: MctsConfig,
): (state: unknown, player: PlayerId, choices: readonly unknown[]) => readonly number[] {
  if (config.priorEvaluator !== undefined) {
    return config.priorEvaluator;
  }
  return requireChoiceEvaluator(adapter, config);
}

/**
 * Softmax over `scores`, numerically stabilized by subtracting the max
 * before `exp` (MctsConfig.priorWeight's doc comment). Exported for
 * `search/ismcts.ts`'s own prior term (same normalization, same source
 * evaluator).
 */
export function softmax(scores: readonly number[]): readonly number[] {
  const max = Math.max(...scores);
  const exps = scores.map((score) => Math.exp(score - max));
  const sum = exps.reduce((total, value) => total + value, 0);
  return exps.map((value) => value / sum);
}

/**
 * Order `legal` for a node's `untried` list and, when the prior is active,
 * compute its softmax priorByKey — the one call site both root creation and
 * per-simulation child creation share, so the evaluator is invoked exactly
 * once per node regardless of caller (MctsConfig.priorWeight's "called once
 * per node" cost constraint). When the prior is inactive, this reproduces the
 * pre-existing `shuffled(legal, rng)` order byte-for-byte and returns no
 * priorByKey — the regression pin for priorWeight-unset callers.
 */
function orderChoicesWithPrior(
  adapter: AnyGameAdapter,
  state: unknown,
  player: PlayerId,
  legal: readonly unknown[],
  config: MctsConfig,
  rng: Rng,
): { readonly ordered: readonly unknown[]; readonly priorByKey: ReadonlyMap<string, number> | undefined } {
  if (!priorIsActive(config)) {
    return { ordered: shuffled(legal, rng), priorByKey: undefined };
  }
  const evaluator = resolvePriorEvaluator(adapter, config);
  const scores = evaluator(state, player, legal);
  const priors = softmax(scores);
  const entries = legal.map((choice, index) => ({
    choice,
    key: adapter.encodeChoice(choice),
    prior: priors[index] as number,
  }));
  entries.sort((a, b) => b.prior - a.prior || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    ordered: entries.map((entry) => entry.choice),
    priorByKey: new Map(entries.map((entry) => [entry.key, entry.prior])),
  };
}

function rewardOf(outcome: Outcome, player: PlayerId): number {
  if (!outcome.winners.includes(player)) {
    return 0;
  }
  return 1 / outcome.winners.length;
}

/**
 * Derive a deterministic bot seed for one heuristic rollout by forking off
 * the search's injected `rng` with a label unique to this rollout's index
 * within its `evaluate()` call — keeps the derivation reproducible for a
 * given (rng, rolloutIndex) pair without ever touching Date.now()/Math.random().
 */
function deriveHeuristicRolloutSeed(rng: Rng, rolloutIndex: number): number {
  return rng.fork(`mcts-heuristic-rollout-${rolloutIndex}`).nextInt(2_147_483_647);
}

/**
 * Resolve the rollout policy for one `evaluate()` call into either a bot
 * instance to drive every rollout decision, or `null` for uniform-random
 * draws. `config.rolloutFactory`, when present, takes precedence over
 * `config.rolloutPolicy` (see MctsConfig's doc comment) — otherwise this
 * mirrors the pre-existing 'heuristic'/'random' branching exactly, so
 * omitting both new-and-old override fields reproduces the original
 * behavior byte-for-byte.
 */
function resolveRolloutBot(
  adapter: AnyGameAdapter,
  config: MctsConfig,
  rng: Rng,
  rolloutIndex: number,
): GameBot<unknown, unknown> | null {
  if (config.rolloutFactory !== undefined) {
    return config.rolloutFactory(deriveHeuristicRolloutSeed(rng, rolloutIndex));
  }
  if (config.rolloutPolicy === 'heuristic') {
    return adapter.baselines.heuristic(deriveHeuristicRolloutSeed(rng, rolloutIndex));
  }
  return null;
}

/**
 * One rollout from `state` to a terminal state. With no rollout bot resolved
 * (`config.rolloutFactory` unset and `config.rolloutPolicy` not 'heuristic'),
 * draws uniformly from legal choices via `rng` (mcts.py's
 * RandomRolloutEvaluator). Otherwise the resolved bot instance decides every
 * step — the OpenSpiel evaluator-replacement pattern referenced on
 * MctsConfig, now open to either the adapter's own heuristic baseline or any
 * caller-supplied `rolloutFactory`.
 */
function rolloutOnce(
  adapter: AnyGameAdapter,
  state: unknown,
  rng: Rng,
  config: MctsConfig,
  rolloutIndex: number,
): Outcome {
  let current = state;
  let decisions = 0;
  const rolloutBot = resolveRolloutBot(adapter, config, rng, rolloutIndex);
  while (adapter.currentDecision(current) !== null) {
    if (decisions >= adapter.spec.maxDecisionsPerGame) {
      throw new Error(
        `mcts rollout: exceeded maxDecisionsPerGame (${adapter.spec.maxDecisionsPerGame}) without reaching a terminal state — adapter defect`,
      );
    }
    const decision = adapter.currentDecision(current) as { player: PlayerId; decisionPoint: string };
    const legal = adapter.getLegalChoices(current);
    const choice =
      rolloutBot !== null
        ? rolloutBot.decide(decision.decisionPoint, adapter.getObservation(current, decision.player), legal)
        : legal[rng.nextInt(legal.length)];
    current = adapter.applyChoice(current, choice);
    decisions += 1;
  }
  const outcome = adapter.getOutcome(current);
  if (outcome === null) {
    throw new Error('mcts rollout: terminal state produced a null Outcome — adapter defect');
  }
  return outcome;
}

/**
 * RandomRolloutEvaluator (mcts.py), or its heuristic-/rolloutFactory-evaluator
 * swap: average per-player reward across `rolloutCount` independent
 * rollouts. Exported (docs/FIX-BACKLOG.md P4) so `src/search/ismcts.ts` can
 * reuse the exact same rollout evaluator instead of re-implementing it.
 * Takes the whole `config` (rather than a bare policy string) so
 * `rolloutFactory` reaches `rolloutOnce` — existing call sites that only ever
 * set `rolloutPolicy` (or neither) are unaffected.
 */
export function evaluate(
  adapter: AnyGameAdapter,
  state: unknown,
  rolloutCount: number,
  rng: Rng,
  config: MctsConfig,
): readonly number[] {
  const playerCount = adapter.spec.playerCount;
  const totals = new Array<number>(playerCount).fill(0);
  for (let i = 0; i < rolloutCount; i += 1) {
    const outcome = rolloutOnce(adapter, state, rng, config, i);
    for (let player = 0; player < playerCount; player += 1) {
      totals[player] = (totals[player] as number) + rewardOf(outcome, player);
    }
  }
  return totals.map((total) => total / rolloutCount);
}

/**
 * Return the first choice in `legal` that wins immediately for `mover` when
 * applied to `state` (a terminal Outcome whose winners include `mover`), or
 * null when none does. Game-neutral (MctsConfig.tacticalDepth's doc comment):
 * relies only on `applyChoice`/`getOutcome`, never on game-specific knowledge.
 */
function findImmediateWin(
  adapter: AnyGameAdapter,
  state: unknown,
  legal: readonly unknown[],
  mover: PlayerId,
): unknown | null {
  for (const choice of legal) {
    const outcome = adapter.getOutcome(adapter.applyChoice(state, choice));
    if (outcome !== null && outcome.winners.includes(mover)) {
      return choice;
    }
  }
  return null;
}

/**
 * Depth-2 half of the tactical precheck (MctsConfig.tacticalDepth's doc
 * comment): from `legal` (optionally sampled down to `branchCap` choices via
 * a forked `rng` stream, so the sampling itself stays deterministic and
 * independent of the caller's own rng consumption), return the subset that
 * does NOT hand `mover`'s opponent an immediate win on their very next
 * decision. A choice that ends the game outright (terminal Outcome, e.g. a
 * draw) is trivially safe — there is no opponent decision left to check.
 */
function tacticalSafeChoices(
  adapter: AnyGameAdapter,
  state: unknown,
  legal: readonly unknown[],
  branchCap: number | undefined,
  rng: Rng,
): readonly unknown[] {
  const pool =
    branchCap !== undefined && branchCap < legal.length
      ? shuffled(legal, rng.fork('mcts-tactical-branch-cap')).slice(0, branchCap)
      : legal;
  const safe: unknown[] = [];
  for (const choice of pool) {
    const next = adapter.applyChoice(state, choice);
    const outcome = adapter.getOutcome(next);
    if (outcome !== null) {
      safe.push(choice); // game over after this move — no opponent reply to check
      continue;
    }
    const opponentDecision = adapter.currentDecision(next) as { player: PlayerId } | null;
    if (opponentDecision === null) {
      safe.push(choice); // defensive: outcome contract says this can't happen, but don't discard a safe-looking choice on a contract violation
      continue;
    }
    const opponentLegal = adapter.getLegalChoices(next);
    if (findImmediateWin(adapter, next, opponentLegal, opponentDecision.player) === null) {
      safe.push(choice);
    }
  }
  return safe;
}

/**
 * UCT selection among `node`'s (already-expanded) children — never called
 * while untried moves remain. When `config.priorWeight` is active, the value
 * gains a third, progressive-bias term (`priorWeight*P(c)/(1+n)`,
 * MctsConfig.priorWeight's doc comment) drawn from `node.priorByKey`
 * (computed once at `node`'s own creation, never here); `priorWeight`
 * unset/0 reproduces the pre-existing two-term UCT value exactly (the term
 * evaluates to `0 * anything`, added to a sum, changing nothing).
 */
function selectChild(node: SearchNode, config: MctsConfig): ChildEdge {
  const logParent = Math.log(node.exploreCount);
  const priorWeight = config.priorWeight ?? 0;
  let best: ChildEdge | null = null;
  let bestValue = -Infinity;
  for (const child of node.children) {
    const exploit = child.node.totalReward / child.node.exploreCount;
    const explore = config.uctC * Math.sqrt(logParent / child.node.exploreCount);
    const prior = priorWeight > 0 ? (priorWeight * (node.priorByKey?.get(child.key) ?? 0)) / (1 + child.node.exploreCount) : 0;
    const value = exploit + explore + prior;
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
 * matching mcts.py's final action selection. mcts.py's
 * `SearchNode.sort_key` breaks ties as `(outcome, explore_count,
 * total_reward)`; this port has no solver (no `outcome`, see the file-level
 * doc comment's "deliberate differences" list), so ties are broken by
 * `(explore_count, total_reward)` — most visits, then highest accumulated
 * reward for the mover who created the child — and only fall through to the
 * lower `encodeChoice` key when both are equal, purely for determinism
 * (docs/FIX-BACKLOG.md P5; previously this fell straight to the key, which
 * silently discarded reward information whenever two children were visited
 * equally often).
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

  // Fail fast (MctsConfig.priorWeight's doc comment): a search that was
  // asked for a prior it cannot compute should never silently fall back to
  // no-prior behavior. `priorIsActive` is false when priorWeight is
  // unset/0 — the byte-for-byte regression pin for every existing caller —
  // so this check never even runs the erased `adapter.choiceEvaluator`
  // lookup for those callers.
  if (priorIsActive(config)) {
    resolvePriorEvaluator(adapter, config);
  }

  // Tactical precheck (MctsConfig.tacticalDepth's doc comment): left
  // undefined/0, `rootLegal` below is exactly `adapter.getLegalChoices(rootState)`
  // and no rng is consumed here, so this reproduces the pre-existing
  // behavior byte-for-byte.
  let rootLegal = adapter.getLegalChoices(rootState);
  const tacticalDepth = config.tacticalDepth ?? 0;
  if (tacticalDepth >= 1) {
    const immediateWin = findImmediateWin(adapter, rootState, rootLegal, rootDecision.player);
    if (immediateWin !== null) {
      return immediateWin;
    }
  }
  // rootOverride (MctsConfig's doc comment): checked after the immediate-win
  // short-circuit above (an actual win always beats a heuristic override) but
  // before the tacticalDepth>=2 safety net below (that net only narrows the
  // legal set, it never decides outright, so an override that does decide
  // outright should get the chance first). Independent of tacticalDepth —
  // this runs whether or not tacticalDepth is set.
  if (config.rootOverride !== undefined) {
    const overridden = config.rootOverride(adapter, rootState, rootLegal, rootDecision.player);
    if (overridden !== null) {
      return overridden;
    }
  }
  if (tacticalDepth >= 2) {
    const safe = tacticalSafeChoices(
      adapter,
      rootState,
      rootLegal,
      config.tacticalBranchCap,
      rng,
    );
    if (safe.length > 0) {
      rootLegal = safe;
    }
  }

  // Untried children are ordered before any expansion happens (not left in
  // getLegalChoices order): rng-shuffled by default (same rng seed still
  // yields the same shuffle, so this stays fully deterministic, but it
  // removes the positional bias that a FIFO `.shift()` over an
  // adapter-ordered legal-choices array would otherwise impose — P5; observed
  // in gomoku as expansion sticking to the board's first few scanned rows),
  // or prior-descending when priorWeight is active (MctsConfig.priorWeight's
  // doc comment) — orderChoicesWithPrior picks between the two and also
  // caches the root's priorByKey for selectChild.
  const rootOrdering = orderChoicesWithPrior(adapter, rootState, rootDecision.player, rootLegal, config, rng);
  const root = new SearchNode(null, rootOrdering.ordered, rootOrdering.priorByKey);

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
        let childUntried: readonly unknown[] = [];
        let childPriorByKey: ReadonlyMap<string, number> | undefined;
        if (childDecision !== null) {
          const childOrdering = orderChoicesWithPrior(
            adapter,
            childState,
            childDecision.player,
            adapter.getLegalChoices(childState),
            config,
            rng,
          );
          childUntried = childOrdering.ordered;
          childPriorByKey = childOrdering.priorByKey;
        }
        const childNode = new SearchNode(decision.player, childUntried, childPriorByKey);
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
      const selected = selectChild(node, config);
      state = adapter.applyChoice(state, selected.choice);
      node = selected.node;
      path.push(node);
    }

    const rewards = evaluate(adapter, state, config.rolloutCount, rng, config);
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
  // Tie-break order mirrors mcts.py's SearchNode.sort_key minus the solver
  // term: explore_count, then total_reward, then (this port only) the
  // encodeChoice key for a fully deterministic last resort (docs/FIX-BACKLOG.md P5).
  let best = root.children[0] as ChildEdge;
  for (const child of root.children) {
    if (
      child.node.exploreCount > best.node.exploreCount ||
      (child.node.exploreCount === best.node.exploreCount &&
        child.node.totalReward > best.node.totalReward) ||
      (child.node.exploreCount === best.node.exploreCount &&
        child.node.totalReward === best.node.totalReward &&
        child.key < best.key)
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
    let decisionIndex = 0;
    return {
      id,
      decide(_decisionPoint, observation, legal) {
        const rootState = reconstructState(observation);
        const effectiveConfig = applyPriorWeightSchedule(config, decisionIndex);
        decisionIndex += 1;
        const choice = mctsSearch(adapter, rootState, effectiveConfig, rng);
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
