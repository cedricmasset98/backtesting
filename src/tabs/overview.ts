/** Overview & Configuration: summary, warnings and methodology at a glance. */

import { baseLayout, draw, LABEL } from '../ui/charts.ts';
import { basisLabel, configLabel, periodLabel, stats, type Ctx } from '../ui/context.ts';
import { escapeHtml, num, pct } from '../ui/format.ts';
import { monthEnd } from '../model.ts';

export function renderOverview(c: Ctx): void {
  const { m, s, view, theme: t, strat } = c;
  const controlled = m.survivorship.controlled_start;
  const jkpLast = Object.values(m.factors).map((f) => f.last).sort()[0];
  const warnings: string[] = [];
  if (controlled && view.period[0] < controlled) {
    warnings.push(`<strong>Survivorship bias before ${controlled}.</strong> The data contain delisted stocks only from ${controlled.slice(0, 4)} onwards (${Object.entries(m.survivorship.delistings_by_year).map(([y, n]) => `${y}: ${n}`).join(', ')} delistings by year of last price). Before that, the universe consists mostly of companies that survived, which flatters every stock-based strategy relative to the SPI.`);
  }
  if (view.period[1] > jkpLast) warnings.push(`The Swiss JKP factors end in ${jkpLast}: factor regressions stop there.`);
  if (s.start < view.available[0] || s.end > view.available[1]) warnings.push(`The requested period was restricted to the months available for this configuration (${view.available[0]} – ${view.available[1]}).`);
  if (strat.decisions.tp_fallback.length) warnings.push(`Tangency portfolio: at ${strat.decisions.tp_fallback.length} decision date(s) no portfolio had a positive expected excess return; the strategy then held the GMV portfolio (${strat.decisions.tp_fallback.slice(0, 6).join(', ')}${strat.decisions.tp_fallback.length > 6 ? '…' : ''}).`);
  if (m.quick) warnings.push('This build used the reduced development grid (--quick): only one configuration is available.');

  const elig = m.universe.eligible[String(s.window)];
  const k0 = m.universe.months.indexOf(view.period[0]);
  const k1 = m.universe.months.indexOf(view.period[1]);
  const nEl = elig.slice(k0, k1 + 1);
  const ids = c.visible;

  c.root.innerHTML = `
  <section class="hero card">
    <h2>Eight portfolio strategies on Swiss equities, backtested walk-forward</h2>
    <p>${escapeHtml(configLabel(c))}<br/>${escapeHtml(periodLabel(c))} · ${escapeHtml(basisLabel(c))}</p>
    <div class="tiles">
      <div class="tile"><span class="tile-v">${view.months.length}</span><span class="tile-l">months out of sample</span></div>
      <div class="tile"><span class="tile-v">${Math.min(...nEl)}–${Math.max(...nEl)}</span><span class="tile-l">eligible stocks per date</span></div>
      <div class="tile"><span class="tile-v">${m.universe.stocks_in_panel}</span><span class="tile-l">stocks in the panel (${m.universe.delisted_in_panel} delisted)</span></div>
      <div class="tile"><span class="tile-v">${m.data_last_date}</span><span class="tile-l">last data date</span></div>
    </div>
  </section>
  ${warnings.length ? `<section class="card warnbox">${warnings.map((w) => `<p>${w}</p>`).join('')}</section>` : ''}
  <section class="card">
    <h3>Summary</h3>
    <div class="table-wrap"><table class="data"><thead><tr><th>Portfolio</th><th>CAGR</th><th>Volatility</th><th>Sharpe</th><th>Max drawdown</th><th>Final value of 100 CHF</th></tr></thead><tbody>
    ${ids.map((id) => {
      const st = stats(c, id);
      return `<tr><th scope="row"><span class="dot" style="background:${t.color[id]}"></span>${LABEL[id]}</th><td>${pct(st.cagr)}</td><td>${pct(st.vol)}</td><td>${num(st.sharpe, 2)}</td><td>${pct(st.maxDD, 1)}</td><td>${num(100 * (1 + st.cumulative), 1)}</td></tr>`;
    }).join('')}
    </tbody></table></div>
    <p class="note">Rows are in a fixed order; nothing is ranked. Differences of this size over ${Math.round(view.months.length / 12)} years are often within sampling error: see the bootstrap tests in the Robustness tab.</p>
  </section>
  <div class="grid2">
    <section class="card"><h3>Eligible universe over time</h3><div id="ch-univ" class="chart short"></div>
      <p class="note">Stocks passing the screens at each month-end for the ${s.window}-month window (listed, traded within ${m.universe.rules.stale_max_days} days of month-end, median daily traded value ≥ CHF ${m.universe.rules.liq_min_median_value_chf.toLocaleString('en')}, ≤ ${m.universe.rules.liq_max_zero_volume * 100} % days without volume, ${s.window} complete monthly returns).</p></section>
    <section class="card"><h3>How to read this site</h3>
      <ul class="plain">
        <li><strong>Walk-forward.</strong> At each month-end t the pipeline uses only data up to t to choose the weights; they earn the returns from t+1 onward. Weights drift between rebalancing dates.</li>
        <li><strong>What is computed where.</strong> Optimisations run in the private pipeline for every combination of the grid (${m.grid.windows.join('/')} months × ${m.grid.freqs.join('/')} × ${m.grid.cov.join('/')} × caps ${Object.keys(m.grid.caps).join('/')}%). Your browser applies transaction costs to the published turnover — exact for proportional costs — and restricts the evaluation period without re-optimising.</li>
        <li><strong>Other settings</strong> (another window, cap or universe rule) need a run of the private pipeline: edit <code>pipeline/config.py</code> and run the workflow. Nothing here is simulated from invented data.</li>
        <li><strong>Benchmark.</strong> CW is the official SPI total return index (no costs). Individual free-float capitalisations are not available, so the cap-weighted portfolio is not replicated.</li>
        <li><strong>Data licence.</strong> Individual prices stay private; the site publishes portfolio-level results only.</li>
      </ul></section>
  </div>`;

  const months = m.universe.months;
  const x = months.map(monthEnd);
  draw(document.getElementById('ch-univ'), [
    { x, y: m.universe.listed, name: 'Listed and traded', type: 'scatter', mode: 'lines', line: { color: t.muted, width: 1.5 } },
    ...m.grid.windows.map((w, i) => ({ x, y: m.universe.eligible[String(w)], name: `Eligible, ${w}m`, type: 'scatter', mode: 'lines', line: { color: t.color[(['EW', 'GMV', 'ERC', 'TP'] as const)[i % 4]], width: w === s.window ? 2.5 : 1, dash: w === s.window ? 'solid' : 'dot' } })),
  ], baseLayout(t, { hovermode: 'x unified', xaxis: { type: 'date' }, yaxis: { title: { text: 'Stocks' } }, shapes: controlled ? [{ type: 'line', x0: monthEnd(controlled), x1: monthEnd(controlled), yref: 'paper', y0: 0, y1: 1, line: { color: t.muted, dash: 'dot', width: 1 } }] : [], annotations: controlled ? [{ x: monthEnd(controlled), y: 1, yref: 'paper', text: 'delistings covered', showarrow: false, xanchor: 'left', font: { size: 10, color: t.muted } }] : [] }));
}
