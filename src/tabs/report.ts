/**
 * Results report of the default configuration (the site as it opens).
 *
 * Every number, sentence, table and chart is computed from the published
 * results (nothing hard-coded), so the report follows data updates. One list of
 * blocks feeds the page (HTML tables, Plotly charts) and the PDF download.
 */

import type { SeriesId, StrategiesFile } from '../data/types.ts';
import { holm, sharpeDiffBootstrap } from '../engine/bootstrap.ts';
import { breuschPagan, defaultLjungBoxLags, jarqueBera, ljungBox } from '../engine/diagnostics.ts';
import { fitModel, FACTORS, MODEL_IDS, MODELS, type FitOutcome, type ModelId } from '../engine/factors.ts';
import { cumulativeCosts, drawdowns, mean, netReturns, percentileRank, perfStats, quantile, wealth } from '../engine/metrics.ts';
import { configKey } from '../data/loader.ts';
import { availableRange, buildView, wealthDates } from '../model.ts';
import { baseLayout, draw, SHORT } from '../ui/charts.ts';
import { configLabel, decomposition, periodLabel, basisLabel, stats, type Ctx } from '../ui/context.ts';
import { buildPdf, type Block, type ChartSpec } from '../ui/pdf.ts';
import { escapeHtml, num, pct, signedPct, stars } from '../ui/format.ts';

/** Fixed light palette (same order as the site) for the PDF and the report charts. */
const COLOR: Record<SeriesId, string> = {
  CW: '#52514e', EW: '#2a78d6', GMV: '#eb6834', ERC: '#1baf7a', TP: '#eda100', MDP: '#e87ba4', IVP: '#008300', MONKEYS: '#6250d6', TP_SAMPLE: '#eda100',
};

const fp = (p: number) => (p < 0.001 ? '< 0.001' : num(p, 3));
const t2 = (t: number) => `(${num(t, 2)})`;

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

type OkFit = Extract<FitOutcome, { ok: true }>;

export async function reportBlocks(c: Ctx, load: (key: string) => Promise<StrategiesFile>): Promise<Block[]> {
  const { view, s, m } = c;
  const strategies = (['EW', 'GMV', 'ERC', 'TP', 'MDP', 'IVP'] as SeriesId[]).filter((id) => view.series.has(id));
  const hasMk = view.series.has('MONKEYS');
  const portfolios: SeriesId[] = [...strategies, ...(hasMk ? (['MONKEYS'] as SeriesId[]) : [])];
  const all: SeriesId[] = ['CW', ...portfolios];
  const st = (id: SeriesId) => stats(c, id);
  const spi = st('CW');
  const S = (id: SeriesId) => SHORT[id];
  const controlled = m.survivorship.controlled_start;
  const biased = !!controlled && view.period[0] < controlled;
  const fdata = { months: c.market.months, rf: c.market.rf, factors: c.market.factors };

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
    { kind: 'title', text: 'Swiss Equity Portfolio Lab — Results report' },
    { kind: 'meta', text: `Default configuration: ${configLabel(c)} · ${periodLabel(c)} · ${basisLabel(c)} · monkeys: K = ${s.k}, seed ${s.seed}. Data up to ${m.data_last_date}; results built ${m.generated_at.slice(0, 10)}.` },
    { kind: 'note', text: 'Generated automatically from the published results of the default configuration (the site as it opens); the figures update with the data. Historical and descriptive results, not investment advice.' },
  ];
  if (biased) blocks.push({ kind: 'warn', text: `The period starts before ${controlled}: the results before that date carry a strong survivorship bias.` });

  // 1. Summary
  const higher = strategies.filter((id) => st(id).sharpe > spi.sharpe);
  const signif = strategies.filter((_, i) => bootAdj[i] < 0.05);
  const sigAlpha = main ? strategies.filter((_, i) => alphaAdj[i] < 0.05) : [];
  const allWin = robust.filter((r) => r.wins === r.total).map((r) => r.id);
  const minVol = [...strategies].sort((a, b) => st(a).vol - st(b).vol)[0];
  blocks.push(
    { kind: 'h2', text: '1. Main results' },
    {
      kind: 'bullets',
      items: [
        `**Returns.** The SPI total return earned ${pct(spi.cagr, 1)} p.a.; the strategies earned between ${pct(Math.min(...strategies.map((id) => st(id).cagr)), 1)} and ${pct(Math.max(...strategies.map((id) => st(id).cagr)), 1)} p.a. net of costs${hasMk ? `, the average monkey portfolio ${pct(st('MONKEYS').cagr, 1)}` : ''}.`,
        `**Risk.** ${list(strategies.filter((id) => st(id).vol < spi.vol).map(S)) || 'No strategy'} had a lower volatility than the SPI (${pct(spi.vol, 1)}); the lowest was ${S(minVol)} (${pct(st(minVol).vol, 1)}, maximum drawdown ${pct(st(minVol).maxDD, 1)} vs ${pct(spi.maxDD, 1)}).`,
        `**Risk-adjusted performance.** ${higher.length ? `${list(higher.map((id) => `${S(id)} (${num(st(id).sharpe, 2)})`))} had a higher Sharpe ratio than the SPI (${num(spi.sharpe, 2)})` : `No strategy had a higher Sharpe ratio than the SPI (${num(spi.sharpe, 2)})`}; ${signif.length ? `the difference is significant at 5 % after the Holm correction for ${list(signif.map(S))}` : 'none of the differences is significant at 5 % after the Holm correction (stationary bootstrap)'}.`,
        main ? `**Factor model (${MODELS[main].label}).** Market betas range from ${num(Math.min(...strategies.map((id) => mainFit(id).result.beta[1])), 2)} to ${num(Math.max(...strategies.map((id) => mainFit(id).result.beta[1])), 2)}; ${sigAlpha.length ? `the alpha is significant after the Holm correction for ${list(sigAlpha.map((id) => `${S(id)} (${signedPct(12 * mainFit(id).result.beta[0], 1)} p.a.)`))}` : 'no alpha is significant after the Holm correction'}.` : '**Factor model.** Not estimable over the period.',
        robust.length ? `**Robustness.** Over the ${robust[0].total} window × frequency combinations (${robustPeriod}), ${allWin.length ? `${list(allWin.map(S))} had a higher Sharpe ratio than the SPI in all of them` : 'no strategy had a higher Sharpe ratio than the SPI in all of them'}.` : '',
      ].filter(Boolean),
    },
  );

  // 2. Design
  const el = m.universe.eligible[String(s.window)];
  const k0 = m.universe.months.indexOf(view.period[0]);
  const k1 = m.universe.months.indexOf(view.period[1]);
  const nEl = el.slice(k0, k1 + 1);
  blocks.push(
    { kind: 'h2', text: '2. Data and design' },
    { kind: 'p', text: `Universe: Swiss-listed ordinary shares from EODHD (${m.universe.stocks_in_panel} stocks, ${m.universe.delisted_in_panel} delisted), screened at each month-end for listing, liquidity (median traded value ≥ CHF ${m.universe.rules.liq_min_median_value_chf.toLocaleString('en')}) and a complete ${s.window}-month return history: ${Math.min(...nEl)} to ${Math.max(...nEl)} eligible stocks per date. Walk-forward: weights decided at the end of month t with data up to t, held from t+1, rebalanced ${({ M: 'monthly', Q: 'at calendar quarter-ends', A: 'every December' } as const)[s.freq]}, long-only, fully invested, weights ≤ ${s.cap} %. Covariance: ${s.cov === 'lw' ? 'Ledoit-Wolf shrinkage to constant correlation' : 'sample + ridge'}; expected returns (TP): Bayes-Stein. Transaction costs: ${s.bps} bp of traded value. Benchmark (CW): SPI total return index. Risk-free rate: SARON (SNB). Factors: Swiss Jensen-Kelly-Pedersen factors in CHF.` },
  );

  // 3. Performance and risk
  const dates = wealthDates(view.months);
  const line = (fn: (r: number[]) => number[]): ChartSpec => ({
    type: 'line',
    x: dates,
    yFormat: 'num',
    yTitle: '',
    series: all.map((id) => ({ name: S(id), color: COLOR[id], y: fn(view.series.get(id)!.r), width: id === 'CW' ? 1.8 : 1, dash: id === 'MONKEYS' })),
  });
  const wealthChart = line((r) => wealth(r));
  (wealthChart as Extract<ChartSpec, { type: 'line' }>).yTitle = 'Value of 100 CHF';
  (wealthChart as Extract<ChartSpec, { type: 'line' }>).refY = 100;
  const ddChart = line((r) => drawdowns(wealth(r)));
  Object.assign(ddChart, { yFormat: 'pct', yTitle: 'Drawdown', height: 120 });
  blocks.push(
    { kind: 'h2', text: '3. Performance and risk' },
    {
      kind: 'table',
      caption: 'Table 1 — Returns and risk (monthly data, annualised where stated)',
      head: ['Portfolio', 'CAGR', 'Mean ×12', 'Volatility', 'Sharpe', 'Sortino', 'Max DD', 'CVaR 95 % (m)', 'Skew', '100 CHF →'],
      rows: all.map((id) => {
        const x = st(id);
        return [S(id), pct(x.cagr, 2), pct(x.arithAnnual, 2), pct(x.vol, 2), num(x.sharpe, 2), num(x.sortino, 2), pct(x.maxDD, 1), pct(x.cvar95, 2), num(x.skew, 2), num(100 * (1 + x.cumulative), 1)];
      }),
      note: `Net of ${s.bps} bp transaction costs (the SPI has none). Sharpe and Sortino use the Swiss risk-free rate; CVaR is the average loss in the worst 5 % of months.`,
    },
    { kind: 'figure', caption: 'Figure 1 — Cumulative value of 100 CHF', chart: wealthChart },
    { kind: 'figure', caption: 'Figure 2 — Drawdowns (fall from the previous peak)', chart: ddChart },
    {
      kind: 'table',
      caption: 'Table 2 — Comparison with the SPI and implementation',
      head: ['Portfolio', 'Beta', 'Track. error', 'Info. ratio', 'Δ CAGR vs SPI', 'Universe (EW−SPI)', 'Weighting (−EW)', 'Turnover p.a.', 'Cost drag p.a.'],
      rows: portfolios.map((id) => {
        const x = st(id);
        const d = decomposition(c, id)!;
        const sv = view.series.get(id)!;
        const to = id === 'MONKEYS' ? 12 * mean(view.monkeys.turnover.map((t) => mean(t))) : (12 * sv.turnover.reduce((a: number, b) => a + (b ?? 0), 0)) / view.months.length;
        const drag = stats(c, id, 'gross').cagr - stats(c, id, 'net').cagr;
        return [S(id), num(x.beta, 2), pct(x.trackingError, 1), num(x.infoRatio, 2), signedPct(d.total, 2), signedPct(d.universe, 2), signedPct(d.weighting, 2), `${num(to, 2)}×`, pct(drag, 2)];
      }),
      note: 'Δ CAGR vs SPI = (EW − SPI) + (strategy − EW): the first term reflects the reconstructed universe with equal weights (small-cap tilt) versus the cap-weighted SPI; only the second isolates the weighting rule. Turnover = sum of absolute weight changes per year (buys + sells).',
    },
  );

  // 4. Inference
  blocks.push(
    { kind: 'h2', text: '4. Are the Sharpe ratio differences significant?' },
    {
      kind: 'table',
      caption: 'Table 3 — Sharpe ratio difference with the SPI (stationary bootstrap)',
      head: ['Strategy', 'Sharpe', 'Δ Sharpe', '95 % CI', 'p-value', 'Holm p'],
      rows: strategies.map((id, i) => [S(id), num(st(id).sharpe, 2), num(boots[i].diff, 2), `[${num(boots[i].low, 2)}; ${num(boots[i].high, 2)}]`, fp(boots[i].pvalue), fp(bootAdj[i])]),
      note: `${boots[0]?.reps ?? 2000} paired resamples of months (mean block length 6), fixed seed; Holm adjustment for the ${strategies.length} comparisons. SPI Sharpe ratio: ${num(spi.sharpe, 2)}.`,
    },
    {
      kind: 'figure',
      caption: 'Figure 3 — Δ Sharpe ratio versus the SPI with 95 % bootstrap interval',
      chart: { type: 'dots', categories: strategies.map(S), colors: strategies.map((id) => COLOR[id]), value: boots.map((b) => b.diff), low: boots.map((b) => b.low), high: boots.map((b) => b.high), xFormat: 'num', xTitle: 'Sharpe(strategy) − Sharpe(SPI), annualised', refX: 0 },
    },
  );

  // 5. Factor analysis
  blocks.push({ kind: 'h2', text: '5. Factor analysis' });
  if (main) {
    const f0 = mainFit(strategies[0]);
    blocks.push({ kind: 'p', text: `Monthly excess returns R − R_f regressed on MKT = SPI − R_f and the Swiss JKP factors SMB (size), HML (value), RMW (profitability), CMA (investment) and MOM (momentum), in CHF. Newey-West standard errors (${f0.result.hacLags} lags), ${f0.result.n} months (${f0.sample.months[0]} – ${f0.sample.months.at(-1)}; the JKP data end there). Coefficients with t-statistics in parentheses; \\* p < 0.10, \\*\\* p < 0.05, \\*\\*\\* p < 0.01. CW is not reported: MKT is built from the SPI, so its alpha is 0 and its beta 1 by construction.` });
    const rows: string[][] = [];
    const sub: boolean[] = [];
    for (const id of portfolios) {
      const r = mainFit(id).result;
      const get = (name: string) => r.names.indexOf(name);
      const cols = ['alpha', ...FACTORS];
      rows.push([S(id), ...cols.map((n) => (get(n) < 0 ? '' : n === 'alpha' ? `${num(100 * r.beta[0], 2)}${stars(r.pvalue[0])}` : `${num(r.beta[get(n)], 2)}${stars(r.pvalue[get(n)])}`)), num(r.r2adj, 2)]);
      sub.push(false);
      rows.push(['', ...cols.map((n) => (get(n) < 0 ? '' : t2(r.stat[get(n)]))), '']);
      sub.push(true);
    }
    blocks.push({ kind: 'table', caption: `Table 4 — ${MODELS[main].label} estimates (alpha in % per month)`, head: ['Portfolio', 'Alpha', ...FACTORS, 'Adj. R²'], rows, sub });

    const rows5: string[][] = [];
    const sub5: boolean[] = [];
    for (const id of portfolios) {
      const f = fits.get(id)!;
      rows5.push([S(id), ...MODEL_IDS.map((mod) => (f[mod].ok ? `${pct(12 * (f[mod] as OkFit).result.beta[0], 2)}${stars((f[mod] as OkFit).result.pvalue[0])}` : 'n/a'))]);
      sub5.push(false);
      rows5.push(['', ...MODEL_IDS.map((mod) => (f[mod].ok ? t2((f[mod] as OkFit).result.stat[0]) : ''))]);
      sub5.push(true);
    }
    blocks.push(
      { kind: 'table', caption: 'Table 5 — Annualised alpha (×12) across the five models', head: ['Portfolio', ...MODEL_IDS.map((mod) => MODELS[mod].label)], rows: rows5, sub: sub5, note: 'CAPM uses all months with the SPI and r_f; the multifactor models use the months with JKP factors. Newey-West t-statistics in parentheses.' },
      {
        kind: 'figure',
        caption: `Figure 4 — ${MODELS[main].label} alpha, annualised, with 95 % confidence interval`,
        chart: { type: 'dots', categories: portfolios.map(S), colors: portfolios.map((id) => COLOR[id]), value: portfolios.map((id) => 12 * mainFit(id).result.beta[0]), low: portfolios.map((id) => 12 * mainFit(id).result.ciLow[0]), high: portfolios.map((id) => 12 * mainFit(id).result.ciHigh[0]), xFormat: 'pct', xTitle: 'Alpha per year', refX: 0 },
      },
      {
        kind: 'table',
        caption: `Table 6 — Alpha significance adjusted for multiple testing and residual diagnostics (${MODELS[main].label})`,
        head: ['Strategy', 'Alpha p.a.', 'p-value', 'Holm p', 'Jarque-Bera p', 'Breusch-Pagan p', 'Ljung-Box p'],
        rows: strategies.map((id, i) => {
          const f = mainFit(id);
          const r = f.result;
          return [S(id), signedPct(12 * r.beta[0], 2), fp(r.pvalue[0]), fp(alphaAdj[i]), fp(jarqueBera(r.resid).pvalue), fp(breuschPagan(r.resid, f.sample.x).pvalue), fp(ljungBox(r.resid, defaultLjungBoxLags(r.n)).pvalue)];
        }),
        note: 'Holm: family-wise correction over the strategies. Diagnostics test normality (JB), heteroskedasticity (BP, Koenker) and residual autocorrelation (LB); the Newey-West standard errors are robust to the last two.',
      },
    );
    const lowBeta = strategies.filter((id) => mainFit(id).result.beta[1] < 0.85);
    const smb = strategies.filter((id) => { const r = mainFit(id).result; const j = r.names.indexOf('SMB'); return j > 0 && r.pvalue[j] < 0.05 && r.beta[j] > 0; });
    blocks.push({ kind: 'p', text: `Reading. ${lowBeta.length ? `${list(lowBeta.map(S))} have a market beta clearly below one, in line with their lower volatility.` : ''} ${smb.length ? `${list(smb.map(S))} load positively and significantly on SMB: they hold more small and mid caps than the cap-weighted index.` : ''} ${sigAlpha.length ? `The alphas of ${list(sigAlpha.map(S))} remain significant after the Holm correction: these strategies earned more than their factor exposures imply, consistent with the low-volatility anomaly documented in the literature.` : 'No alpha survives the Holm correction.'} A significant alpha does not imply a significant Sharpe ratio difference with the SPI (Table 3): the two tests compare with different benchmarks.` });
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
      { kind: 'h2', text: "6. Malkiel's monkeys" },
      { kind: 'p', text: `${mk.length} random portfolios of ${s.k} stocks, equally weighted and redrawn at each rebalancing date from the same eligible universe (seed ${s.seed}).` },
      { kind: 'table', caption: 'Table 7 — Distribution of the 100 monkeys', head: ['Statistic', 'Mean', 'P5', 'P25', 'Median', 'P75', 'P95'], rows: metrics.map(([n, f, fmt]) => { const v = mk.map(f); return [n, fmt(mean(v)), fmt(quantile(v, 0.05)), fmt(quantile(v, 0.25)), fmt(quantile(v, 0.5)), fmt(quantile(v, 0.75)), fmt(quantile(v, 0.95))]; }) },
      { kind: 'table', caption: 'Table 8 — Percentile of each portfolio within the monkeys distribution', head: ['Portfolio', 'CAGR', 'Volatility', 'Sharpe', 'Max drawdown'], rows: ['CW', ...strategies].map((id) => [S(id as SeriesId), ...metrics.map(([, f]) => `${Math.round(100 * percentileRank(mk.map(f), f(st(id as SeriesId))))}`)]), note: 'Share (in %) of the monkeys with a lower value. For volatility a low percentile means less risk; for drawdown a high percentile means a smaller loss.' },
      { kind: 'figure', caption: 'Figure 5 — Sharpe ratios of the 100 monkeys and of the portfolios', chart: { type: 'hist', values: sr, bins: 20, color: COLOR.MONKEYS, markers: ['CW', ...strategies].map((id) => ({ name: S(id as SeriesId), color: COLOR[id as SeriesId], x: st(id as SeriesId).sharpe })), xFormat: 'num', xTitle: 'Sharpe ratio' } },
    );
  }

  // 7. Robustness
  blocks.push({ kind: 'h2', text: '7. Robustness' });
  if (robust.length) {
    blocks.push({ kind: 'table', caption: `Table 9 — Sharpe ratio across the ${robust[0].total} window × frequency combinations (${robustPeriod})`, head: ['Strategy', 'Min', 'Median', 'Max', 'Above SPI'], rows: robust.map((r) => [S(r.id), num(r.min, 2), num(r.med, 2), num(r.max, 2), `${r.wins} / ${r.total}`]), note: `Same covariance (${s.cov}), cap (${s.cap} %) and costs; SPI Sharpe over this period: ${num(spiRobust, 2)}. Windows ${m.grid.windows.join(', ')} months; monthly, quarterly and annual rebalancing.` });
  }
  const costs = [0, 25, 50, 100];
  blocks.push({
    kind: 'table',
    caption: 'Table 10 — Sharpe ratio under different transaction costs',
    head: ['Strategy', ...costs.map((bp) => `${bp} bp`)],
    rows: strategies.map((id) => { const sv = view.series.get(id)!; return [S(id), ...costs.map((bp) => num(perfStats(netReturns(sv.gross, sv.turnover, bp), view.rf, view.spi).sharpe, 2))]; }),
  });
  const regimes = m.regimes
    .map((g) => ({ g, k: view.months.map((mo, i) => [mo, i] as const).filter(([mo]) => mo >= g.start && mo <= g.end).map(([, i]) => i) }))
    .filter((x) => x.k.length >= 6);
  if (regimes.length) {
    blocks.push({
      kind: 'table',
      caption: 'Table 11 — Annualised return by sub-period (regimes fixed in advance)',
      head: ['Sub-period', 'Months', ...all.map(S)],
      rows: regimes.map(({ g, k }) => [g.name, String(k.length), ...all.map((id) => { const r = k.map((i) => view.series.get(id)!.r[i]); return pct(Math.pow(r.reduce((a, x) => a * (1 + x), 1), 12 / r.length) - 1, 1); })]),
    });
  }

  // 8. Composition
  const f = c.strat.freqs[s.freq];
  const pick = (a: (number | null)[]) => view.idx.map((i) => a[i]).filter((v): v is number => v !== null);
  const dec = c.strat.decisions;
  const decIn = dec.months.map((mo, i) => [mo, i] as const).filter(([mo]) => mo >= view.period[0] && mo <= view.period[1]);
  const ercBind = decIn.filter(([, i]) => (dec.erc_capped?.[i] ?? 0) > 0).length;
  blocks.push(
    { kind: 'h2', text: '8. Portfolio composition' },
    {
      kind: 'table',
      caption: 'Table 12 — Average composition over the period',
      head: ['Strategy', 'Positions', 'Effective N', 'Largest weight', 'Top-10 weight', 'Turnover p.a.', 'Costs paid (CHF/100)'],
      rows: strategies.map((id) => {
        const x = f[id as Exclude<SeriesId, 'CW' | 'MONKEYS'>];
        const sv = view.series.get(id)!;
        return [S(id), num(mean(pick(x.n_pos)), 0), num(mean(pick(x.eff_n)), 1), pct(mean(pick(x.max_w)), 1), pct(mean(pick(x.top10)), 1), `${num((12 * sv.turnover.reduce((a: number, b) => a + (b ?? 0), 0)) / view.months.length, 2)}×`, num(cumulativeCosts(sv.gross, sv.turnover, s.bps), 2)];
      }),
      note: `Effective N = 1 / sum of squared weights. ERC: the ${s.cap} % cap binds at ${ercBind} of ${decIn.length} monthly decisions; capped stocks then contribute less risk and the others contribute equally.`,
    },
  );

  // 9. Limitations
  blocks.push(
    { kind: 'h2', text: '9. Limitations' },
    {
      kind: 'bullets',
      items: [
        `Sample of ${num(view.months.length / 12, 1)} years: the standard errors of mean returns and Sharpe ratios are large.`,
        biased ? `Strong survivorship bias before ${controlled}.` : `Survivorship bias reduced but not necessarily eliminated from ${controlled} (delistings are covered from then; no delisting returns beyond the last price).`,
        'Reconstructed universe of liquid Swiss shares, not the historical SPI constituents; the SPI is the official index (no costs).',
        'Proportional costs at month-end closing prices, no market impact.',
        'JKP factors approximate, but do not replicate, the Fama-French factors.',
        'Descriptive comparison of a configuration fixed in advance; selecting the best configuration ex post would be data snooping.',
      ],
    },
  );
  return blocks;
}

// --------------------------------------------------------------------- HTML

function inline(text: string): string {
  return escapeHtml(text.replace(/\\\*/g, '\u0002'))
    .split('**')
    .map((t, i) => (i % 2 ? `<strong>${t}</strong>` : t))
    .join('')
    .replace(/\u0002/g, '*');
}

function toHtml(blocks: Block[]): string {
  let fig = 0;
  return blocks
    .map((b) => {
      switch (b.kind) {
        case 'title':
          return '';
        case 'meta':
          return `<p class="muted small">${inline(b.text)}</p>`;
        case 'note':
          return `<p class="note">${inline(b.text)}</p>`;
        case 'warn':
          return `<p class="warn">${inline(b.text)}</p>`;
        case 'h2':
          return `<h3>${inline(b.text)}</h3>`;
        case 'h3':
          return `<h4>${inline(b.text)}</h4>`;
        case 'p':
          return `<p>${inline(b.text)}</p>`;
        case 'bullets':
          return `<ul class="plain">${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;
        case 'table':
          return `${b.caption ? `<p class="caption">${inline(b.caption)}</p>` : ''}<div class="table-wrap"><table class="data report-table"><thead><tr>${b.head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${b.rows
            .map((r, i) => `<tr${b.sub?.[i] ? ' class="tstat-row"' : b.sub?.[i + 1] ? ' class="coef-row"' : ''}>${r.map((cell, j) => (j === 0 ? `<th scope="row">${escapeHtml(cell)}</th>` : `<td>${escapeHtml(cell)}</td>`)).join('')}</tr>`)
            .join('')}</tbody></table></div>${b.note ? `<p class="note">${inline(b.note)}</p>` : ''}`;
        case 'figure':
          return `<p class="caption">${inline(b.caption)}</p><div class="chart ${b.chart.type === 'line' && (b.chart.height ?? 170) < 150 ? 'short' : ''}" id="rep-fig-${fig++}"></div>${b.note ? `<p class="note">${inline(b.note)}</p>` : ''}`;
      }
    })
    .join('\n');
}

function drawFigures(c: Ctx, blocks: Block[]): void {
  const t = c.theme;
  let fig = 0;
  for (const b of blocks) {
    if (b.kind !== 'figure') continue;
    const el = document.getElementById(`rep-fig-${fig++}`);
    const ch = b.chart;
    if (ch.type === 'line') {
      draw(el, ch.series.map((sr) => ({ x: ch.x, y: sr.y, name: sr.name, type: 'scatter', mode: 'lines', line: { color: sr.color, width: (sr.width ?? 1) * 1.4, dash: sr.dash ? 'dash' : 'solid' }, hovertemplate: `${sr.name}: %{y:${ch.yFormat === 'pct' ? '.1%' : '.1f'}}<extra></extra>` })),
        baseLayout(t, { hovermode: 'x unified', xaxis: { type: 'date' }, yaxis: { title: { text: ch.yTitle }, tickformat: ch.yFormat === 'pct' ? '.0%' : '' }, legend: { orientation: 'h', y: -0.15 } }));
    } else if (ch.type === 'dots') {
      draw(el, [{ x: ch.value, y: ch.categories, type: 'scatter', mode: 'markers', marker: { color: ch.colors, size: 10 }, error_x: { type: 'data', symmetric: false, array: ch.high.map((h, i) => h - ch.value[i]), arrayminus: ch.value.map((v, i) => v - ch.low[i]), color: t.muted, thickness: 1.5 }, hovertemplate: `%{y}: %{x:${ch.xFormat === 'pct' ? '.2%' : '.2f'}}<extra></extra>` }],
        baseLayout(t, { showlegend: false, xaxis: { title: { text: ch.xTitle }, tickformat: ch.xFormat === 'pct' ? '.0%' : '', zeroline: true }, yaxis: { autorange: 'reversed' }, margin: { l: 80, r: 20, t: 10, b: 45 } }));
    } else {
      draw(el, [{ x: ch.values, type: 'histogram', nbinsx: ch.bins, marker: { color: ch.color, opacity: 0.5 }, name: 'Monkeys', hovertemplate: '%{x}: %{y}<extra></extra>' }],
        baseLayout(t, { showlegend: false, bargap: 0.05, xaxis: { title: { text: ch.xTitle } }, yaxis: { title: { text: 'Monkeys' } }, shapes: ch.markers.map((mk) => ({ type: 'line', x0: mk.x, x1: mk.x, yref: 'paper', y0: 0, y1: 1, line: { color: mk.color, width: 2 } })), annotations: ch.markers.map((mk, i) => ({ x: mk.x, y: 1 - (i % 4) * 0.09, yref: 'paper', text: mk.name, showarrow: false, font: { size: 10, color: t.fg }, bgcolor: t.panel, xanchor: 'left' })) }));
    }
  }
}

export async function renderReport(c: Ctx, el: HTMLElement, load: (key: string) => Promise<StrategiesFile>): Promise<void> {
  const blocks = await reportBlocks(c, load);
  el.innerHTML = `
  <section class="card report" id="report">
    <header class="card-head"><div><h2>Results report</h2><p class="muted small">Default configuration of the site</p></div>
      <div class="tools"><button type="button" id="dl-report" class="primary">Download PDF</button></div></header>
    ${toHtml(blocks)}
  </section>`;
  drawFigures(c, blocks);
  el.querySelector<HTMLButtonElement>('#dl-report')!.onclick = () => {
    const bytes = buildPdf(blocks, { footer: `Swiss Equity Portfolio Lab · cedricmasset.ch/backtesting · results report · ${new Date().toISOString().slice(0, 10)}` });
    const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `swiss_equity_portfolio_lab_results_${c.view.period[0]}_${c.view.period[1]}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
}
