import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attribution, buildSample, fitModel, laggedMarketSensitivity, MODEL_IDS, type FactorData } from '../src/engine/factors.ts';
import { mulberry32 } from '../src/engine/bootstrap.ts';

function dataset(n: number): { data: FactorData; months: string[]; r: (number | null)[] } {
  const rand = mulberry32(11);
  const g = () => (rand() - 0.5) * 0.08;
  const months = Array.from({ length: n }, (_, i) => `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
  const f = { MKT: [] as (number | null)[], SMB: [] as (number | null)[], HML: [] as (number | null)[], RMW: [] as (number | null)[], CMA: [] as (number | null)[], MOM: [] as (number | null)[], BAB: [] as (number | null)[] };
  const rf: (number | null)[] = [];
  const r: (number | null)[] = [];
  for (let t = 0; t < n; t++) {
    for (const k of Object.keys(f) as (keyof typeof f)[]) f[k].push(g());
    rf.push(0.001);
    r.push(0.001 + 0.002 + 0.9 * (f.MKT[t] as number) + 0.3 * (f.SMB[t] as number) + g() * 0.2);
  }
  return { data: { months, rf, factors: f }, months, r };
}

test('sample rule drops months with a missing factor, r_f or return, never fills', () => {
  const { data, months, r } = dataset(60);
  data.factors.MOM[5] = null;
  data.rf[7] = null;
  r[9] = null;
  assert.equal(buildSample(months, r, data, 'FF5').y.length, 58); // MOM not in FF5
  assert.equal(buildSample(months, r, data, 'FF5MOM').y.length, 57);
  const s = buildSample(months, r, data, 'CAPM');
  assert.equal(s.x[0][0], 1);
  assert.equal(s.y[0], (r[0] as number) - 0.001);
});

test('every model estimates, with one coefficient and t-statistic per factor', () => {
  const { data, months, r } = dataset(120);
  for (const m of MODEL_IDS) {
    const fit = fitModel(months, r, data, m, 'HAC');
    assert.ok(fit.ok);
    if (fit.ok) {
      assert.equal(fit.result.beta.length, fit.sample.names.length);
      assert.ok(fit.result.stat.every(Number.isFinite));
    }
  }
});

test('unavailable factors give an explicit reason, not a coefficient', () => {
  const { data, months, r } = dataset(60);
  data.factors.RMW = data.factors.RMW.map(() => null);
  const fit = fitModel(months, r, data, 'FF5', 'classical');
  assert.equal(fit.ok, false);
  if (!fit.ok) assert.match(fit.reason, /FF5/);
});

test('attribution adds up to the mean excess return', () => {
  const { data, months, r } = dataset(120);
  const fit = fitModel(months, r, data, 'FF5MOM', 'classical');
  assert.ok(fit.ok);
  if (fit.ok) {
    const total = attribution(fit).reduce((s, a) => s + a.value, 0);
    const meanEx = fit.sample.y.reduce((s, v) => s + v, 0) / fit.sample.y.length;
    assert.ok(Math.abs(total - meanEx) < 1e-14);
  }
});

test('lagged-market multifactor control uses the same sample and detects delayed beta', () => {
  const { data, months, r } = dataset(180);
  const mkt = data.factors.MKT as number[];
  for (let t = 0; t < r.length; t++) {
    r[t] = 0.001 + 0.002 + 0.4 * mkt[t] + (t ? 0.35 * mkt[t - 1] : 0) + 0.002 * Math.sin(t * 1.79);
  }
  const out = laggedMarketSensitivity(months, r, data, 'FF5MOM', 'HAC');
  assert.ok(out.base.ok && out.lagged.ok);
  if (out.base.ok && out.lagged.ok) {
    assert.deepEqual(out.base.sample.months, out.lagged.sample.months);
    assert.equal(out.base.result.n, out.lagged.result.n);
    assert.equal(out.lagged.result.names.at(-1), 'MKT_L1');
    const lag = out.lagged.result.beta.at(-1)!;
    assert.ok(Math.abs(lag - 0.35) < 0.06, `lagged beta ${lag} should be near 0.35`);
  }
});

test('lagged-market control uses the preceding calendar month, never the prior available row', () => {
  const { data, months, r } = dataset(60);
  // The market factor for May 2001 is missing: June 2001 cannot use April
  // as a substitute for the calendar lag.
  const ix = months.indexOf('2001-05');
  data.factors.MKT[ix] = null;
  const out = laggedMarketSensitivity(months, r, data, 'FF5MOM', 'HAC');
  assert.ok(out.base.ok && out.lagged.ok);
  if (out.base.ok && out.lagged.ok) {
    assert.ok(!out.lagged.sample.months.includes('2001-05'));
    assert.ok(!out.lagged.sample.months.includes('2001-06'));
    assert.deepEqual(out.base.sample.months, out.lagged.sample.months);
  }
});
