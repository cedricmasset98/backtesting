/** Allocation & Portfolio Composition (aggregated: no individual weight history is published). */

import type { HoldingsFile, StratId } from '../data/types.ts';
import { monthEnd, STRATS } from '../model.ts';
import { baseLayout, draw, exportsHtml, LABEL, SHORT, wireExports } from '../ui/charts.ts';
import { biasShade } from './performance.ts';
import { configLabel, type Ctx } from '../ui/context.ts';
import { toCsv } from '../ui/export.ts';
import { escapeHtml, pct } from '../ui/format.ts';

export function renderComposition(c: Ctx, hold: HoldingsFile): void {
  const { s, theme: t, strat, view } = c;
  const ids = c.visible.filter((id): id is StratId => (STRATS as string[]).includes(id));
  const f = strat.freqs[s.freq];
  const dates = view.months.map(monthEnd);
  const pick = (a: (number | null)[]) => view.idx.map((i) => a[i]);
  const snap = hold.snapshots.find((x) => x.month === s.snap) ?? hold.snapshots[hold.snapshots.length - 1];
  const dec = strat.decisions;
  const reb = new Set(dec.months.filter((m) => s.freq === 'M' || Number(m.slice(5)) % (s.freq === 'Q' ? 3 : 12) === 0));
  const dIdx = dec.months.map((m, i) => [m, i] as const).filter(([m]) => reb.has(m) && m >= view.period[0] && m <= view.period[1]);

  // ERC under the cap: how often the cap binds and how far the result is from equal contributions
  const ercRows = dIdx.filter(([, i]) => dec.erc_capped && dec.exante.ERC.eff_rc[i] !== null);
  const bind = ercRows.filter(([, i]) => (dec.erc_capped?.[i] ?? 0) > 0);
  const fallback = ercRows.filter(([, i]) => (dec.erc_capped?.[i] ?? 0) < 0).map(([m]) => m);
  const ratio = ercRows.map(([, i]) => (dec.exante.ERC.eff_rc[i] as number) / dec.n_eligible[i]).sort((a, b) => a - b);
  const med = ratio.length ? ratio[Math.floor(ratio.length / 2)] : NaN;
  const ercNote = ercRows.length
    ? `<p class="note"><strong>ERC and the ${strat.cap_value * 100} % cap.</strong> The cap binds at ${bind.length} of ${ercRows.length} rebalancing decisions in the period${bind.length ? ` (median ${bind.map(([, i]) => dec.erc_capped![i]).sort((a, b) => a - b)[Math.floor(bind.length / 2)]} stock(s) at the cap)` : ''}. Capped stocks keep a smaller risk contribution, all the others have exactly equal contributions. Effective number of risk contributions / N: median ${pct(med, 1)} (100 % = unconstrained ERC).${fallback.length ? ` At ${fallback.length} decision(s) (${fallback.join(', ')}) the constrained problem could not be solved numerically (near-singular covariance) and the ERC weights were capped proportionally instead.` : ''}</p>`
    : '';

  c.root.innerHTML = `
  <section class="card"><h2>Allocation &amp; Portfolio Composition</h2>
    <p class="muted small">${escapeHtml(configLabel(c))}</p>
    <p class="note"><strong>Why aggregated views.</strong> The EODHD licence forbids redistributing individual price data. Publishing the complete weight vectors of the ${Object.keys(c.m.grid.caps).length * c.m.grid.cov.length * c.m.grid.windows.length * 3 * 7} published portfolios together with their returns would allow anyone to solve for the monthly return of every stock.
    The site therefore shows concentration statistics every month, ex ante risk statistics at each rebalancing date, and only the ten largest positions at year-end snapshots.</p></section>
  <div class="grid2">
    <section class="card"><h3>Effective number of positions (1/Σw²)</h3><div id="ch-effn" class="chart short"></div>${exportsHtml('ch-effn', 'effective_n')}</section>
    <section class="card"><h3>Number of positions</h3><div id="ch-npos" class="chart short"></div>${exportsHtml('ch-npos', 'n_positions')}</section>
    <section class="card"><h3>Largest weight</h3><div id="ch-maxw" class="chart short"></div>${exportsHtml('ch-maxw', 'max_weight')}<p class="note">Weights held at the start of each month. The cap applies to the target weights at each rebalancing date; between two rebalancing dates a stock that outperforms can drift above it.</p></section>
    <section class="card"><h3>Weight of the ten largest positions</h3><div id="ch-top10" class="chart short"></div>${exportsHtml('ch-top10', 'top10_weight')}</section>
    <section class="card"><h3>Turnover at each trade date</h3><div id="ch-to" class="chart short"></div>${exportsHtml('ch-to', 'turnover')}
      <p class="note">Σ|w<sub>target</sub> − w<sub>before</sub>| (buys + sells, fraction of wealth). Small values between rebalancing dates come from reinvesting the proceeds of delisted stocks.</p></section>
    <section class="card"><h3>Ex ante risk concentration at rebalancing dates</h3><div id="ch-rc" class="chart short"></div>${exportsHtml('ch-rc', 'risk_concentration')}
      <p class="note">Effective number of risk contributions 1/Σ RC<sub>i</sub>², RC<sub>i</sub> = w<sub>i</sub>(Σw)<sub>i</sub>/w'Σw (with the covariance estimated at the date). Without a binding cap ERC equalises the contributions, so this number equals N.</p>
      ${ercNote}</section>
  </div>
  <section class="card">
    <header class="card-head"><div><h3>Largest positions and risk contributions</h3><p class="muted small">Snapshot of the decision at the end of ${snap.month} (${snap.n_eligible} eligible stocks); weights are the targets set at that date.</p></div>
      <div class="tools"><label>Snapshot <select id="hold-snap">${hold.snapshots.map((x) => `<option value="${x.month}" ${x.month === snap.month ? 'selected' : ''}>${x.month}</option>`).join('')}</select></label></div></header>
    <div class="holdings">${ids.map((id) => {
      const h = snap.strategies[id];
      return `<div class="hold"><h4><span class="dot" style="background:${t.color[id]}"></span>${LABEL[id]}</h4>
        <p class="muted small">${h.n_pos} positions · top-10 share of variance ${pct(h.top10_rc, 1)}</p>
        <table class="data compact"><thead><tr><th>Company</th><th>Weight</th><th>Risk contr.</th></tr></thead><tbody>
        ${h.top.map((p) => `<tr><td title="${escapeHtml(p.code)}">${escapeHtml(p.name)}</td><td>${pct(p.w, 1)}</td><td>${pct(p.rc, 1)}</td></tr>`).join('')}
        </tbody></table></div>`;
    }).join('')}</div>
  </section>`;

  c.root.querySelector<HTMLSelectElement>('#hold-snap')!.onchange = (e) => c.set({ snap: (e.target as HTMLSelectElement).value });

  const line = (id: StratId, y: (number | null)[], x = dates) => ({ x, y, name: SHORT[id], type: 'scatter', mode: 'lines', line: { color: t.color[id], width: 1.6, dash: id === 'TP_SAMPLE' ? 'dot' : 'solid', shape: 'hv' }, hovertemplate: `${SHORT[id]}: %{y:.3~f}<extra></extra>` });
  const lay = (title: string, fmt = '') => baseLayout(t, { hovermode: 'x unified', xaxis: { type: 'date' }, yaxis: { title: { text: title }, tickformat: fmt }, margin: { l: 55, r: 15, t: 10, b: 40 }, shapes: biasShade(c, dates[0]) });
  draw(document.getElementById('ch-effn'), ids.map((id) => line(id, pick(f[id].eff_n))), { ...lay('Effective N'), yaxis: { ...(lay('Effective N').yaxis as object), type: 'log' } });
  draw(document.getElementById('ch-npos'), ids.map((id) => line(id, pick(f[id].n_pos))), lay('Positions'));
  draw(document.getElementById('ch-maxw'), ids.map((id) => line(id, pick(f[id].max_w))), lay('Largest weight', '.0%'));
  draw(document.getElementById('ch-top10'), ids.map((id) => line(id, pick(f[id].top10))), lay('Top-10 weight', '.0%'));
  draw(document.getElementById('ch-to'), ids.map((id) => ({ ...line(id, pick(f[id].turnover).map((v) => (v === 0 ? null : v))), mode: 'markers', marker: { color: t.color[id], size: 5 } })), lay('Turnover', '.0%'));
  const rcDates = dIdx.map(([m]) => monthEnd(m));
  draw(document.getElementById('ch-rc'), ids.map((id) => line(id, dIdx.map(([, i]) => dec.exante[id].eff_rc[i]), rcDates)), { ...lay('Effective risk contributions'), yaxis: { ...(lay('').yaxis as object), type: 'log', title: { text: 'Effective N of risk contributions' } } });

  const csv = (key: 'eff_n' | 'n_pos' | 'max_w' | 'top10' | 'turnover') => () => toCsv([['month', ...ids], ...view.months.map((mo, k) => [mo, ...ids.map((id) => pick(f[id][key])[k])])]);
  wireExports(c.root, {
    'ch-effn': csv('eff_n'),
    'ch-npos': csv('n_pos'),
    'ch-maxw': csv('max_w'),
    'ch-top10': csv('top10'),
    'ch-to': csv('turnover'),
    'ch-rc': () => toCsv([['decision', ...ids.flatMap((id) => [`${id}_eff_rc`, `${id}_max_rc`, `${id}_vol_exante`, `${id}_dr`])], ...dIdx.map(([mo, i]) => [mo, ...ids.flatMap((id) => [dec.exante[id].eff_rc[i], dec.exante[id].max_rc[i], dec.exante[id].vol[i], dec.exante[id].dr[i]])])]),
  });
}
