/**
 * Seed ledger: in-memory reservation/consumption record for seed ranges.
 *
 * Prevents the fixed-seed overfitting failure mode by making holdout/graduation
 * banks explicit, non-overlapping, single-use reservations. No file I/O —
 * callers that need persistence serialize via toJSON()/fromJSON().
 */

export type SeedBankStatus = 'reserved' | 'consumed';

export interface SeedRange {
  readonly start: number;
  readonly end: number;
}

export interface SeedBank {
  readonly bankId: string;
  readonly range: SeedRange;
  readonly purpose: string;
  readonly status: SeedBankStatus;
  readonly reservedAt: string;
  readonly consumedAt?: string;
}

export interface ReserveInput {
  readonly bankId: string;
  readonly range: SeedRange;
  readonly purpose: string;
  readonly reservedAt: string;
}

function validateRange(range: SeedRange): void {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) {
    throw new Error(`SeedBank range bounds must be integers: ${JSON.stringify(range)}`);
  }
  if (range.start < 0) {
    throw new Error(`SeedBank range start must be >= 0: ${JSON.stringify(range)}`);
  }
  if (range.start > range.end) {
    throw new Error(`SeedBank range start must be <= end: ${JSON.stringify(range)}`);
  }
}

function rangesOverlap(a: SeedRange, b: SeedRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

export class SeedLedger {
  private readonly banks = new Map<string, SeedBank>();

  reserve(input: ReserveInput): SeedBank {
    if (this.banks.has(input.bankId)) {
      throw new Error(`SeedLedger: duplicate bankId "${input.bankId}"`);
    }
    validateRange(input.range);
    for (const existing of this.banks.values()) {
      if (rangesOverlap(existing.range, input.range)) {
        throw new Error(
          `SeedLedger: range for bank "${input.bankId}" overlaps existing bank "${existing.bankId}"`,
        );
      }
    }
    const bank: SeedBank = {
      bankId: input.bankId,
      range: { start: input.range.start, end: input.range.end },
      purpose: input.purpose,
      status: 'reserved',
      reservedAt: input.reservedAt,
    };
    this.banks.set(bank.bankId, bank);
    return bank;
  }

  consume(bankId: string, consumedAt: string): SeedBank {
    const bank = this.banks.get(bankId);
    if (!bank) {
      throw new Error(`SeedLedger: unknown bankId "${bankId}"`);
    }
    if (bank.status === 'consumed') {
      throw new Error(`SeedLedger: bank "${bankId}" already consumed`);
    }
    const consumed: SeedBank = {
      ...bank,
      status: 'consumed',
      consumedAt,
    };
    this.banks.set(bankId, consumed);
    return consumed;
  }

  get(bankId: string): SeedBank | undefined {
    return this.banks.get(bankId);
  }

  list(): SeedBank[] {
    return [...this.banks.values()];
  }

  seedsOf(bankId: string): number[] {
    const bank = this.banks.get(bankId);
    if (!bank) {
      throw new Error(`SeedLedger: unknown bankId "${bankId}"`);
    }
    const seeds: number[] = [];
    for (let seed = bank.range.start; seed <= bank.range.end; seed += 1) {
      seeds.push(seed);
    }
    return seeds;
  }

  toJSON(): unknown {
    return { banks: this.list() };
  }

  static fromJSON(value: unknown): SeedLedger {
    if (typeof value !== 'object' || value === null) {
      throw new Error('SeedLedger.fromJSON: expected an object');
    }
    const record = value as Record<string, unknown>;
    const banksValue = record['banks'];
    if (!Array.isArray(banksValue)) {
      throw new Error('SeedLedger.fromJSON: expected "banks" to be an array');
    }
    const ledger = new SeedLedger();
    for (const raw of banksValue) {
      const bank = parseSeedBank(raw);
      if (ledger.banks.has(bank.bankId)) {
        throw new Error(`SeedLedger.fromJSON: duplicate bankId "${bank.bankId}"`);
      }
      ledger.banks.set(bank.bankId, bank);
    }
    return ledger;
  }
}

function parseSeedBank(value: unknown): SeedBank {
  if (typeof value !== 'object' || value === null) {
    throw new Error('SeedLedger.fromJSON: expected a bank object');
  }
  const record = value as Record<string, unknown>;
  const bankId = record['bankId'];
  const range = record['range'];
  const purpose = record['purpose'];
  const status = record['status'];
  const reservedAt = record['reservedAt'];
  const consumedAt = record['consumedAt'];

  if (typeof bankId !== 'string' || bankId.length === 0) {
    throw new Error('SeedLedger.fromJSON: bankId must be a non-empty string');
  }
  if (typeof purpose !== 'string') {
    throw new Error(`SeedLedger.fromJSON: bank "${bankId}" purpose must be a string`);
  }
  if (status !== 'reserved' && status !== 'consumed') {
    throw new Error(`SeedLedger.fromJSON: bank "${bankId}" status must be reserved|consumed`);
  }
  if (typeof reservedAt !== 'string') {
    throw new Error(`SeedLedger.fromJSON: bank "${bankId}" reservedAt must be a string`);
  }
  if (typeof range !== 'object' || range === null) {
    throw new Error(`SeedLedger.fromJSON: bank "${bankId}" range must be an object`);
  }
  const rangeRecord = range as Record<string, unknown>;
  const start = rangeRecord['start'];
  const end = rangeRecord['end'];
  if (typeof start !== 'number' || typeof end !== 'number') {
    throw new Error(`SeedLedger.fromJSON: bank "${bankId}" range.start/end must be numbers`);
  }
  const parsedRange: SeedRange = { start, end };
  validateRange(parsedRange);

  if (status === 'consumed') {
    if (typeof consumedAt !== 'string') {
      throw new Error(`SeedLedger.fromJSON: consumed bank "${bankId}" requires consumedAt string`);
    }
    return {
      bankId,
      range: parsedRange,
      purpose,
      status: 'consumed',
      reservedAt,
      consumedAt,
    };
  }

  if (consumedAt !== undefined) {
    throw new Error(`SeedLedger.fromJSON: reserved bank "${bankId}" must not have consumedAt`);
  }

  return {
    bankId,
    range: parsedRange,
    purpose,
    status: 'reserved',
    reservedAt,
  };
}
