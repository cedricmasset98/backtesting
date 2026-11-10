/**
 * Results report of the default configuration (the site as it opens).
 *
 * Every number, sentence, table and chart is computed from the published
 * results (nothing hard-coded), so the report follows data updates. The blocks
 * are typeset with LaTeX at deploy time (tools/build_report.ts, src/report/latex.ts).
 *
 * Text conventions: `$…$` is LaTeX math (passed through), `**…**` bold,
 * `[[label]]` a cross-reference; everything else is plain text and escaped.
 */

import type { MonkeyMode, MonkeysFile, SeriesId, StrategiesFile } from '../data/types.ts';
import { holm, sharpeDiffBootstrap } from '../engine/bootstrap.ts';
import { breuschPagan, defaultLjungBoxLags, jarqueBera, ljungBox } from '../engine/diagnostics.ts';
import { fitModel, FACTORS, laggedMarketSensitivity, MODEL_IDS, MODELS, type FitOutcome, type ModelId } from '../engine/factors.ts';
import { cumulativeCosts, drawdowns, mean, netReturns, percentileRank, perfStats, quantile, sd, wealth } from '../engine/metrics.ts';
import { configKey } from '../data/loader.ts';
import { dimsonFit, loSharpe } from '../engine/stale.ts';
import { availableRange, buildView, wealthDates } from '../model.ts';
import { SHORT } from '../ui/labels.ts';
import { configLabel, decomposition, periodLabel, basisLabel, stats, type ReportCtx } from '../ui/context.ts';
import { num, pct, signedPct, stars } from '../ui/format.ts';

export type ChartSpec =
  | { type: 'line'; x: string[]; series: { name: string; color: string; y: number[]; dash?: boolean; width?: number }[]; yFormat: 'num' | 'pct'; yTitle: string; height?: number; refY?: number }
  | { type: 'dots'; categories: string[]; colors: string[]; value: number[]; low: number[]; high: number[]; xFormat: 'num' | 'pct'; xTitle: string; refX?: number }
  | { type: 'hist'; values: number[]; bins: number; color: string; label: string; markers: { name: string; color: string; x: number }[]; xFormat: 'num' | 'pct'; xTitle: string };

export type Block =
  | { kind: 'title'; text: string; subtitle: string }
  | { kind: 'meta' | 'note' | 'warn' | 'h2' | 'h3' | 'p'; text: string }
  | { kind: 'eq'; tex: string; label?: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'table'; label: string; caption: string; head: string[]; rows: string[][]; sub?: boolean[]; starred?: boolean; note?: string }
  | { kind: 'figure'; label: string; caption: string; chart: ChartSpec; note?: string };

/** Fixed light palette (same order as the site). */
export const COLOR: Record<SeriesId, string> = {
  CW: '#52514e', EW: '#2a78d6', GMV: '#eb6834', ERC: '#1baf7a', TP: '#eda100', MDP: '#e87ba4', IVP: '#008300', MONKEYS: '#6250d6', TP_SAMPLE: '#eda100',
};

const L = String.raw;
const fp = (p: number) => (p < 0.001 ? '$<0.001$' : num(p, 3));
const t2 = (t: number) => `(${num(t, 2)})`;
/** Coefficient with significance stars that do not shift the column alignment. */
const st = (v: string, p: number) => (stars(p) ? L`${v}$\mathrlap{^{${stars(p)}}}$` : v);

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

type OkFit = Extract<FitOutcome, { ok: true }>;

export interface ReportLoaders {
  strategies: (key: string) => Promise<StrategiesFile>;
  monkeys: (mode: MonkeyMode) => Promise<MonkeysFile | null>;
}

export async function reportBlocks(c: ReportCtx, load: ReportLoaders): Promise<Block[]> {
  const { view, s, m } = c;
  const strategies = (['EW', 'GMV', 'ERC', 'TP', 'MDP', 'IVP'] as SeriesId[]).filter((id) => view.series.has(id));
  const hasMk = view.series.has('MONKEYS');
  const portfolios: SeriesId[] = [...strategies, ...(hasMk ? (['MONKEYS'] as SeriesId[]) : [])];
  const all: SeriesId[] = ['CW', ...portfolios];
  const ps = (id: SeriesId) => stats(c, id);
  const spi = ps('CW');
  const S = (id: SeriesId) => SHORT[id];
  const controlled = m.survivorship.controlled_start;
  const biased = !!controlled && view.period[0] < controlled;
  const fdata = { months: c.market.months, rf: c.market.rf, factors: c.market.factors };
  const cap = L`${s.cap}\,\%`; // math mode
  const capT = `${s.cap} %`; // text

  // ---- inference on Sharpe ratios
  const ex = (id: SeriesId) => view.series.get(id)!.r.map((x, i) => x - view.rf[i]);
  const boots = strategies.map((id) => sharpeDiffBootstrap(ex(id), ex('CW'), { seed: 101 }));
  const bootAdj = holm(boots.map((b) => b.pvalue));

  // ---- factor models
  const fits = new Map<SeriesId, Record<ModelId, FitOutcome>>();
  for (const id of portfolios) {
    const r = {} as Record<ModelId, FitOutcome>;
    for (const mod of MODEL_IDS) r[mod] = fitModel(view.months, view.series.get(id)!.r, fdata, mod, 'HAC');
    fits.set(id, r);
  }
  const main = (['FF5MOMBAB', 'FF5MOM', 'FF5', 'CARHART', 'FF3', 'CAPM'] as ModelId[]).find((mod) => portfolios.every((id) => fits.get(id)![mod].ok)) ?? null;
  const mainFit = (id: SeriesId) => fits.get(id)![main!] as OkFit;
  const alphaAdj = main ? holm(strategies.map((id) => mainFit(id).result.pvalue[0])) : [];

  // ---- robustness over windows × frequencies
  let robust: { id: SeriesId; wins: number; total: number; min: number; med: number; max: number }[] = [];
  let robustPeriod = '';
  let spiRobust = NaN;
  try {
    const files = await Promise.all(m.grid.windows.map((w) => load.strategies(configKey(w, s.cov, s.cap))));
    const ranges = files.map((f) => availableRange(f, c.market));
    const start = [s.start, ...ranges.map((r) => r[0])].sort().at(-1)!;
    const end = [s.end, ...ranges.map((r) => r[1])].sort()[0];
    robustPeriod = `${start} – ${end}`;
    const sr = new Map<SeriesId, number[]>(strategies.map((id) => [id, []]));
    for (const f of files) {
      for (const fq of m.grid.freqs) {
        const v = buildView(f, c.market, null, { ...s, freq: fq, start, end });
        spiRobust = perfStats(v.series.get('CW')!.r, v.rf, v.spi).sharpe;
        for (const id of strategies) sr.get(id)!.push(perfStats(v.series.get(id)!.r, v.rf, v.spi).sharpe);
      }
    }
    robust = strategies.map((id) => {
      const x = sr.get(id)!;
      return { id, wins: x.filter((v) => v > spiRobust).length, total: x.length, min: Math.min(...x), med: quantile(x, 0.5), max: Math.max(...x) };
    });
  } catch {
    robust = [];
  }

  // ---- monkeys (and the other drawing rule, for comparison)
  const mk = view.monkeys.r.map((r) => perfStats(r, view.rf, view.spi));
  const otherMode: MonkeyMode = s.mkMode === 'keep' ? 'redraw' : 'keep';
  const otherFile = await load.monkeys(otherMode).catch(() => null);
  const otherView = otherFile ? buildView(c.strat, c.market, otherFile, { ...s, mkMode: otherMode }) : null;

  // ---- stale prices: Dimson betas and Lo Sharpe ratios
  const mktEx = view.spi.map((x, i) => x - view.rf[i]);
  const stale = all.map((id) => {
    const e = ex(id);
    const lo = loSharpe(e);
    return { id, lo, dim: id === 'CW' ? null : dimsonFit(e, mktEx, 1, 'HAC'), vol: Math.sqrt(12) * sd(view.series.get(id)!.r) };
  });

  const blocks: Block[] = [
    { kind: 'title', text: 'Swiss Equity Portfolio Lab', subtitle: 'Results report — default configuration' },
    { kind: 'meta', text: `${configLabel(c)} · ${periodLabel(c)} · ${basisLabel(c)} · monkeys: $K = ${s.k}$, seed ${s.seed}. Data up to ${m.data_last_date}; results built ${m.generated_at.slice(0, 10)}.` },
    { kind: 'note', text: 'Generated automatically from the published results of the default configuration of the site; every figure updates with the data. Historical and descriptive results, not investment advice.' },
  ];
  if (biased) blocks.push({ kind: 'warn', text: `The period starts before ${controlled}: the results before that date carry a strong survivorship bias.` });

  // 1. Summary
  const higher = strategies.filter((id) => ps(id).sharpe > spi.sharpe);
  const signif = strategies.filter((_, i) => bootAdj[i] < 0.05);
  const sigAlpha = main ? strategies.filter((_, i) => alphaAdj[i] < 0.05) : [];
  const allWin = robust.filter((r) => r.wins === r.total).map((r) => r.id);
  const minVol = [...strategies].sort((a, b) => ps(a).vol - ps(b).vol)[0];
  blocks.push(
    { kind: 'h2', text: 'Main results' },
    {
      kind: 'bullets',
      items: [
        `**Returns.** The SPI total return earned ${pct(spi.cagr, 1)} p.a.; the strategies earned between ${pct(Math.min(...strategies.map((id) => ps(id).cagr)), 1)} and ${pct(Math.max(...strategies.map((id) => ps(id).cagr)), 1)} p.a. net of costs${hasMk ? `, the average monkey portfolio ${pct(ps('MONKEYS').cagr, 1)}` : ''} (Table [[tab:perf]]).`,
        `**Risk.** ${list(strategies.filter((id) => ps(id).vol < spi.vol).map(S)) || 'No strategy'} had a lower volatility than the SPI (${pct(spi.vol, 1)}); the lowest was ${S(minVol)} (${pct(ps(minVol).vol, 1)}, maximum drawdown ${pct(ps(minVol).maxDD, 1)} vs ${pct(spi.maxDD, 1)}).`,
        `**Risk-adjusted performance.** ${higher.length ? `${list(higher.map((id) => `${S(id)} (${num(ps(id).sharpe, 2)})`))} had a higher Sharpe ratio than the SPI (${num(spi.sharpe, 2)})` : `No strategy had a higher Sharpe ratio than the SPI (${num(spi.sharpe, 2)})`}; ${signif.length ? `the difference is significant at 5 % after the Holm correction for ${list(signif.map(S))}` : 'none of the differences is significant at 5 % after the Holm correction'} (Table [[tab:sharpe]]).`,
        main
          ? `**Factor model (${MODELS[main].label}).** Market betas range from ${num(Math.min(...strategies.map((id) => mainFit(id).result.beta[1])), 2)} to ${num(Math.max(...strategies.map((id) => mainFit(id).result.beta[1])), 2)}; ${sigAlpha.length ? `the alpha is significant after the Holm correction for ${list(sigAlpha.map((id) => `${S(id)} (${signedPct(12 * mainFit(id).result.beta[0], 1)} p.a.)`))}` : 'no alpha is significant after the Holm correction'} (Tables [[tab:ff]] and [[tab:holm]]).`
          : '**Factor model.** Not estimable over the period.',
        (() => {
          const g = stale.filter((x) => x.dim).sort((a, b) => (b.dim!.betaSum - b.dim!.capm.beta[1]) - (a.dim!.betaSum - a.dim!.capm.beta[1]))[0];
          if (!g) return '';
          const rhos = stale.filter((x) => x.dim).map((x) => x.lo.rho);
          return `**Stale prices.** Monthly autocorrelations of the strategies lie between ${num(Math.min(...rhos), 2)} and ${num(Math.max(...rhos), 2)}. The largest lagged market exposure is that of ${S(g.id)}: Dimson beta ${num(g.dim!.betaSum, 2)} against a CAPM beta of ${num(g.dim!.capm.beta[1], 2)}, Lo Sharpe ratio ${num(g.lo.sharpe, 2)} against ${num(ps(g.id).sharpe, 2)} (Table [[tab:stale]]).`;
        })(),
        robust.length ? `**Robustness.** Over the ${robust[0].total} window $\\times$ frequency combinations (${robustPeriod}), ${allWin.length ? `${list(allWin.map(S))} had a higher Sharpe ratio than the SPI in all of them` : 'no strategy had a higher Sharpe ratio than the SPI in all of them'} (Table [[tab:robust]]).` : '',
      ].filter(Boolean),
    },
  );

  // 2. Design
  const el = m.universe.eligible[String(s.window)];
  const k0 = m.universe.months.indexOf(view.period[0]);
  const k1 = m.universe.months.indexOf(view.period[1]);
  const nEl = el.slice(k0, k1 + 1);
  blocks.push(
    { kind: 'h2', text: 'Data and design' },
    { kind: 'p', text: `**Universe.** Swiss-listed ordinary shares from EODHD (${m.universe.stocks_in_panel} stocks, of which ${m.universe.delisted_in_panel} delisted), screened at each month-end for listing, liquidity (median daily traded value $\\geq$ CHF ${m.universe.rules.liq_min_median_value_chf.toLocaleString('en')}) and a complete ${s.window}-month return history: between ${Math.min(...nEl)} and ${Math.max(...nEl)} eligible stocks per decision date. Benchmark (CW): SPI total return index. Risk-free rate $R_f$: SARON and its predecessors (SNB). Factors: Swiss Jensen–Kelly–Pedersen (JKP) factors converted to CHF.` },
    { kind: 'p', text: `**Walk-forward design.** At the end of month $t$ the weights are computed with the ${s.window} monthly returns up to $t$ only and held from $t+1$; rebalancing ${({ M: 'every month', Q: 'at calendar quarter-ends', A: 'every December' } as const)[s.freq]}, weights drifting in between. All portfolios are long-only and fully invested with a cap $\\bar w = ${cap}$, i.e. ${L`$w \in \mathcal{W} = \{w : \mathbf{1}^\top w = 1,\ 0 \le w_i \le \bar w\}$`}. With $\\hat\\Sigma_t$ the ${s.cov === 'lw' ? 'Ledoit–Wolf (constant-correlation) shrinkage' : 'sample (ridge-regularised)'} covariance matrix, $\\hat\\sigma_t$ the vector of volatilities and $\\hat\\mu_t$ the Bayes–Stein expected returns:` },
    {
      kind: 'eq',
      tex: L`\begin{aligned}
&\text{GMV:} && \min_{w \in \mathcal{W}} \; w^\top \hat\Sigma_t w
&&\text{TP:} && \max_{w \in \mathcal{W}} \; \frac{w^\top \hat\mu_t - R_{f,t}}{\sqrt{w^\top \hat\Sigma_t w}} \\[4pt]
&\text{MDP:} && \max_{w \in \mathcal{W}} \; \frac{w^\top \hat\sigma_t}{\sqrt{w^\top \hat\Sigma_t w}}
&&\text{ERC:} && w_i (\hat\Sigma_t w)_i = w_j (\hat\Sigma_t w)_j \ \text{for all uncapped } i, j \\[4pt]
&\text{IVP:} && w_i \propto 1/\hat\sigma_{i,t}
&&\text{EW:} && w_i = 1/N_t
\end{aligned}`,
    },
    { kind: 'p', text: `For EW and IVP the excess above the cap is redistributed pro rata. **Transaction costs.** Each rebalancing pays a fixed cost $c = ${s.bps}$ bp of the traded value (commission and stamp duty) ${s.spread ? 'and half of the estimated bid-ask spread $s_{i,t}$ of each traded stock' : '(the estimated bid-ask spread is switched off in this configuration)'}, with turnover $\\mathrm{TO}_t$ (buys plus sells):` },
    {
      kind: 'eq',
      label: 'eq:net',
      tex: L`1 + R^{\text{net}}_{t} = \Bigl(1 - c\,\mathrm{TO}_t - ${s.spread ? '' : '\\underbrace{'}\sum_i \bigl|\Delta w_{i,t}\bigr| \tfrac{s_{i,t}}{2}${s.spread ? '' : '}_{=\\,0}'}\Bigr)\bigl(1 + R^{\text{gross}}_{t}\bigr), \qquad \mathrm{TO}_t = \sum_i \bigl|\Delta w_{i,t}\bigr| = \sum_i \bigl| w^{\text{target}}_{i,t} - w^{\text{drift}}_{i,t} \bigr|.`,
    },
    { kind: 'p', text: `The spread is estimated from daily closing, high and low prices with the Abdi and Ranaldo (2017) estimator over the $D$ pairs of consecutive days among the ${m.universe.rules.liq_lookback_days} trading days ending at $t$, with $c_\\tau$ the log close and $\\eta_\\tau$ the mid-range of the log high and low:` },
    { kind: 'eq', label: 'eq:ar', tex: L`\hat s^{\,2}_{i,t} = \frac{4}{D}\sum_{\tau} \bigl(c_{\tau} - \eta_{\tau}\bigr)\bigl(c_{\tau} - \eta_{\tau+1}\bigr), \qquad \eta_\tau = \tfrac{1}{2}\bigl(\ln H_\tau + \ln L_\tau\bigr).` },
    { kind: 'p', text: `One stock's estimate is noisy; at each month-end the stocks are therefore split into ${m.costs?.spread_groups ?? 10} groups of median daily traded value and each stock is charged the median $\\sqrt{\\max(\\hat s^{\\,2}, 0)}$ of its group${m.costs ? `, from ${pct(m.costs.groups[m.costs.groups.length - 1].median_spread ?? NaN, 2)} for the most liquid group to ${pct(m.costs.groups[0].median_spread ?? NaN, 2)} for the least liquid one (medians over time)` : ''}; a zero estimate means a spread of a few basis points, below the precision of the estimator and covered by the fixed cost. Market impact is not modelled.` },
  );

  // 3. Performance and risk
  const dates = wealthDates(view.months);
  const line = (fn: (r: number[]) => number[], yFormat: 'num' | 'pct', yTitle: string, extra: Partial<Extract<ChartSpec, { type: 'line' }>> = {}): ChartSpec => ({
    type: 'line',
    x: dates,
    yFormat,
    yTitle,
    series: all.map((id) => ({ name: S(id), color: COLOR[id], y: fn(view.series.get(id)!.r), width: id === 'CW' ? 1.8 : 1, dash: id === 'MONKEYS' })),
    ...extra,
  });
  blocks.push(
    { kind: 'h2', text: 'Performance and risk' },
    { kind: 'p', text: L`Statistics use monthly simple returns $R_t$ over $n$ months and the excess returns $x_t = R_t - R_{f,t}$ (mean $\bar x$, standard deviation $s_x$):` },
    {
      kind: 'eq',
      label: 'eq:stats',
      tex: L`\mathrm{CAGR} = \Bigl(\prod_{t=1}^{n} (1 + R_t)\Bigr)^{12/n} - 1, \qquad \mathrm{SR} = \sqrt{12}\,\frac{\bar x}{s_x}, \qquad \mathrm{Sortino} = \frac{12\,\bar x}{\sqrt{12}\,\sqrt{\tfrac{1}{n}\sum_t \min(x_t, 0)^2}}.`,
    },
    {
      kind: 'table',
      label: 'tab:perf',
      caption: 'Returns and risk',
      head: ['Portfolio', 'CAGR', L`Mean $\times 12$`, 'Volatility', 'Sharpe', 'Sortino', 'Max DD', 'CVaR 95 %', 'Skewness', '100 CHF →'],
      rows: all.map((id) => {
        const x = ps(id);
        return [S(id), pct(x.cagr, 2), pct(x.arithAnnual, 2), pct(x.vol, 2), num(x.sharpe, 2), num(x.sortino, 2), pct(x.maxDD, 1), pct(x.cvar95, 2), num(x.skew, 2), num(100 * (1 + x.cumulative), 1)];
      }),
      note: `Net of transaction costs (${s.bps} bp fixed${s.spread ? ' plus the estimated half-spread' : ''}, equation [[eq:net]]; the SPI has none). Volatility annualised with $\\sqrt{12}$. CVaR 95 % (expected shortfall): average monthly loss in the worst 5 % of months, reported as a positive number. Last column: final value of 100 CHF invested at the start.`,
    },
    { kind: 'figure', label: 'fig:wealth', caption: 'Cumulative value of 100 CHF', chart: line((r) => wealth(r), 'num', 'Value (CHF)', { refY: 100 }) },
    { kind: 'figure', label: 'fig:dd', caption: 'Drawdowns: fall from the previous peak of cumulative value', chart: line((r) => drawdowns(wealth(r)), 'pct', 'Drawdown (%)', { height: 0.7 }) },
    { kind: 'p', text: L`The difference in CAGR with the SPI is split exactly into a universe effect, which compares the equally weighted reconstructed universe with the cap-weighted index (mostly a size tilt), and a weighting effect that isolates the portfolio rule:` },
    {
      kind: 'eq',
      label: 'eq:decomp',
      tex: L`\mathrm{CAGR}_p - \mathrm{CAGR}_{\text{SPI}} = \underbrace{\bigl(\mathrm{CAGR}_{\text{EW}} - \mathrm{CAGR}_{\text{SPI}}\bigr)}_{\text{universe}} + \underbrace{\bigl(\mathrm{CAGR}_p - \mathrm{CAGR}_{\text{EW}}\bigr)}_{\text{weighting}}.`,
    },
    {
      kind: 'table',
      label: 'tab:spi',
      caption: 'Comparison with the SPI and implementation',
      head: ['Portfolio', 'Beta', 'Track. error', 'Info. ratio', L`$\Delta$CAGR`, 'Universe', 'Weighting', 'Turnover p.a.', 'Cost drag p.a.'],
      rows: portfolios.map((id) => {
        const x = ps(id);
        const d = decomposition(c, id)!;
        const sv = view.series.get(id)!;
        const to = id === 'MONKEYS' ? 12 * mean(view.monkeys.turnover.map((t) => mean(t))) : (12 * sv.turnover.reduce((a: number, b) => a + (b ?? 0), 0)) / view.months.length;
        const drag = stats(c, id, 'gross').cagr - stats(c, id, 'net').cagr;
        return [S(id), num(x.beta, 2), pct(x.trackingError, 1), num(x.infoRatio, 2), signedPct(d.total, 2), signedPct(d.universe, 2), signedPct(d.weighting, 2), `${num(to, 2)}$\\times$`, pct(drag, 2)];
      }),
      note: L`Beta on SPI excess returns; tracking error $\mathrm{TE} = \sqrt{12}\,\mathrm{sd}(R_p - R_{\text{SPI}})$; information ratio $12\,\overline{(R_p - R_{\text{SPI}})}/\mathrm{TE}$. $\Delta$CAGR, universe and weighting effects as in equation [[eq:decomp]]. Turnover: sum of absolute weight changes per year. Cost drag: gross minus net CAGR (fixed cost and spread).`,
    },
  );

  // 4. Inference
  blocks.push(
    { kind: 'h2', text: 'Sharpe ratio differences' },
    { kind: 'p', text: `For each strategy $p$ the test is $H_0\\colon \\mathrm{SR}_p = \\mathrm{SR}_{\\text{SPI}}$. The distribution of $\\widehat{\\mathrm{SR}}_p - \\widehat{\\mathrm{SR}}_{\\text{SPI}}$ is obtained with a stationary bootstrap (Politis and Romano, 1994) of paired months, which keeps the cross-correlation and part of the serial dependence, with ${boots[0]?.reps ?? 2000} resamples, mean block length 6 and a fixed seed. With ${strategies.length} comparisons the p-values are adjusted with the Holm step-down procedure, which controls the family-wise error rate: for ordered p-values $p_{(1)} \\le \\dots \\le p_{(m)}$,` },
    { kind: 'eq', label: 'eq:holm', tex: L`\tilde p_{(k)} = \max_{j \le k} \, \min\bigl\{1,\ (m - j + 1)\, p_{(j)}\bigr\}.` },
    {
      kind: 'table',
      label: 'tab:sharpe',
      caption: 'Sharpe ratio difference with the SPI (stationary bootstrap)',
      head: ['Strategy', 'Sharpe', L`$\Delta$Sharpe`, '95 % CI', 'p-value', 'Holm p-value'],
      rows: strategies.map((id, i) => [S(id), num(ps(id).sharpe, 2), num(boots[i].diff, 2), `[${num(boots[i].low, 2)}; ${num(boots[i].high, 2)}]`, fp(boots[i].pvalue), fp(bootAdj[i])]),
      note: `Annualised Sharpe ratios. SPI Sharpe ratio: ${num(spi.sharpe, 2)}. The interval inverts the same two-sided test: $\\Delta\\widehat{\\mathrm{SR}} \\pm q_{0.95}\\bigl(|\\Delta\\mathrm{SR}^{*} - \\Delta\\widehat{\\mathrm{SR}}|\\bigr)$ over the bootstrap resamples, so it excludes 0 exactly when the p-value is below 5 %.`,
    },
    {
      kind: 'figure',
      label: 'fig:sharpe',
      caption: 'Sharpe ratio difference with the SPI and 95 % bootstrap interval',
      chart: { type: 'dots', categories: strategies.map(S), colors: strategies.map((id) => COLOR[id]), value: boots.map((b) => b.diff), low: boots.map((b) => b.low), high: boots.map((b) => b.high), xFormat: 'num', xTitle: L`$\mathrm{SR}_p - \mathrm{SR}_{\text{SPI}}$ (annualised)`, refX: 0 },
    },
  );

  // 5. Factor analysis
  blocks.push({ kind: 'h2', text: 'Factor analysis' });
  if (main) {
    const f0 = mainFit(strategies[0]);
    const fac = MODELS[main].factors;
    const rhs = fac.map((f) => L`\beta_{\text{${f}}}\,\text{${f}}_t`);
    const split = rhs.length > 3 ? Math.ceil(rhs.length / 2) : rhs.length;
    blocks.push(
      { kind: 'p', text: `Monthly excess returns are regressed on the ${MODELS[main].label} factors: the market factor $\\text{MKT} = R_{\\text{SPI}} - R_f$ and the Swiss JKP long–short factors ${list(fac.filter((f) => f !== 'MKT').map((f) => ({ SMB: 'SMB (size)', HML: 'HML (value)', RMW: 'RMW (profitability)', CMA: 'CMA (investment)', MOM: 'MOM (momentum)', BAB: 'BAB (low beta minus high beta, the JKP version of betting against beta)' } as Record<string, string>)[f] ?? f))}, in CHF. BAB is included because the low-risk strategies (GMV, MDP, IVP) are expected to load on it: without it, the low-beta premium would show up as alpha.` },
      {
        kind: 'eq',
        label: 'eq:ff',
        tex: rhs.length > 3
          ? L`\begin{split} R_{p,t} - R_{f,t} = \alpha_p &+ ${rhs.slice(0, split).join(' + ')} \\ &+ ${rhs.slice(split).join(' + ')} + \varepsilon_{p,t}. \end{split}`
          : L`R_{p,t} - R_{f,t} = \alpha_p + ${rhs.join(' + ')} + \varepsilon_{p,t}.`,
      },
      { kind: 'p', text: `Estimation by OLS over the ${f0.result.n} months with factor data (${f0.sample.months[0]} – ${f0.sample.months.at(-1)}) with Newey–West standard errors (Bartlett kernel, $L = \\lfloor 4 (n/100)^{2/9} \\rfloor = ${f0.result.hacLags}$ lags). The annualised alpha is $12\\,\\hat\\alpha_p$. CW is not reported: MKT is built from the SPI, so its alpha is 0 and its beta 1 by construction.` },
    );
    const rows: string[][] = [];
    const sub: boolean[] = [];
    for (const id of portfolios) {
      const r = mainFit(id).result;
      const get = (name: string) => r.names.indexOf(name);
      const cols = ['alpha', ...FACTORS];
      rows.push([S(id), ...cols.map((n) => (get(n) < 0 ? '' : n === 'alpha' ? st(num(100 * r.beta[0], 2), r.pvalue[0]) : st(num(r.beta[get(n)], 2), r.pvalue[get(n)]))), num(r.r2adj, 2)]);
      sub.push(false);
      rows.push(['', ...cols.map((n) => (get(n) < 0 ? '' : t2(r.stat[get(n)]))), '']);
      sub.push(true);
    }
    blocks.push({
      kind: 'table',
      label: 'tab:ff',
      caption: `${MODELS[main].label} regressions of monthly excess returns`,
      head: ['Portfolio', L`$\hat\alpha$ (% / month)`, ...FACTORS.map((f) => L`$\beta_{\text{${f}}}$`), L`$\bar R^2$`],
      rows,
      sub,
      starred: true,
      note: L`Newey–West $t$-statistics in parentheses. $^{*}\,p<0.10$, $^{**}\,p<0.05$, $^{***}\,p<0.01$ (two-sided).`,
    });

    const rows5: string[][] = [];
    const sub5: boolean[] = [];
    for (const id of portfolios) {
      const f = fits.get(id)!;
      rows5.push([S(id), ...MODEL_IDS.map((mod) => (f[mod].ok ? st(pct(12 * (f[mod] as OkFit).result.beta[0], 2), (f[mod] as OkFit).result.pvalue[0]) : 'n/a'))]);
      sub5.push(false);
      rows5.push(['', ...MODEL_IDS.map((mod) => (f[mod].ok ? t2((f[mod] as OkFit).result.stat[0]) : ''))]);
      sub5.push(true);
    }
    const capm = fits.get(portfolios[0])!.CAPM;
    blocks.push(
      {
        kind: 'table',
        label: 'tab:alpha',
        caption: L`Annualised alpha $12\,\hat\alpha_p$ across the ${['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][MODEL_IDS.length - 1]} factor models`,
        head: ['Portfolio', ...MODEL_IDS.map((mod) => MODELS[mod].label)],
        rows: rows5,
        sub: sub5,
        starred: true,
        note: `${capm.ok ? `CAPM over the ${(capm as OkFit).result.n} months with the SPI and $R_f$; the` : 'The'} multifactor models over the months with JKP factors. Newey–West $t$-statistics in parentheses; stars as in Table [[tab:ff]].`,
      },
      {
        kind: 'figure',
        label: 'fig:alpha',
        caption: `${MODELS[main].label} alpha, annualised, with 95 % confidence interval`,
        chart: { type: 'dots', categories: portfolios.map(S), colors: portfolios.map((id) => COLOR[id]), value: portfolios.map((id) => 12 * mainFit(id).result.beta[0]), low: portfolios.map((id) => 12 * mainFit(id).result.ciLow[0]), high: portfolios.map((id) => 12 * mainFit(id).result.ciHigh[0]), xFormat: 'pct', xTitle: L`$12\,\hat\alpha_p$ (% per year)`, refX: 0 },
      },
      {
        kind: 'table',
        label: 'tab:holm',
        caption: `Alpha significance adjusted for multiple testing and residual diagnostics (${MODELS[main].label})`,
        head: ['Strategy', 'Alpha p.a.', 'p-value', 'Holm p-value', 'Jarque–Bera', 'Breusch–Pagan', 'Ljung–Box'],
        rows: strategies.map((id, i) => {
          const f = mainFit(id);
          const r = f.result;
          return [S(id), signedPct(12 * r.beta[0], 2), fp(r.pvalue[0]), fp(alphaAdj[i]), fp(jarqueBera(r.resid).pvalue), fp(breuschPagan(r.resid, f.sample.x).pvalue), fp(ljungBox(r.resid, defaultLjungBoxLags(r.n)).pvalue)];
        }),
        note: `Holm adjustment (equation [[eq:holm]]) over the ${strategies.length} strategies. The last three columns are p-values of residual tests: normality (Jarque–Bera), heteroskedasticity (Breusch–Pagan, Koenker version) and autocorrelation (Ljung–Box, ${defaultLjungBoxLags(f0.result.n)} lags); the Newey–West standard errors are robust to the last two.`,
      },
    );
    const lowBeta = strategies.filter((id) => mainFit(id).result.beta[1] < 0.85);
    const loads = (name: string) => strategies.filter((id) => { const r = mainFit(id).result; const j = r.names.indexOf(name); return j > 0 && r.pvalue[j] < 0.05 && r.beta[j] > 0; });
    const smb = loads('SMB');
    const bab = loads('BAB');
    const prev = main === 'FF5MOMBAB' ? 'FF5MOM' : null;
    const shift = prev ? strategies.filter((id) => fits.get(id)![prev].ok).map((id) => ({ id, a0: 12 * (fits.get(id)![prev] as OkFit).result.beta[0], a1: 12 * mainFit(id).result.beta[0] })) : [];
    const reading = [
      lowBeta.length ? `${list(lowBeta.map(S))} ${lowBeta.length > 1 ? 'have' : 'has'} a market beta clearly below one, consistent with their lower volatility.` : '',
      smb.length ? `${list(smb.map(S))} ${smb.length > 1 ? 'load' : 'loads'} positively and significantly on SMB: they hold more small and mid caps than the cap-weighted index.` : '',
      main === 'FF5MOMBAB' ? (bab.length ? `${list(bab.map(S))} ${bab.length > 1 ? 'load' : 'loads'} positively and significantly on BAB; ${(() => { const neg = strategies.filter((id) => { const r = mainFit(id).result; const j = r.names.indexOf('BAB'); return j > 0 && r.pvalue[j] < 0.05 && r.beta[j] < 0; }); return neg.length ? `${list(neg.map(S))} ${neg.length > 1 ? 'load' : 'loads'} negatively on it (they hold higher-beta stocks than the low-beta leg), which raises their alpha once BAB is controlled for.` : 'no strategy loads negatively on it.'; })()}` : 'No strategy loads significantly on BAB.') : '',
      shift.length ? `Adding BAB changes the annualised alpha ${list(shift.map((x) => `of ${S(x.id)} from ${signedPct(x.a0, 1)} to ${signedPct(x.a1, 1)}`))} (Table [[tab:alpha]]).` : '',
      sigAlpha.length ? `The alphas of ${list(sigAlpha.map(S))} remain significant after the Holm correction: these strategies earned more than their factor exposures, including the low-beta factor, imply.` : 'No alpha survives the Holm correction.',
      `A significant alpha does not imply a significant Sharpe ratio difference with the SPI (Table [[tab:sharpe]]): the two tests use different benchmarks — a factor-mimicking portfolio with the same exposures, and the index itself. The alphas are also measured with stale prices (next section).`,
    ].filter(Boolean);
    blocks.push({ kind: 'p', text: `**Interpretation.** ${reading.join(' ')}` });
  } else {
    blocks.push({ kind: 'p', text: 'The factor models could not be estimated over the period.' });
  }

  // 5b. Stale prices
  {
    const rows = stale.map((x) => {
      const d = x.dim;
      const ac = d ? 12 * d.capm.beta[0] : NaN;
      const ad = d ? 12 * d.dimson.beta[0] : NaN;
      return [
        S(x.id), num(x.lo.rho, 2), num(ps(x.id).sharpe, 2), num(x.lo.sharpe, 2), pct(x.vol, 1), pct(x.vol * x.lo.volFactor, 1),
        d ? num(d.capm.beta[1], 2) : '', d ? num(d.betaSum, 2) : '',
        d ? st(signedPct(ac, 1), d.capm.pvalue[0]) : '', d ? st(signedPct(ad, 1), d.dimson.pvalue[0]) : '',
      ];
    });
    blocks.push(
      { kind: 'h2', text: 'Thin trading and stale prices' },
      { kind: 'p', text: `Many of the least volatile Swiss stocks (cantonal banks, small real-estate companies) trade on few days, and their last close can be days old. Their monthly returns then react to the market with a delay: the portfolio return is autocorrelated, and the contemporaneous beta and the volatility are too low. Two standard corrections are reported. The Dimson (1979) regression adds the lagged market return, and the summed beta $\\beta_D = \\beta_0 + \\beta_1$ measures the full exposure:` },
      { kind: 'eq', label: 'eq:dimson', tex: L`R_{p,t} - R_{f,t} = \alpha^{D}_p + \beta_0\,\text{MKT}_t + \beta_1\,\text{MKT}_{t-1} + \varepsilon_{p,t}.` },
      { kind: 'p', text: `The Lo (2002) Sharpe ratio replaces the $\\sqrt{12}$ annualisation by $\\eta(12)$, which accounts for the autocorrelation $\\rho_k$ of monthly excess returns (here $\\rho_k = \\hat\\rho_1^{\\,k}$); the same factor gives the corrected annual volatility:` },
      { kind: 'eq', label: 'eq:lo', tex: L`\mathrm{SR}_{\text{Lo}} = \eta(12)\,\frac{\bar x}{s_x}, \qquad \eta(q) = \frac{q}{\sqrt{q + 2\sum_{k=1}^{q-1} (q - k)\,\rho_k}}, \qquad \sigma^{\text{Lo}}_{\text{annual}} = \frac{q}{\eta(q)}\, s.` },
      {
        kind: 'table',
        label: 'tab:stale',
        caption: 'Autocorrelation, Lo Sharpe ratios and Dimson betas',
        head: ['Portfolio', L`$\hat\rho_1$`, 'Sharpe', 'Sharpe (Lo)', 'Volatility', 'Vol. (Lo)', L`$\beta$ CAPM`, L`$\beta_D$ Dimson`, L`$\alpha$ CAPM p.a.`, L`$\alpha$ Dimson p.a.`],
        rows,
        starred: true,
        note: `Monthly excess returns over ${periodLabel(c)}; the CAPM and Dimson regressions use the same months (the first is dropped), with Newey–West standard errors; stars as in Table [[tab:ff]]. A positive $\\hat\\rho_1$ with $\\beta_D > \\beta$ indicates stale prices; the Lo volatility is the volatility implied by the autocorrelation.`,
      },
    );
  }

  // 5c. Matched-sample multifactor diagnostic of delayed market exposure.
  // This is a sensitivity check, not a correction to the underlying prices.
  if (main) {
    const checks = strategies.map((id) => ({
      id,
      check: laggedMarketSensitivity(view.months, view.series.get(id)!.r, fdata, main, 'HAC'),
    }));
    const usable = checks.filter((x) => x.check.base.ok && x.check.lagged.ok);
    if (usable.length) {
      const adjusted = holm(usable.map((x) => (x.check.lagged as OkFit).result.pvalue[0]));
      blocks.push(
        { kind: 'h3', text: 'Multifactor alpha and delayed market exposure' },
        { kind: 'p', text: 'The usual factor regression may misattribute delayed price reactions to alpha. As a sensitivity check, the main factor model (' + MODELS[main].label + ') is re-estimated after adding the preceding calendar month of SPI excess returns. Both the ordinary and lag-augmented regressions use **exactly the same months**. This is an exploratory diagnostic, not proof of stale prices and not a correction to execution prices.' },
        {
          kind: 'table',
          label: 'tab:lagged-factor',
          caption: MODELS[main].label + ': alpha sensitivity to one lag of the market factor',
          head: ['Portfolio', 'Alpha base p.a.', 'Alpha + lag p.a.', 'Holm p (alpha)', 'Lagged MKT beta', 'p (lag)', 'Months'],
          rows: usable.map((x, i) => {
            const a = (x.check.base as OkFit).result;
            const b = (x.check.lagged as OkFit).result;
            const k = b.names.indexOf('MKT_L1');
            return [S(x.id), signedPct(12 * a.beta[0], 2), signedPct(12 * b.beta[0], 2), fp(adjusted[i]), num(b.beta[k], 2), fp(b.pvalue[k]), String(b.n)];
          }),
          note: 'Newey-West standard errors; unadjusted p-value for lagged market loading, Holm-adjusted alpha p-value over the tested strategies. The base column uses the matched sample, not the longer original regression sample. A reduced alpha is consistent with delayed price adjustment but does not establish its cause.',
        },
        { kind: 'p', text: 'Interpret alongside the Dimson and Lo diagnostics in Table [[tab:stale]]. A persistent alpha is still historical evidence, not a prospective trading opportunity; omitted risk factors and valuation conventions remain possible explanations.' },
      );
    }
  }

  // 6. Monkeys
  if (mk.length) {
    const metrics: [string, (x: (typeof mk)[number]) => number, (v: number) => string][] = [
      ['CAGR', (x) => x.cagr, (v) => pct(v, 1)],
      ['Volatility', (x) => x.vol, (v) => pct(v, 1)],
      ['Sharpe', (x) => x.sharpe, (v) => num(v, 2)],
      ['Max drawdown', (x) => x.maxDD, (v) => pct(v, 1)],
    ];
    const sr = mk.map((x) => x.sharpe);
    const mkRow = (label: string, v: typeof view) => {
      const net = v.monkeys.r.map((r) => perfStats(r, v.rf, v.spi));
      const gross = v.monkeys.gross.map((r) => perfStats(r, v.rf, v.spi));
      const to = 12 * mean(v.monkeys.turnover.map((t) => mean(t)));
      const drag = mean(gross.map((g, j) => g.cagr - net[j].cagr));
      const shr = net.map((x) => x.sharpe);
      return [label, `${num(to, 2)}$\\times$`, pct(drag, 2), pct(quantile(net.map((x) => x.cagr), 0.5), 1), num(quantile(gross.map((x) => x.sharpe), 0.5), 2), num(quantile(shr, 0.5), 2), num(quantile(shr, 0.95), 2), num(Math.max(...shr), 2)];
    };
    const mkCompare = (): Block => {
      const rows = [mkRow(s.mkMode === 'keep' ? 'Kept (shown above)' : 'Redrawn (shown above)', view), mkRow(s.mkMode === 'keep' ? 'Redrawn' : 'Kept', otherView!)];
      return { kind: 'table', label: 'tab:mkmode', caption: 'Monkeys: holdings kept or redrawn at each rebalancing date', head: ['Holdings', 'Turnover p.a.', 'Cost drag p.a.', 'Median CAGR', 'Median Sharpe (gross)', 'Median Sharpe', 'P95 Sharpe', 'Max Sharpe'], rows, note: 'Redrawing K stocks at every rebalancing date replaces most of the portfolio and multiplies turnover and costs; keeping the holdings isolates the random selection from the trading.' };
    };
    blocks.push(
      { kind: 'h2', text: "Malkiel's monkeys" },
      { kind: 'p', text: `${mk.length} random portfolios of $K = ${s.k}$ stocks drawn from the same eligible universe (seed ${s.seed}), equally weighted at each rebalancing date and paying the same costs. ${s.mkMode === 'keep' ? 'Each monkey keeps its stocks as long as they remain eligible and replaces only those that leave the universe (delisting, liquidity or history screens) by new random draws: like the strategies, it trades only to rebalance.' : 'Each monkey draws K new stocks at every rebalancing date.'} The percentile of portfolio $p$ for a statistic $X$ is $\\frac{1}{${mk.length}} \\sum_{j} \\mathbf{1}\\{X_j < X_p\\}$.` },
      { kind: 'table', label: 'tab:mk', caption: `Distribution of the ${mk.length} monkey portfolios`, head: ['Statistic', 'Mean', 'P5', 'P25', 'Median', 'P75', 'P95'], rows: metrics.map(([n, f, fmt]) => { const v = mk.map(f); return [n, fmt(mean(v)), fmt(quantile(v, 0.05)), fmt(quantile(v, 0.25)), fmt(quantile(v, 0.5)), fmt(quantile(v, 0.75)), fmt(quantile(v, 0.95))]; }) },
      { kind: 'table', label: 'tab:mkpct', caption: 'Percentile of each portfolio within the monkeys distribution', head: ['Portfolio', 'CAGR', 'Volatility', 'Sharpe', 'Max drawdown'], rows: ['CW', ...strategies].map((id) => [S(id as SeriesId), ...metrics.map(([, f]) => `${Math.round(100 * percentileRank(mk.map(f), f(ps(id as SeriesId))))}`)]), note: 'Share of the monkeys (in %) with a lower value. For volatility a low percentile means less risk; for the maximum drawdown (a negative number) a high percentile means a smaller loss.' },
      ...(otherView && otherView.monkeys.r.length ? [mkCompare()] : []),
      { kind: 'figure', label: 'fig:mk', caption: `Sharpe ratios of the ${mk.length} monkeys and of the portfolios`, chart: { type: 'hist', values: sr, bins: 20, color: COLOR.MONKEYS, label: `Monkeys (${mk.length})`, markers: ['CW', ...strategies].map((id) => ({ name: S(id as SeriesId), color: COLOR[id as SeriesId], x: ps(id as SeriesId).sharpe })), xFormat: 'num', xTitle: 'Sharpe ratio (annualised)' } },
    );
  }

  // 7. Robustness
  blocks.push({ kind: 'h2', text: 'Robustness' });
  if (robust.length) {
    blocks.push({ kind: 'table', label: 'tab:robust', caption: `Sharpe ratio across the ${robust[0].total} window $\\times$ rebalancing combinations (${robustPeriod})`, head: ['Strategy', 'Min', 'Median', 'Max', 'Above SPI'], rows: robust.map((r) => [S(r.id), num(r.min, 2), num(r.med, 2), num(r.max, 2), `${r.wins} / ${r.total}`]), note: `Estimation windows of ${list(m.grid.windows.map(String))} months; monthly, quarterly and annual rebalancing. Same covariance estimator, cap (${capT}) and costs. Common period of all windows; SPI Sharpe ratio over this period: ${num(spiRobust, 2)}.` });
  }
  const sc = c.strat.freqs[s.freq];
  const scen: [string, number, boolean][] = [['Gross', -1, false], [`${s.bps} bp`, s.bps, false], [`${s.bps} bp + spread`, s.bps, true], ['25 bp + spread', 25, true], ['50 bp + spread', 50, true]];
  blocks.push({
    kind: 'table',
    label: 'tab:costs',
    caption: 'Sharpe ratio under different transaction costs',
    head: ['Strategy', ...scen.map(([h]) => h)],
    rows: strategies.map((id) => {
      const sv = view.series.get(id)!;
      const raw = view.idx.map((i) => sc[id as Exclude<SeriesId, 'CW' | 'MONKEYS'>].spread?.[i] ?? 0);
      return [S(id), ...scen.map(([, bp, sp]) => num(perfStats(bp < 0 ? sv.gross : netReturns(sv.gross, sv.turnover, bp, sp ? raw : undefined), view.rf, view.spi).sharpe, 2))];
    }),
    note: L`Fixed cost $c$ with or without the estimated half-spread; net returns recomputed with equation [[eq:net]] (the weights do not depend on the costs).`,
  });
  const regimes = m.regimes
    .map((g) => ({ g, k: view.months.map((mo, i) => [mo, i] as const).filter(([mo]) => mo >= g.start && mo <= g.end).map(([, i]) => i) }))
    .filter((x) => x.k.length >= 6);
  if (regimes.length) {
    blocks.push({
      kind: 'table',
      label: 'tab:regimes',
      caption: 'Annualised return by sub-period',
      head: ['Sub-period', 'Months', ...all.map(S)],
      rows: regimes.map(({ g, k }) => [g.name, String(k.length), ...all.map((id) => { const r = k.map((i) => view.series.get(id)!.r[i]); return pct(Math.pow(r.reduce((a, x) => a * (1 + x), 1), 12 / r.length) - 1, 1); })]),
      note: 'Sub-periods fixed in advance (not chosen from the results).',
    });
  }

  // 8. Composition
  const f = c.strat.freqs[s.freq];
  const pick = (a: (number | null)[]) => view.idx.map((i) => a[i]).filter((v): v is number => v !== null);
  const dec = c.strat.decisions;
  const decIn = dec.months.map((mo, i) => [mo, i] as const).filter(([mo]) => mo >= view.period[0] && mo <= view.period[1]);
  const ercBind = decIn.filter(([, i]) => (dec.erc_capped?.[i] ?? 0) > 0).length;
  blocks.push(
    { kind: 'h2', text: 'Portfolio composition' },
    {
      kind: 'table',
      label: 'tab:comp',
      caption: 'Average composition over the period',
      head: ['Strategy', 'Positions', L`$N_{\text{eff}}$`, 'Largest weight', 'Top-10 weight', 'Turnover p.a.', 'Costs (CHF/100)'],
      rows: strategies.map((id) => {
        const x = f[id as Exclude<SeriesId, 'CW' | 'MONKEYS'>];
        const sv = view.series.get(id)!;
        return [S(id), num(mean(pick(x.n_pos)), 0), num(mean(pick(x.eff_n)), 1), pct(mean(pick(x.max_w)), 1), pct(mean(pick(x.top10)), 1), `${num((12 * sv.turnover.reduce((a: number, b) => a + (b ?? 0), 0)) / view.months.length, 2)}$\\times$`, num(cumulativeCosts(sv.gross, sv.turnover, s.bps, sv.spread), 2)];
      }),
      note: L`Weights held at the start of each month: the cap applies to the target weights at each rebalancing date, and a stock can drift above it in between. Effective number of stocks $N_{\text{eff}} = 1/\sum_i w_i^2$. ERC: the ${capT} cap binds at ${ercBind} of ${decIn.length} monthly decisions; capped stocks then contribute less risk and the others contribute equally.`,
    },
  );

  // 9. Limitations
  blocks.push(
    { kind: 'h2', text: 'Limitations' },
    {
      kind: 'bullets',
      items: [
        `Sample of ${num(view.months.length / 12, 1)} years: the standard errors of mean returns and Sharpe ratios are large, and the bootstrap tests have low power.`,
        biased ? `Strong survivorship bias before ${controlled}.` : `Survivorship bias reduced but not necessarily eliminated from ${controlled} (delistings are covered from then; no delisting returns beyond the last price).`,
        'Reconstructed universe of liquid Swiss shares, not the historical SPI constituents; the SPI is the official index (no costs).',
        'Proportional costs (fixed cost and estimated half-spread) at month-end closing prices, no market impact; for thinly traded stocks the closing price may be stale (Table [[tab:stale]]).',
        'JKP factors approximate, but do not replicate, the Fama–French factors.',
        'Descriptive comparison of a configuration fixed in advance; selecting the best configuration ex post would be data snooping.',
      ],
    },
  );
  return blocks;
}
