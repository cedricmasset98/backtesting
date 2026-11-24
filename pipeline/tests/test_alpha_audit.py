"""Unit tests for the read-only, non-UI alpha attribution audit."""
import numpy as np
import pytest

from tools.alpha_audit import BASE, FULL, audit_array, fit, net_return


def synthetic():
    rng = np.random.default_rng(42)
    n = 144
    factors = {key: rng.normal(0.001, 0.015, n) for key in FULL}
    factors["BAB"] = 0.003 + 0.4 * factors["MKT"] + rng.normal(0, 0.011, n)
    # Missing-factor months: isolate sample effects from incremental-BAB effects.
    factors["BAB"][:12] = np.nan
    rf = np.full(n, 0.0003)
    ew = rf + factors["MKT"] + 0.2 * factors["SMB"] + rng.normal(0, 0.004, n)
    base = np.column_stack([factors[x] for x in BASE])
    monkey = rf + 0.001 + base @ np.array([0.9, 0.2, -0.1, 0.15, 0.05, -0.2])
    monkey += -0.4 * np.nan_to_num(factors["BAB"], nan=0.003) + rng.normal(0, 0.004, n)
    return [f"{2009 + i // 12}-{1 + i % 12:02d}" for i in range(n)], monkey, ew, rf, factors


def test_bab_decomposition_all_methods():
    months, monkey, ew, rf, factors = synthetic()
    res = audit_array(months, monkey, ew, rf, factors)
    assert res["samples"]["old_n"] == 144
    assert res["samples"]["common_n"] == 132
    assert len(res["samples"]["excluded_by_bab"]) == 12
    for method, out in res["methods"].items():
        assert out["B_matched"]["n"] == out["C_plus_BAB"]["n"] == 132
        assert abs(out["identity_error_pa"]) < 1e-10
        assert out["BAB_loading"] < 0
        assert np.isclose(out["total_effect_pa"], out["sample_effect_pa"] + out["BAB_effect_pa"])
        assert np.isclose(out["BAB_effect_pa"], -out["BAB_loading"] * out["BAB_conditional_alpha_pa"])
        assert np.isclose(out["stat_change_numerator"] + out["stat_change_se"],
                          out["C_plus_BAB"]["stat"] - out["B_matched"]["stat"])
        assert res["multiple_models"][method]["FF5MOMBAB"]["holm_p"] >= out["C_plus_BAB"]["p"]


def test_differenced_portfolio_does_not_subtract_risk_free_twice():
    months, monkey, ew, rf, factors = synthetic()
    res = audit_array(months, monkey, ew, rf, factors)
    common = np.all(np.column_stack([np.isfinite(factors[k]) for k in FULL]), axis=1)
    mean_difference = (monkey - ew)[common].mean() * 12
    assert np.isclose(res["monkeys_vs_ew"]["classical"]["mean_difference"]["alpha_pa"], mean_difference)


def test_costs_match_browser_formula():
    gross = np.array([0.04, -0.03])
    turnover = np.array([0.75, 1.25])
    spread = np.array([0.002, 0.001])
    assert np.allclose(net_return(gross, turnover, spread, 10),
                       (1 - turnover * 0.001 - spread) * (1 + gross) - 1)


def test_independent_closed_form_and_statsmodels():
    rng = np.random.default_rng(91)
    x = rng.normal(size=(98, 7))
    y = 0.005 + x @ rng.normal(size=7) + rng.normal(0, 0.5, size=98)
    X = np.column_stack([np.ones(len(x)), x])
    expected_beta = np.linalg.lstsq(X, y, rcond=None)[0]
    for cov in ("classical", "HC3", "HAC"):
        actual = fit(y, x, cov)
        assert np.allclose(actual.params, expected_beta, rtol=1e-10, atol=1e-10)
        if cov == "classical":
            expected_se = np.sqrt(
                np.diag(np.linalg.inv(X.T @ X) * (actual.resid @ actual.resid) / (len(y) - X.shape[1]))
            )
            assert np.allclose(actual.bse, expected_se, rtol=1e-10)


def test_not_enough_common_data():
    months, monkey, ew, rf, factors = synthetic()
    factors["BAB"][:140] = np.nan
    with pytest.raises(ValueError, match="Insufficient"):
        audit_array(months, monkey, ew, rf, factors)
