/**
 * Factor models estimated on monthly excess returns:
 *
 *   R_p − R_f = α + β_M MKT + β_S SMB + β_H HML + β_R RMW + β_C CMA + β_W MOM + ε
 *
 * MKT = SPI total return − Swiss r_f; SMB, HML, RMW, CMA, MOM, BAB = Swiss JKP
 * long-short factors (market_equity, be_me, ope_be, at_gr1, ret_12_1,
 * betabab_1260d: low beta − high beta) in CHF.
 * Sample rule: the months of the selected period where the portfolio return,
 * r_f and every factor of the model are available (no filling). The same rule
 * is used by pipeline/statsref.py for the statsmodels reference.
 */

import { ols, type CovType, type OLSResult } from './ols.ts';

export type FactorId = 'MKT' | 'SMB' | 'HML' | 'RMW' | 'CMA' | 'MOM' | 'BAB';
export type ModelId = 'CAPM' | 'FF3' | 'CARHART' | 'FF5' | 'FF5MOM' | 'FF5MOMBAB';

export const FACTORS: FactorId[] = ['MKT', 'SMB', 'HML', 'RMW', 'CMA', 'MOM', 'BAB'];
export const MODELS: Record<ModelId, { label: string; factors: FactorId[] }> = {
  CAPM: { label: 'CAPM', factors: ['MKT'] },
  FF3: { label: 'FF3', factors: ['MKT', 'SMB', 'HML'] },
  CARHART: { label: 'Carhart-4', factors: ['MKT', 'SMB', 'HML', 'MOM'] },
  FF5: { label: 'FF5', factors: ['MKT', 'SMB', 'HML', 'RMW', 'CMA'] },
  FF5MOM: { label: 'FF5+MOM', factors: ['MKT', 'SMB', 'HML', 'RMW', 'CMA', 'MOM'] },
  FF5MOMBAB: { label: 'FF5+MOM+BAB', factors: ['MKT', 'SMB', 'HML', 'RMW', 'CMA', 'MOM', 'BAB'] },
};
export const MODEL_IDS = Object.keys(MODELS) as ModelId[];

export interface FactorData {
  months: string[];
  rf: (number | null)[];
  factors: Record<FactorId, (number | null)[]>;
}

export interface Sample {
  months: string[];
  y: number[];
  x: number[][]; // with constant in column 0
  names: string[];
}

/** Builds the regression sample for a portfolio return series (months/returns aligned). */
export function buildSample(months: string[], r: (number | null)[], data: FactorData, model: ModelId): Sample {
  const idx = new Map(data.months.map((m, i) => [m, i]));
  const f = MODELS[model].factors;
  const out: Sample = { months: [], y: [], x: [], names: ['alpha', ...f] };
  months.forEach((m, t) => {
    const i = idx.get(m);
    const v = r[t];
    if (i === undefined || v === null || !Number.isFinite(v)) return;
    const rf = data.rf[i];
    if (rf === null) return;
    const row = f.map((k) => data.factors[k]?.[i] ?? null); // a factor absent from the file is missing
    if (row.some((z) => z === null || !Number.isFinite(z))) return;
    out.months.push(m);
    out.y.push(v - rf);
    out.x.push([1, ...(row as number[])]);
  });
  return out;
}

export type FitOutcome =
  | { ok: true; model: ModelId; sample: Sample; result: OLSResult }
  | { ok: false; model: ModelId; reason: string; n: number };

export function fitModel(months: string[], r: (number | null)[], data: FactorData, model: ModelId, cov: CovType): FitOutcome {
  const s = buildSample(months, r, data, model);
  const k = s.names.length;
  if (s.y.length <= k + 1) {
    return { ok: false, model, n: s.y.length, reason: `Only ${s.y.length} months with all ${MODELS[model].label} factors in the selected period (need more than ${k + 1}).` };
  }
  try {
    return { ok: true, model, sample: s, result: ols(s.y, s.x, s.names, { cov }) };
  } catch (e) {
    return { ok: false, model, n: s.y.length, reason: (e as Error).message };
  }
}

/**
 * Attribution of the mean excess return: mean(R_p − R_f) = α̂ + Σ_k β̂_k · mean(F_k)
 * holds exactly in-sample for OLS with a constant.
 */
export function attribution(fit: Extract<FitOutcome, { ok: true }>): { name: string; value: number }[] {
  const { sample, result } = fit;
  const n = sample.y.length;
  return result.names.map((name, j) => {
    const m = j === 0 ? 1 : sample.x.reduce((s, row) => s + row[j], 0) / n;
    return { name, value: result.beta[j] * m };
  });
}

/**
 * Lagged-market sensitivity on an EXACTLY matched sample.
 *
 * Stale prices may load on the preceding calendar month's Swiss market return.
 * The control and lag-augmented regressions therefore use identical observations
 * and differ only by the MKT_L1 regressor. We do not substitute the previous
 * available factor observation if a calendar month is missing.
 *
 * This is a diagnostic, not a correction to the underlying return series.
 */
export function laggedMarketSensitivity(
  months: string[],
  r: (number | null)[],
  data: FactorData,
  model: ModelId,
  cov: CovType,
): { base: FitOutcome; lagged: FitOutcome } {
  const complete = buildSample(months, r, data, model);
  const monthIndex = new Map(data.months.map((m, i) => [m, i]));
  const sample: Sample = { months: [], y: [], x: [], names: [...complete.names, 'MKT_L1'] };
  for (let t = 0; t < complete.months.length; t++) {
    const [year, month] = complete.months[t].split('-').map(Number);
    const prev = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
    const i = monthIndex.get(prev);
    const marketLag = i === undefined ? null : data.factors.MKT?.[i];
    if (marketLag === null || marketLag === undefined || !Number.isFinite(marketLag)) continue;
    sample.months.push(complete.months[t]);
    sample.y.push(complete.y[t]);
    sample.x.push([...complete.x[t], marketLag]);
  }

  const fit = (withLag: boolean): FitOutcome => {
    const names = withLag ? sample.names : complete.names;
    const x = withLag ? sample.x : sample.x.map((row) => row.slice(0, -1));
    if (sample.y.length <= names.length + 1) {
      return { ok: false, model, n: sample.y.length, reason: `Only ${sample.y.length} matched months for ${MODELS[model].label} with lagged MKT (need more than ${names.length + 1}).` };
    }
    try {
      const s: Sample = { months: sample.months, y: sample.y, x, names };
      return { ok: true, model, sample: s, result: ols(s.y, s.x, names, { cov }) };
    } catch (e) {
      return { ok: false, model, n: sample.y.length, reason: (e as Error).message };
    }
  };
  return { base: fit(false), lagged: fit(true) };
}
