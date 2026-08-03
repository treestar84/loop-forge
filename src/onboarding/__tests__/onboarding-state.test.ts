/**
 * Unit tests for src/onboarding/onboarding-state.ts (docs/GAP-ANALYSIS-13.md
 * §3 S3). Pure functions only — no filesystem, no clock, no subprocess (the
 * app-boundary CLI in reference/runners/onboard-cli.ts owns all of that).
 */

import {
  applyDiagnosis,
  applyScaffold,
  applyScore,
  applyWave,
  computeEffectiveCScore,
  countOnboardTodoMarkers,
  renderStatusReport,
  type OnboardingState,
} from '../onboarding-state';

const T0 = '2026-08-03T00:00:00.000Z';
const T1 = '2026-08-03T00:01:00.000Z';
const T2 = '2026-08-03T00:02:00.000Z';
const T3 = '2026-08-03T00:03:00.000Z';

describe('applyDiagnosis', () => {
  it('produces verdict "impossible" and gate g0=fail when the P1 gate fails', () => {
    const state = applyDiagnosis('realtime-game', { verdict: 'impossible' }, T0);
    expect(state.verdict).toBe('impossible');
    expect(state.gates).toEqual({ g0: 'fail', g1: 'pending', g2: 'pending', g3: 'pending', g4: 'pending' });
    expect(state.stage).toBe('not-started');
    expect(state.score).toBeNull();
    expect(state.nextAction).toMatch(/RULEBOOK/);
  });

  it('passes g0 and g1 and sets a P-Score when the gate passes', () => {
    const state = applyDiagnosis('gomoku-like', { verdict: 'estimate', totalScore: 87 }, T0);
    expect(state.gates.g0).toBe('pass');
    expect(state.gates.g1).toBe('pass');
    expect(state.gates.g2).toBe('pending');
    expect(state.verdict).toBe('needs-implementation');
    expect(state.stage).toBe('diagnosed');
    expect(state.score).toEqual({ kind: 'P', value: 87 });
    expect(state.nextAction).toMatch(/scaffold/);
  });
});

function diagnosed(gameId: string, totalScore = 90): OnboardingState {
  return applyDiagnosis(gameId, { verdict: 'estimate', totalScore }, T0);
}

describe('applyScaffold', () => {
  it('throws if g1 has not passed', () => {
    const impossible = applyDiagnosis('excluded-game', { verdict: 'impossible' }, T0);
    expect(() => applyScaffold(impossible, 0, true, T1)).toThrow(/g1/);
  });

  it('passes g2 only when both the TODO marker count is 0 and tsc passed', () => {
    const prev = diagnosed('sample');
    const withTodos = applyScaffold(prev, 5, true, T1);
    expect(withTodos.gates.g2).toBe('fail');
    expect(withTodos.stage).toBe('diagnosed');

    const tscFails = applyScaffold(prev, 0, false, T1);
    expect(tscFails.gates.g2).toBe('fail');

    const clean = applyScaffold(prev, 0, true, T1);
    expect(clean.gates.g2).toBe('pass');
    expect(clean.stage).toBe('scaffolded');
    expect(clean.nextAction).toMatch(/score/);
  });

  it('preserves earlier gates and the P-Score set at diagnosis', () => {
    const prev = diagnosed('sample', 73);
    const state = applyScaffold(prev, 0, true, T1);
    expect(state.gates.g0).toBe('pass');
    expect(state.gates.g1).toBe('pass');
    expect(state.score).toEqual({ kind: 'P', value: 73 });
  });
});

describe('applyScore', () => {
  function scaffolded(gameId: string, todoCount = 0): OnboardingState {
    return applyScaffold(diagnosed(gameId), todoCount, true, T1);
  }

  it('throws if g1 has not passed (no validated profile yet)', () => {
    const impossible = applyDiagnosis('excluded-game', { verdict: 'impossible' }, T0);
    expect(() => applyScore(impossible, 0, true, 100, 0, T2)).toThrow(/g1/);
  });

  it('does NOT require g2 already "pass" — G-Score iterates during G-Convert', () => {
    // Freshly scaffolded, still full of TODO(onboard) markers (g2 fails at
    // scaffold time), but the score command itself re-measures g2 from a
    // fresh TODO count/tsc result rather than trusting the stale value.
    const prev = scaffolded('sample', 12);
    expect(prev.gates.g2).toBe('fail');
    expect(() => applyScore(prev, 12, true, 0, 8, T2)).not.toThrow();
  });

  it('re-measures and updates g2 from the caller-supplied todoCount/tscPassed', () => {
    const prev = scaffolded('sample', 12); // g2 fail at scaffold time
    const afterFilling = applyScore(prev, 0, true, 92, 0, T2); // agent has since filled every TODO
    expect(afterFilling.gates.g2).toBe('pass');
  });

  it('passes g3 and sets verdict "ready" with a C-Score when there are no non-parity blockers', () => {
    const prev = scaffolded('sample');
    const state = applyScore(prev, 0, true, 92, 0, T2);
    expect(state.gates.g3).toBe('pass');
    expect(state.verdict).toBe('ready');
    expect(state.stage).toBe('scored');
    expect(state.score).toEqual({ kind: 'C', value: 92 });
    expect(state.nextAction).toMatch(/wave/);
  });

  it('fails g3 and keeps verdict "needs-implementation" when a non-parity axis blocks', () => {
    const prev = scaffolded('sample');
    const state = applyScore(prev, 0, true, 40, 2, T2);
    expect(state.gates.g3).toBe('fail');
    expect(state.verdict).toBe('needs-implementation');
    expect(state.score).toEqual({ kind: 'C', value: 40 });
  });

  it('replaces the P-Score label with a C-Score label even if the numeric value is unchanged', () => {
    const prev = scaffolded('sample');
    const state = applyScore(prev, 0, true, 90, 0, T2);
    expect(state.score?.kind).toBe('C');
  });
});

describe('applyWave', () => {
  function scored(gameId: string): OnboardingState {
    return applyScore(applyScaffold(diagnosed(gameId), 0, true, T1), 0, true, 95, 0, T2);
  }

  it('throws if g3 has not passed', () => {
    const prev = applyScaffold(diagnosed('unscored'), 0, true, T1);
    expect(() => applyWave(prev, true, T3)).toThrow(/g3/);
  });

  it('passes g4 when the wave ran, regardless of adoption verdict (a failed wave still onboards)', () => {
    const prev = scored('sample');
    const state = applyWave(prev, true, T3);
    expect(state.gates.g4).toBe('pass');
    expect(state.stage).toBe('wave-ready');
    expect(state.nextAction).toMatch(/summary\.md/);
  });

  it('fails g4 when the wave did not run to completion', () => {
    const prev = scored('sample');
    const state = applyWave(prev, false, T3);
    expect(state.gates.g4).toBe('fail');
    expect(state.stage).toBe('scored');
  });
});

describe('countOnboardTodoMarkers', () => {
  it('counts zero markers in plain source', () => {
    expect(countOnboardTodoMarkers('function foo() { return 1; }').count).toBe(0);
  });

  it('counts every well-formed TODO(onboard) marker and captures its text', () => {
    const source = [
      "throw new Error('TODO(onboard): §2-1 — implement createInitialState');",
      "throw new Error('TODO(onboard): §2-4 — implement getObservation');",
    ].join('\n');
    const result = countOnboardTodoMarkers(source);
    expect(result.count).toBe(2);
    expect(result.markers[0]).toContain('§2-1');
    expect(result.markers[1]).toContain('§2-4');
  });

  it('does not match a TODO(onboard) marker missing the §<n>-<m> id', () => {
    const result = countOnboardTodoMarkers("// TODO(onboard): fix this later");
    expect(result.count).toBe(0);
  });
});

describe('renderStatusReport', () => {
  it('labels a pre-adapter score as 추정(P-Score) and a post-scoring score as 실측(C-Score, C7 제외)', () => {
    const preAdapter = diagnosed('sample', 80);
    expect(renderStatusReport(preAdapter)).toContain('추정(P-Score)');

    const postAdapter = applyScore(applyScaffold(preAdapter, 0, true, T1), 0, true, 80, 0, T2);
    expect(renderStatusReport(postAdapter)).toContain('실측(C-Score, C7 제외)');
  });

  it('includes every gate id and the next action text', () => {
    const state = diagnosed('sample');
    const report = renderStatusReport(state);
    for (const id of ['g0', 'g1', 'g2', 'g3', 'g4']) {
      expect(report).toContain(id);
    }
    expect(report).toContain(state.nextAction);
  });
});

describe('computeEffectiveCScore (docs/GAP-ANALYSIS-13.md §9 Phase E 결함 #1)', () => {
  // The exact scenario the fresh Phase E agent hit on connect-four: C0..C6
  // all score 100, C7-parity has a blocker because no replay fixtures were
  // captured yet (a normal, non-blocking state) — the screen showed
  // "적합도(실측, C-Score): 0%" while the same report's gate decision was
  // already "proceed to wave". overallScore (Math.min across every axis
  // including C7) would be 0 here; the effective score must be 100.
  const connectFourAxes = [
    { axis: 'C0-contract', score: 100, blockers: [] },
    { axis: 'C1-determinism', score: 100, blockers: [] },
    { axis: 'C2-integrity', score: 100, blockers: [] },
    { axis: 'C3-hidden-info', score: 100, blockers: [] },
    { axis: 'C4-throughput', score: 100, blockers: [] },
    { axis: 'C5-baselines', score: 100, blockers: [] },
    { axis: 'C6-strategy-surface', score: 100, blockers: [] },
    { axis: 'C7-parity', score: 0, blockers: [{ code: 'C7_NO_FIXTURES' }] },
  ];

  it('takes the minimum over C0..C6 only, ignoring the C7 blocker', () => {
    const { value } = computeEffectiveCScore(connectFourAxes);
    expect(value).toBe(100);
  });

  it('returns a C7 status note explaining the missing-fixtures cap without blocking onboarding', () => {
    const { c7Note } = computeEffectiveCScore(connectFourAxes);
    expect(c7Note).not.toBeNull();
    expect(c7Note).toContain('원본 리플레이');
    expect(c7Note).toContain('막지 않음');
  });

  it('returns null c7Note when C7 itself is fully passing (nothing to call out)', () => {
    const allPassing = connectFourAxes.map((axis) =>
      axis.axis === 'C7-parity' ? { axis: 'C7-parity', score: 100, blockers: [] } : axis,
    );
    expect(computeEffectiveCScore(allPassing).c7Note).toBeNull();
  });

  it('falls back to the min of every axis when C7-parity is absent from the report', () => {
    const withoutC7 = connectFourAxes.filter((axis) => axis.axis !== 'C7-parity');
    const { value, c7Note } = computeEffectiveCScore(withoutC7);
    expect(value).toBe(100);
    expect(c7Note).toBeNull();
  });

  it('applyScore + renderStatusReport surface the C7-excluded 100% score, the "C7 제외" label, and the warning line — never a contradictory 0%', () => {
    const { value, c7Note } = computeEffectiveCScore(connectFourAxes);
    const prev = applyScaffold(diagnosed('connect-four-clone'), 0, true, T1);
    const state = applyScore(prev, 0, true, value, 0, T2, c7Note);

    expect(state.gates.g3).toBe('pass');
    expect(state.verdict).toBe('ready');
    expect(state.score).toEqual({ kind: 'C', value: 100 });
    expect(state.c7Note).toBe(c7Note);

    const report = renderStatusReport(state);
    expect(report).toContain('100% (실측(C-Score, C7 제외))');
    expect(report).not.toContain('적합도: 0%');
    expect(report).toContain(c7Note as string);
  });
});
