import type { Rng } from '../contract/types';

/**
 * Deterministic RNG (Mulberry32). The only randomness source permitted inside
 * adapters, bots, and the kernel — Date.now()/Math.random() are banned by the
 * determinism rule (conformance axis C1).
 */

function hashLabel(label: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    nextInt(bound: number): number {
      if (!Number.isSafeInteger(bound) || bound <= 0) {
        throw new Error(`nextInt bound must be a positive safe integer: ${bound}`);
      }
      return Math.floor(next() * bound);
    },
    fork(label: string): Rng {
      return createRng((state ^ hashLabel(label)) >>> 0);
    },
  };
}

/** Deterministic Fisher-Yates shuffle (returns a new array). */
export function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = rng.nextInt(index + 1);
    const held = result[index] as T;
    result[index] = result[swap] as T;
    result[swap] = held;
  }
  return result;
}
