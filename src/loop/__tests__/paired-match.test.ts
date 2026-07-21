import { miniTrickAdapter } from '../../reference/mini-trick';
import { eraseAdapter } from '../erase';
import { runPairedBlock } from '../paired-match';
import { calibrateIdentity } from '../calibrate';
import { quadGameFreeForAll, quadGameTeamed } from './helpers/quad-game';

const adapter = eraseAdapter(miniTrickAdapter);

describe('runPairedBlock', () => {
  it('cancels seat/first-move bias for an identical bot playing itself (winFraction 0.5)', () => {
    const result = runPairedBlock(adapter, adapter.baselines.heuristic, adapter.baselines.heuristic, 7, 100);
    expect('defect' in result).toBe(false);
    if (!('defect' in result)) {
      expect(result.candidateWinFraction).toBeCloseTo(0.5, 10);
      expect(result.candidateScoreDelta).toBeCloseTo(0, 10);
      expect(result.seed).toBe(7);
    }
  });

  it('is deterministic for the same seeds', () => {
    const first = runPairedBlock(adapter, adapter.baselines.random, adapter.baselines.heuristic, 12, 50);
    const second = runPairedBlock(adapter, adapter.baselines.random, adapter.baselines.heuristic, 12, 50);
    expect(second).toEqual(first);
  });

  it('propagates a defect instead of returning a PairedSeedOutcome', () => {
    const illegalBotFactory = () => ({
      id: 'illegal-bot',
      decide: () => ({ suit: 'A' as const, rank: 999 }),
    });
    const result = runPairedBlock(adapter, illegalBotFactory, adapter.baselines.random, 7, 100);
    expect('defect' in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B2: 3-4 player verification (quad-game fixture — see ./helpers/quad-game.ts)
// ---------------------------------------------------------------------------

const quadFfa = eraseAdapter(quadGameFreeForAll);
const quadTeamed = eraseAdapter(quadGameTeamed);

describe('runPairedBlock — quad-game free-for-all (no teams, B2 regression)', () => {
  it('averages an identical bot playing itself to winFraction 1/playerCount, not 1/2 — unlike the 2-player case, a 4-player solo-winner game has exactly one winning seat per fixed deal, and the seating-plan rotation visits all 4 seats once each, so only one of the four permutations can match the candidate to the winner', () => {
    const result = runPairedBlock(
      quadFfa,
      quadFfa.baselines.heuristic,
      quadFfa.baselines.heuristic,
      7,
      100,
    );
    expect('defect' in result).toBe(false);
    if (!('defect' in result)) {
      // Untagged (no spec.teams) games must use the pre-existing solo-winner
      // math unchanged (isWinner ? (winners.length > 1 ? 0.5 : 1) : 0) — this
      // is the B3 regression check. That unchanged math naturally averages to
      // 1/playerCount for a symmetric free-for-all, not 0.5; 0.5 is a
      // 2-player-only coincidence (mini-trick's own test above).
      expect(result.candidateWinFraction).toBeCloseTo(0.25, 10);
    }
  });

  it('is deterministic for the same seeds (4-player)', () => {
    const first = runPairedBlock(quadFfa, quadFfa.baselines.random, quadFfa.baselines.heuristic, 12, 50);
    const second = runPairedBlock(quadFfa, quadFfa.baselines.random, quadFfa.baselines.heuristic, 12, 50);
    expect(second).toEqual(first);
  });
});

describe('calibrateIdentity — quad-game free-for-all (4-player, B2 finding)', () => {
  it('shows identity self-play win rate near 1/4, not 1/2 — calibrateIdentity\'s hardcoded win-fraction math (isWinner ? (winners.length > 1 ? 0.5 : 1) : 0) is agnostic to player count, but the *expected value* of a solo-winner game with N symmetric players is 1/N, not 1/2. calibrateIdentity itself is not modified; this documents that its 0.5 sanity band in C5 (score.ts) is tuned for 2-player games and would misfire on a naively-reused 4-player adapter.', () => {
      const seeds = Array.from({ length: 300 }, (_, i) => 90_000 + i);
      const identity = calibrateIdentity(quadFfa, quadFfa.baselines.random, seeds, 95_000);

      // Expected ~0.25 for 4 symmetric free-for-all players; comfortably far
      // from the 2-player 0.5 expectation so the two cannot be confused.
      expect(identity.meanWinRate).toBeGreaterThan(0.15);
      expect(identity.meanWinRate).toBeLessThan(0.35);
      expect(identity.meanWinRate).not.toBeCloseTo(0.5, 1);
    },
    20_000,
  );
});

describe('quadGameTeamed.getOutcome — team score arithmetic (B3 unit-level check)', () => {
  it('computes team totals, excludes teammates from the opponent side, and lists every teammate as a winner', () => {
    // Hand-crafted terminal state (bypasses createInitialState/RNG entirely)
    // so the expected scores/winners can be computed by hand:
    //   team0 = players [0,2]: sums 6 + 24 = 30
    //   team1 = players [1,3]: sums 15 + 33 = 48  <- higher, team1 wins
    const state = {
      hands: [[], [], [], []],
      revealed: [
        [1, 2, 3], // player 0: sum 6
        [4, 5, 6], // player 1: sum 15
        [7, 8, 9], // player 2: sum 24
        [10, 11, 12], // player 3: sum 33
      ],
      turnsTaken: 12,
    };
    const outcome = quadGameTeamed.getOutcome(state);
    expect(outcome).not.toBeNull();
    expect(outcome?.scores).toEqual([30, 48, 30, 48]);
    expect(outcome?.winners.slice().sort()).toEqual([1, 3]);
  });
});

describe('runPairedBlock — quad-game teamed (spec.teams: [[0,2],[1,3]], B3)', () => {
  // A fixed (RNG-bypassing) deal so the per-seating-permutation math is fully
  // predictable: hands = [[1,2,3],[4,5,6],[7,8,9],[10,11,12]] for players
  // 0,1,2,3. team0=[0,2] totals 30, team1=[1,3] totals 48 — team1 always wins
  // regardless of which bot (candidate/opponent) is assigned to which seat,
  // since every decision is forced (exactly one legal choice).
  const fixedDealAdapter = eraseAdapter({
    ...quadGameTeamed,
    createInitialState: () => ({
      hands: [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]],
      revealed: [[], [], [], []],
      turnsTaken: 0,
    }),
  });

  it('averages team-aware winFraction/scoreDelta to 0.5/0 across the full seating rotation, with teammate scores excluded from the opponent mean', () => {
    const result = runPairedBlock(
      fixedDealAdapter,
      fixedDealAdapter.baselines.heuristic,
      fixedDealAdapter.baselines.heuristic,
      1,
      100,
    );
    expect('defect' in result).toBe(false);
    if (!('defect' in result)) {
      // Symmetric seating rotation puts the candidate on team0 for two
      // permutations (winFraction 0, scoreDelta 30-48=-18 each) and on team1
      // for the other two (winFraction 1, scoreDelta 48-30=+18 each) — this
      // exact cancellation to 0.5/0 only holds if teammates are correctly
      // pooled together and excluded from the opposing mean.
      expect(result.candidateWinFraction).toBeCloseTo(0.5, 10);
      expect(result.candidateScoreDelta).toBeCloseTo(0, 10);
    }
  });
});
