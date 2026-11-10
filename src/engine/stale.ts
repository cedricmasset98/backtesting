/**
 * Corrections for stale (non-synchronous) prices of thinly traded stocks.
 *
 * When prices react to market news with a delay, monthly portfolio returns are
 * positively autocorrelated, and the contemporaneous beta and the volatility
 * are understated; the alpha and the Sharpe ratio are then overstated.
 *
 *  - Dimson (1979): R_p,t − R_f,t = α + Σ_{l=0}^{L} β_l MKT_{t−l} + ε_t, with the
 *    summed beta β_D = Σ β_l and the alpha measured net of the lagged exposures;
 *  - Lo (2002): annualised Sharpe ratio under serial correlation,
 *    SR(q) = η(q)·SR(1), η(q) = q / √(q + 2 Σ_{k=1}^{q−1} (q − k) ρ_k),
 *    with the AR(1) approximation ρ_k = ρ_1^k (q = 12). The same factor gives
 *    the annual volatility implied by the autocorrelation:
 *    σ_q = √(q + 2 Σ (q − k) ρ_k) · σ_1 instead of √q · σ_1.
 */

import { ols, type CovType, type OLSResult } from './ols.ts';
import { mean, sd } from './metrics.ts';

export function autocorrelation(x: number[], lag = 1): number {
  const n = x.length;
  if (n <= lag + 2) return NaN;
  const m = mean(x);
  let num = 0;
  let den = 0;
  for (let t = 0; t < n; t++) {
    den += (x[t] - m) ** 2;
    if (t >= lag) num += (x[t] - m) * (x[t - lag] - m);
  }
  return num / den;
}

export interface LoSharpe {
  rho: number;
  /** η(q): annualisation factor replacing √q */
  eta: number;
  sharpe: number;
  /** annual volatility multiplier relative to the √q scaling */
  volFactor: number;
}

/** Lo (2002) annualised Sharpe ratio of monthly excess returns, AR(1) autocorrelation. */
export function loSharpe(excess: number[], q = 12): LoSharpe {
  const rho = autocorrelation(excess, 1);
  let s = q;
  for (let k = 1; k < q; k++) s += 2 * (q - k) * rho ** k;
  const eta = q / Math.sqrt(s);
  return { rho, eta, sharpe: (eta * mean(excess)) / sd(excess), volFactor: Math.sqrt(s / q) };
}

export interface DimsonFit {
  capm: OLSResult;
  dimson: OLSResult;
  /** summed beta Σ_l β_l */
  betaSum: number;
  n: number;
}

/**
 * CAPM and Dimson regressions on the same months (the first `lags` months are
 * dropped from both, so that the two alphas are comparable).
 */
export function dimsonFit(excess: number[], mkt: number[], lags = 1, cov: CovType = 'HAC'): DimsonFit {
  if (excess.length !== mkt.length) throw new Error('Incompatible lengths.');
  const y = excess.slice(lags);
  const xc = y.map((_, t) => [1, mkt[t + lags]]);
  const xd = y.map((_, t) => [1, ...Array.from({ length: lags + 1 }, (_, l) => mkt[t + lags - l])]);
  const capm = ols(y, xc, ['alpha', 'MKT'], { cov });
  const dimson = ols(y, xd, ['alpha', ...Array.from({ length: lags + 1 }, (_, l) => (l ? `MKT(t−${l})` : 'MKT'))], { cov });
  return { capm, dimson, betaSum: dimson.beta.slice(1).reduce((a, b) => a + b, 0), n: y.length };
}
