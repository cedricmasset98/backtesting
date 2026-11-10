# Swiss Equity Portfolio Lab

Interactive comparison of eight portfolio strategies on Swiss equities — Market-Cap Weighted
(SPI total return), Equally-Weighted, Global Minimum Variance, Equal Risk Contribution,
Tangency, Most Diversified, Inverse Volatility and 100 random "Malkiel's monkeys" —
backtested walk-forward in CHF, with performance, risk, factor (CAPM → FF5+MOM),
efficient-frontier, composition and robustness analyses.

Site: **https://cedricmasset.ch/backtesting/** (project page of the account whose user site uses the
custom domain cedricmasset.ch; published by GitHub Actions once the secret of section 7 is set).

Research and teaching tool, not investment advice.

---

## 1. Architecture

```
cedricmasset98/market-data (PRIVATE)          cedricmasset98/backtesting (PUBLIC)
  EODHD prices (SW, INDX, FOREX)                 pipeline/   Python, runs in GitHub Actions only
  SNB rates, JKP & French factors     ──read──▶    data.py → backtest.py → monkeys.py → build.py
                                       only        privacy.py checks every output
                                                   │ derived results only (JSON)
                                                   ▼
                                                 public/data/  (never committed)
                                                   │
                                                 src/ TypeScript + Vite + Plotly (static site)
                                                   │ costs, statistics, regressions, bootstrap
                                                   ▼
                                                 GitHub Pages
```

| Layer | Where | What |
|---|---|---|
| Private pipeline | `pipeline/` (Python, CI) | Loads and cleans the private data, builds the point-in-time universe, estimates covariances and expected returns, optimises, simulates drift, turnover and delistings, draws the monkeys, computes ex ante frontiers. |
| Derived results | `public/data/*.json` (built in CI, git-ignored) | Monthly portfolio returns and turnover, concentration statistics, top-10 holdings at year-end snapshots, ex ante frontiers, monkeys returns, market and factor series, manifest. |
| Static app | `src/` (TypeScript, Vite) | Transaction costs, period selection, all statistics, factor regressions (OLS / HC3 / Newey-West), rolling estimates, bootstrap tests, charts, CSV / PNG / SVG exports, URL state, and a plain-language report (Report & Methodology tab) generated from the computed results for the default settings (the site as it opens) — no hard-coded figures, so it follows data updates — downloadable as a PDF built in the browser (`src/ui/pdf.ts`: standard Helvetica fonts, glyph widths from the Adobe AFM files via `tools/gen_pdf_metrics.py`, no dependency). |
| CI/CD | `.github/workflows/deploy.yml` | Read-only checkout of market-data, tests, pipeline, statsmodels references, type check, TS tests, build, publication. Any failing test stops the deployment. |

**Licence of the data.** EODHD forbids redistributing raw prices. The private repository is checked
out read-only in CI, deleted before the site is built, and never reaches the browser. The site only
receives portfolio-level results. `pipeline/privacy.py` fails the build if a published file has a
raw-data field (close, volume…), if a holdings snapshot lists more than ten positions, or if a
published return series equals a single stock's monthly returns for 12 consecutive months.
Two design decisions follow from this:

* **No full weight history is published.** With the weights of the hundreds of published portfolios
  and their returns, one could solve for every stock's monthly return. The composition tab shows
  concentration statistics, ex ante risk contributions and the ten largest positions at year-end.
* **No uncapped configuration.** An unconstrained optimiser can hold one stock for a year (this
  happened with GMV); its return series would then disclose that stock's returns. The loosest
  published weight cap is 25 % (at least four holdings).

**Interactivity vs computation vs confidentiality.** The optimisations need individual returns,
so they cannot run in the browser. The pipeline precomputes the full grid

| Parameter | Precomputed values |
|---|---|
| Estimation window | 12, 36, 60, 120 months |
| Rebalancing | monthly, quarterly (calendar quarter-ends), annual (December) |
| Covariance | sample + ridge ("standard"), Ledoit-Wolf shrinkage |
| Weight cap | 25 %, 10 %, 5 % |
| Monkeys | K = 10, 30, 50 stocks × seeds 1, 2, 3 |

i.e. 24 weight runs × 3 schedules and 108 monkey sets. In the browser:

* **transaction costs** (any value) are applied to the published turnover:
  1 + r<sub>net</sub> = (1 − c·TO<sub>t</sub>)(1 + r<sub>gross</sub>). This is exact because the weights,
  hence the turnover, do not depend on c;
* **the evaluation period** is a slice of the precomputed walk-forward series: portfolios keep the
  weights chosen at their own decision dates, nothing is re-optimised with later information;
* **anything else** (another window, cap, universe rule, estimator) requires a pipeline run: add
  the value to `pipeline/config.py` (`WINDOWS`, `CAPS`, …) and run the workflow. Values outside
  the grid are not selectable in the interface; no result is ever simulated or interpolated.

The alternative — a server with the private data that re-optimises on demand — would allow
any parameter but needs a running backend holding licensed data, authentication and rate limits;
the static design costs nothing to host and keeps the data in one private place.

## 2. Data

| Data | Source (market-data) | Notes |
|---|---|---|
| Swiss stocks, active and delisted | EODHD `data/eodhd/SW` | `adjusted_close` (splits and dividends) = total return in CHF |
| SPI total return | EODHD `SSHI.INDX` | SIX's SPI is a performance index (dividends reinvested) |
| Risk-free rate | SNB `snbgwdzid`, `zimoma` | daily SARON compounded ACT/360 since Sep 2009; previous month-end SARON × days/360 from Jul 1999; 3-month GMBF before |
| Factors | JKP `che_all_factors.csv` | market_equity → SMB, be_me → HML, ope_be → RMW, at_gr1 → CMA, ret_12_1 → MOM; USD → CHF with F(1 + s) |
| USD/CHF | EODHD `USDCHF.FOREX` | month-end, factor conversion only |

### Universe (point in time)

1. **Security filter.** Common stocks traded in CHF; foreign ISINs only for companies whose primary
   listing is SIX (ams-OSRAM, Cosmo, Newron…, list in `config.py`); rights, second trading lines
   and foreign secondary listings (GE, NVIDIA, Pfizer…) excluded.
2. **Duplicates.** Same ISIN under two tickers with identical daily returns (Holcim LHN/HOLN,
   Dufry/Avolta, Georg Fischer, Helvetia, …), and tickers with identical monthly return histories
   under different ISINs: one ticker kept (active first, then longest history — the rule of
   `market-data/scripts/panels.py`).
3. **Cleaning — ex post corrections kept apart from point-in-time filters.**
   *Ex post vendor-error corrections* (documented cleaning hypothesis, rows removed, never filled):
   placeholder prices (≤ 0.001 or ≥ 999,000 CHF, a row-local test) and the history before an
   unreverted ×25 level break (this one uses later rows by construction; 3 stocks).
   *Point-in-time filters*: one-day ×3 spikes are only flagged and ignored once their reversal
   (≤ 5 trading days) has been observed — a month-end spike enters that month's decision as
   published; Ince-Porter monthly reversals (> 300 % then back) make the two months unusable for
   estimation only from the month the reversal is observed (`data.estimation_window`). Realised
   returns use the corrected prices (a vendor spike is not a traded price), so the valuation of a
   month can be revised a few days later; decisions never are.
4. **Eligibility at month-end t.** Price in month t and a trade within 7 days of month-end; median
   daily traded value over the last 63 trading days ≥ CHF 50,000 and ≤ 50 % days without volume;
   a complete window of monthly returns (no gap, no filling). At least 30 eligible stocks per decision.
5. **Suspensions and delistings (point in time).** A month without any price inside the listing
   life is valued at the last price (0 % return) but is not an estimation return. A holding without
   any price during a whole month — delisting or suspension, indistinguishable at that date — earns
   0 % that month, is written off at its last price at the month-end and the proceeds are
   reinvested pro rata (counted in turnover). The final listing date is never used. There is no
   delisting return beyond the last price (takeover premia and bankruptcy losses are both missed).

This is a reconstructed universe of Swiss-listed stocks, **not** the historical SPI constituents
(not available). The cap-weighted strategy is the official SPI series: free-float capitalisations
are not in the data, so no replication is claimed.

### Survivorship

The market-data README says delisted stocks start in 2012; in the files there is one delisting
in 2012, one in 2015, then 9–13 per year from 2017. The pipeline measures this (first year with
≥ 5 delistings) and the site's default evaluation period starts there (January 2017). This is a
**reduced-bias** sample, not a bias-free one: the threshold is a heuristic and the coverage has not
been checked against an independent register of SIX listings and delistings. The
**Full history** button next to the period extends the sample to everything the data allow (from
1996 with the 12-month window to 2005 with the 120-month window): a banner then warns that the
results carry survivorship bias until 2017 and the affected years are shaded on the time charts;
**Reduced bias** returns to the default.

## 3. Strategies

All portfolios are long-only, fully invested, unlevered and capped (25 / 10 / 5 %).

| | Rule | Implementation |
|---|---|---|
| CW | SPI total return | official index series, no costs |
| EW | w<sub>i</sub> = 1/N | over the eligible universe |
| GMV | min w'Σw | short SPG run + exact primal active-set QP (KKT checked) |
| ERC | w<sub>i</sub>(Σw)<sub>i</sub> equal | Newton on min ½y'Σy − (1/N)Σ ln y<sub>i</sub> (Spinu 2013); equal variance contributions ⇔ equal volatility contributions. With a binding cap: risk budgeting under bounds — capped stocks at the cap with a contribution ≤ λ, all others with exactly equal contributions λ (active set; for fixed λ₀ a convex log-barrier problem, λ₀ adjusted so that Σw = 1); binding frequency reported in the Composition tab |
| TP | max (w'μ − r<sub>f</sub>)/√(w'Σw) | μ: Bayes-Stein (Jorion 1986) towards the GMV mean; pseudo-concave ⇒ KKT point = global max; λ-iteration with exact QPs. If no portfolio has positive expected excess return: GMV, flagged |
| TP (sample μ) | same with sample means | sensitivity to the expected-return estimator |
| MDP | max w'σ/√(w'Σw) | same solver as TP (Choueifaty & Coignard 2008) |
| IVP | w<sub>i</sub> ∝ 1/σ<sub>i</sub> | |
| Monkeys | K random stocks, equal weights | re-drawn at each rebalancing date from the same eligible universe; seed (seed, monkey, yyyymm) |

Caps: constraint inside the optimisation for GMV/TP/MDP/ERC; excess redistributed pro rata
("water filling") for EW/IVP.

Covariance: *Ledoit-Wolf* (2004) shrinkage towards constant correlation (diagonal unchanged), or
*sample* covariance + 10<sup>−4</sup>·tr(S)/N ridge — the sample matrix is singular in every
configuration because N (≈ 140–200 stocks) exceeds T (12–120 months). Bayes-Stein always uses the
Ledoit-Wolf matrix.

Timing: decision at the close of month t with data up to t, returns from t+1. Weights are computed
every month (and reused by the quarterly and annual schedules, which simply ignore off-schedule
decisions); between trades they drift, w<sub>i</sub> ← w<sub>i</sub>(1 + r<sub>i</sub>)/(1 + r<sub>p</sub>).
Turnover TO = Σ|w<sub>target</sub> − w<sub>before</sub>| (buys + sells); the initial purchase is not
charged so that sub-periods are comparable. All strategies of a configuration share the same first
decision and the same out-of-sample months.

## 4. Statistics and formulas

Monthly simple returns, wealth V<sub>t</sub> = 100 ∏(1 + r<sub>s</sub>), drawdown V<sub>t</sub>/max V − 1.
CAGR = (V<sub>T</sub>/100)<sup>12/n</sup> − 1; arithmetic annual return 12·mean; volatility s·√12
(n − 1); standard error of the mean s/√n (monthly — not a risk measure); downside deviation
√mean(min(R − R<sub>f</sub>, 0)²)·√12; historical VaR/CVaR 95/99 % on monthly returns (linear
quantiles); skewness and excess kurtosis from biased moments; Sharpe = mean(R − R<sub>f</sub>)/sd·√12;
Sortino = 12·mean(R − R<sub>f</sub>)/DD; Calmar = CAGR/|MDD|; IR = 12·mean(R − R<sub>SPI</sub>)/TE,
TE = sd(R − R<sub>SPI</sub>)·√12; beta on SPI excess returns. Relative performance = 100·V/V<sup>SPI</sup>.

Factor models (monthly): CAPM, FF3, Carhart-4, FF5, FF5+MOM on R<sub>p</sub> − R<sub>f</sub>, with MKT = SPI − R<sub>f</sub>
and the Swiss JKP factors. Sample: months where the portfolio, R<sub>f</sub> and all factors of the model exist
(JKP currently ends in December 2025). Inference: classical OLS (t, n − k df), HC3, or Newey-West
(Bartlett, L = ⌊4(n/100)<sup>2/9</sup>⌋, no small-sample correction) with normal inference. Each coefficient
is shown with its t (or z) statistic below it, stars at 10/5/1 %, standard errors, p-values, 95 % CI,
R², adjusted R², n. Diagnostics: Jarque-Bera, Breusch-Pagan (Koenker), Ljung-Box, Q-Q plot.
Attribution: mean(R − R<sub>f</sub>) = α̂ + Σβ̂<sub>k</sub>·mean(F<sub>k</sub>) (exact in-sample).

Universe vs weighting: strategy − SPI = (EW − SPI) + (strategy − EW) in CAGR. The first term mixes
the reconstructed universe and equal weighting (small-cap tilt) against the official cap-weighted
index; only the second isolates the weighting rule (Overview and Risk & Return tabs).

Model selection: the default configuration was fixed before looking at the results and nothing is
selected afterwards. Choosing the best of the 72 configurations from these results would be data
snooping and would need its own validation period (nested walk-forward); the site says so.

Robustness: Sharpe heatmaps window × frequency and covariance × cap on a common sample; cost
scenarios 0–100 bp; regimes fixed in advance in `config.py`; stationary bootstrap (paired months,
mean block 6, 2,000 draws, fixed seed) of Sharpe differences against the SPI and EW with Holm
adjustment.

## 5. Tests

| Suite | Command | Covers |
|---|---|---|
| Python | `python -m pytest pipeline/tests` | projection on the capped simplex (vs bisection); GMV, TP, MDP, ERC, IVP against closed forms; optimality under caps; singular covariances; Ledoit-Wolf against a loop transcription of the paper; Bayes-Stein; **no look-ahead** on the panel (perturbing future returns and listings leaves every earlier weight and return unchanged, all strategies, all schedules) and **end to end from raw daily CSV files** (`test_end_to_end.py`: different prices and delistings after a cut-off, a month-end spike that reverts only in one copy, an Ince-Porter reversal only in one copy — cleaning, eligibility, estimation windows and weights up to the cut-off are identical); capped ERC KKT conditions; weights only earn later returns; complete-window eligibility; drift and turnover by hand; costs on traded value only; delisting liquidation and reinvestment; common sample; monkeys reproducibility, seeds, independence from later data; cleaning rules; SARON compounding; JKP conversion; privacy checks; numpy OLS vs statsmodels |
| TypeScript | `npm test` | statistics vs numpy/scipy (CAGR, volatility, VaR, CVaR, skewness, kurtosis, Sharpe, Sortino, IR, TE, beta…); drawdowns within [−100 %, 0 %]; compounding; costs; bootstrap reproducibility; Holm; factor sample rule and unavailable factors; attribution identity; **regression engine vs statsmodels** (5 models × OLS/HC3/HAC, coefficients, SE, t, p, CI, R², diagnostics) on synthetic data and on the published strategy returns |

`python -m pipeline.statsref` writes `tests/reference/statsmodels_factor.json`. With
`STRICT_REFERENCE=1` (CI) the reference must come from statsmodels and include the published
returns, otherwise the tests fail. Failing tests block the deployment.

## 6. Local development

```bash
# next to this repository: a clone of the private data repository
git clone https://github.com/cedricmasset98/market-data ../market-data
python -m pip install -r requirements.txt
python -m pytest -q pipeline/tests
python -m pipeline.build --jobs 4        # full grid, ~10 min on 4 cores (or --quick: one configuration)
python -m pipeline.statsref
npm ci
npm test && npm run typecheck
npm run dev                               # http://localhost:5173
```

`MARKET_DATA_DIR` and `OUT_DIR` override the default paths.

## 7. Publication (GitHub Pages)

1. Create a fine-grained personal access token: *Repository access* → only `cedricmasset98/market-data`,
   *Permissions* → *Contents: Read-only*. Add it to this repository as the Actions secret
   **`MARKET_DATA_TOKEN`** (Settings → Secrets and variables → Actions).
2. Settings → Pages → *Source: GitHub Actions*.
3. Push to `main` or run the workflow by hand. The workflow also runs on the 6th of each month.

Vite uses a relative base (`base: './'`) and the app fetches `./data/…`: the site works under any
sub-path. Results are cached per (market-data commit, pipeline code); *Run workflow → rebuild*
forces a full recomputation.

**Data updates.** Update market-data (its own workflows), then rerun this workflow; the header of the
site shows the last data date and the build date. The EODHD subscription was taken for one month:
after it ends, the stock data stop at the last extraction, while SNB and JKP series keep updating.

## 8. Limitations

* Strong survivorship bias before 2017 (delistings missing), reduced but not eliminated afterwards;
  no delisting returns beyond the last price.
* The level-break correction (3 stocks) is an ex post cleaning hypothesis.
* Reconstructed universe, not SPI constituents; no free-float caps (no replicated CW, no size screen).
* Month-end execution at closing prices; proportional costs, no market impact.
* JKP factors approximate Fama-French factors; they end in December 2025.
* Fixed grid; other settings need a pipeline run.
* Comparisons are descriptive: the monkeys distribution depends on its drawing rules, and ten years
  of monthly data give bootstrap tests little power.

## 9. Reuse

`src/engine/{linalg,ols,distributions,diagnostics,rolling}.ts` and `pipeline/olsref.py` come unchanged
from [Empirical-Asset-Pricing](https://github.com/cedricmasset98/Empirical-Asset-Pricing) (validated
against statsmodels there); FF5+MOM is added in `src/engine/factors.ts`. The visual language follows
that site.

## References

Choueifaty & Coignard (2008), *Toward Maximum Diversification*. DeMiguel, Garlappi & Uppal (2009), *Optimal
versus naive diversification*. Fama & French (1993, 2015); Carhart (1997). Ince & Porter (2006), *Individual
equity return data from Thomson Datastream*. Jensen, Kelly & Pedersen (2023), *Is there a replication crisis
in finance?* Jorion (1986), *Bayes-Stein estimation for portfolio analysis*. Ledoit & Wolf (2004), *Honey, I
shrunk the sample covariance matrix*. Maillard, Roncalli & Teïletche (2010), *Equally-weighted risk
contribution portfolios*. Malkiel (1973), *A Random Walk Down Wall Street*. Newey & West (1987, 1994).
Politis & Romano (1994), *The stationary bootstrap*. Spinu (2013), *An algorithm for computing risk parity
weights*.
