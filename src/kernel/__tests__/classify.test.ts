import { classifyGame, CONTENT_WEIGHT_HEAVY_THRESHOLD, DECISION_MAGNITUDE_LONG_THRESHOLD } from '../classify';
import { miniTrickAdapter } from '../../reference/mini-trick';
import { splendorAdapter } from '../../reference/splendor';
import { gomokuAdapter } from '../../reference/gomoku';

describe('classifyGame', () => {
  it('classifies mini-trick: two-player, hidden info, scored, short', () => {
    const classification = classifyGame(miniTrickAdapter.spec);
    expect(classification.matchStructure).toBe('two-player');
    expect(classification.identityCenter).toBeCloseTo(0.5);
    expect(classification.informationStructure).toBe('hidden');
    expect(classification.scoreStructure).toBe('scored');
    expect(classification.decisionMagnitude).toBe('short');
    expect(classification.scoreMarginDeclared).toBe(false);
  });

  it('classifies splendor (assumed FFA scenario): ffa, perfect, scored, long', () => {
    const ffaSpec = { ...splendorAdapter.spec, playerCount: 4, maxDecisionsPerGame: 190 };
    const classification = classifyGame(ffaSpec);
    expect(classification.matchStructure).toBe('ffa');
    expect(classification.identityCenter).toBeCloseTo(0.25);
    expect(classification.informationStructure).toBe('perfect');
    expect(classification.scoreStructure).toBe('scored');
    expect(classification.decisionMagnitude).toBe('long');
  });

  it('classifies gomoku (assumed scoreMargin: none): two-player, perfect, win-loss-only, long', () => {
    const spec = { ...gomokuAdapter.spec, scoreMargin: 'none' as const, maxDecisionsPerGame: 146 };
    const classification = classifyGame(spec);
    expect(classification.matchStructure).toBe('two-player');
    expect(classification.identityCenter).toBeCloseTo(0.5);
    expect(classification.informationStructure).toBe('perfect');
    expect(classification.scoreStructure).toBe('win-loss-only');
    expect(classification.decisionMagnitude).toBe('long');
    expect(classification.scoreMarginDeclared).toBe(true);
  });

  it('team games derive identityCenter from team count, not player count', () => {
    const teamSpec = {
      ...miniTrickAdapter.spec,
      playerCount: 4,
      teams: [[0, 1], [2, 3]] as const,
    };
    const classification = classifyGame(teamSpec);
    expect(classification.matchStructure).toBe('team');
    expect(classification.identityCenter).toBeCloseTo(0.5);
  });

  it('content weight follows the heavy threshold boundary', () => {
    const light = Array.from({ length: CONTENT_WEIGHT_HEAVY_THRESHOLD - 1 }, (_, i) => ({ id: `c${i}` }));
    const heavy = Array.from({ length: CONTENT_WEIGHT_HEAVY_THRESHOLD }, (_, i) => ({ id: `c${i}` }));
    expect(classifyGame(miniTrickAdapter.spec, []).contentWeight).toBe('none');
    expect(classifyGame(miniTrickAdapter.spec, light).contentWeight).toBe('light');
    expect(classifyGame(miniTrickAdapter.spec, heavy).contentWeight).toBe('heavy');
  });

  it('decision magnitude follows the long threshold boundary', () => {
    const shortSpec = { ...miniTrickAdapter.spec, maxDecisionsPerGame: DECISION_MAGNITUDE_LONG_THRESHOLD - 1 };
    const longSpec = { ...miniTrickAdapter.spec, maxDecisionsPerGame: DECISION_MAGNITUDE_LONG_THRESHOLD };
    expect(classifyGame(shortSpec).decisionMagnitude).toBe('short');
    expect(classifyGame(longSpec).decisionMagnitude).toBe('long');
  });
});
