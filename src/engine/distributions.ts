/**
 * Lois de probabilité utilisées pour l'inférence : normale, Student, Fisher, χ².
 * Implémentation autonome (fonctions bêta et gamma incomplètes régularisées),
 * validée contre scipy.stats dans tests/distributions.test.ts.
 */

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** ln Γ(x) pour x > 0 (approximation de Lanczos, g = 7). */
export function lnGamma(x: number): number {
  if (x < 0.5) {
    // formule de réflexion
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  }
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

const EPS = 1e-16;
const FPMIN = 1e-300;
const MAX_ITER = 10000;

/** Fraction continue de la fonction bêta incomplète (algorithme de Lentz modifié). */
function betacf(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) return h;
  }
  return h;
}

/** Fonction bêta incomplète régularisée I_x(a, b). */
export function betaInc(a: number, b: number, x: number): number {
  if (!(a > 0) || !(b > 0)) return NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbt = lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  const bt = Math.exp(lbt);
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Fonction gamma incomplète régularisée inférieure P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) return gammaSeries(a, x);
  return 1 - gammaCF(a, x);
}

/** Fonction gamma incomplète régularisée supérieure Q(a, x) = 1 − P(a, x). */
export function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  if (x < a + 1) return 1 - gammaSeries(a, x);
  return gammaCF(a, x);
}

function gammaSeries(a: number, x: number): number {
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < MAX_ITER; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
}

function gammaCF(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= MAX_ITER; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

// ---------------------------------------------------------------- Normale

/** Fonction de répartition de la loi normale centrée réduite. */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  const z = (x * x) / 2;
  const tail = 0.5 * gammaQ(0.5, z); // = P(Z > |x|)
  return x < 0 ? tail : 1 - tail;
}

/** Fonction de survie P(Z > x). */
export function normSf(x: number): number {
  return normCdf(-x);
}

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Quantile de la loi normale (algorithme d'Acklam + un pas de Halley). */
export function normPpf(p: number): number {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  let x: number;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - plow) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // raffinement de Halley
  for (let i = 0; i < 2; i++) {
    const e = normCdf(x) - p;
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
    x = x - u / (1 + (x * u) / 2);
  }
  return x;
}

// ---------------------------------------------------------------- Student

/** p-value bilatérale P(|T| > |t|) pour T ~ t(df). */
export function tTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t)) return Number.isNaN(t) ? NaN : 0;
  return betaInc(df / 2, 0.5, df / (df + t * t));
}

/** Fonction de répartition de Student. */
export function tCdf(t: number, df: number): number {
  const p2 = tTwoSidedP(t, df);
  return t >= 0 ? 1 - p2 / 2 : p2 / 2;
}

const tCritCache = new Map<string, number>();

/** Valeur critique bilatérale c telle que P(|T| > c) = alpha, T ~ t(df). */
export function tCritTwoSided(alpha: number, df: number): number {
  const key = `${alpha}|${df}`;
  const cached = tCritCache.get(key);
  if (cached !== undefined) return cached;
  let lo = 0;
  let hi = 1;
  while (tTwoSidedP(hi, df) > alpha) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (tTwoSidedP(mid, df) > alpha) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-15 * hi) break;
  }
  const c = 0.5 * (lo + hi);
  tCritCache.set(key, c);
  return c;
}

/** Valeur critique bilatérale de la loi normale. */
export function zCritTwoSided(alpha: number): number {
  return normPpf(1 - alpha / 2);
}

// ---------------------------------------------------------------- Fisher et χ²

/** Fonction de survie de la loi de Fisher F(d1, d2). */
export function fSf(f: number, d1: number, d2: number): number {
  if (!(f > 0)) return 1;
  if (!Number.isFinite(f)) return 0;
  return betaInc(d2 / 2, d1 / 2, d2 / (d2 + d1 * f));
}

/** Fonction de survie de la loi du χ²(k). */
export function chi2Sf(x: number, k: number): number {
  if (!(x > 0)) return 1;
  if (!Number.isFinite(x)) return 0;
  return gammaQ(k / 2, x / 2);
}
