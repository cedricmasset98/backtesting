/** Application state and its URL representation (shareable links). */

import type { CovType } from './engine/ols.ts';
import type { ModelId } from './engine/factors.ts';
import type { CovMethod, Freq, Manifest, MonkeyMode, SeriesId } from './data/types.ts';
import { MODEL_IDS } from './engine/factors.ts';

export const TABS = ['overview', 'performance', 'risk', 'factors', 'frontier', 'monkeys', 'composition', 'robustness', 'data'] as const;
export type TabId = (typeof TABS)[number];

export const MAIN_SERIES: SeriesId[] = ['CW', 'EW', 'GMV', 'ERC', 'TP', 'MDP', 'IVP', 'MONKEYS'];
export const ALL_SERIES: SeriesId[] = [...MAIN_SERIES, 'TP_SAMPLE'];

export interface State {
  tab: TabId;
  window: number;
  freq: Freq;
  cov: CovMethod;
  cap: string;
  bps: number;
  /** add the estimated bid-ask spread cost to the fixed cost */
  spread: boolean;
  basis: 'net' | 'gross';
  start: string;
  end: string;
  visible: SeriesId[];
  k: number;
  seed: number;
  mkMode: MonkeyMode;
  log: boolean;
  compareGross: boolean;
  inference: CovType;
  pf: SeriesId;
  model: ModelId;
  roll: number;
  snap: string;
  robust: SeriesId;
}

export function defaults(m: Manifest): State {
  const d = m.default;
  return {
    tab: 'overview',
    window: d.window,
    freq: d.freq,
    cov: d.cov,
    cap: d.cap,
    bps: d.bps ?? 10,
    spread: d.spread ?? true,
    basis: 'net',
    start: m.survivorship.controlled_start ?? m.configs[0]?.first_return ?? '2000-01',
    end: m.last_complete_month,
    visible: [...MAIN_SERIES],
    k: d.monkeys_k,
    seed: d.seed,
    mkMode: d.monkeys_mode ?? 'keep',
    log: false,
    compareGross: false,
    inference: 'HAC',
    pf: 'EW',
    model: 'FF5MOM',
    roll: 60,
    snap: '',
    robust: 'GMV',
  };
}

const MONTH = /^\d{4}-\d{2}$/;

/** Reads the URL; unknown or out-of-grid values fall back to the defaults. */
export function fromUrl(m: Manifest, search: string): State {
  const s = defaults(m);
  const p = new URLSearchParams(search);
  const g = m.grid;
  const tab = p.get('tab');
  if (tab && (TABS as readonly string[]).includes(tab)) s.tab = tab as TabId;
  const w = Number(p.get('w'));
  if (g.windows.includes(w)) s.window = w;
  const f = p.get('f') as Freq;
  if (g.freqs.includes(f)) s.freq = f;
  const cov = p.get('cov') as CovMethod;
  if (g.cov.includes(cov)) s.cov = cov;
  const cap = p.get('cap');
  if (cap && cap in g.caps) s.cap = cap;
  const tc = Number(p.get('tc'));
  if (p.has('tc') && Number.isFinite(tc) && tc >= 0 && tc <= 500) s.bps = tc;
  if (p.get('basis') === 'gross') s.basis = 'gross';
  if (p.has('sp')) s.spread = p.get('sp') === '1';
  const from = p.get('from');
  if (from && MONTH.test(from)) s.start = from;
  const to = p.get('to');
  if (to && MONTH.test(to)) s.end = to;
  const vis = p.get('s');
  if (vis !== null) s.visible = vis.split(',').filter((v): v is SeriesId => (ALL_SERIES as string[]).includes(v));
  const k = Number(p.get('k'));
  if (g.monkey_sizes.includes(k)) s.k = k;
  const seed = Number(p.get('seed'));
  if (g.monkey_seeds.includes(seed)) s.seed = seed;
  const mk = p.get('mk');
  if (mk === 'keep' || mk === 'redraw') s.mkMode = mk;
  s.log = p.get('log') === '1';
  s.compareGross = p.get('cmp') === '1';
  const inf = p.get('inf');
  if (inf === 'classical' || inf === 'HC3' || inf === 'HAC') s.inference = inf;
  const pf = p.get('pf');
  if (pf && (ALL_SERIES as string[]).includes(pf)) s.pf = pf as SeriesId;
  const model = p.get('model');
  if (model && (MODEL_IDS as string[]).includes(model)) s.model = model as ModelId;
  const roll = Number(p.get('roll'));
  if ([36, 60, 120].includes(roll)) s.roll = roll;
  const snap = p.get('snap');
  if (snap && MONTH.test(snap)) s.snap = snap;
  const rs = p.get('rs');
  if (rs && (ALL_SERIES as string[]).includes(rs)) s.robust = rs as SeriesId;
  return s;
}

export function toUrl(s: State, d: State): string {
  const p = new URLSearchParams();
  const set = (k: string, v: string, def: string) => {
    if (v !== def) p.set(k, v);
  };
  set('tab', s.tab, d.tab);
  set('w', String(s.window), String(d.window));
  set('f', s.freq, d.freq);
  set('cov', s.cov, d.cov);
  set('cap', s.cap, d.cap);
  set('tc', String(s.bps), String(d.bps));
  set('basis', s.basis, d.basis);
  set('sp', s.spread ? '1' : '0', d.spread ? '1' : '0');
  set('from', s.start, d.start);
  set('to', s.end, d.end);
  set('s', s.visible.join(','), d.visible.join(','));
  set('k', String(s.k), String(d.k));
  set('seed', String(s.seed), String(d.seed));
  set('mk', s.mkMode, d.mkMode);
  set('log', s.log ? '1' : '0', '0');
  set('cmp', s.compareGross ? '1' : '0', '0');
  set('inf', s.inference, d.inference);
  set('pf', s.pf, d.pf);
  set('model', s.model, d.model);
  set('roll', String(s.roll), String(d.roll));
  set('snap', s.snap, d.snap);
  set('rs', s.robust, d.robust);
  const q = p.toString();
  return q ? `?${q}` : location.pathname;
}
