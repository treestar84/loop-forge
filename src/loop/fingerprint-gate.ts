/**
 * Calibrated L3 holdout fingerprint gate (docs/adr/0015-calibrated-l3-fingerprint-gate.md).
 *
 * Gate 2 of the L3 holdout anchor ladder (see e.g.
 * reference/runners/wingspan-anchor-ladder.ts's runL3Gate) rejects an L3
 * candidate whose behavioral fingerprint is too close to the L2 anchor's —
 * an L3 that mostly mirrors L2 is not an independent judge. Historically that
 * closeness was a single fixed threshold (agreement < 70% required). ADR-0015
 * found a counterexample: wingspan's narrow per-turn action space (4 action
 * kinds, ~20 fixed birds) makes even independently-designed bots converge to
 * ~84% agreement — not because of design leakage, but because the game
 * itself has low fingerprint discriminating power. A fixed threshold cannot
 * tell "this game naturally has little room to disagree" apart from "this L3
 * silently copies L2", so the threshold must be calibrated per game against
 * that game's own natural agreement floor.
 *
 * This module holds only the pure decision function — computing the
 * "floor" (agreement between two bots whose independence is obvious, e.g.
 * plain heuristic vs L2) is the caller's job, since it requires running the
 * game (reference/runners/* is an app boundary; this file must not be).
 */

const FAST_PASS_THRESHOLD = 0.7;
const EXCESS_THRESHOLD = 0.5;

export interface FingerprintGateResult {
  /** Agreement rate between the L3 candidate and L2, over the probe protocol. */
  readonly agreement: number;
  /** Natural agreement floor for this game (independent bot pair, same protocol). */
  readonly floor: number;
  /** True iff the absolute fast-pass threshold alone already passed the gate. */
  readonly fastPass: boolean;
  /**
   * Normalized excess agreement above the floor: (agreement - floor) / (1 -
   * floor), clamped to 0 when floor >= agreement (trivial pass — L3 is
   * already at or below the independent-pair baseline). Always 0 when
   * fastPass is true (not computed/needed).
   */
  readonly excess: number;
  /** Overall gate verdict: true means the L3 candidate may be registered. */
  readonly pass: boolean;
}

/**
 * ADR-0015's two-stage calibrated verdict:
 *   1. Fast-pass (unchanged from the original fixed-threshold gate):
 *      agreement < 70% passes outright, no floor needed. Every pre-ADR-0015
 *      registration (gomoku 69.2%, splendor 49.8%, dominion, hearthstone)
 *      is reproduced exactly by this branch alone.
 *   2. Calibrated: only reached when agreement >= 70%. excess = (agreement -
 *      floor) / (1 - floor); passes iff excess < 0.5 — "L3 sits closer to an
 *      independent bot pair (floor) than to being the same bot (1.0)".
 *      floor >= agreement is a trivial pass (excess defined as 0): L3 is
 *      already at or below the independent-pair baseline, so it cannot be
 *      "too close to L2" by this measure.
 */
export function evaluateFingerprintGate(agreement: number, floor: number): FingerprintGateResult {
  if (agreement < FAST_PASS_THRESHOLD) {
    return { agreement, floor, fastPass: true, excess: 0, pass: true };
  }
  if (floor >= agreement) {
    return { agreement, floor, fastPass: false, excess: 0, pass: true };
  }
  const excess = (agreement - floor) / (1 - floor);
  return { agreement, floor, fastPass: false, excess, pass: excess < EXCESS_THRESHOLD };
}
