"""Malkiel's monkeys: 100 random portfolios.

Rules (documented in the interface):
  * at every scheduled rebalancing date (and at the first decision date), each
    monkey draws K stocks uniformly without replacement from the eligible
    universe E_t of the same window as the strategies (same liquidity, history
    and listing screens), holds them with equal weights 1/K, and lets the
    weights drift until the next rebalancing date, when it draws again;
  * if fewer than K stocks are eligible, the monkey holds all of them;
  * the generator of monkey j at month t is numpy's PCG64 seeded with
    (seed, j, yyyymm): a draw depends only on the seed, the monkey, the date and
    E_t. It is reproducible and cannot change when later data change;
  * delistings and turnover are handled exactly as for the strategies.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import config as C
from .backtest import rebalance_months
from .data import Panel


def draw(seed: int, monkey: int, month: pd.Period, eligible_idx: np.ndarray, k: int) -> np.ndarray:
    rng = np.random.default_rng([seed, monkey, month.year * 100 + month.month])
    pick = rng.choice(eligible_idx.size, size=min(k, eligible_idx.size), replace=False)
    return np.sort(eligible_idx[pick])


def simulate_monkeys(panel: Panel, elig: pd.DataFrame, t0: int, freq: str, k: int, seed: int,
                     n_monkeys: int = C.N_MONKEYS) -> tuple[np.ndarray, np.ndarray]:
    """Returns (gross returns, turnover), each of shape (n_monkeys, T); NaN
    before the first holding month."""
    months = panel.months
    T, N = len(months), len(panel.codes)
    rv = panel.r_val.reindex(columns=panel.codes).to_numpy()
    last_idx = np.array([months.get_loc(panel.last_month[c]) for c in panel.codes])
    E_ = elig.reindex(columns=panel.codes).to_numpy()
    sched = rebalance_months(months, freq)
    gross = np.full((n_monkeys, T), np.nan)
    turn = np.full((n_monkeys, T), np.nan)
    post = None
    for t in range(t0, T - 1):
        if t == t0 or sched[t]:
            idx = np.flatnonzero(E_[t])
            target = np.zeros((n_monkeys, N))
            for j in range(n_monkeys):
                pick = draw(seed, j, months[t], idx, k)
                target[j, pick] = 1.0 / pick.size
        else:
            target = post.copy()
            gone = last_idx < t + 1
            target[:, gone] = 0.0
            target /= target.sum(axis=1, keepdims=True)
        turn[:, t + 1] = 0.0 if post is None else np.abs(target - post).sum(axis=1)
        r = np.where(np.isnan(rv[t + 1]), 0.0, rv[t + 1])
        rp = target @ r
        gross[:, t + 1] = rp
        post = target * (1 + r) / (1 + rp)[:, None]
    return gross, turn
