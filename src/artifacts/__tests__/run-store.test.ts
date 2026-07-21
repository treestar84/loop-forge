import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeComparabilityKey, RunStore } from '../run-store';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'loop-forge-run-store-'));
}

describe('computeComparabilityKey', () => {
  it('is a stable digest of its 4-factor input', () => {
    const key = computeComparabilityKey({
      gameId: 'mini-trick',
      specDigest: 'sha256-abc',
      baselineVersion: 'v1',
      opponentId: 'heuristic',
      seedBankIds: ['smoke', 'prune', 'holdout'],
    });
    expect(key).toMatch(/^sha256-[0-9a-f]{64}$/);
    const again = computeComparabilityKey({
      gameId: 'mini-trick',
      specDigest: 'sha256-abc',
      baselineVersion: 'v1',
      opponentId: 'heuristic',
      seedBankIds: ['smoke', 'prune', 'holdout'],
    });
    expect(again).toBe(key);
  });

  it('changes when any of the 4 factors changes', () => {
    const base = {
      gameId: 'mini-trick',
      specDigest: 'sha256-abc',
      baselineVersion: 'v1',
      opponentId: 'heuristic',
      seedBankIds: ['smoke'],
    };
    const key = computeComparabilityKey(base);
    expect(computeComparabilityKey({ ...base, baselineVersion: 'v2' })).not.toBe(key);
    expect(computeComparabilityKey({ ...base, opponentId: 'random' })).not.toBe(key);
    expect(computeComparabilityKey({ ...base, seedBankIds: ['smoke', 'prune'] })).not.toBe(key);
  });
});

describe('RunStore', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('saves a run and reloads it with matching payload and markdown', () => {
    const store = new RunStore(root);
    store.saveRun({
      runId: 'run-1',
      kind: 'wave',
      recordedAt: '2026-01-01T00:00:00.000Z',
      comparabilityKey: 'sha256-abc',
      payload: { hello: 'world', n: 3 },
      markdown: '# Run 1\n',
    });

    const loaded = store.loadRun('run-1');
    expect(loaded.kind).toBe('wave');
    expect(loaded.comparabilityKey).toBe('sha256-abc');
    expect(loaded.payload).toEqual({ hello: 'world', n: 3 });
    expect(loaded.markdown).toBe('# Run 1\n');
  });

  it('writes svg files alongside the report', () => {
    const store = new RunStore(root);
    store.saveRun({
      runId: 'run-svg',
      kind: 'benchmark',
      recordedAt: '2026-01-01T00:00:00.000Z',
      comparabilityKey: 'sha256-abc',
      payload: {},
      markdown: '# Run\n',
      svg: [{ name: 'progression.svg', content: '<svg></svg>' }],
    });
    const content = readFileSync(join(root, 'runs', 'run-svg', 'progression.svg'), 'utf8');
    expect(content).toBe('<svg></svg>');
  });

  it('throws when saving a runId that already exists (append-only)', () => {
    const store = new RunStore(root);
    const input = {
      runId: 'dup',
      kind: 'conformance' as const,
      recordedAt: '2026-01-01T00:00:00.000Z',
      comparabilityKey: 'sha256-abc',
      payload: {},
      markdown: '# Run\n',
    };
    store.saveRun(input);
    expect(() => store.saveRun(input)).toThrow(/append-only/);
  });

  it('lists saved runs sorted by runId with summary fields', () => {
    const store = new RunStore(root);
    store.saveRun({
      runId: 'run-b',
      kind: 'calibration',
      recordedAt: '2026-01-02T00:00:00.000Z',
      comparabilityKey: 'sha256-b',
      payload: {},
      markdown: '# B\n',
    });
    store.saveRun({
      runId: 'run-a',
      kind: 'conformance',
      recordedAt: '2026-01-01T00:00:00.000Z',
      comparabilityKey: 'sha256-a',
      payload: {},
      markdown: '# A\n',
    });
    const runs = store.listRuns();
    expect(runs.map((r) => r.runId)).toEqual(['run-a', 'run-b']);
    expect(runs[0]).toEqual({
      runId: 'run-a',
      kind: 'conformance',
      recordedAt: '2026-01-01T00:00:00.000Z',
      comparabilityKey: 'sha256-a',
    });
  });

  it('detects tampering: mutating payload.json after save makes loadRun throw', () => {
    const store = new RunStore(root);
    store.saveRun({
      runId: 'run-tamper',
      kind: 'wave',
      recordedAt: '2026-01-01T00:00:00.000Z',
      comparabilityKey: 'sha256-abc',
      payload: { value: 1 },
      markdown: '# Run\n',
    });
    const payloadPath = join(root, 'runs', 'run-tamper', 'payload.json');
    const original = readFileSync(payloadPath, 'utf8');
    const tampered = original.replace('"value":1', '"value":2');
    expect(tampered).not.toBe(original);
    writeFileSync(payloadPath, tampered, 'utf8');

    expect(() => store.loadRun('run-tamper')).toThrow(/digest mismatch/);
  });

  it('rejects runIds containing path separators', () => {
    const store = new RunStore(root);
    expect(() =>
      store.saveRun({
        runId: '../escape',
        kind: 'wave',
        recordedAt: '2026-01-01T00:00:00.000Z',
        comparabilityKey: 'sha256-abc',
        payload: {},
        markdown: '# Run\n',
      }),
    ).toThrow();
  });

  it('throws loading an unknown runId', () => {
    const store = new RunStore(root);
    expect(() => store.loadRun('does-not-exist')).toThrow(/unknown run/);
  });

  it('listRuns returns an empty array when no runs exist yet', () => {
    const store = new RunStore(root);
    expect(store.listRuns()).toEqual([]);
  });
});
