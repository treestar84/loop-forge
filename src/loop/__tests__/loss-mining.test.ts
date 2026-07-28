import type { AnyBotFactory } from '../../contract/types';
import { eraseAdapter } from '../erase';
import { runPairedBlock, type MatchTrajectoryRecord } from '../paired-match';
import { mineLosses } from '../loss-mining';
import { longAccumulateAdapter } from './helpers/long-accumulate-game';

const adapter = eraseAdapter(longAccumulateAdapter);

/** Always picks `value` (falling back to the first legal choice if `value`
 * is somehow illegal, which never happens for this fixture's fixed 0-9
 * legal set). */
function fixedPickBot(value: number, id: string): AnyBotFactory {
  return () => ({
    id,
    decide(_decisionPoint, _observation, legal) {
      return legal.find((choice) => choice === value) ?? legal[0];
    },
  });
}

const LOW_BOT = fixedPickBot(0, 'always-0');
const HIGH_BOT = fixedPickBot(9, 'always-9');
const ANCHOR_BOT = fixedPickBot(9, 'anchor-always-9'); // matches HIGH_BOT's line, diverges from LOW_BOT

function collectRecords(candidate: AnyBotFactory, opponent: AnyBotFactory, seed: number): MatchTrajectoryRecord[] {
  const records: MatchTrajectoryRecord[] = [];
  const result = runPairedBlock(adapter, candidate, opponent, seed, 500, (record) => records.push(record));
  expect('defect' in result).toBe(false);
  return records;
}

describe('mineLosses', () => {
  it('detects the exact decisionIndex where the candidate diverges from the anchor, and skips won games', () => {
    // Candidate always picks 0 against an opponent who always picks 9:
    // candidate scores 0, opponent scores 540 — a loss on both seatings.
    const lossRecords = collectRecords(LOW_BOT, HIGH_BOT, 5);
    // Candidate always picks 9 against an opponent who always picks 0: a win
    // on both seatings — must contribute zero divergences.
    const winRecords = collectRecords(HIGH_BOT, LOW_BOT, 5);

    const report = mineLosses(adapter, [...lossRecords, ...winRecords], ANCHOR_BOT, {
      anchorSeedBase: 999,
    });

    expect(report.totalGames).toBe(4);
    expect(report.candidateLosses).toBe(2);

    // Every one of the candidate's 60 decisions per lost game diverges
    // (anchor always picks 9, candidate always picked 0): 2 lost games x 60.
    expect(report.divergences).toHaveLength(120);
    for (const divergence of report.divergences) {
      expect(divergence.decisionPointId).toBe('pick');
      expect(divergence.candidateChoiceKey).toBe('0');
      expect(divergence.anchorChoiceKey).toBe('9');
    }

    // The record where the candidate sits in seat 0 first decides at
    // decisionIndex 0; the record where it sits in seat 1 first decides at
    // decisionIndex 1 (0-indexed choices array, players alternate 0,1,0,1,...).
    const firstDivergenceIndices = new Set(
      lossRecords.map((record) => {
        const firstCandidateIndex = record.deciders.findIndex(
          (decider) => decider === record.candidateSeat,
        );
        return firstCandidateIndex;
      }),
    );
    expect(firstDivergenceIndices).toEqual(new Set([0, 1]));

    expect(report.mismatchRateByDecisionPoint['pick']).toEqual({ decisions: 120, mismatches: 120 });
    // Both lost games' first divergence lands within decisionIndex 0-9.
    expect(report.firstDivergenceDepthHistogram['0-9']).toBe(2);
  });

  it('caps divergences per game at maxDivergencesPerGame without affecting candidateLosses/mismatch counts', () => {
    const lossRecords = collectRecords(LOW_BOT, HIGH_BOT, 5);
    const report = mineLosses(adapter, lossRecords, ANCHOR_BOT, {
      anchorSeedBase: 999,
      maxDivergencesPerGame: 1,
    });
    expect(report.candidateLosses).toBe(2);
    expect(report.divergences).toHaveLength(2); // 1 per lost game
    // Mismatch tallying is independent of the cap — every candidate decision
    // is still checked and counted.
    expect(report.mismatchRateByDecisionPoint['pick']).toEqual({ decisions: 120, mismatches: 120 });
  });

  it('reports zero divergences when the anchor agrees with the candidate on every decision', () => {
    const lossRecords = collectRecords(LOW_BOT, HIGH_BOT, 5);
    const agreeingAnchor = fixedPickBot(0, 'anchor-agrees'); // same line as the candidate
    const report = mineLosses(adapter, lossRecords, agreeingAnchor, { anchorSeedBase: 999 });
    expect(report.candidateLosses).toBe(2);
    expect(report.divergences).toHaveLength(0);
    expect(report.firstDivergenceDepthHistogram).toEqual({});
  });

  it('is deterministic: identical inputs reproduce an identical LossReport', () => {
    const lossRecords = collectRecords(LOW_BOT, HIGH_BOT, 5);
    const first = mineLosses(adapter, lossRecords, ANCHOR_BOT, { anchorSeedBase: 999 });
    const second = mineLosses(adapter, lossRecords, ANCHOR_BOT, { anchorSeedBase: 999 });
    expect(second).toEqual(first);
  });
});
