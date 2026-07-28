import type { AnyBotFactory } from '../../contract/types';
import { eraseAdapter } from '../erase';
import { runPairedBlock, type MatchTrajectoryRecord } from '../paired-match';
import { mineLosses } from '../loss-mining';
import { buildProbeBank, scoreAgainstProbes } from '../probe-bank';
import { longAccumulateAdapter } from './helpers/long-accumulate-game';

const adapter = eraseAdapter(longAccumulateAdapter);

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
const ANCHOR_BOT = fixedPickBot(9, 'anchor-always-9');

function collectRecords(candidate: AnyBotFactory, opponent: AnyBotFactory, seed: number): MatchTrajectoryRecord[] {
  const records: MatchTrajectoryRecord[] = [];
  const result = runPairedBlock(adapter, candidate, opponent, seed, 500, (record) => records.push(record));
  expect('defect' in result).toBe(false);
  return records;
}

describe('buildProbeBank + scoreAgainstProbes', () => {
  const lossRecords = collectRecords(LOW_BOT, HIGH_BOT, 5);
  const report = mineLosses(adapter, lossRecords, ANCHOR_BOT, { anchorSeedBase: 999 });

  it('promotes every divergence into a probe with a stable id and a valid choicePrefix', () => {
    const probes = buildProbeBank(report, lossRecords, 'anchor-always-9-v1');
    expect(probes.length).toBe(report.divergences.length);

    const ids = new Set(probes.map((probe) => probe.probeId));
    expect(ids.size).toBe(probes.length); // no duplicate probeIds

    for (const probe of probes) {
      expect(probe.probeId).toBe(`${probe.gameSeed}-${probe.choicePrefix.length}`);
      expect(probe.sourceAnchorId).toBe('anchor-always-9-v1');
      expect(probe.decisionPointId).toBe('pick');
      expect(probe.anchorChoiceKey).toBe('9');
    }
  });

  it('caps at maxProbes, keeping the earliest decisionIndex probes first', () => {
    const probes = buildProbeBank(report, lossRecords, 'anchor-always-9-v1', { maxProbes: 2 });
    expect(probes).toHaveLength(2);
    const depths = probes.map((probe) => probe.choicePrefix.length);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
  });

  it('scores the anchor itself at agreementRate 1.0 (determinism/self-consistency check)', () => {
    const probes = buildProbeBank(report, lossRecords, 'anchor-always-9-v1', { maxProbes: 10 });
    const score = scoreAgainstProbes(adapter, ANCHOR_BOT, probes, 42);
    expect(score.probes).toBe(10);
    expect(score.skipped).toBe(0);
    expect(score.agreementRate).toBe(1);
  });

  it('scores a disagreeing bot below 1.0', () => {
    const probes = buildProbeBank(report, lossRecords, 'anchor-always-9-v1', { maxProbes: 10 });
    const disagreeingBot = fixedPickBot(0, 'disagrees-with-anchor');
    const score = scoreAgainstProbes(adapter, disagreeingBot, probes, 42);
    expect(score.agreementRate).toBeLessThan(1);
    expect(score.agreements).toBe(0);
  });
});
