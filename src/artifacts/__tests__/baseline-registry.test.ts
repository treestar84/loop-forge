import { eraseAdapter } from '../../loop/erase';
import { miniTrickAdapter } from '../../reference/mini-trick';
import { BaselineRegistry, composeBot, type BaselineVersion } from '../baseline-registry';

const adapter = eraseAdapter(miniTrickAdapter);

function v1(): BaselineVersion {
  return {
    version: 'v1',
    flags: [],
    parent: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceWaveId: null,
    notes: 'pristine heuristic baseline',
  };
}

describe('composeBot', () => {
  it('returns the raw heuristic bot for an empty flag list', () => {
    const composed = composeBot(adapter, []);
    const bot = composed(1);
    const heuristicBot = adapter.baselines.heuristic(1);
    expect(bot.id).toBe(heuristicBot.id);
  });

  it('applies flags in order onto the heuristic baseline', () => {
    const composed = composeBot(adapter, ['winCheapest', 'leadHighFirst']);
    const bot = composed(1);
    // winCheapest applied first, then leadHighFirst wraps it — id suffix order reflects application order.
    expect(bot.id).toBe('mini-trick-heuristic+winCheapest+leadHighFirst');
  });

  it('throws for an unknown flag', () => {
    expect(() => composeBot(adapter, ['not-a-real-flag'])).toThrow(/unknown strategy flag/);
  });
});

describe('BaselineRegistry — versions', () => {
  it('registers and retrieves a version, and reports latest()', () => {
    const registry = new BaselineRegistry();
    registry.register(v1());
    expect(registry.get('v1')).toEqual(v1());
    expect(registry.latest()).toEqual(v1());
  });

  it('rejects duplicate version registration', () => {
    const registry = new BaselineRegistry();
    registry.register(v1());
    expect(() => registry.register(v1())).toThrow(/duplicate baseline version/);
  });

  it('rejects a version whose parent is unknown', () => {
    const registry = new BaselineRegistry();
    expect(() =>
      registry.register({
        version: 'v2',
        flags: ['winCheapest'],
        parent: 'v1',
        createdAt: '2026-01-02T00:00:00.000Z',
        sourceWaveId: 'wave-1',
        notes: 'adopted winCheapest',
      }),
    ).toThrow(/unknown parent/);
  });

  it('builds a full lineage chain from a leaf version back to the root', () => {
    const registry = new BaselineRegistry();
    registry.register(v1());
    registry.register({
      version: 'v2',
      flags: ['winCheapest'],
      parent: 'v1',
      createdAt: '2026-01-02T00:00:00.000Z',
      sourceWaveId: 'wave-1',
      notes: 'adopted winCheapest',
    });
    const lineage = registry.lineage('v2');
    expect(lineage.map((v) => v.version)).toEqual(['v1', 'v2']);
  });

  it('round-trips through toJSON/fromJSON', () => {
    const registry = new BaselineRegistry();
    registry.register(v1());
    registry.register({
      version: 'v2',
      flags: ['winCheapest'],
      parent: 'v1',
      createdAt: '2026-01-02T00:00:00.000Z',
      sourceWaveId: 'wave-1',
      notes: 'adopted winCheapest',
    });
    const restored = BaselineRegistry.fromJSON(JSON.parse(JSON.stringify(registry.toJSON())));
    expect(restored.get('v2')).toEqual(registry.get('v2'));
    expect(restored.latest()).toEqual(registry.latest());
  });

  it('round-trips a version carrying an optional sourceDigest', () => {
    const registry = new BaselineRegistry();
    registry.register({ ...v1(), sourceDigest: 'sha256-abc123' });
    const restored = BaselineRegistry.fromJSON(JSON.parse(JSON.stringify(registry.toJSON())));
    expect(restored.get('v1')?.sourceDigest).toBe('sha256-abc123');
    expect(restored.get('v1')).toEqual(registry.get('v1'));
  });

  it('loads a version with no sourceDigest field unchanged (backward compatibility)', () => {
    const registry = new BaselineRegistry();
    registry.register(v1());
    const restored = BaselineRegistry.fromJSON(JSON.parse(JSON.stringify(registry.toJSON())));
    expect(restored.get('v1')?.sourceDigest).toBeUndefined();
  });

  it('fromJSON rejects malformed input', () => {
    expect(() => BaselineRegistry.fromJSON(null)).toThrow();
    expect(() => BaselineRegistry.fromJSON({})).toThrow();
    expect(() =>
      BaselineRegistry.fromJSON({ versionOrder: ['v1'], versions: [], anchorOrder: [], anchors: [] }),
    ).toThrow();
  });
});

describe('BaselineRegistry — anchors are frozen once registered', () => {
  it('registers random/heuristic anchors and resolves them to bot factories', () => {
    const registry = new BaselineRegistry();
    registry.registerAnchor({ anchorId: 'random-anchor', kind: 'random' });
    registry.registerAnchor({ anchorId: 'heuristic-anchor', kind: 'heuristic' });

    const randomFactory = registry.resolveAnchor(adapter, 'random-anchor');
    const heuristicFactory = registry.resolveAnchor(adapter, 'heuristic-anchor');
    expect(randomFactory(1).id).toBe(adapter.baselines.random(1).id);
    expect(heuristicFactory(1).id).toBe(adapter.baselines.heuristic(1).id);
  });

  it('registers a baseline-kind anchor referencing a registered version', () => {
    const registry = new BaselineRegistry();
    registry.register(v1());
    registry.registerAnchor({ anchorId: 'v1-anchor', kind: 'baseline', baselineVersion: 'v1' });
    const factory = registry.resolveAnchor(adapter, 'v1-anchor');
    expect(factory(1).id).toBe(adapter.baselines.heuristic(1).id);
  });

  it('rejects a baseline anchor referencing an unknown version', () => {
    const registry = new BaselineRegistry();
    expect(() =>
      registry.registerAnchor({ anchorId: 'bad-anchor', kind: 'baseline', baselineVersion: 'v99' }),
    ).toThrow(/unknown baseline version/);
  });

  it('throws on re-registering the same anchorId — anchors never move', () => {
    const registry = new BaselineRegistry();
    registry.registerAnchor({ anchorId: 'random-anchor', kind: 'random' });
    expect(() => registry.registerAnchor({ anchorId: 'random-anchor', kind: 'heuristic' })).toThrow(
      /already frozen/,
    );
  });

  it('lists anchors in registration order and round-trips via JSON', () => {
    const registry = new BaselineRegistry();
    registry.registerAnchor({ anchorId: 'a', kind: 'random' });
    registry.registerAnchor({ anchorId: 'b', kind: 'heuristic' });
    expect(registry.listAnchors().map((a) => a.anchorId)).toEqual(['a', 'b']);

    const restored = BaselineRegistry.fromJSON(JSON.parse(JSON.stringify(registry.toJSON())));
    expect(restored.listAnchors()).toEqual(registry.listAnchors());
  });
});

// GAP-11 D3: external anchors (the L1/L2/L3 anchor ladder).
describe('BaselineRegistry — external anchors (GAP-11 D3)', () => {
  it('registers an external anchor with an explicit role', () => {
    const registry = new BaselineRegistry();
    const stored = registry.registerAnchor({ anchorId: 'l2-opus', kind: 'external', role: 'feedback' });
    expect(stored).toEqual({ anchorId: 'l2-opus', kind: 'external', role: 'feedback' });
    expect(registry.getAnchor('l2-opus')).toEqual(stored);
  });

  it('registers a holdout external anchor', () => {
    const registry = new BaselineRegistry();
    const stored = registry.registerAnchor({ anchorId: 'l3-opus', kind: 'external', role: 'holdout' });
    expect(stored.role).toBe('holdout');
  });

  it('normalizes an external anchor with no role to "feedback"', () => {
    const registry = new BaselineRegistry();
    const stored = registry.registerAnchor({ anchorId: 'l1-sonnet', kind: 'external' });
    expect(stored.role).toBe('feedback');
    expect(registry.getAnchor('l1-sonnet')?.role).toBe('feedback');
  });

  it('rejects re-registering an external anchor — anchors never move', () => {
    const registry = new BaselineRegistry();
    registry.registerAnchor({ anchorId: 'l2-opus', kind: 'external', role: 'feedback' });
    expect(() => registry.registerAnchor({ anchorId: 'l2-opus', kind: 'external', role: 'holdout' })).toThrow(
      /already frozen/,
    );
  });

  it('rejects a non-external anchor that declares a role', () => {
    const registry = new BaselineRegistry();
    expect(() => registry.registerAnchor({ anchorId: 'bad-role', kind: 'random', role: 'feedback' })).toThrow(
      /must not declare a role/,
    );
    expect(() =>
      registry.registerAnchor({ anchorId: 'bad-role-2', kind: 'heuristic', role: 'holdout' }),
    ).toThrow(/must not declare a role/);
  });

  it('resolveAnchor throws for an external anchor — its factory must be supplied by the caller', () => {
    const registry = new BaselineRegistry();
    registry.registerAnchor({ anchorId: 'l2-opus', kind: 'external', role: 'feedback' });
    expect(() => registry.resolveAnchor(adapter, 'l2-opus')).toThrow(/cannot be resolved via resolveAnchor/);
  });

  it('round-trips external anchors (both roles) through toJSON/fromJSON', () => {
    const registry = new BaselineRegistry();
    registry.registerAnchor({ anchorId: 'l1-sonnet', kind: 'external', role: 'feedback' });
    registry.registerAnchor({ anchorId: 'l3-opus', kind: 'external', role: 'holdout' });
    const restored = BaselineRegistry.fromJSON(JSON.parse(JSON.stringify(registry.toJSON())));
    expect(restored.getAnchor('l1-sonnet')).toEqual(registry.getAnchor('l1-sonnet'));
    expect(restored.getAnchor('l3-opus')).toEqual(registry.getAnchor('l3-opus'));
  });
});
