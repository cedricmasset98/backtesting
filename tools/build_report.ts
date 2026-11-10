/**
 * Builds the results report (PDF) of the default configuration from the
 * published results in public/data, with pdflatex (latexmk).
 *
 *   node --experimental-strip-types --no-warnings tools/build_report.ts
 *
 * Output: public/report/swiss_equity_portfolio_lab_report.pdf (copied into
 * the site by vite build). The report contains only derived results, like
 * the JSON files it is computed from.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { Manifest, Market, MonkeysFile, StrategiesFile } from '../src/data/types.ts';
import { configKey } from '../src/data/loader.ts';
import { buildView } from '../src/model.ts';
import { defaults } from '../src/state.ts';
import { reportBlocks } from '../src/report/blocks.ts';
import { toLatex } from '../src/report/latex.ts';

const DATA = 'public/data';
const WORK = 'build/report';
const OUT = 'public/report/swiss_equity_portfolio_lab_report.pdf';

const read = <T>(path: string): T => JSON.parse(readFileSync(`${DATA}/${path}`, 'utf8')) as T;

const m = read<Manifest>('manifest.json');
const market = read<Market>('market.json');
const s = defaults(m);
const strat = read<StrategiesFile>(`strategies/${configKey(s.window, s.cov, s.cap)}.json`);
const mkPath = `monkeys/L${s.window}_${s.freq}_k${s.k}_s${s.seed}.json`;
const monkeys = existsSync(`${DATA}/${mkPath}`) ? read<MonkeysFile>(mkPath) : null;
const view = buildView(strat, market, monkeys, s);

const blocks = await reportBlocks({ s, m, market, strat, monkeys, view }, async (key) => read<StrategiesFile>(`strategies/${key}.json`));
const tex = toLatex(blocks, {
  title: 'Swiss Equity Portfolio Lab — Results report',
  footer: `Swiss Equity Portfolio Lab · cedricmasset.ch/backtesting · ${view.period[0]} – ${view.period[1]} · built ${m.generated_at.slice(0, 10)}`,
});

mkdirSync(WORK, { recursive: true });
writeFileSync(`${WORK}/report.tex`, tex);
const run = spawnSync('latexmk', ['-pdf', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', 'report.tex'], { cwd: WORK, encoding: 'utf8' });
if (run.status !== 0) {
  const log = existsSync(`${WORK}/report.log`) ? readFileSync(`${WORK}/report.log`, 'utf8') : run.stdout + run.stderr;
  const err = log.split('\n').findIndex((l: string) => /^!|:\d+: /.test(l));
  console.error(log.split('\n').slice(Math.max(0, err - 2), err + 15).join('\n'));
  console.error('report: pdflatex failed');
  process.exit(1);
}
const log = readFileSync(`${WORK}/report.log`, 'utf8');
const overfull = (log.match(/Overfull \\hbox \(([\d.]+)pt/g) ?? []).filter((l: string) => parseFloat(l.split('(')[1]) > 2);
if (overfull.length) console.warn(`report: ${overfull.length} overfull line(s) > 2pt`);
mkdirSync('public/report', { recursive: true });
copyFileSync(`${WORK}/report.pdf`, OUT);
console.log(`report: ${OUT} (${(readFileSync(OUT).length / 1024).toFixed(0)} kB, ${blocks.length} blocks)`);
