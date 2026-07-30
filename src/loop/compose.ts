import type { AnyBotFactory, AnyGameAdapter, StrategyFlagSpec } from '../contract/types';

/**
 * Compose a bot factory by starting at `adapter.baselines.heuristic` and
 * applying each named flag's `apply` from `adapter.strategySurface` in
 * order. Composing with an empty `flags` array returns the raw heuristic
 * bot untouched. Throws on any flag not present in strategySurface — an
 * unknown flag is a programming error, never a "no candidate" signal.
 *
 * Lives in the loop layer (not artifacts) because the wave runner composes
 * candidate bots — artifacts sits above loop and re-exports this for its
 * baseline-registry consumers.
 */
export function composeBot(adapter: AnyGameAdapter, flags: readonly string[]): AnyBotFactory {
  let factory: AnyBotFactory = adapter.baselines.heuristic;
  for (const flag of flags) {
    const spec = adapter.strategySurface.find((candidate) => candidate.flag === flag);
    if (!spec) {
      throw new Error(`composeBot: unknown strategy flag "${flag}"`);
    }
    factory = spec.apply(factory);
  }
  return factory;
}

/**
 * Return a new adapter whose strategySurface is the original's plus
 * `extraFlags`, leaving the original adapter untouched. This is the injection
 * point a runner (app boundary) uses to add search/learn bot candidates
 * (MCTS, CFR, …) to a wave without editing the adapter's own source — the
 * search/learn modules are reference-layer-adjacent tooling that only a
 * runner imports, never the adapter itself. Throws if any extraFlags entry
 * reuses a flag name already present on the adapter, since a silent name
 * collision would make composeBot resolve to the wrong candidate.
 */
export function withStrategyFlags(
  adapter: AnyGameAdapter,
  extraFlags: ReadonlyArray<StrategyFlagSpec<unknown, unknown>>,
): AnyGameAdapter {
  const existingFlags = new Set(adapter.strategySurface.map((spec) => spec.flag));
  for (const extra of extraFlags) {
    if (existingFlags.has(extra.flag)) {
      throw new Error(`withStrategyFlags: flag "${extra.flag}" already exists on adapter.strategySurface`);
    }
  }
  return {
    ...adapter,
    strategySurface: [...adapter.strategySurface, ...extraFlags],
  };
}

/** ADR-0014: static check of a flags array's assembly semantics, purely from the
 * `assembly` metadata declared on adapter.strategySurface (never inspects apply). */
export interface AssemblyAnalysis {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Inspect `flags` against `adapter.strategySurface`'s declared `assembly` kind
 * (undeclared = 'unknown'). Flags not found on strategySurface are ignored
 * here — composeBot is the one that throws on an unknown flag name, not this
 * function's job to pre-empt that. Errors: 2+ declared terminals in `flags`,
 * or exactly 1 declared terminal that is not flags[0] (every decorator ahead
 * of it would be silently discarded by composeBot's sequential apply chain).
 * Warnings: any 'unknown' flag present, since its assembly kind can't be
 * verified.
 */
export function analyzeAssembly(adapter: AnyGameAdapter, flags: readonly string[]): AssemblyAnalysis {
  const errors: string[] = [];
  const warnings: string[] = [];
  const terminals: string[] = [];
  let hasUnknown = false;

  for (const flag of flags) {
    const spec = adapter.strategySurface.find((candidate) => candidate.flag === flag);
    if (!spec) {
      continue;
    }
    const assembly = spec.assembly ?? 'unknown';
    if (assembly === 'terminal') {
      terminals.push(flag);
    } else if (assembly === 'unknown') {
      hasUnknown = true;
    }
  }

  if (terminals.length >= 2) {
    errors.push(`복수 터미널 ${terminals.join(', ')} — 뒤의 것만 생존`);
  } else if (terminals.length === 1 && flags[0] !== terminals[0]) {
    errors.push(`터미널 ${terminals[0]}가 배열 첫 항목이 아님 — 앞의 데코레이터가 전부 소실`);
  }

  if (hasUnknown) {
    warnings.push('assembly 조립 판단이 불가능한 unknown 플래그가 있음');
  }

  return { errors, warnings };
}

/**
 * composeBot, guarded by analyzeAssembly: throws when the flags array has an
 * assembly error (composeBot itself is never touched — see this module's
 * doc comment on composeBot for the byte-for-byte reproduction guarantee).
 * All new round promotion code should call this instead of composeBot.
 */
export function composeBotChecked(adapter: AnyGameAdapter, flags: readonly string[]): AnyBotFactory {
  const analysis = analyzeAssembly(adapter, flags);
  if (analysis.errors.length > 0) {
    throw new Error(`composeBotChecked: ${analysis.errors.join('; ')}`);
  }
  return composeBot(adapter, flags);
}

export interface AssembleFlagsCandidate {
  readonly flag: string;
  readonly assembly?: 'decorator' | 'terminal';
  readonly challengeScore?: number;
}

export interface AssembleFlagsResult {
  readonly flags: readonly string[];
  readonly excluded: readonly { readonly flag: string; readonly reason: string }[];
}

/**
 * Assemble a promotion round's flags array from `candidates` (the prior
 * champion's surviving flags plus this round's newly adopted flags, in
 * adoption order). When multiple candidates declare assembly==='terminal',
 * only the one with the highest challengeScore survives (ties keep input
 * order; a missing challengeScore sorts lowest) — terminals cannot be
 * demoted to decorators (they ignore `base` by construction), so the losers
 * are excluded outright, not reordered. Final order: the surviving terminal
 * first (if any), then every non-terminal candidate in input order.
 */
export function assembleFlags(candidates: readonly AssembleFlagsCandidate[]): AssembleFlagsResult {
  const terminals = candidates.filter((candidate) => candidate.assembly === 'terminal');
  const decorators = candidates.filter((candidate) => candidate.assembly !== 'terminal');
  const excluded: { readonly flag: string; readonly reason: string }[] = [];

  let survivingTerminal: AssembleFlagsCandidate | undefined;
  if (terminals.length > 0) {
    const ranked = [...terminals].sort((a, b) => {
      const scoreA = a.challengeScore ?? Number.NEGATIVE_INFINITY;
      const scoreB = b.challengeScore ?? Number.NEGATIVE_INFINITY;
      return scoreB - scoreA;
    });
    survivingTerminal = ranked[0];
    for (const terminal of terminals) {
      if (terminal === survivingTerminal) {
        continue;
      }
      excluded.push({
        flag: terminal.flag,
        reason: `이번 라운드에 더 높은 challenge 성적의 터미널 ${survivingTerminal?.flag}로 대체됨`,
      });
    }
  }

  const flags = survivingTerminal
    ? [survivingTerminal.flag, ...decorators.map((candidate) => candidate.flag)]
    : decorators.map((candidate) => candidate.flag);

  return { flags, excluded };
}
