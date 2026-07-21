/**
 * Type-erase a concrete GameAdapter into the AnyGameAdapter view consumed by
 * the kernel/loop layer (contract/types.ts's own doc comment on
 * AnyGameAdapter: "used by kernel/loop code that never inspects states,
 * observations, or choices structurally"). The cast is safe in practice
 * because loop code only ever re-passes values a given adapter produced
 * itself (createInitialState/applyChoice output fed back into
 * getObservation/getLegalChoices/etc. of that same adapter) — it never
 * fabricates a foreign "unknown" value to hand to an adapter method.
 */

import type { AnyGameAdapter, GameAdapter } from '../contract/types';

export function eraseAdapter<TState, TObservation, TChoice>(
  adapter: GameAdapter<TState, TObservation, TChoice>,
): AnyGameAdapter {
  return adapter as unknown as AnyGameAdapter;
}
