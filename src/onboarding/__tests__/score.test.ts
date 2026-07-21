import { eraseAdapter } from '../../loop/erase';
import { miniTrickAdapter } from '../../reference/mini-trick';
import { scoreAdapter } from '../score';

const adapter = eraseAdapter(miniTrickAdapter);

describe('scoreAdapter — mini-trick (a conformant adapter)', () => {
  // mini-trick deliberately ships one no-op strategy flag (noopSort) to prove
  // the wave-runner/C6 no-op screen actually rejects no-ops — that caps C6 at
  // 2/3 distinct flags = 67. The default threshold (70) is tuned for adapters
  // without an intentional no-op demo flag, so this call uses a threshold
  // that reflects mini-trick's known ceiling.
  const report = scoreAdapter(adapter, { threshold: 65 });

  it('has zero blockers on every axis', () => {
    for (const axisResult of report.axes) {
      expect(axisResult.blockers).toEqual([]);
    }
  }, 20_000);

  it('is ready for loop execution', () => {
    expect(report.ready).toBe(true);
  }, 20_000);

  it('flags noopSort as the sole non-distinct strategy flag (C6)', () => {
    const c6 = report.axes.find((a) => a.axis === 'C6-strategy-surface');
    expect(c6?.score).toBe(67);
    expect(c6?.notes.some((note) => note.includes('noopSort'))).toBe(true);
  }, 20_000);
});

describe('scoreAdapter — a broken adapter without hiddenInfoProbe', () => {
  it('scores C3 as a 0-point blocker', () => {
    const { hiddenInfoProbe: _removed, ...withoutProbe } = miniTrickAdapter;
    const broken = eraseAdapter(withoutProbe);
    const report = scoreAdapter(broken, { threshold: 65 });
    const c3 = report.axes.find((a) => a.axis === 'C3-hidden-info');
    expect(c3?.score).toBe(0);
    expect(c3?.blockers.some((b) => b.code === 'C3_NO_PROBE')).toBe(true);
    expect(report.ready).toBe(false);
  });
});

describe('scoreAdapter — a broken adapter that leaks the opponent hand into observations', () => {
  it('scores C3 as a 0-point blocker for the observation leak', () => {
    const leakyAdapter = {
      ...miniTrickAdapter,
      getObservation(state: typeof miniTrickAdapter extends { createInitialState(seed: number): infer S }
        ? S
        : never, player: 0 | 1) {
        const base = miniTrickAdapter.getObservation(state, player);
        const opponent = player === 0 ? 1 : 0;
        return { ...base, opponentHandLeak: state.hands[opponent] };
      },
    };
    const broken = eraseAdapter(leakyAdapter);
    const report = scoreAdapter(broken, { threshold: 65 });
    const c3 = report.axes.find((a) => a.axis === 'C3-hidden-info');
    expect(c3?.score).toBe(0);
    expect(c3?.blockers.some((b) => b.code === 'C3_OBSERVATION_LEAK')).toBe(true);
    expect(report.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A2: spec.perfectInformation (C3 pass / contradiction)
// ---------------------------------------------------------------------------

describe('scoreAdapter — a perfect-information adapter (A2)', () => {
  it('passes C3 with a not-applicable note when perfectInformation is declared and hiddenInfoProbe is absent', () => {
    const { hiddenInfoProbe: _removed, ...withoutProbe } = miniTrickAdapter;
    const perfectInfoAdapter = {
      ...withoutProbe,
      spec: { ...miniTrickAdapter.spec, perfectInformation: true as const },
    };
    const broken = eraseAdapter(perfectInfoAdapter);
    const report = scoreAdapter(broken, { threshold: 65 });
    const c3 = report.axes.find((a) => a.axis === 'C3-hidden-info');
    expect(c3?.score).toBe(100);
    expect(c3?.blockers).toEqual([]);
    expect(c3?.notes.some((note) => note.includes('완전정보 게임'))).toBe(true);
  });

  it('scores C3 as a 0-point blocker when perfectInformation and hiddenInfoProbe contradict each other', () => {
    const contradictoryAdapter = {
      ...miniTrickAdapter,
      spec: { ...miniTrickAdapter.spec, perfectInformation: true as const },
    };
    const broken = eraseAdapter(contradictoryAdapter);
    const report = scoreAdapter(broken, { threshold: 65 });
    const c3 = report.axes.find((a) => a.axis === 'C3-hidden-info');
    expect(c3?.score).toBe(0);
    expect(c3?.blockers.some((b) => b.code === 'C3_PERFECT_INFO_CONTRADICTION')).toBe(true);
    expect(report.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A1: C1 seed-diversity check
// ---------------------------------------------------------------------------

describe('scoreAdapter — a fixed-opening adapter (A1 seed diversity)', () => {
  it('blocks C1 when every seed replays the same random self-play trajectory', () => {
    // Ignores the seed passed to createInitialState entirely — a stand-in for
    // a chess-like adapter with a fixed initial position and no seed-indexed
    // opening diversity.
    const fixedOpeningAdapter = {
      ...miniTrickAdapter,
      createInitialState: (_seed: number) => miniTrickAdapter.createInitialState(1),
    };
    const broken = eraseAdapter(fixedOpeningAdapter);
    const report = scoreAdapter(broken, { threshold: 65 });
    const c1 = report.axes.find((a) => a.axis === 'C1-determinism');
    expect(c1?.blockers.some((b) => b.code === 'C1_SEED_DIVERSITY')).toBe(true);
    expect(
      c1?.blockers.some((b) =>
        b.remediation.includes('시드-인덱스 오프닝 다양성'),
      ),
    ).toBe(true);
    expect(report.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A4: C4 decisions/sec reporting
// ---------------------------------------------------------------------------

describe('scoreAdapter — C4 throughput reporting (A4)', () => {
  it('reports both decisions/sec and games/sec, scoring on decisions/sec', () => {
    const report = scoreAdapter(adapter, { threshold: 65 });
    const c4 = report.axes.find((a) => a.axis === 'C4-throughput');
    expect(c4?.notes.some((note) => note.includes('decisions/sec'))).toBe(true);
    expect(c4?.notes.some((note) => note.includes('games/sec'))).toBe(true);
  }, 20_000);
});
