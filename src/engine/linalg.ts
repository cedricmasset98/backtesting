/**
 * Petites routines d'algèbre linéaire dense (k ≤ ~10 régresseurs).
 * Matrices stockées en tableaux de lignes (number[][]).
 */

export type Matrix = number[][];
export type Vector = number[];

export class SingularMatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SingularMatrixError';
  }
}

export function zeros(r: number, c: number): Matrix {
  const m: Matrix = new Array(r);
  for (let i = 0; i < r; i++) m[i] = new Array(c).fill(0);
  return m;
}

export function transpose(a: Matrix): Matrix {
  const r = a.length;
  const c = r ? a[0].length : 0;
  const t = zeros(c, r);
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) t[j][i] = a[i][j];
  return t;
}

export function matmul(a: Matrix, b: Matrix): Matrix {
  const n = a.length;
  const m = b[0].length;
  const p = b.length;
  const out = zeros(n, m);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < p; k++) {
      const aik = a[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < m; j++) out[i][j] += aik * b[k][j];
    }
  }
  return out;
}

export function matvec(a: Matrix, v: Vector): Vector {
  return a.map((row) => dot(row, v));
}

export function dot(a: Vector, b: Vector): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** X'X pour X (n × k) stockée par lignes d'observations. */
export function crossprod(x: Matrix): Matrix {
  const k = x[0].length;
  const out = zeros(k, k);
  for (const row of x) {
    for (let i = 0; i < k; i++) {
      const ri = row[i];
      for (let j = i; j < k; j++) out[i][j] += ri * row[j];
    }
  }
  for (let i = 0; i < k; i++) for (let j = 0; j < i; j++) out[i][j] = out[j][i];
  return out;
}

/** X'y */
export function crossprodVec(x: Matrix, y: Vector): Vector {
  const k = x[0].length;
  const out = new Array(k).fill(0);
  for (let t = 0; t < x.length; t++) {
    const row = x[t];
    const yt = y[t];
    for (let i = 0; i < k; i++) out[i] += row[i] * yt;
  }
  return out;
}

/**
 * Décomposition de Cholesky A = L L' d'une matrice symétrique définie positive.
 * Lève SingularMatrixError si A est (numériquement) singulière, ce qui signale
 * une colinéarité parfaite entre régresseurs.
 */
export function cholesky(a: Matrix): Matrix {
  const n = a.length;
  const l = zeros(n, n);
  let maxDiag = 0;
  for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, Math.abs(a[i][i]));
  const tol = 1e-13 * Math.max(maxDiag, 1e-300);
  for (let j = 0; j < n; j++) {
    let s = a[j][j];
    for (let k = 0; k < j; k++) s -= l[j][k] * l[j][k];
    if (!(s > tol)) {
      throw new SingularMatrixError(
        "The X'X matrix is singular: perfectly collinear regressors or a constant variable.",
      );
    }
    const d = Math.sqrt(s);
    l[j][j] = d;
    for (let i = j + 1; i < n; i++) {
      let t = a[i][j];
      for (let k = 0; k < j; k++) t -= l[i][k] * l[j][k];
      l[i][j] = t / d;
    }
  }
  return l;
}

/** Inverse d'une matrice symétrique définie positive via Cholesky. */
export function invSPD(a: Matrix): Matrix {
  const n = a.length;
  const l = cholesky(a);
  // inverse de L (triangulaire inférieure)
  const li = zeros(n, n);
  for (let i = 0; i < n; i++) {
    li[i][i] = 1 / l[i][i];
    for (let j = 0; j < i; j++) {
      let s = 0;
      for (let k = j; k < i; k++) s -= l[i][k] * li[k][j];
      li[i][j] = s / l[i][i];
    }
  }
  // A^-1 = L^-T L^-1
  const out = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = i; k < n; k++) s += li[k][i] * li[k][j];
      out[i][j] = s;
      out[j][i] = s;
    }
  }
  return out;
}

/** Inverse générale par Gauss-Jordan avec pivot partiel (pour matrices non SPD). */
export function inv(a: Matrix): Matrix {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-300) throw new SingularMatrixError('Singular matrix.');
    [m[c], m[p]] = [m[p], m[c]];
    const piv = m[c][c];
    for (let j = 0; j < 2 * n; j++) m[c][j] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[c][j];
    }
  }
  return m.map((row) => row.slice(n));
}

/** Forme quadratique v' A v */
export function quadForm(a: Matrix, v: Vector): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) for (let j = 0; j < v.length; j++) s += v[i] * a[i][j] * v[j];
  return s;
}

/** Sous-matrice (lignes et colonnes d'indices idx). */
export function subMatrix(a: Matrix, idx: number[]): Matrix {
  return idx.map((i) => idx.map((j) => a[i][j]));
}
