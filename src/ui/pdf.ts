/**
 * Minimal PDF writer (no dependency) for the plain-language report: A4 pages,
 * the standard fonts Helvetica and Helvetica-Bold (WinAnsiEncoding, no font
 * embedding needed), headings, paragraphs with bold spans, bullet lists, small
 * tables, page numbers. Text is wrapped with the official glyph widths.
 */

import { HELVETICA, HELVETICA_BOLD } from './pdfmetrics.ts';

export type Block =
  | { kind: 'title'; text: string }
  | { kind: 'meta'; text: string }
  | { kind: 'h2'; text: string }
  | { kind: 'p'; text: string } // **bold** spans allowed
  | { kind: 'warn'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][]; align?: ('l' | 'r')[] };

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;
const WIDTH = PAGE_W - 2 * MARGIN;
const INK = '0.12 0.14 0.17';
const MUTED = '0.40 0.43 0.47';
const ACCENT = '0.11 0.31 0.57';
const WARN = '0.54 0.35 0.00';

/** Characters outside cp1252 replaced by readable equivalents. */
const SUBST: Record<string, string> = {
  '−': '-', '≤': '<=', '≥': '>=', '→': '->', '←': '<-', 'Σ': 'Sum ', 'σ': 'sigma', 'μ': 'µ', 'λ': 'lambda', 'α': 'alpha',
  'β': 'beta', 'ν': 'nu', '√': 'sqrt', '₀': '0', '⌊': '', '⌋': '', '≈': '~', '·': '·', ' ': ' ', ' ': ' ', ' ': ' ',
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
    if (sub !== undefined && sub !== ch) {
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

type Run = { text: string; bold: boolean };

/** Splits "a **b** c" into runs; text already cp1252-encoded. */
function runs(text: string, bold = false): Run[] {
  const parts = text.split('**');
  return parts.map((t, i) => ({ text: toCp1252(t), bold: bold !== (i % 2 === 1) })).filter((r) => r.text.length > 0);
}

/** Word wrapping of runs into lines of at most maxW points. */
function wrap(rs: Run[], size: number, maxW: number): Run[][] {
  const words: Run[] = [];
  for (const r of rs) {
    const parts = r.text.split(/( )/);
    for (const p of parts) if (p.length) words.push({ text: p, bold: r.bold });
  }
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
    if (y - h < MARGIN + 24) newPage();
  };
  const textLine = (line: Run[], x: number, size: number, color: string) => {
    let cx = x;
    for (const r of line) {
      ops.push(`BT /${r.bold ? 'F2' : 'F1'} ${size} Tf ${color} rg ${cx.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(r.text)} Tj ET`);
      cx += width(r.text, r.bold, size);
    }
  };
  const para = (text: string, size: number, color: string, opt: { bold?: boolean; indent?: number; gapAfter?: number; bullet?: boolean } = {}) => {
    const indent = opt.indent ?? 0;
    const lines = wrap(runs(text, opt.bold), size, WIDTH - indent);
    const lh = size * 1.38;
    lines.forEach((ln, i) => {
      ensure(lh);
      y -= lh;
      if (opt.bullet && i === 0) textLine([{ text: toCp1252('•'), bold: false }], MARGIN + indent - 10, size, color);
      textLine(ln, MARGIN + indent, size, color);
    });
    y -= opt.gapAfter ?? size * 0.6;
  };

  for (const b of blocks) {
    switch (b.kind) {
      case 'title':
        para(b.text, 18, ACCENT, { bold: true, gapAfter: 4 });
        break;
      case 'meta':
        para(b.text, 8.5, MUTED, { gapAfter: 8 });
        break;
      case 'h2':
        ensure(40);
        y -= 6;
        para(b.text, 12.5, ACCENT, { bold: true, gapAfter: 3 });
        break;
      case 'p':
        para(b.text, 10, INK);
        break;
      case 'note':
        para(b.text, 8.5, MUTED);
        break;
      case 'warn':
        para(b.text, 9.5, WARN, { bold: false });
        break;
      case 'bullets':
        for (const it of b.items) para(it, 10, INK, { indent: 14, bullet: true, gapAfter: 3 });
        y -= 4;
        break;
      case 'table': {
        const size = 8.5;
        const lh = size * 1.6;
        const enc = [b.head, ...b.rows].map((r) => r.map((c) => toCp1252(c)));
        const n = b.head.length;
        const natural = Array.from({ length: n }, (_, j) => Math.max(...enc.map((r, i) => width(r[j] ?? '', i === 0, size))) + 10);
        const tot = natural.reduce((a, c) => a + c, 0);
        const colW = natural.map((w) => (w * Math.min(WIDTH, tot)) / tot);
        ensure(lh * Math.min(enc.length, 4));
        enc.forEach((row, i) => {
          ensure(lh);
          y -= lh;
          let x = MARGIN;
          row.forEach((cell, j) => {
            const right = (b.align?.[j] ?? (j === 0 ? 'l' : 'r')) === 'r';
            const w = width(cell, i === 0, size);
            const cx = right ? x + colW[j] - 5 - w : x + 2;
            ops.push(`BT /${i === 0 ? 'F2' : 'F1'} ${size} Tf ${i === 0 ? MUTED : INK} rg ${cx.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(cell)} Tj ET`);
            x += colW[j];
          });
          ops.push(`0.85 0.87 0.9 RG 0.5 w ${MARGIN} ${(y - 4).toFixed(2)} m ${(MARGIN + colW.reduce((a, c) => a + c, 0)).toFixed(2)} ${(y - 4).toFixed(2)} l S`);
        });
        y -= 10;
        break;
      }
    }
  }
  newPage();

  // assemble objects
  const objs: string[] = [];
  const add = (s: string) => objs.push(s); // returns the 1-based object number
  const fontReg = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  // numbering: 1–2 fonts, then (content stream, page) per page, then the page tree
  const pagesId = 2 + 2 * pages.length + 1;
  const pageIds: number[] = [];
  const total = pages.length;
  pages.forEach((content, i) => {
    const footer = `BT /F1 7.5 Tf ${MUTED} rg ${MARGIN} 30 Td ${pdfString(toCp1252(opts.footer))} Tj ET\nBT /F1 7.5 Tf ${MUTED} rg ${(PAGE_W - MARGIN - width(toCp1252(`${i + 1} / ${total}`), false, 7.5)).toFixed(2)} 30 Td ${pdfString(toCp1252(`${i + 1} / ${total}`))} Tj ET`;
    const stream = `${content}\n${footer}`;
    const sid = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontReg} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${sid} 0 R >>`));
  });
  const realPagesId = add(`<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  if (realPagesId !== pagesId) throw new Error('PDF object numbering');
  const info = add(`<< /Title ${pdfString('Swiss Equity Portfolio Lab - report')} /Producer (Swiss Equity Portfolio Lab) >>`);
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
