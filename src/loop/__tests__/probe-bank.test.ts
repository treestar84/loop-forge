import type { AnyBotFactory } from '../../contract/types';
import { createRng } from '../../kernel/rng';
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

/** Every decision in longAccumulateAdapter offers 10 equally-scored legal
 * choices (helpers/long-accumulate-game.ts's LEGAL is unranked), so a bot
 * that breaks ties via its own seeded RNG never has a single "obviously
 * correct" choice — regression fixture for GAP-11 Phase 1-E's per-decision
 * anchor derivation fix (loss-mining.ts/probe-bank.ts doc comments). */
const seedTieBreakBot: AnyBotFactory = (seed) => {
  const rng = createRng(seed);
  return {
    id: `tie-break-${seed}`,
    decide(_decisionPoint, _observation, legal) {
      return legal[rng.nextInt(legal.length)] as number;
    },
  };
};

describe('mineLosses -> buildProbeBank -> scoreAgainstProbes self-consistency (GAP-11 Phase 1-E)', () => {
  const ANCHOR_SEED_BASE = 12_345;

  it('reproduces agreementRate exactly 1.0 for a seed-dependent tie-break anchor scored against its own probe bank', () => {
    const lossRecords = collectRecords(LOW_BOT, HIGH_BOT, 7);
    const report = mineLosses(adapter, lossRecords, seedTieBreakBot, {
      anchorSeedBase: ANCHOR_SEED_BASE,
    });
    // Sanity: this fixture must actually exercise tie-breaking (multiple
    // divergences across a game with 10 always-tied choices), or the test
    // would pass trivially even without the per-decision derivation fix.
    expect(report.divergences.length).toBeGreaterThan(0);

    const probes = buildProbeBank(report, lossRecords, 'seed-tie-break-anchor-v1');
    expect(probes.length).toBe(report.divergences.length);

    // Scoring the SAME anchor against its own probe bank, with the SAME
    // seed base mineLosses used, must reproduce every anchorChoiceKey
    // exactly — this is only true if mineLosses and scoreAgainstProbes
    // derive the anchor's seed the same way per (gameSeed, decisionIndex).
    const selfScore = scoreAgainstProbes(adapter, seedTieBreakBot, probes, ANCHOR_SEED_BASE);
    expect(selfScore.skipped).toBe(0);
    expect(selfScore.agreementRate).toBe(1);
  });
});
