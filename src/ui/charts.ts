/** Plotly helpers: theme from CSS variables, consistent series colours, exports. */

import Plotly from 'plotly.js-dist-min';
import type { SeriesId } from '../data/types.ts';
import { download } from './export.ts';

export { LABEL, SHORT } from './labels.ts';

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
    font: { family: "'Source Serif 4', Georgia, 'Times New Roman', serif", color: t.fg, size: 12 },
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

const LABEL_POSITIONS = ['top center', 'bottom center', 'middle right', 'middle left', 'top right', 'top left', 'bottom right', 'bottom left'] as const;

/**
 * Text positions for labelled points (one Plotly textposition per point) that keep labels
 * off each other and off the other labelled markers. Greedy search in pixel units, estimated
 * from the chart size and the data range (`range` holds the other plotted points).
 */
export function labelPositions(
  el: HTMLElement | null,
  pts: { x: number; y: number; text: string }[],
  range: { x: number[]; y: number[] } = { x: [], y: [] },
  opts: { xZero?: boolean } = {},
): string[] {
  const xs = [...range.x, ...pts.map((p) => p.x)].filter(Number.isFinite);
  const ys = [...range.y, ...pts.map((p) => p.y)].filter(Number.isFinite);
  if (!pts.length || !xs.length || !ys.length) return pts.map(() => 'top center');
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  if (opts.xZero) x0 = Math.min(0, x0);
  const padX = (x1 - x0 || 1) * 0.05;
  const padY = (y1 - y0 || 1) * 0.05;
  x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
  const W = Math.max(200, (el?.clientWidth || 500) - 90);
  const H = Math.max(150, (el?.clientHeight || 380) - 75);
  const px = (x: number) => ((x - x0) / (x1 - x0)) * W;
  const py = (y: number) => ((y1 - y) / (y1 - y0)) * H;
  type Box = [number, number, number, number];
  const overlap = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const R = 7, GAP = 3, CHAR = 6.5, LINE = 13;
  const box = (cx: number, cy: number, w: number, pos: string): Box => {
    const [v, h] = pos.split(' ');
    const l = h === 'center' ? cx - w / 2 : h === 'right' ? cx + R + GAP : cx - R - GAP - w;
    const top = v === 'middle' ? cy - LINE / 2 : v === 'top' ? cy - R - GAP - LINE : cy + R + GAP;
    return [l, top, l + w, top + LINE];
  };
  const markers: Box[] = pts.map((p) => [px(p.x) - R, py(p.y) - R, px(p.x) + R, py(p.y) + R]);
  const placed: Box[] = [];
  return pts.map((p, i) => {
    const cx = px(p.x);
    const cy = py(p.y);
    const w = p.text.length * CHAR;
    let best: string = LABEL_POSITIONS[0];
    let bestScore = Infinity;
    for (const pos of LABEL_POSITIONS) {
      const b = box(cx, cy, w, pos);
      let score = 0;
      for (const q of placed) if (overlap(b, q)) score += 10;
      markers.forEach((m, j) => { if (j !== i && overlap(b, m)) score += 5; });
      if (b[0] < 0 || b[2] > W || b[1] < 0 || b[3] > H) score += 3;
      if (score < bestScore) { bestScore = score; best = pos; }
      if (score === 0) break;
    }
    placed.push(box(cx, cy, w, best));
    return best;
  });
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
