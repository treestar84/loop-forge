import { SeedLedger } from '../../kernel/seed-ledger';
import { DEFAULT_CRITERIA } from '../../kernel/gates';
import { miniTrickAdapter } from '../../reference/mini-trick';
import { eraseAdapter } from '../erase';
import { assembleWaveConfig } from '../assemble-wave-config';
import type { WaveScreenProbeConfig } from '../wave-runner';

const winLossAdapter = eraseAdapter({
  ...miniTrickAdapter,
  spec: { ...miniTrickAdapter.spec, scoreMargin: 'none' as const },
});

function makeLedger(): SeedLedger {
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

const screenProbe: WaveScreenProbeConfig = { seeds: [7, 11, 12, 13, 42], botSeedBase: 500 };

function requiredInput(ledger: SeedLedger) {
  return {
    waveId: 'test-wave',
    candidates: [{ flag: 'winCheapest' }],
    opponent: 'heuristic' as const,
    ledger,
    recordedAt: '2026-01-01T00:00:00.000Z',
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
    screenProbe,
  };
}

describe('assembleWaveConfig', () => {
  it('derives criteria.minScoreDiff===0 for a win-loss-only game (scoreMargin: none)', () => {
    const config = assembleWaveConfig(winLossAdapter, requiredInput(makeLedger()));
    expect(config.criteria.minScoreDiff).toBe(0);
    expect(config.criteria.minWinRate).toBe(DEFAULT_CRITERIA.minWinRate);
    expect(config.signalCollapseThreshold).toBe(0.8);
  });

  it('lets an explicit criteria override take priority over the blueprint-derived value', () => {
    const config = assembleWaveConfig(winLossAdapter, requiredInput(makeLedger()), undefined, {
      criteria: { minWinRate: 0.6, minScoreDiff: 0.3 },
    });
    expect(config.criteria).toEqual({ minWinRate: 0.6, minScoreDiff: 0.3 });
  });

  it('lets an explicit signalCollapseThreshold override take priority', () => {
    const config = assembleWaveConfig(winLossAdapter, requiredInput(makeLedger()), undefined, {
      signalCollapseThreshold: 0.5,
    });
    expect(config.signalCollapseThreshold).toBe(0.5);
  });

  it('passes required fields through unchanged', () => {
    const ledger = makeLedger();
    const required = requiredInput(ledger);
    const config = assembleWaveConfig(winLossAdapter, required);
    expect(config.waveId).toBe(required.waveId);
    expect(config.candidates).toBe(required.candidates);
    expect(config.ledger).toBe(ledger);
    expect(config.tiers).toBe(required.tiers);
    expect(config.screenProbe).toBe(screenProbe);
  });
});
