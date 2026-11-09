/**
 * Moteur OLS : estimation des coefficients et inférence classique, HC3 et
 * Newey-West (HAC). Les coefficients ne dépendent jamais de la méthode
 * d'inférence : seule la matrice de covariance des estimateurs change.
 *
 * Conventions (identiques à statsmodels, cf. docs/METHODOLOGY.md) :
 *  - classique : V = s² (X'X)⁻¹, s² = SSR/(n−k) ; tests t de Student à n−k ddl,
 *    test global F(k−1, n−k).
 *  - HC3 : V = (X'X)⁻¹ X' diag(e²/(1−h)²) X (X'X)⁻¹ ; inférence asymptotique
 *    normale (z), test global de Wald χ²(k−1).
 *  - HAC Newey-West : noyau de Bartlett, L retards, sans correction de petit
 *    échantillon par défaut ; inférence normale (z), Wald χ²(k−1).
 */

import { crossprod, crossprodVec, invSPD, matvec, quadForm, subMatrix, inv, type Matrix, type Vector } from './linalg.ts';
import { chi2Sf, fSf, normSf, tCritTwoSided, tTwoSidedP, zCritTwoSided } from './distributions.ts';

export type CovType = 'classical' | 'HC3' | 'HAC';

export interface FitOptions {
  cov: CovType;
  /** Nombre de retards Newey-West ; null/undefined = règle automatique. */
  hacLags?: number | null;
  /** Multiplie la covariance HAC par n/(n−k) (option `use_correction` de statsmodels). */
  hacSmallSampleCorrection?: boolean;
  /** Niveau de confiance (0.95 par défaut). */
  level?: number;
}

export interface JointTest {
  kind: 'F' | 'Wald';
  label: string;
  stat: number;
  df1: number;
  df2: number | null;
  pvalue: number;
}

export interface OLSResult {
  names: string[];
  n: number;
  k: number;
  dfResid: number;
  cov: CovType;
  /** 't' pour l'OLS classique, 'normal' pour les méthodes robustes. */
  distribution: 't' | 'normal';
  hacLags: number | null;
  level: number;
  crit: number;
  beta: Vector;
  se: Vector;
  stat: Vector;
  pvalue: Vector;
  ciLow: Vector;
  ciHigh: Vector;
  covParams: Matrix;
  r2: number;
  r2adj: number;
  ssr: number;
  /** Écart-type des résidus s = sqrt(SSR/(n−k)). */
  sigma: number;
  joint: JointTest | null;
  fitted: Vector;
  resid: Vector;
  leverage: Vector;
  xtxInv: Matrix;
}

export class InsufficientDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientDataError';
  }
}

/** Règle de Newey-West (1994) : L = floor(4 (n/100)^(2/9)). */
export function neweyWestAutoLags(n: number): number {
  return Math.floor(4 * Math.pow(n / 100, 2 / 9));
}

/**
 * Estime y = X b + e par OLS. X doit contenir la constante si on en veut une
 * (par convention colonne 0). `names` nomme les colonnes de X.
 */
export function ols(y: Vector, x: Matrix, names: string[], options: FitOptions): OLSResult {
  const n = y.length;
  if (x.length !== n) throw new Error('Incompatible dimensions between y and X.');
  if (n === 0) throw new InsufficientDataError('Aucune observation disponible.');
  const k = x[0].length;
  if (names.length !== k) throw new Error('Incorrect number of variable names.');
  if (n <= k) {
    throw new InsufficientDataError(`Insufficient observations: n = ${n} for k = ${k} parameters.`);
  }
  for (let t = 0; t < n; t++) {
    if (!Number.isFinite(y[t]) || x[t].some((v) => !Number.isFinite(v))) {
      throw new Error(`Missing or non-finite value at observation ${t}.`);
    }
  }
  const level = options.level ?? 0.95;
  const alpha = 1 - level;

  const xtx = crossprod(x);
  const xtxInv = invSPD(xtx);
  const beta = matvec(xtxInv, crossprodVec(x, y));

  const fitted = x.map((row) => row.reduce((s, v, j) => s + v * beta[j], 0));
  const resid = y.map((v, t) => v - fitted[t]);
  const ssr = resid.reduce((s, e) => s + e * e, 0);
  const ybar = y.reduce((s, v) => s + v, 0) / n;
  const sst = y.reduce((s, v) => s + (v - ybar) ** 2, 0);
  const dfResid = n - k;
  const s2 = ssr / dfResid;
  const hasConst = x.every((row) => row[0] === 1);
  const r2 = hasConst ? 1 - ssr / sst : 1 - ssr / y.reduce((s, v) => s + v * v, 0);
  const r2adj = 1 - ((1 - r2) * (n - (hasConst ? 1 : 0))) / dfResid;

  const leverage = x.map((row) => quadForm(xtxInv, row));

  let covParams: Matrix;
  let hacLags: number | null = null;
  if (options.cov === 'classical') {
    covParams = xtxInv.map((row) => row.map((v) => v * s2));
  } else if (options.cov === 'HC3') {
    const omega = resid.map((e, t) => (e * e) / (1 - leverage[t]) ** 2);
    covParams = sandwich(xtxInv, meatDiag(x, omega));
  } else {
    hacLags = options.hacLags ?? neweyWestAutoLags(n);
    if (!Number.isInteger(hacLags) || hacLags < 0) throw new Error('Invalid number of HAC lags.');
    if (hacLags >= n) throw new InsufficientDataError('Number of HAC lags exceeds the number of observations.');
    covParams = sandwich(xtxInv, meatHAC(x, resid, hacLags));
    if (options.hacSmallSampleCorrection) {
      const f = n / dfResid;
      covParams = covParams.map((row) => row.map((v) => v * f));
    }
  }

  const distribution: 't' | 'normal' = options.cov === 'classical' ? 't' : 'normal';
  const crit = distribution === 't' ? tCritTwoSided(alpha, dfResid) : zCritTwoSided(alpha);
  const se = covParams.map((row, i) => Math.sqrt(row[i]));
  const stat = beta.map((b, i) => b / se[i]);
  const pvalue = stat.map((s) => (distribution === 't' ? tTwoSidedP(s, dfResid) : 2 * normSf(Math.abs(s))));
  const ciLow = beta.map((b, i) => b - crit * se[i]);
  const ciHigh = beta.map((b, i) => b + crit * se[i]);

  // Test global : nullité de toutes les pentes (hors constante).
  let joint: JointTest | null = null;
  const slopeIdx = hasConst ? Array.from({ length: k - 1 }, (_, i) => i + 1) : Array.from({ length: k }, (_, i) => i);
  if (slopeIdx.length > 0) {
    const q = slopeIdx.length;
    if (options.cov === 'classical') {
      const ess = hasConst ? sst - ssr : y.reduce((s, v) => s + v * v, 0) - ssr;
      const f = ess / q / s2;
      joint = { kind: 'F', label: `F(${q}, ${dfResid})`, stat: f, df1: q, df2: dfResid, pvalue: fSf(f, q, dfResid) };
    } else {
      const bs = slopeIdx.map((i) => beta[i]);
      const vs = subMatrix(covParams, slopeIdx);
      const w = quadForm(inv(vs), bs);
      joint = { kind: 'Wald', label: `Wald χ²(${q})`, stat: w, df1: q, df2: null, pvalue: chi2Sf(w, q) };
    }
  }

  return {
    names,
    n,
    k,
    dfResid,
    cov: options.cov,
    distribution,
    hacLags,
    level,
    crit,
    beta,
    se,
    stat,
    pvalue,
    ciLow,
    ciHigh,
    covParams,
    r2,
    r2adj,
    ssr,
    sigma: Math.sqrt(s2),
    joint,
    fitted,
    resid,
    leverage,
    xtxInv,
  };
}

function sandwich(bread: Matrix, meat: Matrix): Matrix {
  const k = bread.length;
  const tmp: Matrix = bread.map((row) => {
    const out = new Array(k).fill(0);
    for (let j = 0; j < k; j++) for (let l = 0; l < k; l++) out[j] += row[l] * meat[l][j];
    return out;
  });
  const res: Matrix = tmp.map((row) => {
    const out = new Array(k).fill(0);
    for (let j = 0; j < k; j++) for (let l = 0; l < k; l++) out[j] += row[l] * bread[l][j];
    return out;
  });
  // symétrisation numérique
  for (let i = 0; i < k; i++) for (let j = 0; j < i; j++) res[i][j] = res[j][i] = 0.5 * (res[i][j] + res[j][i]);
  return res;
}

/** Σ_t ω_t x_t x_t' */
function meatDiag(x: Matrix, omega: Vector): Matrix {
  const k = x[0].length;
  const m: Matrix = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let t = 0; t < x.length; t++) {
    const row = x[t];
    const w = omega[t];
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) m[i][j] += w * row[i] * row[j];
  }
  return m;
}

/** Γ0 + Σ_{l=1..L} (1 − l/(L+1)) (Γ_l + Γ_l'), Γ_l = Σ_t (x_t e_t)(x_{t−l} e_{t−l})' */
function meatHAC(x: Matrix, e: Vector, lags: number): Matrix {
  const n = x.length;
  const k = x[0].length;
  const u = x.map((row, t) => row.map((v) => v * e[t]));
  const m: Matrix = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let t = 0; t < n; t++) for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) m[i][j] += u[t][i] * u[t][j];
  for (let l = 1; l <= lags; l++) {
    const w = 1 - l / (lags + 1);
    for (let t = l; t < n; t++) {
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) {
          const g = u[t][i] * u[t - l][j];
          m[i][j] += w * g;
          m[j][i] += w * g;
        }
      }
    }
  }
  return m;
}

/**
 * Intervalle de confiance de la moyenne conditionnelle ŷ(x0) = x0'b,
 * avec la covariance des coefficients de la méthode choisie.
 */
export function meanPredictionInterval(res: OLSResult, x0: Vector): { fit: number; low: number; high: number } {
  const fit = x0.reduce((s, v, j) => s + v * res.beta[j], 0);
  const se = Math.sqrt(quadForm(res.covParams, x0));
  return { fit, low: fit - res.crit * se, high: fit + res.crit * se };
}
