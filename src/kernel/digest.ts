/**
 * Digest integrity: canonical JSON serialization + SHA-256 sealing of
 * experiment artifacts, so evidence tampering/drift can be detected.
 */

import { createHash } from 'crypto';

function canonicalize(value: unknown): unknown {
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`canonicalJson: cannot serialize a ${typeof value}`);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const item = record[key];
    if (item === undefined) {
      continue;
    }
    result[key] = canonicalize(item);
  }
  return result;
}

/** Recursively key-sorted canonical JSON (array order preserved, undefined fields dropped). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** sha256-<hex> digest of the canonical JSON form of value. */
export function sha256Digest(value: unknown): string {
  const hash = createHash('sha256').update(canonicalJson(value)).digest('hex');
  return `sha256-${hash}`;
}

const SHA256_DIGEST_PATTERN = /^sha256-[0-9a-f]{64}$/;

export function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST_PATTERN.test(value);
}
