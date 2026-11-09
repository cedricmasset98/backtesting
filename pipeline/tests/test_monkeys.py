import unittest

import numpy as np
import pandas as pd

from pipeline import data as D
from pipeline import monkeys as M
from pipeline.tests.helpers import synthetic_panel


class TestMonkeys(unittest.TestCase):
    def setUp(self):
        self.p = synthetic_panel(n_stocks=60, seed=7)
        self.elig = D.eligibility(self.p, 12)
        self.t0 = 12

    def test_reproducible(self):
        a = M.simulate_monkeys(self.p, self.elig, self.t0, "Q", 10, 1, n_monkeys=20)
        b = M.simulate_monkeys(self.p, self.elig, self.t0, "Q", 10, 1, n_monkeys=20)
        np.testing.assert_array_equal(a[0], b[0])
        np.testing.assert_array_equal(a[1], b[1])

    def test_seeds_differ(self):
        a = M.simulate_monkeys(self.p, self.elig, self.t0, "Q", 10, 1, n_monkeys=20)[0]
        b = M.simulate_monkeys(self.p, self.elig, self.t0, "Q", 10, 2, n_monkeys=20)[0]
        self.assertFalse(np.allclose(np.nan_to_num(a), np.nan_to_num(b)))

    def test_draw_rules(self):
        idx = np.flatnonzero(self.elig.iloc[30].to_numpy())
        d = M.draw(1, 3, self.p.months[30], idx, 10)
        self.assertEqual(d.size, 10)
        self.assertEqual(len(set(d)), 10)
        self.assertTrue(set(d) <= set(idx))
        self.assertEqual(M.draw(1, 3, self.p.months[30], idx[:5], 10).size, 5)  # fewer eligible than K

    def test_future_data_does_not_change_past_draws(self):
        m = self.p.months[40]
        idx = np.flatnonzero(self.elig.iloc[40].to_numpy())
        before = M.draw(2, 7, m, idx, 10)
        p2 = synthetic_panel(n_stocks=60, seed=7)
        p2.r_est.iloc[41:] *= -3
        e2 = D.eligibility(p2, 12)
        np.testing.assert_array_equal(before, M.draw(2, 7, m, np.flatnonzero(e2.iloc[40].to_numpy()), 10))

    def test_equal_weights_at_rebalancing(self):
        g, _ = M.simulate_monkeys(self.p, self.elig, self.t0, "M", 10, 1, n_monkeys=5)
        k = 30
        idx = np.flatnonzero(self.elig.iloc[k].to_numpy())
        pick = M.draw(1, 0, self.p.months[k], idx, 10)
        r = self.p.r_val.to_numpy()[k + 1, pick]
        self.assertAlmostEqual(g[0, k + 1], r.mean(), places=12)


if __name__ == "__main__":
    unittest.main()
