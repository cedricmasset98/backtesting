"""Synthetic panels for the tests (no private data needed)."""

from __future__ import annotations

import numpy as np
import pandas as pd

from pipeline.data import Panel


def synthetic_panel(n_stocks: int = 40, n_months: int = 120, seed: int = 0, start: str = "2000-01",
                    delist: dict[str, str] | None = None, list_from: dict[str, str] | None = None) -> Panel:
    """Stocks with factor-structured monthly returns. `delist` maps a code to
    its last month with a price; `list_from` to its first month."""
    rng = np.random.default_rng(seed)
    months = pd.period_range(start, periods=n_months, freq="M")
    codes = [f"S{i:03d}" for i in range(n_stocks)]
    mkt = rng.normal(0.006, 0.045, n_months)
    beta = rng.uniform(0.5, 1.5, n_stocks)
    idio = rng.uniform(0.03, 0.12, n_stocks)
    R = mkt[:, None] * beta[None, :] + rng.normal(0, 1, (n_months, n_stocks)) * idio[None, :] + 0.002
    R = pd.DataFrame(R, index=months, columns=codes)
    price = (1 + R).cumprod() * 100
    first = {c: months[0] for c in codes}
    last = {c: months[-1] for c in codes}
    for c, m in (list_from or {}).items():
        first[c] = pd.Period(m, "M")
    for c, m in (delist or {}).items():
        last[c] = pd.Period(m, "M")
    for c in codes:
        price.loc[(price.index < first[c]) | (price.index > last[c]), c] = np.nan
    r_gen = (price / price.shift(1) - 1).where(price.notna() & price.shift(1).notna())
    r_val = r_gen.copy()
    alive = price.notna()
    liquid = pd.DataFrame(True, index=months, columns=codes)
    return Panel(months, codes, {c: f"Stock {c}" for c in codes}, price, price.copy(), r_gen, r_gen.copy(), r_val, alive,
                 liquid, price.notna(), last, 0)


def random_cov(n: int, seed: int = 0, factor: float = 0.6) -> np.ndarray:
    rng = np.random.default_rng(seed)
    b = rng.uniform(0.5, 1.5, n)
    s = rng.uniform(0.04, 0.12, n)
    return factor * 0.002 * np.outer(b, b) + np.diag(s**2)
