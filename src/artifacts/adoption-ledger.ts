/**
 * Adoption ledger: append-only record of every wave's per-candidate verdicts,
 * tier statistics, and the notes that feed the next big-loop cycle (tichu
 * harness's `strategy-history.md`, generalized). Nothing here is ever
 * mutated in place — `add` only appends, matching the seed ledger's
 * single-use-reservation philosophy for evidence integrity.
 */

import type { GameClassification } from '../kernel/classify';
import { TIER_ORDER, type PromotionCriteria } from '../kernel/gates';

/** The single classification field renderStrategyHistoryMarkdown needs to
 * label scoreDiff correctly (INTERPRETATION.md §3.5) — accepts a full
 * GameClassification or just this field. */
export type LedgerRenderClassification = Pick<GameClassification, 'scoreStructure'>;

export interface AdoptionCiInterval {
  readonly lower: number;
  readonly upper: number;
}

export interface AdoptionTierStats {
  readonly pointWinRate: number;
  readonly pointScoreDiff: number;
  readonly winRateCI?: AdoptionCiInterval;
  readonly blocks: number;
  readonly drawRate?: number;
}

export interface AdoptionEntry {
  /** Flags composed for this candidate, in application order. */
  readonly flags: readonly string[];
  readonly verdict: string;
  readonly tierStats: Record<string, AdoptionTierStats>;
  readonly failureReason?: string;
}

export interface AdoptionRecord {
  readonly waveId: string;
  readonly recordedAt: string;
  readonly comparabilityKey: string;
  readonly baselineVersion: string;
  readonly opponentId: string;
  readonly entries: readonly AdoptionEntry[];
  readonly nextLoopNotes: readonly string[];
}

function cloneTierStats(stats: AdoptionTierStats): AdoptionTierStats {
  return {
    pointWinRate: stats.pointWinRate,
    pointScoreDiff: stats.pointScoreDiff,
    blocks: stats.blocks,
    ...(stats.drawRate !== undefined ? { drawRate: stats.drawRate } : {}),
    ...(stats.winRateCI !== undefined ? { winRateCI: { ...stats.winRateCI } } : {}),
  };
}

function cloneEntry(entry: AdoptionEntry): AdoptionEntry {
  const tierStats: Record<string, AdoptionTierStats> = {};
  for (const [tier, stats] of Object.entries(entry.tierStats)) {
    tierStats[tier] = cloneTierStats(stats);
  }
  return {
    flags: [...entry.flags],
    verdict: entry.verdict,
    tierStats,
    ...(entry.failureReason !== undefined ? { failureReason: entry.failureReason } : {}),
  };
}

function cloneRecord(record: AdoptionRecord): AdoptionRecord {
  return {
    waveId: record.waveId,
    recordedAt: record.recordedAt,
    comparabilityKey: record.comparabilityKey,
    baselineVersion: record.baselineVersion,
    opponentId: record.opponentId,
    entries: record.entries.map(cloneEntry),
    nextLoopNotes: [...record.nextLoopNotes],
  };
}

const ADOPTED_VERDICT = 'adopted';
const NEAR_MISS_VERDICT = 'near-miss';

function classify(entry: AdoptionEntry): 'adopted' | 'near-miss' | 'other' {
  if (entry.verdict === ADOPTED_VERDICT) {
    return 'adopted';
  }
  if (entry.verdict === NEAR_MISS_VERDICT) {
    return 'near-miss';
  }
  return 'other';
}

export interface NearMissCandidate {
  /** Flags composed for this candidate, in application order. */
  readonly flags: readonly string[];
  /** Tier at which the candidate was last attempted and failed to pass. */
  readonly failedAtTier: string;
  readonly pointWinRate: number;
  readonly pointScoreDiff: number;
  readonly winRateCI?: AdoptionCiInterval;
  readonly gap: {
    /** criteria.minWinRate - pointWinRate; positive means the candidate fell short. */
    readonly winRateGap: number;
    /** criteria.minScoreDiff - pointScoreDiff; positive means the candidate fell short. */
    readonly scoreDiffGap: number;
  };
}

/** The tier a near-miss entry last attempted: the highest TIER_ORDER tier
 * with recorded stats (holdout+ would have yielded a different verdict). */
function lastAttemptedTier(entry: AdoptionEntry): string {
  for (let i = TIER_ORDER.length - 1; i >= 0; i--) {
    const tier = TIER_ORDER[i];
    if (tier !== undefined && entry.tierStats[tier] !== undefined) {
      return tier;
    }
  }
  throw new Error('extractNearMissCandidates: near-miss entry has no recorded tier stats');
}

/** Pulls near-miss entries out of a wave record into a machine-readable list
 * (DESIGN.md §6.1 step 2), sorted by how close each candidate came to
 * promotion (smallest winRateGap first). */
export function extractNearMissCandidates(
  record: AdoptionRecord,
  criteria: PromotionCriteria,
): readonly NearMissCandidate[] {
  const candidates: NearMissCandidate[] = [];
  for (const entry of record.entries) {
    if (classify(entry) !== 'near-miss') {
      continue;
    }
    const failedAtTier = lastAttemptedTier(entry);
    const stats = entry.tierStats[failedAtTier];
    if (stats === undefined) {
      throw new Error(`extractNearMissCandidates: missing stats for tier "${failedAtTier}"`);
    }
    candidates.push({
      flags: [...entry.flags],
      failedAtTier,
      pointWinRate: stats.pointWinRate,
      pointScoreDiff: stats.pointScoreDiff,
      ...(stats.winRateCI !== undefined ? { winRateCI: { ...stats.winRateCI } } : {}),
      gap: {
        winRateGap: criteria.minWinRate - stats.pointWinRate,
        scoreDiffGap: criteria.minScoreDiff - stats.pointScoreDiff,
      },
    });
  }
  return candidates.sort((a, b) => a.gap.winRateGap - b.gap.winRateGap);
}

function formatFlags(flags: readonly string[]): string {
  return flags.length > 0 ? flags.join('+') : '(no flags)';
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function renderEntryRow(
  entry: AdoptionEntry,
  tier: string,
  classification?: LedgerRenderClassification,
): string {
  const stats = entry.tierStats[tier];
  const winRate = stats ? formatPercent(stats.pointWinRate) : '-';
  const winLossOnly = classification?.scoreStructure === 'win-loss-only';
  const scoreDiff = winLossOnly ? 'N/A' : stats ? stats.pointScoreDiff.toFixed(3) : '-';
  const drawRate = stats && stats.drawRate !== undefined ? formatPercent(stats.drawRate) : '-';
  const blocks = stats ? String(stats.blocks) : '-';
  return `| ${formatFlags(entry.flags)} | ${entry.verdict} | ${winRate} | ${scoreDiff} | ${drawRate} | ${blocks} |`;
}

function highestPassedTier(entry: AdoptionEntry): string {
  const tiers = ['holdout', 'prune', 'smoke', 'screen'];
  for (const tier of tiers) {
    if (entry.tierStats[tier] !== undefined) {
      return tier;
    }
  }
  return 'screen';
}

export class AdoptionLedger {
  private readonly records: AdoptionRecord[] = [];

  add(record: AdoptionRecord): AdoptionRecord {
    const stored = cloneRecord(record);
    this.records.push(stored);
    return stored;
  }

  all(): readonly AdoptionRecord[] {
    return this.records.map(cloneRecord);
  }

  toJSON(): unknown {
    return { records: this.records.map(cloneRecord) };
  }

  static fromJSON(value: unknown): AdoptionLedger {
    if (typeof value !== 'object' || value === null) {
      throw new Error('AdoptionLedger.fromJSON: expected an object');
    }
    const record = value as Record<string, unknown>;
    const records = record['records'];
    if (!Array.isArray(records)) {
      throw new Error('AdoptionLedger.fromJSON: expected "records" to be an array');
    }
    const ledger = new AdoptionLedger();
    for (const raw of records) {
      ledger.add(parseAdoptionRecord(raw));
    }
    return ledger;
  }

  /** Render every recorded wave as tichu strategy-history.md-style Markdown. */
  renderStrategyHistoryMarkdown(classification?: LedgerRenderClassification): string {
    const lines: string[] = ['# STRATEGY-HISTORY', ''];
    if (classification?.scoreStructure === 'win-loss-only') {
      lines.push('_승/패 전용 게임: scoreDiff는 무의미하여 N/A로 표시_', '');
    }
    for (const record of this.records) {
      lines.push(`## Wave: ${record.waveId}`, '');
      lines.push(`- recordedAt: ${record.recordedAt}`);
      lines.push(`- comparabilityKey: ${record.comparabilityKey}`);
      lines.push(`- baselineVersion: ${record.baselineVersion}`);
      lines.push(`- opponentId: ${record.opponentId}`);
      lines.push('');

      const adopted = record.entries.filter((entry) => classify(entry) === 'adopted');
      const nearMiss = record.entries.filter((entry) => classify(entry) === 'near-miss');
      const failed = record.entries.filter((entry) => classify(entry) === 'other');

      lines.push(...renderVerdictSection('채택 (adopted)', adopted, classification));
      lines.push(...renderVerdictSection('근접 실패 (near-miss)', nearMiss, classification));
      lines.push(...renderVerdictSection('실패/선별 (failed/screened)', failed, classification));

      lines.push(
        `- 통계: 총 ${record.entries.length}개 후보 — 채택 ${adopted.length}, 근접실패 ${nearMiss.length}, 실패/선별 ${failed.length}`,
      );
      lines.push('');
      lines.push('### 다음 루프 입력', '');
      if (record.nextLoopNotes.length === 0) {
        lines.push('- (없음)');
      } else {
        for (const note of record.nextLoopNotes) {
          lines.push(`- ${note}`);
        }
      }
      lines.push('');
    }
    return lines.join('\n').trimEnd() + '\n';
  }
}

function renderVerdictSection(
  title: string,
  entries: readonly AdoptionEntry[],
  classification?: LedgerRenderClassification,
): string[] {
  const lines = [`### ${title}`, ''];
  if (entries.length === 0) {
    lines.push('- (없음)', '');
    return lines;
  }
  const winLossOnly = classification?.scoreStructure === 'win-loss-only';
  lines.push(`| flags | verdict | winRate | ${winLossOnly ? 'scoreDiff (N/A)' : 'scoreDiff'} | drawRate | blocks |`);
  lines.push('|---|---|---|---|---|---|');
  for (const entry of entries) {
    lines.push(renderEntryRow(entry, highestPassedTier(entry), classification));
    if (entry.failureReason) {
      lines.push(`  - 사유: ${entry.failureReason}`);
    }
  }
  lines.push('');
  return lines;
}

function parseCi(value: unknown, context: string): AdoptionCiInterval | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error(`AdoptionLedger.fromJSON: ${context} winRateCI must be an object`);
  }
  const record = value as Record<string, unknown>;
  const lower = record['lower'];
  const upper = record['upper'];
  if (typeof lower !== 'number' || typeof upper !== 'number') {
    throw new Error(`AdoptionLedger.fromJSON: ${context} winRateCI.lower/upper must be numbers`);
  }
  return { lower, upper };
}

function parseTierStats(value: unknown, context: string): AdoptionTierStats {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`AdoptionLedger.fromJSON: ${context} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const pointWinRate = record['pointWinRate'];
  const pointScoreDiff = record['pointScoreDiff'];
  const blocks = record['blocks'];
  const drawRate = record['drawRate'];
  if (typeof pointWinRate !== 'number' || typeof pointScoreDiff !== 'number') {
    throw new Error(`AdoptionLedger.fromJSON: ${context} pointWinRate/pointScoreDiff must be numbers`);
  }
  if (typeof blocks !== 'number' || !Number.isInteger(blocks) || blocks < 0) {
    throw new Error(`AdoptionLedger.fromJSON: ${context} blocks must be a non-negative integer`);
  }
  if (drawRate !== undefined && typeof drawRate !== 'number') {
    throw new Error(`AdoptionLedger.fromJSON: ${context} drawRate must be a number`);
  }
  const parsedCi = parseCi(record['winRateCI'], context);
  return {
    pointWinRate,
    pointScoreDiff,
    blocks,
    ...(drawRate !== undefined ? { drawRate: drawRate as number } : {}),
    ...(parsedCi !== undefined ? { winRateCI: parsedCi } : {}),
  };
}

function parseEntry(value: unknown, index: number): AdoptionEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`AdoptionLedger.fromJSON: entries[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const flags = record['flags'];
  const verdict = record['verdict'];
  const tierStats = record['tierStats'];
  const failureReason = record['failureReason'];

  if (!Array.isArray(flags) || !flags.every((flag) => typeof flag === 'string')) {
    throw new Error(`AdoptionLedger.fromJSON: entries[${index}].flags must be a string array`);
  }
  if (typeof verdict !== 'string') {
    throw new Error(`AdoptionLedger.fromJSON: entries[${index}].verdict must be a string`);
  }
  if (typeof tierStats !== 'object' || tierStats === null) {
    throw new Error(`AdoptionLedger.fromJSON: entries[${index}].tierStats must be an object`);
  }
  if (failureReason !== undefined && typeof failureReason !== 'string') {
    throw new Error(`AdoptionLedger.fromJSON: entries[${index}].failureReason must be a string`);
  }

  const parsedTierStats: Record<string, AdoptionTierStats> = {};
  for (const [tier, stats] of Object.entries(tierStats as Record<string, unknown>)) {
    parsedTierStats[tier] = parseTierStats(stats, `entries[${index}].tierStats["${tier}"]`);
  }

  return {
    flags: [...(flags as string[])],
    verdict,
    tierStats: parsedTierStats,
    ...(failureReason !== undefined ? { failureReason: failureReason as string } : {}),
  };
}

function parseAdoptionRecord(value: unknown): AdoptionRecord {
  if (typeof value !== 'object' || value === null) {
    throw new Error('AdoptionLedger.fromJSON: expected a record object');
  }
  const record = value as Record<string, unknown>;
  const waveId = record['waveId'];
  const recordedAt = record['recordedAt'];
  const comparabilityKey = record['comparabilityKey'];
  const baselineVersion = record['baselineVersion'];
  const opponentId = record['opponentId'];
  const entries = record['entries'];
  const nextLoopNotes = record['nextLoopNotes'];

  if (typeof waveId !== 'string' || waveId.length === 0) {
    throw new Error('AdoptionLedger.fromJSON: waveId must be a non-empty string');
  }
  if (typeof recordedAt !== 'string') {
    throw new Error(`AdoptionLedger.fromJSON: record "${waveId}" recordedAt must be a string`);
  }
  if (typeof comparabilityKey !== 'string') {
    throw new Error(`AdoptionLedger.fromJSON: record "${waveId}" comparabilityKey must be a string`);
  }
  if (typeof baselineVersion !== 'string') {
    throw new Error(`AdoptionLedger.fromJSON: record "${waveId}" baselineVersion must be a string`);
  }
  if (typeof opponentId !== 'string') {
    throw new Error(`AdoptionLedger.fromJSON: record "${waveId}" opponentId must be a string`);
  }
  if (!Array.isArray(entries)) {
    throw new Error(`AdoptionLedger.fromJSON: record "${waveId}" entries must be an array`);
  }
  if (!Array.isArray(nextLoopNotes) || !nextLoopNotes.every((note) => typeof note === 'string')) {
    throw new Error(`AdoptionLedger.fromJSON: record "${waveId}" nextLoopNotes must be a string array`);
  }

  return {
    waveId,
    recordedAt,
    comparabilityKey,
    baselineVersion,
    opponentId,
    entries: entries.map((entry, index) => parseEntry(entry, index)),
    nextLoopNotes: [...(nextLoopNotes as string[])],
  };
}
