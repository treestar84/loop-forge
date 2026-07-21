import { miniTrickAdapter } from '../../reference/mini-trick';
import { eraseAdapter } from '../erase';
import { runPairedBlock } from '../paired-match';

const adapter = eraseAdapter(miniTrickAdapter);

describe('runPairedBlock', () => {
  it('cancels seat/first-move bias for an identical bot playing itself (winFraction 0.5)', () => {
    const result = runPairedBlock(adapter, adapter.baselines.heuristic, adapter.baselines.heuristic, 7, 100);
    expect('defect' in result).toBe(false);
    if (!('defect' in result)) {
      expect(result.candidateWinFraction).toBeCloseTo(0.5, 10);
      expect(result.candidateScoreDelta).toBeCloseTo(0, 10);
      expect(result.seed).toBe(7);
    }
  });

  it('is deterministic for the same seeds', () => {
    const first = runPairedBlock(adapter, adapter.baselines.random, adapter.baselines.heuristic, 12, 50);
    const second = runPairedBlock(adapter, adapter.baselines.random, adapter.baselines.heuristic, 12, 50);
    expect(second).toEqual(first);
  });

  it('propagates a defect instead of returning a PairedSeedOutcome', () => {
    const illegalBotFactory = () => ({
      id: 'illegal-bot',
      decide: () => ({ suit: 'A' as const, rank: 999 }),
    });
    const result = runPairedBlock(adapter, illegalBotFactory, adapter.baselines.random, 7, 100);
    expect('defect' in result).toBe(true);
  });
});
