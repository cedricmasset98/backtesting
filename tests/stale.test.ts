import { test } from 'node:test';
import assert from 'node:assert/strict';

import { autocorrelation, dimsonFit, loSharpe } from '../src/engine/stale.ts';
import { mulberry32 } from '../src/engine/bootstrap.ts';
import { mean, sd } from '../src/engine/metrics.ts';

function normal(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

test('Lo Sharpe ratio: √12 scaling without autocorrelation, lower with positive autocorrelation', () => {
  const rand = mulberry32(3);
  const iid = Array.from({ length: 2000 }, () => 0.005 + 0.03 * normal(rand));
  const lo = loSharpe(iid);
  assert.ok(Math.abs(lo.rho) < 0.06);
  assert.ok(Math.abs(lo.eta - Math.sqrt(12)) < 0.3);
  // AR(1) with ρ = 0.3: η(12) from the closed form
  const ar: number[] = [];
  let e = 0;
  for (let t = 0; t < 4000; t++) {
    e = 0.3 * e + 0.03 * normal(rand);
    ar.push(0.005 + e);
  }
  const l2 = loSharpe(ar);
  assert.ok(Math.abs(l2.rho - 0.3) < 0.05);
  let s = 12;
  for (let k = 1; k < 12; k++) s += 2 * (12 - k) * l2.rho ** k;
  assert.ok(Math.abs(l2.eta - 12 / Math.sqrt(s)) < 1e-12);
  assert.ok(l2.sharpe < (Math.sqrt(12) * mean(ar)) / sd(ar));
  assert.ok(Math.abs(autocorrelation([1, 2, 3, 4, 5, 6, 7, 8], 1) - 0.625) < 1e-12);
});

test('Dimson regression recovers a lagged market exposure', () => {
  const rand = mulberry32(9);
  const n = 600;
  const mkt = Array.from({ length: n }, () => 0.006 + 0.045 * normal(rand));
  const y = mkt.map((m, t) => 0.002 + 0.2 * m + (t ? 0.15 * mkt[t - 1] : 0) + 0.01 * normal(rand));
  const f = dimsonFit(y, mkt, 1, 'HAC');
  assert.equal(f.n, n - 1);
  assert.ok(Math.abs(f.betaSum - 0.35) < 0.03);
  assert.ok(Math.abs(f.capm.beta[1] - 0.2) < 0.03);
  assert.ok(f.dimson.beta[0] < f.capm.beta[0]); // the lagged exposure was counted as alpha by the CAPM
});
