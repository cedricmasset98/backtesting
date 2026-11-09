"""Configuration of the private pipeline.

Every number that changes a result is defined here, so that the documentation
(README, docs/METHODOLOGY.md, the Data & Methodology tab) can quote one place.
Changing the grid below is the documented way to add a window, a weight cap or
another precomputed configuration: re-run `python -m pipeline.build`.
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Private repository checked out next to this one (CI) or given explicitly.
MARKET_DATA_DIR = Path(os.environ.get("MARKET_DATA_DIR", ROOT.parent / "market-data")).resolve()
OUT_DIR = Path(os.environ.get("OUT_DIR", ROOT / "public" / "data")).resolve()

# --------------------------------------------------------------------- grid
# Rolling estimation windows (months of returns used at each decision date).
WINDOWS = [12, 36, 60, 120]
# Rebalancing frequencies: calendar month-ends, quarter-ends, year-ends.
FREQS = {"M": 1, "Q": 3, "A": 12}
# Covariance estimators: sample (with a tiny ridge for numerical stability) and
# Ledoit-Wolf (2004) shrinkage towards the constant-correlation target.
COV_METHODS = ["sample", "lw"]
# Upper bound on any single weight (long-only, fully invested in all cases).
# No uncapped configuration is published: an unconstrained optimiser can hold a
# single stock for months, and the published return series of that portfolio
# would then reproduce the stock's returns (licence; see privacy.py). The
# loosest published cap, 25 %, guarantees at least four holdings.
CAPS = {"25": 0.25, "10": 0.10, "5": 0.05}

# Default configuration shown when the site opens.
DEFAULT = {"window": 60, "freq": "Q", "cov": "lw", "cap": "10", "monkeys_k": 30, "seed": 1}

STRATEGIES = ["CW", "EW", "GMV", "ERC", "TP", "MDP", "IVP"]
# Extra series computed for the sensitivity of the tangency portfolio to the
# expected-return estimator (hidden by default in the interface).
EXTRA_STRATEGIES = ["TP_SAMPLE"]

# ------------------------------------------------------------- Monkeys
N_MONKEYS = 100
MONKEY_SIZES = [10, 30, 50]
MONKEY_SEEDS = [1, 2, 3]

# ---------------------------------------------------------- universe rules
MIN_UNIVERSE = 30              # no decision with fewer eligible stocks
LIQ_LOOKBACK_DAYS = 63         # trailing trading days for liquidity screens
LIQ_MIN_MEDIAN_VALUE = 50_000  # CHF, median daily traded value (close × volume)
LIQ_MAX_ZERO_VOLUME = 0.50     # max share of days without volume
STALE_MAX_DAYS = 7             # last trade at most 7 calendar days before month-end
PRICE_MIN = 0.001              # CHF; below = placeholder value (e.g. 0.0001)
PRICE_MAX = 999_000.0          # CHF; above = placeholder value (e.g. 999999.9999)
# Daily spike filter: a move of at least ×SPIKE_UP (or ÷SPIKE_UP) that is undone
# within SPIKE_REVERT_DAYS rows (back within ±SPIKE_TOL of the pre-spike level).
SPIKE_UP = 3.0
SPIKE_REVERT_DAYS = 5
SPIKE_TOL = 0.25
# Unreverted one-day level break (×25 or ÷25): history before it is a placeholder.
LEVEL_BREAK = 25.0
# Monthly reversal flag (Ince & Porter, 2006): r_t > 300 % and the two-month
# return below 50 % → both months unusable for estimation.
REVERSAL_UP = 3.0
REVERSAL_TWO_MONTH = 0.5
# Same ISIN, two tickers: duplicate when daily returns coincide on most common days.
DUP_MIN_COMMON_DAYS = 20
DUP_MIN_IDENTICAL = 0.85
CROSS_DUP_MIN_MONTHS = 24
CROSS_DUP_MIN_IDENTICAL = 0.80
# Names that identify instruments that are not ordinary shares.
EXCLUDE_NAME_PATTERNS = [r"\bRIGHTS?\b", r"\bANR\b", r"LINIE", r"\bWARRANT", r"\bCPENPO\b"]

# Foreign ISINs are secondary listings unless the company has its primary
# listing on SIX (these are SPI constituents or former constituents).
FOREIGN_PRIMARY_SIX = {
    "AMS": "ams-OSRAM (AT), primary listing on SIX",
    "BMAG": "Bajaj Mobility / PIERER Mobility (AT), primary listing on SIX",
    "PKTM": "PIERER Mobility (AT), primary listing on SIX",
    "KTMI": "KTM Industries (AT), primary listing on SIX",
    "CMHC": "Cosmo Pharmaceuticals (NL), primary listing on SIX",
    "COPN": "Cosmo Pharmaceuticals (NL), primary listing on SIX",
    "LMN": "lastminute.com (NL), primary listing on SIX",
    "NWRN": "Newron Pharmaceuticals (IT), primary listing on SIX",
    "SHLTN": "SHL Telemedicine (IL), primary listing on SIX",
    "SKIN": "Cassiopea (IT), primary listing on SIX",
    "IGPH": "IGEA Pharma (NL), primary listing on SIX",
    "SYST": "Synthes (US-domiciled), primary listing on SIX",
}
# Tickers without ISIN that are foreign secondary listings or not ordinary shares.
EXCLUDE_NO_ISIN = {
    "ASML": "foreign secondary listing", "AVGO": "foreign secondary listing",
    "B": "foreign secondary listing", "GLW": "foreign secondary listing",
    "INTC": "foreign secondary listing", "KHC": "foreign secondary listing",
    "MBG": "foreign secondary listing", "NVDA": "foreign secondary listing",
    "ALV": "foreign secondary listing", "PFE": "foreign secondary listing",
    "VW": "foreign secondary listing", "VW-V": "foreign secondary listing",
    "YHOO": "foreign secondary listing", "DSFIR": "primary listing in Amsterdam",
    "KEDA": "GDR of a Chinese company", "CFRAO": "not an ordinary share line",
    "CSGN1": "subscription rights",
}

# ---------------------------------------------------------- optimisation
RIDGE = 1e-4                   # sample covariance: Σ + RIDGE·tr(Σ)/N·I (N ≥ T: singular)
TOL = 1e-10
MAX_ITER = 5_000

# ---------------------------------------------------------- factors / rf
JKP_FACTORS = {
    "SMB": ("market_equity", "market capitalisation (small − big)"),
    "HML": ("be_me", "book equity / market equity (value − growth)"),
    "RMW": ("ope_be", "operating profit / book equity (robust − weak)"),
    "CMA": ("at_gr1", "annual growth in total assets (conservative − aggressive)"),
    "MOM": ("ret_12_1", "return from t−12 to t−1 (winners − losers)"),
}
JKP_MIN_STOCKS = 30            # months with fewer stocks in a factor are dropped (as in Empirical-Asset-Pricing)
SURVIVORSHIP_MIN_DELISTINGS = 5  # a year is "covered" when the data hold at least this many delistings

# Subperiods used by the robustness tab: chosen from economic history, not from
# the results (no data snooping); empty intersections are reported as such.
REGIMES = [
    ("Dot-com bust", "2000-04", "2003-03"),
    ("Pre-crisis expansion", "2003-04", "2007-06"),
    ("Global financial crisis", "2007-07", "2009-03"),
    ("Euro crisis & SNB floor", "2009-04", "2015-01"),
    ("Negative rates", "2015-02", "2020-01"),
    ("COVID-19", "2020-02", "2021-12"),
    ("Inflation & rate hikes", "2022-01", "2023-12"),
    ("Recent", "2024-01", "2099-12"),
]
