import { AdoptionLedger, extractNearMissCandidates, type AdoptionRecord } from '../adoption-ledger';
import { DEFAULT_CRITERIA } from '../../kernel/gates';

function sampleRecord(waveId: string): AdoptionRecord {
  return {
    waveId,
    recordedAt: '2026-01-01T00:00:00.000Z',
    comparabilityKey: 'sha256-deadbeef',
    baselineVersion: 'v1',
    opponentId: 'heuristic',
    entries: [
      {
        flags: ['winCheapest'],
        verdict: 'adopted',
        tierStats: {
          holdout: { pointWinRate: 0.62, pointScoreDiff: 0.8, blocks: 150, drawRate: 0.05, winRateCI: { lower: 0.55, upper: 0.68 } },
        },
      },
      {
        flags: ['noopSort'],
        verdict: 'screened-out',
        tierStats: {},
        failureReason: 'behavioral no-op',
      },
      {
        flags: ['leadHighFirst'],
        verdict: 'near-miss',
        tierStats: {
          smoke: { pointWinRate: 0.55, pointScoreDiff: 0.1, blocks: 40, drawRate: 0.2 },
        },
      },
    ],
    nextLoopNotes: ['다음 웨이브는 leadHighFirst 변형을 재설계'],
  };
}

function mixedVerdictRecord(): AdoptionRecord {
  return {
    waveId: 'wave-mixed',
    recordedAt: '2026-01-01T00:00:00.000Z',
    comparabilityKey: 'sha256-deadbeef',
    baselineVersion: 'v1',
    opponentId: 'heuristic',
    entries: [
      {
        flags: ['winCheapest'],
        verdict: 'adopted',
        tierStats: {
          holdout: { pointWinRate: 0.6, pointScoreDiff: 6, blocks: 150 },
        },
      },
      {
        flags: ['noopSort'],
        verdict: 'failed',
        tierStats: {
          screen: { pointWinRate: 0.4, pointScoreDiff: -2, blocks: 20 },
        },
      },
      {
        // near-miss A: failed at 'prune', 0.03 short on win rate, 1.0 short on score diff
        flags: ['leadHighFirst'],
        verdict: 'near-miss',
        tierStats: {
          smoke: { pointWinRate: 0.55, pointScoreDiff: 6, blocks: 40 },
          prune: {
            pointWinRate: 0.5,
            pointScoreDiff: 4,
            blocks: 80,
            winRateCI: { lower: 0.44, upper: 0.56 },
          },
        },
      },
      {
        // near-miss B: failed at 'smoke', already over win rate but short on score diff
        flags: ['winCheapest', 'discardHighFirst'],
        verdict: 'near-miss',
        tierStats: {
          smoke: { pointWinRate: 0.54, pointScoreDiff: 3, blocks: 40 },
        },
      },
    ],
    nextLoopNotes: [],
  };
}

describe('extractNearMissCandidates', () => {
  it('extracts only near-miss entries with a structured gap-to-promotion', () => {
    const candidates = extractNearMissCandidates(mixedVerdictRecord(), DEFAULT_CRITERIA);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.flags.join('+') !== 'winCheapest')).toBe(true);
    expect(candidates.every((c) => c.flags.join('+') !== 'noopSort')).toBe(true);
  });

  it('picks the last-attempted (highest) tier as failedAtTier and computes gap correctly', () => {
    const candidates = extractNearMissCandidates(mixedVerdictRecord(), DEFAULT_CRITERIA);
    const a = candidates.find((c) => c.flags.includes('leadHighFirst'));
    expect(a).toBeDefined();
    expect(a?.failedAtTier).toBe('prune');
    expect(a?.pointWinRate).toBeCloseTo(0.5);
    expect(a?.pointScoreDiff).toBeCloseTo(4);
    expect(a?.winRateCI).toEqual({ lower: 0.44, upper: 0.56 });
    expect(a?.gap.winRateGap).toBeCloseTo(0.03);
    expect(a?.gap.scoreDiffGap).toBeCloseTo(1);

    const b = candidates.find((c) => c.flags.includes('discardHighFirst'));
    expect(b).toBeDefined();
    expect(b?.failedAtTier).toBe('smoke');
    expect(b?.gap.winRateGap).toBeCloseTo(-0.01);
    expect(b?.gap.scoreDiffGap).toBeCloseTo(2);
    expect(b?.winRateCI).toBeUndefined();
  });

  it('sorts ascending by gap.winRateGap (closest-to-promotion first)', () => {
    const candidates = extractNearMissCandidates(mixedVerdictRecord(), DEFAULT_CRITERIA);
    expect(candidates.map((c) => c.flags.join('+'))).toEqual([
      'winCheapest+discardHighFirst',
      'leadHighFirst',
    ]);
  });

  it('reports "regression" as failedAtTier when a candidate has holdout+regression stats (O10)', () => {
    const record: AdoptionRecord = {
      waveId: 'wave-regression',
      recordedAt: '2026-01-01T00:00:00.000Z',
      comparabilityKey: 'sha256-deadbeef',
      baselineVersion: 'v1',
      opponentId: 'heuristic',
      entries: [
        {
          flags: ['override'],
          verdict: 'near-miss',
          tierStats: {
            holdout: { pointWinRate: 0.65, pointScoreDiff: 6, blocks: 150 },
            regression: { pointWinRate: 0.2, pointScoreDiff: -1, blocks: 40 },
          },
        },
      ],
      nextLoopNotes: [],
    };
    const candidates = extractNearMissCandidates(record, DEFAULT_CRITERIA);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.failedAtTier).toBe('regression');
    expect(candidates[0]?.pointWinRate).toBeCloseTo(0.2);
  });

  it('returns an empty array when there are no near-miss entries', () => {
    const record: AdoptionRecord = {
      waveId: 'wave-clean',
      recordedAt: '2026-01-01T00:00:00.000Z',
      comparabilityKey: 'sha256-deadbeef',
      baselineVersion: 'v1',
      opponentId: 'heuristic',
      entries: [
        {
          flags: ['winCheapest'],
          verdict: 'adopted',
          tierStats: { holdout: { pointWinRate: 0.6, pointScoreDiff: 6, blocks: 150 } },
        },
      ],
      nextLoopNotes: [],
    };
    expect(extractNearMissCandidates(record, DEFAULT_CRITERIA)).toEqual([]);
  });
});

describe('AdoptionLedger', () => {
  it('is append-only: add() appends and all() returns every record', () => {
    const ledger = new AdoptionLedger();
    ledger.add(sampleRecord('wave-1'));
    ledger.add(sampleRecord('wave-2'));
    expect(ledger.all().map((r) => r.waveId)).toEqual(['wave-1', 'wave-2']);
  });

  it('add() does not let the caller mutate stored state via the input reference', () => {
    const ledger = new AdoptionLedger();
    const record = sampleRecord('wave-1');
    ledger.add(record);
    (record.nextLoopNotes as string[]).push('tampered');
    expect(ledger.all()[0]?.nextLoopNotes).toEqual(['다음 웨이브는 leadHighFirst 변형을 재설계']);
  });

  it('round-trips through toJSON/fromJSON', () => {
    const ledger = new AdoptionLedger();
    ledger.add(sampleRecord('wave-1'));
    const restored = AdoptionLedger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())));
    expect(restored.all()).toEqual(ledger.all());
  });

  it('fromJSON rejects malformed input', () => {
    expect(() => AdoptionLedger.fromJSON(null)).toThrow();
    expect(() => AdoptionLedger.fromJSON({})).toThrow();
    expect(() => AdoptionLedger.fromJSON({ records: [{ waveId: 'x' }] })).toThrow();
  });

  it('renders a Markdown strategy history with adopted/near-miss/failed sections and next-loop notes', () => {
    const ledger = new AdoptionLedger();
    ledger.add(sampleRecord('wave-1'));
    const markdown = ledger.renderStrategyHistoryMarkdown();
    expect(markdown).toContain('wave-1');
    expect(markdown).toContain('winCheapest');
    expect(markdown).toContain('adopted');
    expect(markdown).toContain('근접 실패');
    expect(markdown).toContain('leadHighFirst');
    expect(markdown).toContain('noopSort');
    expect(markdown).toContain('behavioral no-op');
    expect(markdown).toContain('다음 웨이브는 leadHighFirst 변형을 재설계');
  });

  it('omits classification context when no classification is passed (back-compat)', () => {
    const ledger = new AdoptionLedger();
    ledger.add(sampleRecord('wave-1'));
    const withoutArg = ledger.renderStrategyHistoryMarkdown();
    const withUndefinedArg = ledger.renderStrategyHistoryMarkdown(undefined);
    expect(withUndefinedArg).toEqual(withoutArg);
    expect(withoutArg).toContain('0.800');
    expect(withoutArg).not.toContain('scoreDiff는 무의미');
    expect(withoutArg).toContain('| scoreDiff |');
  });

  it('replaces scoreDiff with N/A for win-loss-only games', () => {
    const ledger = new AdoptionLedger();
    ledger.add(sampleRecord('wave-1'));
    const markdown = ledger.renderStrategyHistoryMarkdown({ scoreStructure: 'win-loss-only' });
    expect(markdown).toContain('scoreDiff는 무의미');
    expect(markdown).toContain('scoreDiff (N/A)');
    expect(markdown).not.toContain('0.800');
    expect(markdown).not.toContain('0.1 |');
  });

  it('keeps raw scoreDiff numbers for scored games', () => {
    const ledger = new AdoptionLedger();
    ledger.add(sampleRecord('wave-1'));
    const markdown = ledger.renderStrategyHistoryMarkdown({ scoreStructure: 'scored' });
    expect(markdown).toContain('0.800');
    expect(markdown).not.toContain('scoreDiff는 무의미');
  });

  it('renders a placeholder when a wave has no entries in a given bucket', () => {
    const ledger = new AdoptionLedger();
    ledger.add({
      waveId: 'wave-empty',
      recordedAt: '2026-01-01T00:00:00.000Z',
      comparabilityKey: 'sha256-empty',
      baselineVersion: 'v1',
      opponentId: 'heuristic',
      entries: [],
      nextLoopNotes: [],
    });
    const markdown = ledger.renderStrategyHistoryMarkdown();
    expect(markdown).toContain('(없음)');
  });
});
