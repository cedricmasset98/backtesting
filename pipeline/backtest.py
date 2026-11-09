"""Walk-forward backtest.

Decision at the end of month t (information set: data up to and including t):
  1. the eligible universe E_t is determined (data.eligibility);
  2. Σ_t and μ_t are estimated on the `window` monthly returns ending at t;
  3. target weights are computed;
  4. they earn the returns of month t+1 (and drift until the next rebalancing).

Weights computed at t are therefore never applied to a return observed at or
before t. Weights are computed every month once per (window, covariance, cap),
and reused by the monthly, quarterly and annual schedules: a quarterly
portfolio simply ignores the decisions taken outside quarter-ends.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import config as C
from . import estimators as E
from . import optimizers as O
from .data import Panel

OPTIMISED = ["EW", "GMV", "ERC", "TP", "MDP", "IVP", "TP_SAMPLE"]


@dataclass
class Decision:
    idx: np.ndarray                      # column indices (in panel.codes) of the eligible stocks
    weights: dict[str, np.ndarray]       # strategy -> weights on idx
    sigma: np.ndarray                    # covariance used (monthly)
    mu_bs: np.ndarray                    # Bayes-Stein expected returns (monthly)
    rf: float
    shrinkage: float | None
    bs_phi: float
    tp_fallback: bool
    tp_sample_fallback: bool
    exante: dict[str, dict] = field(default_factory=dict)  # strategy -> ex ante statistics


@dataclass
class WeightsRun:
    window: int
    cov: str
    cap: float
    t0: int                               # index (in panel.months) of the first decision
    decisions: dict[int, Decision] = field(default_factory=dict)


def first_decision(n_eligible: pd.Series, rf: pd.Series, spi: pd.Series) -> pd.Period | None:
    ok = (n_eligible >= C.MIN_UNIVERSE) & n_eligible.index.isin(rf.index) & n_eligible.index.isin(spi.index)
    return n_eligible.index[ok.to_numpy()].min() if ok.any() else None


def compute_weights(panel: Panel, elig: pd.DataFrame, window: int, cov: str, cap_key: str, rf: pd.Series,
                    spi: pd.Series, keep_sigma_months: set[pd.Period] | None = None) -> WeightsRun:
    """Target weights of every strategy at every month-end from the first
    feasible decision date (≥ MIN_UNIVERSE eligible stocks) to the last month."""
    cap = C.CAPS[cap_key]
    months = panel.months
    n_el = elig.sum(axis=1)
    start = first_decision(n_el, rf, spi)
    run = WeightsRun(window, cov, cap, months.get_loc(start) if start is not None else len(months))
    if start is None:
        return run
    R = panel.r_est.to_numpy()
    E_ = elig.to_numpy()
    rf_f = rf.reindex(months).ffill()
    prev: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for k in range(run.t0, len(months)):
        idx = np.flatnonzero(E_[k])
        if idx.size < C.MIN_UNIVERSE:
            continue
        x = R[k - window + 1:k + 1][:, idx]
        if np.isnan(x).any():  # cannot happen: eligibility requires a complete window
            raise AssertionError(f"Missing return in the estimation window at {months[k]}.")
        sigma, delta = E.covariance(x, cov)
        lw = sigma if cov == "lw" else E.ledoit_wolf_cc(x)[0]
        mu_bs, phi = E.bayes_stein_mean(x, lw)
        mu_s = x.mean(axis=0)
        rf_k = float(rf_f.iloc[k])

        def warm(name: str) -> np.ndarray | None:
            if name not in prev:
                return None
            pidx, pw = prev[name]
            w = np.zeros(idx.size)
            pos = np.searchsorted(idx, pidx)
            ok = (pos < idx.size) & (idx[np.minimum(pos, idx.size - 1)] == pidx)
            w[pos[ok]] = pw[ok]
            return w if w.sum() > 0 else None

        n = idx.size
        w = {
            "EW": O.apply_cap(np.full(n, 1.0 / n), cap),
            "IVP": O.apply_cap(O.inverse_volatility(sigma), cap),
            "ERC": O.apply_cap(O.equal_risk_contribution(sigma), cap),
            "GMV": O.gmv(sigma, cap, warm("GMV")),
            "MDP": O.most_diversified(sigma, cap, warm("MDP")),
        }
        w["TP"], fb = O.tangency(sigma, mu_bs, rf_k, cap, warm("TP"))
        w["TP_SAMPLE"], fbs = O.tangency(sigma, mu_s, rf_k, cap, warm("TP_SAMPLE"))
        for name, v in w.items():
            v = np.where(v < 1e-10, 0.0, v)
            w[name] = v / v.sum()
            prev[name] = (idx, w[name])
        keep = keep_sigma_months is None or months[k] in keep_sigma_months
        dec = Decision(idx, w, sigma, mu_bs, rf_k, delta, phi, fb, fbs)
        dec.exante = {name: ex_ante(dec, name) for name in w}
        if not keep:
            dec.sigma, dec.mu_bs = np.empty((0, 0)), np.empty(0)
        run.decisions[k] = dec
    return run


def rebalance_months(months: pd.PeriodIndex, freq: str) -> np.ndarray:
    step = C.FREQS[freq]
    return np.array([m.month % step == 0 for m in months])


@dataclass
class SimResult:
    gross: np.ndarray        # holding-month returns (index = month of the return)
    turnover: np.ndarray     # traded fraction at the start of the month (end of previous month)
    rebalanced: np.ndarray   # bool: a scheduled rebalancing took place at the start of the month
    n_pos: np.ndarray
    eff_n: np.ndarray
    max_w: np.ndarray
    top10: np.ndarray
    exits: int               # positions liquidated after a delisting


def simulate(run: WeightsRun, strategy: str, freq: str, panel: Panel) -> SimResult:
    """Holding-period returns with weight drift between rebalancing dates.

    * At a scheduled rebalancing date the portfolio is traded to the target
      weights; turnover = Σ|w_target − w_before| (one-way, fraction of wealth).
    * Between rebalancing dates weights drift: w_i ← w_i (1 + r_i)/(1 + r_p).
    * A held stock whose listing ends is liquidated at its last observed price
      (zero return afterwards); the proceeds are reinvested pro rata in the other
      holdings at the next month-end and the trade counts in turnover.
    * Transaction costs are not applied here: net returns are computed from
      gross returns and turnover (costs.py / the browser), which is exact for
      proportional costs.
    """
    months = panel.months
    T = len(months)
    N = len(panel.codes)
    rv = panel.r_val.reindex(columns=panel.codes).to_numpy()
    last_idx = np.array([months.get_loc(panel.last_month[c]) for c in panel.codes])
    sched = rebalance_months(months, freq)
    out = SimResult(*(np.full(T, np.nan) for _ in range(2)), np.zeros(T, bool), *(np.full(T, np.nan) for _ in range(4)), 0)
    post: np.ndarray | None = None
    for k in range(run.t0, T - 1):
        dec = run.decisions.get(k)
        scheduled = k == run.t0 or sched[k]
        if scheduled and dec is not None:
            target = np.zeros(N)
            target[dec.idx] = dec.weights[strategy]
        elif post is not None:
            target = post.copy()
            gone = (last_idx < k + 1) & (target > 0)  # listing ended: last price at or before month k
            if gone.any():
                out.exits += int(gone.sum())
                target[gone] = 0.0
            target /= target.sum()
        else:
            continue
        out.turnover[k + 1] = 0.0 if post is None else float(np.abs(target - post).sum())
        out.rebalanced[k + 1] = bool(scheduled and dec is not None)
        r = rv[k + 1]
        held = target > 0
        rh = np.where(np.isnan(r[held]), 0.0, r[held])  # no price after the last one: liquidated value
        rp = float(target[held] @ rh)
        out.gross[k + 1] = rp
        post = np.zeros(N)
        post[held] = target[held] * (1 + rh) / (1 + rp)
        w = target[held]
        out.n_pos[k + 1] = held.sum()
        out.eff_n[k + 1] = 1.0 / float((w**2).sum())
        out.max_w[k + 1] = w.max()
        out.top10[k + 1] = np.sort(w)[::-1][:10].sum()
    return out


def ex_ante(dec: Decision, strategy: str) -> dict:
    """Ex ante statistics of a decision (monthly units): volatility √(w'Σw),
    Bayes-Stein expected return w'μ, diversification ratio w'σ/√(w'Σw), largest
    share of variance contributed by one stock, and effective number of risk
    contributions 1/Σ RC_i² (RC_i = w_i (Σw)_i / w'Σw)."""
    w = dec.weights[strategy]
    vol = math.sqrt(float(w @ dec.sigma @ w))
    rc = O.risk_contributions(w, dec.sigma)
    dr = float(w @ np.sqrt(np.diag(dec.sigma))) / vol
    return {"vol": vol, "mu": float(w @ dec.mu_bs), "dr": dr, "max_rc": float(rc.max()), "eff_rc": float(1 / (rc**2).sum())}


def net_returns(gross: np.ndarray, turnover: np.ndarray, bps: float) -> np.ndarray:
    """Net returns with proportional transaction costs of `bps` basis points
    per unit of traded value: wealth is reduced by c·TO_t at the rebalancing
    date, then earns the gross return: 1 + r_net = (1 − c·TO_t)(1 + r_gross).
    Exact because weights (hence turnover) do not depend on the cost level."""
    c = bps / 1e4
    to = np.where(np.isnan(turnover), 0.0, turnover)
    return (1 - c * to) * (1 + gross) - 1
