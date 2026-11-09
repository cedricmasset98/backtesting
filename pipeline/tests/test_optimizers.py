import math
import unittest

import numpy as np

from pipeline import optimizers as O
from pipeline.tests.helpers import random_cov


def feasible(w, cap, tol=1e-9):
    return abs(w.sum() - 1) < tol and w.min() >= -tol and w.max() <= cap + tol


class TestProjection(unittest.TestCase):
    def test_matches_bisection(self):
        rng = np.random.default_rng(1)
        for _ in range(2000):
            n = int(rng.integers(2, 50))
            cap = float(rng.choice([1.0, 0.5, 0.2, 0.1]))
            if cap * n < 1:
                continue
            v = rng.normal(size=n) * rng.choice([1e-3, 1, 50])
            lo, hi = v.min() - 2, v.max() + 2
            for _ in range(200):
                m = (lo + hi) / 2
                lo, hi = (m, hi) if np.clip(v - m, 0, cap).sum() > 1 else (lo, m)
            np.testing.assert_allclose(O.project_capped_simplex(v, cap), np.clip(v - (lo + hi) / 2, 0, cap), atol=1e-9)

    def test_infeasible_cap(self):
        with self.assertRaises(ValueError):
            O.project_capped_simplex(np.zeros(5), 0.1)


class TestStrategies(unittest.TestCase):
    def test_gmv_closed_form_unconstrained(self):
        # diagonal Σ: GMV weights ∝ 1/σ² (all positive, no bound binds)
        s = np.array([0.05, 0.1, 0.2, 0.08])
        w = O.gmv(np.diag(s**2), 1.0)
        ref = (1 / s**2) / (1 / s**2).sum()
        np.testing.assert_allclose(w, ref, atol=1e-10)

    def test_gmv_general_closed_form(self):
        sig = random_cov(8, 3, factor=0.1)
        inv = np.linalg.inv(sig)
        ref = inv @ np.ones(8) / (np.ones(8) @ inv @ np.ones(8))
        self.assertTrue((ref > 0).all())
        np.testing.assert_allclose(O.gmv(sig, 1.0), ref, atol=1e-9)

    def test_gmv_constraints_and_optimality(self):
        for seed in range(5):
            sig = random_cov(60, seed)
            for cap in (1.0, 0.1, 0.05):
                w = O.gmv(sig, cap)
                self.assertTrue(feasible(w, cap))
                # no feasible random perturbation improves the variance
                rng = np.random.default_rng(seed)
                for _ in range(50):
                    z = O.project_capped_simplex(w + rng.normal(0, 1e-3, 60), cap)
                    self.assertGreaterEqual(z @ sig @ z, w @ sig @ w - 1e-14)

    def test_tangency_closed_form(self):
        sig = random_cov(6, 4, factor=0.1)
        mu = np.array([0.008, 0.006, 0.007, 0.009, 0.005, 0.0065])
        rf = 0.001
        inv = np.linalg.inv(sig)
        ref = inv @ (mu - rf)
        ref /= ref.sum()
        self.assertTrue((ref > 0).all())
        w, fb = O.tangency(sig, mu, rf, 1.0)
        self.assertFalse(fb)
        np.testing.assert_allclose(w, ref, atol=1e-7)

    def test_tangency_maximises_sharpe_with_caps(self):
        rng = np.random.default_rng(5)
        sig = random_cov(40, 5)
        mu = rng.normal(0.006, 0.004, 40)
        for cap in (1.0, 0.1):
            w, fb = O.tangency(sig, mu, 0.001, cap)
            self.assertTrue(feasible(w, cap))
            sr = (w @ mu - 0.001) / math.sqrt(w @ sig @ w)
            for _ in range(200):
                z = O.project_capped_simplex(w + rng.normal(0, 2e-3, 40), cap)
                self.assertLessEqual((z @ mu - 0.001) / math.sqrt(z @ sig @ z), sr + 1e-10)

    def test_tangency_fallback_when_no_positive_excess_return(self):
        sig = random_cov(10, 6)
        w, fb = O.tangency(sig, np.full(10, 0.001), 0.01, 1.0)
        self.assertTrue(fb)
        np.testing.assert_allclose(w, O.gmv(sig, 1.0), atol=1e-10)

    def test_mdp_diagonal(self):
        # uncorrelated assets: MDP weights ∝ 1/σ
        s = np.array([0.05, 0.1, 0.2, 0.08])
        w = O.most_diversified(np.diag(s**2), 1.0)
        np.testing.assert_allclose(w, (1 / s) / (1 / s).sum(), atol=1e-8)

    def test_mdp_equals_gmv_on_correlation_matrix(self):
        sig = random_cov(12, 7, factor=0.2)
        sd = np.sqrt(np.diag(sig))
        corr = sig / np.outer(sd, sd)
        y = O.gmv(corr, 1.0)
        ref = (y / sd) / (y / sd).sum()
        np.testing.assert_allclose(O.most_diversified(sig, 1.0), ref, atol=1e-7)

    def test_erc_equal_contributions(self):
        for seed in range(4):
            sig = random_cov(30, seed)
            w = O.equal_risk_contribution(sig)
            rc = O.risk_contributions(w, sig)
            np.testing.assert_allclose(rc, np.full(30, 1 / 30), atol=1e-9)
            self.assertTrue(feasible(w, 1.0))

    def test_erc_diagonal_is_inverse_vol(self):
        s = np.array([0.05, 0.1, 0.2])
        np.testing.assert_allclose(O.equal_risk_contribution(np.diag(s**2)), O.inverse_volatility(np.diag(s**2)), atol=1e-10)

    def test_ivp(self):
        s = np.array([0.1, 0.2, 0.4])
        np.testing.assert_allclose(O.inverse_volatility(np.diag(s**2)), np.array([4, 2, 1]) / 7)

    def test_apply_cap(self):
        w = O.apply_cap(np.array([0.5, 0.2, 0.1, 0.1, 0.05, 0.05]), 0.25)
        self.assertTrue(feasible(w, 0.25))
        self.assertAlmostEqual(w[0], 0.25)
        # proportions of uncapped weights are preserved
        self.assertAlmostEqual(w[2] / w[4], 2.0)

    def test_singular_covariance(self):
        # N > T: sample covariance singular, made positive definite by the ridge
        from pipeline.estimators import sample_cov
        x = np.random.default_rng(0).normal(0, 0.05, (12, 50))
        sig = sample_cov(x)
        self.assertGreater(np.linalg.eigvalsh(sig)[0], 0)
        for f in (lambda: O.gmv(sig, 0.1), lambda: O.most_diversified(sig, 0.1), lambda: O.equal_risk_contribution(sig)):
            w = f()
            self.assertTrue(feasible(w, 1.0))


class TestFrontier(unittest.TestCase):
    def test_frontier_monotone_and_starts_at_gmv(self):
        sig = random_cov(25, 2)
        mu = np.random.default_rng(2).normal(0.006, 0.003, 25)
        pts = O.frontier(sig, mu, 0.2)
        w = O.gmv(sig, 0.2)
        self.assertAlmostEqual(pts[0][0], math.sqrt(w @ sig @ w), places=10)
        for a, b in zip(pts, pts[1:]):
            self.assertGreater(b[0], a[0] - 1e-12)
            self.assertGreater(b[1], a[1])


if __name__ == "__main__":
    unittest.main()
