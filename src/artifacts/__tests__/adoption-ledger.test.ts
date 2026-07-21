import { AdoptionLedger, type AdoptionRecord } from '../adoption-ledger';

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
