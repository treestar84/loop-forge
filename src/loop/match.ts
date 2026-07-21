/**
 * Match runner: executes one game on top of a GameAdapter.
 *
 * Invalid states (illegal choice, empty legal set, exceeding
 * spec.maxDecisionsPerGame, an invariant violation, or a bot throwing) are
 * classified as adapter/bot defects rather than game results — the caller
 * must not treat a defect as a loss/draw/win. Invariants are checked only at
 * the initial and final state (not every step) to protect playout throughput.
 */

import type {
  AnyBotFactory,
  AnyGameAdapter,
  Outcome,
  SeatingPermutation,
} from '../contract/types';

export type MatchDefectType =
  | 'illegal-choice'
  | 'empty-legal'
  | 'max-decisions-exceeded'
  | 'invariant-violation'
  | 'bot-error';

export interface MatchDefect {
  readonly type: MatchDefectType;
  readonly message: string;
  readonly atDecision: number;
}

export type MatchResult =
  | {
      readonly kind: 'completed';
      readonly outcome: Outcome;
      readonly choiceKeys: readonly string[];
      readonly decisions: number;
    }
  | {
      readonly kind: 'defect';
      readonly defect: MatchDefect;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkInvariants(adapter: AnyGameAdapter, state: unknown): string | null {
  for (const invariant of adapter.invariants ?? []) {
    const message = invariant(state);
    if (message !== null) {
      return message;
    }
  }
  return null;
}

/**
 * Run one game. `botFactories[i]` occupies the seat `seating[i]`; `botSeeds[i]`
 * is that bot's seed. Returns a `defect` result instead of throwing whenever
 * the adapter or a bot misbehaves, so callers can distinguish "candidate lost
 * a fair game" from "the harness cannot trust this game".
 */
export function runMatch(
  adapter: AnyGameAdapter,
  botFactories: readonly AnyBotFactory[],
  gameSeed: number,
  botSeeds: readonly number[],
  seating: SeatingPermutation,
): MatchResult {
  if (botFactories.length !== seating.length) {
    throw new Error(
      `runMatch: botFactories.length (${botFactories.length}) must equal seating.length (${seating.length})`,
    );
  }
  if (botSeeds.length !== botFactories.length) {
    throw new Error(
      `runMatch: botSeeds.length (${botSeeds.length}) must equal botFactories.length (${botFactories.length})`,
    );
  }

  const bots = botFactories.map((factory, index) => {
    const seed = botSeeds[index];
    if (seed === undefined) {
      throw new Error(`runMatch: missing botSeed at index ${index}`);
    }
    return factory(seed);
  });

  const seatToBotIndex = new Map<number, number>();
  seating.forEach((seat, botIndex) => {
    seatToBotIndex.set(seat, botIndex);
  });

  let state = adapter.createInitialState(gameSeed);

  const initialInvariantError = checkInvariants(adapter, state);
  if (initialInvariantError !== null) {
    return {
      kind: 'defect',
      defect: {
        type: 'invariant-violation',
        message: `initial state: ${initialInvariantError}`,
        atDecision: 0,
      },
    };
  }

  const choiceKeys: string[] = [];
  let decisions = 0;

  for (;;) {
    const decision = adapter.currentDecision(state);
    if (!decision) {
      break;
    }

    decisions += 1;
    if (decisions > adapter.spec.maxDecisionsPerGame) {
      return {
        kind: 'defect',
        defect: {
          type: 'max-decisions-exceeded',
          message: `exceeded maxDecisionsPerGame (${adapter.spec.maxDecisionsPerGame})`,
          atDecision: decisions,
        },
      };
    }

    const legal = adapter.getLegalChoices(state);
    if (legal.length === 0) {
      return {
        kind: 'defect',
        defect: {
          type: 'empty-legal',
          message: 'getLegalChoices returned an empty list for a non-terminal state',
          atDecision: decisions,
        },
      };
    }

    const botIndex = seatToBotIndex.get(decision.player);
    if (botIndex === undefined) {
      throw new Error(`runMatch: seating does not cover player ${decision.player}`);
    }
    const bot = bots[botIndex];
    if (!bot) {
      throw new Error(`runMatch: no bot at index ${botIndex}`);
    }

    const observation = adapter.getObservation(state, decision.player);

    let choice: unknown;
    try {
      choice = bot.decide(decision.decisionPoint, observation, legal);
    } catch (error) {
      return {
        kind: 'defect',
        defect: {
          type: 'bot-error',
          message: `bot "${bot.id}" threw during decide: ${errorMessage(error)}`,
          atDecision: decisions,
        },
      };
    }

    const legalKeys = new Set(legal.map((candidate) => adapter.encodeChoice(candidate)));
    const encoded = adapter.encodeChoice(choice);
    if (!legalKeys.has(encoded)) {
      return {
        kind: 'defect',
        defect: {
          type: 'illegal-choice',
          message: `bot "${bot.id}" chose "${encoded}", which is not in the legal set`,
          atDecision: decisions,
        },
      };
    }

    choiceKeys.push(encoded);

    try {
      state = adapter.applyChoice(state, choice);
    } catch (error) {
      return {
        kind: 'defect',
        defect: {
          type: 'illegal-choice',
          message: `applyChoice threw for a choice reported as legal: ${errorMessage(error)}`,
          atDecision: decisions,
        },
      };
    }
  }

  const finalInvariantError = checkInvariants(adapter, state);
  if (finalInvariantError !== null) {
    return {
      kind: 'defect',
      defect: {
        type: 'invariant-violation',
        message: `final state: ${finalInvariantError}`,
        atDecision: decisions,
      },
    };
  }

  const outcome = adapter.getOutcome(state);
  if (!outcome) {
    return {
      kind: 'defect',
      defect: {
        type: 'bot-error',
        message: 'currentDecision reported the game over but getOutcome returned null',
        atDecision: decisions,
      },
    };
  }

  return { kind: 'completed', outcome, choiceKeys, decisions };
}
