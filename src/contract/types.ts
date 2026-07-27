/**
 * Loop Forge — Game Adapter Contract (authoritative).
 *
 * Everything above this layer (kernel, onboarding scoring, loop engine) depends
 * ONLY on the types in this file. No game knowledge may leak upward: a game's
 * rules, cards, phases, and heuristics live entirely inside one GameAdapter
 * implementation. Decision points are declared as data, and the bot interface
 * is a single `decide` method, so the harness never needs game-specific hooks.
 *
 * Determinism rule (enforced by the C1 conformance axis): adapter and bot code
 * must not touch Date.now(), Math.random(), or any external I/O. All randomness
 * flows from the seeds passed to `createInitialState` and `BotFactory`.
 */

export type PlayerId = number; // 0..playerCount-1

/** Deterministic RNG handle. Implementations must be pure given their seed. */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, bound). */
  nextInt(bound: number): number;
  /** Derive an independent, reproducible child stream. */
  fork(label: string): Rng;
}

/** A named decision the game can ask a player to make (mulligan, play, target…). */
export interface DecisionPointSpec {
  readonly id: string;
  readonly description: string;
}

/** One seating arrangement: seatOf[botIndex] = the PlayerId that bot occupies. */
export type SeatingPermutation = readonly PlayerId[];

export interface GameSpec {
  readonly gameId: string;
  readonly playerCount: number;
  /** Team partition, when the game is team-based. Omit for free-for-all. */
  readonly teams?: ReadonlyArray<readonly PlayerId[]>;
  readonly decisionPoints: readonly DecisionPointSpec[];
  /**
   * Seat permutations evaluated per game seed so position bias cancels out in
   * paired statistics. Must contain at least 2 permutations covering every seat
   * for the candidate (index 0) — e.g. 2-player: [[0,1],[1,0]].
   */
  readonly seatingPlan: readonly SeatingPermutation[];
  /**
   * Declare true for perfect-information games (chess-like): the C3
   * hidden-information axis then passes as not-applicable instead of requiring
   * a hiddenInfoProbe. Games with any hidden state must omit this and ship a
   * probe. Note that perfect-information games with a fixed initial position
   * must still inject per-seed opening diversity (see docs/ONBOARDING-GUIDE.md
   * §5), or the seed-diversity conformance check will block them.
   */
  readonly perfectInformation?: boolean;
  /** Hard cap on decisions per game; exceeding it is an adapter defect. */
  readonly maxDecisionsPerGame: number;
  /**
   * Declare 'none' for games with no meaningful score margin (win/loss is the
   * only signal — e.g. gomoku, Avalon, race games). Declare 'scored' (default
   * when omitted, for backward compatibility) when score differences carry
   * real information.
   */
  readonly scoreMargin?: 'none' | 'scored';
  /**
   * Absorbed from OpenSpiel's GameType.utility. 'zero-sum' means one player's
   * gain is exactly another's loss (classic minimax); 'general' covers
   * general-sum and cooperative payoff structures. Feeds classifyGame and any
   * CFR-style learning algorithm's convergence-guarantee decision. Omitted is
   * treated as 'general' — a conservative default, since assuming zero-sum
   * without a declaration would falsely promise convergence guarantees.
   */
  readonly utility?: 'zero-sum' | 'general';
  /**
   * Declare true for games where teams exist (winners always come out as a
   * subset tied to a hidden faction) but faction membership itself is hidden
   * during play, so it cannot be statically declared via `teams` (Avalon-like
   * games; docs/GAP-ANALYSIS-3.md F4, docs/GAP-ANALYSIS-10.md M1). `teams`
   * must stay unset in this case — it is reserved for fixed, public team
   * partitions. When true, the C5 identity-fairness check (scoreC5) stops
   * comparing measured self-play win rate against 1/playerCount (which has no
   * relationship to hidden faction sizes) and instead treats the measured
   * rate as its own reference point, while still running the seat-bias check.
   */
  readonly hiddenTeamStructure?: boolean;
  /**
   * Declare true for cooperative games where every player is on a single team
   * playing against the game itself (Pandemic-like games; rule-driven
   * difficulty, not an opposing player/faction; docs/GAP-ANALYSIS-10.md M2).
   * `teams` must stay unset in this case too — the same reasoning as
   * `hiddenTeamStructure` applies: `teams` is reserved for fixed, public
   * partitions of *multiple* teams, and "everyone is one team" is not that.
   * The "random self-play win rate ≈ 1/playerCount (or 1/teamCount)" fairness
   * premise behind the C5 identity check does not hold here either — with a
   * single team, identityCenter would compute to 1/1 = 1.0, but a
   * rule-difficulty-driven cooperative game commonly has a random-policy team
   * win rate designed to be low (e.g. 20%) by construction, unrelated to any
   * 1/N expectation. When true, scoreC5 skips the C5_IDENTITY_NOT_FAIR
   * comparison the same way it does for hiddenTeamStructure, while still
   * running the seat-bias check.
   */
  readonly cooperativeStructure?: boolean;
}

export interface PendingDecision {
  readonly player: PlayerId;
  readonly decisionPoint: string; // DecisionPointSpec.id
}

export interface Outcome {
  /** Composite score per player (higher is better). Team games repeat the team score. */
  readonly scores: readonly number[];
  /** Winning players (all members of the winning team, or ties listed together). */
  readonly winners: readonly PlayerId[];
}

/**
 * The single bot interface. `decide` must be deterministic given the bot's own
 * seeded RNG plus its inputs, and must return one element of `legal`.
 */
export interface GameBot<TObservation, TChoice> {
  readonly id: string;
  decide(
    decisionPoint: string,
    observation: TObservation,
    legal: readonly TChoice[],
  ): TChoice;
}

export type BotFactory<TObservation, TChoice> = (
  seed: number,
) => GameBot<TObservation, TChoice>;

/**
 * A named strategy flag: given a base bot factory, produce a variant factory.
 * This is the candidate-injection surface the loop engine experiments over.
 */
export interface StrategyFlagSpec<TObservation, TChoice> {
  readonly flag: string;
  readonly description: string;
  readonly apply: (
    base: BotFactory<TObservation, TChoice>,
  ) => BotFactory<TObservation, TChoice>;
}

/** Probe used by the C3 hidden-information axis: mutate what `viewer` must not see. */
export interface HiddenInfoProbe<TState> {
  /**
   * Return a state whose viewer-hidden information differs from `state`
   * (e.g. reshuffled opponent hand). Return null when the state currently has
   * no hidden information for this viewer.
   */
  mutateHidden(state: TState, viewer: PlayerId, rng: Rng): TState | null;
}

/** Replay captured from the real game, used by the C7 parity axis. */
export interface ReplayFixture {
  readonly id: string;
  readonly seed: number;
  /** Encoded choice keys in play order (must match adapter.encodeChoice output). */
  readonly choiceKeys: readonly string[];
  /** Expected final scores, matching Outcome.scores. */
  readonly finalScores: readonly number[];
  /**
   * Where this fixture came from. 'original-replay' = captured from the real
   * game (human play or the original engine's own replay). 'self-play' =
   * generated by the adapter replaying itself (proves reproducibility, not
   * parity with the original game). Omitted is treated as 'self-play' for
   * scoring purposes — parity credit must be earned explicitly.
   */
  readonly provenance?: 'original-replay' | 'self-play';
}

/**
 * The full adapter contract. Implementing this — and passing the conformance
 * gate — is what "onboarding a game" produces.
 */
export interface GameAdapter<TState, TObservation, TChoice> {
  readonly spec: GameSpec;

  createInitialState(seed: number): TState;
  /** Whose turn to decide what; null when the game is over. */
  currentDecision(state: TState): PendingDecision | null;
  /** The only channel through which bots see the game. Must hide hidden info. */
  getObservation(state: TState, player: PlayerId): TObservation;
  /** Legal choices for the current pending decision. Non-empty until terminal. */
  getLegalChoices(state: TState): readonly TChoice[];
  /** Pure transition. Must throw on a choice not in getLegalChoices(state). */
  applyChoice(state: TState, choice: TChoice): TState;
  /** Non-null exactly when currentDecision(state) is null. */
  getOutcome(state: TState): Outcome | null;
  /** Stable string key for a choice (logging, dedup, trajectory comparison). */
  encodeChoice(choice: TChoice): string;

  /** Game-specific invariants; return an error message or null. Checked during playouts. */
  readonly invariants?: ReadonlyArray<(state: TState) => string | null>;
  /**
   * Content inventory for content-heavy games (unique cards, bird powers, …).
   * Declaring it lets the conformance battery measure playout content
   * coverage: random playouts only exercise what happens to be drawn, so
   * without this, half-broken content can pass C2 unnoticed
   * (docs/GAP-ANALYSIS-2.md X2). Pair with `exercisedContent`.
   */
  readonly contentInventory?: ReadonlyArray<{
    readonly id: string;
    readonly description: string;
  }>;
  /**
   * Which contentInventory ids were actually exercised (drawn/triggered/used)
   * over the course of a finished game. Required when contentInventory is
   * declared; the battery aggregates this across playouts into a coverage
   * report with an uncovered-content list.
   */
  readonly exercisedContent?: (finalState: TState) => readonly string[];
  /** Required for the C3 hidden-information axis to score above zero. */
  readonly hiddenInfoProbe?: HiddenInfoProbe<TState>;
  /** Required for the C7 parity axis to score above zero. */
  readonly replayFixtures?: readonly ReplayFixture[];

  /**
   * Absorbed from OpenSpiel's information_state_string: a stable key for the
   * player's information set, used by CFR-family learning algorithms. When
   * omitted, the learning module falls back to digest(decisionPoint +
   * canonical observation) — that fallback does NOT guarantee perfect recall
   * (it can collide information sets that a true information-state key would
   * keep distinct), so declaring this explicitly is required for sound CFR.
   */
  informationStateKey?(state: TState, player: PlayerId): string;
  /**
   * Full-information-only: reconstruct the entire game state from a single
   * player's observation. This is the channel a search bot (MCTS) uses to
   * obtain a simulation root from its own observation. It does not weaken the
   * bot contract — bots still only ever see observations, never states — but
   * a hidden-information game cannot losslessly reconstruct full state from
   * one player's observation by definition, so implementing this method on a
   * hidden-information adapter is a contract violation, not a valid choice:
   * only games with spec.perfectInformation === true may declare it.
   */
  reconstructState?(observation: TObservation): TState;
  /**
   * Determinization hook for IS-MCTS (Cowling, Powley & Whitehouse 2012,
   * "Information Set Monte Carlo Tree Search"; docs/FIX-BACKLOG.md P4,
   * docs/GAP-ANALYSIS-7.md §2's previously-deferred "IS-MCTS + 결정화" item).
   * Hidden-information games cannot losslessly reconstruct a full state from
   * one player's observation (that is exactly what makes them hidden-info —
   * see `reconstructState`'s doc comment), so a search bot for such a game
   * instead samples one *plausible* full state consistent with everything
   * `player` actually knows: implementations must return a state whose
   * `getObservation(returned, player)` reproduces the caller's `observation`
   * exactly (own hand, public zones, counts, revealed info — anything the
   * viewer already sees) and must only use `rng` to fill in the parts the
   * viewer does NOT see (opponent hands, shuffled deck order, …), resampled
   * without contradicting what is known (e.g. respecting revealed-card
   * counts). This does not weaken the bot contract — bots still only ever
   * see observations, never states — this hook exists purely for the search
   * harness (IS-MCTS, `src/search/ismcts.ts`) to build a simulation root; a
   * regular `GameBot` never calls it and never receives a sampled state.
   */
  sampleStateFromObservation?(observation: TObservation, player: PlayerId, rng: Rng): TState;

  /** Baseline ecosystem — mandatory for calibration and the ladder floor. */
  readonly baselines: {
    readonly random: BotFactory<TObservation, TChoice>;
    readonly heuristic: BotFactory<TObservation, TChoice>;
  };
  /** Candidate-injection surface for the loop engine. */
  readonly strategySurface: ReadonlyArray<
    StrategyFlagSpec<TObservation, TChoice>
  >;
}

/**
 * Type-erased view used by kernel/loop code that never inspects states,
 * observations, or choices structurally.
 */
export type AnyGameAdapter = GameAdapter<unknown, unknown, unknown>;
export type AnyBotFactory = BotFactory<unknown, unknown>;
