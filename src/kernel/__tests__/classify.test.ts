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

  // O2: spec.utility -> classification.utilityStructure/utilityDeclared.
  // Never inferred — a 2-player win/loss game left undeclared must still
  // classify as 'general', not 'zero-sum'. mini-trick itself now declares
  // utility: 'zero-sum' (docs/GAP-ANALYSIS-7.md O7-b: its scores always sum
  // to a constant 6, so it is genuinely zero-sum after centering) — this
  // test strips that declaration back off to exercise the omitted-field
  // default independently of that fact.
  it('defaults to general/undeclared when spec.utility is omitted, even for a 2-player game', () => {
    const { utility: _utility, ...specWithoutUtility } = miniTrickAdapter.spec;
    const classification = classifyGame(specWithoutUtility);
    expect(classification.utilityStructure).toBe('general');
    expect(classification.utilityDeclared).toBe(false);
  });

  it('classifies zero-sum only when spec.utility is explicitly declared', () => {
    const zeroSumSpec = { ...miniTrickAdapter.spec, utility: 'zero-sum' as const };
    const classification = classifyGame(zeroSumSpec);
    expect(classification.utilityStructure).toBe('zero-sum');
    expect(classification.utilityDeclared).toBe(true);
  });

  it('classifies general-sum when spec.utility is explicitly declared as general', () => {
    const generalSpec = { ...miniTrickAdapter.spec, utility: 'general' as const };
    const classification = classifyGame(generalSpec);
    expect(classification.utilityStructure).toBe('general');
    expect(classification.utilityDeclared).toBe(true);
  });
});
