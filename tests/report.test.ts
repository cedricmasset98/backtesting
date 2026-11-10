import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toLatex, tx } from '../src/report/latex.ts';
import type { Block } from '../src/report/blocks.ts';

test('report text is escaped for LaTeX, math is kept', () => {
  assert.equal(tx('50% & more_x #1'), '50\\% \\& more\\_x \\#1');
  assert.equal(tx('5 % of $R_f$'), '5\\,\\% of $R_f$');
  assert.equal(tx('a −0.12 and (-0.30)'), 'a $-$0.12 and ($-$0.30)');
  assert.equal(tx('**Bold** ≥ 2 × σ'), '\\textbf{Bold} $\\geq$ 2 $\\times$ $\\sigma$');
  assert.equal(tx('Table [[tab:x]] and equation [[eq:y]]'), 'Table~\\ref{tab:x} and equation~\\eqref{eq:y}');
  assert.equal(tx('Ledoit–Wolf, Malkiel’s'), "Ledoit–Wolf, Malkiel's");
  assert.throws(() => tx('unbalanced $x'));
  assert.throws(() => tx('emoji 😀'));
});

test('report document compiles (when pdflatex is installed)', { skip: spawnSync('latexmk', ['-v']).status !== 0 }, () => {
  const blocks: Block[] = [
    { kind: 'title', text: 'T', subtitle: 'S' },
    { kind: 'h2', text: 'Section' },
    { kind: 'p', text: 'Text with $\\alpha$ and 10 %.' },
    { kind: 'eq', label: 'eq:a', tex: 'a = b' },
    { kind: 'table', label: 'tab:a', caption: 'C', head: ['A', 'B'], rows: [['x', '0.10$\\mathrlap{^{**}}$'], ['', '(2.00)']], sub: [false, true], starred: true, note: 'See [[eq:a]].' },
    { kind: 'figure', label: 'fig:a', caption: 'F', chart: { type: 'dots', categories: ['A', 'B'], colors: ['#2a78d6', '#eb6834'], value: [0.1, -0.2], low: [-0.1, -0.5], high: [0.3, 0.1], xFormat: 'num', xTitle: 'x', refX: 0 } },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'rep-'));
  writeFileSync(join(dir, 'r.tex'), toLatex(blocks, { title: 'T', footer: 'F' }));
  const run = spawnSync('latexmk', ['-pdf', '-interaction=nonstopmode', '-halt-on-error', 'r.tex'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout.slice(-2000));
  assert.ok(existsSync(join(dir, 'r.pdf')));
});
