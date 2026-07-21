import { SeedLedger } from '../seed-ledger';

describe('SeedLedger', () => {
  it('reserves non-overlapping ranges and lists seeds', () => {
    const ledger = new SeedLedger();
    const bank = ledger.reserve({
      bankId: 'smoke-1',
      range: { start: 0, end: 4 },
      purpose: 'smoke',
      reservedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(bank.status).toBe('reserved');
    expect(ledger.seedsOf('smoke-1')).toEqual([0, 1, 2, 3, 4]);
  });

  it('rejects duplicate bankId', () => {
    const ledger = new SeedLedger();
    ledger.reserve({
      bankId: 'a',
      range: { start: 0, end: 1 },
      purpose: 'x',
      reservedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(() =>
      ledger.reserve({
        bankId: 'a',
        range: { start: 5, end: 6 },
        purpose: 'y',
        reservedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects overlapping ranges', () => {
    const ledger = new SeedLedger();
    ledger.reserve({
      bankId: 'a',
      range: { start: 0, end: 10 },
      purpose: 'x',
      reservedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(() =>
      ledger.reserve({
        bankId: 'b',
        range: { start: 10, end: 20 },
        purpose: 'y',
        reservedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow();
    expect(() =>
      ledger.reserve({
        bankId: 'c',
        range: { start: -5, end: -1 },
        purpose: 'y',
        reservedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects invalid ranges (start > end, non-integer, negative)', () => {
    const ledger = new SeedLedger();
    expect(() =>
      ledger.reserve({
        bankId: 'bad1',
        range: { start: 5, end: 1 },
        purpose: 'x',
        reservedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow();
    expect(() =>
      ledger.reserve({
        bankId: 'bad2',
        range: { start: 0.5, end: 1 },
        purpose: 'x',
        reservedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow();
    expect(() =>
      ledger.reserve({
        bankId: 'bad3',
        range: { start: -1, end: 1 },
        purpose: 'x',
        reservedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('consumes once and rejects re-consumption', () => {
    const ledger = new SeedLedger();
    ledger.reserve({
      bankId: 'holdout-1',
      range: { start: 0, end: 3 },
      purpose: 'holdout',
      reservedAt: '2026-01-01T00:00:00.000Z',
    });
    const consumed = ledger.consume('holdout-1', '2026-01-02T00:00:00.000Z');
    expect(consumed.status).toBe('consumed');
    expect(consumed.consumedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(() => ledger.consume('holdout-1', '2026-01-03T00:00:00.000Z')).toThrow();
  });

  it('rejects consuming an unknown bank', () => {
    const ledger = new SeedLedger();
    expect(() => ledger.consume('nope', '2026-01-01T00:00:00.000Z')).toThrow();
  });

  it('round-trips through toJSON/fromJSON', () => {
    const ledger = new SeedLedger();
    ledger.reserve({
      bankId: 'a',
      range: { start: 0, end: 2 },
      purpose: 'smoke',
      reservedAt: '2026-01-01T00:00:00.000Z',
    });
    ledger.reserve({
      bankId: 'b',
      range: { start: 3, end: 5 },
      purpose: 'holdout',
      reservedAt: '2026-01-01T00:00:00.000Z',
    });
    ledger.consume('b', '2026-01-02T00:00:00.000Z');

    const serialized = JSON.parse(JSON.stringify(ledger.toJSON()));
    const restored = SeedLedger.fromJSON(serialized);

    expect(restored.get('a')).toEqual(ledger.get('a'));
    expect(restored.get('b')).toEqual(ledger.get('b'));
    // Restored ledger still enforces the same invariants.
    expect(() => restored.consume('b', '2026-01-03T00:00:00.000Z')).toThrow();
  });

  it('strictly validates fromJSON input', () => {
    expect(() => SeedLedger.fromJSON(null)).toThrow();
    expect(() => SeedLedger.fromJSON({})).toThrow();
    expect(() => SeedLedger.fromJSON({ banks: [{ bankId: 'a' }] })).toThrow();
    expect(() =>
      SeedLedger.fromJSON({
        banks: [
          {
            bankId: 'a',
            range: { start: 0, end: 1 },
            purpose: 'x',
            status: 'consumed',
            reservedAt: '2026-01-01T00:00:00.000Z',
            // missing consumedAt while status is consumed
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      SeedLedger.fromJSON({
        banks: [
          {
            bankId: 'dup',
            range: { start: 0, end: 1 },
            purpose: 'x',
            status: 'reserved',
            reservedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            bankId: 'dup',
            range: { start: 2, end: 3 },
            purpose: 'y',
            status: 'reserved',
            reservedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    ).toThrow();
  });
});
