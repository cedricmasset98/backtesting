/** Factor Analysis: CAPM, FF3, Carhart-4, FF5 and FF5+MOM with Swiss factors. */

import type { SeriesId } from '../data/types.ts';
import { attribution, fitModel, MODEL_IDS, MODELS, FACTORS, type FactorData, type FitOutcome, type ModelId } from '../engine/factors.ts';
import { breuschPagan, defaultLjungBoxLags, jarqueBera, ljungBox, qqPoints } from '../engine/diagnostics.ts';
import { rollingOLS } from '../engine/rolling.ts';
import type { CovType } from '../engine/ols.ts';
import { monthEnd } from '../model.ts';
import { ALL_SERIES } from '../state.ts';
import { baseLayout, draw, exportsHtml, LABEL, SHORT, wireExports } from '../ui/charts.ts';
import { basisLabel, configLabel, periodLabel, type Ctx } from '../ui/context.ts';
import { download, tableCsv, toCsv } from '../ui/export.ts';
import { escapeHtml, num, pct, pval, stars } from '../ui/format.ts';

const INFERENCE: Record<CovType, string> = {
  classical: 'OLS (classical, t-distribution with n − k df)',
  HC3: 'HC3 heteroskedasticity-robust (normal inference)',
  HAC: 'Newey-West HAC, Bartlett kernel, L = ⌊4(n/100)^(2/9)⌋ (normal inference)',
};

const ROW_NAMES = ['alpha', ...FACTORS] as const;
const ROW_LABEL: Record<string, string> = { alpha: 'Alpha (% / month)', MKT: 'MKT', SMB: 'SMB', HML: 'HML', RMW: 'RMW', CMA: 'CMA', MOM: 'MOM' };

function factorData(c: Ctx): FactorData {
  return { months: c.market.months, rf: c.market.rf, factors: c.market.factors };
}

export function fits(c: Ctx, id: SeriesId, cov: CovType): Record<ModelId, FitOutcome> {
  const sv = c.view.series.get(id)!;
  const out = {} as Record<ModelId, FitOutcome>;
  for (const m of MODEL_IDS) out[m] = fitModel(c.view.months, sv.r, factorData(c), m, cov);
  return out;
}

function cellCoef(f: FitOutcome, name: string): string {
  if (!f.ok) return '<td class="na">—</td>';
  const j = f.result.names.indexOf(name);
  if (j < 0) return '<td></td>';
  const scale = name === 'alpha' ? 100 : 1;
  const b = f.result.beta[j] * scale;
  return `<td data-v="${f.result.beta[j]}"><div class="coef">${num(b, name === 'alpha' ? 3 : 3)}<sup>${stars(f.result.pvalue[j])}</sup></div><div class="tstat">(${num(f.result.stat[j], 2)})</div></td>`;
}

export function renderFactors(c: Ctx): void {
  const { s, theme: t } = c;
  const pf = c.view.series.has(s.pf) ? s.pf : 'EW';
  const F = fits(c, pf, s.inference);
  const sel = F[s.model];
  const available = ALL_SERIES.filter((id) => c.view.series.has(id));
  const jkpLast = Object.values(c.m.factors).map((f) => f.last).sort()[0];
  const unavailable = MODEL_IDS.filter((m) => !F[m].ok);

  c.root.innerHTML = `
  <section class="card">
    <header class="card-head"><div><h2>Factor Analysis</h2>
      <p class="muted small">${escapeHtml(configLabel(c))} · ${escapeHtml(periodLabel(c))} · dependent variable: monthly ${s.basis} excess return R<sub>p</sub> − R<sub>f</sub> (${escapeHtml(basisLabel(c))})</p></div>
      <div class="tools">
        <label>Portfolio <select id="f-pf">${available.map((id) => `<option value="${id}" ${id === pf ? 'selected' : ''}>${SHORT[id]}</option>`).join('')}</select></label>
        <label>Inference <select id="f-inf">${(['classical', 'HC3', 'HAC'] as CovType[]).map((k) => `<option value="${k}" ${k === s.inference ? 'selected' : ''}>${k === 'classical' ? 'OLS' : k === 'HAC' ? 'Newey-West' : 'HC3'}</option>`).join('')}</select></label>
        <label>Model (charts) <select id="f-model">${MODEL_IDS.map((m) => `<option value="${m}" ${m === s.model ? 'selected' : ''}>${MODELS[m].label}</option>`).join('')}</select></label>
      </div></header>
    <p class="note">R<sub>p</sub> − R<sub>f</sub> = α + β<sub>M</sub>MKT + β<sub>S</sub>SMB + β<sub>H</sub>HML + β<sub>R</sub>RMW + β<sub>C</sub>CMA + β<sub>W</sub>MOM + ε. MKT = SPI total return − Swiss r<sub>f</sub>.
    SMB, HML, RMW, CMA and MOM are the Swiss <strong>Jensen-Kelly-Pedersen</strong> long-short factors built on market_equity, be_me, ope_be, at_gr1 and ret_12_1 (capped value weights, converted from USD to CHF as F(1 + s)).
    They are close to, but not replications of, the Fama-French factors. JKP data end in ${jkpLast}: months after that are not in the multifactor samples.</p>
    ${unavailable.length ? `<p class="warn">Not estimated: ${unavailable.map((m) => `${MODELS[m].label} — ${escapeHtml((F[m] as Extract<FitOutcome, { ok: false }>).reason)}`).join('; ')}</p>` : ''}
  </section>

  <section class="card">
    <header class="card-head"><div><h3>${LABEL[pf]}: coefficients by model</h3>
      <p class="muted small">Coefficient, with its ${s.inference === 'classical' ? 't' : 'z'}-statistic in parentheses below. * p &lt; 0.10, ** p &lt; 0.05, *** p &lt; 0.01 (two-sided). Inference: ${INFERENCE[s.inference]}.</p></div>
      <div class="tools"><button type="button" id="dl-acad">Export CSV</button></div></header>
    <div class="table-wrap"><table class="data academic" id="tb-acad">
      <thead><tr><th></th>${MODEL_IDS.map((m) => `<th>${MODELS[m].label}</th>`).join('')}</tr></thead>
      <tbody>
        ${ROW_NAMES.map((n) => `<tr><th scope="row">${ROW_LABEL[n]}</th>${MODEL_IDS.map((m) => cellCoef(F[m], n)).join('')}</tr>`).join('')}
        <tr class="sep"><th scope="row">Alpha, annualised (×12)</th>${MODEL_IDS.map((m) => (F[m].ok ? `<td data-v="${12 * F[m].result.beta[0]}">${pct(12 * F[m].result.beta[0])}</td>` : '<td>—</td>')).join('')}</tr>
        <tr><th scope="row">R²</th>${MODEL_IDS.map((m) => (F[m].ok ? `<td>${num(F[m].result.r2, 3)}</td>` : '<td>—</td>')).join('')}</tr>
        <tr><th scope="row">Adjusted R²</th>${MODEL_IDS.map((m) => (F[m].ok ? `<td>${num(F[m].result.r2adj, 3)}</td>` : '<td>—</td>')).join('')}</tr>
        <tr><th scope="row">Observations</th>${MODEL_IDS.map((m) => `<td>${F[m].ok ? F[m].result.n : (F[m] as { n: number }).n}</td>`).join('')}</tr>
        <tr><th scope="row">Sample</th>${MODEL_IDS.map((m) => (F[m].ok ? `<td class="small">${F[m].sample.months[0]} – ${F[m].sample.months.at(-1)}</td>` : '<td>—</td>')).join('')}</tr>
        <tr><th scope="row">Frequency</th>${MODEL_IDS.map(() => '<td>Monthly</td>').join('')}</tr>
        <tr><th scope="row">Inference</th>${MODEL_IDS.map((m) => `<td class="small">${s.inference === 'HAC' && F[m].ok ? `NW, L = ${F[m].result.hacLags}` : s.inference === 'HC3' ? 'HC3' : 'OLS'}</td>`).join('')}</tr>
      </tbody></table></div>
    <details><summary>Standard errors, p-values and 95 % confidence intervals</summary>
      <div class="table-wrap"><table class="data" id="tb-detail"><thead><tr><th>Model</th><th>Variable</th><th>Coefficient</th><th>Std. error</th><th>${s.inference === 'classical' ? 't' : 'z'}</th><th>p-value</th><th>95 % CI low</th><th>95 % CI high</th></tr></thead><tbody>
      ${MODEL_IDS.map((m) => {
        const f = F[m];
        if (!f.ok) return `<tr><td>${MODELS[m].label}</td><td colspan="7" class="muted">${escapeHtml(f.reason)}</td></tr>`;
        const r = f.result;
        return r.names.map((n, j) => `<tr><td>${MODELS[m].label}</td><td>${n}</td><td data-v="${r.beta[j]}">${num(r.beta[j], 5)}</td><td data-v="${r.se[j]}">${num(r.se[j], 5)}</td><td>${num(r.stat[j], 3)}</td><td data-v="${r.pvalue[j]}">${pval(r.pvalue[j])}</td><td data-v="${r.ciLow[j]}">${num(r.ciLow[j], 5)}</td><td data-v="${r.ciHigh[j]}">${num(r.ciHigh[j], 5)}</td></tr>`).join('') +
          `<tr class="muted"><td>${MODELS[m].label}</td><td colspan="7">${r.joint ? `${r.joint.label} = ${num(r.joint.stat, 2)}, p = ${pval(r.joint.pvalue)} (all slopes = 0)` : ''}; residual s.d. ${pct(r.sigma, 3)} per month</td></tr>`;
      }).join('')}
      </tbody></table></div></details>
    <p class="note">Statistical significance is not economic importance: an alpha of 0.05 % per month can be "significant" with a long sample and economically negligible, and a large alpha can be insignificant because returns are noisy. Read the size (annualised) together with the confidence interval.</p>
  </section>

  <section class="card">
    <header class="card-head"><div><h3>All portfolios — ${MODELS[s.model].label}</h3></div><div class="tools"><button type="button" id="dl-cmp">Export CSV</button></div></header>
    <div class="table-wrap"><table class="data academic" id="tb-cmp"><thead><tr><th>Portfolio</th>${['alpha', ...MODELS[s.model].factors].map((n) => `<th>${ROW_LABEL[n]}</th>`).join('')}<th>R² adj.</th><th>n</th></tr></thead><tbody>
    ${available.map((id) => {
      const f = id === pf ? sel : fitModel(c.view.months, c.view.series.get(id)!.r, factorData(c), s.model, s.inference);
      if (!f.ok) return `<tr><th scope="row">${SHORT[id]}</th><td colspan="${MODELS[s.model].factors.length + 3}" class="muted">${escapeHtml(f.reason)}</td></tr>`;
      return `<tr><th scope="row"><span class="dot" style="background:${t.color[id]}"></span>${SHORT[id]}</th>${f.result.names.map((n) => cellCoef(f, n)).join('')}<td>${num(f.result.r2adj, 3)}</td><td>${f.result.n}</td></tr>`;
    }).join('')}
    </tbody></table></div>
  </section>

  <div class="grid2">
    <section class="card"><h3>Coefficient plot — ${LABEL[pf]}, ${MODELS[s.model].label}</h3><div id="ch-coef" class="chart"></div>${exportsHtml('ch-coef', 'coefficients')}
      <p class="note">Points: estimates; bars: 95 % confidence intervals (${s.inference === 'classical' ? 'OLS' : s.inference}). Alpha is shown annualised (×12) on its own axis scale in the table above.</p></section>
    <section class="card"><h3>Factor exposures — FF5+MOM, all portfolios</h3><div id="ch-heat" class="chart"></div>${exportsHtml('ch-heat', 'exposures_heatmap')}
      <p class="note">Slope coefficients; diverging scale centred on 0 (MKT shown as β − 1 would hide the level, so the raw β is displayed).</p></section>
  </div>

  <div class="grid2">
    <section class="card"><h3>Alpha across models — ${LABEL[pf]}</h3><div id="ch-alpha" class="chart"></div>${exportsHtml('ch-alpha', 'alpha_by_model')}</section>
    <section class="card"><h3>Mean excess return attribution — ${MODELS[s.model].label}</h3><div id="ch-attr" class="chart"></div>${exportsHtml('ch-attr', 'attribution')}
      <p class="note">In-sample OLS identity: mean(R<sub>p</sub> − R<sub>f</sub>) = α̂ + Σ β̂<sub>k</sub> · mean(F<sub>k</sub>), annualised ×12. It assumes constant exposures over the sample.</p></section>
  </div>

  <section class="card">
    <header class="card-head"><div><h3>Rolling ${s.roll}-month estimates — ${LABEL[pf]}, ${MODELS[s.model].label}</h3></div>
      <div class="tools"><label>Window <select id="f-roll">${[36, 60, 120].map((w) => `<option value="${w}" ${w === s.roll ? 'selected' : ''}>${w} months</option>`).join('')}</select></label></div></header>
    <div id="ch-roll" class="chart"></div>${exportsHtml('ch-roll', 'rolling_betas')}
    <div id="ch-ralpha" class="chart short"></div>${exportsHtml('ch-ralpha', 'rolling_alpha')}
    <p class="note" id="roll-note"></p>
  </section>

  <section class="card"><h3>Residual diagnostics — ${LABEL[pf]}, ${MODELS[s.model].label}</h3>
    <div class="grid2"><div id="diag-tests"></div><div id="ch-qq" class="chart"></div></div>
  </section>`;

  const q = <T extends HTMLElement>(sel: string) => c.root.querySelector<T>(sel)!;
  q<HTMLSelectElement>('#f-pf').onchange = (e) => c.set({ pf: (e.target as HTMLSelectElement).value as SeriesId });
  q<HTMLSelectElement>('#f-inf').onchange = (e) => c.set({ inference: (e.target as HTMLSelectElement).value as CovType });
  q<HTMLSelectElement>('#f-model').onchange = (e) => c.set({ model: (e.target as HTMLSelectElement).value as ModelId });
  q<HTMLSelectElement>('#f-roll').onchange = (e) => c.set({ roll: Number((e.target as HTMLSelectElement).value) });
  q<HTMLButtonElement>('#dl-acad').onclick = () => download(`factor_table_${pf}.csv`, tableCsv(q('#tb-detail')));
  q<HTMLButtonElement>('#dl-cmp').onclick = () => download(`factor_comparison_${s.model}.csv`, tableCsv(q('#tb-cmp')));

  // coefficient plot
  if (sel.ok) {
    const r = sel.result;
    const idx = r.names.map((_, j) => j).slice(1);
    draw(document.getElementById('ch-coef'), [{
      x: idx.map((j) => r.beta[j]), y: idx.map((j) => r.names[j]), type: 'scatter', mode: 'markers', marker: { color: t.color[pf], size: 10 },
      error_x: { type: 'data', symmetric: false, array: idx.map((j) => r.ciHigh[j] - r.beta[j]), arrayminus: idx.map((j) => r.beta[j] - r.ciLow[j]), color: t.muted, thickness: 1.5, width: 4 },
      hovertemplate: '%{y}: %{x:.3f}<extra></extra>',
    }], baseLayout(t, { showlegend: false, xaxis: { title: { text: 'Coefficient' }, zeroline: true }, yaxis: { autorange: 'reversed' } }));
  }

  // heatmap of exposures (FF5+MOM)
  const heat = available.map((id) => fitModel(c.view.months, c.view.series.get(id)!.r, factorData(c), 'FF5MOM', s.inference));
  const z = heat.map((f) => (f.ok ? f.result.beta.slice(1) : FACTORS.map(() => null)));
  const zmax = Math.max(0.5, ...z.flat().filter((v): v is number => v !== null).map((v) => Math.abs(v)));
  draw(document.getElementById('ch-heat'), [{
    z, x: [...FACTORS], y: available.map((id) => SHORT[id]), type: 'heatmap', zmin: -zmax, zmax, colorscale: [[0, '#2a78d6'], [0.5, '#e9e8e4'], [1, '#e34948']],
    text: z.map((row) => row.map((v) => (v === null ? 'n/a' : v.toFixed(2)))), texttemplate: '%{text}', hovertemplate: '%{y} · %{x}: %{z:.3f}<extra></extra>', xgap: 2, ygap: 2,
    colorbar: { thickness: 10, tickfont: { color: t.muted } },
  }], baseLayout(t, { yaxis: { autorange: 'reversed' }, margin: { l: 90, r: 20, t: 10, b: 40 } }));

  // alpha across models
  const okModels = MODEL_IDS.filter((m) => F[m].ok);
  draw(document.getElementById('ch-alpha'), [{
    x: okModels.map((m) => MODELS[m].label), y: okModels.map((m) => 12 * (F[m] as Extract<FitOutcome, { ok: true }>).result.beta[0]), type: 'bar', marker: { color: t.color[pf] },
    error_y: { type: 'data', symmetric: false, array: okModels.map((m) => { const r = (F[m] as Extract<FitOutcome, { ok: true }>).result; return 12 * (r.ciHigh[0] - r.beta[0]); }), arrayminus: okModels.map((m) => { const r = (F[m] as Extract<FitOutcome, { ok: true }>).result; return 12 * (r.beta[0] - r.ciLow[0]); }), color: t.muted, thickness: 1.5 },
    hovertemplate: '%{x}: α = %{y:.2%} p.a.<extra></extra>',
  }], baseLayout(t, { showlegend: false, bargap: 0.5, yaxis: { title: { text: 'Alpha (annualised, 95 % CI)' }, tickformat: '.1%' } }));

  // attribution
  if (sel.ok) {
    const a = attribution(sel);
    const meanEx = sel.sample.y.reduce((x, y) => x + y, 0) / sel.sample.y.length;
    draw(document.getElementById('ch-attr'), [{
      y: [...a.map((v) => (v.name === 'alpha' ? 'α' : v.name)), 'Mean excess return'], x: [...a.map((v) => 12 * v.value), 12 * meanEx], type: 'bar', orientation: 'h',
      marker: { color: [...a.map(() => t.color[pf]), t.color.CW] }, hovertemplate: '%{y}: %{x:.2%} p.a.<extra></extra>',
    }], baseLayout(t, { showlegend: false, xaxis: { tickformat: '.1%', title: { text: 'Contribution (annualised)' } }, yaxis: { autorange: 'reversed' }, margin: { l: 130, r: 20, t: 10, b: 45 } }));
  }

  // rolling estimates
  let rollCsv = () => '';
  let ralphaCsv = () => '';
  if (sel.ok) {
    const smp = sel.sample;
    try {
      const rr = rollingOLS(smp.months, smp.y, smp.x, smp.names, s.roll, { cov: s.inference });
      const dates = rr.dates.map(monthEnd);
      const betaTraces = rr.names.slice(1).map((n, k) => ({ x: dates, y: rr.beta[k + 1], name: n, type: 'scatter', mode: 'lines', line: { width: 1.8, color: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'][k] }, hovertemplate: `${n}: %{y:.2f}<extra></extra>` }));
      draw(document.getElementById('ch-roll'), betaTraces, baseLayout(t, { hovermode: 'x unified', xaxis: { type: 'date' }, yaxis: { title: { text: 'Rolling beta' } } }));
      draw(document.getElementById('ch-ralpha'), [
        { x: [...dates, ...[...dates].reverse()], y: [...rr.high[0].map((v) => 12 * v), ...[...rr.low[0]].reverse().map((v) => 12 * v)], fill: 'toself', fillcolor: 'rgba(127,127,127,0.18)', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, type: 'scatter' },
        { x: dates, y: rr.beta[0].map((v) => 12 * v), name: 'Alpha (annualised)', type: 'scatter', mode: 'lines', line: { color: t.color[pf], width: 2 }, hovertemplate: 'α: %{y:.2%}<extra></extra>' },
      ], baseLayout(t, { showlegend: false, hovermode: 'x unified', xaxis: { type: 'date' }, yaxis: { title: { text: 'Rolling alpha (×12, 95 % CI)' }, tickformat: '.0%' } }));
      q('#roll-note').textContent = `Each point uses the ${s.roll} months ending at that date (${rr.dates.length} windows), same inference method as the table.`;
      rollCsv = () => toCsv([['window_end', ...rr.names], ...rr.dates.map((d, i) => [d, ...rr.beta.map((b) => b[i])])]);
      ralphaCsv = () => toCsv([['window_end', 'alpha_monthly', 'ci_low', 'ci_high'], ...rr.dates.map((d, i) => [d, rr.beta[0][i], rr.low[0][i], rr.high[0][i]])]);
    } catch (e) {
      q('#roll-note').textContent = `Rolling estimates unavailable: ${(e as Error).message}`;
    }
    // diagnostics
    const res = sel.result;
    const lb = ljungBox(res.resid, defaultLjungBoxLags(res.n));
    const tests = [jarqueBera(res.resid), breuschPagan(res.resid, smp.x), lb];
    q('#diag-tests').innerHTML = `<table class="data"><thead><tr><th>Test</th><th>H0</th><th>Statistic</th><th>df</th><th>p-value</th></tr></thead><tbody>
      ${tests.map((x) => `<tr><td>${x.name}</td><td class="small">${x.h0}</td><td>${num(x.stat, 2)}</td><td>${x.df}</td><td>${pval(x.pvalue)}</td></tr>`).join('')}</tbody></table>
      <p class="note">With autocorrelated or heteroskedastic residuals (small p-values for Ljung-Box or Breusch-Pagan), prefer Newey-West or HC3 standard errors. Non-normal residuals matter little for inference with ${res.n} observations.</p>`;
    const qq = qqPoints(res.resid, res.sigma);
    const lim = Math.max(...qq.theoretical.map(Math.abs), ...qq.sample.map(Math.abs));
    draw(document.getElementById('ch-qq'), [
      { x: qq.theoretical, y: qq.sample, type: 'scatter', mode: 'markers', marker: { color: t.color[pf], size: 6, opacity: 0.7 }, hovertemplate: 'theoretical %{x:.2f}, sample %{y:.2f}<extra></extra>' },
      { x: [-lim, lim], y: [-lim, lim], type: 'scatter', mode: 'lines', line: { color: t.muted, dash: 'dot', width: 1 }, hoverinfo: 'skip' },
    ], baseLayout(t, { showlegend: false, xaxis: { title: { text: 'Normal quantiles' } }, yaxis: { title: { text: 'Standardised residuals' } } }));
  }

  wireExports(c.root, {
    'ch-coef': () => (sel.ok ? toCsv([['variable', 'coef', 'ci_low', 'ci_high'], ...sel.result.names.map((n, j) => [n, sel.result.beta[j], sel.result.ciLow[j], sel.result.ciHigh[j]])]) : ''),
    'ch-heat': () => toCsv([['portfolio', ...FACTORS], ...available.map((id, i) => [id, ...z[i]])]),
    'ch-alpha': () => toCsv([['model', 'alpha_monthly', 'ci_low', 'ci_high', 'p_value'], ...okModels.map((m) => { const r = (F[m] as Extract<FitOutcome, { ok: true }>).result; return [m, r.beta[0], r.ciLow[0], r.ciHigh[0], r.pvalue[0]]; })]),
    'ch-attr': () => (sel.ok ? toCsv([['component', 'monthly_contribution'], ...attribution(sel).map((a) => [a.name, a.value])]) : ''),
    'ch-roll': () => rollCsv(),
    'ch-ralpha': () => ralphaCsv(),
  });
}
