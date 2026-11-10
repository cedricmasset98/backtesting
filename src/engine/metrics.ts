/**
 * Performance and risk statistics of monthly return series.
 *
 * Conventions (documented in the Data & Methodology tab and the README):
 *  - returns are simple monthly decimal returns; r_f is the monthly Swiss
 *    risk-free return of the same month;
 *  - annualisation: means × 12, standard deviations × √12, CAGR = (V_T/V_0)^(12/n) − 1;
 *  - standard deviations use the n − 1 divisor; skewness and excess kurtosis
 *    use biased moments (scipy.stats defaults);
 *  - VaR and CVaR are historical, monthly, reported as positive losses;
 *    quantiles use linear interpolation between order statistics (numpy default);
 *  - drawdown D_t = V_t / max_{s ≤ t} V_s − 1, with V_0 = 100 included in the maximum.
 */

export function mean(x: number[]): number {
  let s = 0;
  for (const v of x) s += v;
  return s / x.length;
}

export function sd(x: number[]): number {
  if (x.length < 2) return NaN;
  const m = mean(x);
  let s = 0;
  for (const v of x) s += (v - m) ** 2;
  return Math.sqrt(s / (x.length - 1));
}

export function covariance(x: number[], y: number[]): number {
  const mx = mean(x);
  const my = mean(y);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] - mx) * (y[i] - my);
  return s / (x.length - 1);
}

/** Quantile with linear interpolation (numpy "linear", Hyndman-Fan type 7). */
export function quantile(x: number[], p: number): number {
  const s = [...x].sort((a, b) => a - b);
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

/** Wealth path V_0 = 100, V_t = 100 ∏ (1 + r_s). Length n + 1. */
export function wealth(r: number[], base = 100): number[] {
  const out = [base];
  let v = base;
  for (const x of r) {
    v *= 1 + x;
    out.push(v);
  }
  return out;
}

/** Drawdowns D_t = V_t / max_{s≤t} V_s − 1, in [−1, 0] for non-negative wealth. */
export function drawdowns(v: number[]): number[] {
  let peak = -Infinity;
  return v.map((x) => {
    peak = Math.max(peak, x);
    return x / peak - 1;
  });
}

export function maxDrawdown(r: number[]): number {
  return Math.min(...drawdowns(wealth(r)));
}

export function skewness(x: number[]): number {
  const m = mean(x);
  let m2 = 0;
  let m3 = 0;
  for (const v of x) {
    m2 += (v - m) ** 2;
    m3 += (v - m) ** 3;
  }
  m2 /= x.length;
  m3 /= x.length;
  return m3 / m2 ** 1.5;
}

export function excessKurtosis(x: number[]): number {
  const m = mean(x);
  let m2 = 0;
  let m4 = 0;
  for (const v of x) {
    m2 += (v - m) ** 2;
    m4 += (v - m) ** 4;
  }
  m2 /= x.length;
  m4 /= x.length;
  return m4 / (m2 * m2) - 3;
}

/** Historical VaR at level a (e.g. 0.95): −q_{1−a}(r), a positive loss. */
export function historicalVaR(r: number[], a: number): number {
  return -quantile(r, 1 - a);
}

/** Historical CVaR / expected shortfall: −mean(r | r ≤ q_{1−a}(r)). */
export function historicalCVaR(r: number[], a: number): number {
  const q = quantile(r, 1 - a);
  const tail = r.filter((v) => v <= q);
  return -mean(tail);
}

export interface PerfStats {
  n: number;
  cumulative: number;
  cagr: number;
  meanSimple: number; // monthly
  meanLog: number; // monthly
  arithAnnual: number; // 12 × mean simple
  vol: number; // annualised
  seMean: number; // monthly standard error of the mean, sd/√n
  downsideDev: number; // annualised, MAR = r_f
  maxDD: number;
  var95: number;
  var99: number;
  cvar95: number;
  cvar99: number;
  skew: number;
  exKurt: number;
  posFreq: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  infoRatio: number;
  trackingError: number;
  beta: number;
  excessMeanAnnual: number;
}

/**
 * All statistics for a strategy r, the risk-free return rf and the benchmark b
 * (same months, same length).
 */
export function perfStats(r: number[], rf: number[], b: number[]): PerfStats {
  const n = r.length;
  const v = wealth(r);
  const cumulative = v[n] / 100 - 1;
  const cagr = Math.pow(v[n] / 100, 12 / n) - 1;
  const ex = r.map((x, i) => x - rf[i]);
  const bex = b.map((x, i) => x - rf[i]);
  const active = r.map((x, i) => x - b[i]);
  const s = sd(r);
  const downside = Math.sqrt(mean(ex.map((e) => Math.min(e, 0) ** 2))) * Math.sqrt(12);
  const maxDD = Math.min(...drawdowns(v));
  const te = sd(active) * Math.sqrt(12);
  const varB = sd(bex) ** 2;
  return {
    n,
    cumulative,
    cagr,
    meanSimple: mean(r),
    meanLog: mean(r.map((x) => Math.log1p(x))),
    arithAnnual: 12 * mean(r),
    vol: s * Math.sqrt(12),
    seMean: s / Math.sqrt(n),
    downsideDev: downside,
    maxDD,
    var95: historicalVaR(r, 0.95),
    var99: historicalVaR(r, 0.99),
    cvar95: historicalCVaR(r, 0.95),
    cvar99: historicalCVaR(r, 0.99),
    skew: skewness(r),
    exKurt: excessKurtosis(r),
    posFreq: r.filter((x) => x > 0).length / n,
    sharpe: (mean(ex) / sd(ex)) * Math.sqrt(12),
    sortino: (12 * mean(ex)) / downside,
    calmar: maxDD < 0 ? cagr / Math.abs(maxDD) : NaN,
    infoRatio: te > 0 ? (12 * mean(active)) / te : NaN,
    trackingError: te,
    beta: varB > 0 ? covariance(ex, bex) / varB : NaN,
    excessMeanAnnual: 12 * mean(ex),
  };
}

/**
 * Net returns with proportional costs c (in basis points) on the traded value:
 * 1 + r_net = (1 − c·TO)(1 + r_gross). Exact: weights and turnover do not
 * depend on the cost level. Same formula as pipeline/backtest.py:net_returns.
 */
/**
 * Net returns with proportional costs: at a rebalancing date wealth is reduced
 * by c·TO_t (fixed cost of `bps` per unit traded) plus the spread cost S_t of the
 * same trades (Σ_i |Δw_i|·s_i/2, from the pipeline), then earns the gross return:
 * 1 + r_net = (1 − c·TO_t − S_t)(1 + r_gross).
 */
export function netReturns(gross: number[], turnover: (number | null)[], bps: number, spread?: (number | null)[]): number[] {
  const c = bps / 1e4;
  return gross.map((g, i) => (1 - c * (turnover[i] ?? 0) - (spread?.[i] ?? 0)) * (1 + g) - 1);
}

/** Costs paid, in CHF per 100 CHF invested at the start: Σ (c·TO_t + S_t)·V_{t−1}^{net}. */
export function cumulativeCosts(gross: number[], turnover: (number | null)[], bps: number, spread?: (number | null)[]): number {
  const c = bps / 1e4;
  let v = 100;
  let paid = 0;
  gross.forEach((g, i) => {
    const cost = (c * (turnover[i] ?? 0) + (spread?.[i] ?? 0)) * v;
    paid += cost;
    v = (v - cost) * (1 + g);
  });
  return paid;
}

/** Relative wealth (strategy / benchmark) rebased to 100: 100 ∏(1+r)/∏(1+b). */
export function relativeWealth(r: number[], b: number[]): number[] {
  const a = wealth(r);
  const c = wealth(b);
  return a.map((x, i) => (100 * x) / c[i]);
}

/** Rank of x within a sample: share of sample values strictly below x plus half the ties. */
export function percentileRank(sample: number[], x: number): number {
  let below = 0;
  let ties = 0;
  for (const v of sample) {
    if (v < x) below++;
    else if (v === x) ties++;
  }
  return (below + 0.5 * ties) / sample.length;
}
