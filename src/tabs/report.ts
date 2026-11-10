/**
 * Plain-language report of the results, generated from the numbers shown on the
 * site for the default configuration and period, i.e. the site as it opens (no
 * hard-coded result: every sentence is assembled from the computed statistics,
 * so it follows data updates). One list of blocks feeds the page and the PDF.
 */

import type { SeriesId, StrategiesFile } from '../data/types.ts';
import { holm, sharpeDiffBootstrap } from '../engine/bootstrap.ts';
import { fitModel, MODELS, type FitOutcome, type ModelId } from '../engine/factors.ts';
import { percentileRank, perfStats } from '../engine/metrics.ts';
import { configKey } from '../data/loader.ts';
import { availableRange, buildView } from '../model.ts';
import { LABEL, SHORT } from '../ui/charts.ts';
import { basisLabel, configLabel, decomposition, periodLabel, stats, type Ctx } from '../ui/context.ts';
import { buildPdf, type Block } from '../ui/pdf.ts';
import { escapeHtml, num, pct, signedPct } from '../ui/format.ts';

const PLAIN: Record<string, string> = {
  SMB: 'small companies',
  HML: 'value stocks',
  RMW: 'profitable companies',
  CMA: 'companies with low asset growth',
  MOM: 'recent winners (momentum)',
};

const fp = (p: number) => (p < 0.001 ? '< 0.001' : `= ${num(p, 3)}`);

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

async function robustness(c: Ctx, strategies: SeriesId[], load: (key: string) => Promise<StrategiesFile>): Promise<string> {
  const { m, s } = c;
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
    return `Over the common period ${start} – ${end}, the ${total} combinations of estimation window (${m.grid.windows.join(', ')} months) and rebalancing frequency were compared with the SPI (Sharpe ratio, same costs, covariance and cap). ${robust.length ? `**${list(robust.map((id) => SHORT[id]))} beat the SPI in every combination**` : 'No strategy beat the SPI in every combination'}${never.length ? `; ${list(never.map((id) => SHORT[id]))} never did` : ''}${mixed.length ? `; for ${list(mixed.map((id) => `${SHORT[id]} (${wins.get(id)}/${total})`))} the answer depends on the settings` : ''}. A conclusion that changes with the settings should be treated with caution.`;
  } catch (e) {
    return `The other configurations could not be loaded (${(e as Error).message}).`;
  }
}

export async function reportBlocks(c: Ctx, load: (key: string) => Promise<StrategiesFile>): Promise<Block[]> {
  const { view, s, m } = c;
  const strategies = (['EW', 'GMV', 'ERC', 'TP', 'MDP', 'IVP'] as SeriesId[]).filter((id) => view.series.has(id));
  const st = (id: SeriesId) => stats(c, id);
  const spi = st('CW');
  const years = view.months.length / 12;
  const controlled = m.survivorship.controlled_start;
  const biased = !!controlled && view.period[0] < controlled;
  const S = (id: SeriesId) => SHORT[id];

  const above = strategies.filter((id) => st(id).cagr > spi.cagr);
  const below = strategies.filter((id) => st(id).cagr <= spi.cagr);
  const lowerVol = strategies.filter((id) => st(id).vol < spi.vol);
  const minVol = [...strategies].sort((a, b) => st(a).vol - st(b).vol)[0];
  const shallower = strategies.filter((id) => st(id).maxDD > spi.maxDD);

  const ex = (id: SeriesId) => view.series.get(id)!.r.map((x, i) => x - view.rf[i]);
  const boots = strategies.map((id) => sharpeDiffBootstrap(ex(id), ex('CW'), { seed: 101 }));
  const adj = holm(boots.map((b) => b.pvalue));
  const higherSR = strategies.filter((id) => st(id).sharpe > spi.sharpe);
  const signif = strategies.filter((_, i) => adj[i] < 0.05);
  const signifUp = signif.filter((id) => st(id).sharpe > spi.sharpe);
  const signifDown = signif.filter((id) => st(id).sharpe <= spi.sharpe);

  const uni = decomposition(c, 'EW')!.universe;
  const weighting = strategies.filter((id) => id !== 'EW').map((id) => ({ id, v: decomposition(c, id)!.weighting })).sort((a, b) => b.v - a.v);

  const fdata = { months: c.market.months, rf: c.market.rf, factors: c.market.factors };
  const fac = (id: SeriesId): FitOutcome => {
    for (const mod of ['FF5MOM', 'FF5', 'CARHART', 'FF3', 'CAPM'] as ModelId[]) {
      const f = fitModel(view.months, view.series.get(id)!.r, fdata, mod, 'HAC');
      if (f.ok) return f;
    }
    return fitModel(view.months, view.series.get(id)!.r, fdata, 'CAPM', 'HAC');
  };
  const fits = new Map(strategies.map((id) => [id, fac(id)] as const));
  const anyFit = [...fits.values()].find((f) => f.ok) as Extract<FitOutcome, { ok: true }> | undefined;
  const alphaAdj = holm(strategies.map((id) => { const f = fits.get(id)!; return f.ok ? f.result.pvalue[0] : 1; }));

  const costDrag = strategies
    .map((id) => ({ id, drag: stats(c, id, 'gross').cagr - stats(c, id, 'net').cagr, to: (12 * view.series.get(id)!.turnover.reduce((a: number, b) => a + (b ?? 0), 0)) / view.months.length }))
    .sort((a, b) => b.drag - a.drag);

  const mk = view.monkeys.r.map((r) => perfStats(r, view.rf, view.spi));
  const mkAvg = view.series.has('MONKEYS') ? st('MONKEYS') : null;
  const mkSharpe = mk.map((x) => x.sharpe);

  const factorText = (id: SeriesId, k: number): string => {
    const f = fits.get(id)!;
    if (!f.ok) return `**${S(id)}**: factor model not estimable (${f.reason}).`;
    const r = f.result;
    const beta = r.beta[r.names.indexOf('MKT')];
    const tilts = r.names
      .map((n, i) => ({ n, b: r.beta[i], p: r.pvalue[i] }))
      .filter((x) => x.n in PLAIN && x.p < 0.05)
      .map((x) => `${x.b > 0 ? 'towards' : 'away from'} ${PLAIN[x.n]} (${x.n} ${num(x.b, 2)})`);
    const a = 12 * r.beta[0];
    const pa = alphaAdj[k];
    const alphaTxt = pa < 0.05
      ? `an unexplained return (alpha) of ${signedPct(a, 1)} per year, statistically significant even after adjusting for the ${strategies.length} strategies tested (Holm p ${fp(pa)})`
      : r.pvalue[0] < 0.05
        ? `an alpha of ${signedPct(a, 1)} per year that is significant on its own (p ${fp(r.pvalue[0])}) but not once the ${strategies.length} strategies tested together are accounted for (Holm p ${fp(pa)})`
        : `no statistically significant unexplained return (alpha ${signedPct(a, 1)} per year, p ${fp(r.pvalue[0])})`;
    return `**${S(id)}**: market beta ${num(beta, 2)} — it moves ${beta < 0.85 ? 'less than' : beta > 1.15 ? 'more than' : 'about as much as'} the market${tilts.length ? `; significant tilts ${list(tilts)}` : '; no significant style tilt'}; ${alphaTxt}.`;
  };

  const all: SeriesId[] = ['CW', ...strategies, ...(mkAvg ? (['MONKEYS'] as SeriesId[]) : [])];
  const blocks: Block[] = [
    { kind: 'title', text: 'Swiss Equity Portfolio Lab — results in plain language' },
    { kind: 'meta', text: `${configLabel(c)} · ${periodLabel(c)} · ${basisLabel(c)}. Data up to ${m.data_last_date}; results built ${m.generated_at.slice(0, 10)}.` },
    { kind: 'note', text: 'This report analyses the default settings of the site (as it opens, settings above), whatever is selected in the settings bar. It is written automatically from the computed results: when the data are updated, the text follows. It describes what happened; it is not a forecast or investment advice.' },
  ];
  if (biased) blocks.push({ kind: 'warn', text: `The period starts before ${controlled}: results before that date carry a strong survivorship bias (delisted companies are missing), which flatters the stock-based strategies.` });
  blocks.push(
    { kind: 'h2', text: 'Key figures' },
    {
      kind: 'table',
      head: ['Portfolio', 'Return p.a.', 'Volatility', 'Sharpe', 'Worst fall', '100 CHF →'],
      rows: all.map((id) => [LABEL[id], pct(st(id).cagr, 1), pct(st(id).vol, 1), num(st(id).sharpe, 2), pct(st(id).maxDD, 1), num(100 * (1 + st(id).cumulative), 0)]),
    },
    { kind: 'h2', text: '1. What became of 100 CHF' },
    { kind: 'p', text: `Over ${num(years, 1)} years (${view.period[0]} to ${view.period[1]}), 100 CHF invested in the Swiss market index (SPI, dividends reinvested) grew to **${num(100 * (1 + spi.cumulative), 0)} CHF**, i.e. ${pct(spi.cagr, 1)} per year. ${above.length ? `${list(above.map((id) => `${S(id)} (${pct(st(id).cagr, 1)})`))} did better than the index` : 'No strategy did better than the index'}${below.length ? `, while ${list(below.map((id) => `${S(id)} (${pct(st(id).cagr, 1)})`))} did worse` : ''}.${mkAvg ? ` For comparison, 100 portfolios of ${s.k} stocks picked at random earned ${pct(mkAvg.cagr, 1)} per year as one combined portfolio.` : ''}` },
    { kind: 'h2', text: '2. How bumpy was the ride' },
    { kind: 'p', text: `Volatility measures how much returns swing. The SPI's was ${pct(spi.vol, 1)} per year and its worst fall from a peak (maximum drawdown) was ${pct(spi.maxDD, 1)}. ${lowerVol.length ? `${list(lowerVol.map((id) => `${S(id)} (${pct(st(id).vol, 1)})`))} ${lowerVol.length > 1 ? 'were' : 'was'} calmer than the index` : 'All strategies were more volatile than the index'}; the calmest was **${LABEL[minVol]}**, which is designed for exactly that. ${shallower.length ? `${list(shallower.map(S))} also had a smaller worst-case loss than the SPI.` : 'None had a smaller worst-case loss than the SPI.'}` },
    { kind: 'h2', text: '3. Return per unit of risk — and is it more than luck?' },
    { kind: 'p', text: `The Sharpe ratio divides the return above the risk-free rate by the volatility. The SPI's was ${num(spi.sharpe, 2)}; ${higherSR.length ? `${list(higherSR.map((id) => `${S(id)} (${num(st(id).sharpe, 2)})`))} had a higher one` : 'no strategy had a higher one'}. With ${view.months.length} months of data, such differences can easily arise by chance. A resampling test (stationary bootstrap) with a correction for comparing ${strategies.length} strategies at once (Holm) finds ${signif.length === 0 ? '**no statistically significant difference** with the SPI at the 5 % level. The data cannot tell these differences from noise.' : `${signifUp.length ? `a significantly higher Sharpe ratio for **${list(signifUp.map(S))}**` : ''}${signifUp.length && signifDown.length ? ' and ' : ''}${signifDown.length ? `a significantly lower one for **${list(signifDown.map(S))}**` : ''} (5 % level).${signif.length < strategies.length ? ' For the others, the data cannot tell a real difference from noise.' : ''}`}` },
    { kind: 'h2', text: '4. Choice of stocks or way of weighting them?' },
    { kind: 'p', text: `The strategies pick from the same pool of liquid Swiss stocks, which is not exactly the SPI. Simply holding every stock of that pool with equal weights (EW) earned ${signedPct(uni, 1)} per year compared with the SPI: this gap comes from the pool itself and from giving small companies as much weight as large ones. Measured against EW, the weighting rules added ${list(weighting.map((x) => `${signedPct(x.v, 1)} (${S(x.id)})`))} per year. Only this second part reflects the portfolio construction itself.` },
    { kind: 'h2', text: '5. What drives the returns (factor analysis)' },
  );
  if (anyFit) {
    blocks.push(
      { kind: 'p', text: `Each strategy's monthly excess returns are explained with the ${MODELS[anyFit.model].label} model on Swiss factors (Newey-West standard errors, ${anyFit.result.n} months, ${anyFit.sample.months[0]} – ${anyFit.sample.months.at(-1)}). A tilt is reported when it is significant at 5 %.` },
      { kind: 'bullets', items: strategies.map((id, k) => factorText(id, k)) },
      { kind: 'p', text: 'A positive alpha means that the return is not explained by the market and the five style factors. It can coexist with a Sharpe ratio that is not significantly different from the SPI\'s (point 3): the two tests ask different questions — beating a factor benchmark versus beating the index. Low-risk strategies earning more than their low beta implies is a well-documented pattern (the "low-volatility anomaly").' },
    );
  } else blocks.push({ kind: 'p', text: 'The factor models cannot be estimated over this period.' });
  blocks.push(
    { kind: 'h2', text: '6. Trading costs' },
    { kind: 'p', text: `At ${s.bps} bp per franc traded, costs reduced annual returns by ${list(costDrag.map((x) => `${pct(x.drag, 2)} for ${S(x.id)} (turnover ${num(x.to, 1)}× per year)`))}. ${costDrag[0].drag > 0.005 ? `The most active strategy, ${S(costDrag[0].id)}, is the most sensitive to the cost assumption (see the cost scenarios in the Robustness tab).` : 'Costs matter little at this level and rebalancing frequency.'}` },
    { kind: 'h2', text: '7. Against the monkeys' },
    { kind: 'p', text: mk.length ? `One hundred "monkeys" each held ${s.k} stocks drawn at random at every rebalancing date. ${mk.filter((x) => x.sharpe > spi.sharpe).length} of them had a higher Sharpe ratio than the SPI. Ranked among the monkeys by Sharpe ratio, ${list(strategies.map((id) => `${S(id)} is better than ${Math.round(100 * percentileRank(mkSharpe, st(id).sharpe))} %`))} of them. This shows how much of a result could come from luck with the same stocks; it depends on the drawing rules and is not a formal test.` : 'Monkeys not available for this configuration.' },
    { kind: 'h2', text: '8. Do the conclusions depend on the settings?' },
    { kind: 'p', text: await robustness(c, strategies, load) },
    { kind: 'h2', text: '9. What to keep in mind' },
    {
      kind: 'bullets',
      items: [
        `${num(years, 1)} years is short for comparing average returns: the uncertainty is large (see point 3).`,
        biased ? `Before ${controlled} the data miss most delisted companies (survivorship bias).` : `From ${controlled ?? 'the start'} the data include delisted companies, but the survivorship bias is reduced, not necessarily eliminated.`,
        'The stock pool is reconstructed from listed Swiss shares, not the official SPI list; the SPI is the official index.',
        'Results are historical and descriptive. Choosing the setting with the best past result and expecting it to repeat would be misleading.',
      ],
    },
    { kind: 'h2', text: 'Glossary' },
    {
      kind: 'bullets',
      items: [
        '**Return p.a. (CAGR)** — average yearly growth rate of the invested amount.',
        '**Volatility** — typical size of yearly fluctuations (annualised standard deviation).',
        '**Worst fall (maximum drawdown)** — largest fall from a previous peak.',
        '**Sharpe ratio** — return above the risk-free rate per unit of volatility.',
        '**Beta** — sensitivity to the market: 0.5 means the strategy tends to move half as much as the market.',
        '**Alpha** — the part of the return that the factors do not explain.',
        '**Statistically significant** — unlikely to be due to chance alone (here: less than 5 % probability under the assumptions of the test).',
      ],
    },
  );
  return blocks;
}

function inline(text: string): string {
  return escapeHtml(text)
    .split('**')
    .map((t, i) => (i % 2 ? `<strong>${t}</strong>` : t))
    .join('');
}

function toHtml(blocks: Block[]): string {
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
        case 'p':
          return `<p>${inline(b.text)}</p>`;
        case 'bullets':
          return `<ul class="plain">${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;
        case 'table':
          return `<div class="table-wrap"><table class="data"><thead><tr>${b.head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((cell, j) => (j === 0 ? `<th scope="row">${inline(cell)}</th>` : `<td>${inline(cell)}</td>`)).join('')}</tr>`).join('')}</tbody></table></div>`;
      }
    })
    .join('\n');
}

export async function renderReport(c: Ctx, el: HTMLElement, load: (key: string) => Promise<StrategiesFile>): Promise<void> {
  const blocks = await reportBlocks(c, load);
  el.innerHTML = `
  <section class="card report" id="report">
    <header class="card-head"><div><h2>Results in plain language</h2><p class="muted small">Default settings of the site</p></div>
      <div class="tools"><button type="button" id="dl-report" class="primary">Download PDF</button></div></header>
    ${toHtml(blocks)}
  </section>`;
  el.querySelector<HTMLButtonElement>('#dl-report')!.onclick = () => {
    const bytes = buildPdf(blocks, { footer: `Swiss Equity Portfolio Lab · cedricmasset.ch/backtesting · ${new Date().toISOString().slice(0, 10)}` });
    const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `swiss_equity_portfolio_lab_report_${c.view.period[0]}_${c.view.period[1]}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
}
