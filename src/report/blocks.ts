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

import type { SeriesId, StrategiesFile } from '../data/types.ts';
import { holm, sharpeDiffBootstrap } from '../engine/bootstrap.ts';
import { breuschPagan, defaultLjungBoxLags, jarqueBera, ljungBox } from '../engine/diagnostics.ts';
import { fitModel, FACTORS, MODEL_IDS, MODELS, type FitOutcome, type ModelId } from '../engine/factors.ts';
import { cumulativeCosts, drawdowns, mean, netReturns, percentileRank, perfStats, quantile, wealth } from '../engine/metrics.ts';
import { configKey } from '../data/loader.ts';
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

export async function reportBlocks(c: ReportCtx, load: (key: string) => Promise<StrategiesFile>): Promise<Block[]> {
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
  const main = (['FF5MOM', 'FF5', 'CARHART', 'FF3', 'CAPM'] as ModelId[]).find((mod) => portfolios.every((id) => fits.get(id)![mod].ok)) ?? null;
  const mainFit = (id: SeriesId) => fits.get(id)![main!] as OkFit;
  const alphaAdj = main ? holm(strategies.map((id) => mainFit(id).result.pvalue[0])) : [];

  // ---- robustness over windows × frequencies
  let robust: { id: SeriesId; wins: number; total: number; min: number; med: number; max: number }[] = [];
  let robustPeriod = '';
  let spiRobust = NaN;
  try {
    const files = await Promise.all(m.grid.windows.map((w) => load(configKey(w, s.cov, s.cap))));
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

  // ---- monkeys
  const mk = view.monkeys.r.map((r) => perfStats(r, view.rf, view.spi));

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
    { kind: 'p', text: `For EW and IVP the excess above the cap is redistributed pro rata. **Transaction costs** of $c = ${s.bps}$ bp are charged on the traded value, with turnover $\\mathrm{TO}_t$ (buys plus sells) at each rebalancing:` },
    {
      kind: 'eq',
      label: 'eq:net',
      tex: L`1 + R^{\text{net}}_{t} = \bigl(1 - c\,\mathrm{TO}_t\bigr)\bigl(1 + R^{\text{gross}}_{t}\bigr), \qquad \mathrm{TO}_t = \sum_i \bigl| w^{\text{target}}_{i,t} - w^{\text{drift}}_{i,t} \bigr|.`,
    },
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
      note: `Net of ${s.bps} bp transaction costs (the SPI has none). Volatility annualised with $\\sqrt{12}$. CVaR 95 %: average monthly return in the worst 5 % of months. Last column: final value of 100 CHF invested at the start.`,
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
      note: L`Beta on SPI excess returns; tracking error $\mathrm{TE} = \sqrt{12}\,\mathrm{sd}(R_p - R_{\text{SPI}})$; information ratio $12\,\overline{(R_p - R_{\text{SPI}})}/\mathrm{TE}$. $\Delta$CAGR, universe and weighting effects as in equation [[eq:decomp]]. Turnover: sum of absolute weight changes per year.`,
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
      note: `Annualised Sharpe ratios. SPI Sharpe ratio: ${num(spi.sharpe, 2)}. Percentile confidence interval.`,
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
    const split = rhs.length > 3 ? 3 : rhs.length;
    blocks.push(
      { kind: 'p', text: `Monthly excess returns are regressed on the ${MODELS[main].label} factors: the market factor $\\text{MKT} = R_{\\text{SPI}} - R_f$ and the Swiss JKP long–short factors ${list(fac.filter((f) => f !== 'MKT').map((f) => ({ SMB: 'SMB (size)', HML: 'HML (value)', RMW: 'RMW (profitability)', CMA: 'CMA (investment)', MOM: 'MOM (momentum)' } as Record<string, string>)[f] ?? f))}, in CHF:` },
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
        caption: L`Annualised alpha $12\,\hat\alpha_p$ across the five factor models`,
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
    const smb = strategies.filter((id) => { const r = mainFit(id).result; const j = r.names.indexOf('SMB'); return j > 0 && r.pvalue[j] < 0.05 && r.beta[j] > 0; });
    const reading = [
      lowBeta.length ? `${list(lowBeta.map(S))} have a market beta clearly below one, consistent with their lower volatility.` : '',
      smb.length ? `${list(smb.map(S))} load positively and significantly on SMB: they hold more small and mid caps than the cap-weighted index.` : '',
      sigAlpha.length ? `The alphas of ${list(sigAlpha.map(S))} remain significant after the Holm correction: these strategies earned more than their factor exposures imply, in line with the low-volatility anomaly.` : 'No alpha survives the Holm correction.',
      `A significant alpha does not imply a significant Sharpe ratio difference with the SPI (Table [[tab:sharpe]]): the two tests use different benchmarks — a factor-mimicking portfolio with the same exposures, and the index itself.`,
    ].filter(Boolean);
    blocks.push({ kind: 'p', text: `**Interpretation.** ${reading.join(' ')}` });
  } else {
    blocks.push({ kind: 'p', text: 'The factor models could not be estimated over the period.' });
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
    blocks.push(
      { kind: 'h2', text: "Malkiel's monkeys" },
      { kind: 'p', text: `${mk.length} random portfolios of $K = ${s.k}$ stocks, equally weighted and redrawn at each rebalancing date from the same eligible universe (seed ${s.seed}), with the same costs. The percentile of portfolio $p$ for a statistic $X$ is $\\frac{1}{${mk.length}} \\sum_{j} \\mathbf{1}\\{X_j < X_p\\}$.` },
      { kind: 'table', label: 'tab:mk', caption: `Distribution of the ${mk.length} monkey portfolios`, head: ['Statistic', 'Mean', 'P5', 'P25', 'Median', 'P75', 'P95'], rows: metrics.map(([n, f, fmt]) => { const v = mk.map(f); return [n, fmt(mean(v)), fmt(quantile(v, 0.05)), fmt(quantile(v, 0.25)), fmt(quantile(v, 0.5)), fmt(quantile(v, 0.75)), fmt(quantile(v, 0.95))]; }) },
      { kind: 'table', label: 'tab:mkpct', caption: 'Percentile of each portfolio within the monkeys distribution', head: ['Portfolio', 'CAGR', 'Volatility', 'Sharpe', 'Max drawdown'], rows: ['CW', ...strategies].map((id) => [S(id as SeriesId), ...metrics.map(([, f]) => `${Math.round(100 * percentileRank(mk.map(f), f(ps(id as SeriesId))))}`)]), note: 'Share of the monkeys (in %) with a lower value. For volatility a low percentile means less risk; for the maximum drawdown (a negative number) a high percentile means a smaller loss.' },
      { kind: 'figure', label: 'fig:mk', caption: `Sharpe ratios of the ${mk.length} monkeys and of the portfolios`, chart: { type: 'hist', values: sr, bins: 20, color: COLOR.MONKEYS, label: `Monkeys (${mk.length})`, markers: ['CW', ...strategies].map((id) => ({ name: S(id as SeriesId), color: COLOR[id as SeriesId], x: ps(id as SeriesId).sharpe })), xFormat: 'num', xTitle: 'Sharpe ratio (annualised)' } },
    );
  }

  // 7. Robustness
  blocks.push({ kind: 'h2', text: 'Robustness' });
  if (robust.length) {
    blocks.push({ kind: 'table', label: 'tab:robust', caption: `Sharpe ratio across the ${robust[0].total} window $\\times$ rebalancing combinations (${robustPeriod})`, head: ['Strategy', 'Min', 'Median', 'Max', 'Above SPI'], rows: robust.map((r) => [S(r.id), num(r.min, 2), num(r.med, 2), num(r.max, 2), `${r.wins} / ${r.total}`]), note: `Estimation windows of ${list(m.grid.windows.map(String))} months; monthly, quarterly and annual rebalancing. Same covariance estimator, cap (${capT}) and costs. Common period of all windows; SPI Sharpe ratio over this period: ${num(spiRobust, 2)}.` });
  }
  const costs = [0, 25, 50, 100];
  blocks.push({
    kind: 'table',
    label: 'tab:costs',
    caption: 'Sharpe ratio under different transaction costs',
    head: ['Strategy', ...costs.map((bp) => `${bp} bp`)],
    rows: strategies.map((id) => { const sv = view.series.get(id)!; return [S(id), ...costs.map((bp) => num(perfStats(netReturns(sv.gross, sv.turnover, bp), view.rf, view.spi).sharpe, 2))]; }),
    note: L`Net returns recomputed with equation [[eq:net]]; the weights do not depend on $c$.`,
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
        return [S(id), num(mean(pick(x.n_pos)), 0), num(mean(pick(x.eff_n)), 1), pct(mean(pick(x.max_w)), 1), pct(mean(pick(x.top10)), 1), `${num((12 * sv.turnover.reduce((a: number, b) => a + (b ?? 0), 0)) / view.months.length, 2)}$\\times$`, num(cumulativeCosts(sv.gross, sv.turnover, s.bps), 2)];
      }),
      note: L`Effective number of stocks $N_{\text{eff}} = 1/\sum_i w_i^2$. ERC: the ${capT} cap binds at ${ercBind} of ${decIn.length} monthly decisions; capped stocks then contribute less risk and the others contribute equally.`,
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
        'Proportional costs at month-end closing prices, no market impact.',
        'JKP factors approximate, but do not replicate, the Fama–French factors.',
        'Descriptive comparison of a configuration fixed in advance; selecting the best configuration ex post would be data snooping.',
      ],
    },
  );
  return blocks;
}
