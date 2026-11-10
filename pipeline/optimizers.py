"""Portfolio construction rules. All portfolios are long-only and fully
invested (Σw = 1, 0 ≤ w_i ≤ u, u = weight cap; u = 1 means no cap).

Optimised portfolios (GMV, TP, MDP) are solved on the capped simplex with the
spectral projected gradient method and an exact projection. GMV is a convex
QP; the ratio problems (TP, MDP) are pseudo-concave on {q'w > 0}, so their
first-order (KKT) points are global maxima.
"""

from __future__ import annotations

import math

import numpy as np

from . import config as C


# Solver statistics, reported in the build manifest.
STATS = {"qp_solves": 0, "qp_failures": 0, "ratio_not_converged": 0, "erc_fallback": 0}


# --------------------------------------------------------------- projections

def project_capped_simplex(v: np.ndarray, cap: float = 1.0) -> np.ndarray:
    """Exact Euclidean projection on {w : Σw = 1, 0 ≤ w ≤ cap}.

    w_i = clip(v_i − τ, 0, cap) where τ solves g(τ) = Σ clip(v_i − τ, 0, cap) = 1.
    g is piecewise linear and non-increasing with breakpoints {v_i} ∪ {v_i − cap}:
    g is evaluated at every breakpoint with sorted cumulative sums, and τ is then
    obtained exactly on the bracketing linear piece (O(N log N))."""
    v = np.asarray(v, float)
    v = v - v.max()  # shift invariance: improves accuracy for large inputs
    n = v.size
    if cap * n < 1 - 1e-12:
        raise ValueError(f"Infeasible cap: {n} assets × {cap} < 1.")
    cap = min(cap, 1.0)
    vs = np.sort(v)
    cs = np.concatenate(([0.0], np.cumsum(vs)))

    def pieces(tau: np.ndarray):
        lo = np.searchsorted(vs, tau, side="right")        # v_i ≤ τ → 0
        hi = np.searchsorted(vs, tau + cap, side="left")    # v_i ≥ τ + cap → cap
        n_cap = n - hi
        n_free = hi - lo
        s_free = cs[hi] - cs[lo]
        return n_cap, n_free, s_free

    b = np.unique(np.concatenate((vs, vs - cap)))
    n_cap, n_free, s_free = pieces(b)
    g = cap * n_cap + s_free - b * n_free
    k = int(np.searchsorted(-g, -1.0, side="right")) - 1   # last breakpoint with g ≥ 1
    if k < 0:
        tau = b[0] - (1 - g[0]) / max(n, 1)
    elif k >= b.size - 1:
        tau = b[-1]
    else:
        mid = np.array([0.5 * (b[k] + b[k + 1])])
        nc, nf, sf = (a[0] for a in pieces(mid))
        tau = (cap * nc + sf - 1) / nf if nf > 0 else b[k]
    w = np.clip(v - tau, 0.0, cap)
    tot = w.sum()
    if not np.isfinite(tot) or tot <= 0:
        # numerically degenerate input: the projection keeps the largest entries
        k = int(math.ceil(1 / cap - 1e-12))
        w = np.zeros(n)
        top = np.argsort(v)[::-1][:k]
        w[top] = cap
        w[top[-1]] = 1 - cap * (k - 1)
        return w
    return w / tot


def apply_cap(w: np.ndarray, cap: float) -> np.ndarray:
    """Cap a rule-based allocation (EW, IVP, ERC): weights above the cap are set
    to the cap and the excess is redistributed pro rata to the other weights,
    repeatedly ("water filling"). The proportions among uncapped assets are kept."""
    w = np.asarray(w, float).copy()
    if cap >= 1 or w.max() <= cap + 1e-15:
        return w
    for _ in range(w.size):
        over = w > cap
        excess = (w[over] - cap).sum()
        if excess <= 1e-15:
            break
        w[over] = cap
        room = ~over & (w < cap)
        w[room] += excess * w[room] / w[room].sum()
    return w / w.sum()


# --------------------------------------------------------------------- SPG

def spg(fg, x0: np.ndarray, cap: float, tol: float = 1e-9, max_iter: int = C.MAX_ITER, memory: int = 10):
    """Spectral projected gradient (Birgin, Martínez & Raydan, 2000) for
    min h(w) on the capped simplex, with Barzilai-Borwein steps and a
    non-monotone Armijo line search. `fg(w)` returns (h(w), ∇h(w)).
    Stops when ‖P(w − ∇h) − w‖∞ < tol (first-order optimality).
    Returns (w, iterations)."""
    x = project_capped_simplex(x0, cap)
    f, g = fg(x)
    hist = [f]
    pg = project_capped_simplex(x - g, cap) - x
    alpha = 1.0 / max(np.abs(pg).max(), 1e-12)
    it = 0
    for it in range(1, max_iter + 1):
        if np.abs(project_capped_simplex(x - g, cap) - x).max() < tol:
            break
        d = project_capped_simplex(x - alpha * g, cap) - x
        gd = float(g @ d)
        fmax = max(hist[-memory:])
        lam = 1.0
        while True:
            xn = x + lam * d
            fn, gn = fg(xn)
            if fn <= fmax + 1e-4 * lam * gd or lam < 1e-12:
                break
            lam *= 0.5
        s_ = xn - x
        y_ = gn - g
        sy = float(s_ @ y_)
        alpha = float(s_ @ s_) / sy if sy > 1e-300 else 1e10
        alpha = min(max(alpha, 1e-10), 1e8)
        x, f, g = xn, fn, gn
        hist.append(f)
    return x, it


def qp_active_set(sigma: np.ndarray, q: np.ndarray, cap: float, w0: np.ndarray, tol: float = 1e-12,
                  max_iter: int = 2000) -> tuple[np.ndarray, bool]:
    """Exact solution of min ½ w'Σw − q'w s.t. 1'w = 1, 0 ≤ w ≤ cap (Σ positive
    definite) by a primal active-set method (Nocedal & Wright, 2006, alg. 16.3),
    started from a feasible point (in practice an approximate SPG solution, so
    that few active-set changes remain). Each iteration solves the equality-
    constrained QP on the free assets with a Cholesky factorisation.

    KKT conditions at the solution: (Σw − q)_i = ν on free assets, ≥ ν on assets
    at zero, ≤ ν on assets at the cap. Returns (w, converged)."""
    n = sigma.shape[0]
    cap = min(cap, 1.0)
    w = project_capped_simplex(w0, cap)
    at_lo = w <= 1e-12
    at_hi = (w >= cap - 1e-12) & ~at_lo if cap < 1 else np.zeros(n, bool)
    w[at_lo] = 0.0
    w[at_hi] = cap
    free = ~(at_lo | at_hi)
    if free.any():
        w[free] += (1 - w.sum()) / free.sum()
    for _ in range(max_iter):
        free = ~(at_lo | at_hi)
        nf = int(free.sum())
        budget = 1.0 - cap * int(at_hi.sum())
        g = sigma @ w - q
        if nf == 0:
            nu = 0.0
            x = np.empty(0)
            step = np.empty(0)
        else:
            A = sigma[np.ix_(free, free)]
            rhs = q[free] - (sigma[np.ix_(free, at_hi)] @ np.full(int(at_hi.sum()), cap) if at_hi.any() else 0.0)
            L = np.linalg.cholesky(A)
            a = np.linalg.solve(L.T, np.linalg.solve(L, rhs))
            b = np.linalg.solve(L.T, np.linalg.solve(L, np.ones(nf)))
            nu = (budget - a.sum()) / b.sum()
            x = a + nu * b
            step = x - w[free]
        if nf == 0 or np.abs(step).max() <= tol:
            if nf:
                w[free] = x
            g = sigma @ w - q
            nu_hat = float(np.mean(g[free])) if nf else float(np.median(g))
            viol_lo = np.where(at_lo, g - nu_hat, np.inf)       # must be ≥ 0
            viol_hi = np.where(at_hi, nu_hat - g, np.inf)       # must be ≥ 0
            i_lo, i_hi = int(np.argmin(viol_lo)), int(np.argmin(viol_hi))
            worst = min(viol_lo[i_lo], viol_hi[i_hi])
            if worst >= -1e-12 * max(1.0, np.abs(g).max()):
                return w, True
            if viol_lo[i_lo] <= viol_hi[i_hi]:
                at_lo[i_lo] = False
            else:
                at_hi[i_hi] = False
            continue
        # move towards x until a bound blocks
        wf = w[free]
        ratio = np.full(nf, np.inf)
        neg, pos = step < 0, step > 0
        ratio[neg] = -wf[neg] / step[neg]
        if cap < 1:
            ratio[pos] = (cap - wf[pos]) / step[pos]
        j = int(np.argmin(ratio))
        alpha = min(1.0, float(ratio[j]))
        w[free] = wf + alpha * step
        if alpha < 1.0:
            fi = np.flatnonzero(free)[j]
            if step[j] < 0:
                at_lo[fi] = True
                w[fi] = 0.0
            else:
                at_hi[fi] = True
                w[fi] = cap
    return w, False


def gmv(sigma: np.ndarray, cap: float, w0: np.ndarray | None = None) -> np.ndarray:
    """Global minimum variance: min w'Σw on the capped simplex. A short SPG run
    (or the previous solution) gives the starting active set; the active-set
    method then returns the exact solution."""
    n = sigma.shape[0]
    S = sigma / np.mean(np.diag(sigma))

    def fg(w):
        m = S @ w
        return 0.5 * float(w @ m), m

    x0 = np.full(n, 1.0 / n) if w0 is None else w0
    x0 = spg(fg, x0, cap, tol=1e-6, max_iter=300)[0]
    w, ok = qp_active_set(S, np.zeros(n), cap, x0)
    STATS["qp_solves"] += 1
    STATS["qp_failures"] += int(not ok)
    return w if ok else spg(fg, w, cap)[0]


def max_ratio(sigma: np.ndarray, q: np.ndarray, cap: float, w0: np.ndarray | None = None) -> tuple[np.ndarray, float]:
    """max f(w) = q'w / √(w'Σw) on the capped simplex.

    On {q'w > 0}, f is the ratio of a positive linear function and a positive
    convex one: it is pseudo-concave, so every KKT point is a global maximum.
    The KKT conditions of this problem are those of the QP
    min ½w'Σw − λ q'w with λ = w'Σw / q'w (same multipliers up to a positive
    factor). The solver runs SPG ascent from the best of several feasible
    starts, then iterates λ ← w'Σw / q'w with exact active-set QP solutions
    until the weights no longer change. Returns (w, f(w)); f ≤ 0 means that no
    portfolio has q'w > 0."""
    n = sigma.shape[0]
    qmax = max(np.abs(q).max(), 1e-300)
    qs = q / qmax
    S = sigma / np.mean(np.diag(sigma))

    def ratio(w):
        return float(qs @ w) / math.sqrt(float(w @ S @ w))

    starts = [np.full(n, 1.0 / n), project_capped_simplex(qs * 1e6, cap)]
    if w0 is not None and w0.size == n:
        starts.insert(0, project_capped_simplex(w0, cap))
    x = max(starts, key=ratio)
    if ratio(x) <= 0:
        return x, ratio(x) * qmax / math.sqrt(np.mean(np.diag(sigma)))

    def fg(w):
        m = S @ w
        v = float(w @ m)
        sd = math.sqrt(v)
        a = float(qs @ w)
        if a <= 0:
            return np.inf, -qs
        return -a / sd, -(qs / sd - a * m / (sd * v))

    x = spg(fg, x, cap, tol=1e-7, max_iter=500)[0]
    best, best_r = x, ratio(x)
    converged = False
    for _ in range(100):
        lam = float(x @ S @ x) / float(qs @ x)
        y, ok = qp_active_set(S, lam * qs, cap, x)
        STATS["qp_solves"] += 1
        if not ok:
            break
        r = ratio(y)
        if r > best_r:
            best, best_r = y, r
        if np.abs(y - x).max() < 1e-12:
            converged = True
            break
        x = y
    if not converged:
        STATS["ratio_not_converged"] += 1
        best = spg(fg, best, cap, tol=1e-10)[0]
        best_r = ratio(best)
    return best, best_r * qmax / math.sqrt(np.mean(np.diag(sigma)))


def most_diversified(sigma: np.ndarray, cap: float, w0: np.ndarray | None = None) -> np.ndarray:
    """MDP (Choueifaty & Coignard, 2008): max DR = w'σ / √(w'Σw), σ_i = √Σ_ii."""
    return max_ratio(sigma, np.sqrt(np.diag(sigma)), cap, w0)[0]


def tangency(sigma: np.ndarray, mu: np.ndarray, rf: float, cap: float, w0: np.ndarray | None = None) -> tuple[np.ndarray, bool]:
    """Tangency portfolio: max (w'μ − r_f) / √(w'Σw), long-only, Σw = 1.

    Under full investment w'μ − r_f = w'(μ − r_f 1). When no feasible portfolio
    has a positive expected excess return the tangency portfolio does not exist
    (the slope of the capital allocation line would be negative); the strategy
    then holds the GMV portfolio and the date is flagged (returned True)."""
    w, r = max_ratio(sigma, mu - rf, cap, w0)
    if not (r > 0):
        return gmv(sigma, cap), True
    return w, False


def frontier(sigma: np.ndarray, mu: np.ndarray, cap: float, n_points: int = 30) -> list[tuple[float, float]]:
    """Constrained (long-only, capped) mean-variance frontier, ex ante.

    Points are exact solutions of min ½w'Σw − λ w'μ over the capped simplex for
    a geometric grid of λ ≥ 0 (λ = 0 is the GMV portfolio), which traces the
    efficient branch from the GMV to the maximum-mean portfolio. Returns the
    (σ, μ) pairs, per month, sorted by risk."""
    n = sigma.shape[0]
    m = np.mean(np.diag(sigma))
    S = sigma / m
    mu_s = mu / max(np.abs(mu).max(), 1e-300)
    w = gmv(sigma, cap)
    pts = [(math.sqrt(float(w @ sigma @ w)), float(w @ mu))]
    for lam in np.geomspace(1e-3, 1e3, n_points):
        w, ok = qp_active_set(S, lam * mu_s, cap, w)
        if ok:
            pts.append((math.sqrt(float(w @ sigma @ w)), float(w @ mu)))
    pts.sort()
    eff, best = [], -np.inf
    for sd, mm in pts:
        if mm > best + 1e-14:
            eff.append((sd, mm))
            best = mm
    return eff


def inverse_volatility(sigma: np.ndarray) -> np.ndarray:
    """IVP: w_i = (1/σ_i) / Σ_j (1/σ_j)."""
    iv = 1 / np.sqrt(np.diag(sigma))
    return iv / iv.sum()


def equal_risk_contribution(sigma: np.ndarray, tol: float = 1e-12, max_iter: int = 200) -> np.ndarray:
    """ERC (Maillard, Roncalli & Teïletche, 2010): w_i (Σw)_i equal for all i.

    Convention: equal contributions to the portfolio variance, which is the
    same as equal contributions to the volatility, because RC_i^σ = w_i (Σw)_i / σ_p
    = RC_i^{σ²} / σ_p. Solved by damped Newton iterations on the strictly convex
    problem min F(y) = ½ y'Σy − (1/N) Σ ln y_i, y > 0 (Spinu, 2013); its unique
    solution normalised to Σw = 1 is the ERC portfolio."""
    n = sigma.shape[0]
    scale = 1.0 / np.mean(np.diag(sigma))
    S = sigma * scale
    b = np.full(n, 1.0 / n)
    y = 1 / np.sqrt(np.diag(S))
    y /= math.sqrt(y @ S @ y)

    def F(z):
        return 0.5 * float(z @ S @ z) - float(b @ np.log(z))

    for _ in range(max_iter):
        g = S @ y - b / y
        H = S + np.diag(b / y**2)
        d = -np.linalg.solve(H, g)
        dec = float(-g @ d)
        if np.abs(g * y).max() < tol or dec / 2 < 1e-30:
            break
        t = 1.0
        while np.any(y + t * d <= 0):
            t *= 0.5
        f0 = F(y)
        while F(y + t * d) > f0 - 0.25 * t * dec and t > 1e-12:
            t *= 0.5
        y = y + t * d
    return y / y.sum()


def _erc_fixed(sigma: np.ndarray, fixed: np.ndarray, cap: float, w_start: np.ndarray) -> tuple[np.ndarray, bool]:
    """Weights with w_i = cap on `fixed` and equal risk contributions
    w_i (Σw)_i = λ on the other assets, Σw = 1.

    For λ0 > 0, z(λ0) = argmin_z ½ w'Σw − λ0 Σ_free ln z_i (w = z on free assets,
    cap on fixed ones) is a strictly convex problem whose first-order condition
    is z_i (Σw)_i = λ0 for every free asset (damped Newton, warm-started). The
    budget Σ z(λ0) increases with λ0, and λ0 is found by safeguarded regula
    falsi (Illinois) on ln Σ z(e^ν) − ln(1 − cap·#fixed). Returns (w, converged)."""
    S = sigma / np.mean(np.diag(sigma))
    free = ~fixed
    budget = 1.0 - cap * fixed.sum()
    Sff = S[np.ix_(free, free)]
    base = S[np.ix_(free, fixed)] @ np.full(int(fixed.sum()), cap) if fixed.any() else np.zeros(int(free.sum()))

    def inner(lam: float, z: np.ndarray) -> np.ndarray:
        for _ in range(200):
            g = Sff @ z + base - lam / z
            if np.abs(g * z).max() < 1e-13 * lam:
                break
            d = -np.linalg.solve(Sff + np.diag(lam / z**2), g)
            t = 1.0
            while np.any(z + t * d <= 0):
                t *= 0.5
            # the objective is convex and self-concordant: a damped step suffices
            dec = float(np.sqrt(max(-(g @ d), 0.0)))
            if dec > 0.25 and t == 1.0:
                t = 1.0 / (1.0 + dec)
            z = z + t * d
        return z

    z = np.maximum(np.asarray(w_start, float)[free], 1e-12)
    z *= budget / z.sum()
    w = np.zeros(sigma.shape[0])
    w[fixed] = cap
    w[free] = z
    nu = math.log(max(float(np.mean(z * (S @ w)[free])), 1e-300))

    def f(nu_: float, z_: np.ndarray) -> tuple[float, np.ndarray]:
        lam_ = math.exp(min(max(nu_, -700.0), 700.0))
        with np.errstate(all="ignore"):
            zz = inner(lam_, z_)
        if not np.isfinite(zz).all() or zz.min() <= 0:
            raise FloatingPointError("inner problem failed")
        return math.log(zz.sum()) - math.log(budget), zz

    try:
        return _regula_falsi(f, nu, z, w, free)
    except (FloatingPointError, np.linalg.LinAlgError, ZeroDivisionError, OverflowError):
        return w / w.sum(), False


def _regula_falsi(f, nu: float, z: np.ndarray, w: np.ndarray, free: np.ndarray) -> tuple[np.ndarray, bool]:
    """Root of the increasing function f(ν) (Illinois method), see _erc_fixed."""
    fa, z = f(nu, z)
    a, zb = nu, z
    b, step = nu, 1.0
    fb = fa
    while fa * fb > 0:  # bracket the root
        b = b - step if fa > 0 else b + step
        fb, zb = f(b, zb)
        step *= 2
        if step > 1e4:
            return w, False
    side = 0
    za = z
    for _ in range(200):
        c = b - fb * (b - a) / (fb - fa)
        fc, zc = f(c, za if abs(c - a) < abs(c - b) else zb)
        if abs(fc) < 1e-13:
            w[free] = zc
            return w / w.sum(), True
        if fc * fb < 0:
            a, fa, za = b, fb, zb
            side = 0
        else:
            if side == 1:
                fa /= 2
            side = 1
        b, fb, zb = c, fc, zc
    w[free] = zb
    return w / w.sum(), False


def erc_capped(sigma: np.ndarray, cap: float) -> tuple[np.ndarray, int]:
    """ERC under a weight cap (risk budgeting with bounds).

    Without a binding cap this is the ERC portfolio. Otherwise the solution
    satisfies the KKT conditions of the bounded problem: assets at the cap have
    a risk contribution not larger than the common contribution λ of all the
    other assets, which are exactly equal (Richard & Roncalli, 2019, use the
    same characterisation). Active set: assets above the cap are fixed at the
    cap, assets at the cap whose contribution exceeds λ are released, until both
    conditions hold. Returns (weights, number of capped assets); −1 signals a
    numerical failure, in which case the proportionally capped ERC is returned."""
    n = sigma.shape[0]
    w = equal_risk_contribution(sigma)
    if cap >= 1 or w.max() <= cap + 1e-12:
        return w, 0
    w_erc = w.copy()
    fixed = w > cap
    ok = True
    for _ in range(n):
        w, ok = _erc_fixed(sigma, fixed, cap, w)
        if not ok:
            break
        rc = w * (sigma @ w)
        lam = float(np.mean(rc[~fixed]))
        over = ~fixed & (w > cap + 1e-12)
        if over.any():
            fixed |= over
            continue
        excess = np.where(fixed, rc - lam, -np.inf)
        j = int(np.argmax(excess))
        if fixed.any() and excess[j] > 1e-10 * lam:
            fixed[j] = False
            continue
        break
    if not ok or not np.isfinite(w).all():
        # numerical failure (seen only with singular sample covariances): fall back to the
        # proportional cap of the ERC weights, counted and reported in the manifest
        STATS["erc_fallback"] += 1
        w = apply_cap(w_erc, cap)
        return w, -1
    w = np.clip(w, 0.0, cap)
    return w / w.sum(), int(fixed.sum())


def risk_contributions(w: np.ndarray, sigma: np.ndarray) -> np.ndarray:
    """Shares of the portfolio variance: RC_i = w_i (Σw)_i / w'Σw (sum to 1)."""
    m = sigma @ w
    v = float(w @ m)
    return w * m / v
