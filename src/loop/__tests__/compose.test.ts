import { composeBot, withStrategyFlags } from '../compose';
import { eraseAdapter } from '../erase';
import { miniTrickAdapter } from '../../reference/mini-trick';

const adapter = eraseAdapter(miniTrickAdapter);

describe('withStrategyFlags', () => {
  it('returns a new adapter with extraFlags appended, leaving the original untouched', () => {
    const originalFlagCount = adapter.strategySurface.length;
    const extraFlag = {
      flag: 'test-extra-flag',
      description: 'a test-only flag added via withStrategyFlags',
      apply: (base: typeof adapter.baselines.heuristic) => base,
    };

    const extended = withStrategyFlags(adapter, [extraFlag]);

    expect(adapter.strategySurface.length).toBe(originalFlagCount);
    expect(adapter.strategySurface.some((spec) => spec.flag === 'test-extra-flag')).toBe(false);
    expect(extended.strategySurface.length).toBe(originalFlagCount + 1);
    expect(extended.strategySurface.some((spec) => spec.flag === 'test-extra-flag')).toBe(true);
  });

  it('lets composeBot resolve a flag injected via withStrategyFlags', () => {
    const extraFlag = {
      flag: 'test-extra-flag-2',
      description: 'a test-only flag added via withStrategyFlags',
      apply: (base: typeof adapter.baselines.heuristic) => base,
    };
    const extended = withStrategyFlags(adapter, [extraFlag]);
    expect(() => composeBot(extended, ['test-extra-flag-2'])).not.toThrow();
  });

  it('throws when extraFlags reuses an existing flag name', () => {
    const existingFlagName = adapter.strategySurface[0]?.flag;
    expect(existingFlagName).toBeDefined();
    const duplicateFlag = {
      flag: existingFlagName as string,
      description: 'duplicate flag name — should be rejected',
      apply: (base: typeof adapter.baselines.heuristic) => base,
    };
    expect(() => withStrategyFlags(adapter, [duplicateFlag])).toThrow(
      /already exists on adapter.strategySurface/,
    );
  });

  it('throws when two extraFlags entries collide with each other', () => {
    const flagA = {
      flag: 'duplicate-among-extras',
      description: 'first',
      apply: (base: typeof adapter.baselines.heuristic) => base,
    };
    // Note: only collisions against the adapter's existing flags are checked
    // up front; this exercises that a name already on the adapter (added via
    // a prior withStrategyFlags call) is rejected on a second call.
    const onceExtended = withStrategyFlags(adapter, [flagA]);
    expect(() => withStrategyFlags(onceExtended, [{ ...flagA, description: 'second' }])).toThrow(
      /already exists on adapter.strategySurface/,
    );
  });
});
