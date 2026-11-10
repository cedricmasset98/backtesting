"""Malkiel's monkeys: 100 random portfolios.

Rules (documented in the interface):
  * at the first decision date each monkey draws K stocks uniformly without
    replacement from the eligible universe E_t of the same window as the
    strategies (same liquidity, history and listing screens), holds them with
    equal weights 1/K and lets the weights drift until the next rebalancing date;
  * mode "keep": at each rebalancing date the monkey keeps the stocks that are
    still eligible, replaces only those that left E_t by new random draws among
    the eligible stocks it does not hold, and restores equal weights;
  * mode "redraw": at each rebalancing date the monkey draws K new stocks;
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
from .backtest import _half_spread, rebalance_months
from .data import Panel


def draw(seed: int, monkey: int, month: pd.Period, eligible_idx: np.ndarray, k: int) -> np.ndarray:
    rng = np.random.default_rng([seed, monkey, month.year * 100 + month.month])
    pick = rng.choice(eligible_idx.size, size=min(k, eligible_idx.size), replace=False)
    return np.sort(eligible_idx[pick])


def replace(seed: int, monkey: int, month: pd.Period, held: np.ndarray, eligible_idx: np.ndarray, k: int) -> np.ndarray:
    """Mode "keep": eligible holdings are kept, the others are replaced by random
    draws among the eligible stocks not held (same generator rule as draw)."""
    keep = np.intersect1d(held, eligible_idx)
    pool = np.setdiff1d(eligible_idx, keep)
    need = min(k - keep.size, pool.size)
    if need <= 0:
        return keep
    rng = np.random.default_rng([seed, monkey, month.year * 100 + month.month])
    return np.sort(np.concatenate([keep, pool[rng.choice(pool.size, size=need, replace=False)]]))


def simulate_monkeys(panel: Panel, elig: pd.DataFrame, t0: int, freq: str, k: int, seed: int,
                     n_monkeys: int = C.N_MONKEYS, mode: str = "redraw") -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Returns (gross returns, turnover, spread cost), each of shape
    (n_monkeys, T); NaN before the first holding month."""
    months = panel.months
    T, N = len(months), len(panel.codes)
    rv = panel.r_val.reindex(columns=panel.codes).to_numpy()
    observed = panel.observed.reindex(columns=panel.codes).to_numpy()
    E_ = elig.reindex(columns=panel.codes).to_numpy()
    sched = rebalance_months(months, freq)
    gross = np.full((n_monkeys, T), np.nan)
    turn = np.full((n_monkeys, T), np.nan)
    spread = np.full((n_monkeys, T), np.nan)
    hs = _half_spread(panel)
    post = None
    for t in range(t0, T - 1):
        if t == t0 or sched[t]:
            idx = np.flatnonzero(E_[t])
            target = np.zeros((n_monkeys, N))
            for j in range(n_monkeys):
                if mode == "keep" and post is not None:
                    pick = replace(seed, j, months[t], np.flatnonzero(post[j] > 0), idx, k)
                else:
                    pick = draw(seed, j, months[t], idx, k)
                target[j, pick] = 1.0 / pick.size
        else:
            target = post.copy()
            gone = ~observed[t]
            target[:, gone] = 0.0
            tot = target.sum(axis=1, keepdims=True)
            target = np.divide(target, tot, out=np.zeros_like(target), where=tot > 0)  # all holdings gone: cash
        turn[:, t + 1] = 0.0 if post is None else np.abs(target - post).sum(axis=1)
        spread[:, t + 1] = 0.0 if post is None else np.abs(target - post) @ hs[t]
        r = np.where(np.isnan(rv[t + 1]), 0.0, rv[t + 1])
        rp = target @ r
        gross[:, t + 1] = rp
        post = target * (1 + r) / (1 + rp)[:, None]
    return gross, turn, spread
