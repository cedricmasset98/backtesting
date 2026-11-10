/**
 * From the published files to the series displayed for one configuration.
 *
 * Nothing is re-optimised here: weights, gross returns and turnover come from
 * the private pipeline for the selected (window, frequency, covariance, cap)
 * configuration. The browser only (i) applies proportional transaction costs
 * (a fixed cost per unit of turnover and, optionally, the estimated bid-ask
 * spread cost of the same trades), which is exact, (ii) restricts the evaluation
 * period — the portfolios keep the weights decided with the information of
 * their own decision dates — and (iii) rebases wealth to 100.
 */

import type { Market, MonkeysFile, SeriesId, StrategiesFile, StratId } from './data/types.ts';
import { netReturns } from './engine/metrics.ts';
import type { State } from './state.ts';

export interface SeriesView {
  id: SeriesId;
  gross: number[];
  net: number[];
  r: number[]; // basis selected (net or gross)
  turnover: (number | null)[];
  /** spread cost of the trades applied in `net` (zeros when the spread is switched off) */
  spread: (number | null)[];
  rebalanced: number[];
}

export interface View {
  months: string[];
  rf: number[];
  spi: number[];
  series: Map<SeriesId, SeriesView>;
  monkeys: { gross: number[][]; net: number[][]; r: number[][]; turnover: number[][]; spread: number[][] };
  available: [string, string];
  period: [string, string];
  /** index of each selected month in the strategy file */
  idx: number[];
}

export const STRATS: StratId[] = ['EW', 'GMV', 'ERC', 'TP', 'MDP', 'IVP', 'TP_SAMPLE'];

export function availableRange(strat: StrategiesFile, market: Market): [string, string] {
  const mi = new Map(market.months.map((m, i) => [m, i]));
  const ok = strat.months.filter((m) => {
    const i = mi.get(m);
    return i !== undefined && market.spi[i] !== null && market.rf[i] !== null;
  });
  return [ok[0], ok[ok.length - 1]];
}

export function buildView(strat: StrategiesFile, market: Market, monkeys: MonkeysFile | null, s: State): View {
  const mi = new Map(market.months.map((m, i) => [m, i]));
  const available = availableRange(strat, market);
  const start = s.start < available[0] ? available[0] : s.start;
  const end = s.end > available[1] || s.end < start ? available[1] : s.end;
  const idx: number[] = [];
  strat.months.forEach((m, i) => {
    if (m < start || m > end) return;
    const j = mi.get(m);
    if (j === undefined || market.spi[j] === null || market.rf[j] === null) return;
    idx.push(i);
  });
  const months = idx.map((i) => strat.months[i]);
  const rf = months.map((m) => market.rf[mi.get(m)!] as number);
  const spi = months.map((m) => market.spi[mi.get(m)!] as number);
  const series = new Map<SeriesId, SeriesView>();
  series.set('CW', { id: 'CW', gross: spi, net: spi, r: spi, turnover: months.map(() => null), spread: months.map(() => null), rebalanced: months.map(() => 0) });
  const f = strat.freqs[s.freq];
  for (const id of STRATS) {
    const x = f[id];
    const gross = idx.map((i) => x.gross[i] as number);
    const turnover = idx.map((i) => x.turnover[i]);
    const spread = idx.map((i) => (s.spread && x.spread ? x.spread[i] : 0));
    const net = netReturns(gross, turnover, s.bps, spread);
    series.set(id, { id, gross, net, r: s.basis === 'net' ? net : gross, turnover, spread, rebalanced: idx.map((i) => x.rebalanced[i]) });
  }
  const mk = { gross: [] as number[][], net: [] as number[][], r: [] as number[][], turnover: [] as number[][], spread: [] as number[][] };
  if (monkeys) {
    const pos = new Map(monkeys.months.map((m, i) => [m, i]));
    const sc = monkeys.scale;
    const cols = months.map((m) => pos.get(m));
    if (cols.every((c) => c !== undefined)) {
      for (let j = 0; j < monkeys.gross.length; j++) {
        const g = cols.map((c) => monkeys.gross[j][c!] / sc);
        const t = cols.map((c) => monkeys.turnover[j][c!] / sc);
        const sp = cols.map((c) => (s.spread && monkeys.spread ? monkeys.spread[j][c!] / sc : 0));
        const n = netReturns(g, t, s.bps, sp);
        mk.gross.push(g);
        mk.turnover.push(t);
        mk.spread.push(sp);
        mk.net.push(n);
        mk.r.push(s.basis === 'net' ? n : g);
      }
      const avg = (rows: number[][]) => months.map((_, t) => rows.reduce((a, row) => a + row[t], 0) / rows.length);
      const gross = avg(mk.gross);
      const net = avg(mk.net);
      series.set('MONKEYS', { id: 'MONKEYS', gross, net, r: s.basis === 'net' ? net : gross, turnover: avg(mk.turnover), spread: avg(mk.spread), rebalanced: months.map(() => 0) });
    }
  }
  return { months, rf, spi, series, monkeys: mk, available, period: [months[0], months[months.length - 1]], idx };
}

/** Month-end date of 'YYYY-MM' (for chart axes). */
export function monthEnd(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo, 0));
  return d.toISOString().slice(0, 10);
}

/** Dates for a wealth path: the month-end preceding the first return, then each month-end. */
export function wealthDates(months: string[]): string[] {
  const [y, mo] = months[0].split('-').map(Number);
  const prev = new Date(Date.UTC(y, mo - 1, 0)).toISOString().slice(0, 10);
  return [prev, ...months.map(monthEnd)];
}
