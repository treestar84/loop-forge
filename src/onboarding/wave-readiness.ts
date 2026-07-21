/**
 * Shared gate between G-Score conformance scoring and wave execution
 * (DESIGN.md §4). Every non-C7 axis blocking is a real adapter defect —
 * stop. A C7-only cap (self-play replayFixtures, no
 * provenance:'original-replay' evidence) means game logic is sound but
 * parity with the source game is unproven; that caveat should be surfaced
 * loudly but does not block wave execution.
 */

import type { AxisResult, ConformanceReport } from './report';

export interface WaveReadinessDecision {
  readonly proceed: boolean;
  readonly blockingAxes: readonly AxisResult[];
  readonly warnings: readonly string[];
}

export function evaluateWaveReadiness(conformance: ConformanceReport): WaveReadinessDecision {
  const blockingAxes = conformance.axes.filter(
    (axis) => axis.axis !== 'C7-parity' && axis.blockers.length > 0,
  );
  if (blockingAxes.length > 0) {
    return { proceed: false, blockingAxes, warnings: [] };
  }
  const warnings =
    conformance.ready === false
      ? [
          "conformance not ready (C7-parity capped — no provenance:'original-replay' fixtures). " +
            'Proceeding to wave execution anyway: game-logic axes (C0-C6) all pass, only parity-with-source is unproven.',
        ]
      : [];
  return { proceed: true, blockingAxes: [], warnings };
}
