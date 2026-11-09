/** Cumulative Portfolio Performance, synchronised drawdowns and relative performance. */

import { drawdowns, relativeWealth, wealth } from '../engine/metrics.ts';
import { wealthDates } from '../model.ts';
import { baseLayout, draw, exportsHtml, LABEL, lineStyle, SHORT, wireExports } from '../ui/charts.ts';
import { basisLabel, configLabel, periodLabel, stats, type Ctx } from '../ui/context.ts';
import { toCsv } from '../ui/export.ts';
import { escapeHtml, num, pct } from '../ui/format.ts';

/** Shaded period affected by survivorship bias (before the first year with delistings in the data). */
export function biasShade(c: Ctx, first: string): Record<string, unknown>[] {
  const ctl = c.m.survivorship.controlled_start;
  if (!ctl || c.view.period[0] >= ctl) return [];
  return [{ type: 'rect', xref: 'x', yref: 'paper', x0: first, x1: `${ctl}-01`, y0: 0, y1: 1, fillcolor: 'rgba(237,161,0,0.10)', line: { width: 0 }, layer: 'below' }];
}

export function biasLabel(c: Ctx, first: string): Record<string, unknown>[] {
  const ctl = c.m.survivorship.controlled_start;
  if (!ctl || c.view.period[0] >= ctl) return [];
  return [{ x: first, xref: 'x', xanchor: 'left', y: 1, yref: 'paper', yanchor: 'top', text: `survivorship bias until ${ctl}`, showarrow: false, font: { size: 11, color: c.theme.muted } }];
}

export function renderPerformance(c: Ctx): void {
  const { view, s, theme: t } = c;
  const dates = wealthDates(view.months);
  c.root.innerHTML = `
  <section class="card">
    <header class="card-head">
      <div><h2>Cumulative Portfolio Performance</h2>
      <p class="muted small">${escapeHtml(configLabel(c))} · ${escapeHtml(periodLabel(c))} · ${escapeHtml(basisLabel(c))}</p></div>
      <div class="tools">
        <label class="check"><input type="checkbox" id="opt-log" ${s.log ? 'checked' : ''}/> Log scale</label>
        <label class="check"><input type="checkbox" id="opt-cmp" ${s.compareGross ? 'checked' : ''}/> Show gross and net</label>
      </div>
    </header>
    <div id="ch-perf" class="chart xtall" role="img" aria-label="Cumulative wealth, drawdowns and wealth relative to the SPI"></div>
    ${exportsHtml('ch-perf', 'cumulative_performance')}
    <p class="note">Top: value of 100 CHF invested at ${dates[0]} (V<sub>t</sub> = 100 × ∏(1 + r<sub>p,s</sub>)); every portfolio starts at 100 on the same date.
    Middle: drawdown V<sub>t</sub>/max<sub>s≤t</sub> V<sub>s</sub> − 1. Bottom: relative wealth 100 × V<sub>t</sub>/V<sub>t</sub><sup>SPI</sup>
    (above 100 = the strategy has outperformed the SPI total return since the start of the period). Drag to zoom: the three panels share the time axis.</p>
  </section>
  <section class="card">
    <h3>End of period</h3>
    <div class="table-wrap"><table class="data" id="tb-final"><thead><tr><th>Portfolio</th><th>Final value (CHF)</th><th>Cumulative return</th><th>CAGR</th><th>Max drawdown</th><th>Trough</th><th>Relative to SPI</th></tr></thead><tbody>
    ${c.visible
      .map((id) => {
        const v = wealth(view.series.get(id)!.r);
        const dd = drawdowns(v);
        let k = 0;
        dd.forEach((d, i) => {
          if (d < dd[k]) k = i;
        });
        const st = stats(c, id);
        const rel = relativeWealth(view.series.get(id)!.r, view.spi).at(-1)!;
        return `<tr><th scope="row"><span class="dot" style="background:${t.color[id]}"></span>${SHORT[id]}</th><td data-v="${v.at(-1)}">${num(v.at(-1)!, 1)}</td><td data-v="${st.cumulative}">${pct(st.cumulative, 1)}</td><td data-v="${st.cagr}">${pct(st.cagr)}</td><td data-v="${st.maxDD}">${pct(st.maxDD, 1)}</td><td>${dates[k]}</td><td data-v="${rel}">${num(rel, 1)}</td></tr>`;
      })
      .join('')}
    </tbody></table></div>
  </section>`;

  c.root.querySelector<HTMLInputElement>('#opt-log')!.onchange = (e) => c.set({ log: (e.target as HTMLInputElement).checked });
  c.root.querySelector<HTMLInputElement>('#opt-cmp')!.onchange = (e) => c.set({ compareGross: (e.target as HTMLInputElement).checked });

  const traces: unknown[] = [];
  for (const id of c.visible) {
    const sv = view.series.get(id)!;
    const v = wealth(sv.r);
    const line = lineStyle(t, id);
    traces.push({ x: dates, y: v, name: SHORT[id], legendgroup: id, type: 'scatter', mode: 'lines', line, hovertemplate: `${LABEL[id]}: %{y:.2f}<extra></extra>` });
    if (s.compareGross && id !== 'CW') {
      const other = s.basis === 'net' ? sv.gross : sv.net;
      traces.push({ x: dates, y: wealth(other), name: `${SHORT[id]} (${s.basis === 'net' ? 'gross' : 'net'})`, legendgroup: id, showlegend: false, type: 'scatter', mode: 'lines', line: { ...line, width: 1, dash: 'dot' }, opacity: 0.8, hovertemplate: `${SHORT[id]} ${s.basis === 'net' ? 'gross' : 'net'}: %{y:.2f}<extra></extra>` });
    }
    traces.push({ x: dates, y: drawdowns(v), yaxis: 'y2', legendgroup: id, showlegend: false, type: 'scatter', mode: 'lines', line: { ...line, width: 1.2 }, hovertemplate: `${SHORT[id]} drawdown: %{y:.1%}<extra></extra>` });
    if (id !== 'CW') {
      traces.push({ x: dates, y: relativeWealth(sv.r, view.spi), yaxis: 'y3', legendgroup: id, showlegend: false, type: 'scatter', mode: 'lines', line: { ...line, width: 1.2 }, hovertemplate: `${SHORT[id]} / SPI: %{y:.1f}<extra></extra>` });
    }
  }
  draw(
    document.getElementById('ch-perf'),
    traces,
    baseLayout(t, {
      hovermode: 'x unified',
      margin: { l: 70, r: 20, t: 10, b: 40 },
      legend: { orientation: 'h', y: 1.06, x: 0, font: { color: t.fg } },
      xaxis: { type: 'date', rangeslider: { visible: false }, spikemode: 'across', showspikes: true, spikecolor: t.muted, spikethickness: 1 },
      yaxis: { domain: [0.46, 1], type: s.log ? 'log' : 'linear', title: { text: 'Value of 100 CHF' } },
      yaxis2: { domain: [0.24, 0.42], anchor: 'x', tickformat: '.0%', title: { text: 'Drawdown' }, rangemode: 'tozero' },
      yaxis3: { domain: [0, 0.2], anchor: 'x', title: { text: 'Relative to SPI' } },
      shapes: [{ type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y3', y0: 100, y1: 100, line: { color: t.zero, width: 1, dash: 'dot' } }, ...biasShade(c, dates[0])],
      annotations: biasLabel(c, dates[0]),
    }),
  );

  wireExports(c.root, {
    'ch-perf': () => {
      const header = ['date', ...c.visible.flatMap((id) => [`wealth_${id}`, `drawdown_${id}`, `relative_spi_${id}`])];
      const cols = c.visible.map((id) => {
        const v = wealth(view.series.get(id)!.r);
        return [v, drawdowns(v), relativeWealth(view.series.get(id)!.r, view.spi)];
      });
      return toCsv([header, ...dates.map((d, i) => [d, ...cols.flatMap((x) => [x[0][i], x[1][i], x[2][i]])])]);
    },
  });
}
