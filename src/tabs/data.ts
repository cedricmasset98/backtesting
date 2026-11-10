/** Data & Methodology: sources, universe construction, conventions, limitations, build information. */

import { baseLayout, draw } from '../ui/charts.ts';
import type { Ctx } from '../ui/context.ts';
import { escapeHtml, num } from '../ui/format.ts';

export function renderData(c: Ctx): void {
  const { m, theme: t } = c;
  const u = m.universe;
  const cfg = m.configs.find((x) => x.window === c.s.window && x.cov === c.s.cov && x.cap === c.s.cap);
  const commit = m.market_data_commit ? m.market_data_commit.slice(0, 10) : 'unknown';
  c.root.innerHTML = `
  <section class="card report-link">
    <div><h2>Results report</h2>
    <p class="muted small">PDF of the default configuration (${m.default.window}-month window, ${({ M: 'monthly', Q: 'quarterly', A: 'annual' } as const)[m.default.freq]} rebalancing, ${m.survivorship.controlled_start ?? ''} – ${m.last_complete_month}), typeset with LaTeX from the same results as this site, built ${escapeHtml(m.generated_at.slice(0, 10))}.</p></div>
    <a class="button primary" href="./report/swiss_equity_portfolio_lab_report.pdf" target="_blank" rel="noopener">Open the report (PDF)</a>
  </section>
  <section class="card prose">
    <h2>Data &amp; Methodology</h2>
    <p class="muted small">Results built on ${escapeHtml(m.generated_at)} from market-data commit <code>${commit}</code>; prices up to ${m.data_last_date}, last complete month ${m.last_complete_month}. Build time ${Math.round(m.build_seconds / 60)} min. Privacy check: <strong>${m.privacy?.status ?? 'n/a'}</strong> (${m.privacy?.files_checked ?? 0} files).</p>

    <h3>1. Sources</h3>
    <table class="data"><thead><tr><th>Series</th><th>Source</th><th>Use</th></tr></thead><tbody>
      <tr><td>Swiss stocks (active and delisted)</td><td>EODHD, exchange SW — private repository <code>market-data</code>; adjusted close (splits and dividends) = total return in CHF</td><td>Universe, estimation, portfolio returns. Never published.</td></tr>
      <tr><td>SPI total return</td><td>EODHD <code>${m.benchmark.ticker}</code> (${m.benchmark.first} – ${m.benchmark.last}), month-end levels</td><td>CW benchmark, market factor. Monthly returns published.</td></tr>
      <tr><td>Swiss risk-free rate</td><td>Swiss National Bank (data.snb.ch): ${m.risk_free.segments.map((g) => `${g.start} – ${g.end}: ${escapeHtml(g.method)}`).join('; ')}</td><td>Excess returns, Sharpe ratios, tangency portfolio</td></tr>
      <tr><td>Factors</td><td>Global Factor Data, Jensen, Kelly &amp; Pedersen (2023), Switzerland, capped value weights, USD → CHF with EODHD USD/CHF month-ends</td><td>Factor regressions</td></tr>
    </tbody></table>
    <p>Splice checks (overlapping periods): ${Object.entries(m.risk_free.checks).map(([k, v]) => `${k.replace(/_/g, ' ')}: corr. ${num(v.corr, 3)}, mean difference ${num(v.mean_diff_annual * 100, 2)} pt p.a. (n = ${v.n})`).join('; ')}.</p>
    <table class="data"><thead><tr><th>Factor</th><th>JKP characteristic</th><th>Definition</th><th>Available</th></tr></thead><tbody>
      ${Object.entries(m.factors).map(([k, f]) => `<tr><td>${k}</td><td><code>${f.jkp_characteristic}</code></td><td>${escapeHtml(f.label)}</td><td>${f.first} – ${f.last} (${f.n} months)</td></tr>`).join('')}
    </tbody></table>
    <p>JKP factors are long-short tercile portfolios signed towards the high-expected-return leg; they approximate, but do not replicate, Fama-French factors (different breakpoints, weighting and characteristic definitions). Long-short factors convert to CHF as F<sup>CHF</sup> = F<sup>USD</sup>(1 + s) with s the monthly change of USD/CHF; a total return converts as (1 + R)(1 + s) − 1. Months with fewer than 30 stocks in a factor are dropped.</p>

    <h3>2. Universe</h3>
    <p>${u.candidates} share lines on SIX in the EODHD list; ${u.included} kept after removing ${u.excluded.length} non-CHF lines, foreign secondary listings, rights and second trading lines;
    ${u.dropped_duplicates.length} duplicated tickers removed (same security under two codes); ${u.no_price_data.length} without prices. Panel: <strong>${u.stocks_in_panel} stocks, ${u.delisted_in_panel} delisted</strong>.
    This is a <strong>reconstructed universe of Swiss-listed stocks</strong>, not the historical SPI constituent list, which is not available.</p>
    <p>Eligibility at each month-end t (point in time): a price in month t and a trade within ${u.rules.stale_max_days} days of month-end; median daily traded value over the last ${u.rules.liq_lookback_days} trading days ≥ CHF ${u.rules.liq_min_median_value_chf.toLocaleString('en')} and at most ${u.rules.liq_max_zero_volume * 100} % of days without volume;
    a complete window of monthly returns (no missing month, no filling). At least ${u.rules.min_universe} eligible stocks are required for a decision.</p>
    <p><strong>Cleaning — two kinds of treatment, kept apart.</strong></p>
    <ul class="plain">
      <li><strong>Ex post corrections of vendor errors</strong> (a cleaning hypothesis applied once to the whole history; rows removed, never filled): ${u.cleaning.invalid_rows.toLocaleString('en')} rows with placeholder prices (≤ ${u.rules.price_min} or ≥ ${u.rules.price_max.toLocaleString('en')} CHF — a row-local test that uses no later data) and ${u.cleaning.level_break_rows.toLocaleString('en')} rows before an unreverted ×${u.rules.level_break} level break (${Object.entries(u.cleaning.by_code).filter(([, v]) => v.level_break_rows).map(([k]) => k).join(', ') || 'none'}): this rule does use later rows, because a placeholder history can only be recognised once the real price level appears.</li>
      <li><strong>Point-in-time filters</strong> (each decision uses only what was known at its date): ${u.cleaning.spike_rows} rows of one-day spikes of ×${u.rules.spike_up} undone within ${u.rules.spike_revert_days} trading days are flagged; a spike is ignored only once its reversal has been observed, so a month-end spike enters the decision of that month as published${u.spike_months_affecting_last_return !== undefined ? ` (${u.spike_months_affecting_last_return} stock-months concerned)` : ''}. Monthly reversals (> ${u.rules.reversal_up * 100} % then back below +${u.rules.reversal_two_month * 100} % over two months, Ince &amp; Porter 2006) make both months unusable for estimation only from the month the reversal is observed (${u.reversal_months_flagged} cases in the data).</li>
      <li>Realised (valuation) returns use the corrected prices: a vendor spike is not a price at which anyone traded. The return of a month can therefore be revised when a spike at its end is detected a few days later; decisions are never revised.</li>
    </ul>
    <p>A month without any price inside a listing (suspension) is valued at the last price (zero return) but is not a usable estimation return.</p>
    <details><summary>Excluded lines (${u.excluded.length}) and duplicates (${u.duplicates_same_isin.length + u.duplicates_cross.length} pairs checked)</summary>
      <table class="data compact"><thead><tr><th>Code</th><th>Name</th><th>Reason</th></tr></thead><tbody>${u.excluded.map((e) => `<tr><td>${escapeHtml(e.code)}</td><td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.reason)}</td></tr>`).join('')}</tbody></table>
      <table class="data compact"><thead><tr><th>Kept</th><th>Other ticker</th><th>Evidence</th><th>Duplicate?</th></tr></thead><tbody>
      ${u.duplicates_same_isin.map((d) => `<tr><td>${d.kept}</td><td>${d.dropped}</td><td>same ISIN ${d.isin}; identical daily returns on ${(d.identical_return_share * 100).toFixed(1)} % of ${d.common_days} common days</td><td>${d.is_duplicate ? 'yes, removed' : 'no, both kept'}</td></tr>`).join('')}
      ${u.duplicates_cross.map((d) => `<tr><td>${d.kept}</td><td>${d.dropped}</td><td>identical monthly returns on ${(d.identical_return_share * 100).toFixed(1)} % of ${d.common_months} common months</td><td>yes, removed</td></tr>`).join('')}
      </tbody></table></details>

    <h3>3. Survivorship</h3>
    <div id="ch-delist" class="chart short"></div>
    <p>The data hold delisted stocks only from ${m.survivorship.first_covered_year ?? '—'} (first year with at least five delistings). The market-data README mentions 2012; in the files, 2012–2016 contain ${[2012, 2013, 2014, 2015, 2016].reduce((a, y) => a + (m.survivorship.delistings_by_year[String(y)] ?? 0), 0)} delisting(s).
    The default evaluation period therefore starts in ${m.survivorship.controlled_start}: a <strong>reduced-bias</strong> sample, not a bias-free one. The five-delisting threshold is a heuristic; the coverage has not been checked against an independent register of SIX listings and delistings, and some delistings may still be missing. "Full history" shows the earlier years with a warning.</p>
    <p>Delistings are handled point in time. A holding without any price during a whole month (a delisting or a suspension — they cannot be told apart at that date) earns 0 % that month, is written off at its last price at the month-end and the proceeds are reinvested pro rata (counted in turnover). The final listing date is never used. No delisting return is available beyond the last price: takeovers (often at a premium) and bankruptcies (often worse than the last price) are both valued at the last trade.</p>

    <h3>4. Strategies</h3>
    <ul class="plain">
      <li><strong>CW</strong> — SPI total return index (official series, no costs). Not a replicated portfolio.</li>
      <li><strong>EW</strong> — w<sub>i</sub> = 1/N over the eligible universe.</li>
      <li><strong>GMV</strong> — min w'Σw.</li>
      <li><strong>ERC</strong> — w<sub>i</sub>(Σw)<sub>i</sub> equal for all i (equal contributions to variance, equivalently to volatility); Newton solution of min ½y'Σy − (1/N)Σ ln y<sub>i</sub>. With a binding cap: risk budgeting under bounds — capped stocks at the cap with a contribution not above the common one, all other stocks with exactly equal contributions (active set + Newton). The Composition tab reports how often the cap binds.</li>
      <li><strong>TP</strong> — max (w'μ − r<sub>f</sub>)/√(w'Σw), μ = Bayes-Stein (Jorion, 1986): shrinkage of the sample means towards the GMV mean with intensity φ = λ/(T + λ). If no portfolio has a positive expected excess return, TP holds GMV (flagged). Sensitivity: the same problem with sample means (TP sample μ).</li>
      <li><strong>MDP</strong> — max w'σ/√(w'Σw) (Choueifaty &amp; Coignard, 2008).</li>
      <li><strong>IVP</strong> — w<sub>i</sub> ∝ 1/σ<sub>i</sub>.</li>
      <li><strong>Monkeys</strong> — 100 random equally weighted portfolios of K stocks. <em>Kept</em> (default): the stocks are kept as long as they remain eligible and only those that leave the universe are replaced by new random draws, equal weights being restored at each rebalancing date; <em>Redrawn</em>: K new stocks at each rebalancing date (much higher turnover). Monkeys tab.</li>
    </ul>
    <p>All portfolios are long-only, fully invested, without leverage, with a weight cap of ${Object.keys(m.grid.caps).join(', ')} % (GMV, TP, MDP, ERC: constraint in the optimisation; EW, IVP: excess above the cap redistributed pro rata). No uncapped configuration is published: an unconstrained optimiser can hold one stock, whose return would then be disclosed.
    Optimisations use an exact projection on the capped simplex, spectral projected gradient and a primal active-set QP solver (KKT conditions checked); the ratio problems (TP, MDP) are pseudo-concave so first-order points are global maxima.
    Covariance: <em>Ledoit-Wolf</em> shrinkage to constant correlation (2004), or <em>sample</em> covariance + ridge 10<sup>−4</sup>·tr(S)/N — needed because N &gt; T in every configuration (the sample matrix is singular). Bayes-Stein always uses the Ledoit-Wolf matrix.</p>
    ${cfg ? `<p class="muted small">Current configuration: first decision ${cfg.first_decision}, ${cfg.n_decisions} monthly decisions, TP fallbacks ${cfg.tp_fallbacks}, solver: ${Object.entries(cfg.solver).map(([k, v]) => `${k} ${v}`).join(', ')}.</p>` : ''}

    <h3>5. Timing, rebalancing and costs</h3>
    <p>Decision at the close of month t with data up to t; weights earn returns from t+1. Weights are computed every month; quarterly and annual schedules trade at calendar quarter-ends and year-ends (and at the first decision) and let weights drift otherwise: w<sub>i</sub> ← w<sub>i</sub>(1 + r<sub>i</sub>)/(1 + r<sub>p</sub>).
    Turnover TO<sub>t</sub> = Σ<sub>i</sub>|w<sub>i,target</sub> − w<sub>i,before</sub>| (buys + sells). Net return: 1 + r<sup>net</sup> = (1 − c·TO<sub>t</sub> − S<sub>t</sub>)(1 + r<sup>gross</sup>), with c a fixed cost in basis points of traded value (commission and stamp duty; default ${m.default.bps ?? 10} bp) and S<sub>t</sub> = Σ<sub>i</sub>|Δw<sub>i</sub>|·s<sub>i,t</sub>/2 the cost of crossing half the bid-ask spread of each traded stock (can be switched off).
    The spread s<sub>i,t</sub> is estimated from daily close, high and low prices with the Abdi &amp; Ranaldo (2017) estimator over the last ${u.rules.liq_lookback_days} trading days ending at t (no later data). Because one stock's estimate is noisy, the stocks are split at each month-end into ${m.costs?.spread_groups ?? 10} groups of median daily traded value and each stock is assigned the median estimate of its group, so that the spread falls with liquidity.
    Because weights do not depend on costs, the browser recomputes net returns exactly. The initial purchase is not charged, so that every sub-period is comparable. Market impact is not modelled.</p>
    ${m.costs ? `<table class="data compact"><thead><tr><th>Liquidity group</th>${m.costs.groups.map((g) => `<th>${g.group}</th>`).join('')}</tr></thead><tbody>
      <tr><th scope="row">Median daily traded value (CHF)</th>${m.costs.groups.map((g) => `<td>${g.median_daily_value_chf === null ? '—' : Math.round(g.median_daily_value_chf).toLocaleString('en')}</td>`).join('')}</tr>
      <tr><th scope="row">Estimated spread (median over time)</th>${m.costs.groups.map((g) => `<td>${g.median_spread === null ? '—' : (g.median_spread * 100).toFixed(2) + ' %'}</td>`).join('')}</tr></tbody></table>
      <p class="muted small">Groups 1 (least liquid) to ${m.costs.spread_groups} over all listed stocks, before the eligibility screens; medians over all month-ends.</p>` : ''}
    <p>
    Changing the evaluation period never re-optimises: the portfolios keep the weights chosen at their own decision dates.</p>
    <p>Automatic tests (pipeline/tests) check that altering future returns or listings leaves every earlier decision and return unchanged, for every strategy and schedule; that monkeys draws are reproducible and independent of later data; and that the published files contain no raw price field and no return series equal to a single stock's.</p>

    <h3>6. Statistics</h3>
    <p>Monthly simple returns; CAGR = (V<sub>T</sub>/V<sub>0</sub>)<sup>12/n</sup> − 1; arithmetic annualised return 12 × mean; volatility s × √12 (n − 1 divisor); standard error of the mean s/√n (monthly).
    Downside deviation √(mean(min(R − R<sub>f</sub>, 0)²)) × √12. Historical VaR/CVaR at 95/99 % on monthly returns (linear-interpolated quantiles). Skewness and excess kurtosis from biased moments.
    Sharpe = mean(R − R<sub>f</sub>)/sd × √12; Sortino = 12 mean(R − R<sub>f</sub>)/DD; Calmar = CAGR/|MDD|; IR = 12 mean(R − R<sub>SPI</sub>)/TE, TE = sd(R − R<sub>SPI</sub>)√12; beta on SPI excess returns.</p>
    <p>Regressions: OLS with classical, HC3 or Newey-West (Bartlett, L = ⌊4(n/100)<sup>2/9</sup>⌋, no small-sample correction) covariances; t (classical) or normal (robust) inference; Jarque-Bera, Breusch-Pagan (Koenker) and Ljung-Box (min(12, n/5) lags) tests.
    The engine is the one of Empirical-Asset-Pricing and is checked against statsmodels in CI on synthetic data and on the published strategy returns. Bootstrap: stationary bootstrap of paired months (mean block 6), Holm correction.</p>

    <h3>7. Limitations</h3>
    <ul class="plain">
      <li>Strong survivorship bias before ${m.survivorship.controlled_start}, reduced (not eliminated) afterwards; no delisting returns beyond the last traded price.</li>
      <li>The difference with the SPI mixes a universe effect and a weighting effect; only strategy − EW isolates the weighting rule (Overview, Risk &amp; Return).</li>
      <li>Reconstructed universe, not SPI constituents; no free-float capitalisations, hence no replicated cap-weighted portfolio and no size-based liquidity screen.</li>
      <li>Liquidity is screened on traded value, and costs include an estimated half-spread, but trades are assumed at month-end closing prices with proportional costs only (no market impact). For thinly traded stocks the last close may be stale: monthly returns of portfolios holding them are autocorrelated (Report: Dimson betas and Lo Sharpe ratios).</li>
      <li>JKP factors are approximations of Fama-French factors and end in ${Object.values(m.factors).map((f) => f.last).sort()[0]}.</li>
      <li>The grid of windows, frequencies, covariances and caps is fixed; other settings require a pipeline run.</li>
      <li>The comparisons are descriptive. The monkeys distribution depends on the drawing rules; bootstrap tests have low power over ten years.</li>
    </ul>

    <h3>8. Published files and privacy</h3>
    <p>${Object.keys(m.files).length} JSON files (${(Object.values(m.files).reduce((a, b) => a + b, 0) / 1e6).toFixed(1)} MB): portfolio returns and turnover, concentration statistics, ten largest positions at year-end snapshots, ex ante frontiers, monkeys returns. Portfolio-months with fewer than 3 holdings: ${m.privacy?.portfolio_months_with_fewer_than_3_holdings ?? 'n/a'}.</p>
  </section>`;

  const years = Object.keys(m.survivorship.delistings_by_year);
  draw(document.getElementById('ch-delist'), [{ x: years, y: years.map((y) => m.survivorship.delistings_by_year[y]), type: 'bar', marker: { color: t.color.EW }, hovertemplate: '%{x}: %{y} delisted stocks<extra></extra>' }],
    baseLayout(t, { showlegend: false, bargap: 0.3, xaxis: { title: { text: 'Year of the last price' }, type: 'category' }, yaxis: { title: { text: 'Delisted stocks in the data' } } }));
}
