"""Private pipeline entry point: market-data → derived results in public/data.

    MARKET_DATA_DIR=../market-data python -m pipeline.build [--jobs 2] [--quick]

Only aggregated, derived results are written (portfolio returns, turnover,
statistics, top holdings, ex ante frontiers). privacy.py checks every output
before the build is declared successful. --quick restricts the grid (tests).
"""

from __future__ import annotations

import argparse
import json
import math
import multiprocessing as mp
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import backtest as B
from . import config as C
from . import data as D
from . import monkeys as MK
from . import optimizers as O
from . import privacy

# Shared state for worker processes (inherited through fork).
G: dict = {}


def r(x, nd: int = 9):
    """JSON-safe rounded float (None for NaN/inf)."""
    if x is None:
        return None
    x = float(x)
    return round(x, nd) if math.isfinite(x) else None


def arr(a, nd: int = 9) -> list:
    return [r(v, nd) for v in a]


def config_key(window: int, cov: str, cap: str) -> str:
    return f"L{window}_{cov}_cap{cap}"


# ------------------------------------------------------------------ loading

def load_all(md: Path) -> dict:
    t = time.time()
    sec = D.classify_securities(md)
    log = D.CleanLog()
    daily = D.load_daily(md, sec.loc[sec["included"], "code"].tolist(), log)
    dups = D.find_duplicates(sec, daily)
    dropped = {d["dropped"] for d in dups if d["is_duplicate"]}
    cross = D.find_cross_duplicates(sec, daily, dropped)
    for c in cross:
        if c["kept"] not in dropped:
            dropped.add(c["dropped"])
    no_data = sorted(set(sec.loc[sec["included"], "code"]) - set(daily))
    daily = {k: v for k, v in daily.items() if k not in dropped}
    last = D.last_complete_month(md)
    names = dict(zip(sec["code"], sec["name"]))
    panel = D.monthly_panel(daily, names, last)
    rf = D.risk_free(md)
    spi = D.spi_returns(md)
    fx = D.usdchf_change(md)
    factors, finfo = D.jkp_factors_chf(md, fx)
    surv = D.survivorship_coverage(sec, daily)
    elig = {L: D.eligibility(panel, L) for L in C.WINDOWS}
    return {
        "sec": sec, "log": log, "dups": dups, "cross": cross, "dropped": sorted(dropped), "no_data": no_data,
        "panel": panel, "rf": rf, "spi": spi, "fx": fx, "factors": factors, "finfo": finfo, "surv": surv,
        "elig": elig, "last": last, "load_seconds": time.time() - t,
        "data_last_date": str(max(d["date"].max() for d in daily.values()).date()),
    }


def snapshot_months(panel: D.Panel, t0: int) -> set:
    months = panel.months
    snaps = {m for m in months[t0:] if m.month == 12}
    snaps.add(months[-1])
    return snaps


# ------------------------------------------------------------- config jobs

def run_config(job: tuple[int, str, str]) -> dict:
    window, cov, cap_key = job
    t = time.time()
    O.STATS.update({k: 0 for k in O.STATS})
    panel: D.Panel = G["panel"]
    elig = G["elig"][window]
    rf, spi = G["rf"].series, G["spi"]
    n_el = elig.sum(axis=1)
    start = B.first_decision(n_el, rf, spi)
    t0 = panel.months.get_loc(start)
    snaps = snapshot_months(panel, t0)
    run = B.compute_weights(panel, elig, window, cov, cap_key, rf, spi, keep_sigma_months=snaps)
    months = panel.months
    T = len(months)
    ret_months = [str(m) for m in months[t0 + 1:T]]
    sl = slice(t0 + 1, T)
    freqs = {}
    exits = {}
    for f in C.FREQS:
        freqs[f] = {}
        for s in B.OPTIMISED:
            sim = B.simulate(run, s, f, panel)
            exits[f"{f}_{s}"] = sim.exits
            freqs[f][s] = {
                "gross": arr(sim.gross[sl], 10),
                "turnover": arr(sim.turnover[sl], 8),
                "spread": arr(sim.spread[sl], 8),
                "rebalanced": [int(v) for v in sim.rebalanced[sl]],
                "n_pos": [int(v) if np.isfinite(v) else None for v in sim.n_pos[sl]],
                "eff_n": arr(sim.eff_n[sl], 3),
                "max_w": arr(sim.max_w[sl], 6),
                "top10": arr(sim.top10[sl], 6),
            }
    dec_months = sorted(run.decisions)
    exante = {s: {k: [] for k in ("vol", "mu", "dr", "max_rc", "eff_rc")} for s in B.OPTIMISED}
    for k in dec_months:
        for s in B.OPTIMISED:
            for key, v in run.decisions[k].exante[s].items():
                exante[s][key].append(r(v, 8))
    decisions = {
        "months": [str(months[k]) for k in dec_months],
        "n_eligible": [int(run.decisions[k].idx.size) for k in dec_months],
        "shrinkage": [r(run.decisions[k].shrinkage, 6) for k in dec_months],
        "bs_phi": [r(run.decisions[k].bs_phi, 6) for k in dec_months],
        "rf": [r(run.decisions[k].rf, 10) for k in dec_months],
        "tp_fallback": [str(months[k]) for k in dec_months if run.decisions[k].tp_fallback],
        "tp_sample_fallback": [str(months[k]) for k in dec_months if run.decisions[k].tp_sample_fallback],
        "erc_capped": [run.decisions[k].erc_capped for k in dec_months],  # −1: numerical fallback (proportional cap)
        "exante": exante,
    }
    # top holdings and frontier snapshots (December decisions and the last one)
    holdings, frontiers = [], []
    names = panel.names
    codes = panel.codes
    for k in dec_months:
        if months[k] not in snaps:
            continue
        dec = run.decisions[k]
        snap = {"month": str(months[k]), "n_eligible": int(dec.idx.size), "strategies": {}}
        fr = {"month": str(months[k]), "rf": r(dec.rf, 10), "strategies": {}}
        for s in B.OPTIMISED:
            w = dec.weights[s]
            rc = O.risk_contributions(w, dec.sigma)
            order = np.argsort(-w)[:10]
            snap["strategies"][s] = {
                "top": [{"code": codes[dec.idx[i]], "name": names.get(codes[dec.idx[i]], codes[dec.idx[i]]),
                         "w": r(w[i], 6), "rc": r(rc[i], 6)} for i in order if w[i] > 0],
                "n_pos": int((w > 0).sum()),
                "top10_rc": r(rc[order].sum(), 6),
            }
            fr["strategies"][s] = [r(math.sqrt(float(w @ dec.sigma @ w)), 8), r(float(w @ dec.mu_bs), 8)]
        holdings.append(snap)
        pts = O.frontier(dec.sigma, dec.mu_bs, run.cap)
        fr["frontier"] = [[r(a, 8), r(b, 8)] for a, b in pts]
        # ex ante cloud of the 100 monkeys (K = 30, seed 1) drawn at this date
        cloud = []
        for j in range(C.N_MONKEYS):
            pick = MK.draw(1, j, months[k], dec.idx, 30)
            pos = np.searchsorted(dec.idx, pick)
            w = np.zeros(dec.idx.size)
            w[pos] = 1.0 / pos.size
            cloud.append([r(math.sqrt(float(w @ dec.sigma @ w)), 8), r(float(w @ dec.mu_bs), 8)])
        fr["monkeys"] = cloud
        frontiers.append(fr)
    key = config_key(window, cov, cap_key)
    out = {
        "key": key, "window": window, "cov": cov, "cap": cap_key, "cap_value": C.CAPS[cap_key],
        "first_decision": str(months[t0]), "months": ret_months, "freqs": freqs, "decisions": decisions,
    }
    meta = {"key": key, "window": window, "cov": cov, "cap": cap_key, "first_decision": str(months[t0]),
            "first_return": ret_months[0], "last_return": ret_months[-1], "n_decisions": len(dec_months),
            "tp_fallbacks": len(decisions["tp_fallback"]), "tp_sample_fallbacks": len(decisions["tp_sample_fallback"]),
            "exits": exits, "solver": dict(O.STATS), "seconds": round(time.time() - t, 1)}
    return {"key": key, "strategies": out, "holdings": {"key": key, "snapshots": holdings},
            "frontier": {"key": key, "cap_value": C.CAPS[cap_key], "snapshots": frontiers}, "meta": meta}


def run_monkeys(job: tuple[int, str, int, int, str]) -> dict:
    window, freq, k, seed, mode = job
    panel: D.Panel = G["panel"]
    elig = G["elig"][window]
    start = B.first_decision(elig.sum(axis=1), G["rf"].series, G["spi"])
    t0 = panel.months.get_loc(start)
    gross, turn, spread = MK.simulate_monkeys(panel, elig, t0, freq, k, seed, mode=mode)
    sl = slice(t0 + 1, len(panel.months))
    sc = 1e6

    def ints(a):
        return [[int(round(v * sc)) if np.isfinite(v) else 0 for v in row] for row in a[:, sl]]

    return {
        "key": monkeys_key(window, freq, k, seed, mode), "window": window, "freq": freq, "k": k, "seed": seed, "mode": mode,
        "months": [str(m) for m in panel.months[sl]],
        "scale": sc,
        # integers: returns, turnover and spread cost × 1e6 (compact, exact to 1e-6)
        "gross": ints(gross),
        "turnover": ints(turn),
        "spread": ints(spread),
    }


def monkeys_key(window: int, freq: str, k: int, seed: int, mode: str) -> str:
    return f"L{window}_{freq}_k{k}_s{seed}_{mode}"


# ------------------------------------------------------------------ writing

def _np_default(o):
    if isinstance(o, (np.integer, np.floating, np.bool_)):
        return o.item()
    raise TypeError(f"{type(o).__name__} is not JSON serialisable")


def write_json(path: Path, obj) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False, default=_np_default)
    path.write_text(txt, encoding="utf-8")
    return len(txt)


def market_json(g: dict) -> dict:
    months = pd.period_range(min(g["spi"].index.min(), g["rf"].series.index.min()), g["last"], freq="M")
    spi = g["spi"].reindex(months)
    rf = g["rf"].series.reindex(months)
    f = g["factors"].reindex(months)
    return {
        "months": [str(m) for m in months],
        "spi": arr(spi), "rf": arr(rf, 10),
        "factors": {"MKT": arr(spi - rf), **{k: arr(f[k]) for k in C.JKP_FACTORS}},
    }


def git_commit(path: Path) -> str | None:
    try:
        return subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    except Exception:  # noqa: BLE001
        return None


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=int(os.environ.get("JOBS", os.cpu_count() or 1)))
    ap.add_argument("--quick", action="store_true", help="small grid (development / tests)")
    args = ap.parse_args(argv)
    if args.quick:
        C.WINDOWS[:] = [60]
        C.COV_METHODS[:] = ["lw"]
        for k in list(C.CAPS):
            if k != "10":
                del C.CAPS[k]
        C.MONKEY_SIZES[:] = [30]
        C.MONKEY_SEEDS[:] = [1]
    t_start = time.time()
    md = C.MARKET_DATA_DIR
    if not (md / "data/eodhd/SW/symbols.csv").exists():
        raise SystemExit(f"market-data not found at {md} (set MARKET_DATA_DIR).")
    G.update(load_all(md))
    out = C.OUT_DIR
    for sub in ("strategies", "holdings", "frontier", "monkeys"):
        d = out / sub
        if d.exists():
            for f in d.glob("*.json"):
                f.unlink()
    print(f"Data loaded in {G['load_seconds']:.1f}s; last complete month {G['last']}; {len(G['panel'].codes)} stocks.")
    jobs = [(L, cov, cap) for L in C.WINDOWS for cov in C.COV_METHODS for cap in C.CAPS]
    # heaviest jobs first (short windows with the sample covariance)
    jobs.sort(key=lambda j: (j[1] != "sample", j[0]))
    mjobs = [(L, f, k, s, mo) for L in C.WINDOWS for f in C.FREQS for k in C.MONKEY_SIZES for s in C.MONKEY_SEEDS for mo in C.MONKEY_MODES]
    ctx = mp.get_context("fork")
    sizes = {}
    metas = []
    with ctx.Pool(args.jobs) as pool:
        for res in pool.imap_unordered(run_config, jobs):
            k = res["key"]
            sizes[f"strategies/{k}.json"] = write_json(out / "strategies" / f"{k}.json", res["strategies"])
            sizes[f"holdings/{k}.json"] = write_json(out / "holdings" / f"{k}.json", res["holdings"])
            sizes[f"frontier/{k}.json"] = write_json(out / "frontier" / f"{k}.json", res["frontier"])
            metas.append(res["meta"])
            print(f"  {k}: {res['meta']['seconds']}s, decisions {res['meta']['n_decisions']}, solver {res['meta']['solver']}", flush=True)
        for res in pool.imap_unordered(run_monkeys, mjobs):
            sizes[f"monkeys/{res['key']}.json"] = write_json(out / "monkeys" / f"{res['key']}.json", res)
    sizes["market.json"] = write_json(out / "market.json", market_json(G))
    metas.sort(key=lambda m: (m["window"], m["cov"], m["cap"]))
    panel: D.Panel = G["panel"]
    sec = G["sec"]
    surv = G["surv"]
    controlled = f"{surv['first_covered_year']}-01" if surv["first_covered_year"] else None
    elig_counts = {str(L): [int(v) for v in G["elig"][L].sum(axis=1)] for L in C.WINDOWS}
    listed = int(panel.alive.sum(axis=1).max())
    manifest = {
        "title": "Swiss Equity Portfolio Lab",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "market_data_commit": git_commit(md),
        "data_last_date": G["data_last_date"],
        "last_complete_month": str(G["last"]),
        "grid": {"windows": C.WINDOWS, "freqs": list(C.FREQS), "cov": C.COV_METHODS, "caps": {k: v for k, v in C.CAPS.items()},
                 "monkey_sizes": C.MONKEY_SIZES, "monkey_seeds": C.MONKEY_SEEDS, "monkey_modes": C.MONKEY_MODES,
                 "n_monkeys": C.N_MONKEYS},
        "default": C.DEFAULT if not args.quick else {**C.DEFAULT, "window": 60, "cov": "lw", "cap": "10"},
        "quick": bool(args.quick),
        "strategies": C.STRATEGIES, "extra_strategies": C.EXTRA_STRATEGIES,
        "configs": metas,
        "survivorship": {**surv, "controlled_start": controlled},
        "universe": {
            "rules": {"min_universe": C.MIN_UNIVERSE, "liq_lookback_days": C.LIQ_LOOKBACK_DAYS,
                      "liq_min_median_value_chf": C.LIQ_MIN_MEDIAN_VALUE, "liq_max_zero_volume": C.LIQ_MAX_ZERO_VOLUME,
                      "stale_max_days": C.STALE_MAX_DAYS, "price_min": C.PRICE_MIN, "price_max": C.PRICE_MAX,
                      "spike_up": C.SPIKE_UP, "spike_revert_days": C.SPIKE_REVERT_DAYS, "level_break": C.LEVEL_BREAK,
                      "reversal_up": C.REVERSAL_UP, "reversal_two_month": C.REVERSAL_TWO_MONTH},
            "candidates": int(len(sec)), "included": int(sec["included"].sum()),
            "excluded": sec.loc[~sec["included"], ["code", "name", "reason"]].to_dict("records"),
            "no_price_data": G["no_data"],
            "duplicates_same_isin": G["dups"], "duplicates_cross": G["cross"], "dropped_duplicates": G["dropped"],
            "stocks_in_panel": len(panel.codes), "delisted_in_panel": int(sum(sec.set_index("code").loc[c, "delisted"] for c in panel.codes)),
            "cleaning": {"invalid_rows": G["log"].invalid_rows, "spike_rows": G["log"].spike_rows,
                         "level_break_rows": G["log"].break_rows, "by_code": G["log"].by_code,
                         "ex_post_corrections": ["placeholder prices (row-local test)", "history before an unreverted level break"],
                         "point_in_time_filters": ["one-day spikes (known once reverted)", "Ince-Porter monthly reversals (known one month later)"]},
            "reversal_months_flagged": panel.flagged_reversals,
            "max_listed_at_once": listed,
            "spike_months_affecting_last_return": int(((panel.price_raw - panel.price).abs() > 1e-12).to_numpy().sum()),
            "months": [str(m) for m in panel.months],
            "eligible": elig_counts,
            "listed": [int(v) for v in panel.alive.sum(axis=1)],
        },
        "costs": {"spread_estimator": "Abdi and Ranaldo (2017) close-high-low, 63 trading days, median by liquidity group",
                  "spread_groups": C.SPREAD_GROUPS, "groups": panel.spread_groups},
        "risk_free": {"segments": G["rf"].segments, "checks": G["rf"].checks},
        "factors": G["finfo"],
        "benchmark": {"ticker": "SSHI.INDX", "name": "SPI (Swiss Performance Index), total return, CHF",
                      "first": str(G["spi"].index.min()), "last": str(G["spi"].index.max())},
        "regimes": [{"name": n, "start": a, "end": b} for n, a, b in C.REGIMES],
        "files": sizes,
        "build_seconds": round(time.time() - t_start, 1),
    }
    sizes["manifest.json"] = write_json(out / "manifest.json", manifest)
    report = privacy.check_outputs(out, G["panel"])
    write_json(out / "manifest.json", {**manifest, "privacy": report})
    total = sum(sizes.values()) / 1e6
    print(f"Done in {time.time() - t_start:.0f}s; {len(sizes)} files, {total:.1f} MB; privacy: {report['status']}")
    if report["status"] != "ok":
        raise SystemExit("Privacy check failed: " + "; ".join(report["problems"]))


if __name__ == "__main__":
    main()
