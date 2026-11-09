"""Automatic checks that the published files contain derived results only.

The EODHD licence forbids redistributing raw prices. The public site therefore
receives portfolio-level results, never individual price or volume series.
This module fails the build when:
  * a file outside the expected set is present in the output directory;
  * a JSON key that denotes raw market data appears (close, volume, …);
  * a holdings snapshot lists more than its top 10 positions (full weight
    vectors of many portfolios would allow solving for individual returns);
  * any published strategy return series coincides with the monthly return of
    a single stock during 12 or more consecutive months.
It also reports, without failing, the number of portfolio-months with fewer
than three holdings (a one-stock month reveals that stock's monthly return,
which is a derived figure, not a price).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

FORBIDDEN_KEYS = {"open", "high", "low", "close", "adjusted_close", "adj", "volume", "price", "prices", "eod"}
ALLOWED = ("manifest.json", "market.json", "strategies/", "holdings/", "frontier/", "monkeys/")
MAX_TOP = 10
RUN = 12


def _keys(obj, path=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k, path
            yield from _keys(v, f"{path}/{k}")
    elif isinstance(obj, list) and obj and isinstance(obj[0], (dict, list)):
        for v in obj:
            yield from _keys(v, path)


def _max_equal_run(a: np.ndarray, b: np.ndarray, tol: float = 1e-8) -> int:
    eq = np.isfinite(a) & np.isfinite(b) & (np.abs(a - b) < tol)
    best = cur = 0
    for v in eq:
        cur = cur + 1 if v else 0
        best = max(best, cur)
    return best


def check_outputs(out: Path, panel) -> dict:
    problems: list[str] = []
    files = sorted(p for p in out.rglob("*") if p.is_file())
    thin_months = 0
    max_run = 0
    rv = panel.r_val
    for p in files:
        rel = p.relative_to(out).as_posix()
        if not rel.startswith(ALLOWED):
            problems.append(f"unexpected file {rel}")
            continue
        obj = json.loads(p.read_text(encoding="utf-8"))
        for k, where in _keys(obj):
            if k.lower() in FORBIDDEN_KEYS:
                problems.append(f"{rel}: forbidden key '{k}' at {where or '/'}")
        if rel.startswith("holdings/"):
            for snap in obj["snapshots"]:
                for s, v in snap["strategies"].items():
                    if len(v["top"]) > MAX_TOP:
                        problems.append(f"{rel}: {snap['month']} {s} lists {len(v['top'])} positions")
        if rel.startswith("strategies/"):
            months = pd.PeriodIndex(obj["months"], freq="M")
            R = rv.reindex(months).to_numpy()
            for f, strat in obj["freqs"].items():
                for s, series in strat.items():
                    thin_months += sum(1 for n in series["n_pos"] if n is not None and n < 3)
                    g = np.array([np.nan if v is None else v for v in series["gross"]], float)
                    eq_any = np.abs(R - g[:, None]) < 1e-8
                    if eq_any.sum(axis=0).max(initial=0) < RUN:
                        continue
                    for j in np.flatnonzero(eq_any.sum(axis=0) >= RUN):
                        run = _max_equal_run(g, R[:, j])
                        max_run = max(max_run, run)
                        if run >= RUN:
                            problems.append(f"{rel}: {f}/{s} equals the return of {rv.columns[j]} for {run} consecutive months")
    return {
        "status": "ok" if not problems else "failed",
        "problems": problems[:50],
        "files_checked": len(files),
        "portfolio_months_with_fewer_than_3_holdings": thin_months,
        "longest_single_stock_match_months": max_run,
    }
