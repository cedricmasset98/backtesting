"""Reference values for tests/metrics.test.ts, computed with numpy/scipy.

    python tests/fixtures/make_metrics.py
"""
import json
from pathlib import Path

import numpy as np
from scipy import stats

rng = np.random.default_rng(42)
r = rng.normal(0.006, 0.045, 60)
rf = np.full(60, 0.001) + rng.normal(0, 0.0002, 60)
b = 0.7 * r + rng.normal(0.002, 0.02, 60)
ex, bex, act = r - rf, b - rf, r - b
v = 100 * np.cumprod(np.concatenate([[1], 1 + r]))
peak = np.maximum.accumulate(v)
q05, q01 = np.quantile(r, 0.05), np.quantile(r, 0.01)
dd = np.sqrt(np.mean(np.minimum(ex, 0) ** 2)) * np.sqrt(12)
ref = {
    "r": r.tolist(), "rf": rf.tolist(), "b": b.tolist(),
    "cagr": float((v[-1] / 100) ** (12 / 60) - 1), "cumulative": float(v[-1] / 100 - 1),
    "vol": float(r.std(ddof=1) * np.sqrt(12)), "meanLog": float(np.log1p(r).mean()),
    "maxDD": float((v / peak - 1).min()),
    "var95": float(-q05), "var99": float(-q01), "cvar95": float(-r[r <= q05].mean()), "cvar99": float(-r[r <= q01].mean()),
    "skew": float(stats.skew(r)), "exKurt": float(stats.kurtosis(r)),
    "sharpe": float(ex.mean() / ex.std(ddof=1) * np.sqrt(12)), "sortino": float(12 * ex.mean() / dd), "downsideDev": float(dd),
    "trackingError": float(act.std(ddof=1) * np.sqrt(12)), "infoRatio": float(12 * act.mean() / (act.std(ddof=1) * np.sqrt(12))),
    "beta": float(np.cov(ex, bex, ddof=1)[0, 1] / bex.var(ddof=1)), "seMean": float(r.std(ddof=1) / np.sqrt(60)),
    "posFreq": float((r > 0).mean()),
}
Path(__file__).with_name("metrics_reference.json").write_text(json.dumps(ref, indent=1))
print("written")
