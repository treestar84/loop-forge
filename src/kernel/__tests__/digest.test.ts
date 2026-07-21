import { canonicalJson, isSha256Digest, sha256Digest } from '../digest';

describe('canonicalJson', () => {
  it('is invariant to key order', () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { a: 2, c: { y: 2, z: 1 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it('drops undefined fields but keeps null', () => {
    const value = { a: undefined, b: null, c: 1 };
    expect(canonicalJson(value)).toBe('{"b":null,"c":1}');
  });

  it('throws on functions and symbols', () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
    expect(() => canonicalJson({ s: Symbol('x') })).toThrow();
  });

  it('recursively sorts nested arrays of objects', () => {
    const value = [{ b: 1, a: 2 }, { d: 3, c: 4 }];
    expect(canonicalJson(value)).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });
});

describe('sha256Digest', () => {
  it('is deterministic and key-order independent', () => {
    const a = sha256Digest({ x: 1, y: 2 });
    const b = sha256Digest({ y: 2, x: 1 });
    expect(a).toBe(b);
    expect(isSha256Digest(a)).toBe(true);
  });

  it('differs for different content', () => {
    expect(sha256Digest({ x: 1 })).not.toBe(sha256Digest({ x: 2 }));
  });
});

describe('isSha256Digest', () => {
  it('accepts well-formed digests and rejects everything else', () => {
    expect(isSha256Digest(`sha256-${'a'.repeat(64)}`)).toBe(true);
    expect(isSha256Digest('sha256-short')).toBe(false);
    expect(isSha256Digest(`SHA256-${'a'.repeat(64)}`)).toBe(false);
    expect(isSha256Digest(123)).toBe(false);
    expect(isSha256Digest(null)).toBe(false);
  });
});
