/**
 * Sequential Probability Ratio Test (Fishtest-style), Bernoulli win-rate model.
 *
 * Used as the smoke-tier gate: candidates with a clear effect finish early,
 * ambiguous candidates get more games instead of a fixed, wasteful budget.
 */

export interface SprtConfig {
  /** Null-hypothesis win rate, e.g. 0.50. */
  readonly p0: number;
  /** Alternative-hypothesis win rate, e.g. 0.55. */
  readonly p1: number;
  readonly alpha: number;
  readonly beta: number;
}

export type SprtVerdict = 'accept' | 'reject' | 'continue';

export interface Sprt {
  /** winFraction is a per-block Bernoulli-style observation in [0,1]; 0.5 = draw. */
  update(winFraction: number): void;
  llr(): number;
  verdict(): SprtVerdict;
}

function validateConfig(config: SprtConfig): void {
  if (!(config.p0 > 0 && config.p0 < config.p1 && config.p1 < 1)) {
    throw new Error(
      `SprtConfig requires 0 < p0 < p1 < 1, got p0=${config.p0}, p1=${config.p1}`,
    );
  }
  if (!(config.alpha > 0 && config.alpha < 0.5)) {
    throw new Error(`SprtConfig requires 0 < alpha < 0.5, got alpha=${config.alpha}`);
  }
  if (!(config.beta > 0 && config.beta < 0.5)) {
    throw new Error(`SprtConfig requires 0 < beta < 0.5, got beta=${config.beta}`);
  }
}

export function createSprt(config: SprtConfig): Sprt {
  validateConfig(config);

  const { p0, p1, alpha, beta } = config;
  const upperBound = Math.log((1 - beta) / alpha);
  const lowerBound = Math.log(beta / (1 - alpha));

  let logLikelihoodRatio = 0;

  return {
    update(winFraction: number): void {
      if (Number.isNaN(winFraction) || winFraction < 0 || winFraction > 1) {
        throw new Error(`Sprt.update: winFraction must be in [0,1], got ${winFraction}`);
      }
      logLikelihoodRatio +=
        winFraction * Math.log(p1 / p0) + (1 - winFraction) * Math.log((1 - p1) / (1 - p0));
    },
    llr(): number {
      return logLikelihoodRatio;
    },
    verdict(): SprtVerdict {
      if (logLikelihoodRatio >= upperBound) {
        return 'accept';
      }
      if (logLikelihoodRatio <= lowerBound) {
        return 'reject';
      }
      return 'continue';
    },
  };
}
