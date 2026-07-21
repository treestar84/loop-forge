import { miniTrickAdapter } from '../../reference/mini-trick';
import { composeBot } from '../compose';
import { eraseAdapter } from '../erase';
import { runHeadToHead } from '../head-to-head';

const adapter = eraseAdapter(miniTrickAdapter);
const SEEDS = Array.from({ length: 80 }, (_, i) => 1000 + i);

describe('runHeadToHead', () => {
  it('reports candidateWinRate near 0.5 for an identity contrast (bot vs itself)', () => {
    const heuristic = adapter.baselines.heuristic;
    const result = runHeadToHead(adapter, heuristic, heuristic, SEEDS, 42);
    expect(result.blocks).toBe(SEEDS.length);
    expect(result.candidateWinRate).toBeGreaterThan(0.4);
    expect(result.candidateWinRate).toBeLessThan(0.6);
  });

  it('reports a win rate meaningfully off 0.5 for winCheapest vs the base heuristic', () => {
    // winCheapest (play the cheapest winning card when able) is a strictly
    // better line than the base heuristic (always play lowest rank) — same
    // skill-gap pairing wave-runner's tests use to confirm behavioral
    // divergence, so it should show up here as a real win-rate edge.
    const winCheapest = composeBot(adapter, ['winCheapest']);
    const heuristic = adapter.baselines.heuristic;
    const result = runHeadToHead(adapter, winCheapest, heuristic, SEEDS, 42);
    expect(result.blocks).toBe(SEEDS.length);
    expect(result.candidateWinRate).toBeGreaterThan(0.53);
    // CI should not straddle the identity value 0.5 for a real skill gap.
    expect(result.winRateCI.lower).toBeGreaterThan(0.5);
  });

  it('is deterministic: identical seeds + botSeedBase reproduce the identical result', () => {
    const winCheapest = composeBot(adapter, ['winCheapest']);
    const heuristic = adapter.baselines.heuristic;
    const first = runHeadToHead(adapter, winCheapest, heuristic, SEEDS, 7);
    const second = runHeadToHead(adapter, winCheapest, heuristic, SEEDS, 7);
    expect(second).toEqual(first);
  });
});
