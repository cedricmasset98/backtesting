/**
 * Minimal PDF writer (no dependency) for the results report: A4 pages, the
 * standard fonts Helvetica and Helvetica-Bold (WinAnsiEncoding, no embedding),
 * headings, paragraphs with bold spans, bullet lists, tables (with t-statistic
 * sub-rows) and vector charts (lines, dot-and-whisker, histograms). Text is
 * wrapped with the official glyph widths.
 */

import { HELVETICA, HELVETICA_BOLD } from './pdfmetrics.ts';

export interface LineSeries {
  name: string;
  color: string; // #rrggbb
  y: (number | null)[];
  dash?: boolean;
  width?: number;
}

export type ChartSpec =
  | { type: 'line'; x: string[]; series: LineSeries[]; yFormat: 'num' | 'pct'; yTitle: string; height?: number; refY?: number }
  | { type: 'dots'; categories: string[]; colors: string[]; value: number[]; low: number[]; high: number[]; xFormat: 'num' | 'pct'; xTitle: string; refX?: number }
  | { type: 'hist'; values: number[]; bins: number; color: string; markers: { name: string; color: string; x: number }[]; xFormat: 'num' | 'pct'; xTitle: string };

export type Block =
  | { kind: 'title'; text: string }
  | { kind: 'meta'; text: string }
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'p'; text: string } // **bold** spans allowed
  | { kind: 'warn'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][]; sub?: boolean[]; caption?: string; note?: string }
  | { kind: 'figure'; caption: string; chart: ChartSpec; note?: string };

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 50;
const WIDTH = PAGE_W - 2 * MARGIN;
const INK = '0.12 0.14 0.17';
const MUTED = '0.40 0.43 0.47';
const ACCENT = '0.11 0.31 0.57';
const WARN = '0.54 0.35 0.00';
const GRID = '0.88 0.89 0.91';

/** Characters outside cp1252 replaced by readable equivalents. */
const SUBST: Record<string, string> = {
  '−': '-', '≤': '<=', '≥': '>=', '→': '->', '←': '<-', 'Σ': 'Sum ', 'σ': 'sigma', 'μ': 'µ', 'λ': 'lambda', 'α': 'alpha',
  'β': 'beta', 'ν': 'nu', '√': 'sqrt', 'Δ': 'Diff. ', '²': '2', '₀': '0', '⌊': '', '⌋': '', '≈': '~', ' ': ' ', ' ': ' ', ' ': ' ',
};
const CP1252_EXTRA: Record<string, number> = {
  '€': 128, '‚': 130, 'ƒ': 131, '„': 132, '…': 133, '†': 134, '‡': 135, 'ˆ': 136, '‰': 137, 'Š': 138, '‹': 139, 'Œ': 140,
  'Ž': 142, '‘': 145, '’': 146, '“': 147, '”': 148, '•': 149, '–': 150, '—': 151, '˜': 152, '™': 153, 'š': 154, '›': 155,
  'œ': 156, 'ž': 158, 'Ÿ': 159,
};

/** Encodes a JavaScript string to cp1252 codes (one char code 0–255 per character). */
export function toCp1252(s: string): string {
  let out = '';
  for (const ch of s) {
    const sub = SUBST[ch];
    if (sub !== undefined) {
      out += toCp1252(sub);
      continue;
    }
    const c = ch.codePointAt(0)!;
    if (c < 128 || (c >= 160 && c <= 255)) out += String.fromCharCode(c);
    else if (CP1252_EXTRA[ch] !== undefined) out += String.fromCharCode(CP1252_EXTRA[ch]);
    else out += '?';
  }
  return out;
}

/** PDF literal string (cp1252 bytes), with escapes. */
export function pdfString(cp: string): string {
  let out = '(';
  for (let i = 0; i < cp.length; i++) {
    const c = cp.charCodeAt(i);
    const ch = cp[i];
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += ch;
  }
  return out + ')';
}

function width(cp: string, bold: boolean, size: number): number {
  const w = bold ? HELVETICA_BOLD : HELVETICA;
  let s = 0;
  for (let i = 0; i < cp.length; i++) s += w[cp.charCodeAt(i)] || 556;
  return (s * size) / 1000;
}

const tw = (s: string, size: number, bold = false) => width(toCp1252(s), bold, size);

function rgb(hex: string): string {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
}

function lighten(hex: string, f: number): string {
  const h = hex.replace('#', '');
  return '#' + [0, 2, 4].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) + (255 - parseInt(h.slice(i, i + 2), 16)) * f).toString(16).padStart(2, '0')).join('');
}

type Run = { text: string; bold: boolean };

/** Splits "a **b** c" into runs (\\* is a literal asterisk). */
function runs(text: string, bold = false): Run[] {
  const parts = text.replace(/\\\*/g, '\u0002').split('**');
  return parts.map((t, i) => ({ text: toCp1252(t.replace(/\u0002/g, '*')), bold: bold !== (i % 2 === 1) })).filter((r) => r.text.length > 0);
}

function wrap(rs: Run[], size: number, maxW: number): Run[][] {
  const words: Run[] = [];
  for (const r of rs) for (const p of r.text.split(/( )/)) if (p.length) words.push({ text: p, bold: r.bold });
  const lines: Run[][] = [];
  let line: Run[] = [];
  let w = 0;
  for (const word of words) {
    const ww = width(word.text, word.bold, size);
    if (word.text === ' ') {
      if (line.length) {
        line.push(word);
        w += ww;
      }
      continue;
    }
    if (w + ww > maxW && line.length) {
      while (line.length && line[line.length - 1].text === ' ') line.pop();
      lines.push(line);
      line = [];
      w = 0;
    }
    line.push(word);
    w += ww;
  }
  while (line.length && line[line.length - 1].text === ' ') line.pop();
  if (line.length) lines.push(line);
  return lines;
}

/** "Nice" axis ticks between lo and hi (about n ticks). */
export function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

const fmtAxis = (v: number, f: 'num' | 'pct', step: number) => {
  if (f === 'pct') return `${(v * 100).toFixed(step * 100 < 1 ? 1 : 0)}%`;
  return v.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0);
};

export interface PdfOptions {
  footer: string;
}

/** Builds the PDF and returns its bytes. */
export function buildPdf(blocks: Block[], opts: PdfOptions): Uint8Array {
  const pages: string[] = [];
  let ops: string[] = [];
  let y = PAGE_H - MARGIN;
  const newPage = () => {
    if (ops.length) pages.push(ops.join('\n'));
    ops = [];
    y = PAGE_H - MARGIN;
  };
  const ensure = (h: number) => {
    if (y - h < MARGIN + 20) newPage();
  };
  const text = (s: string, x: number, yy: number, size: number, color = INK, bold = false) => {
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color} rg ${x.toFixed(2)} ${yy.toFixed(2)} Td ${pdfString(toCp1252(s))} Tj ET`);
  };
  const textLine = (ln: Run[], x: number, size: number, color: string) => {
    let cx = x;
    for (const r of ln) {
      ops.push(`BT /${r.bold ? 'F2' : 'F1'} ${size} Tf ${color} rg ${cx.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(r.text)} Tj ET`);
      cx += width(r.text, r.bold, size);
    }
  };
  const para = (s: string, size: number, color: string, opt: { bold?: boolean; indent?: number; gapAfter?: number; bullet?: boolean } = {}) => {
    const indent = opt.indent ?? 0;
    const lines = wrap(runs(s, opt.bold), size, WIDTH - indent);
    const lh = size * 1.38;
    lines.forEach((ln, i) => {
      ensure(lh);
      y -= lh;
      if (opt.bullet && i === 0) textLine([{ text: toCp1252('•'), bold: false }], MARGIN + indent - 9, size, color);
      textLine(ln, MARGIN + indent, size, color);
    });
    y -= opt.gapAfter ?? size * 0.6;
  };
  const line = (x1: number, y1: number, x2: number, y2: number, color: string, w = 0.5, dash = false) => {
    ops.push(`${color} RG ${w} w ${dash ? '[3 2] 0 d ' : ''}${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S${dash ? ' [] 0 d' : ''}`);
  };
  const circle = (cx: number, cy: number, r: number, fill: string) => {
    const k = 0.5523 * r;
    const p = (a: number, b: number) => `${a.toFixed(2)} ${b.toFixed(2)}`;
    ops.push(`${fill} rg ${p(cx + r, cy)} m ${p(cx + r, cy + k)} ${p(cx + k, cy + r)} ${p(cx, cy + r)} c ${p(cx - k, cy + r)} ${p(cx - r, cy + k)} ${p(cx - r, cy)} c ${p(cx - r, cy - k)} ${p(cx - k, cy - r)} ${p(cx, cy - r)} c ${p(cx + k, cy - r)} ${p(cx + r, cy - k)} ${p(cx + r, cy)} c f`);
  };

  /** Legend below a plot; returns the height used. */
  const legend = (items: { name: string; color: string; dash?: boolean }[], top: number): number => {
    const size = 7;
    let x = MARGIN;
    let yy = top - 10;
    for (const it of items) {
      const w = 16 + tw(it.name, size) + 12;
      if (x + w > MARGIN + WIDTH) {
        x = MARGIN;
        yy -= 11;
      }
      line(x, yy + 2.5, x + 12, yy + 2.5, rgb(it.color), 1.6, it.dash);
      text(it.name, x + 16, yy, size, INK);
      x += w;
    }
    return top - yy + 6;
  };

  const figure = (b: Extract<Block, { kind: 'figure' }>) => {
    const ch = b.chart;
    const plotH = ch.type === 'line' ? (ch.height ?? 170) : ch.type === 'dots' ? 18 * ch.categories.length + 30 : 150;
    const legendH = ch.type === 'line' ? 12 * Math.ceil(ch.series.length / 5) + 10 : ch.type === 'hist' ? 12 * Math.ceil(ch.markers.length / 6) + 10 : 0;
    const capLines = wrap(runs(b.caption, true), 9, WIDTH).length;
    ensure(capLines * 12.5 + plotH + legendH + 34);
    para(b.caption, 9, INK, { bold: true, gapAfter: 4 });
    const top = y - 8;
    const bottom = top - plotH;
    const left = MARGIN + (ch.type === 'dots' ? 92 : 40);
    const right = MARGIN + WIDTH - 6;
    const size = 7;
    if (ch.type === 'line') {
      const all = ch.series.flatMap((s) => s.y.filter((v): v is number => v !== null && Number.isFinite(v)));
      let lo = Math.min(...all, ch.refY ?? Infinity);
      let hi = Math.max(...all, ch.refY ?? -Infinity);
      const pad = (hi - lo) * 0.05 || Math.abs(hi) * 0.05 || 1;
      lo -= pad;
      hi += pad;
      const ticks = niceTicks(lo, hi, 5);
      const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
      const Y = (v: number) => bottom + ((v - lo) / (hi - lo)) * (top - bottom);
      const n = ch.x.length;
      const X = (i: number) => left + (i / Math.max(n - 1, 1)) * (right - left);
      for (const t of ticks) {
        line(left, Y(t), right, Y(t), GRID, 0.4);
        const lab = fmtAxis(t, ch.yFormat, step);
        text(lab, left - 4 - tw(lab, size), Y(t) - 2.5, size, MUTED);
      }
      if (ch.refY !== undefined) line(left, Y(ch.refY), right, Y(ch.refY), MUTED, 0.6, true);
      const years = ch.x.map((d) => d.slice(0, 4));
      const firstIdx: number[] = [];
      years.forEach((yv, i) => {
        if (i === 0 || yv !== years[i - 1]) firstIdx.push(i);
      });
      const every = Math.ceil(firstIdx.length / 10);
      firstIdx.forEach((i, k) => {
        if (k % every) return;
        line(X(i), bottom, X(i), bottom - 3, MUTED, 0.5);
        text(years[i], X(i) - tw(years[i], size) / 2, bottom - 11, size, MUTED);
      });
      line(left, bottom, right, bottom, MUTED, 0.6);
      text(ch.yTitle, MARGIN, top + 4, size, MUTED);
      for (const s of ch.series) {
        const pts: string[] = [];
        let started = false;
        s.y.forEach((v, i) => {
          if (v === null || !Number.isFinite(v)) {
            started = false;
            return;
          }
          pts.push(`${X(i).toFixed(2)} ${Y(v).toFixed(2)} ${started ? 'l' : 'm'}`);
          started = true;
        });
        ops.push(`${rgb(s.color)} RG ${s.width ?? 1} w 1 j ${s.dash ? '[3 2] 0 d ' : ''}${pts.join(' ')} S${s.dash ? ' [] 0 d' : ''}`);
      }
      y = bottom - 14;
      y -= legend(ch.series.map((s) => ({ name: s.name, color: s.color, dash: s.dash })), y);
    } else if (ch.type === 'dots') {
      const lo0 = Math.min(...ch.low, ch.refX ?? Infinity);
      const hi0 = Math.max(...ch.high, ch.refX ?? -Infinity);
      const pad = (hi0 - lo0) * 0.06 || 0.01;
      const lo = lo0 - pad;
      const hi = hi0 + pad;
      const X = (v: number) => left + ((v - lo) / (hi - lo)) * (right - left);
      const ticks = niceTicks(lo, hi, 6);
      const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
      const rowH = (top - bottom - 20) / ch.categories.length;
      for (const t of ticks) {
        line(X(t), bottom + 20, X(t), top, GRID, 0.4);
        const lab = fmtAxis(t, ch.xFormat, step);
        text(lab, X(t) - tw(lab, size) / 2, bottom + 10, size, MUTED);
      }
      if (ch.refX !== undefined) line(X(ch.refX), bottom + 20, X(ch.refX), top, MUTED, 0.7, true);
      ch.categories.forEach((cat, i) => {
        const cy = top - rowH * (i + 0.5);
        const col = rgb(ch.colors[i]);
        text(cat, MARGIN, cy - 2.5, size + 0.5, INK);
        line(X(ch.low[i]), cy, X(ch.high[i]), cy, col, 1.2);
        line(X(ch.low[i]), cy - 3, X(ch.low[i]), cy + 3, col, 1.2);
        line(X(ch.high[i]), cy - 3, X(ch.high[i]), cy + 3, col, 1.2);
        circle(X(ch.value[i]), cy, 3, col);
      });
      text(ch.xTitle, left + (right - left) / 2 - tw(ch.xTitle, size) / 2, bottom, size, MUTED);
      y = bottom - 6;
    } else {
      const vals = ch.values;
      const mk = ch.markers.map((m) => m.x);
      const lo0 = Math.min(...vals, ...mk);
      const hi0 = Math.max(...vals, ...mk);
      const binW = (hi0 - lo0) / ch.bins || 1;
      const lo = lo0 - binW * 0.5;
      const hi = hi0 + binW * 0.5;
      const counts = new Array(ch.bins + 1).fill(0);
      for (const v of vals) counts[Math.min(ch.bins, Math.floor((v - lo) / binW))]++;
      const cmax = Math.max(...counts, 1);
      const X = (v: number) => left + ((v - lo) / (hi - lo)) * (right - left);
      const Y = (c: number) => bottom + 14 + (c / cmax) * (top - bottom - 24);
      const fill = rgb(lighten(ch.color, 0.45));
      counts.forEach((c, i) => {
        if (!c) return;
        const x0 = X(lo + i * binW) + 0.6;
        const x1 = X(lo + (i + 1) * binW) - 0.6;
        ops.push(`${fill} rg ${x0.toFixed(2)} ${Y(0).toFixed(2)} ${(x1 - x0).toFixed(2)} ${(Y(c) - Y(0)).toFixed(2)} re f`);
      });
      line(left, Y(0), right, Y(0), MUTED, 0.6);
      const ticks = niceTicks(lo, hi, 6);
      const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
      for (const t of ticks) {
        const lab = fmtAxis(t, ch.xFormat, step);
        text(lab, X(t) - tw(lab, size) / 2, Y(0) - 10, size, MUTED);
      }
      for (const m of ch.markers) line(X(m.x), Y(0), X(m.x), top, rgb(m.color), 1.4);
      text(`${ch.xTitle} (bars: number of portfolios)`, MARGIN, top + 4, size, MUTED);
      y = bottom - 4;
      y -= legend(ch.markers.map((m) => ({ name: m.name, color: m.color })), y);
    }
    if (b.note) para(b.note, 7.5, MUTED, { gapAfter: 6 });
    y -= 8;
  };

  const table = (b: Extract<Block, { kind: 'table' }>) => {
    const size = 7.5;
    const lh = size * 1.55;
    const n = b.head.length;
    const all = [b.head, ...b.rows];
    const natural = Array.from({ length: n }, (_, j) => Math.max(...all.map((r, i) => tw(r[j] ?? '', size, i === 0))) + 9);
    const tot = natural.reduce((a, c) => a + c, 0);
    const colW = tot > WIDTH ? natural.map((w) => (w * WIDTH) / tot) : natural;
    const tableW = colW.reduce((a, c) => a + c, 0);
    if (b.caption) {
      ensure(lh * Math.min(all.length, 6) + 16);
      para(b.caption, 9, INK, { bold: true, gapAfter: 3 });
    } else ensure(lh * Math.min(all.length, 4));
    all.forEach((row, i) => {
      const sub = i > 0 && !!b.sub?.[i - 1];
      const nextSub = !!b.sub?.[i];
      ensure(lh * (nextSub ? 2 : 1));
      y -= sub ? lh * 0.85 : lh;
      let x = MARGIN;
      const fs = sub ? size - 0.5 : size;
      row.forEach((cell, j) => {
        const bold = i === 0;
        const w = tw(cell, fs, bold);
        const cx = j > 0 ? x + colW[j] - 4 - w : x + 2;
        text(cell, cx, y, fs, i === 0 || sub ? MUTED : INK, bold);
        x += colW[j];
      });
      if (!nextSub) line(MARGIN, y - 3.5, MARGIN + tableW, y - 3.5, i === 0 ? MUTED : GRID, i === 0 ? 0.6 : 0.4);
    });
    y -= 6;
    if (b.note) para(b.note, 7.5, MUTED, { gapAfter: 4 });
    y -= 6;
  };

  for (const b of blocks) {
    switch (b.kind) {
      case 'title':
        para(b.text, 17, ACCENT, { bold: true, gapAfter: 4 });
        break;
      case 'meta':
        para(b.text, 8, MUTED, { gapAfter: 6 });
        break;
      case 'h2':
        ensure(70);
        y -= 8;
        para(b.text, 12.5, ACCENT, { bold: true, gapAfter: 3 });
        break;
      case 'h3':
        ensure(60);
        y -= 2;
        para(b.text, 10, ACCENT, { bold: true, gapAfter: 2 });
        break;
      case 'p':
        para(b.text, 9.5, INK);
        break;
      case 'note':
        para(b.text, 8, MUTED);
        break;
      case 'warn':
        para(b.text, 9, WARN);
        break;
      case 'bullets':
        for (const it of b.items) para(it, 9.5, INK, { indent: 13, bullet: true, gapAfter: 2.5 });
        y -= 4;
        break;
      case 'table':
        table(b);
        break;
      case 'figure':
        figure(b);
        break;
    }
  }
  newPage();

  // objects: 1–2 fonts, then (content stream, page) per page, then page tree, info, catalog
  const objs: string[] = [];
  const add = (s: string) => objs.push(s);
  const fontReg = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pagesId = 2 + 2 * pages.length + 1;
  const pageIds: number[] = [];
  const total = pages.length;
  pages.forEach((content, i) => {
    const num = `${i + 1} / ${total}`;
    const footer = `BT /F1 7 Tf ${MUTED} rg ${MARGIN} 28 Td ${pdfString(toCp1252(opts.footer))} Tj ET\nBT /F1 7 Tf ${MUTED} rg ${(PAGE_W - MARGIN - tw(num, 7)).toFixed(2)} 28 Td ${pdfString(toCp1252(num))} Tj ET`;
    const stream = `${content}\n${footer}`;
    const sid = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontReg} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${sid} 0 R >>`));
  });
  const realPagesId = add(`<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  if (realPagesId !== pagesId) throw new Error('PDF object numbering');
  const info = add(`<< /Title ${pdfString('Swiss Equity Portfolio Lab - results report')} /Producer (Swiss Equity Portfolio Lab) >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);

  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
