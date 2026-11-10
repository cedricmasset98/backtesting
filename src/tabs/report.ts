/**
 * Plain-language report of the results, generated from the numbers shown on the
 * site for the selected configuration and period (no hard-coded result: every
 * sentence is assembled from the computed statistics, so it follows the settings).
 */

import type { SeriesId, StrategiesFile } from '../data/types.ts';
import { holm, sharpeDiffBootstrap } from '../engine/bootstrap.ts';
import { fitModel, MODELS, type FitOutcome, type ModelId } from '../engine/factors.ts';
import { percentileRank, perfStats } from '../engine/metrics.ts';
import { configKey } from '../data/loader.ts';
import { availableRange, buildView } from '../model.ts';
import { LABEL, SHORT } from '../ui/charts.ts';
import { basisLabel, configLabel, decomposition, periodLabel, stats, type Ctx } from '../ui/context.ts';
import { download } from '../ui/export.ts';
import { escapeHtml, num, pct, signedPct } from '../ui/format.ts';

const PLAIN: Record<string, string> = {
  SMB: 'small companies',
  HML: 'value stocks',
  RMW: 'profitable companies',
  CMA: 'companies with low asset growth',
  MOM: 'recent winners (momentum)',
};

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const strong = (s: string) => `<strong>${s}</strong>`;

export async function renderReport(c: Ctx, el: HTMLElement, load: (key: string) => Promise<StrategiesFile>): Promise<void> {
  const { view, s, m } = c;
  const strategies = (['EW', 'GMV', 'ERC', 'TP', 'MDP', 'IVP'] as SeriesId[]).filter((id) => view.series.has(id));
  const name = (id: SeriesId) => `${LABEL[id]} (${SHORT[id]})`;
  const st = (id: SeriesId) => stats(c, id);
  const spi = st('CW');
  const years = view.months.length / 12;
  const controlled = m.survivorship.controlled_start;
  const biased = !!controlled && view.period[0] < controlled;

  // 1. wealth
  const byFinal = [...strategies].sort((a, b) => st(b).cumulative - st(a).cumulative);
  const above = strategies.filter((id) => st(id).cagr > spi.cagr);
  const below = strategies.filter((id) => st(id).cagr <= spi.cagr);

  // 2. risk
  const lowerVol = strategies.filter((id) => st(id).vol < spi.vol);
  const minVol = [...strategies].sort((a, b) => st(a).vol - st(b).vol)[0];
  const shallower = strategies.filter((id) => st(id).maxDD > spi.maxDD);

  // 3. Sharpe and bootstrap against the SPI
  const ex = (id: SeriesId) => view.series.get(id)!.r.map((x, i) => x - view.rf[i]);
  const boots = strategies.map((id) => sharpeDiffBootstrap(ex(id), ex('CW'), { seed: 101 }));
  const adj = holm(boots.map((b) => b.pvalue));
  const higherSR = strategies.filter((id) => st(id).sharpe > spi.sharpe);
  const signif = strategies.filter((_, i) => adj[i] < 0.05);
  const signifUp = signif.filter((id) => st(id).sharpe > spi.sharpe);
  const signifDown = signif.filter((id) => st(id).sharpe <= spi.sharpe);

  // 4. universe vs weighting
  const uni = decomposition(c, 'EW')!.universe;
  const weighting = strategies.filter((id) => id !== 'EW').map((id) => ({ id, v: decomposition(c, id)!.weighting })).sort((a, b) => b.v - a.v);

  // 5. factors: the richest model that can be estimated
  const fac = (id: SeriesId): FitOutcome => {
    for (const mod of ['FF5MOM', 'FF5', 'CARHART', 'FF3', 'CAPM'] as ModelId[]) {
      const f = fitModel(view.months, view.series.get(id)!.r, { months: c.market.months, rf: c.market.rf, factors: c.market.factors }, mod, 'HAC');
      if (f.ok) return f;
    }
    return fitModel(view.months, view.series.get(id)!.r, { months: c.market.months, rf: c.market.rf, factors: c.market.factors }, 'CAPM', 'HAC');
  };
  const fits = new Map(strategies.map((id) => [id, fac(id)] as const));
  const anyFit = [...fits.values()].find((f) => f.ok) as Extract<FitOutcome, { ok: true }> | undefined;
  // alphas are tested for all strategies at once: Holm adjustment across strategies
  const alphaP = strategies.map((id) => { const f = fits.get(id)!; return f.ok ? f.result.pvalue[0] : 1; });
  const alphaAdj = new Map(strategies.map((id, i) => [id, holm(alphaP)[i]] as const));

  // 6. costs
  const costDrag = strategies.map((id) => ({ id, drag: stats(c, id, 'gross').cagr - stats(c, id, 'net').cagr, to: (12 * view.series.get(id)!.turnover.reduce((a: number, b) => a + (b ?? 0), 0)) / view.months.length })).sort((a, b) => b.drag - a.drag);

  // 7. monkeys
  const mk = view.monkeys.r.map((r) => perfStats(r, view.rf, view.spi));
  const mkAvg = view.series.has('MONKEYS') ? st('MONKEYS') : null;
  const mkSharpe = mk.map((x) => x.sharpe);
  const mkBeatSpi = mk.filter((x) => x.sharpe > spi.sharpe).length;

  const factorText = (id: SeriesId): string => {
    const f = fits.get(id)!;
    if (!f.ok) return `${name(id)}: factor model not estimable (${escapeHtml(f.reason)}).`;
    const r = f.result;
    const j = (k: string) => r.names.indexOf(k);
    const beta = r.beta[j('MKT')];
    const tilts = r.names
      .map((n, i) => ({ n, b: r.beta[i], p: r.pvalue[i] }))
      .filter((x) => x.n in PLAIN && x.p < 0.05)
      .map((x) => `${x.b > 0 ? 'towards' : 'away from'} ${PLAIN[x.n]} (${x.n} ${num(x.b, 2)})`);
    const alphaA = 12 * r.beta[0];
    const pa = alphaAdj.get(id)!;
    const alphaTxt = pa < 0.05
      ? `an unexplained return (alpha) of ${signedPct(alphaA, 1)} per year, statistically significant even after adjusting for the ${strategies.length} strategies tested (Holm p = ${num(pa, 3)})`
      : r.pvalue[0] < 0.05
        ? `an alpha of ${signedPct(alphaA, 1)} per year that is significant on its own (p = ${num(r.pvalue[0], 3)}) but not once the ${strategies.length} strategies tested together are accounted for (Holm p = ${num(pa, 2)})`
        : `no statistically significant unexplained return (alpha ${signedPct(alphaA, 1)} per year, p = ${num(r.pvalue[0], 2)})`;
    return `${strong(SHORT[id])}: market beta ${num(beta, 2)} — it moves ${beta < 0.85 ? 'less than' : beta > 1.15 ? 'more than' : 'about as much as'} the market${tilts.length ? `; significant tilts ${list(tilts)}` : '; no significant style tilt'}; ${alphaTxt}.`;
  };

  const settings = `${configLabel(c)} · ${periodLabel(c)} · ${basisLabel(c)}`;
  el.innerHTML = `
  <section class="card report" id="report">
    <header class="card-head"><div><h2>Results in plain language</h2>
      <p class="muted small">${escapeHtml(settings)}</p></div>
      <div class="tools"><button type="button" id="dl-report">Download (text)</button></div></header>
    <p class="note">Written automatically from the results of this site for the settings above: change the period, window, rebalancing, costs or caps and the report follows. It describes what happened; it is not a forecast or investment advice.</p>
    ${biased ? `<p class="warn">The period starts before ${controlled}: the results before that date carry a strong survivorship bias (delisted companies are missing), which flatters the stock-based strategies.</p>` : ''}

    <div class="keyfigs">
      <div>SPI total return<strong>${pct(spi.cagr, 1)} p.a.</strong><span class="muted small">100 CHF → ${num(100 * (1 + spi.cumulative), 0)} CHF</span></div>
      <div>Strategies' annual returns<strong>${pct(st(byFinal[byFinal.length - 1]).cagr, 1)} to ${pct(st(byFinal[0]).cagr, 1)}</strong><span class="muted small">${SHORT[byFinal[byFinal.length - 1]]} to ${SHORT[byFinal[0]]}</span></div>
      <div>Lowest volatility<strong>${pct(st(minVol).vol, 1)}</strong><span class="muted small">${SHORT[minVol]} (SPI ${pct(spi.vol, 1)})</span></div>
      <div>Significant Sharpe differences vs SPI<strong>${signif.length} of ${strategies.length}</strong><span class="muted small">bootstrap, Holm-adjusted, 5 %</span></div>
    </div>

    <h3>1. What became of 100 CHF</h3>
    <p>Over ${num(years, 1)} years (${view.period[0]} to ${view.period[1]}), 100 CHF invested in the Swiss market index (SPI, dividends reinvested) grew to ${strong(`${num(100 * (1 + spi.cumulative), 0)} CHF`)}, i.e. ${pct(spi.cagr, 1)} per year.
    ${above.length ? `${list(above.map((id) => `${SHORT[id]} (${pct(st(id).cagr, 1)})`))} did better than the index` : 'No strategy did better than the index'}${below.length ? `, while ${list(below.map((id) => `${SHORT[id]} (${pct(st(id).cagr, 1)})`))} did worse` : ''}.
    ${mkAvg ? `For comparison, 100 portfolios of ${s.k} stocks picked at random earned ${pct(mkAvg.cagr, 1)} per year on average (as one combined portfolio).` : ''}</p>

    <h3>2. How bumpy was the ride</h3>
    <p>Volatility measures how much returns swing from month to month. The SPI's was ${pct(spi.vol, 1)} per year and its worst fall from a peak (maximum drawdown) was ${pct(spi.maxDD, 1)}.
    ${lowerVol.length ? `${list(lowerVol.map((id) => `${SHORT[id]} (${pct(st(id).vol, 1)})`))} ${lowerVol.length > 1 ? 'were' : 'was'} calmer than the index` : 'All strategies were more volatile than the index'}; the calmest was ${strong(LABEL[minVol])}, which was designed for exactly that.
    ${shallower.length ? `${list(shallower.map((id) => SHORT[id]))} also had a smaller worst-case loss than the SPI.` : 'None had a smaller worst-case loss than the SPI.'}</p>

    <h3>3. Return per unit of risk — and is it more than luck?</h3>
    <p>The Sharpe ratio divides the return above the risk-free rate by the volatility. The SPI's was ${num(spi.sharpe, 2)}; ${higherSR.length ? `${list(higherSR.map((id) => `${SHORT[id]} (${num(st(id).sharpe, 2)})`))} had a higher one` : 'no strategy had a higher one'}.
    With ${view.months.length} months of data, such differences can easily arise by chance. A resampling test (stationary bootstrap) with a correction for comparing ${strategies.length} strategies at once (Holm) finds
    ${signif.length === 0 ? `${strong('no statistically significant difference')} with the SPI at the 5 % level` : `${signifUp.length ? `a significantly higher Sharpe ratio for ${list(signifUp.map((id) => SHORT[id]))}` : ''}${signifUp.length && signifDown.length ? ' and ' : ''}${signifDown.length ? `a significantly lower one for ${list(signifDown.map((id) => SHORT[id]))}` : ''} (5 % level)`}.
    ${signif.length === 0 ? 'The data cannot tell these differences from noise.' : signif.length < strategies.length ? 'For the others, the data cannot tell a real difference from noise.' : ''}</p>

    <h3>4. Choice of stocks or way of weighting them?</h3>
    <p>The strategies pick from the same pool of liquid Swiss stocks, which is not exactly the SPI. Simply holding every stock of that pool with equal weights (EW) earned ${signedPct(uni, 1)} per year compared with the SPI: this gap comes from the pool itself and from giving small companies as much weight as large ones.
    Measured against EW, the weighting rules added ${list(weighting.map((x) => `${signedPct(x.v, 1)} (${SHORT[x.id]})`))} per year. Only this second part reflects the portfolio construction itself.</p>

    <h3>5. What drives the returns (factor analysis)</h3>
    ${anyFit ? `<p>Each strategy's monthly excess returns are explained with the ${MODELS[anyFit.model].label} model on Swiss factors (Newey-West standard errors, ${anyFit.result.n} months, ${anyFit.sample.months[0]} – ${anyFit.sample.months.at(-1)}). A tilt is reported when it is significant at 5 %.</p>
    <ul class="plain">${strategies.map((id) => `<li>${factorText(id)}</li>`).join('')}</ul>
    <p>A positive alpha means the return is not explained by the market and the five style factors. It can coexist with a Sharpe ratio that is not significantly different from the SPI's (point 3): the two tests ask different questions — beating a factor benchmark versus beating the index. Low-risk strategies earning more than their low beta implies is a well-documented pattern (the "low-volatility anomaly").</p>` : '<p>The factor models cannot be estimated over this period.</p>'}

    <h3>6. Trading costs</h3>
    <p>At ${s.bps} bp per franc traded, costs reduced annual returns by ${list(costDrag.map((x) => `${pct(x.drag, 2)} for ${SHORT[x.id]} (turnover ${num(x.to, 1)}× per year)`))}.
    ${costDrag[0].drag > 0.005 ? `The most active strategy, ${SHORT[costDrag[0].id]}, is the most sensitive to the cost assumption: see the cost scenarios in the Robustness tab.` : 'Costs matter little at this level and rebalancing frequency.'}</p>

    <h3>7. Against the monkeys</h3>
    ${mk.length ? `<p>One hundred "monkeys" each held ${s.k} stocks drawn at random at every rebalancing date. ${mkBeatSpi} of them had a higher Sharpe ratio than the SPI. Ranked among the monkeys by Sharpe ratio, ${list(strategies.map((id) => `${SHORT[id]} is better than ${Math.round(100 * percentileRank(mkSharpe, st(id).sharpe))} %`))} of them.
    This shows how much of a result could come from luck with the same stocks; it depends on the drawing rules and is not a formal test.</p>` : '<p>Monkeys not available for this configuration.</p>'}

    <h3>8. Do the conclusions depend on the settings?</h3>
    <p id="rep-robust" class="muted">Comparing the other estimation windows and rebalancing frequencies…</p>

    <h3>9. What to keep in mind</h3>
    <ul class="plain">
      <li>${num(years, 1)} years is short for comparing average returns: the uncertainty is large (see point 3).</li>
      <li>${biased ? `Before ${controlled} the data miss most delisted companies (survivorship bias).` : `From ${controlled ?? 'the start'} the data include delisted companies, but the survivorship bias is reduced, not necessarily eliminated.`}</li>
      <li>The stock pool is reconstructed from listed Swiss shares, not the official SPI list; the SPI is the official index.</li>
      <li>Results are historical and descriptive. Choosing the setting with the best past result and expecting it to repeat would be misleading.</li>
    </ul>

    <details><summary>Glossary</summary><ul class="plain">
      <li><strong>CAGR</strong> — average yearly growth rate of the invested amount.</li>
      <li><strong>Volatility</strong> — typical size of yearly fluctuations (standard deviation, annualised).</li>
      <li><strong>Maximum drawdown</strong> — largest fall from a previous peak.</li>
      <li><strong>Sharpe ratio</strong> — return above the risk-free rate per unit of volatility.</li>
      <li><strong>Beta</strong> — sensitivity to the market: 0.5 means the strategy tends to move half as much as the market.</li>
      <li><strong>Alpha</strong> — the part of the return the factors do not explain.</li>
      <li><strong>Statistically significant</strong> — unlikely to be due to chance alone (here: less than 5 % probability under the test's assumptions).</li>
    </ul></details>
  </section>`;

  el.querySelector<HTMLButtonElement>('#dl-report')!.onclick = () => {
    const txt = (el.querySelector('#report') as HTMLElement).innerText.replace(/Download \(text\)\n?/, '');
    download('swiss_equity_portfolio_lab_report.txt', txt, 'text/plain;charset=utf-8');
  };

  // robustness across windows × frequencies (same covariance, cap and costs)
  try {
    const files = await Promise.all(m.grid.windows.map((w) => load(configKey(w, s.cov, s.cap))));
    const ranges = files.map((f) => availableRange(f, c.market));
    const start = [s.start, ...ranges.map((r) => r[0])].sort().at(-1)!;
    const end = [s.end, ...ranges.map((r) => r[1])].sort()[0];
    const wins = new Map<SeriesId, number>(strategies.map((id) => [id, 0]));
    let total = 0;
    for (const f of files) {
      for (const fq of m.grid.freqs) {
        const v = buildView(f, c.market, null, { ...s, freq: fq, start, end });
        const spiSR = perfStats(v.series.get('CW')!.r, v.rf, v.spi).sharpe;
        total++;
        for (const id of strategies) if (perfStats(v.series.get(id)!.r, v.rf, v.spi).sharpe > spiSR) wins.set(id, wins.get(id)! + 1);
      }
    }
    const robust = strategies.filter((id) => wins.get(id) === total);
    const never = strategies.filter((id) => wins.get(id) === 0);
    const mixed = strategies.filter((id) => wins.get(id)! > 0 && wins.get(id)! < total);
    const p = el.querySelector('#rep-robust') as HTMLElement;
    p.classList.remove('muted');
    p.innerHTML = `Over the common period ${start} – ${end}, the ${total} combinations of estimation window (${m.grid.windows.join(', ')} months) and rebalancing frequency were compared with the SPI (Sharpe ratio, same costs, covariance and cap).
      ${robust.length ? `${list(robust.map((id) => SHORT[id]))} beat the SPI in every combination` : 'No strategy beat the SPI in every combination'}${never.length ? `; ${list(never.map((id) => SHORT[id]))} never did` : ''}${mixed.length ? `; for ${list(mixed.map((id) => `${SHORT[id]} (${wins.get(id)}/${total})`))} the answer depends on the settings` : ''}.
      A conclusion that changes with the settings should be treated with caution.`;
  } catch (e) {
    (el.querySelector('#rep-robust') as HTMLElement).textContent = `Other configurations unavailable: ${(e as Error).message}`;
  }
}
