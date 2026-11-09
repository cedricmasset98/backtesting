"""Reference regressions for the TypeScript engine (tests/statsmodels.test.ts).

    python -m pipeline.statsref            # statsmodels (CI); numpy/scipy fallback locally

Two datasets:
  * a synthetic dataset (fixed seed, 7 regressors with autocorrelated and
    heteroskedastic errors) — always available;
  * the published results (public/data), if present: the excess returns of
    every strategy of the default configuration (gross) regressed on the five
    factor models, with exactly the sample rule of the browser (months where
    the portfolio return, r_f and every factor of the model are available).
The output records which engine produced it; CI requires "statsmodels".
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import olsref

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "reference" / "statsmodels_factor.json"
DATA = Path(os.environ.get("OUT_DIR", ROOT / "public" / "data"))

MODELS = {
    "CAPM": ["MKT"],
    "FF3": ["MKT", "SMB", "HML"],
    "CARHART": ["MKT", "SMB", "HML", "MOM"],
    "FF5": ["MKT", "SMB", "HML", "RMW", "CMA"],
    "FF5MOM": ["MKT", "SMB", "HML", "RMW", "CMA", "MOM"],
}
COVS = ["classical", "HC3", "HAC"]

try:
    import statsmodels.api as sm
    from statsmodels.stats.diagnostic import acorr_ljungbox, het_breuschpagan
    from statsmodels.stats.stattools import jarque_bera

    ENGINE = "statsmodels"
except ImportError:  # local development without statsmodels
    sm = None
    ENGINE = "numpy"


def fit(y: np.ndarray, X: np.ndarray, cov: str) -> dict:
    n = len(y)
    lags = olsref.nw_lags(n)
    if sm is not None:
        m = sm.OLS(y, X)
        if cov == "classical":
            r = m.fit()
        elif cov == "HC3":
            r = m.fit(cov_type="HC3")
        else:
            r = m.fit(cov_type="HAC", cov_kwds={"maxlags": lags, "use_correction": False})
        ci = r.conf_int(0.05)
        out = {"beta": r.params.tolist(), "se": r.bse.tolist(), "stat": r.tvalues.tolist(), "pvalue": r.pvalues.tolist(),
               "ci_low": ci[:, 0].tolist(), "ci_high": ci[:, 1].tolist(), "r2": float(r.rsquared), "r2adj": float(r.rsquared_adj),
               "n": int(r.nobs), "hac_lags": lags if cov == "HAC" else None}
        if cov == "classical":
            e = r.resid
            lb = acorr_ljungbox(e, lags=[olsref.lb_lags(n)], return_df=True)
            bp = het_breuschpagan(e, X, robust=True)
            jb = jarque_bera(e)
            out["diagnostics"] = {"jb": [float(jb[0]), float(jb[1])], "bp": [float(bp[0]), float(bp[1])],
                                  "lb": [float(lb["lb_stat"].iloc[0]), float(lb["lb_pvalue"].iloc[0])], "lb_lags": olsref.lb_lags(n)}
        return out
    f = olsref.fit(y, X, cov, lags if cov == "HAC" else None)
    out = {"beta": f.params.tolist(), "se": f.se.tolist(), "stat": f.stat.tolist(), "pvalue": f.pvalue.tolist(),
           "ci_low": f.ci_low.tolist(), "ci_high": f.ci_high.tolist(), "r2": f.r2, "r2adj": f.r2adj, "n": f.n,
           "hac_lags": f.hac_lags}
    if cov == "classical":
        jb = olsref.jarque_bera(f.resid)
        bp = olsref.breusch_pagan(f.resid, X)
        lb = olsref.ljung_box(f.resid, olsref.lb_lags(n))
        out["diagnostics"] = {"jb": [jb[0], jb[1]], "bp": list(bp), "lb": list(lb), "lb_lags": olsref.lb_lags(n)}
    return out


def synthetic() -> dict:
    rng = np.random.default_rng(20261109)
    n = 240
    F = rng.normal(0, 0.04, size=(n, 6))
    F[:, 0] += 0.005
    e = np.zeros(n)
    for t in range(n):  # AR(1) errors with volatility clustering
        e[t] = (0.3 * e[t - 1] if t else 0) + rng.normal(0, 0.01 * (1 + abs(F[t, 0]) * 20))
    beta = np.array([0.001, 0.9, 0.3, -0.2, 0.15, 0.1, 0.05])
    y = beta[0] + F @ beta[1:] + e
    names = ["MKT", "SMB", "HML", "RMW", "CMA", "MOM"]
    data = {k: F[:, i].tolist() for i, k in enumerate(names)}
    cases = []
    for model, cols in MODELS.items():
        X = np.column_stack([np.ones(n)] + [F[:, names.index(c)] for c in cols])
        for cov in COVS:
            cases.append({"model": model, "cov": cov, **fit(y, X, cov)})
    return {"y": y.tolist(), "factors": data, "cases": cases}


def published() -> dict | None:
    man = DATA / "manifest.json"
    if not man.exists():
        return None
    m = json.loads(man.read_text())
    d = m["default"]
    key = f"L{d['window']}_{d['cov']}_cap{d['cap']}"
    strat = json.loads((DATA / "strategies" / f"{key}.json").read_text())
    mk = json.loads((DATA / "market.json").read_text())
    idx = {mo: i for i, mo in enumerate(mk["months"])}
    cases = []
    for s, series in strat["freqs"][d["freq"]].items():
        for model, cols in MODELS.items():
            rows = []
            for t, mo in enumerate(strat["months"]):
                g = series["gross"][t]
                i = idx.get(mo)
                if g is None or i is None or mk["rf"][i] is None:
                    continue
                fac = [mk["factors"][c][i] for c in cols]
                if any(v is None for v in fac):
                    continue
                rows.append((g - mk["rf"][i], fac))
            if len(rows) <= len(cols) + 1:
                continue
            y = np.array([r[0] for r in rows])
            X = np.column_stack([np.ones(len(rows)), np.array([r[1] for r in rows])])
            for cov in COVS:
                cases.append({"strategy": s, "model": model, "cov": cov, **fit(y, X, cov)})
    return {"config": key, "freq": d["freq"], "cases": cases}


def main() -> None:
    out = {"engine": ENGINE, "statsmodels_version": getattr(sm, "__version__", None) if sm else None,
           "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "conventions": {"hac": "Bartlett kernel, lags floor(4 (n/100)^(2/9)), no small-sample correction",
                           "ci_level": 0.95, "breusch_pagan": "Koenker (robust=True)"},
           "synthetic": synthetic(), "published": published()}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, allow_nan=False))
    n_pub = len(out["published"]["cases"]) if out["published"] else 0
    print(f"{OUT} written ({ENGINE}); synthetic cases {len(out['synthetic']['cases'])}, published cases {n_pub}.")
    if os.environ.get("STRICT_REFERENCE") == "1" and ENGINE != "statsmodels":
        raise SystemExit("STRICT_REFERENCE=1 but statsmodels is not installed.")
    if os.environ.get("REQUIRE_PUBLISHED") == "1" and out["published"] is None:
        raise SystemExit("REQUIRE_PUBLISHED=1 but public/data has not been built.")


if __name__ == "__main__":
    main()
