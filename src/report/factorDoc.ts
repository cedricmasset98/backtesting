/**
 * Methodological note on the regression factors (results report, "Factor analysis").
 *
 * Static text, checked against:
 *   - Jensen, Kelly and Pedersen (2023), "Is There a Replication Crisis in Finance?",
 *     Journal of Finance, Section II.A (tercile sorts, non-micro breakpoints, capped
 *     value weights, sign convention, one-month holding, four-month accounting lag, USD);
 *   - the JKP "Global Factor Data" documentation (characteristic formulas, sign and
 *     original reference of each characteristic; betabab_1260d = corr_1260d × rvol_252d
 *     / mktvol_252d, correlation on overlapping three-day excess returns);
 *   - this repository: pipeline/config.py (JKP_FACTORS, JKP_MIN_STOCKS) and
 *     pipeline/data.py (weighting "vw_cap", F_CHF = F_USD (1 + s)).
 * The characteristic codes are read from the manifest; if they ever differ from the
 * documented ones the report fails rather than describing the wrong factors
 * (tests/report.test.ts also checks the pipeline constants).
 */

import type { Manifest } from '../data/types.ts';
import type { FactorId } from '../engine/factors.ts';
import type { Block } from './blocks.ts';

/** JKP characteristic documented below for each long-short factor (pipeline/config.py JKP_FACTORS). */
export const JKP_CHARACTERISTIC: Record<Exclude<FactorId, 'MKT'>, string> = {
  SMB: 'market_equity', HML: 'be_me', RMW: 'ope_be', CMA: 'at_gr1', MOM: 'ret_12_1', BAB: 'betabab_1260d',
};
/** Months with fewer stocks in a factor are dropped (pipeline/config.py JKP_MIN_STOCKS). */
export const JKP_MIN_STOCKS = 30;
/** JKP weighting scheme used (pipeline/data.py). */
export const JKP_WEIGHTING = 'vw_cap';

const code = (s: string) => `$\\texttt{${s.replace(/_/g, '\\_')}}$`;

export function factorMethodology(m: Manifest): Block[] {
  for (const [k, c] of Object.entries(JKP_CHARACTERISTIC)) {
    const got = m.factors?.[k]?.jkp_characteristic;
    if (got !== undefined && got !== c) throw new Error(`report: factor ${k} uses ${got}, but the methodology documents ${c} (src/report/factorDoc.ts)`);
  }
  const ch = (k: keyof typeof JKP_CHARACTERISTIC) => code(JKP_CHARACTERISTIC[k]);
  return [
    { kind: 'h3', text: 'The factors' },
    {
      kind: 'p',
      text: `**Common construction.** Apart from the market, the factors come from the Swiss file of the global factor database of Jensen, Kelly and Pedersen (2023, JKP). Each month, Swiss stocks are sorted into terciles of one characteristic, with breakpoints computed on non-micro stocks (market capitalisation above the 20th percentile of NYSE stocks); micro-caps are then assigned with the same breakpoints. Within each tercile, stocks are weighted by their market capitalisation capped at the NYSE 80th percentile, which limits both the weight of micro-caps and the dominance of the largest companies (Nestlé, Novartis, Roche). The factor is long the tercile that the original paper associates with the highest expected return and short the opposite tercile, held for one month; accounting data are lagged four months and returns are in USD. The lab uses these capped value-weighted series (${code(JKP_WEIGHTING)}), drops months in which the file reports fewer than ${JKP_MIN_STOCKS} stocks for a factor, and converts them to CHF with $F^{\\text{CHF}}_t = F^{\\text{USD}}_t\\,(1 + s_t)$, $s_t$ being the monthly change of USD/CHF: for a zero-investment portfolio whose two legs are converted at the same rate, this recovers the CHF long–short return exactly.`,
    },
    {
      kind: 'table',
      label: 'tab:factors',
      caption: 'Factors of the regressions',
      head: ['Factor', 'Characteristic', 'Long leg', 'Short leg', 'Original paper (cited by JKP)'],
      align: 'lllll',
      rows: [
        ['MKT', 'SPI total return (not JKP)', 'Market', 'Risk-free rate', 'CAPM'],
        ['SMB', ch('SMB'), 'Small', 'Large', 'Banz (1981)'],
        ['HML', ch('HML'), 'High book-to-market', 'Low book-to-market', 'Rosenberg et al. (1985)'],
        ['RMW', ch('RMW'), 'High profitability', 'Low profitability', 'Fama and French (2015)'],
        ['CMA', ch('CMA'), 'Low asset growth', 'High asset growth', 'Cooper et al. (2008)'],
        ['MOM', ch('MOM'), 'Past winners', 'Past losers', 'Jegadeesh and Titman (1993)'],
        ['BAB', ch('BAB'), 'Low beta', 'High beta', 'Frazzini and Pedersen (2014)'],
      ],
      note: `For the six JKP factors, the legs are the top and bottom terciles of the characteristic, capped value-weighted and rebalanced monthly. The factor names follow the Fama–French and Frazzini–Pedersen factors they approximate.`,
    },
    {
      kind: 'bullets',
      items: [
        `**MKT (market).** Reward for bearing aggregate, non-diversifiable equity risk (CAPM). Built as the SPI total return (capitalisation-weighted, dividends reinvested, CHF) minus $R_f$, without any sort. It is deliberately not a JKP series, so that the market factor is the CW benchmark itself; the Fama–French market factor is the value-weighted return of US listed stocks minus the one-month Treasury bill.`,
        `**SMB (size).** Historical premium of small over large companies (Banz, 1981), read either as compensation for distress and illiquidity risk or as mispricing. JKP sorts on ${ch('SMB')} (price × shares outstanding): long the smallest tercile, short the largest. Fama and French (1993) average six portfolios from independent 2 × 3 sorts on size (NYSE median) and book-to-market, rebalanced each June; the single JKP sort does not neutralise the value tilt of small caps.`,
        `**HML (value).** Premium of cheap stocks (high book equity relative to market value) over expensive ones, attributed to distress risk or to investors over-extrapolating past growth. JKP sorts on ${ch('HML')}, book equity (Fama–French 1993 definition) over market equity: long high, short low. Fama and French use the market equity of the previous December and rebalance annually; JKP use the most recent price (Asness and Frazzini, 2013) and rebalance monthly.`,
        `**RMW (profitability).** Premium of firms with high operating profitability: at a given valuation, higher expected profits imply a higher expected return (Novy-Marx, 2013; Fama and French, 2015). JKP sorts on ${ch('RMW')}, operating profit (EBITDA minus interest expense) over book equity, i.e. the Fama–French (2015) variable: long high, short low. The difference lies in the portfolios (single tercile sort with the latest accounts, versus annual 2 × 3 sorts with size).`,
        `**CMA (investment).** Premium of firms that grow their assets slowly over those that invest aggressively: a high cost of capital discourages investment (q-theory), and aggressive investment may also be overvalued. JKP sorts on ${ch('CMA')}, the one-year growth of total assets (Cooper, Gulen and Schill, 2008): long low growth (conservative), short high growth (aggressive). Fama and French (2015) use the same variable over the last fiscal year, in annual 2 × 3 sorts with size.`,
        `**MOM (momentum).** Tendency of the past year's winners to keep outperforming past losers for a few months (Jegadeesh and Titman, 1993), usually attributed to under-reaction to news. JKP sorts on ${ch('MOM')}, the return from $t-12$ to $t-1$, which skips the last month to avoid short-term reversal: long winners, short losers. The formation window is that of the Carhart (1997) and Fama–French UMD factors; UMD uses 2 × 3 sorts with size and 30th/70th percentile breakpoints.`,
        `**BAB (low beta).** Low-beta anomaly: investors who cannot or will not use leverage tilt towards high-beta stocks, which flattens the security market line, so that low-beta stocks earn more than the CAPM implies (Black, 1972; Frazzini and Pedersen, 2014). JKP sorts on ${ch('BAB')}, the Frazzini–Pedersen beta $\\hat\\beta_i = \\hat\\rho_{i,m}\\,\\hat\\sigma_i / \\hat\\sigma_m$, with the correlation estimated on overlapping three-day excess returns over 1,260 trading days (about five years) and the volatilities on the last 252 daily excess returns, against the Swiss market return of the JKP database: long the low-beta tercile, short the high-beta tercile.`,
      ],
    },
    {
      kind: 'p',
      text: `**BAB is the furthest from its original.** The factor of Frazzini and Pedersen (2014) shrinks betas towards one, rank-weights all stocks into a low- and a high-beta portfolio and rescales each leg to a beta of one, $r_{\\text{BAB}} = (r_L - r_f)/\\beta_L - (r_H - r_f)/\\beta_H$, so that it is market-neutral ex ante. The JKP factor used here is dollar-neutral, not beta-neutral: its short leg has the higher estimated beta, so its ex ante market beta is negative and its loading can only be read together with $\\beta_{\\text{MKT}}$. Its capped value weights also avoid the implicit small-stock tilt of rank weighting (Novy-Marx and Velikov, 2022), and its betas are measured against the JKP Swiss market return rather than the SPI. The JKP documentation does not mention shrinkage, but a common shrinkage towards one preserves the ranking of betas and would not change the terciles. “BAB” is therefore a convenient label for a low-minus-high beta factor, not a replication of BAB.`,
    },
    {
      kind: 'p',
      text: `**Verified and approximate.** Verified: the construction rules above against Jensen, Kelly and Pedersen (2023, Journal of Finance, Section II.A); the characteristic definitions, signs and original papers of Table [[tab:factors]] against the JKP documentation (Global Factor Data); the series, weighting, ${JKP_MIN_STOCKS}-stock filter, CHF conversion and market factor against this lab's code. Approximate: the six JKP factors proxy for, but do not replicate, the Fama–French, Carhart and Frazzini–Pedersen factors, so the loadings below are not directly comparable with published estimates on those factors. Not documented by JKP: the weighting of the market return used for the betas.`,
    },
  ];
}
