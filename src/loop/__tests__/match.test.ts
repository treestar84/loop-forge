import type { AnyBotFactory } from '../../contract/types';
import { miniTrickAdapter, type MiniTrickCard } from '../../reference/mini-trick';
import { eraseAdapter } from '../erase';
import { runMatch } from '../match';

const adapter = eraseAdapter(miniTrickAdapter);

function randomBots(): AnyBotFactory[] {
  return [adapter.baselines.random, adapter.baselines.random];
}

describe('runMatch determinism', () => {
  it('replays an identical trajectory and outcome for the same seeds', () => {
    const first = runMatch(adapter, randomBots(), 41, [100, 200], [0, 1]);
    const second = runMatch(adapter, randomBots(), 41, [100, 200], [0, 1]);
    expect(first).toEqual(second);
  });

  it('produces a completed result with a non-empty trajectory', () => {
    const result = runMatch(adapter, randomBots(), 41, [100, 200], [0, 1]);
    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.choiceKeys.length).toBeGreaterThan(0);
      expect(result.decisions).toBe(result.choiceKeys.length);
      expect(result.outcome.scores).toHaveLength(2);
    }
  });
});

describe('runMatch defect detection', () => {
  it('reports illegal-choice when a bot returns a choice outside legal', () => {
    const illegalBotFactory: AnyBotFactory = () => ({
      id: 'illegal-bot',
      decide(): MiniTrickCard {
        return { suit: 'A', rank: 999 };
      },
    });
    const result = runMatch(
      adapter,
      [illegalBotFactory, adapter.baselines.random],
      41,
      [1, 2],
      [0, 1],
    );
    expect(result.kind).toBe('defect');
    if (result.kind === 'defect') {
      expect(result.defect.type).toBe('illegal-choice');
      expect(result.defect.atDecision).toBe(1);
    }
  });

  it('reports bot-error when a bot throws during decide', () => {
    const throwingBotFactory: AnyBotFactory = () => ({
      id: 'throwing-bot',
      decide(): MiniTrickCard {
        throw new Error('boom');
      },
    });
    const result = runMatch(
      adapter,
      [throwingBotFactory, adapter.baselines.random],
      41,
      [1, 2],
      [0, 1],
    );
    expect(result.kind).toBe('defect');
    if (result.kind === 'defect') {
      expect(result.defect.type).toBe('bot-error');
      expect(result.defect.message).toContain('boom');
    }
  });

  it('reports max-decisions-exceeded when spec.maxDecisionsPerGame is exceeded', () => {
    const tinyCapAdapter = {
      ...adapter,
      spec: { ...adapter.spec, maxDecisionsPerGame: 1 },
    };
    const result = runMatch(tinyCapAdapter, randomBots(), 41, [100, 200], [0, 1]);
    expect(result.kind).toBe('defect');
    if (result.kind === 'defect') {
      expect(result.defect.type).toBe('max-decisions-exceeded');
    }
  });

  it('throws (a programming error, not a defect) when botFactories/seating length mismatch', () => {
    expect(() => runMatch(adapter, randomBots(), 41, [100, 200], [0])).toThrow();
    expect(() => runMatch(adapter, randomBots(), 41, [100], [0, 1])).toThrow();
  });
});
