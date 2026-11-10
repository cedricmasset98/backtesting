import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPdf, pdfString, toCp1252, type Block } from '../src/ui/pdf.ts';

const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

test('cp1252 encoding and escaping', () => {
  assert.equal(toCp1252('é–€'), 'é\u0096\u0080');
  assert.equal(toCp1252('−5 % ≥ μ'), '-5 % >= µ');
  assert.equal(pdfString('a(b)\\'), '(a\\(b\\)\\\\)');
  assert.equal(pdfString('é'), '(\\351)');
});

test('valid PDF structure: header, objects at the xref offsets, trailer', () => {
  const blocks: Block[] = [
    { kind: 'title', text: 'Report' },
    { kind: 'p', text: 'A **bold** word. '.repeat(400) },
    { kind: 'bullets', items: ['one', 'two'] },
    { kind: 'table', head: ['A', 'B'], rows: [['x', '1'], ['y', '2']] },
  ];
  const pdf = latin1(buildPdf(blocks, { footer: 'footer' }));
  assert.ok(pdf.startsWith('%PDF-1.4'));
  assert.ok(pdf.trimEnd().endsWith('%%EOF'));
  const startxref = Number(pdf.match(/startxref\n(\d+)/)![1]);
  assert.ok(pdf.slice(startxref).startsWith('xref'));
  const offsets = [...pdf.slice(startxref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
  offsets.forEach((o, i) => assert.ok(pdf.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1} at ${o}`));
  const count = Number(pdf.match(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/)![1]);
  assert.ok(count >= 2, 'long text spans several pages');
  for (const m of pdf.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index! + m[0].length;
    assert.equal(pdf.slice(start + Number(m[1]), start + Number(m[1]) + 10), '\nendstream');
  }
});
