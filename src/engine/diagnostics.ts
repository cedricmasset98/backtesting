/**
 * Diagnostics des résidus : ACF, Ljung-Box, Breusch-Pagan (version studentisée
 * de Koenker), Jarque-Bera, quantiles pour Q-Q plot.
 * Conventions alignées sur statsmodels (acf, acorr_ljungbox, het_breuschpagan
 * avec robust=True, jarque_bera).
 */

import { ols } from './ols.ts';
import { chi2Sf, normPpf } from './distributions.ts';
import type { Matrix, Vector } from './linalg.ts';

export interface TestResult {
  name: string;
  stat: number;
  df: number;
  pvalue: number;
  h0: string;
}

/** Autocorrélations empiriques r_1..r_nlags (non ajustées, données centrées). */
export function acf(x: Vector, nlags: number): Vector {
  const n = x.length;
  const mean = x.reduce((s, v) => s + v, 0) / n;
  const d = x.map((v) => v - mean);
  const c0 = d.reduce((s, v) => s + v * v, 0);
  const out: Vector = [];
  for (let k = 1; k <= nlags; k++) {
    let s = 0;
    for (let t = k; t < n; t++) s += d[t] * d[t - k];
    out.push(s / c0);
  }
  return out;
}

/** Test de Ljung-Box à m retards : Q = n(n+2) Σ r_k²/(n−k) ~ χ²(m). */
export function ljungBox(resid: Vector, m: number): TestResult {
  const n = resid.length;
  const r = acf(resid, m);
  let q = 0;
  for (let k = 1; k <= m; k++) q += (r[k - 1] * r[k - 1]) / (n - k);
  q *= n * (n + 2);
  return { name: `Ljung-Box (${m} lags)`, stat: q, df: m, pvalue: chi2Sf(q, m), h0: 'No autocorrelation of residuals' };
}

/**
 * Breusch-Pagan studentisé (Koenker, 1981) : régression de e² sur X ;
 * LM = n·R² ~ χ²(k−1). X doit contenir la constante en colonne 0.
 */
export function breuschPagan(resid: Vector, x: Matrix): TestResult {
  const n = resid.length;
  const k = x[0].length;
  const e2 = resid.map((e) => e * e);
  const names = Array.from({ length: k }, (_, i) => `x${i}`);
  const aux = ols(e2, x, names, { cov: 'classical' });
  const lm = n * aux.r2;
  return { name: 'Breusch-Pagan (Koenker)', stat: lm, df: k - 1, pvalue: chi2Sf(lm, k - 1), h0: 'Homoskedastic residuals' };
}

export interface Moments {
  skewness: number;
  kurtosis: number;
}

/** Asymétrie et kurtosis (non excédentaire) avec moments biaisés, comme scipy.stats. */
export function moments(x: Vector): Moments {
  const n = x.length;
  const mean = x.reduce((s, v) => s + v, 0) / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of x) {
    const d = v - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  return { skewness: m3 / Math.pow(m2, 1.5), kurtosis: m4 / (m2 * m2) };
}

/** Test de Jarque-Bera : JB = n/6 (S² + (K−3)²/4) ~ χ²(2). */
export function jarqueBera(resid: Vector): TestResult & Moments {
  const n = resid.length;
  const { skewness, kurtosis } = moments(resid);
  const jb = (n / 6) * (skewness * skewness + ((kurtosis - 3) * (kurtosis - 3)) / 4);
  return { name: 'Jarque-Bera', stat: jb, df: 2, pvalue: chi2Sf(jb, 2), h0: 'Normally distributed residuals', skewness, kurtosis };
}

/**
 * Points du Q-Q plot normal : résidus standardisés (e/s) triés contre les
 * quantiles théoriques Φ⁻¹((i − 0,5)/n) (positions de Hazen).
 */
export function qqPoints(resid: Vector, sigma: number): { theoretical: Vector; sample: Vector } {
  const n = resid.length;
  const sample = resid.map((e) => e / sigma).sort((a, b) => a - b);
  const theoretical = sample.map((_, i) => normPpf((i + 0.5) / n));
  return { theoretical, sample };
}

/** Nombre de retards par défaut pour Ljung-Box : min(12, floor(n/5)) en mensuel. */
export function defaultLjungBoxLags(n: number): number {
  return Math.max(1, Math.min(12, Math.floor(n / 5)));
}
