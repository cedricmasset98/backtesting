/** Plotly helpers: theme from CSS variables, consistent series colours, exports. */

import Plotly from 'plotly.js-dist-min';
import type { SeriesId } from '../data/types.ts';
import { download } from './export.ts';

export const LABEL: Record<SeriesId, string> = {
  CW: 'Market-Cap Weighted (SPI TR)',
  EW: 'Equally-Weighted',
  GMV: 'Global Minimum Variance',
  ERC: 'Equal Risk Contribution',
  TP: 'Tangency Portfolio',
  MDP: 'Most Diversified Portfolio',
  IVP: 'Inverse Volatility',
  MONKEYS: "Malkiel's Monkeys (average)",
  TP_SAMPLE: 'Tangency (sample mean, sensitivity)',
};

export const SHORT: Record<SeriesId, string> = {
  CW: 'CW (SPI)',
  EW: 'EW',
  GMV: 'GMV',
  ERC: 'ERC',
  TP: 'TP',
  MDP: 'MDP',
  IVP: 'IVP',
  MONKEYS: 'Monkeys',
  TP_SAMPLE: 'TP (sample μ)',
};

export interface Theme {
  fg: string;
  muted: string;
  grid: string;
  zero: string;
  panel: string;
  bg: string;
  color: Record<SeriesId, string>;
}

export function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  const ids: SeriesId[] = ['CW', 'EW', 'GMV', 'ERC', 'TP', 'MDP', 'IVP', 'MONKEYS', 'TP_SAMPLE'];
  return {
    fg: v('--fg'),
    muted: v('--muted'),
    grid: v('--grid'),
    zero: v('--zero'),
    panel: v('--panel'),
    bg: v('--bg'),
    color: Object.fromEntries(ids.map((id) => [id, v(`--c-${id}`)])) as Record<SeriesId, string>,
  };
}

/** Line style per series: the benchmark is thicker, the sensitivity series dotted, monkeys dashed. */
export function lineStyle(t: Theme, id: SeriesId, width = 2): Record<string, unknown> {
  return {
    color: t.color[id],
    width: id === 'CW' ? width + 1 : width,
    dash: id === 'TP_SAMPLE' ? 'dot' : id === 'MONKEYS' ? 'dash' : 'solid',
  };
}

const CONFIG = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'],
  toImageButtonOptions: { format: 'png', scale: 2 },
};

export function baseLayout(t: Theme, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const axis = { gridcolor: t.grid, zerolinecolor: t.zero, linecolor: t.grid, tickfont: { color: t.muted }, title: { font: { color: t.fg, size: 12 } }, automargin: true };
  const base: Record<string, unknown> = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif', color: t.fg, size: 12 },
    margin: { l: 60, r: 20, t: 20, b: 45 },
    hoverlabel: { bgcolor: t.panel, bordercolor: t.grid, font: { color: t.fg } },
    legend: { orientation: 'h', y: -0.15, font: { color: t.fg } },
    xaxis: { ...axis },
    yaxis: { ...axis },
  };
  for (const [k, val] of Object.entries(extra)) {
    if ((k.startsWith('xaxis') || k.startsWith('yaxis')) && typeof val === 'object' && val !== null) base[k] = { ...axis, ...(val as object) };
    else base[k] = val;
  }
  return base;
}

export function draw(el: HTMLElement | null, data: unknown[], layout: Record<string, unknown>): void {
  if (!el) return;
  void Plotly.react(el, data, layout, CONFIG);
}

export function purge(el: HTMLElement): void {
  Plotly.purge(el);
}

export function exportImage(el: HTMLElement, format: 'png' | 'svg', name: string): void {
  void Plotly.downloadImage(el, { format, filename: name, width: el.clientWidth || 1000, height: el.clientHeight || 500, scale: format === 'png' ? 2 : 1 });
}

/** Wires the export buttons placed under a chart: <div class="exports" data-chart="id" data-name="file">. */
export function wireExports(root: HTMLElement, csv: Record<string, () => string>): void {
  root.querySelectorAll<HTMLElement>('.exports').forEach((box) => {
    const id = box.dataset.chart!;
    const name = box.dataset.name ?? id;
    box.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.onclick = () => {
        const el = document.getElementById(id);
        if (b.dataset.fmt === 'csv') {
          const f = csv[id];
          if (f) download(`${name}.csv`, f());
        } else if (el) exportImage(el, b.dataset.fmt as 'png' | 'svg', name);
      };
    });
  });
}

export function exportsHtml(chartId: string, name: string, withCsv = true): string {
  return `<div class="exports" data-chart="${chartId}" data-name="${name}">
    <button type="button" data-fmt="png">PNG</button><button type="button" data-fmt="svg">SVG</button>${withCsv ? '<button type="button" data-fmt="csv">CSV</button>' : ''}
  </div>`;
}

/** Histogram bins shared by several samples. */
export function bins(values: number[], n = 25): { start: number; end: number; size: number } {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const size = (hi - lo) / n || 1e-6;
  return { start: lo - size / 2, end: hi + size / 2, size };
}
