/** Robustness: sensitivity to the window, rebalancing, costs, covariance, caps and regimes; bootstrap tests. */

import type { Freq, SeriesId, StrategiesFile } from '../data/types.ts';
import { holm, sharpeDiffBootstrap } from '../engine/bootstrap.ts';
import { netReturns, perfStats } from '../engine/metrics.ts';
import { availableRange, buildView } from '../model.ts';
import { configKey } from '../data/loader.ts';
import { baseLayout, draw, exportsHtml, SHORT, wireExports } from '../ui/charts.ts';
import { basisLabel, periodLabel, stats, type Ctx } from '../ui/context.ts';
import { download, tableCsv, toCsv } from '../ui/export.ts';
import { escapeHtml, num, pct, pval } from '../ui/format.ts';

const FREQ_LABEL: Record<Freq, string> = { M: 'Monthly', Q: 'Quarterly', A: 'Annual' };

export async function renderRobustness(c: Ctx, load: (key: string) => Promise<StrategiesFile>): Promise<void> {
  const { s, m, theme: t } = c;
  const target = (c.view.series.has(s.robust) ? s.robust : 'GMV') as SeriesId;
  const options = (['EW', 'GMV', 'ERC', 'TP', 'MDP', 'IVP', 'TP_SAMPLE'] as SeriesId[]).filter((id) => c.view.series.has(id));
  c.root.innerHTML = `
  <section class="card"><h2>Robustness</h2>
    <p class="muted small">${escapeHtml(basisLabel(c))}. No strategy is selected from these tables: they show how much the conclusions depend on choices made before looking at the results.</p>
    <p class="warn">Picking the best cell of a heatmap and reporting its Sharpe ratio as out-of-sample evidence is data snooping: the ${m.grid.windows.length * m.grid.freqs.length * m.grid.cov.length * Object.keys(m.grid.caps).length} configurations are evaluated on the same months. A configuration chosen this way would have to be validated on a later, untouched period (nested walk-forward); the bootstrap and Holm corrections below only cover the strategies of one configuration.</p>
    <div class="tools"><label>Strategy for the heatmaps <select id="rb-strat">${options.map((id) => `<option value="${id}" ${id === target ? 'selected' : ''}>${SHORT[id]}</option>`).join('')}</select></label></div></section>
  <div class="grid2">
    <section class="card"><h3>Sharpe ratio — window × rebalancing (${SHORT[target]})</h3><div id="ch-hw" class="chart short"></div>${exportsHtml('ch-hw', 'heatmap_window_frequency')}<p class="note" id="hw-note">Loading the other configurations…</p></section>
    <section class="card"><h3>Sharpe ratio — covariance × weight cap (${SHORT[target]})</h3><div id="ch-hc" class="chart short"></div>${exportsHtml('ch-hc', 'heatmap_cov_cap')}<p class="note" id="hc-note"></p></section>
  </div>
  <section class="card"><header class="card-head"><div><h3>Transaction-cost scenarios — current configuration, ${escapeHtml(periodLabel(c))}</h3></div><div class="tools"><button type="button" id="dl-cost">Export CSV</button></div></header><div class="table-wrap" id="tb-cost-wrap"></div></section>
  <section class="card"><header class="card-head"><div><h3>Historical regimes — CAGR (${s.basis})</h3><p class="muted small">Regimes defined in advance from economic history (pipeline/config.py), intersected with the available sample of this configuration.</p></div><div class="tools"><button type="button" id="dl-reg">Export CSV</button></div></header><div class="table-wrap" id="tb-reg-wrap"></div></section>
  <section class="card"><header class="card-head"><div><h3>Sharpe ratio differences — stationary bootstrap</h3><p class="muted small">${escapeHtml(periodLabel(c))}; 2,000 paired resamples, mean block length 6 months, fixed seed. Holm-adjusted p-values control the family-wise error over the comparisons in each table.</p></div><div class="tools"><button type="button" id="dl-boot">Export CSV</button></div></header><div class="table-wrap" id="tb-boot-wrap"></div>
    <p class="note">ΔSR = SR<sub>strategy</sub> − SR<sub>reference</sub>, annualised. The percentile interval and the p-value come from the bootstrap distribution of ΔSR (re-centred for the p-value). Seven strategies compared with the same benchmark on the same sample: unadjusted p-values overstate the evidence.</p></section>`;

  c.root.querySelector<HTMLSelectElement>('#rb-strat')!.onchange = (e) => c.set({ robust: (e.target as HTMLSelectElement).value as SeriesId });

  // ---- costs
  const ids = c.visible.filter((id) => id !== 'MONKEYS' || c.view.series.has('MONKEYS'));
  const costs = [0, 10, 25, 50, 100];
  const costRows = ids.filter((id) => id !== 'CW').map((id) => {
    const sv = c.view.series.get(id)!;
    return { id, cells: costs.map((bp) => perfStats(netReturns(sv.gross, sv.turnover, bp), c.view.rf, c.view.spi)) };
  });
  const cw = stats(c, 'CW');
  c.root.querySelector('#tb-cost-wrap')!.innerHTML = `<table class="data" id="tb-cost"><thead><tr><th rowspan="2">Portfolio</th>${costs.map((bp) => `<th colspan="2">${bp} bp</th>`).join('')}</tr><tr>${costs.map(() => '<th>CAGR</th><th>Sharpe</th>').join('')}</tr></thead><tbody>
    <tr><th scope="row">${SHORT.CW}</th>${costs.map(() => `<td>${pct(cw.cagr)}</td><td>${num(cw.sharpe, 2)}</td>`).join('')}</tr>
    ${costRows.map((r) => `<tr><th scope="row"><span class="dot" style="background:${t.color[r.id]}"></span>${SHORT[r.id]}</th>${r.cells.map((st) => `<td data-v="${st.cagr}">${pct(st.cagr)}</td><td data-v="${st.sharpe}">${num(st.sharpe, 2)}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <p class="note">Monkeys: average portfolio, each monkey paying the cost on its own turnover.</p>`;
  c.root.querySelector<HTMLButtonElement>('#dl-cost')!.onclick = () => download('cost_scenarios.csv', tableCsv(c.root.querySelector('#tb-cost')!));

  // ---- regimes
  const regRows = m.regimes.map((g) => {
    const k = c.view.months.map((mo, i) => [mo, i] as const).filter(([mo]) => mo >= g.start && mo <= g.end).map(([, i]) => i);
    return { g, k };
  });
  c.root.querySelector('#tb-reg-wrap')!.innerHTML = `<table class="data" id="tb-reg"><thead><tr><th>Regime</th><th>Months</th>${ids.map((id) => `<th><span class="dot" style="background:${t.color[id]}"></span>${SHORT[id]}</th>`).join('')}</tr></thead><tbody>
    ${regRows.map(({ g, k }) => `<tr><th scope="row">${escapeHtml(g.name)} <span class="muted small">${g.start} – ${g.end > m.last_complete_month ? m.last_complete_month : g.end}</span></th><td>${k.length}</td>${ids.map((id) => {
      if (k.length < 3) return '<td class="muted">n/a</td>';
      const r = k.map((i) => c.view.series.get(id)!.r[i]);
      const v = Math.pow(r.reduce((a, x) => a * (1 + x), 1), 12 / r.length) - 1;
      return `<td data-v="${v}">${pct(v, 1)}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table><p class="note">n/a: the regime does not overlap the selected period (or fewer than 3 months).</p>`;
  c.root.querySelector<HTMLButtonElement>('#dl-reg')!.onclick = () => download('regimes.csv', tableCsv(c.root.querySelector('#tb-reg')!));

  // ---- bootstrap
  const ex = (id: SeriesId) => c.view.series.get(id)!.r.map((x, i) => x - c.view.rf[i]);
  const strategies = ids.filter((id) => id !== 'CW');
  const vsSpi = strategies.map((id) => sharpeDiffBootstrap(ex(id), ex('CW'), { seed: 101 }));
  const adjSpi = holm(vsSpi.map((b) => b.pvalue));
  const others = strategies.filter((id) => id !== 'EW');
  const vsEw = others.map((id) => sharpeDiffBootstrap(ex(id), ex('EW'), { seed: 202 }));
  const adjEw = holm(vsEw.map((b) => b.pvalue));
  const row = (id: SeriesId, b: (typeof vsSpi)[number], adj: number) => `<tr><th scope="row"><span class="dot" style="background:${t.color[id]}"></span>${SHORT[id]}</th><td data-v="${b.diff}">${num(b.diff, 3)}</td><td data-v="${b.low}">${num(b.low, 3)}</td><td data-v="${b.high}">${num(b.high, 3)}</td><td data-v="${b.pvalue}">${pval(b.pvalue)}</td><td data-v="${adj}">${pval(adj)}</td></tr>`;
  c.root.querySelector('#tb-boot-wrap')!.innerHTML = `<table class="data" id="tb-boot"><thead><tr><th>Strategy</th><th>ΔSR</th><th>95 % low</th><th>95 % high</th><th>p</th><th>p (Holm)</th></tr></thead><tbody>
    <tr class="group"><th colspan="6">Against the SPI (CW)</th></tr>${strategies.map((id, i) => row(id, vsSpi[i], adjSpi[i])).join('')}
    <tr class="group"><th colspan="6">Against the equally-weighted portfolio</th></tr>${others.map((id, i) => row(id, vsEw[i], adjEw[i])).join('')}</tbody></table>`;
  c.root.querySelector<HTMLButtonElement>('#dl-boot')!.onclick = () => download('sharpe_bootstrap.csv', tableCsv(c.root.querySelector('#tb-boot')!));

  // ---- heatmaps (other configurations, loaded on demand)
  const sharpeOf = (file: StrategiesFile, freq: Freq, start: string, end: string): number => {
    const v = buildView(file, c.market, null, { ...s, freq, start, end });
    const sv = v.series.get(target)!;
    return perfStats(sv.r, v.rf, v.spi).sharpe;
  };
  let hwCsv = () => '';
  let hcCsv = () => '';
  try {
    const files = await Promise.all(m.grid.windows.map((w) => load(configKey(w, s.cov, s.cap))));
    const ranges = files.map((f) => availableRange(f, c.market));
    const start = [s.start, ...ranges.map((r) => r[0])].sort().at(-1)!;
    const end = [s.end, ...ranges.map((r) => r[1])].sort()[0];
    const z = files.map((f) => m.grid.freqs.map((fq) => sharpeOf(f, fq, start, end)));
    draw(document.getElementById('ch-hw'), [{ z, x: m.grid.freqs.map((f) => FREQ_LABEL[f]), y: m.grid.windows.map((w) => `${w} months`), type: 'heatmap', colorscale: [[0, '#e9eef7'], [1, '#1d4f91']], text: z.map((r) => r.map((v) => v.toFixed(2))), texttemplate: '%{text}', hovertemplate: '%{y}, %{x}: Sharpe %{z:.3f}<extra></extra>', xgap: 2, ygap: 2, colorbar: { thickness: 10 } }],
      baseLayout(t, { margin: { l: 90, r: 20, t: 10, b: 40 }, yaxis: { title: { text: 'Estimation window' } } }));
    c.root.querySelector('#hw-note')!.textContent = `Common sample ${start} – ${end} for all windows (the longest window starts latest); ${s.cov === 'lw' ? 'Ledoit-Wolf' : 'sample'} covariance, cap ${s.cap}.`;
    hwCsv = () => toCsv([['window', ...m.grid.freqs], ...m.grid.windows.map((w, i) => [w, ...z[i]])]);

    const keys = m.grid.cov.flatMap((cov) => Object.keys(m.grid.caps).map((cap) => [cov, cap] as const));
    const files2 = await Promise.all(keys.map(([cov, cap]) => load(configKey(s.window, cov, cap))));
    const r2 = files2.map((f) => availableRange(f, c.market));
    const st2 = [s.start, ...r2.map((r) => r[0])].sort().at(-1)!;
    const en2 = [s.end, ...r2.map((r) => r[1])].sort()[0];
    const caps = Object.keys(m.grid.caps);
    const z2 = m.grid.cov.map((cov) => caps.map((cap) => sharpeOf(files2[keys.findIndex((k) => k[0] === cov && k[1] === cap)], s.freq, st2, en2)));
    draw(document.getElementById('ch-hc'), [{ z: z2, x: caps.map((k) => (k === 'none' ? 'No cap' : `Cap ${k}%`)), y: m.grid.cov.map((k) => (k === 'lw' ? 'Ledoit-Wolf' : 'Sample + ridge')), type: 'heatmap', colorscale: [[0, '#e9eef7'], [1, '#1d4f91']], text: z2.map((r) => r.map((v) => v.toFixed(2))), texttemplate: '%{text}', hovertemplate: '%{y}, %{x}: Sharpe %{z:.3f}<extra></extra>', xgap: 2, ygap: 2, colorbar: { thickness: 10 } }],
      baseLayout(t, { margin: { l: 110, r: 20, t: 10, b: 40 } }));
    c.root.querySelector('#hc-note')!.textContent = `${s.window}-month window, ${FREQ_LABEL[s.freq].toLowerCase()} rebalancing, sample ${st2} – ${en2}. EW is unaffected by the covariance; IVP only through the diagonal, identical for both estimators.`;
    hcCsv = () => toCsv([['covariance', ...caps], ...m.grid.cov.map((cov, i) => [cov, ...z2[i]])]);
  } catch (e) {
    c.root.querySelector('#hw-note')!.textContent = `Configurations unavailable: ${(e as Error).message}`;
  }
  wireExports(c.root, { 'ch-hw': () => hwCsv(), 'ch-hc': () => hcCsv() });
}
