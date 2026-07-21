import { createSprt } from '../sprt';

const config = { p0: 0.5, p1: 0.55, alpha: 0.05, beta: 0.05 };

describe('createSprt', () => {
  it('accepts under a strong, consistent winning signal', () => {
    const sprt = createSprt(config);
    let verdict = sprt.verdict();
    for (let i = 0; i < 2000 && verdict === 'continue'; i += 1) {
      sprt.update(0.62);
      verdict = sprt.verdict();
    }
    expect(verdict).toBe('accept');
  });

  it('rejects under a losing signal', () => {
    const sprt = createSprt(config);
    let verdict = sprt.verdict();
    for (let i = 0; i < 2000 && verdict === 'continue'; i += 1) {
      sprt.update(0.4);
      verdict = sprt.verdict();
    }
    expect(verdict).toBe('reject');
  });

  it('continues under a pure no-op signal exactly at p0, llr matches closed form', () => {
    const sprt = createSprt(config);
    const perObservation =
      0.5 * Math.log(config.p1 / config.p0) + 0.5 * Math.log((1 - config.p1) / (1 - config.p0));
    for (let i = 0; i < 50; i += 1) {
      sprt.update(0.5);
    }
    expect(sprt.verdict()).toBe('continue');
    expect(sprt.llr()).toBeCloseTo(perObservation * 50, 10);
  });

  it('llr accumulates monotonically in the expected direction for winning observations', () => {
    const sprt = createSprt(config);
    sprt.update(0.6);
    const first = sprt.llr();
    sprt.update(0.6);
    const second = sprt.llr();
    expect(second).toBeGreaterThan(first);
  });

  it('validates config bounds', () => {
    expect(() => createSprt({ p0: 0.6, p1: 0.5, alpha: 0.05, beta: 0.05 })).toThrow();
    expect(() => createSprt({ p0: 0, p1: 0.5, alpha: 0.05, beta: 0.05 })).toThrow();
    expect(() => createSprt({ p0: 0.5, p1: 1, alpha: 0.05, beta: 0.05 })).toThrow();
    expect(() => createSprt({ p0: 0.5, p1: 0.55, alpha: 0.5, beta: 0.05 })).toThrow();
    expect(() => createSprt({ p0: 0.5, p1: 0.55, alpha: 0.05, beta: 0.5 })).toThrow();
  });

  it('validates update input range', () => {
    const sprt = createSprt(config);
    expect(() => sprt.update(-0.1)).toThrow();
    expect(() => sprt.update(1.1)).toThrow();
    expect(() => sprt.update(Number.NaN)).toThrow();
  });
});
