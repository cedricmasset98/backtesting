import unittest

import numpy as np

from pipeline import estimators as E


def lw_naive(x):
    """Direct transcription of Ledoit & Wolf (2004), appendix B, with loops."""
    t, n = x.shape
    xc = x - x.mean(0)
    s = xc.T @ xc / t
    sd = np.sqrt(np.diag(s))
    rbar = sum(s[i, j] / (sd[i] * sd[j]) for i in range(n) for j in range(n) if i != j) / (n * (n - 1))
    f = np.array([[s[i, i] if i == j else rbar * sd[i] * sd[j] for j in range(n)] for i in range(n)])
    pi = sum(((xc[:, i] * xc[:, j] - s[i, j]) ** 2).mean() for i in range(n) for j in range(n))
    rho = sum(((xc[:, i] ** 2 - s[i, i]) ** 2).mean() for i in range(n))
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            th_ii = ((xc[:, i] ** 2 - s[i, i]) * (xc[:, i] * xc[:, j] - s[i, j])).mean()
            th_jj = ((xc[:, j] ** 2 - s[j, j]) * (xc[:, i] * xc[:, j] - s[i, j])).mean()
            rho += rbar / 2 * (sd[j] / sd[i] * th_ii + sd[i] / sd[j] * th_jj)
    gamma = ((f - s) ** 2).sum()
    delta = max(0, min(1, (pi - rho) / gamma / t))
    return (delta * f + (1 - delta) * s) * t / (t - 1), delta


class TestCovariance(unittest.TestCase):
    def test_lw_matches_naive(self):
        x = np.random.default_rng(0).normal(0, 0.05, (36, 7)) + np.random.default_rng(1).normal(0, 0.03, (36, 1))
        a, da = E.ledoit_wolf_cc(x)
        b, db = lw_naive(x)
        self.assertAlmostEqual(da, db, places=12)
        np.testing.assert_allclose(a, b, rtol=1e-10)

    def test_lw_properties(self):
        x = np.random.default_rng(2).normal(0, 0.05, (12, 80))
        s, d = E.ledoit_wolf_cc(x)
        self.assertTrue(0 <= d <= 1)
        np.testing.assert_allclose(np.diag(s), np.var(x, axis=0, ddof=1), rtol=1e-12)  # diagonal kept
        self.assertGreater(np.linalg.eigvalsh(s)[0], 0)  # positive definite although N > T

    def test_sample_cov(self):
        x = np.random.default_rng(3).normal(size=(50, 4))
        np.testing.assert_allclose(E.sample_cov(x, ridge=0.0), np.cov(x, rowvar=False))


class TestBayesStein(unittest.TestCase):
    def test_shrinks_towards_gmv_mean(self):
        rng = np.random.default_rng(4)
        x = rng.normal(0.01, 0.05, (60, 10))
        sig = E.ledoit_wolf_cc(x)[0]
        mu, phi = E.bayes_stein_mean(x, sig)
        self.assertTrue(0 < phi < 1)
        inv = np.linalg.inv(sig)
        mu0 = np.ones(10) @ inv @ x.mean(0) / (np.ones(10) @ inv @ np.ones(10))
        np.testing.assert_allclose(mu, (1 - phi) * x.mean(0) + phi * mu0)
        self.assertLess(np.std(mu), np.std(x.mean(0)))

    def test_equal_means_unchanged(self):
        x = np.random.default_rng(5).normal(0, 0.05, (24, 5))
        x = x - x.mean(0) + 0.01
        mu, phi = E.bayes_stein_mean(x, np.cov(x, rowvar=False))
        np.testing.assert_allclose(mu, 0.01)


if __name__ == "__main__":
    unittest.main()
