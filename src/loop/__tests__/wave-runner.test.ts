import { SeedLedger } from '../../kernel/seed-ledger';
import type { PromotionCriteria } from '../../kernel/gates';
import { miniTrickAdapter } from '../../reference/mini-trick';
import { eraseAdapter } from '../erase';
import { runWave, type WaveConfig } from '../wave-runner';
import { fieldMixAdapter } from './helpers/field-mix-game';
import { firstMoverWinsAdapter } from './helpers/first-mover-wins-game';
import { strengthDeclareAdapter } from './helpers/strength-declare-game';

const adapter = eraseAdapter(miniTrickAdapter);
const collapseAdapter = eraseAdapter(firstMoverWinsAdapter);
const strengthAdapter = eraseAdapter(strengthDeclareAdapter);
const fieldMixTestAdapter = eraseAdapter(fieldMixAdapter);

// mini-trick scores range 0-6 (six tricks total), so kernel/gates'
// DEFAULT_CRITERIA (minScoreDiff: 5, tuned for a larger-magnitude game) would
// reject every realistic candidate here. Use criteria scaled to this game.
const MINI_TRICK_CRITERIA: PromotionCriteria = { minWinRate: 0.53, minScoreDiff: 0.3 };

function makeLedger() {
  const ledger = new SeedLedger();
  ledger.reserve({
    bankId: 'smoke-test',
    range: { start: 1000, end: 1079 },
    purpose: 'smoke',
    reservedAt: '2026-01-01T00:00:00.000Z',
  });
  ledger.reserve({
    bankId: 'prune-test',
    range: { start: 2000, end: 2079 },
    purpose: 'prune',
    reservedAt: '2026-01-01T00:00:00.000Z',
  });
  ledger.reserve({
    bankId: 'holdout-test',
    range: { start: 3000, end: 3079 },
    purpose: 'holdout',
    reservedAt: '2026-01-01T00:00:00.000Z',
  });
  return ledger;
}

function baseWaveConfig(ledger: SeedLedger): WaveConfig {
  return {
    waveId: 'test-wave-1',
    candidates: [{ flag: 'winCheapest' }, { flag: 'noopSort' }, { flag: 'leadHighFirst' }],
    opponent: 'heuristic',
    recordedAt: '2026-01-01T00:00:00.000Z',
    ledger,
    tiers: {
      smoke: {
        bankId: 'smoke-test',
        sprt: { p0: 0.5, p1: 0.58, alpha: 0.05, beta: 0.05 },
        maxBlocks: 80,
        minBlocks: 10,
      },
      prune: { bankId: 'prune-test', blocks: 80 },
      holdout: { bankId: 'holdout-test', blocks: 80 },
    },
    criteria: MINI_TRICK_CRITERIA,
    // Seeds 1-5 happen to never expose winCheapest's cheapest-winning-card
    // decision on this base bot (small-sample luck of the shuffle), so use a
    // probe set independently confirmed to make winCheapest diverge from the
    // base heuristic bot's trajectory.
    screenProbe: { seeds: [7, 11, 12, 13, 42], botSeedBase: 500 },
  };
}

describe('runWave', () => {
  it('screens out noopSort as a behavioral no-op before spending any smoke games', () => {
    const ledger = makeLedger();
    const report = runWave(adapter, baseWaveConfig(ledger));
    const noop = report.results.find((r) => r.flag === 'noopSort');
    expect(noop).toBeDefined();
    expect(noop?.tiersPassed).toEqual([]);
    expect(noop?.stats.smoke).toBeUndefined();
  });

  it('carries winCheapest (a real improvement) through smoke, prune, and holdout to adoption', () => {
    const ledger = makeLedger();
    const report = runWave(adapter, baseWaveConfig(ledger));
    const winCheapest = report.results.find((r) => r.flag === 'winCheapest');
    expect(winCheapest).toBeDefined();
    expect(winCheapest?.tiersPassed).toEqual(['screen', 'smoke', 'prune', 'holdout']);
    expect(winCheapest?.verdict).toBe('adopted');
  });

  it('reports seed consumption and a stable digest', () => {
    const ledger = makeLedger();
    const report = runWave(adapter, baseWaveConfig(ledger));
    expect(report.seedConsumption).toEqual(['smoke-test', 'prune-test', 'holdout-test']);
    expect(report.reportDigest).toMatch(/^sha256-[0-9a-f]{64}$/);

    const secondLedger = makeLedger();
    const secondReport = runWave(adapter, baseWaveConfig(secondLedger));
    expect(secondReport.reportDigest).toBe(report.reportDigest);
  });

  it('every candidate result carries a flag matching an input candidate', () => {
    const ledger = makeLedger();
    const report = runWave(adapter, baseWaveConfig(ledger));
    const flags = report.results.map((r) => r.flag).sort();
    expect(flags).toEqual(['leadHighFirst', 'noopSort', 'winCheapest']);
  });
});

// X1 (docs/GAP-ANALYSIS-2.md): paired signal collapse warning. firstMoverWinsAdapter's
// outcome never depends on any decision, so every smoke block's winFraction is
// exactly 0.5 (drawRate=1.0) — comfortably above the default 0.8 threshold.
describe('runWave signal-collapse warnings (X1)', () => {
  function collapseWaveConfig(ledger: SeedLedger): WaveConfig {
    return {
      waveId: 'collapse-wave-1',
      candidates: [{ flag: 'pickB' }],
      opponent: 'heuristic',
      recordedAt: '2026-01-01T00:00:00.000Z',
      ledger,
      tiers: {
        smoke: {
          bankId: 'smoke-test',
          sprt: { p0: 0.5, p1: 0.58, alpha: 0.05, beta: 0.05 },
          maxBlocks: 20,
          minBlocks: 20,
        },
        prune: { bankId: 'prune-test', blocks: 20 },
        holdout: { bankId: 'holdout-test', blocks: 20 },
      },
      criteria: { minWinRate: 0.53, minScoreDiff: 0.1 },
      screenProbe: { seeds: [1, 2, 3], botSeedBase: 500 },
    };
  }

  it('raises a signal-collapse warning on the candidate result and aggregates it on the report', () => {
    const ledger = makeLedger();
    const report = runWave(collapseAdapter, collapseWaveConfig(ledger));
    const pickB = report.results.find((r) => r.flag === 'pickB');
    expect(pickB).toBeDefined();
    expect(pickB?.stats.smoke?.drawRate).toBe(1);
    expect(pickB?.warnings.some((w) => w.includes('signal collapse'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('[pickB]') && w.includes('signal collapse'))).toBe(
      true,
    );
  });
});

// O10 (docs/GAP-ANALYSIS-7.md): regression gate backward compatibility. A
// WaveConfig that never sets wave.tiers.regression must behave byte-for-byte
// like pre-O10 wave-runner — same seedConsumption, same reportDigest.
describe('runWave backward compatibility (no regression tier configured)', () => {
  it('produces a stable reportDigest identical to the pre-O10 value for an unchanged config', () => {
    const ledger = makeLedger();
    const report = runWave(adapter, baseWaveConfig(ledger));
    expect(report.reportDigest).toBe(
      'sha256-afd3bca47e9bf25ca757287295f888313c6a33b5f4baf588ce78d1a060560c30',
    );
    expect(report.seedConsumption).toEqual(['smoke-test', 'prune-test', 'holdout-test']);
  });
});

// O10: regression gate — holdout-passing candidates get one more paired
// evaluation against the current baseline composite bot (not the raw
// heuristic opponent every other tier faces). This is the gate that would
// have caught the omok v3 override bug (GAP-ANALYSIS-7.md O10): a candidate
// that beats the raw opponent but is weaker than what's already adopted.
describe('runWave regression tier (O10)', () => {
  function makeStrengthLedger() {
    const ledger = new SeedLedger();
    ledger.reserve({
      bankId: 'strength-smoke',
      range: { start: 1000, end: 1009 },
      purpose: 'smoke',
      reservedAt: '2026-01-01T00:00:00.000Z',
    });
    ledger.reserve({
      bankId: 'strength-prune',
      range: { start: 2000, end: 2009 },
      purpose: 'prune',
      reservedAt: '2026-01-01T00:00:00.000Z',
    });
    ledger.reserve({
      bankId: 'strength-holdout',
      range: { start: 3000, end: 3009 },
      purpose: 'holdout',
      reservedAt: '2026-01-01T00:00:00.000Z',
    });
    ledger.reserve({
      bankId: 'strength-regression',
      range: { start: 4000, end: 4009 },
      purpose: 'regression',
      reservedAt: '2026-01-01T00:00:00.000Z',
    });
    return ledger;
  }

  const STRENGTH_CRITERIA: PromotionCriteria = { minWinRate: 0.53, minScoreDiff: 0.5 };

  function strengthWaveConfig(
    ledger: SeedLedger,
    flag: string,
  ): WaveConfig {
    return {
      waveId: 'strength-wave-1',
      candidates: [{ flag }],
      opponent: 'heuristic',
      recordedAt: '2026-01-01T00:00:00.000Z',
      ledger,
      // The current baseline champion already has 'strong' composed in
      // (strength 3) — this is what the regression tier compares candidates
      // against, instead of the raw heuristic (strength 1).
      baselineFlags: ['strong'],
      tiers: {
        smoke: {
          bankId: 'strength-smoke',
          sprt: { p0: 0.5, p1: 0.58, alpha: 0.05, beta: 0.05 },
          maxBlocks: 10,
          minBlocks: 5,
        },
        prune: { bankId: 'strength-prune', blocks: 10 },
        holdout: { bankId: 'strength-holdout', blocks: 10 },
        regression: { bankId: 'strength-regression', blocks: 10 },
      },
      criteria: STRENGTH_CRITERIA,
      screenProbe: { seeds: [1, 2, 3], botSeedBase: 500 },
    };
  }

  it('demotes an override-style candidate that beats the raw opponent but is weaker than the current baseline', () => {
    const ledger = makeStrengthLedger();
    const report = runWave(strengthAdapter, strengthWaveConfig(ledger, 'override'));
    const result = report.results.find((r) => r.flag === 'override');
    expect(result).toBeDefined();
    // Clears screen/smoke/prune/holdout against the raw heuristic (strength
    // 2 beats strength 1) but never reaches 'regression' in tiersPassed.
    expect(result?.tiersPassed).toEqual(['screen', 'smoke', 'prune', 'holdout']);
    expect(result?.verdict).toBe('near-miss');
    expect(result?.stats.regression).toBeDefined();
    expect(result?.stats.regression?.pointWinRate).toBe(0);
    expect(result?.warnings.some((w) => w.includes('regression failed vs current baseline'))).toBe(
      true,
    );
  });

  it('adopts a candidate that ties the current baseline exactly (winFraction 0.5) in the regression tier', () => {
    const ledger = makeStrengthLedger();
    const report = runWave(strengthAdapter, strengthWaveConfig(ledger, 'twin'));
    const result = report.results.find((r) => r.flag === 'twin');
    expect(result).toBeDefined();
    expect(result?.tiersPassed).toEqual(['screen', 'smoke', 'prune', 'holdout', 'regression']);
    expect(result?.verdict).toBe('adopted');
    expect(result?.stats.regression?.pointWinRate).toBeCloseTo(0.5);
  });

  it('consumes the regression seed bank only when the regression tier is configured', () => {
    const ledger = makeStrengthLedger();
    const report = runWave(strengthAdapter, strengthWaveConfig(ledger, 'twin'));
    expect(report.seedConsumption).toEqual([
      'strength-smoke',
      'strength-prune',
      'strength-holdout',
      'strength-regression',
    ]);
    expect(ledger.get('strength-regression')?.status).toBe('consumed');

    // Compare against a config that omits the regression tier entirely: the
    // bank must stay untouched and out of seedConsumption (backward compat).
    const noRegressionLedger = makeLedger();
    const noRegressionReport = runWave(adapter, baseWaveConfig(noRegressionLedger));
    expect(noRegressionReport.seedConsumption).not.toContain('strength-regression');
  });
});

// M4 (docs/GAP-ANALYSIS-10.md): WaveConfig.fieldMix — per-seat opponent
// composition for multi-player waves, taking precedence over the single
// `opponent` field for every non-candidate seat.
describe('runWave fieldMix (M4)', () => {
  function fieldMixWaveConfig(ledger: SeedLedger, fieldMix?: WaveConfig['fieldMix']): WaveConfig {
    return {
      waveId: 'field-mix-wave-1',
      candidates: [{ flag: 'noop' }],
      opponent: 'heuristic',
      ...(fieldMix === undefined ? {} : { fieldMix }),
      recordedAt: '2026-01-01T00:00:00.000Z',
      ledger,
      tiers: {
        smoke: {
          bankId: 'smoke-test',
          sprt: { p0: 0.5, p1: 0.58, alpha: 0.05, beta: 0.05 },
          maxBlocks: 5,
          minBlocks: 5,
        },
        prune: { bankId: 'prune-test', blocks: 5 },
        holdout: { bankId: 'holdout-test', blocks: 5 },
      },
      criteria: { minWinRate: 0.53, minScoreDiff: 0.1 },
      screenProbe: { seeds: [1], botSeedBase: 500 },
    };
  }

  it('throws a clear error when fieldMix.length does not equal playerCount - 1', () => {
    const ledger = makeLedger();
    expect(() => runWave(fieldMixTestAdapter, fieldMixWaveConfig(ledger, ['heuristic']))).toThrow(
      /fieldMix/,
    );
  });

  it('places each fieldMix entry\'s baseline factory at its own non-candidate seat', () => {
    // fieldMixAdapter's sole strategySurface flag ('noop') always returns
    // `base` unchanged, so screen rejects it as a no-op and evaluateCandidate
    // stops right after the screen tier (no smoke/prune/holdout games spent)
    // — this keeps bot-factory construction calls to exactly the two screen
    // trajectories (candidate vs base), both built from the same restFactories.
    const heuristicSeeds: number[] = [];
    const randomSeeds: number[] = [];
    const spiedAdapter = eraseAdapter({
      ...fieldMixAdapter,
      baselines: {
        heuristic: (seed: number) => {
          heuristicSeeds.push(seed);
          return fieldMixAdapter.baselines.heuristic(seed);
        },
        random: (seed: number) => {
          randomSeeds.push(seed);
          return fieldMixAdapter.baselines.random(seed);
        },
      },
    });

    const ledger = makeLedger();
    const report = runWave(
      spiedAdapter,
      fieldMixWaveConfig(ledger, ['heuristic', 'random', 'heuristic']),
    );
    const result = report.results.find((r) => r.flag === 'noop');
    expect(result?.tiersPassed).toEqual([]);

    // Candidate seat (index 0) is always heuristic-based here (no
    // baselineFlags), plus non-candidate seats 1 and 3 declared 'heuristic'
    // in fieldMix, seat 2 declared 'random' — each trajectory call (screen
    // runs candidate-vs-rest and base-vs-rest once, per probe seed) hits
    // every seat once, so seed offsets 0/1/3 (relative to botSeedBase=500)
    // must only ever reach the heuristic spy, and offset 2 only the random spy.
    expect(new Set(heuristicSeeds)).toEqual(new Set([500, 501, 503]));
    expect(new Set(randomSeeds)).toEqual(new Set([502]));
  });

  it('fieldMix unset preserves pre-M4 behavior: every non-candidate seat uses the single opponent factory', () => {
    const heuristicSeeds: number[] = [];
    const randomSeeds: number[] = [];
    const spiedAdapter = eraseAdapter({
      ...fieldMixAdapter,
      baselines: {
        heuristic: (seed: number) => {
          heuristicSeeds.push(seed);
          return fieldMixAdapter.baselines.heuristic(seed);
        },
        random: (seed: number) => {
          randomSeeds.push(seed);
          return fieldMixAdapter.baselines.random(seed);
        },
      },
    });

    const ledger = makeLedger();
    runWave(spiedAdapter, fieldMixWaveConfig(ledger, undefined));

    // Every seat (candidate + all 3 rest slots) is heuristic-based: candidate
    // via composeBot's default heuristic baseline, rest slots via
    // wave.opponent: 'heuristic'. random is never touched.
    expect(new Set(heuristicSeeds)).toEqual(new Set([500, 501, 502, 503]));
    expect(randomSeeds).toEqual([]);
  });
});

// GAP-11 D3: external-anchor challenge measurement. Never influences
// verdict/tiersPassed — it's an observation appended after gating finishes.
describe('runWave challenge measurement (GAP-11 D3)', () => {
  const CHALLENGE_SEEDS = [9001, 9002, 9003, 9004, 9005];

  it('throws immediately when a challenge entry declares role "holdout"', () => {
    const ledger = makeLedger();
    const config: WaveConfig = {
      ...baseWaveConfig(ledger),
      challenge: {
        entries: [{ anchorId: 'l3-opus', factory: adapter.baselines.random, role: 'holdout' }],
        seeds: CHALLENGE_SEEDS,
        botSeedBase: 7000,
      },
    };
    expect(() => runWave(adapter, config)).toThrow(/holdout anchors are for/);
  });

  it('throws before consuming any seed bank when the challenge has a holdout entry', () => {
    const ledger = makeLedger();
    const config: WaveConfig = {
      ...baseWaveConfig(ledger),
      challenge: {
        entries: [
          { anchorId: 'l2-opus', factory: adapter.baselines.heuristic, role: 'feedback' },
          { anchorId: 'l3-opus', factory: adapter.baselines.random, role: 'holdout' },
        ],
        seeds: CHALLENGE_SEEDS,
        botSeedBase: 7000,
      },
    };
    expect(() => runWave(adapter, config)).toThrow();
    // The smoke bank must still be "reserved" (not consumed) — the throw
    // happens before any ledger.consume call, so a caller can safely retry
    // with a fixed config without hitting SeedLedger's "already consumed".
    expect(ledger.get('smoke-test')?.status).toBe('reserved');
  });

  it('produces challengeResult for every subject (baseline + each candidate) x every feedback entry', () => {
    const ledger = makeLedger();
    const config: WaveConfig = {
      ...baseWaveConfig(ledger),
      challenge: {
        entries: [{ anchorId: 'l2-opus', factory: adapter.baselines.random, role: 'feedback' }],
        seeds: CHALLENGE_SEEDS,
        botSeedBase: 7000,
      },
    };
    const report = runWave(adapter, config);
    expect(report.challengeResult).toBeDefined();
    const subjects = report.challengeResult?.map((r) => r.subject).sort();
    // baseline + the 3 candidates declared in baseWaveConfig.
    expect(subjects).toEqual(['baseline', 'leadHighFirst', 'noopSort', 'winCheapest'].sort());
    for (const entry of report.challengeResult ?? []) {
      expect(entry.anchorId).toBe('l2-opus');
      expect(entry.blocks).toBeGreaterThan(0);
      expect(entry.winRateCI.lower).toBeLessThanOrEqual(entry.winRateCI.upper);
    }
  });

  it('does not change any candidate verdict compared to an identical wave without a challenge', () => {
    const ledgerA = makeLedger();
    const reportWithoutChallenge = runWave(adapter, baseWaveConfig(ledgerA));

    const ledgerB = makeLedger();
    const configWithChallenge: WaveConfig = {
      ...baseWaveConfig(ledgerB),
      challenge: {
        entries: [{ anchorId: 'l2-opus', factory: adapter.baselines.random, role: 'feedback' }],
        seeds: CHALLENGE_SEEDS,
        botSeedBase: 7000,
      },
    };
    const reportWithChallenge = runWave(adapter, configWithChallenge);

    expect(reportWithChallenge.results.map((r) => ({ flag: r.flag, verdict: r.verdict, tiersPassed: r.tiersPassed }))).toEqual(
      reportWithoutChallenge.results.map((r) => ({ flag: r.flag, verdict: r.verdict, tiersPassed: r.tiersPassed })),
    );
  });

  it('omitting challenge leaves reportDigest identical to the pinned pre-D3 value', () => {
    const ledger = makeLedger();
    const report = runWave(adapter, baseWaveConfig(ledger));
    expect(report.challengeResult).toBeUndefined();
    expect(report.reportDigest).toBe(
      'sha256-afd3bca47e9bf25ca757287295f888313c6a33b5f4baf588ce78d1a060560c30',
    );
  });
});
