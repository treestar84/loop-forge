import type { AnyBotFactory, AnyGameAdapter } from '../contract/types';

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
