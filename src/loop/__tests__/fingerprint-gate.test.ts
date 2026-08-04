import { evaluateFingerprintGate } from '../fingerprint-gate';

describe('evaluateFingerprintGate (docs/adr/0015-calibrated-l3-fingerprint-gate.md)', () => {
  it('fast-passes below the 70% absolute threshold regardless of floor', () => {
    const result = evaluateFingerprintGate(0.5, 0.9);
    expect(result.fastPass).toBe(true);
    expect(result.excess).toBe(0);
    expect(result.pass).toBe(true);
  });

  it('trivially passes when the floor is at or above the agreement (independent-pair baseline already this high)', () => {
    const result = evaluateFingerprintGate(0.75, 0.8);
    expect(result.fastPass).toBe(false);
    expect(result.excess).toBe(0);
    expect(result.pass).toBe(true);
  });

  it('trivially passes when floor exactly equals agreement', () => {
    const result = evaluateFingerprintGate(0.8, 0.8);
    expect(result.excess).toBe(0);
    expect(result.pass).toBe(true);
  });

  it('fails exactly at the excess=0.5 boundary (excess < 0.5 is required, not <=)', () => {
    // agreement=0.85, floor=0.7 -> excess = (0.85-0.7)/(1-0.7) = 0.5
    const result = evaluateFingerprintGate(0.85, 0.7);
    expect(result.fastPass).toBe(false);
    expect(result.excess).toBeCloseTo(0.5, 10);
    expect(result.pass).toBe(false);
  });

  it('passes just below the excess=0.5 boundary', () => {
    // agreement=0.84, floor=0.7 -> excess = 0.14/0.3 = 0.4667 < 0.5
    const result = evaluateFingerprintGate(0.84, 0.7);
    expect(result.fastPass).toBe(false);
    expect(result.excess).toBeLessThan(0.5);
    expect(result.pass).toBe(true);
  });

  it('fails just above the excess=0.5 boundary', () => {
    // agreement=0.86, floor=0.7 -> excess = 0.16/0.3 = 0.5333 > 0.5
    const result = evaluateFingerprintGate(0.86, 0.7);
    expect(result.excess).toBeGreaterThan(0.5);
    expect(result.pass).toBe(false);
  });

  it('reproduces the gomoku registration decision (agreement 69.2% fast-passes)', () => {
    const result = evaluateFingerprintGate(0.692, 0.5);
    expect(result.fastPass).toBe(true);
    expect(result.pass).toBe(true);
  });

  it('reproduces the splendor registration decision (agreement 49.8% fast-passes)', () => {
    const result = evaluateFingerprintGate(0.498, 0.5);
    expect(result.fastPass).toBe(true);
    expect(result.pass).toBe(true);
  });

  it('wingspan 84.0% agreement fails when the floor is low (excess well above 0.5)', () => {
    // e.g. floor=0.3 -> excess = 0.54/0.7 = 0.7714
    const result = evaluateFingerprintGate(0.84, 0.3);
    expect(result.fastPass).toBe(false);
    expect(result.excess).toBeGreaterThan(0.5);
    expect(result.pass).toBe(false);
  });

  it('wingspan 84.0% agreement passes when the floor is high enough (excess below 0.5)', () => {
    // floor=0.75 -> excess = 0.09/0.25 = 0.36 < 0.5
    const result = evaluateFingerprintGate(0.84, 0.75);
    expect(result.fastPass).toBe(false);
    expect(result.excess).toBeLessThan(0.5);
    expect(result.pass).toBe(true);
  });

  it('handles floor=1 without dividing by zero (agreement<=1=floor is always a trivial pass)', () => {
    const result = evaluateFingerprintGate(0.9, 1);
    expect(Number.isFinite(result.excess)).toBe(true);
    expect(result.pass).toBe(true);
  });

  it('handles agreement=1, floor=0 as the maximal-excess case (excess=1, fails)', () => {
    const result = evaluateFingerprintGate(1, 0);
    expect(result.excess).toBeCloseTo(1, 10);
    expect(result.pass).toBe(false);
  });
});
