"""No look-ahead along the whole chain, from raw daily CSV files to weights.

Two copies of a synthetic market-data directory share every row up to a cut-off
date D and differ afterwards: other prices, delistings, a month-end spike at D
that reverts after D in one copy only, and a +400 % month followed by a crash
(Ince-Porter reversal) in one copy only. Everything decided at or before D —
cleaning, eligibility, estimation windows, weights of every strategy — must be
identical, and so must the realised returns of the months before D.
"""

import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from pipeline import backtest as B
from pipeline import config as C
from pipeline import data as D

N_STOCKS = 40
START, END = "2000-01-03", "2006-12-29"
CUT = pd.Timestamp("2004-06-30")  # last day of the common information set


def market(root: Path, variant: str) -> None:
    rng = np.random.default_rng(7)  # same draws for both variants up to the cut
    dates = pd.bdate_range(START, END)
    eod = root / "data/eodhd/SW/eod"
    eod.mkdir(parents=True)
    rows = []
    after = dates > CUT
    alt = np.random.default_rng(99)
    for i in range(N_STOCKS):
        code = f"S{i:02d}"
        r = rng.normal(0.0003, 0.015, len(dates))
        if variant == "B":
            r[after] = alt.normal(-0.001, 0.03, after.sum())
        p = 50 * np.cumprod(1 + r)
        if i == 3:  # month-end spike at the cut: reverts after D in A only
            k = np.flatnonzero(dates == CUT)[0]
            p[k] *= 5  # A: the following days are back to normal, so the spike reverts
            if variant == "B":
                p[k + 1:] *= 5  # B: no reversal, a genuine level change
        if i == 4:  # +400 % during the cut month, crash the month after in A only
            m = (dates.to_period("M") == CUT.to_period("M"))
            first = np.flatnonzero(m)[0]
            p[first:] *= 5
            if variant == "A":
                nxt = np.flatnonzero(dates.to_period("M") == CUT.to_period("M") + 1)[0]
                p[nxt:] /= 5.5
        keep = np.ones(len(dates), bool)
        delisted = False
        if variant == "B" and i in (5, 6):  # delisted after the cut in B only
            keep = dates <= CUT + pd.Timedelta(days=45)
            delisted = True
        df = pd.DataFrame({"date": dates[keep].strftime("%Y-%m-%d"), "open": p[keep], "high": p[keep], "low": p[keep],
                           "close": p[keep], "adjusted_close": p[keep], "volume": 5000})
        df.to_csv(eod / f"{code}.SW.csv.gz", index=False, compression="gzip")
        rows.append({"Code": code, "Name": f"Company {i}", "Country": "Switzerland", "Exchange": "SW", "Currency": "CHF",
                     "Type": "Common Stock", "Isin": f"CH{i:010d}", "Delisted": str(delisted)})
    pd.DataFrame(rows).to_csv(root / "data/eodhd/SW/symbols.csv", index=False)


def pipeline_until_weights(root: Path):
    sec = D.classify_securities(root)
    log = D.CleanLog()
    daily = D.load_daily(root, sec.loc[sec["included"], "code"].tolist(), log)
    panel = D.monthly_panel(daily, dict(zip(sec["code"], sec["name"])), pd.Period("2006-12", "M"))
    rf = pd.Series(0.001, index=panel.months)
    spi = pd.Series(0.005, index=panel.months)
    window = 24
    elig = D.eligibility(panel, window)
    run = B.compute_weights(panel, elig, window, "lw", "25", rf, spi)
    return panel, elig, run


class TestEndToEndNoLookAhead(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        base = Path(cls.tmp.name)
        for v in ("A", "B"):
            market(base / v, v)
        cls.A = pipeline_until_weights(base / "A")
        cls.B = pipeline_until_weights(base / "B")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_the_two_markets_really_differ_after_the_cut(self):
        pa, ea, ra = self.A
        pb, eb, rb = self.B
        kc = pa.months.get_loc(CUT.to_period("M"))
        self.assertFalse(np.allclose(np.nan_to_num(pa.r_val.iloc[kc + 2:].to_numpy()), np.nan_to_num(pb.r_val.iloc[kc + 2:].to_numpy())))
        self.assertFalse(ea.iloc[kc + 3:].equals(eb.iloc[kc + 3:]))

    def test_decisions_up_to_the_cut_are_identical(self):
        pa, ea, ra = self.A
        pb, eb, rb = self.B
        kc = pa.months.get_loc(CUT.to_period("M"))
        np.testing.assert_array_equal(ea.iloc[: kc + 1].to_numpy(), eb.iloc[: kc + 1].to_numpy())
        for k in range(ra.t0, kc + 1):
            np.testing.assert_array_equal(D.estimation_window(pa, k, 24), D.estimation_window(pb, k, 24))
            for s in B.OPTIMISED:
                np.testing.assert_array_equal(ra.decisions[k].weights[s], rb.decisions[k].weights[s], err_msg=f"{s} at {pa.months[k]}")

    def test_returns_before_the_cut_are_identical(self):
        pa, _, ra = self.A
        pb, _, rb = self.B
        kc = pa.months.get_loc(CUT.to_period("M"))
        for f in C.FREQS:
            for s in B.OPTIMISED:
                np.testing.assert_array_equal(B.simulate(ra, s, f, pa).gross[:kc], B.simulate(rb, s, f, pb).gross[:kc])

    def test_spike_and_reversal_are_corrected_once_known(self):
        pa, _, _ = self.A
        kc = pa.months.get_loc(CUT.to_period("M"))
        # month-end spike of S03: seen at the cut, removed from the ex post price
        self.assertGreater(pa.price_raw["S03"].iloc[kc], 4 * pa.price["S03"].iloc[kc])
        # the reversal of S04 is ignored at the cut, flagged one month later
        w_at_cut = D.estimation_window(pa, kc, 24)[:, pa.codes.index("S04")]
        w_after = D.estimation_window(pa, kc + 1, 24)[:, pa.codes.index("S04")]
        self.assertFalse(np.isnan(w_at_cut).any())
        self.assertTrue(np.isnan(w_after[-2:]).all())


if __name__ == "__main__":
    unittest.main()
