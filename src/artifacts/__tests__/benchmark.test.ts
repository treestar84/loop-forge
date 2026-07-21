import { eraseAdapter } from '../../loop/erase';
import { miniTrickAdapter } from '../../reference/mini-trick';
import { BaselineRegistry, composeBot } from '../baseline-registry';
import { renderLadderMarkdown, runBenchmarkLadder } from '../benchmark';

const adapter = eraseAdapter(miniTrickAdapter);

describe('runBenchmarkLadder', () => {
  it('scores a subject against every registered anchor, in registration order', () => {
    const registry = new BaselineRegistry();
    registry.registerAnchor({ anchorId: 'random-anchor', kind: 'random' });
    registry.registerAnchor({ anchorId: 'heuristic-anchor', kind: 'heuristic' });

    const subject = composeBot(adapter, ['winCheapest']);
    const seeds = Array.from({ length: 20 }, (_, i) => 5000 + i);

    const result = runBenchmarkLadder(adapter, subject, registry.listAnchors(), registry, {
      seeds,
      botSeedBase: 60_000,
    });

    expect(result.rungs.map((r) => r.anchorId)).toEqual(['random-anchor', 'heuristic-anchor']);
    for (const rung of result.rungs) {
      expect(rung.blocks).toBe(seeds.length);
      expect(rung.pointWinRate).toBeGreaterThanOrEqual(0);
      expect(rung.pointWinRate).toBeLessThanOrEqual(1);
      expect(rung.winRateCI.lower).toBeLessThanOrEqual(rung.winRateCI.upper);
    }
    // winCheapest should beat random baseline decisively over these seeds.
    const vsRandom = result.rungs.find((r) => r.anchorId === 'random-anchor');
    expect(vsRandom?.pointWinRate).toBeGreaterThan(0.5);
  });

  it('is deterministic for the same adapter/subject/anchors/seed bank', () => {
    const registry = new BaselineRegistry();
    registry.registerAnchor({ anchorId: 'heuristic-anchor', kind: 'heuristic' });
    const subject = composeBot(adapter, ['leadHighFirst']);
    const bank = { seeds: [1, 2, 3, 4, 5], botSeedBase: 100 };

    const first = runBenchmarkLadder(adapter, subject, registry.listAnchors(), registry, bank);
    const second = runBenchmarkLadder(adapter, subject, registry.listAnchors(), registry, bank);
    expect(second).toEqual(first);
  });

  it('resolves a baseline-kind anchor through the registry', () => {
    const registry = new BaselineRegistry();
    registry.register({
      version: 'v1',
      flags: [],
      parent: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceWaveId: null,
      notes: 'pristine',
    });
    registry.registerAnchor({ anchorId: 'v1-anchor', kind: 'baseline', baselineVersion: 'v1' });
    const subject = composeBot(adapter, []);
    const result = runBenchmarkLadder(adapter, subject, registry.listAnchors(), registry, {
      seeds: [7, 8, 9],
      botSeedBase: 200,
    });
    // subject === anchor (both the pristine heuristic bot): win rate must be
    // the identity 0.5 the same way runPairedBlock cancels seat bias.
    expect(result.rungs[0]?.pointWinRate).toBeCloseTo(0.5, 10);
  });
});

describe('renderLadderMarkdown', () => {
  it('renders a Markdown table with one row per rung', () => {
    const registry = new BaselineRegistry();
    registry.registerAnchor({ anchorId: 'random-anchor', kind: 'random' });
    const subject = composeBot(adapter, ['winCheapest']);
    const result = runBenchmarkLadder(adapter, subject, registry.listAnchors(), registry, {
      seeds: [1, 2, 3],
      botSeedBase: 50,
    });
    const markdown = renderLadderMarkdown(result);
    expect(markdown).toContain('random-anchor');
    expect(markdown).toContain('| anchor | kind |');
  });
});
