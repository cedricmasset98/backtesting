/** CSV exports (comma separator, decimal point, unrounded values). */

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

export function download(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob(['﻿' + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV of an HTML table as displayed (header rows included). */
export function tableCsv(table: HTMLTableElement): string {
  const rows = [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('th,td')].map((c) => (c as HTMLElement).dataset.v ?? c.textContent?.trim() ?? ''));
  return toCsv(rows);
}
