import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { cumulativeCosts, drawdowns, maxDrawdown, netReturns, perfStats, percentileRank, quantile, relativeWealth, wealth } from '../src/engine/metrics.ts';
import { holm, mulberry32, sharpeDiffBootstrap } from '../src/engine/bootstrap.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(readFileSync(join(here, 'fixtures', 'metrics_reference.json'), 'utf8'));

function close(a: number, b: number, tol = 1e-10, msg = '') {
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
}

test('statistics match numpy/scipy', () => {
  const s = perfStats(ref.r, ref.rf, ref.b);
  for (const k of ['cagr', 'cumulative', 'vol', 'meanLog', 'maxDD', 'var95', 'var99', 'cvar95', 'cvar99', 'skew', 'exKurt', 'sharpe', 'sortino', 'downsideDev', 'trackingError', 'infoRatio', 'beta', 'seMean', 'posFreq']) {
    close((s as unknown as Record<string, number>)[k], ref[k], 1e-10, k);
  }
  assert.equal(s.n, 60);
});

test('compounding: V_t = 100 Π(1 + r)', () => {
  const v = wealth([0.1, -0.5, 1]);
  assert.deepEqual(v.map((x) => +x.toFixed(10)), [100, 110, 55, 110]);
  close(relativeWealth([0.1], [0.1]).at(-1)!, 100);
});

test('drawdowns are within [−100 %, 0 %] for long-only wealth', () => {
  const rand = mulberry32(7);
  for (let k = 0; k < 200; k++) {
    const r = Array.from({ length: 120 }, () => -1 + 2.2 * rand() ** 2);
    const dd = drawdowns(wealth(r));
    assert.ok(dd.every((d) => d <= 0 && d >= -1), 'bounds');
  }
  close(maxDrawdown([0.1, -0.5, 0.2]), 0.5 * 1.0 - 1); // peak 110 → 55
  assert.equal(maxDrawdown([0.01, 0.02]), 0);
});

test('quantile uses linear interpolation', () => {
  close(quantile([1, 2, 3, 4], 0.5), 2.5);
  close(quantile([1, 2, 3, 4, 5], 0.05), 1.2);
});

test('costs: net return charged on the traded value only', () => {
  const g = [0.01, 0.02, -0.01];
  const to = [0, 0.5, null];
  const net = netReturns(g, to, 40);
  close(net[0], 0.01);
  close(net[1], (1 - 0.004 * 0.5) * 1.02 - 1);
  close(net[2], -0.01);
  let v = 100;
  let paid = 0;
  g.forEach((x, i) => {
    const c = 0.004 * (to[i] ?? 0) * v;
    paid += c;
    v = (v - c) * (1 + x);
  });
  close(cumulativeCosts(g, to, 40), paid);
  close(wealth(net).at(-1)!, v);
});

test('percentile rank', () => {
  close(percentileRank([1, 2, 3, 4], 3), 0.625);
  close(percentileRank([1, 2, 3, 4], 10), 1);
});

test('bootstrap is reproducible and centred', () => {
  const a = sharpeDiffBootstrap(ref.r.map((x: number, i: number) => x - ref.rf[i]), ref.b.map((x: number, i: number) => x - ref.rf[i]), { reps: 500, seed: 3 });
  const b = sharpeDiffBootstrap(ref.r.map((x: number, i: number) => x - ref.rf[i]), ref.b.map((x: number, i: number) => x - ref.rf[i]), { reps: 500, seed: 3 });
  assert.deepEqual(a, b);
  assert.ok(a.low <= a.diff && a.diff <= a.high);
  assert.ok(a.pvalue > 0 && a.pvalue <= 1);
  const same = sharpeDiffBootstrap(ref.r, ref.r, { reps: 200 });
  assert.equal(same.diff, 0);
});

test('Holm adjustment', () => {
  const adj = holm([0.01, 0.04, 0.03, 0.2]);
  assert.deepEqual(adj.map((x) => +x.toFixed(10)), [0.04, 0.09, 0.09, 0.2]);
});
