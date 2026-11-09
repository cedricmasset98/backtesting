"""Covariance and expected-return estimators (all ex ante: inputs are the
returns of the estimation window ending at the decision date)."""

from __future__ import annotations

import numpy as np

from . import config as C


def sample_cov(x: np.ndarray, ridge: float = C.RIDGE) -> np.ndarray:
    """Unbiased sample covariance (divisor T−1) plus a tiny ridge
    RIDGE·tr(S)/N·I. The ridge only guarantees numerical positive definiteness
    when N ≥ T (the matrix is then singular); it does not change well-posed
    problems in any visible way."""
    t, n = x.shape
    if t < 2:
        raise ValueError("At least two observations are needed for a covariance matrix.")
    s = np.cov(x, rowvar=False, ddof=1)
    s = np.atleast_2d(s)
    return s + ridge * np.trace(s) / n * np.eye(n)


def ledoit_wolf_cc(x: np.ndarray) -> tuple[np.ndarray, float]:
    """Ledoit & Wolf (2004), "Honey, I shrunk the sample covariance matrix":
    shrinkage of the sample covariance (divisor T) towards the constant-correlation
    target F (f_ii = s_ii, f_ij = r̄ √(s_ii s_jj), r̄ = average sample correlation).

    Σ̂ = δ* F + (1 − δ*) S, with δ* = max(0, min(1, κ̂/T)), κ̂ = (π̂ − ρ̂)/γ̂.
    The diagonal is unchanged, so individual volatilities equal the sample ones
    (up to the T vs T−1 divisor). Returns (Σ̂ rescaled to the T−1 divisor, δ*).
    """
    t, n = x.shape
    xc = x - x.mean(axis=0)
    s = xc.T @ xc / t
    var = np.diag(s).copy()
    sd = np.sqrt(var)
    corr = s / np.outer(sd, sd)
    rbar = (corr.sum() - n) / (n * (n - 1)) if n > 1 else 0.0
    f = rbar * np.outer(sd, sd)
    np.fill_diagonal(f, var)
    # π̂: sum of asymptotic variances of the entries of S
    y = xc**2
    pi_mat = y.T @ y / t - s**2
    pi_hat = pi_mat.sum()
    # ρ̂: asymptotic covariances between the entries of F and S
    theta_ii = (xc**3).T @ xc / t - var[:, None] * s  # θ_{ii,ij}
    rho_off = 0.0
    if n > 1:
        ratio = np.outer(1 / sd, sd)  # √(s_jj / s_ii)
        term = ratio * theta_ii + ratio.T * theta_ii.T
        np.fill_diagonal(term, 0.0)
        rho_off = rbar / 2 * term.sum()
    rho_hat = np.trace(pi_mat) + rho_off
    gamma_hat = ((f - s) ** 2).sum()
    kappa = (pi_hat - rho_hat) / gamma_hat if gamma_hat > 0 else 0.0
    delta = float(max(0.0, min(1.0, kappa / t)))
    sigma = delta * f + (1 - delta) * s
    return sigma * t / (t - 1), delta


def covariance(x: np.ndarray, method: str) -> tuple[np.ndarray, float | None]:
    if method == "sample":
        return sample_cov(x), None
    if method == "lw":
        return ledoit_wolf_cc(x)
    raise ValueError(f"Unknown covariance method: {method}")


def bayes_stein_mean(x: np.ndarray, sigma: np.ndarray) -> tuple[np.ndarray, float]:
    """Jorion (1986) Bayes-Stein estimator of expected returns:

        μ_BS = (1 − φ) μ̂ + φ μ_0 1,  μ_0 = 1'Σ⁻¹μ̂ / 1'Σ⁻¹1 (mean of the GMV portfolio),
        φ = λ / (T + λ),  λ = (N + 2) / [(μ̂ − μ_0 1)' Σ⁻¹ (μ̂ − μ_0 1)].

    Σ is a well-conditioned estimate (Ledoit-Wolf in the pipeline, also when the
    "sample" covariance option is selected, because the sample matrix is
    singular when N ≥ T). Returns (μ_BS, φ)."""
    t, n = x.shape
    mu = x.mean(axis=0)
    inv = np.linalg.inv(sigma)
    ones = np.ones(n)
    mu0 = float(ones @ inv @ mu / (ones @ inv @ ones))
    d = mu - mu0
    q = float(d @ inv @ d)
    lam = (n + 2) / q if q > 0 else np.inf
    phi = 1.0 if not np.isfinite(lam) else lam / (t + lam)
    return (1 - phi) * mu + phi * mu0, float(phi)
