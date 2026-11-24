"""Read-only, non-UI audit of Malkiel monkeys' factor alpha.
Usage: python tools/alpha_audit.py --data-dir public/data --out alpha-audit.json
Uses only publicly derived portfolio-level data and statsmodels.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import numpy as np
import statsmodels.api as sm
from statsmodels.stats.multitest import multipletests

BASE = ("MKT", "SMB", "HML", "RMW", "CMA", "MOM")
FULL = BASE + ("BAB",)
MODELS = {
    "CAPM": ("MKT",), "FF3": ("MKT", "SMB", "HML"),
    "CARHART": ("MKT", "SMB", "HML", "MOM"),
    "FF5": ("MKT", "SMB", "HML", "RMW", "CMA"),
    "FF5MOM": BASE, "FF5MOMBAB": FULL,
}
COVS = ("classical", "HC3", "HAC")


def net_return(gross: np.ndarray, turnover: np.ndarray, spread: np.ndarray, bps: float) -> np.ndarray:
    """Mirror src/engine/metrics.ts netReturns, including spread and multiplicative gross return."""
    return (1.0 - (bps / 10000.0) * np.nan_to_num(turnover) - np.nan_to_num(spread)) * (1.0 + gross) - 1.0


def fit(y: np.ndarray, factors: np.ndarray, cov: str):
    X = sm.add_constant(factors, has_constant="add")
    model = sm.OLS(y, X)
    if cov == "classical":
        return model.fit()
    if cov == "HC3":
        return model.fit(cov_type="HC3")
    if cov == "HAC":
        lag = int(np.floor(4 * (len(y) / 100) ** (2 / 9)))
        return model.fit(cov_type="HAC", cov_kwds={"maxlags": lag, "use_correction": False})
    raise ValueError(cov)


def stats(r) -> dict:
    ci = np.asarray(r.conf_int(alpha=0.05))[0]
    return {"alpha_pa": float(12 * r.params[0]), "se_pa": float(12 * r.bse[0]),
            "stat": float(r.tvalues[0]), "p": float(r.pvalues[0]),
            "ci95_pa": [float(12 * v) for v in ci],
            "r2adj": float(r.rsquared_adj), "n": int(r.nobs)}


def audit_array(months: list[str], portfolio: np.ndarray, ew: np.ndarray,
                rf: np.ndarray, factors: dict[str, np.ndarray]) -> dict:
    assert len(months) == len(portfolio) == len(ew) == len(rf)
    rows = {key: np.asarray(factors[key], dtype=float) for key in FULL}
    for key in FULL:
        assert len(rows[key]) == len(months), key
    available = np.isfinite(portfolio) & np.isfinite(rf)

    def sample(keys: tuple[str, ...], additionally_ew: bool = False) -> np.ndarray:
        valid = available & np.all(np.column_stack([np.isfinite(rows[k]) for k in keys]), axis=1)
        if additionally_ew:
            valid &= np.isfinite(ew)
        return np.flatnonzero(valid)

    old = sample(BASE)
    both = sample(FULL)
    if len(both) <= len(FULL) + 2:
        raise ValueError("Insufficient common monthly observations")
    outcome = {"samples": {
        "old_n": len(old), "common_n": len(both),
        "old_start": months[old[0]], "old_end": months[old[-1]],
        "common_start": months[both[0]], "common_end": months[both[-1]],
        "excluded_by_bab": [months[i] for i in np.setdiff1d(old, both)],
    }, "methods": {}, "monkeys_vs_ew": {}, "multiple_models": {}}
    y = portfolio - rf
    oldX = np.column_stack([rows[k][old] for k in BASE])
    commonX = np.column_stack([rows[k][both] for k in BASE])
    fullX = np.column_stack([rows[k][both] for k in FULL])
    babX = rows["BAB"][both]
    for cov in COVS:
        a = fit(y[old], oldX, cov)
        b = fit(y[both], commonX, cov)
        c = fit(y[both], fullX, cov)
        auxiliary = fit(babX, commonX, cov)
        sample_effect = float(12 * (b.params[0] - a.params[0]))
        bab_effect = float(12 * (c.params[0] - b.params[0]))
        gamma = float(c.params[-1])
        conditional_bab = float(auxiliary.params[0])
        identity_gap = bab_effect + 12 * gamma * conditional_bab
        if not np.isclose(identity_gap, 0.0, atol=1e-9):
            raise AssertionError(f"FWL alpha identity failed ({cov}): {identity_gap}")
        t_numerator = float((c.params[0] - b.params[0]) / b.bse[0])
        t_denominator = float(c.params[0] * (1 / c.bse[0] - 1 / b.bse[0]))
        assert np.isclose(t_numerator + t_denominator, c.tvalues[0] - b.tvalues[0], atol=1e-8)
        outcome["methods"][cov] = {
            "A_original": stats(a), "B_matched": stats(b), "C_plus_BAB": stats(c),
            "sample_effect_pa": sample_effect, "BAB_effect_pa": bab_effect,
            "total_effect_pa": float(12 * (c.params[0] - a.params[0])),
            "BAB_loading": gamma, "BAB_loading_p": float(c.pvalues[-1]),
            "BAB_conditional_alpha_pa": 12 * conditional_bab,
            "identity_error_pa": identity_gap,
            "stat_change_numerator": t_numerator, "stat_change_se": t_denominator,
            "BAB_partial_R2": float((b.ssr - c.ssr) / b.ssr),
        }
        same = sample(FULL, additionally_ew=True)
        diff = (portfolio - ew)[same]  # Do NOT subtract risk-free rate twice.
        regressors = np.column_stack([rows[k][same] for k in FULL])
        spread_fit = fit(diff, regressors, cov)
        mean_fit = fit(diff, np.empty((len(diff), 0)), cov)
        outcome["monkeys_vs_ew"][cov] = {
            "mean_difference": stats(mean_fit), "factor_adjusted_difference": stats(spread_fit),
            "n": len(same),
        }
        pvals, all_mod = [], []
        for name, keys in MODELS.items():
            idx = sample(keys)
            fX = np.column_stack([rows[k][idx] for k in keys])
            result = fit(y[idx], fX, cov)
            pvals.append(float(result.pvalues[0]))
            all_mod.append((name, stats(result)))
        adjusted = multipletests(pvals, method="holm")[1]
        outcome["multiple_models"][cov] = {
            name: {**s, "holm_p": float(adj)}
            for (name, s), adj in zip(all_mod, adjusted)
        }
    return outcome


def load_published(root: Path, basis: str = "net", start: str | None = None,
                   end: str | None = None):
    man = json.loads((root / "manifest.json").read_text())
    market = json.loads((root / "market.json").read_text())
    d = man["default"]
    strat_key = f"L{d['window']}_{d['cov']}_cap{d['cap']}"
    monkey_key = f"L{d['window']}_{d['freq']}_k{d['monkeys_k']}_s{d['seed']}_{d.get('monkeys_mode', 'keep')}"
    st = json.loads((root / "strategies" / f"{strat_key}.json").read_text())
    mk = json.loads((root / "monkeys" / f"{monkey_key}.json").read_text())
    cost = float(d.get("bps", 10.0))
    use_spread = bool(d.get("spread", True))
    smap = {m: i for i, m in enumerate(st["months"])}
    mmap = {m: i for i, m in enumerate(mk["months"])}
    bmap = {m: i for i, m in enumerate(market["months"])}
    start = start or man["survivorship"]["controlled_start"] or st["months"][0]
    end = end or man["last_complete_month"]
    months = [m for m in st["months"] if start <= m <= end and m in mmap and m in bmap
              and market["spi"][bmap[m]] is not None and market["rf"][bmap[m]] is not None]
    if not months:
        raise ValueError("No month meets requested range and market data availability")
    rf = np.asarray([market["rf"][bmap[m]] for m in months], dtype=float)
    factors = {key: np.array([market["factors"][key][bmap[m]] for m in months], dtype=float)
               for key in FULL}
    f = st["freqs"][d["freq"]]["EW"]
    si = [smap[m] for m in months]
    ew_g = np.asarray([f["gross"][i] for i in si], dtype=float)
    ew_t = np.asarray([f["turnover"][i] for i in si], dtype=float)
    ew_s = np.asarray([f.get("spread", [0.0] * len(st["months"]))[i] or 0.0 for i in si], dtype=float) if use_spread else np.zeros(len(si))
    ew = ew_g if basis == "gross" else net_return(ew_g, ew_t, ew_s, cost)
    mi = [mmap[m] for m in months]
    scale = mk["scale"]
    gross = np.asarray(mk["gross"], dtype=float)[:, mi] / scale
    turnover = np.asarray(mk["turnover"], dtype=float)[:, mi] / scale
    sp = np.asarray(mk["spread"], dtype=float)[:, mi] / scale if use_spread and mk.get("spread") else np.zeros_like(gross)
    monkeys = gross if basis == "gross" else net_return(gross, turnover, sp, cost)
    average_monkey = monkeys.mean(axis=0)
    provenance = {
        "manifest_generated_at": man["generated_at"],
        "market_data_commit": man.get("market_data_commit"),
        "configuration": {
            "strat_key": strat_key, "monkey_key": monkey_key,
            "freq": d["freq"], "basis": basis, "bps": cost, "spread": use_spread,
            "start": months[0], "end": months[-1], "n_monkeys": len(monkeys),
        }, "n_months": len(months),
    }
    return months, average_monkey, ew, rf, factors, provenance


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", type=Path, default=Path("public/data"))
    ap.add_argument("--basis", choices=("gross", "net"), default="net")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    months, monkeys, ew, rf, factors, provenance = load_published(args.data_dir, args.basis, args.start, args.end)
    output = {"provenance": provenance, "results": audit_array(months, monkeys, ew, rf, factors)}
    rendered = json.dumps(output, indent=2, allow_nan=False)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered, encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
