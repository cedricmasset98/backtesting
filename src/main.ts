/** Swiss Equity Portfolio Lab — application shell: settings bar, tabs, URL state. */

import './styles.css';
import { configKey, loadFrontier, loadHoldings, loadManifest, loadMarket, loadMonkeys, loadStrategies } from './data/loader.ts';
import type { Manifest, Market, SeriesId } from './data/types.ts';
import { buildView } from './model.ts';
import { ALL_SERIES, defaults, fromUrl, TABS, toUrl, type State, type TabId } from './state.ts';
import { LABEL, readTheme, SHORT } from './ui/charts.ts';
import type { Ctx } from './ui/context.ts';
import { escapeHtml } from './ui/format.ts';
import { renderOverview } from './tabs/overview.ts';
import { renderPerformance } from './tabs/performance.ts';
import { renderRisk } from './tabs/risk.ts';
import { renderFactors } from './tabs/factors.ts';
import { renderFrontier } from './tabs/frontier.ts';
import { renderMonkeys } from './tabs/monkeys.ts';
import { renderComposition } from './tabs/composition.ts';
import { renderRobustness } from './tabs/robustness.ts';
import { renderData } from './tabs/data.ts';

const TAB_LABEL: Record<TabId, string> = {
  overview: 'Overview',
  performance: 'Cumulative Performance',
  risk: 'Risk & Return',
  factors: 'Factor Analysis',
  frontier: 'Efficient Frontier',
  monkeys: "Malkiel's Monkeys",
  composition: 'Portfolio Composition',
  robustness: 'Robustness',
  data: 'Data & Methodology',
};

let manifest: Manifest;
let market: Market;
let state: State;
let base: State;
let renderToken = 0;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function setState(patch: Partial<State>): void {
  state = { ...state, ...patch };
  history.replaceState(null, '', toUrl(state, base));
  syncControls();
  void render();
}

function option(v: string, label: string, sel: boolean): string {
  return `<option value="${v}"${sel ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

function buildControls(): void {
  const g = manifest.grid;
  $('controls').innerHTML = `
    <fieldset><legend>Period</legend>
      <label>Start <input type="month" id="c-start" /></label>
      <label>End <input type="month" id="c-end" /></label>
      <span class="muted small" id="c-avail"></span>
    </fieldset>
    <fieldset><legend>Construction</legend>
      <label>Window <select id="c-window">${g.windows.map((w) => option(String(w), `${w} months`, false)).join('')}</select></label>
      <label>Rebalancing <select id="c-freq">${g.freqs.map((f) => option(f, { M: 'Monthly', Q: 'Quarterly', A: 'Annual' }[f], false)).join('')}</select></label>
      <label>Covariance <select id="c-cov">${g.cov.map((c) => option(c, c === 'lw' ? 'Ledoit-Wolf shrinkage' : 'Sample (standard)', false)).join('')}</select></label>
      <label>Max weight <select id="c-cap">${Object.keys(g.caps).map((k) => option(k, `${k} %`, false)).join('')}</select></label>
    </fieldset>
    <fieldset><legend>Costs</legend>
      <label class="range">Transaction costs <input type="range" id="c-bps" min="0" max="200" step="5" /><input type="number" id="c-bps-n" min="0" max="500" step="1" class="num" /> bp</label>
      <label>Returns <select id="c-basis">${option('net', 'Net of costs', false)}${option('gross', 'Gross', false)}</select></label>
    </fieldset>
    <fieldset><legend>Monkeys</legend>
      <label>Stocks (K) <select id="c-k">${g.monkey_sizes.map((k) => option(String(k), String(k), false)).join('')}</select></label>
      <label>Seed <select id="c-seed">${g.monkey_seeds.map((k) => option(String(k), String(k), false)).join('')}</select></label>
    </fieldset>
    <fieldset class="series"><legend>Portfolios shown</legend>
      ${ALL_SERIES.map((id) => `<label class="chip" title="${escapeHtml(LABEL[id])}"><input type="checkbox" value="${id}" /><span class="dot" style="background:var(--c-${id})"></span>${SHORT[id]}</label>`).join('')}
    </fieldset>
    <div class="actions"><button type="button" id="c-link">Copy link</button><button type="button" id="c-reset">Reset</button></div>`;
  const on = (id: string, ev: string, f: (el: HTMLInputElement & HTMLSelectElement) => void) => $(id).addEventListener(ev, (e) => f(e.target as HTMLInputElement & HTMLSelectElement));
  on('c-start', 'change', (el) => el.value && setState({ start: el.value }));
  on('c-end', 'change', (el) => el.value && setState({ end: el.value }));
  on('c-window', 'change', (el) => setState({ window: Number(el.value) }));
  on('c-freq', 'change', (el) => setState({ freq: el.value as State['freq'] }));
  on('c-cov', 'change', (el) => setState({ cov: el.value as State['cov'] }));
  on('c-cap', 'change', (el) => setState({ cap: el.value }));
  on('c-bps', 'change', (el) => setState({ bps: Number(el.value) }));
  on('c-bps', 'input', (el) => ($('c-bps-n') as HTMLInputElement).value = el.value);
  on('c-bps-n', 'change', (el) => setState({ bps: Math.max(0, Math.min(500, Number(el.value) || 0)) }));
  on('c-basis', 'change', (el) => setState({ basis: el.value as State['basis'] }));
  on('c-k', 'change', (el) => setState({ k: Number(el.value) }));
  on('c-seed', 'change', (el) => setState({ seed: Number(el.value) }));
  $('controls').querySelectorAll<HTMLInputElement>('.series input').forEach((cb) =>
    cb.addEventListener('change', () => {
      const vis = [...$('controls').querySelectorAll<HTMLInputElement>('.series input')].filter((x) => x.checked).map((x) => x.value as SeriesId);
      setState({ visible: vis });
    }),
  );
  $('c-link').onclick = () => {
    void navigator.clipboard?.writeText(location.href).then(() => {
      $('c-link').textContent = 'Link copied';
      setTimeout(() => ($('c-link').textContent = 'Copy link'), 1500);
    });
  };
  $('c-reset').onclick = () => setState({ ...base, tab: state.tab });
}

function syncControls(): void {
  ($('c-start') as HTMLInputElement).value = state.start;
  ($('c-end') as HTMLInputElement).value = state.end;
  ($('c-window') as HTMLSelectElement).value = String(state.window);
  ($('c-freq') as HTMLSelectElement).value = state.freq;
  ($('c-cov') as HTMLSelectElement).value = state.cov;
  ($('c-cap') as HTMLSelectElement).value = state.cap;
  ($('c-bps') as HTMLInputElement).value = String(Math.min(200, state.bps));
  ($('c-bps-n') as HTMLInputElement).value = String(state.bps);
  ($('c-basis') as HTMLSelectElement).value = state.basis;
  ($('c-k') as HTMLSelectElement).value = String(state.k);
  ($('c-seed') as HTMLSelectElement).value = String(state.seed);
  $('controls').querySelectorAll<HTMLInputElement>('.series input').forEach((cb) => (cb.checked = state.visible.includes(cb.value as SeriesId)));
  document.querySelectorAll<HTMLButtonElement>('nav.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
}

function buildTabs(): void {
  $('tabs').innerHTML = TABS.map((t) => `<button type="button" role="tab" data-tab="${t}">${TAB_LABEL[t]}</button>`).join('');
  $('tabs').querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => setState({ tab: b.dataset.tab as TabId })));
}

async function render(): Promise<void> {
  const token = ++renderToken;
  const root = $('view');
  const key = configKey(state.window, state.cov, state.cap);
  root.setAttribute('aria-busy', 'true');
  try {
    const [strat, monkeys] = await Promise.all([loadStrategies(key), loadMonkeys(state.window, state.freq, state.k, state.seed).catch(() => null)]);
    if (token !== renderToken) return;
    const view = buildView(strat, market, monkeys, state);
    if (view.months.length < 12) {
      root.innerHTML = `<section class="card"><p class="warn">The selected period contains ${view.months.length} month(s) for this configuration (available: ${view.available[0]} – ${view.available[1]}). Choose a period of at least 12 months.</p></section>`;
      return;
    }
    $('c-avail').textContent = `available ${view.available[0]} – ${view.available[1]}`;
    const visible = ALL_SERIES.filter((id) => state.visible.includes(id) && view.series.has(id));
    const ctx: Ctx = { s: state, m: manifest, market, strat, monkeys, view, theme: readTheme(), root, visible: visible.length ? visible : ['CW'], set: setState };
    const banner = $('banner');
    const controlled = manifest.survivorship.controlled_start;
    banner.hidden = !(controlled && view.period[0] < controlled);
    banner.innerHTML = banner.hidden ? '' : `Survivorship warning: the period starts before ${controlled}; delisted stocks are missing from the data before that date, which biases stock-based strategies upwards.`;
    switch (state.tab) {
      case 'overview':
        renderOverview(ctx);
        break;
      case 'performance':
        renderPerformance(ctx);
        break;
      case 'risk':
        renderRisk(ctx);
        break;
      case 'factors':
        renderFactors(ctx);
        break;
      case 'frontier': {
        const fr = await loadFrontier(key);
        if (token === renderToken) renderFrontier(ctx, fr);
        break;
      }
      case 'monkeys':
        renderMonkeys(ctx);
        break;
      case 'composition': {
        const h = await loadHoldings(key);
        if (token === renderToken) renderComposition(ctx, h);
        break;
      }
      case 'robustness':
        await renderRobustness(ctx, loadStrategies);
        break;
      case 'data':
        renderData(ctx);
        break;
    }
  } catch (e) {
    if (token === renderToken) root.innerHTML = `<section class="card"><p class="warn">This configuration could not be loaded: ${escapeHtml((e as Error).message)}. It may not have been computed by the pipeline.</p></section>`;
    console.error(e);
  } finally {
    if (token === renderToken) root.removeAttribute('aria-busy');
  }
}

function setupTheme(): void {
  const btn = $('theme');
  const apply = () => {
    btn.textContent = document.documentElement.dataset.theme === 'dark' ? '☀' : '☾';
  };
  apply();
  btn.onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('sepl-theme', next);
    } catch {
      /* storage unavailable */
    }
    apply();
    void render();
  };
}

async function init(): Promise<void> {
  setupTheme();
  try {
    [manifest, market] = await Promise.all([loadManifest(), loadMarket()]);
  } catch (e) {
    $('view').innerHTML = `<section class="card"><p class="warn">The results have not been built yet (${escapeHtml((e as Error).message)}). Run the private pipeline: <code>python -m pipeline.build</code>.</p></section>`;
    return;
  }
  base = defaults(manifest);
  state = fromUrl(manifest, location.search);
  $('databar').textContent = `Data up to ${manifest.data_last_date} · results built ${manifest.generated_at.slice(0, 10)} · ${manifest.universe.stocks_in_panel} Swiss stocks (${manifest.universe.delisted_in_panel} delisted) · benchmark SPI total return`;
  buildTabs();
  buildControls();
  syncControls();
  await render();
}

void init();
