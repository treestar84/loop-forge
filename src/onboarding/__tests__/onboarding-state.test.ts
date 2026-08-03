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
  it('labels a pre-adapter score as 추정(P-Score) and a post-scoring score as 실측(C-Score)', () => {
    const preAdapter = diagnosed('sample', 80);
    expect(renderStatusReport(preAdapter)).toContain('추정(P-Score)');

    const postAdapter = applyScore(applyScaffold(preAdapter, 0, true, T1), 0, true, 80, 0, T2);
    expect(renderStatusReport(postAdapter)).toContain('실측(C-Score)');
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
