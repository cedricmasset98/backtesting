/** Malkiel's Monkeys: distribution of 100 random portfolios and position of the strategies. */

import type { SeriesId } from '../data/types.ts';
import { maxDrawdown, mean, percentileRank, perfStats, quantile, wealth } from '../engine/metrics.ts';
import { wealthDates } from '../model.ts';
import { baseLayout, bins, draw, exportsHtml, LABEL, SHORT, wireExports } from '../ui/charts.ts';
import { biasLabel, biasShade } from './performance.ts';
import { basisLabel, configLabel, periodLabel, stats, type Ctx } from '../ui/context.ts';
import { download, tableCsv, toCsv } from '../ui/export.ts';
import { escapeHtml, num, pct } from '../ui/format.ts';

type Metric = { key: string; label: string; get: (r: number[], rf: number[], b: number[]) => number; fmt: (x: number) => string; axis: string };

export function renderMonkeys(c: Ctx): void {
  const { view, s, theme: t, m } = c;
  if (!view.monkeys.r.length) {
    c.root.innerHTML = `<section class="card"><h2>Malkiel's Monkeys</h2><p class="warn">The monkeys file for this configuration is not available.</p></section>`;
    return;
  }
  const metrics: Metric[] = [
    { key: 'cagr', label: 'CAGR', get: (r, rf, b) => perfStats(r, rf, b).cagr, fmt: (x) => pct(x), axis: '.0%' },
    { key: 'sharpe', label: 'Sharpe ratio', get: (r, rf, b) => perfStats(r, rf, b).sharpe, fmt: (x) => num(x, 2), axis: '.2f' },
    { key: 'vol', label: 'Volatility', get: (r, rf, b) => perfStats(r, rf, b).vol, fmt: (x) => pct(x), axis: '.0%' },
    { key: 'mdd', label: 'Maximum drawdown', get: (r) => maxDrawdown(r), fmt: (x) => pct(x, 1), axis: '.0%' },
    { key: 'final', label: 'Final value of 100 CHF', get: (r) => wealth(r).at(-1)!, fmt: (x) => num(x, 0), axis: '.0f' },
  ];
  const mk = view.monkeys.r.map((r) => perfStats(r, view.rf, view.spi));
  const values: Record<string, number[]> = {};
  for (const mt of metrics) values[mt.key] = view.monkeys.r.map((r, j) => (mt.key === 'cagr' ? mk[j].cagr : mt.key === 'sharpe' ? mk[j].sharpe : mt.key === 'vol' ? mk[j].vol : mt.key === 'mdd' ? mk[j].maxDD : mt.get(r, view.rf, view.spi)));
  const marks: SeriesId[] = (['CW', 'EW', 'GMV', 'ERC', 'TP', 'MDP', 'IVP'] as SeriesId[]).filter((id) => view.series.has(id));
  const val = (id: SeriesId, key: string) => {
    const st = stats(c, id);
    return key === 'cagr' ? st.cagr : key === 'sharpe' ? st.sharpe : key === 'vol' ? st.vol : key === 'mdd' ? st.maxDD : 100 * (1 + st.cumulative);
  };
  const avg = view.series.get('MONKEYS')!;
  const avgStats = stats(c, 'MONKEYS');

  c.root.innerHTML = `
  <section class="card">
    <h2>Malkiel's Monkeys — ${m.grid.n_monkeys} random portfolios</h2>
    <p class="muted small">${escapeHtml(configLabel(c))} · ${escapeHtml(periodLabel(c))} · ${escapeHtml(basisLabel(c))} · K = ${s.k} stocks, seed ${s.seed} (change them in the settings bar)</p>
    <p class="note"><strong>Drawing rules.</strong> At the first decision date and at every scheduled rebalancing date (${s.freq === 'M' ? 'month-ends' : s.freq === 'Q' ? 'quarter-ends' : 'year-ends'}), each monkey draws ${s.k} stocks uniformly without replacement from the same eligible universe as the strategies
    (same ${s.window}-month history, liquidity and listing screens), holds them with equal weights and lets the weights drift until the next draw. Delistings and transaction costs are treated as for the strategies.
    The generator of monkey j at month t is seeded with (seed, j, yyyymm): the draws are reproducible and cannot depend on later data.
    This is an illustration, not a definitive test of superiority: the distribution depends on the drawing rules, K and the universe.</p>
  </section>
  <section class="card">
    <header class="card-head"><div><h3>Distribution of the 100 monkeys and rank of the strategies</h3></div><div class="tools"><button type="button" id="dl-mk">Export CSV</button></div></header>
    <div class="table-wrap"><table class="data" id="tb-mk"><thead><tr><th>Statistic</th><th>Mean of the 100</th><th>Median</th><th>P5</th><th>P25</th><th>P75</th><th>P95</th><th>Average portfolio</th>${marks.map((id) => `<th><span class="dot" style="background:${t.color[id]}"></span>${SHORT[id]} (percentile)</th>`).join('')}</tr></thead><tbody>
    ${metrics.map((mt) => {
      const v = values[mt.key];
      const avgV = mt.key === 'cagr' ? avgStats.cagr : mt.key === 'sharpe' ? avgStats.sharpe : mt.key === 'vol' ? avgStats.vol : mt.key === 'mdd' ? avgStats.maxDD : wealth(avg.r).at(-1)!;
      return `<tr><th scope="row">${mt.label}</th><td>${mt.fmt(mean(v))}</td><td>${mt.fmt(quantile(v, 0.5))}</td><td>${mt.fmt(quantile(v, 0.05))}</td><td>${mt.fmt(quantile(v, 0.25))}</td><td>${mt.fmt(quantile(v, 0.75))}</td><td>${mt.fmt(quantile(v, 0.95))}</td><td>${mt.fmt(avgV)}</td>${marks.map((id) => `<td>${mt.fmt(val(id, mt.key))} <span class="muted">(${(100 * percentileRank(v, val(id, mt.key))).toFixed(0)})</span></td>`).join('')}</tr>`;
    }).join('')}
    </tbody></table></div>
    <p class="note">"Mean of the 100" averages each monkey's own statistic. "Average portfolio" is a different object: one portfolio investing equally in the 100 monkeys (re-equalised monthly at no cost); its volatility and drawdown are lower than the average of the individual figures because the monkeys diversify one another.
    Percentile: share of the 100 monkeys with a lower value (for volatility and drawdown a low percentile means less risk / deeper loss respectively).</p>
  </section>
  <div class="grid2" id="mk-hists">${metrics.map((mt) => `<section class="card"><h3>${mt.label}</h3><div id="ch-mk-${mt.key}" class="chart short"></div>${exportsHtml(`ch-mk-${mt.key}`, `monkeys_${mt.key}`, false)}</section>`).join('')}</div>
  <section class="card"><h3>Trajectories of the 100 monkeys</h3><div id="ch-mk-paths" class="chart tall"></div>${exportsHtml('ch-mk-paths', 'monkeys_paths')}
    <p class="note">Thin grey lines: the 100 monkeys (portfolio-level results only, no individual stock data). The strategies and the SPI are overlaid.</p></section>`;

  c.root.querySelector<HTMLButtonElement>('#dl-mk')!.onclick = () => download('monkeys_distribution.csv', tableCsv(c.root.querySelector('#tb-mk')!));

  for (const mt of metrics) {
    const v = values[mt.key];
    const b = bins([...v, ...marks.map((id) => val(id, mt.key))], 20);
    const shapes = marks.map((id) => ({ type: 'line', x0: val(id, mt.key), x1: val(id, mt.key), yref: 'paper', y0: 0, y1: 1, line: { color: t.color[id], width: id === 'CW' ? 3 : 2, dash: id === 'CW' ? 'dot' : 'solid' } }));
    const ann = marks.map((id, i) => ({ x: val(id, mt.key), y: 1 - (i % 4) * 0.09, yref: 'paper', text: SHORT[id], showarrow: false, font: { size: 10, color: t.fg }, bgcolor: t.panel, xanchor: 'left' }));
    draw(document.getElementById(`ch-mk-${mt.key}`), [{ x: v, type: 'histogram', xbins: b, marker: { color: t.color.MONKEYS, opacity: 0.55, line: { color: t.bg, width: 1 } }, name: 'Monkeys', hovertemplate: '%{x}: %{y} monkeys<extra></extra>' }],
      baseLayout(t, { showlegend: false, shapes, annotations: ann, bargap: 0.05, xaxis: { title: { text: mt.label }, tickformat: mt.axis }, yaxis: { title: { text: 'Monkeys' } }, margin: { l: 50, r: 20, t: 10, b: 45 } }));
  }

  const dates = wealthDates(view.months);
  const paths = view.monkeys.r.map((r) => wealth(r));
  const tr: unknown[] = paths.map((p, j) => ({ x: dates, y: p, type: 'scatter', mode: 'lines', line: { color: t.muted, width: 0.6 }, opacity: 0.35, showlegend: j === 0, name: 'Monkeys', legendgroup: 'mk', hoverinfo: 'skip' }));
  for (const id of [...marks, 'MONKEYS' as SeriesId]) tr.push({ x: dates, y: wealth(view.series.get(id)!.r), type: 'scatter', mode: 'lines', name: SHORT[id], line: { color: t.color[id], width: id === 'CW' ? 3 : 2, dash: id === 'MONKEYS' ? 'dash' : 'solid' }, hovertemplate: `${LABEL[id]}: %{y:.1f}<extra></extra>` });
  draw(document.getElementById('ch-mk-paths'), tr, baseLayout(t, { hovermode: 'closest', xaxis: { type: 'date' }, yaxis: { type: s.log ? 'log' : 'linear', title: { text: 'Value of 100 CHF' } }, shapes: biasShade(c, dates[0]), annotations: biasLabel(c, dates[0]) }));

  wireExports(c.root, {
    'ch-mk-paths': () => toCsv([['date', ...paths.map((_, j) => `monkey_${j}`)], ...dates.map((d, i) => [d, ...paths.map((p) => p[i])])]),
  });
}
