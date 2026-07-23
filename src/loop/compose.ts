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
