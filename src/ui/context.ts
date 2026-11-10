import type { Manifest, Market, MonkeysFile, SeriesId, StrategiesFile } from '../data/types.ts';
import type { View } from '../model.ts';
import type { State } from '../state.ts';
import type { Theme } from './charts.ts';
import { perfStats, type PerfStats } from '../engine/metrics.ts';

export interface Ctx {
  s: State;
  m: Manifest;
  market: Market;
  strat: StrategiesFile;
  monkeys: MonkeysFile | null;
  view: View;
  theme: Theme;
  root: HTMLElement;
  /** visible series that exist in this view, in display order */
  visible: SeriesId[];
  set: (patch: Partial<State>) => void;
}

const statsCache = new WeakMap<View, Map<string, PerfStats>>();

/** Statistics of a series on the current basis (cached per view). */
export function stats(c: Ctx, id: SeriesId, basis: 'r' | 'gross' | 'net' = 'r'): PerfStats {
  let m = statsCache.get(c.view);
  if (!m) {
    m = new Map();
    statsCache.set(c.view, m);
  }
  const key = `${id}:${basis}`;
  let st = m.get(key);
  if (!st) {
    const sv = c.view.series.get(id)!;
    st = perfStats(sv[basis], c.view.rf, c.view.spi);
    m.set(key, st);
  }
  return st;
}

/**
 * CAGR difference with the SPI, split exactly into a universe effect (EW − SPI:
 * reconstructed universe with equal weights versus the official cap-weighted
 * index) and a weighting effect (strategy − EW, same universe and months).
 */
export function decomposition(c: Ctx, id: SeriesId): { total: number; universe: number; weighting: number } | null {
  if (id === 'CW' || !c.view.series.has('EW')) return null;
  const s = stats(c, id).cagr;
  const ew = stats(c, 'EW').cagr;
  const spi = stats(c, 'CW').cagr;
  return { total: s - spi, universe: ew - spi, weighting: s - ew };
}

export function periodLabel(c: Ctx): string {
  const [a, b] = c.view.period;
  return `${a} – ${b} (${c.view.months.length} months)`;
}

export function basisLabel(c: Ctx): string {
  return c.s.basis === 'net' ? `net of ${c.s.bps} bp transaction costs on traded value` : 'gross of transaction costs';
}

export function configLabel(c: Ctx): string {
  const f = { M: 'monthly', Q: 'quarterly', A: 'annual' }[c.s.freq];
  const cov = c.s.cov === 'lw' ? 'Ledoit-Wolf shrinkage' : 'sample (ridge)';
  const cap = c.s.cap === 'none' ? 'no weight cap' : `cap ${c.s.cap}%`;
  return `${c.s.window}-month window · ${f} rebalancing · ${cov} covariance · ${cap}`;
}
