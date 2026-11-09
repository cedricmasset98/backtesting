/** Risk & Return: full statistics table and distribution charts. */

import type { SeriesId } from '../data/types.ts';
import { cumulativeCosts, mean, sd, type PerfStats } from '../engine/metrics.ts';
import { monthEnd, STRATS } from '../model.ts';
import { baseLayout, draw, exportsHtml, LABEL, SHORT, wireExports } from '../ui/charts.ts';
import { biasShade } from './performance.ts';
import { basisLabel, configLabel, periodLabel, stats, type Ctx } from '../ui/context.ts';
import { download, tableCsv, toCsv } from '../ui/export.ts';
import { escapeHtml, num, pct } from '../ui/format.ts';

type Row = { label: string; unit: string; get: (st: PerfStats, id: SeriesId) => number; fmt: (x: number) => string; help?: string };

function characteristics(c: Ctx, id: SeriesId) {
  if (id === 'CW') return null;
  if (id === 'MONKEYS') {
    // average over the 100 monkeys of each monkey's own figures (each holds K stocks)
    const mk = c.view.monkeys;
    return {
      to: 12 * mean(mk.turnover.map((t) => mean(t))),
      costs: mean(mk.gross.map((g, j) => cumulativeCosts(g, mk.turnover[j], c.s.bps))),
      effN: c.s.k,
      maxW: 1 / c.s.k,
      nPos: c.s.k,
    };
  }
  const f = c.strat.freqs[c.s.freq][id as (typeof STRATS)[number]];
  const pick = (a: (number | null)[]) => c.view.idx.map((i) => a[i]).filter((v): v is number => v !== null);
  const sv = c.view.series.get(id)!;
  const to = sv.turnover.map((v) => v ?? 0);
  return {
    to: (12 * to.reduce((a, b) => a + b, 0)) / to.length,
    costs: cumulativeCosts(sv.gross, sv.turnover, c.s.bps),
    effN: mean(pick(f.eff_n)),
    maxW: mean(pick(f.max_w)),
    nPos: mean(pick(f.n_pos)),
  };
}

export function renderRisk(c: Ctx): void {
  const { view, theme: t } = c;
  const ids = c.visible;
  const groups: { title: string; rows: Row[] }[] = [
    {
      title: 'Returns',
      rows: [
        { label: 'CAGR', unit: '% p.a.', get: (s) => s.cagr, fmt: (x) => pct(x) },
        { label: 'Mean simple return', unit: '% per month', get: (s) => s.meanSimple, fmt: (x) => pct(x, 3) },
        { label: 'Mean log return', unit: '% per month', get: (s) => s.meanLog, fmt: (x) => pct(x, 3) },
        { label: 'Arithmetic return, annualised (×12)', unit: '% p.a.', get: (s) => s.arithAnnual, fmt: (x) => pct(x) },
        { label: 'Cumulative return', unit: '%', get: (s) => s.cumulative, fmt: (x) => pct(x, 1) },
        { label: 'Standard error of the mean', unit: '% per month', get: (s) => s.seMean, fmt: (x) => pct(x, 3), help: 's / √n: uncertainty of the mean monthly return, not a measure of risk' },
      ],
    },
    {
      title: 'Risk',
      rows: [
        { label: 'Volatility (×√12)', unit: '% p.a.', get: (s) => s.vol, fmt: (x) => pct(x) },
        { label: 'Downside deviation (MAR = r_f)', unit: '% p.a.', get: (s) => s.downsideDev, fmt: (x) => pct(x) },
        { label: 'Maximum drawdown', unit: '%', get: (s) => s.maxDD, fmt: (x) => pct(x, 1) },
        { label: 'VaR 95 % (historical)', unit: '% per month', get: (s) => s.var95, fmt: (x) => pct(x) },
        { label: 'VaR 99 % (historical)', unit: '% per month', get: (s) => s.var99, fmt: (x) => pct(x) },
        { label: 'CVaR / ES 95 %', unit: '% per month', get: (s) => s.cvar95, fmt: (x) => pct(x) },
        { label: 'CVaR / ES 99 %', unit: '% per month', get: (s) => s.cvar99, fmt: (x) => pct(x) },
        { label: 'Skewness', unit: '', get: (s) => s.skew, fmt: (x) => num(x, 2) },
        { label: 'Excess kurtosis', unit: '', get: (s) => s.exKurt, fmt: (x) => num(x, 2) },
        { label: 'Positive months', unit: '%', get: (s) => s.posFreq, fmt: (x) => pct(x, 1) },
      ],
    },
    {
      title: 'Ratios (relative to r_f and the SPI)',
      rows: [
        { label: 'Sharpe ratio', unit: 'annualised', get: (s) => s.sharpe, fmt: (x) => num(x, 2) },
        { label: 'Sortino ratio', unit: 'annualised', get: (s) => s.sortino, fmt: (x) => num(x, 2) },
        { label: 'Calmar ratio', unit: 'CAGR / |MDD|', get: (s) => s.calmar, fmt: (x) => num(x, 2) },
        { label: 'Information ratio', unit: 'annualised', get: (s) => s.infoRatio, fmt: (x) => num(x, 2) },
        { label: 'Tracking error', unit: '% p.a.', get: (s) => s.trackingError, fmt: (x) => pct(x) },
        { label: 'Market beta (on SPI excess return)', unit: '', get: (s) => s.beta, fmt: (x) => num(x, 2) },
      ],
    },
    {
      title: 'Implementation',
      rows: [
        { label: 'Observations', unit: 'months', get: (s) => s.n, fmt: (x) => String(x) },
        { label: 'Turnover, annualised', unit: '× wealth p.a.', get: (_, id) => characteristics(c, id)?.to ?? NaN, fmt: (x) => num(x, 2), help: 'Σ|Δw| per year (buys + sells), drift between rebalancing dates included' },
        { label: 'Costs paid over the period', unit: 'CHF per 100', get: (_, id) => characteristics(c, id)?.costs ?? NaN, fmt: (x) => num(x, 2) },
        { label: 'Average number of positions', unit: '', get: (_, id) => characteristics(c, id)?.nPos ?? NaN, fmt: (x) => num(x, 1) },
        { label: 'Average effective number of positions (1/Σw²)', unit: '', get: (_, id) => characteristics(c, id)?.effN ?? NaN, fmt: (x) => num(x, 1) },
        { label: 'Average largest weight', unit: '%', get: (_, id) => characteristics(c, id)?.maxW ?? NaN, fmt: (x) => pct(x, 1) },
      ],
    },
  ];

  c.root.innerHTML = `
  <section class="card">
    <header class="card-head"><div><h2>Risk &amp; Return statistics</h2>
    <p class="muted small">${escapeHtml(configLabel(c))} · ${escapeHtml(periodLabel(c))} · ${escapeHtml(basisLabel(c))}. The SPI is an index: no costs.</p></div>
    <div class="tools"><button type="button" id="dl-stats">Export CSV</button></div></header>
    <div class="table-wrap"><table class="data stats" id="tb-stats">
      <thead><tr><th>Statistic</th><th>Unit</th>${ids.map((id) => `<th title="${LABEL[id]}"><span class="dot" style="background:${t.color[id]}"></span>${SHORT[id]}</th>`).join('')}</tr></thead>
      <tbody>${groups
        .map(
          (g) =>
            `<tr class="group"><th colspan="${ids.length + 2}">${g.title}</th></tr>` +
            g.rows
              .map((r) => `<tr><th scope="row"${r.help ? ` title="${escapeHtml(r.help)}"` : ''}>${escapeHtml(r.label)}${r.help ? ' <span class="muted">ⓘ</span>' : ''}</th><td class="muted">${r.unit}</td>${ids
                .map((id) => {
                  const v = r.get(stats(c, id), id);
                  return `<td data-v="${Number.isFinite(v) ? v : ''}">${Number.isFinite(v) ? r.fmt(v) : '—'}</td>`;
                })
                .join('')}</tr>`)
              .join(''),
        )
        .join('')}</tbody></table></div>
    <p class="note">Volatility (dispersion of monthly returns, × √12) measures risk; the standard error of the mean (s/√n) measures how precisely the average return is estimated; the mean return is the average itself.
    Sharpe = mean(R − R<sub>f</sub>)/sd(R − R<sub>f</sub>) × √12; Sortino = 12·mean(R − R<sub>f</sub>)/downside deviation; information ratio and tracking error use R − R<sub>SPI</sub>; beta = cov(R − R<sub>f</sub>, R<sub>SPI</sub> − R<sub>f</sub>)/var(R<sub>SPI</sub> − R<sub>f</sub>).
    VaR/CVaR are monthly historical losses (positive numbers). Monkeys: statistics of the average portfolio (see the Monkeys tab for the distribution of the 100 individual monkeys).</p>
  </section>
  <div class="grid2">
    <section class="card"><h3>Realised risk and return</h3><div id="ch-rr" class="chart"></div>${exportsHtml('ch-rr', 'risk_return')}
      <p class="note">Annualised volatility against CAGR over the selected period; grey dots: the 100 monkeys.</p></section>
    <section class="card"><h3>Distribution of monthly returns</h3><div id="ch-box" class="chart"></div>${exportsHtml('ch-box', 'monthly_return_distribution')}
      <p class="note">Box: quartiles; whiskers: 1.5 × IQR; points: outlying months.</p></section>
  </div>
  <section class="card"><h3>Rolling 36-month volatility</h3><div id="ch-rvol" class="chart"></div>${exportsHtml('ch-rvol', 'rolling_volatility')}</section>`;

  c.root.querySelector<HTMLButtonElement>('#dl-stats')!.onclick = () => download('risk_return_statistics.csv', tableCsv(c.root.querySelector('#tb-stats')!));

  // risk-return scatter
  const mk = view.monkeys.r.map((r) => {
    const st = { vol: sd(r) * Math.sqrt(12), cagr: Math.pow(r.reduce((v, x) => v * (1 + x), 1), 12 / r.length) - 1 };
    return st;
  });
  const traces: unknown[] = [];
  if (mk.length) traces.push({ x: mk.map((m) => m.vol), y: mk.map((m) => m.cagr), name: '100 monkeys', type: 'scatter', mode: 'markers', marker: { color: t.muted, size: 6, opacity: 0.35 }, hovertemplate: 'Monkey: vol %{x:.1%}, CAGR %{y:.1%}<extra></extra>' });
  for (const id of ids) {
    const st = stats(c, id);
    traces.push({ x: [st.vol], y: [st.cagr], name: SHORT[id], type: 'scatter', mode: 'markers+text', text: [SHORT[id]], textposition: 'top center', textfont: { color: t.fg, size: 11 }, marker: { color: t.color[id], size: 11, line: { color: t.bg, width: 2 }, symbol: id === 'CW' ? 'diamond' : 'circle' }, hovertemplate: `${LABEL[id]}: vol %{x:.2%}, CAGR %{y:.2%}<extra></extra>` });
  }
  draw(document.getElementById('ch-rr'), traces, baseLayout(t, { showlegend: false, xaxis: { title: { text: 'Volatility (annualised)' }, tickformat: '.0%' }, yaxis: { title: { text: 'CAGR' }, tickformat: '.0%' } }));

  draw(
    document.getElementById('ch-box'),
    ids.map((id) => ({ y: view.series.get(id)!.r, name: SHORT[id], type: 'box', boxpoints: 'outliers', marker: { color: t.color[id], size: 4 }, line: { color: t.color[id], width: 1.5 }, hovertemplate: `${SHORT[id]}: %{y:.2%}<extra></extra>` })),
    baseLayout(t, { showlegend: false, yaxis: { title: { text: 'Monthly return' }, tickformat: '.0%' } }),
  );

  const w = 36;
  const dates = view.months.map(monthEnd);
  const roll = (r: number[]) => r.map((_, i) => (i + 1 < w ? null : sd(r.slice(i + 1 - w, i + 1)) * Math.sqrt(12)));
  draw(
    document.getElementById('ch-rvol'),
    ids.map((id) => ({ x: dates, y: roll(view.series.get(id)!.r), name: SHORT[id], type: 'scatter', mode: 'lines', line: { color: t.color[id], width: id === 'CW' ? 2.5 : 1.5, dash: id === 'MONKEYS' ? 'dash' : id === 'TP_SAMPLE' ? 'dot' : 'solid' }, hovertemplate: `${SHORT[id]}: %{y:.1%}<extra></extra>` })),
    baseLayout(t, { hovermode: 'x unified', yaxis: { title: { text: 'Volatility (annualised)' }, tickformat: '.0%' }, xaxis: { type: 'date' }, shapes: biasShade(c, dates[0]) }),
  );

  wireExports(c.root, {
    'ch-rr': () => toCsv([['series', 'volatility_annualised', 'cagr'], ...ids.map((id) => [id, stats(c, id).vol, stats(c, id).cagr]), ...mk.map((m, j) => [`monkey_${j}`, m.vol, m.cagr])]),
    'ch-box': () => toCsv([['month', ...ids], ...view.months.map((m, i) => [m, ...ids.map((id) => view.series.get(id)!.r[i])])]),
    'ch-rvol': () => toCsv([['month', ...ids], ...view.months.map((m, i) => [m, ...ids.map((id) => roll(view.series.get(id)!.r)[i])])]),
  });
}
