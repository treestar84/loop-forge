import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadOrCreateLedger,
  loadOrCreateRegistry,
  saveLedger,
  saveRegistry,
} from '../game-state';
import { BaselineRegistry } from '../baseline-registry';
import { AdoptionLedger } from '../adoption-ledger';

describe('game-state persistence', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'loop-forge-game-state-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('loadOrCreateRegistry returns a fresh empty registry when no file exists', () => {
    const registry = loadOrCreateRegistry(rootDir, 'gomoku');
    expect(registry.latest()).toBeUndefined();
    expect(registry.listAnchors()).toEqual([]);
  });

  it('loadOrCreateLedger returns a fresh empty ledger when no file exists', () => {
    const ledger = loadOrCreateLedger(rootDir, 'gomoku');
    expect(ledger.all()).toEqual([]);
  });

  it('round-trips a registry through save/loadOrCreate', () => {
    const registry = new BaselineRegistry();
    registry.register({
      version: 'v1',
      flags: [],
      parent: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceWaveId: null,
      notes: 'pristine baseline',
    });
    registry.registerAnchor({ anchorId: 'anchor-random', kind: 'random' });

    saveRegistry(rootDir, 'gomoku', registry);
    const reloaded = loadOrCreateRegistry(rootDir, 'gomoku');

    expect(reloaded.get('v1')).toEqual(registry.get('v1'));
    expect(reloaded.listAnchors()).toEqual(registry.listAnchors());
  });

  it('round-trips a ledger through save/loadOrCreate', () => {
    const ledger = new AdoptionLedger();
    ledger.add({
      waveId: 'wave-1',
      recordedAt: '2026-01-01T00:00:00.000Z',
      comparabilityKey: 'key-1',
      baselineVersion: 'v1',
      opponentId: 'heuristic',
      entries: [
        {
          flags: ['blockImmediateThreat'],
          verdict: 'adopted',
          tierStats: {
            holdout: { pointWinRate: 0.6, pointScoreDiff: 0.2, blocks: 10 },
          },
        },
      ],
      nextLoopNotes: ['note'],
    });

    saveLedger(rootDir, 'gomoku', ledger);
    const reloaded = loadOrCreateLedger(rootDir, 'gomoku');

    expect(reloaded.all()).toEqual(ledger.all());
  });
});
