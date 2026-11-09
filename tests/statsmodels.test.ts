/**
 * The TypeScript regression engine (reused from Empirical-Asset-Pricing)
 * against statsmodels: five factor models × three inference methods, on a
 * synthetic dataset and on the published strategy returns of the default
 * configuration (same sample rule as the browser).
 * Reference: tests/reference/statsmodels_factor.json (python -m pipeline.statsref).
 * With STRICT_REFERENCE=1 (CI) the reference must exist and come from statsmodels;
 * with REQUIRE_PUBLISHED=1 (deployment build) it must include the published cases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ols, type CovType } from '../src/engine/ols.ts';
import { breuschPagan, jarqueBera, ljungBox } from '../src/engine/diagnostics.ts';
import { buildSample, MODELS, type FactorData, type ModelId } from '../src/engine/factors.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const refPath = join(root, 'tests', 'reference', 'statsmodels_factor.json');
const strict = process.env.STRICT_REFERENCE === '1';

function close(a: number, b: number, rel: number, abs: number, msg: string) {
  assert.ok(Math.abs(a - b) <= Math.max(abs, rel * Math.abs(b)), `${msg}: engine ${a}, reference ${b}`);
}

interface Case {
  model: ModelId;
  cov: CovType;
  strategy?: string;
  beta: number[];
  se: number[];
  stat: number[];
  pvalue: number[];
  ci_low: number[];
  ci_high: number[];
  r2: number;
  r2adj: number;
  n: number;
  hac_lags: number | null;
  diagnostics?: { jb: number[]; bp: number[]; lb: number[]; lb_lags: number };
}

function compare(c: Case, y: number[], x: number[][], label: string) {
  const res = ols(y, x, ['alpha', ...MODELS[c.model].factors], { cov: c.cov, hacLags: c.hac_lags });
  assert.equal(res.n, c.n, `${label} n`);
  c.beta.forEach((v, i) => close(res.beta[i], v, 1e-9, 1e-13, `${label} beta[${i}]`));
  c.se.forEach((v, i) => close(res.se[i], v, 1e-8, 1e-14, `${label} se[${i}]`));
  c.stat.forEach((v, i) => close(res.stat[i], v, 1e-8, 1e-10, `${label} t[${i}]`));
  c.pvalue.forEach((v, i) => close(res.pvalue[i], v, 1e-6, 1e-12, `${label} p[${i}]`));
  c.ci_low.forEach((v, i) => close(res.ciLow[i], v, 1e-8, 1e-13, `${label} ci_low[${i}]`));
  c.ci_high.forEach((v, i) => close(res.ciHigh[i], v, 1e-8, 1e-13, `${label} ci_high[${i}]`));
  close(res.r2, c.r2, 1e-10, 1e-12, `${label} r2`);
  close(res.r2adj, c.r2adj, 1e-10, 1e-12, `${label} r2adj`);
  if (c.diagnostics) {
    const d = c.diagnostics;
    const jb = jarqueBera(res.resid);
    close(jb.stat, d.jb[0], 1e-7, 1e-10, `${label} JB`);
    close(jb.pvalue, d.jb[1], 1e-6, 1e-12, `${label} JB p`);
    const bp = breuschPagan(res.resid, x);
    close(bp.stat, d.bp[0], 1e-7, 1e-10, `${label} BP`);
    const lb = ljungBox(res.resid, d.lb_lags);
    close(lb.stat, d.lb[0], 1e-7, 1e-10, `${label} LB`);
    close(lb.pvalue, d.lb[1], 1e-6, 1e-12, `${label} LB p`);
  }
}

if (!existsSync(refPath)) {
  test('statsmodels reference', { skip: !strict }, () => assert.fail('tests/reference/statsmodels_factor.json missing: run python -m pipeline.statsref'));
} else {
  const ref = JSON.parse(readFileSync(refPath, 'utf8'));

  test('reference produced by statsmodels (CI)', { skip: !strict }, () => {
    assert.equal(ref.engine, 'statsmodels');
    if (process.env.REQUIRE_PUBLISHED === '1') assert.ok(ref.published && ref.published.cases.length > 0, 'published cases missing');
  });

  test('synthetic dataset: 5 models × 3 inference methods', () => {
    const syn = ref.synthetic;
    const n = syn.y.length;
    for (const c of syn.cases as Case[]) {
      const x = Array.from({ length: n }, (_, t) => [1, ...MODELS[c.model].factors.map((f) => syn.factors[f][t])]);
      compare(c, syn.y, x, `synthetic ${c.model} ${c.cov}`);
    }
  });

  const pub = ref.published;
  const dataDir = join(root, 'public', 'data');
  test('published strategies: same sample rule and estimates as statsmodels', { skip: !pub || !existsSync(join(dataDir, 'market.json')) }, () => {
    const mk = JSON.parse(readFileSync(join(dataDir, 'market.json'), 'utf8'));
    const st = JSON.parse(readFileSync(join(dataDir, 'strategies', `${pub.config}.json`), 'utf8'));
    const data: FactorData = { months: mk.months, rf: mk.rf, factors: mk.factors };
    for (const c of pub.cases as Case[]) {
      const s = buildSample(st.months, st.freqs[pub.freq][c.strategy!].gross, data, c.model);
      compare(c, s.y, s.x, `${c.strategy} ${c.model} ${c.cov}`);
    }
  });
}
