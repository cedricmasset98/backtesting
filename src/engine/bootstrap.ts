/**
 * Stationary bootstrap (Politis & Romano, 1994) for differences of Sharpe
 * ratios between two strategies observed over the same months, and Holm's
 * step-down correction for multiple comparisons.
 *
 * Resampling paired months (blocks of random geometric length, mean b) keeps
 * the cross-correlation between the two strategies and part of the serial
 * dependence. The interval is the percentile interval of the bootstrap
 * distribution of ΔSR; the two-sided p-value is 2·min(P*(ΔSR* ≤ 0), P*(ΔSR* ≥ 0))
 * computed on the bootstrap distribution re-centred on zero (Ledoit & Wolf, 2008,
 * use studentised statistics; this simpler version is documented as such).
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
  boot.sort((x, y) => x - y);
  const q = (p: number) => boot[Math.min(boot.length - 1, Math.max(0, Math.floor(p * (boot.length - 1))))];
  const centred = boot.map((d) => d - diff);
  const extreme = centred.filter((d) => Math.abs(d) >= Math.abs(diff)).length;
  return { diff, low: q((1 - level) / 2), high: q(1 - (1 - level) / 2), pvalue: (extreme + 1) / (boot.length + 1), reps: boot.length };
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
