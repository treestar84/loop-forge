import { eraseAdapter } from '../../../../loop/erase';
import { composeBot } from '../../../../loop/compose';
import { gomokuAdapter } from '../../../gomoku';
import {
  GOMOKU_ROUND3_S512_FLAG,
  GOMOKU_ROUND3_S768_FLAG,
  buildRound3S512Candidate,
  buildRound3S768Candidate,
} from '../gomoku-round3-candidates';

describe('gomoku round3 candidates (GAP-11 Phase 4-B2 미니 진단 — 예산만 올린 opusclone 파생)', () => {
  it('builds a valid, self-contained mcts12-s512-opusclone-w16 StrategyFlagSpec and plays one legal move', () => {
    const bareAdapter = eraseAdapter(gomokuAdapter);
    const candidate = buildRound3S512Candidate(bareAdapter);
    expect(candidate.flag).toBe(GOMOKU_ROUND3_S512_FLAG);
    expect(candidate.bucket).toBe('B1-exploit');
    expect(typeof candidate.spec.apply).toBe('function');

    const adapter = { ...bareAdapter, strategySurface: [candidate.spec] };
    const factory = composeBot(adapter, [GOMOKU_ROUND3_S512_FLAG]);
    const bot = factory(1);

    const state = adapter.createInitialState(1);
    const decision = adapter.currentDecision(state);
    expect(decision).not.toBeNull();
    const legal = adapter.getLegalChoices(state);
    const observation = adapter.getObservation(state, decision!.player);
    const choice = bot.decide(decision!.decisionPoint, observation, legal);
    expect(legal).toContain(choice);
  });

  it('builds a valid mcts12-s768-opusclone-w16 fallback candidate (same shape, higher budget)', () => {
    const bareAdapter = eraseAdapter(gomokuAdapter);
    const candidate = buildRound3S768Candidate(bareAdapter);
    expect(candidate.flag).toBe(GOMOKU_ROUND3_S768_FLAG);
    expect(candidate.bucket).toBe('B1-exploit');
    expect(typeof candidate.spec.apply).toBe('function');
  });
});
