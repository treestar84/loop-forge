import { evaluateWaveReadiness } from '../wave-readiness';
import type { AxisResult, ConformanceReport } from '../report';

function axis(overrides: Partial<AxisResult> & Pick<AxisResult, 'axis'>): AxisResult {
  return { score: 100, blockers: [], notes: [], ...overrides };
}

function report(axes: readonly AxisResult[], ready: boolean): ConformanceReport {
  return {
    gameId: 'test-game',
    axes,
    overallScore: Math.min(...axes.map((a) => a.score)),
    ready,
    threshold: 70,
  };
}

describe('evaluateWaveReadiness', () => {
  it('proceeds with a warning when only C7-parity is capped', () => {
    const conformance = report(
      [
        axis({ axis: 'C0-contract' }),
        axis({ axis: 'C1-determinism' }),
        axis({ axis: 'C7-parity', score: 50 }),
      ],
      false,
    );

    const decision = evaluateWaveReadiness(conformance);

    expect(decision.proceed).toBe(true);
    expect(decision.blockingAxes).toEqual([]);
    expect(decision.warnings.length).toBeGreaterThan(0);
  });

  it('blocks when a non-C7 axis has blockers', () => {
    const c0 = axis({
      axis: 'C0-contract',
      blockers: [{ code: 'X', message: 'bad', remediation: 'fix' }],
    });
    const conformance = report([c0, axis({ axis: 'C7-parity' })], false);

    const decision = evaluateWaveReadiness(conformance);

    expect(decision.proceed).toBe(false);
    expect(decision.blockingAxes).toEqual([c0]);
  });

  it('proceeds with no warnings when fully ready', () => {
    const conformance = report(
      [axis({ axis: 'C0-contract' }), axis({ axis: 'C7-parity' })],
      true,
    );

    const decision = evaluateWaveReadiness(conformance);

    expect(decision.proceed).toBe(true);
    expect(decision.blockingAxes).toEqual([]);
    expect(decision.warnings).toEqual([]);
  });
});
