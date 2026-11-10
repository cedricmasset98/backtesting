/**
 * Stationary bootstrap (Politis & Romano, 1994) for differences of Sharpe
 * ratios between two strategies observed over the same months, and Holm's
 * step-down correction for multiple comparisons.
 *
 * Resampling paired months (blocks of random geometric length, mean b) keeps
 * the cross-correlation between the two strategies and part of the serial
 * dependence. The two-sided p-value uses the absolute centred bootstrap
 * deviation |ΔSR* − ΔSR|. Its matching symmetric confidence interval is
 * ΔSR ± q_level(|ΔSR* − ΔSR|), so p < 0.05 and exclusion of zero from the
 * 95 % interval agree, except for discrete/rounded boundary cases.
 * This is an unstudentised bootstrap sensitivity test, not a claim of exact
 * finite-sample coverage.
 */

import { mean, sd } from './metrics.ts';

/** Deterministic PRNG (mulberry32), so that results are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sharpe(ex: number[]): number {
  return (mean(ex) / sd(ex)) * Math.sqrt(12);
}

/** Indices of one stationary-bootstrap resample of length n (mean block length b). */
export function stationaryIndices(n: number, b: number, rand: () => number): number[] {
  const out: number[] = new Array(n);
  let i = Math.floor(rand() * n);
  for (let t = 0; t < n; t++) {
    if (t > 0) {
      if (rand() < 1 / b) i = Math.floor(rand() * n);
      else i = (i + 1) % n;
    }
    out[t] = i;
  }
  return out;
}

export interface SharpeDiff {
  diff: number;
  low: number;
  high: number;
  pvalue: number;
  reps: number;
}

export function sharpeDiffBootstrap(exA: number[], exB: number[], opts: { reps?: number; block?: number; seed?: number; level?: number } = {}): SharpeDiff {
  const reps = opts.reps ?? 2000;
  const block = opts.block ?? 6;
  const level = opts.level ?? 0.95;
  const rand = mulberry32(opts.seed ?? 12345);
  const n = exA.length;
  const diff = sharpe(exA) - sharpe(exB);
  const boot: number[] = [];
  for (let r = 0; r < reps; r++) {
    const idx = stationaryIndices(n, block, rand);
    const a = idx.map((i) => exA[i]);
    const b = idx.map((i) => exB[i]);
    const d = sharpe(a) - sharpe(b);
    if (Number.isFinite(d)) boot.push(d);
  }
  // Two-sided test of ΔSR = 0 from the re-centred distribution |ΔSR* − ΔSR|, and the
  // symmetric interval obtained by inverting the same test, ΔSR ± q_level(|ΔSR* − ΔSR|):
  // the interval excludes 0 exactly when |ΔSR| exceeds that quantile (p < 1 − level).
  const dev = boot.map((d) => Math.abs(d - diff)).sort((x, y) => x - y);
  const half = dev[Math.min(dev.length - 1, Math.ceil(level * (dev.length + 1)) - 1)];
  const extreme = dev.filter((d) => d >= Math.abs(diff)).length;
  return { diff, low: diff - half, high: diff + half, pvalue: (extreme + 1) / (boot.length + 1), reps: boot.length };
}

/** Holm (1979) step-down adjusted p-values (family-wise error rate). */
export function holm(p: number[]): number[] {
  const m = p.length;
  const order = p.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const adj = new Array(m).fill(NaN);
  let running = 0;
  order.forEach(([v, i], k) => {
    running = Math.max(running, Math.min(1, (m - k) * v));
    adj[i] = running;
  });
  return adj;
}
