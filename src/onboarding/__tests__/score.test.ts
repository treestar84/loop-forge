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
