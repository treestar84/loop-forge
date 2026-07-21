import { sha256Digest } from './digest';

export interface ComparabilityKeyInput {
  readonly gameId: string;
  readonly specDigest: string;
  readonly baselineVersion: string;
  readonly opponentId: string;
  readonly seedBankIds: readonly string[];
}

/**
 * Digest the 4-factor comparability context (INTERPRETATION.md §1): adapter
 * identity (via caller-computed specDigest), baseline version, opponent
 * identity, and seed banks used. Two reports are only directly comparable
 * when this key matches.
 *
 * Lives in the kernel (not artifacts) because the wave runner stamps every
 * WaveReport with this key — artifacts re-exports it for run-store consumers.
 */
export function computeComparabilityKey(input: ComparabilityKeyInput): string {
  return sha256Digest({
    gameId: input.gameId,
    specDigest: input.specDigest,
    baselineVersion: input.baselineVersion,
    opponentId: input.opponentId,
    seedBankIds: [...input.seedBankIds],
  });
}
