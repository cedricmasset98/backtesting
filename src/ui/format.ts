/** Formatage des nombres (point décimal, cohérent avec les exports CSV). */

export function pct(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return '—';
  return `${noNegZero((x * 100).toFixed(digits))}%`;
}

export function num(x: number, digits = 3): string {
  if (!Number.isFinite(x)) return '—';
  return noNegZero(x.toFixed(digits));
}

/** '-0.00' → '0.00' (a value that rounds to zero carries no sign). */
function noNegZero(s: string): string {
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
}

export function pval(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p < 1e-4) return p.toExponential(1);
  return p.toFixed(4);
}

export function stars(p: number): string {
  if (!Number.isFinite(p)) return '';
  if (p < 0.01) return '***';
  if (p < 0.05) return '**';
  if (p < 0.1) return '*';
  return '';
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function signedPct(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return '—';
  return `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(digits)}%`;
}

/** Coefficient with significance stars (two-sided p-values: * 10 %, ** 5 %, *** 1 %). */
export function coefStars(b: number, p: number, digits = 3): string {
  return `${num(b, digits)}${stars(p)}`;
}
