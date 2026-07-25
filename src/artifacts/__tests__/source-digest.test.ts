import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeSourceDigest } from '../source-digest';
import { isSha256Digest } from '../../kernel/digest';

describe('computeSourceDigest', () => {
  let dir: string;
  let fileA: string;
  let fileB: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'source-digest-test-'));
    fileA = join(dir, 'a.ts');
    fileB = join(dir, 'b.ts');
    writeFileSync(fileA, 'export const a = 1;\n');
    writeFileSync(fileB, 'export const b = 2;\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces a well-formed sha256 digest', () => {
    const digest = computeSourceDigest([fileA, fileB]);
    expect(isSha256Digest(digest)).toBe(true);
  });

  it('is deterministic for the same file set', () => {
    const first = computeSourceDigest([fileA, fileB]);
    const second = computeSourceDigest([fileA, fileB]);
    expect(first).toBe(second);
  });

  it('is independent of the input path order', () => {
    const forward = computeSourceDigest([fileA, fileB]);
    const reversed = computeSourceDigest([fileB, fileA]);
    expect(forward).toBe(reversed);
  });

  it('changes when a file\'s content changes', () => {
    const before = computeSourceDigest([fileA, fileB]);
    writeFileSync(fileA, 'export const a = 999;\n');
    const after = computeSourceDigest([fileA, fileB]);
    expect(after).not.toBe(before);
  });

  it('changes when the file set changes', () => {
    const onlyA = computeSourceDigest([fileA]);
    const both = computeSourceDigest([fileA, fileB]);
    expect(onlyA).not.toBe(both);
  });
});
