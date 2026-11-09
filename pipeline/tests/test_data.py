import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from pipeline import config as C
from pipeline import data as D


def write_stock(root: Path, code: str, df: pd.DataFrame):
    p = root / "data/eodhd/SW/eod"
    p.mkdir(parents=True, exist_ok=True)
    df.to_csv(p / f"{code}.SW.csv.gz", index=False, compression="gzip")


def frame(prices, start="2020-01-01", volume=1000):
    dates = pd.bdate_range(start, periods=len(prices))
    return pd.DataFrame({"date": dates.strftime("%Y-%m-%d"), "open": prices, "high": prices, "low": prices,
                         "close": prices, "adjusted_close": prices, "volume": volume})


class TestCleaning(unittest.TestCase):
    def test_invalid_spike_and_break(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            p = list(np.linspace(10, 11, 30))
            spike = p[:10] + [60.0, 61.0] + p[12:]                 # reverts after 2 days
            placeholder = [0.0001] * 5 + p                           # invalid tiny prices
            brk = [0.02] * 10 + p                                    # ×500 level break
            write_stock(root, "AAA", frame(spike))
            write_stock(root, "BBB", frame(placeholder))
            write_stock(root, "CCC", frame(brk))
            log = D.CleanLog()
            out = D.load_daily(root, ["AAA", "BBB", "CCC"], log)
            self.assertEqual(len(out["AAA"]), 28)
            self.assertEqual(log.spike_rows, 2)
            self.assertEqual(len(out["BBB"]), 30)
            self.assertEqual(log.invalid_rows, 5)
            self.assertEqual(len(out["CCC"]), 30)
            self.assertEqual(log.break_rows, 10)
            self.assertLess(out["AAA"]["adj"].max(), 12)

    def test_missing_months_not_filled_for_estimation(self):
        d = frame(list(np.linspace(10, 12, 130)), start="2020-01-01")
        d["date"] = pd.to_datetime(d["date"])
        d = d[~d["date"].dt.to_period("M").isin([pd.Period("2020-03", "M")])]  # suspension in March
        d = d.rename(columns={"adjusted_close": "adj"})[["date", "close", "adj", "volume"]]
        panel = D.monthly_panel({"X": d}, {"X": "X"}, pd.Period("2020-06", "M"))
        r = panel.r_est["X"]
        self.assertTrue(np.isnan(r[pd.Period("2020-03", "M")]))
        self.assertTrue(np.isnan(r[pd.Period("2020-04", "M")]))
        v = panel.r_val["X"]
        self.assertEqual(v[pd.Period("2020-03", "M")], 0.0)  # valued at the last price while suspended
        # valuation over the gap equals the true two-month return
        p = panel.price["X"]
        self.assertAlmostEqual((1 + v[pd.Period("2020-03", "M")]) * (1 + v[pd.Period("2020-04", "M")]),
                               p[pd.Period("2020-04", "M")] / p[pd.Period("2020-02", "M")])

    def test_duplicate_detection(self):
        a = frame(list(10 + np.cumsum(np.random.default_rng(0).normal(0, 0.1, 60))))
        b = a.copy()
        b["adjusted_close"] = b["adjusted_close"] * 3.0  # same returns, different adjustment factor
        c = frame(list(10 + np.cumsum(np.random.default_rng(1).normal(0, 0.1, 60))))
        daily = {}
        for k, f in {"NEW": a, "OLD": b, "OTH": c}.items():
            f = f.copy()
            f["date"] = pd.to_datetime(f["date"])
            daily[k] = f.rename(columns={"adjusted_close": "adj"})
        sec = pd.DataFrame({"code": ["NEW", "OLD", "OTH"], "name": ["n", "o", "x"], "isin": ["CH1", "CH1", "CH1"],
                            "delisted": [False, True, False], "included": True, "reason": ""})
        dups = {(d["kept"], d["dropped"]): d["is_duplicate"] for d in D.find_duplicates(sec, daily)}
        self.assertTrue(dups[("NEW", "OLD")])
        self.assertFalse(dups[("NEW", "OTH")])


class TestRiskFreeConvention(unittest.TestCase):
    def test_saron_compounding(self):
        # constant 1 % ACT/360 over a 30-day month
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "data/snb/snbgwdzid").mkdir(parents=True)
            (root / "data/snb/zimoma").mkdir(parents=True)
            days = pd.date_range("2021-03-25", "2021-07-02", freq="B")
            pd.DataFrame({"Date": days.strftime("%Y-%m-%d"), "SARON fixing at the close of the trading day [SARON]": 1.0}).to_csv(
                root / "data/snb/snbgwdzid/wide.csv", index=False)
            mm = pd.period_range("2020-01", "2021-07", freq="M")
            pd.DataFrame({"Date": mm.astype(str), "SARON > 1 day [SARON]": 1.0,
                          "Money market debt register claims of the Swiss Confederation > 3-month [EG3M]": 1.0}).to_csv(
                root / "data/snb/zimoma/wide.csv", index=False)
            rf = D.risk_free(root).series
            self.assertAlmostEqual(rf[pd.Period("2021-04", "M")], (1 + 0.01 / 360) ** 30 - 1, places=14)
            self.assertAlmostEqual(rf[pd.Period("2021-05", "M")], (1 + 0.01 / 360) ** 31 - 1, places=14)
            self.assertAlmostEqual(rf[pd.Period("2021-02", "M")], 0.01 * 28 / 360, places=14)  # previous month-end × days/360


class TestJkpConversion(unittest.TestCase):
    def test_long_short_conversion(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "data/jkp").mkdir(parents=True)
            rows = []
            for k, (code, _) in C.JKP_FACTORS.items():
                rows.append({"location": "che", "name": code, "freq": "monthly", "weighting": "vw_cap", "direction": 1,
                             "n_stocks": 100, "n_stocks_min": 30, "date": "2020-01-31", "ret": 0.02})
            pd.DataFrame(rows).to_csv(root / "data/jkp/che_all_factors.csv", index=False)
            fx = pd.Series([0.05], index=pd.PeriodIndex(["2020-01"], freq="M"))
            f, _ = D.jkp_factors_chf(root, fx)
            self.assertAlmostEqual(f.loc[pd.Period("2020-01", "M"), "SMB"], 0.02 * 1.05)


if __name__ == "__main__":
    unittest.main()
