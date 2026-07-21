import { SeedLedger } from '../../kernel/seed-ledger';
import type { PromotionCriteria } from '../../kernel/gates';
import { miniTrickAdapter } from '../../reference/mini-trick';
import { eraseAdapter } from '../erase';
import { runWave, type WaveConfig } from '../wave-runner';

const adapter = eraseAdapter(miniTrickAdapter);

// mini-trick scores range 0-6 (six tricks total), so kernel/gates'
// DEFAULT_CRITERIA (minScoreDiff: 5, tuned for a larger-magnitude game) would
// reject every realistic candidate here. Use criteria scaled to this game.
const MINI_TRICK_CRITERIA: PromotionCriteria = { minWinRate: 0.53, minScoreDiff: 0.3 };

function makeLedger() {
  const ledger = new SeedLedger();
  ledger.reserve({
    bankId: 'smoke-test',
    range: { start: 1000, end: 1079 },
    purpose: 'smoke',
    reservedAt: '2026-01-01T00:00:00.000Z',
  });
  ledger.reserve({
    bankId: 'prune-test',
    range: { start: 2000, end: 2079 },
    purpose: 'prune',
    reservedAt: '2026-01-01T00:00:00.000Z',
  });
  ledger.reserve({
    bankId: 'holdout-test',
    range: { start: 3000, end: 3079 },
    purpose: 'holdout',
    reservedAt: '2026-01-01T00:00:00.000Z',
  });
  return ledger;
}

function baseWaveConfig(ledger: SeedLedger): WaveConfig {
  return {
    waveId: 'test-wave-1',
    candidates: [{ flag: 'winCheapest' }, { flag: 'noopSort' }, { flag: 'leadHighFirst' }],
    opponent: 'heuristic',
    ledger,
    tiers: {
      smoke: {
        bankId: 'smoke-test',
        sprt: { p0: 0.5, p1: 0.58, alpha: 0.05, beta: 0.05 },
        maxBlocks: 80,
        minBlocks: 10,
      },
      prune: { bankId: 'prune-test', blocks: 80 },
      holdout: { bankId: 'holdout-test', blocks: 80 },
    },
    criteria: MINI_TRICK_CRITERIA,
    // Seeds 1-5 happen to never expose winCheapest's cheapest-winning-card
    // decision on this base bot (small-sample luck of the shuffle), so use a
    // probe set independently confirmed to make winCheapest diverge from the
    // base heuristic bot's trajectory.
    screenProbe: { seeds: [7, 11, 12, 13, 42], botSeedBase: 500 },
  };
}

describe('runWave', () => {
  it('screens out noopSort as a behavioral no-op before spending any smoke games', () => {
    const ledger = makeLedger();
    const report = runWave(adapter, baseWaveConfig(ledger));
    const noop = report.results.find((r) => r.flag === 'noopSort');
    expect(noop).toBeDefined();
    expect(noop?.tiersPassed).toEqual([]);
    expect(noop?.stats.smoke).toBeUndefined();
  });

  it('carries winCheapest (a real improvement) through smoke, prune, and holdout to adoption', () => {
    const ledger = makeLedger();
    const report = runWave(adapter, baseWaveConfig(ledger));
    const winCheapest = report.results.find((r) => r.flag === 'winCheapest');
    expect(winCheapest).toBeDefined();
    expect(winCheapest?.tiersPassed).toEqual(['screen', 'smoke', 'prune', 'holdout']);
    expect(winCheapest?.verdict).toBe('adopted');
  });

  it('reports seed consumption and a stable digest', () => {
    const ledger = makeLedger();
    const report = runWave(adapter, baseWaveConfig(ledger));
    expect(report.seedConsumption).toEqual(['smoke-test', 'prune-test', 'holdout-test']);
    expect(report.reportDigest).toMatch(/^sha256-[0-9a-f]{64}$/);

    const secondLedger = makeLedger();
    const secondReport = runWave(adapter, baseWaveConfig(secondLedger));
    expect(secondReport.reportDigest).toBe(report.reportDigest);
  });

  it('every candidate result carries a flag matching an input candidate', () => {
    const ledger = makeLedger();
    const report = runWave(adapter, baseWaveConfig(ledger));
    const flags = report.results.map((r) => r.flag).sort();
    expect(flags).toEqual(['leadHighFirst', 'noopSort', 'winCheapest']);
  });
});
