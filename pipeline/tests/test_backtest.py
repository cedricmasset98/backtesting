"""Walk-forward engine: timing (no look-ahead), drift, turnover, costs, delistings."""

import unittest

import numpy as np
import pandas as pd

from pipeline import backtest as B
from pipeline import config as C
from pipeline import data as D
from pipeline.tests.helpers import synthetic_panel


def run_all(panel, window=24, cov="lw", cap="10"):
    elig = D.eligibility(panel, window)
    rf = pd.Series(0.001, index=panel.months)
    spi = pd.Series(0.005, index=panel.months)
    return elig, B.compute_weights(panel, elig, window, cov, cap, rf, spi)


class TestNoLookAhead(unittest.TestCase):
    def test_future_data_cannot_change_past_decisions(self):
        p1 = synthetic_panel(seed=1)
        _, run1 = run_all(p1)
        cut = 80
        p2 = synthetic_panel(seed=1)
        rng = np.random.default_rng(99)
        noise = rng.normal(0, 0.2, p2.r_est.iloc[cut + 1:].shape)
        p2.r_gen.iloc[cut + 1:] = p2.r_gen.iloc[cut + 1:] + noise
        p2.r_last.iloc[cut + 1:] = p2.r_gen.iloc[cut + 1:]
        p2.r_val.iloc[cut + 1:] = p2.r_gen.iloc[cut + 1:]
        p2.alive.iloc[cut + 1:, :5] = False  # future delistings
        p2.observed.iloc[cut + 1:, :5] = False
        _, run2 = run_all(p2)
        self.assertEqual(run1.t0, run2.t0)
        for k in range(run1.t0, cut + 1):
            for s in B.OPTIMISED:
                np.testing.assert_array_equal(run1.decisions[k].weights[s], run2.decisions[k].weights[s], err_msg=f"{s} at {k}")
        # returns up to the cut are identical as well, for every schedule
        for f in C.FREQS:
            for s in B.OPTIMISED:
                a = B.simulate(run1, s, f, p1).gross[: cut + 1]
                b = B.simulate(run2, s, f, p2).gross[: cut + 1]
                np.testing.assert_array_equal(a, b)
        # and something after the cut did change
        self.assertFalse(np.array_equal(run1.decisions[cut + 2].weights["GMV"], run2.decisions[cut + 2].weights["GMV"]))

    def test_weights_only_earn_later_returns(self):
        p = synthetic_panel(seed=2)
        _, run = run_all(p)
        sim = B.simulate(run, "EW", "M", p)
        self.assertTrue(np.isnan(sim.gross[: run.t0 + 1]).all())  # nothing before the first holding month
        k = run.t0 + 5
        dec = run.decisions[k]
        r = p.r_val.to_numpy()[k + 1, dec.idx]
        self.assertAlmostEqual(sim.gross[k + 1], float(dec.weights["EW"] @ r), places=12)

    def test_eligibility_requires_complete_window(self):
        p = synthetic_panel(seed=3, list_from={"S000": "2004-01"})
        elig = D.eligibility(p, 24)
        first = elig["S000"].idxmax() if elig["S000"].any() else None
        # listed in Jan 2004 → first return Feb 2004 → 24 returns end in Jan 2006
        self.assertEqual(str(first), "2006-01")


class TestDriftTurnoverCosts(unittest.TestCase):
    def setUp(self):
        months = pd.period_range("2010-01", periods=6, freq="M")
        codes = ["A", "B"]
        r = pd.DataFrame([[0, 0], [0.10, 0.0], [0.0, 0.10], [0.05, -0.05], [0, 0], [0, 0]], index=months, columns=codes, dtype=float)
        price = (1 + r).cumprod()
        self.panel = D.Panel(months, codes, {"A": "A", "B": "B"}, price, price.copy(), r, r.copy(), r.copy(), price.notna(),
                             pd.DataFrame(True, index=months, columns=codes), price.notna(), {c: months[-1] for c in codes}, 0)
        self.run = B.WeightsRun(1, "lw", 1.0, 0)
        for k in range(6):
            self.run.decisions[k] = B.Decision(np.array([0, 1]), {"EW": np.array([0.5, 0.5])}, np.eye(2), np.zeros(2), 0, None, 0, False, False)

    def test_drift_and_annual_rebalancing(self):
        sim = B.simulate(self.run, "EW", "A", self.panel)  # no December in the sample: buy and hold
        self.assertAlmostEqual(sim.gross[1], 0.05)
        w_a = 0.5 * 1.1 / 1.05
        self.assertAlmostEqual(sim.gross[2], (1 - w_a) * 0.10)
        self.assertTrue(np.all(sim.turnover[2:] == 0))
        wealth = np.prod(1 + sim.gross[1:])
        self.assertAlmostEqual(wealth, 0.5 * 1.1 * 1.05 + 0.5 * 1.1 * 0.95)  # buy-and-hold value

    def test_monthly_turnover(self):
        sim = B.simulate(self.run, "EW", "M", self.panel)
        w_a = 0.5 * 1.1 / 1.05
        self.assertAlmostEqual(sim.turnover[2], abs(0.5 - w_a) + abs(0.5 - (1 - w_a)))
        self.assertEqual(sim.turnover[1], 0.0)  # the initial purchase is not charged

    def test_spread_cost_of_the_trades(self):
        import dataclasses
        hs = pd.DataFrame([[0.002, 0.010]] * 6, index=self.panel.months, columns=self.panel.codes)
        panel = dataclasses.replace(self.panel, half_spread=hs)
        sim = B.simulate(self.run, "EW", "M", panel)
        w_a = 0.5 * 1.1 / 1.05
        self.assertEqual(sim.spread[1], 0.0)
        self.assertAlmostEqual(sim.spread[2], abs(0.5 - w_a) * 0.002 + abs(0.5 - (1 - w_a)) * 0.010)
        self.assertTrue(np.all(B.simulate(self.run, "EW", "M", self.panel).spread[1:] == 0))  # no estimate: no cost

    def test_costs_on_traded_amount_only(self):
        sim = B.simulate(self.run, "EW", "M", self.panel)
        g, to = sim.gross[1:], sim.turnover[1:]
        net = B.net_returns(g, to, 50)
        wealth = 1.0
        for gi, ti in zip(g, to):
            wealth -= wealth * 0.005 * ti  # pay costs on the traded value
            wealth *= 1 + gi
        self.assertAlmostEqual(np.prod(1 + net), wealth, places=14)
        bh = B.simulate(self.run, "EW", "A", self.panel)
        np.testing.assert_allclose(B.net_returns(bh.gross[1:], bh.turnover[1:], 100), bh.gross[1:])  # no trade, no cost


class TestDelisting(unittest.TestCase):
    def test_delisted_stock_written_off_after_an_observed_month_without_price(self):
        p = synthetic_panel(n_stocks=35, seed=4, delist={"S001": "2006-06"})
        p.r_val.loc[p.months > pd.Period("2006-06", "M"), "S001"] = np.nan
        elig, run = run_all(p, cap="25")
        self.assertFalse(elig.loc[pd.Period("2006-07", "M"):, "S001"].any())
        self.assertTrue(elig.loc[pd.Period("2006-06", "M"), "S001"])
        sim = B.simulate(run, "EW", "A", p)
        k = p.months.get_loc(pd.Period("2006-06", "M"))
        self.assertGreaterEqual(sim.exits, 1)
        # July: still held (its absence is only known at the end of July), earns 0 %
        self.assertAlmostEqual(sim.turnover[k + 1], 0.0, places=12)
        # end of July: written off and reinvested → turnover in the August holding month
        self.assertGreater(sim.turnover[k + 2], 0)
        self.assertTrue(np.isfinite(sim.gross[k + 1:]).all())

    def test_suspension_is_not_known_in_advance(self):
        # S002 has no price in Mar 2006 but trades again later: the rule cannot use that
        p = synthetic_panel(n_stocks=35, seed=4)
        m = pd.Period("2006-03", "M")
        p.observed.loc[m, "S002"] = False
        p.r_val.loc[m, "S002"] = 0.0
        _, run = run_all(p, cap="25")
        sim = B.simulate(run, "EW", "A", p)
        self.assertGreaterEqual(sim.exits, 1)


class TestCommonSample(unittest.TestCase):
    def test_all_strategies_share_first_and_last_return(self):
        p = synthetic_panel(seed=5)
        _, run = run_all(p)
        spans = set()
        for s in B.OPTIMISED:
            g = B.simulate(run, s, "Q", p).gross
            ok = np.flatnonzero(np.isfinite(g))
            spans.add((ok[0], ok[-1], ok.size))
        self.assertEqual(len(spans), 1)


if __name__ == "__main__":
    unittest.main()
