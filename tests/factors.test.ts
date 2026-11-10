import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attribution, buildSample, fitModel, MODEL_IDS, type FactorData } from '../src/engine/factors.ts';
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
