"""Loading and cleaning of the private market data (cedricmasset98/market-data).

Nothing in this module is published: it returns in-memory panels used by the
backtest. Only aggregated, derived results leave the pipeline (see build.py and
privacy.py).

Timing convention
-----------------
Months are pandas Periods. "Month t" means the information set at the close of
the last trading day of month t. A decision taken at t uses data up to and
including month t and is applied to the returns of month t+1 onwards.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as C


# ---------------------------------------------------------------- securities

def classify_securities(md: Path) -> pd.DataFrame:
    """One row per Swiss-listed ordinary share candidate with the decision taken.

    Columns: code, name, isin, delisted, included (bool), reason.
    """
    sym = pd.read_csv(md / "data/eodhd/SW/symbols.csv", dtype=str)
    sym = sym[sym["Type"].isin(["Common Stock", "Preferred Stock"])].copy()
    rows = []
    pat = re.compile("|".join(C.EXCLUDE_NAME_PATTERNS), re.IGNORECASE)
    for _, r in sym.iterrows():
        code, name, isin = r["Code"], str(r["Name"]), r["Isin"] if isinstance(r["Isin"], str) else ""
        reason = ""
        if r["Currency"] != "CHF":
            reason = f"traded in {r['Currency']} (not a CHF share line)"
        elif pat.search(name) or code.endswith("NE") and "LINIE" in name.upper():
            reason = "not an ordinary share (rights or second trading line)"
        elif isin and isin[:2] not in ("CH", "LI"):
            if code not in C.FOREIGN_PRIMARY_SIX:
                reason = f"foreign ISIN ({isin[:2]}): secondary listing"
        elif not isin and code in C.EXCLUDE_NO_ISIN:
            reason = C.EXCLUDE_NO_ISIN[code]
        rows.append({
            "code": code, "name": name, "isin": isin,
            "delisted": str(r["Delisted"]).lower() == "true",
            "included": reason == "", "reason": reason,
        })
    return pd.DataFrame(rows).sort_values("code").reset_index(drop=True)


# ------------------------------------------------------------- daily prices

@dataclass
class CleanLog:
    invalid_rows: int = 0
    spike_rows: int = 0
    break_rows: int = 0
    by_code: dict = field(default_factory=dict)


def _spike_mask(adj: np.ndarray) -> np.ndarray:
    """Rows belonging to a price spike that is undone within a few rows.

    A spike starts when the adjusted price is multiplied (or divided) by at least
    SPIKE_UP from one row to the next, and ends when the price comes back within
    ±SPIKE_TOL of the pre-spike level at most SPIKE_REVERT_DAYS rows later.
    """
    n = len(adj)
    bad = np.zeros(n, dtype=bool)
    i = 1
    while i < n:
        ratio = adj[i] / adj[i - 1]
        if ratio >= C.SPIKE_UP or ratio <= 1 / C.SPIKE_UP:
            base = adj[i - 1]
            for j in range(i + 1, min(n, i + 1 + C.SPIKE_REVERT_DAYS)):
                if abs(adj[j] / base - 1) <= C.SPIKE_TOL:
                    bad[i:j] = True
                    i = j
                    break
        i += 1
    return bad


def load_daily(md: Path, codes: list[str], log: CleanLog) -> dict[str, pd.DataFrame]:
    """Daily rows (date, close, adj, volume, spike).

    Two kinds of treatment, kept apart on purpose:
    * ex post corrections of vendor errors, applied once to the whole history
      and documented as a cleaning hypothesis: placeholder prices (row-local
      test, no look-ahead) and the history before an unreverted level break of
      ×LEVEL_BREAK (upwards, or downwards when the earlier segment is the
      shorter one), which by construction uses later rows;
    * point-in-time filters: one-day spikes that revert within
      SPIKE_REVERT_DAYS rows are only *flagged* (column `spike`). A spike is
      known once its reversal is observed, so monthly_panel uses the flag for
      months whose information set contains the reversal and keeps the raw
      price otherwise (see Panel.price_raw / r_last).
    Rows are removed or flagged, never filled."""
    out = {}
    for code in codes:
        f = md / "data/eodhd/SW/eod" / f"{code}.SW.csv.gz"
        if not f.exists() or f.stat().st_size == 0:
            continue
        d = pd.read_csv(f)
        if d.empty:
            continue
        d["date"] = pd.to_datetime(d["date"])
        d = d.sort_values("date").drop_duplicates("date", keep="last")
        ok = (d["close"] > C.PRICE_MIN) & (d["close"] < C.PRICE_MAX) & (d["adjusted_close"] > 0) & d["adjusted_close"].notna()
        n_bad = int((~ok).sum())
        d = d[ok]
        n_brk = 0
        if len(d) > 2:
            adj = d["adjusted_close"].to_numpy(float)
            ratio = adj[1:] / adj[:-1]
            for i in np.flatnonzero((ratio >= C.LEVEL_BREAK) | (ratio <= 1 / C.LEVEL_BREAK))[::-1]:
                earlier, later = i + 1, len(d) - i - 1
                if ratio[i] >= C.LEVEL_BREAK or earlier < later:
                    n_brk += earlier
                    d = d.iloc[i + 1:]
                    break
        d = d.copy()
        d["spike"] = _spike_mask(d["adjusted_close"].to_numpy(float)) if len(d) > 2 else np.zeros(len(d), bool)
        n_spk = int(d["spike"].sum())
        if n_bad or n_spk or n_brk:
            log.by_code[code] = {"invalid_rows": n_bad, "spike_rows": n_spk, "level_break_rows": n_brk}
        log.break_rows += n_brk
        log.invalid_rows += n_bad
        log.spike_rows += n_spk
        if len(d):
            out[code] = d[["date", "close", "adjusted_close", "volume", "spike"]].rename(columns={"adjusted_close": "adj"}).reset_index(drop=True)
    return out


def find_duplicates(sec: pd.DataFrame, daily: dict[str, pd.DataFrame]) -> list[dict]:
    """Same security listed under two tickers (renames): same ISIN and identical
    daily returns (|difference| < 1 bp) on at least DUP_MIN_IDENTICAL of the
    common dates. Price levels are not compared: EODHD adjusts the two tickers
    with different factors. Keep the active ticker,
    then the longest history (rule of market-data/scripts/panels.py)."""
    dups = []
    s = sec[sec["included"] & (sec["isin"] != "")]
    for isin, g in s.groupby("isin"):
        codes = [c for c in g["code"] if c in daily]
        if len(codes) < 2:
            continue
        order = sorted(codes, key=lambda c: (bool(g.set_index("code").loc[c, "delisted"]), -len(daily[c])))
        keep = order[0]
        for other in order[1:]:
            a = daily[keep].set_index("date")["adj"]
            b = daily[other].set_index("date")["adj"]
            common = a.index.intersection(b.index)
            ra, rb = a[common].pct_change().iloc[1:], b[common].pct_change().iloc[1:]
            same = float((np.abs(ra - rb) < 1e-4).mean()) if len(ra) else 0.0
            dups.append({"isin": isin, "kept": keep, "dropped": other, "common_days": int(len(common)),
                         "identical_return_share": round(same, 4),
                         "is_duplicate": bool(len(common) >= C.DUP_MIN_COMMON_DAYS and same >= C.DUP_MIN_IDENTICAL)})
    return dups


def find_cross_duplicates(sec: pd.DataFrame, daily: dict[str, pd.DataFrame], exclude: set[str]) -> list[dict]:
    """Tickers with different (or missing) ISINs but the same monthly return
    history: share of identical month-end returns (|difference| < 1e-6) of at
    least CROSS_DUP_MIN_IDENTICAL over at least CROSS_DUP_MIN_MONTHS common
    months. EODHD sometimes maps a renamed company, or a second share line, to
    the history of another ticker. Same keep rule as find_duplicates."""
    meta = sec.set_index("code")
    rets = {}
    for c, d in daily.items():
        if c in exclude:
            continue
        p = d.groupby(d["date"].dt.to_period("M"))["adj"].last()
        rets[c] = p / p.shift(1) - 1
    R = pd.DataFrame(rets)
    X = R.to_numpy()
    cols = list(R.columns)
    obs = ~np.isnan(X)
    out = []
    for i in range(len(cols)):
        for j in range(i + 1, len(cols)):
            m = obs[:, i] & obs[:, j]
            n = int(m.sum())
            if n < C.CROSS_DUP_MIN_MONTHS:
                continue
            share = float((np.abs(X[m, i] - X[m, j]) < 1e-6).mean())
            if share >= C.CROSS_DUP_MIN_IDENTICAL:
                a, b = cols[i], cols[j]
                keep, drop = sorted([a, b], key=lambda c: (bool(meta.loc[c, "delisted"]), -len(daily[c])))
                out.append({"kept": keep, "dropped": drop, "common_months": n, "identical_return_share": round(share, 4)})
    return out


# ------------------------------------------------------------ monthly panel

@dataclass
class Panel:
    months: pd.PeriodIndex            # all calendar months covered
    codes: list[str]
    names: dict[str, str]
    price: pd.DataFrame               # month-end adjusted close, spikes removed (ex post view)
    price_raw: pd.DataFrame           # month-end adjusted close as seen at that month-end (spike not yet revealed)
    r_gen: pd.DataFrame               # genuine monthly returns from `price` (both month-ends observed)
    r_last: pd.DataFrame              # return of month t as known at the end of t: price_raw[t] / price[t-1] - 1
    r_val: pd.DataFrame               # valuation returns during the listing life (stale months = 0)
    alive: pd.DataFrame               # bool: traded close to month-end
    liquid: pd.DataFrame              # bool: liquidity screens at month-end
    observed: pd.DataFrame            # bool: at least one price in the month (known at month-end)
    last_month: dict[str, pd.Period]  # last month with a valid price (end of life, used for valuation only)
    flagged_reversals: int            # ex post count of Ince-Porter reversals (information)

    @property
    def r_est(self) -> pd.DataFrame:  # backwards-compatible name
        return self.r_gen


def monthly_panel(daily: dict[str, pd.DataFrame], names: dict[str, str], last_complete: pd.Period) -> Panel:
    codes = sorted(daily)
    first = min(d["date"].min() for d in daily.values()).to_period("M")
    months = pd.period_range(first, last_complete, freq="M")
    month_end = months.to_timestamp(how="end").normalize()
    price, praw, alive, liquid, rval = {}, {}, {}, {}, {}
    last_month = {}
    for c in codes:
        d = daily[c]
        d = d[d["date"].dt.to_period("M") <= last_complete]
        if d.empty:
            continue
        if "spike" not in d:
            d = d.assign(spike=False)
        per = d["date"].dt.to_period("M")
        g = d.groupby(per)
        p_raw = g["adj"].last().reindex(months)
        clean = d[~d["spike"].to_numpy(bool)]
        p = clean.groupby(clean["date"].dt.to_period("M"))["adj"].last().reindex(months)
        last_date = g["date"].max().reindex(months)
        traded = d[d["volume"] > 0]
        last_trade = traded.groupby(traded["date"].dt.to_period("M"))["date"].max().reindex(months)
        gap_ok = (pd.Series(month_end, index=months) - last_trade).dt.days <= C.STALE_MAX_DAYS
        alive[c] = p_raw.notna() & last_date.notna() & gap_ok.fillna(False)
        # liquidity: trailing LIQ_LOOKBACK_DAYS rows ending at the last row of each month
        dd = pd.DataFrame({
            "per": per.to_numpy(),
            "med": (d["close"] * d["volume"]).rolling(C.LIQ_LOOKBACK_DAYS, min_periods=C.LIQ_LOOKBACK_DAYS // 2).median().to_numpy(),
            "zsh": (d["volume"] <= 0).astype(float).rolling(C.LIQ_LOOKBACK_DAYS, min_periods=C.LIQ_LOOKBACK_DAYS // 2).mean().to_numpy(),
        })
        lastrow = dd.groupby("per").nth(-1).set_index("per")
        ok = (lastrow["med"] >= C.LIQ_MIN_MEDIAN_VALUE) & (lastrow["zsh"] <= C.LIQ_MAX_ZERO_VOLUME)
        liquid[c] = ok.reindex(months).fillna(False).astype(bool)
        price[c] = p
        praw[c] = p_raw
        lastm = p.last_valid_index()
        firstm = p.first_valid_index()
        if lastm is None:
            continue
        last_month[c] = lastm
        pff = p.copy()
        pff.loc[firstm:lastm] = pff.loc[firstm:lastm].ffill()
        rv = pff / pff.shift(1) - 1
        rv.loc[:firstm] = np.nan
        rval[c] = rv
    price = pd.DataFrame(price)[list(rval)]
    praw = pd.DataFrame(praw)[list(rval)]
    r_gen = (price / price.shift(1) - 1).where(price.notna() & price.shift(1).notna())
    r_last = (praw / price.shift(1) - 1).where(praw.notna() & price.shift(1).notna())
    nxt = r_gen.shift(-1)
    rev = (r_gen > C.REVERSAL_UP) & ((1 + r_gen) * (1 + nxt) - 1 < C.REVERSAL_TWO_MONTH)
    return Panel(months, list(price.columns), names, price, praw, r_gen, r_last, pd.DataFrame(rval),
                 pd.DataFrame(alive)[list(rval)].fillna(False).astype(bool),
                 pd.DataFrame(liquid).reindex(months)[list(rval)].fillna(False).astype(bool),
                 praw.notna(), last_month, int(rev.to_numpy().sum()))


def estimation_window(panel: Panel, k: int, window: int) -> np.ndarray | None:
    """Monthly returns usable at the decision taken at the end of month k
    (window × stocks), built only from information available at that date.

    * months k−window+1 … k−1: genuine returns from spike-cleaned prices (every
      spike in those months has reverted by the end of month k, because a
      reversal takes at most SPIKE_REVERT_DAYS trading days);
    * month k: price_raw[k] / price[k−1] − 1, i.e. the month-end price as it was
      published at k, even if a later reversal will reveal a vendor error;
    * Ince & Porter (2006) reversal flag, evaluated causally: r_s is unusable
      when r_s > REVERSAL_UP and (1 + r_s)(1 + r_{s+1}) − 1 < REVERSAL_TWO_MONTH
      with s + 1 ≤ k; both months are then set missing.
    Missing values are NaN (never filled). None if the history is too short."""
    if k - window < 0:
        return None
    R = panel.r_gen.to_numpy()
    full = np.vstack([R[k - window:k], panel.r_last.to_numpy()[k][None, :]])  # rows: months k−window … k
    with np.errstate(invalid="ignore"):
        rev = (full[:-1] > C.REVERSAL_UP) & ((1 + full[:-1]) * (1 + full[1:]) - 1 < C.REVERSAL_TWO_MONTH)
    bad = np.zeros_like(full, dtype=bool)
    bad[:-1] |= rev
    bad[1:] |= rev
    full = np.where(bad, np.nan, full)
    return full[1:]


def eligibility(panel: Panel, window: int) -> pd.DataFrame:
    """Point-in-time eligibility (bool, months × codes) for a given window.

    Uses only information available at the end of month t: listed and traded
    near month-end, liquidity screens on trailing data, and a complete window of
    `window` monthly returns ending at t as returned by estimation_window (no
    missing value allowed, no filling). A stock that enters the market therefore
    becomes eligible once its history covers the whole window.
    """
    T, N = len(panel.months), len(panel.codes)
    complete = np.zeros((T, N), dtype=bool)
    for k in range(window, T):
        W = estimation_window(panel, k, window)
        complete[k] = ~np.isnan(W).any(axis=0)
    out = panel.alive.to_numpy() & panel.liquid.to_numpy() & complete
    return pd.DataFrame(out, index=panel.months, columns=panel.codes)


# ------------------------------------------------------------- market series

def _month_end_series(f: Path, col: str = "adjusted_close") -> pd.Series:
    d = pd.read_csv(f, parse_dates=["date"])
    d = d[d[col] > 0]
    return d.groupby(d["date"].dt.to_period("M"))[col].last()


def last_complete_month(md: Path) -> pd.Period:
    """Last month whose final business day is in the data (SPI as the clock)."""
    d = pd.read_csv(md / "data/eodhd/INDX/eod/SSHI.INDX.csv.gz", parse_dates=["date"])
    last = d["date"].max()
    bme = (last + pd.offsets.BMonthEnd(0)).normalize()
    m = last.to_period("M")
    return m if last.normalize() >= bme else m - 1


def spi_returns(md: Path) -> pd.Series:
    p = _month_end_series(md / "data/eodhd/INDX/eod/SSHI.INDX.csv.gz", "close")
    return (p / p.shift(1) - 1).dropna().rename("SPI")


def usdchf_change(md: Path) -> pd.Series:
    p = _month_end_series(md / "data/eodhd/FOREX/eod/USDCHF.FOREX.csv.gz", "close")
    return (p / p.shift(1) - 1).dropna().rename("usdchf")


@dataclass
class RiskFree:
    series: pd.Series
    segments: list[dict]
    checks: dict


def risk_free(md: Path) -> RiskFree:
    """Monthly Swiss risk-free return (decimal), convention of Empirical-Asset-Pricing:

    * since Sep 2009: daily SARON fixing compounded over the calendar days of the
      month, ACT/360 (each fixing applies until the next one);
    * Jul 1999 – Aug 2009: month-end SARON of the previous month × days/360;
    * before: 3-month Confederation money-market debt register claims (GMBF) of the
      previous month-end × days/360.
    Previous-month rates are known at the start of the month (ex ante); the
    compounded SARON is a realised return. The splices are checked on overlaps.
    """
    daily = pd.read_csv(md / "data/snb/snbgwdzid/wide.csv", parse_dates=["Date"])
    col = [c for c in daily.columns if c.endswith("[SARON]")][0]
    s = daily.set_index("Date")[col].dropna() / 100
    cal = pd.date_range(s.index.min(), s.index.max(), freq="D")
    s = s.reindex(cal).ffill()
    comp = (1 + s / 360).groupby(s.index.to_period("M")).prod() - 1
    # drop first partial month and an incomplete last month
    first_full = (s.index.min() + pd.offsets.MonthBegin(1)).to_period("M")
    comp = comp[comp.index >= first_full]
    if s.index.max() < (s.index.max() + pd.offsets.MonthEnd(0)):
        comp = comp[comp.index < s.index.max().to_period("M")]
    mm = pd.read_csv(md / "data/snb/zimoma/wide.csv")
    mm.index = pd.PeriodIndex(mm["Date"], freq="M")
    saron_eom = mm[[c for c in mm.columns if c.endswith("[SARON]")][0]].dropna() / 100
    gmbf = mm[[c for c in mm.columns if c.endswith("[EG3M]")][0]].dropna() / 100

    def from_prev(rate: pd.Series) -> pd.Series:
        nxt = rate.copy()
        nxt.index = nxt.index + 1
        days = nxt.index.days_in_month
        return nxt * days / 360

    a = from_prev(saron_eom)
    b = from_prev(gmbf)
    out = comp.copy()
    seg = [{"start": str(comp.index.min()), "end": str(comp.index.max()), "method": "daily SARON compounded over the month (ACT/360)"}]
    early = a[a.index < comp.index.min()]
    out = pd.concat([early, out])
    seg.insert(0, {"start": str(early.index.min()), "end": str(early.index.max()), "method": "month-end SARON of the previous month × days/360"})
    older = b[b.index < out.index.min()]
    out = pd.concat([older, out]).sort_index()
    seg.insert(0, {"start": str(older.index.min()), "end": str(older.index.max()), "method": "3-month GMBF of the previous month-end × days/360"})

    def cmp(x: pd.Series, y: pd.Series) -> dict:
        i = x.index.intersection(y.index)
        return {"n": int(len(i)), "corr": float(np.corrcoef(x[i], y[i])[0, 1]), "mean_diff_annual": float(12 * (x[i] - y[i]).mean())}

    checks = {"saron_eom_vs_compounded": cmp(a, comp), "gmbf_vs_saron_eom": cmp(b, a)}
    return RiskFree(out.rename("rf"), seg, checks)


def jkp_factors_chf(md: Path, fx: pd.Series) -> tuple[pd.DataFrame, dict]:
    """Swiss JKP long-short factors converted from USD to CHF: F_CHF = F_USD (1 + s),
    s = monthly change of USD/CHF. Months with fewer than JKP_MIN_STOCKS stocks in
    a factor are set missing (not filled)."""
    raw = pd.read_csv(md / "data/jkp/che_all_factors.csv")
    out, info = {}, {}
    for key, (code, label) in C.JKP_FACTORS.items():
        g = raw[(raw["name"] == code) & (raw["weighting"] == "vw_cap")].copy()
        g.index = pd.PeriodIndex(pd.to_datetime(g["date"]), freq="M")
        r = g["ret"].where(g["n_stocks"] >= C.JKP_MIN_STOCKS)
        common = r.index.intersection(fx.index)
        out[key] = (r[common] * (1 + fx[common])).astype(float)
        v = out[key].dropna()
        info[key] = {"jkp_characteristic": code, "label": label, "first": str(v.index.min()), "last": str(v.index.max()), "n": int(len(v))}
    return pd.DataFrame(out), info


def survivorship_coverage(sec: pd.DataFrame, daily: dict[str, pd.DataFrame]) -> dict:
    """Number of included delisted stocks by year of their last price. A year is
    considered covered once it holds at least SURVIVORSHIP_MIN_DELISTINGS
    delistings; the first covered year starts the survivorship-controlled sample."""
    years: dict[int, int] = {}
    for _, r in sec[sec["included"] & sec["delisted"]].iterrows():
        if r["code"] in daily:
            y = int(daily[r["code"]]["date"].max().year)
            years[y] = years.get(y, 0) + 1
    covered = sorted(y for y, n in years.items() if n >= C.SURVIVORSHIP_MIN_DELISTINGS)
    first = covered[0] if covered else None
    return {"delistings_by_year": dict(sorted(years.items())), "first_covered_year": first}
