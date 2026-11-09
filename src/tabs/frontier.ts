/** Efficient Frontier: ex ante (estimated at a decision date) vs realised out of sample. */

import type { FrontierFile, StratId } from '../data/types.ts';
import { sd } from '../engine/metrics.ts';
import { baseLayout, draw, exportsHtml, LABEL, SHORT, wireExports } from '../ui/charts.ts';
import { configLabel, periodLabel, stats, type Ctx } from '../ui/context.ts';
import { toCsv } from '../ui/export.ts';
import { escapeHtml } from '../ui/format.ts';

const EX_ANTE: StratId[] = ['EW', 'GMV', 'ERC', 'TP', 'MDP', 'IVP'];

export function renderFrontier(c: Ctx, fr: FrontierFile): void {
  const { s, theme: t } = c;
  const snaps = fr.snapshots;
  const snap = snaps.find((x) => x.month === s.snap) ?? snaps[snaps.length - 1];
  const A = (sdv: number) => sdv * Math.sqrt(12);
  const M = (mu: number) => mu * 12;
  const capTxt = fr.cap_value >= 1 ? 'long-only, fully invested' : `long-only, fully invested, weights ≤ ${(fr.cap_value * 100).toFixed(0)} %`;

  c.root.innerHTML = `
  <section class="card">
    <header class="card-head"><div><h2>Efficient Frontier</h2>
      <p class="muted small">${escapeHtml(configLabel(c))}</p></div>
      <div class="tools"><label>Estimation date <select id="fr-snap">${snaps.map((x) => `<option value="${x.month}" ${x.month === snap.month ? 'selected' : ''}>${x.month}</option>`).join('')}</select></label></div></header>
    <p class="note"><strong>Two different objects.</strong> Left: what the investor could estimate at the end of ${snap.month}, from the ${s.window} months of returns ending then
    (covariance ${s.cov === 'lw' ? 'Ledoit-Wolf' : 'sample + ridge'}, Bayes-Stein expected returns) — the constrained frontier (${capTxt}), the portfolios chosen at that date, and the capital allocation line through the tangency portfolio.
    Right: what the strategies actually delivered afterwards over the selected period. The ex ante frontier never uses returns after its estimation date.</p>
  </section>
  <div class="grid2">
    <section class="card"><h3>Ex ante — estimated at ${snap.month}</h3><div id="ch-exante" class="chart tall"></div>${exportsHtml('ch-exante', `frontier_ex_ante_${snap.month}`)}
      <p class="note">Annualised: μ × 12, σ × √12. Grey dots: 100 random 30-stock equally weighted portfolios drawn at the same date (seed 1), evaluated with the same estimates. Expected returns are estimates, which is why the realised positions differ.</p></section>
    <section class="card"><h3>Realised out of sample — ${escapeHtml(periodLabel(c))}</h3><div id="ch-real" class="chart tall"></div>${exportsHtml('ch-real', 'realised_risk_return')}
      <p class="note">Annualised volatility and arithmetic mean return (12 × mean, ${s.basis}) of the monthly returns actually earned. Grey dots: the 100 monkeys (K = ${s.k}, seed ${s.seed}).</p></section>
  </div>`;

  c.root.querySelector<HTMLSelectElement>('#fr-snap')!.onchange = (e) => c.set({ snap: (e.target as HTMLSelectElement).value });

  const rfA = M(snap.rf);
  const tp = snap.strategies.TP;
  const slope = (M(tp[1]) - rfA) / A(tp[0]);
  const xmax = Math.max(...snap.frontier.map((p) => A(p[0])), ...snap.monkeys.map((p) => A(p[0])), ...EX_ANTE.map((k) => A(snap.strategies[k][0]))) * 1.08;
  const traces: unknown[] = [
    { x: snap.monkeys.map((p) => A(p[0])), y: snap.monkeys.map((p) => M(p[1])), name: 'Random portfolios', type: 'scatter', mode: 'markers', marker: { color: t.muted, size: 5, opacity: 0.35 }, hovertemplate: 'random: σ %{x:.1%}, μ %{y:.1%}<extra></extra>' },
    { x: snap.frontier.map((p) => A(p[0])), y: snap.frontier.map((p) => M(p[1])), name: 'Efficient frontier (ex ante)', type: 'scatter', mode: 'lines', line: { color: t.fg, width: 2 }, hovertemplate: 'frontier: σ %{x:.2%}, μ %{y:.2%}<extra></extra>' },
  ];
  if (slope > 0) traces.push({ x: [0, xmax], y: [rfA, rfA + slope * xmax], name: 'Capital allocation line', type: 'scatter', mode: 'lines', line: { color: t.color.TP, width: 1.5, dash: 'dash' }, hovertemplate: 'CAL: σ %{x:.1%}, μ %{y:.1%}<extra></extra>' });
  for (const k of EX_ANTE) {
    const p = snap.strategies[k];
    traces.push({ x: [A(p[0])], y: [M(p[1])], name: SHORT[k], type: 'scatter', mode: 'markers+text', text: [SHORT[k]], textposition: 'top center', textfont: { color: t.fg, size: 11 }, marker: { color: t.color[k], size: 11, line: { color: t.bg, width: 2 } }, hovertemplate: `${LABEL[k]}: σ %{x:.2%}, μ %{y:.2%} (ex ante)<extra></extra>` });
  }
  draw(document.getElementById('ch-exante'), traces, baseLayout(t, { xaxis: { title: { text: 'Expected volatility (ex ante, annualised)' }, tickformat: '.0%', rangemode: 'tozero' }, yaxis: { title: { text: 'Expected return (ex ante, annualised)' }, tickformat: '.0%' }, legend: { orientation: 'h', y: -0.2 } }));

  const ids = c.visible;
  const mk = c.view.monkeys.r.map((r) => [sd(r) * Math.sqrt(12), (12 * r.reduce((a, b) => a + b, 0)) / r.length]);
  const rtr: unknown[] = [];
  if (mk.length) rtr.push({ x: mk.map((p) => p[0]), y: mk.map((p) => p[1]), name: 'Monkeys', type: 'scatter', mode: 'markers', marker: { color: t.muted, size: 5, opacity: 0.35 }, hovertemplate: 'monkey: σ %{x:.1%}, μ %{y:.1%}<extra></extra>' });
  for (const id of ids) {
    const st = stats(c, id);
    rtr.push({ x: [st.vol], y: [st.arithAnnual], name: SHORT[id], type: 'scatter', mode: 'markers+text', text: [SHORT[id]], textposition: 'top center', textfont: { color: t.fg, size: 11 }, marker: { color: t.color[id], size: 11, symbol: id === 'CW' ? 'diamond' : 'circle', line: { color: t.bg, width: 2 } }, hovertemplate: `${LABEL[id]}: σ %{x:.2%}, mean %{y:.2%} (realised)<extra></extra>` });
  }
  draw(document.getElementById('ch-real'), rtr, baseLayout(t, { showlegend: false, xaxis: { title: { text: 'Realised volatility (annualised)' }, tickformat: '.0%', rangemode: 'tozero' }, yaxis: { title: { text: 'Realised mean return (×12)' }, tickformat: '.0%' } }));

  wireExports(c.root, {
    'ch-exante': () => toCsv([['type', 'name', 'sigma_monthly', 'mu_monthly'], ...snap.frontier.map((p, i) => ['frontier', i, p[0], p[1]]), ...EX_ANTE.map((k) => ['strategy', k, snap.strategies[k][0], snap.strategies[k][1]]), ...snap.monkeys.map((p, i) => ['random', i, p[0], p[1]]), ['rf', 'rf', 0, snap.rf]]),
    'ch-real': () => toCsv([['series', 'vol_annualised', 'mean_annualised'], ...ids.map((id) => [id, stats(c, id).vol, stats(c, id).arithAnnual]), ...mk.map((p, i) => [`monkey_${i}`, p[0], p[1]])]),
  });
}
