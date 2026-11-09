/** Régressions mobiles sur fenêtre glissante de w observations consécutives. */

import { ols, type FitOptions } from './ols.ts';
import type { Matrix, Vector } from './linalg.ts';

export interface RollingResult {
  window: number;
  names: string[];
  /** Date de fin de chaque fenêtre. */
  dates: string[];
  beta: number[][]; // [coef][fenêtre]
  low: number[][];
  high: number[][];
  r2: number[];
  hacLags: (number | null)[];
}

export function rollingOLS(dates: string[], y: Vector, x: Matrix, names: string[], window: number, options: FitOptions): RollingResult {
  const n = y.length;
  const k = names.length;
  if (window <= k + 1) throw new Error(`A ${window}-observation window is too short for ${k} parameters.`);
  if (n < window) {
    throw new Error(`Insufficient observations for a ${window}-month window (n = ${n}).`);
  }
  const out: RollingResult = {
    window,
    names,
    dates: [],
    beta: names.map(() => []),
    low: names.map(() => []),
    high: names.map(() => []),
    r2: [],
    hacLags: [],
  };
  for (let end = window; end <= n; end++) {
    const ys = y.slice(end - window, end);
    const xs = x.slice(end - window, end);
    const res = ols(ys, xs, names, options);
    out.dates.push(dates[end - 1]);
    for (let j = 0; j < k; j++) {
      out.beta[j].push(res.beta[j]);
      out.low[j].push(res.ciLow[j]);
      out.high[j].push(res.ciHigh[j]);
    }
    out.r2.push(res.r2);
    out.hacLags.push(res.hacLags);
  }
  return out;
}
