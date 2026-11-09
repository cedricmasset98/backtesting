"""The numpy/scipy OLS (olsref) and statsmodels agree; this justifies the
numpy fallback of statsref.py and anchors the TypeScript tests. In CI
(STRICT_REFERENCE=1) a missing statsmodels is an error, not a skip."""

import os
import unittest

import numpy as np

from pipeline import olsref

try:
    import statsmodels.api as sm
    from statsmodels.stats.diagnostic import acorr_ljungbox, het_breuschpagan
    from statsmodels.stats.stattools import jarque_bera
    HAS_SM = True
except ImportError:
    HAS_SM = False

STRICT = os.environ.get("STRICT_REFERENCE") == "1"


class TestOlsAgainstStatsmodels(unittest.TestCase):
    def setUp(self):
        if not HAS_SM:
            if STRICT:
                self.fail("statsmodels is required when STRICT_REFERENCE=1")
            self.skipTest("statsmodels not installed")
        rng = np.random.default_rng(0)
        n = 180
        self.X = np.column_stack([np.ones(n), rng.normal(0, 0.04, (n, 6))])
        e = rng.normal(0, 0.01, n) * (1 + 5 * np.abs(self.X[:, 1]))
        self.y = self.X @ np.array([0.001, 1.0, 0.2, -0.3, 0.1, 0.05, 0.2]) + e

    def test_all_covariances(self):
        n = len(self.y)
        lags = olsref.nw_lags(n)
        for cov, kw in (("classical", {}), ("HC3", {"cov_type": "HC3"}),
                        ("HAC", {"cov_type": "HAC", "cov_kwds": {"maxlags": lags, "use_correction": False}})):
            ref = sm.OLS(self.y, self.X).fit(**kw)
            f = olsref.fit(self.y, self.X, cov)
            np.testing.assert_allclose(f.params, ref.params, rtol=1e-10)
            np.testing.assert_allclose(f.se, ref.bse, rtol=1e-9)
            np.testing.assert_allclose(f.pvalue, ref.pvalues, rtol=1e-7, atol=1e-14)
            np.testing.assert_allclose(f.ci_low, ref.conf_int()[:, 0], rtol=1e-9)
            self.assertAlmostEqual(f.r2, ref.rsquared, places=12)
            self.assertAlmostEqual(f.r2adj, ref.rsquared_adj, places=12)

    def test_diagnostics(self):
        f = olsref.fit(self.y, self.X, "classical")
        jb = jarque_bera(f.resid)
        self.assertAlmostEqual(olsref.jarque_bera(f.resid)[0], jb[0], places=8)
        bp = het_breuschpagan(f.resid, self.X, robust=True)
        self.assertAlmostEqual(olsref.breusch_pagan(f.resid, self.X)[0], bp[0], places=8)
        lb = acorr_ljungbox(f.resid, lags=[12], return_df=True)
        self.assertAlmostEqual(olsref.ljung_box(f.resid, 12)[0], float(lb["lb_stat"].iloc[0]), places=8)


if __name__ == "__main__":
    unittest.main()
