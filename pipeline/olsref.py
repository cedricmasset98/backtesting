"""OLS and residual diagnostics in numpy/scipy, with the conventions of the
browser engine (src/engine, reused from Empirical-Asset-Pricing) and of
statsmodels. Copied unchanged from Empirical-Asset-Pricing/pipeline/olsref.py;
equality with statsmodels is checked by pipeline/tests/test_statsref.py.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy import stats


@dataclass
class Fit:
    params: np.ndarray
    se: np.ndarray
    stat: np.ndarray
    pvalue: np.ndarray
    ci_low: np.ndarray
    ci_high: np.ndarray
    cov: np.ndarray
    r2: float
    r2adj: float
    sigma: float
    n: int
    k: int
    fitted: np.ndarray
    resid: np.ndarray
    distribution: str  # "t" ou "normal"
    crit: float
    joint_stat: float
    joint_pvalue: float
    joint_label: str
    hac_lags: int | None


def nw_lags(n: int) -> int:
    """Règle de Newey-West (1994) : L = floor(4 (n/100)^(2/9))."""
    return int(math.floor(4 * (n / 100) ** (2 / 9)))


def fit(y: np.ndarray, X: np.ndarray, cov: str = "classical", lags: int | None = None, level: float = 0.95) -> Fit:
    n, k = X.shape
    xtx_inv = np.linalg.inv(X.T @ X)
    b = xtx_inv @ X.T @ y
    fitted = X @ b
    e = y - fitted
    ssr = float(e @ e)
    s2 = ssr / (n - k)
    sst = float(((y - y.mean()) ** 2).sum())
    r2 = 1 - ssr / sst
    r2adj = 1 - (1 - r2) * (n - 1) / (n - k)
    used_lags = None
    if cov == "classical":
        v = s2 * xtx_inv
    elif cov == "HC3":
        h = np.einsum("ij,jk,ik->i", X, xtx_inv, X)
        meat = (X * (e**2 / (1 - h) ** 2)[:, None]).T @ X
        v = xtx_inv @ meat @ xtx_inv
    elif cov == "HAC":
        used_lags = nw_lags(n) if lags is None else lags
        u = X * e[:, None]
        s = u.T @ u
        for lag in range(1, used_lags + 1):
            w = 1 - lag / (used_lags + 1)
            g = u[lag:].T @ u[:-lag]
            s = s + w * (g + g.T)
        v = xtx_inv @ s @ xtx_inv
    else:
        raise ValueError(cov)
    se = np.sqrt(np.diag(v))
    stat = b / se
    alpha = 1 - level
    if cov == "classical":
        dist, crit = "t", float(stats.t.ppf(1 - alpha / 2, n - k))
        p = 2 * stats.t.sf(np.abs(stat), n - k)
        q = k - 1
        f = ((sst - ssr) / q) / s2
        joint = (float(f), float(stats.f.sf(f, q, n - k)), f"F({q}, {n - k})")
    else:
        dist, crit = "normal", float(stats.norm.ppf(1 - alpha / 2))
        p = 2 * stats.norm.sf(np.abs(stat))
        bs = b[1:]
        w = float(bs @ np.linalg.inv(v[1:, 1:]) @ bs)
        joint = (w, float(stats.chi2.sf(w, k - 1)), f"Wald χ²({k - 1})")
    return Fit(b, se, stat, p, b - crit * se, b + crit * se, v, r2, r2adj, math.sqrt(s2), n, k, fitted, e,
               dist, crit, joint[0], joint[1], joint[2], used_lags)


def mean_ci(f: Fit, x0: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Intervalle de la moyenne conditionnelle pour une grille x0 (lignes = points)."""
    m = x0 @ f.params
    se = np.sqrt(np.einsum("ij,jk,ik->i", x0, f.cov, x0))
    return m, m - f.crit * se, m + f.crit * se


def ljung_box(e: np.ndarray, m: int) -> tuple[float, float]:
    n = len(e)
    d = e - e.mean()
    c0 = d @ d
    r = np.array([(d[k:] @ d[:-k]) / c0 for k in range(1, m + 1)])
    q = n * (n + 2) * np.sum(r**2 / (n - np.arange(1, m + 1)))
    return float(q), float(stats.chi2.sf(q, m))


def breusch_pagan(e: np.ndarray, X: np.ndarray) -> tuple[float, float]:
    e2 = e**2
    g, *_ = np.linalg.lstsq(X, e2, rcond=None)
    ea = e2 - X @ g
    r2 = 1 - (ea @ ea) / ((e2 - e2.mean()) ** 2).sum()
    lm = len(e) * r2
    return float(lm), float(stats.chi2.sf(lm, X.shape[1] - 1))


def jarque_bera(e: np.ndarray) -> tuple[float, float, float, float]:
    s = float(stats.skew(e))
    k = float(stats.kurtosis(e, fisher=False))
    jb = len(e) / 6 * (s**2 + (k - 3) ** 2 / 4)
    return float(jb), float(stats.chi2.sf(jb, 2)), s, k


def lb_lags(n: int) -> int:
    return max(1, min(12, n // 5))
