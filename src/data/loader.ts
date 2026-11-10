/** Fetches the derived JSON files (relative URLs: works under any GitHub Pages sub-path). */

import type { FrontierFile, HoldingsFile, Manifest, Market, MonkeysFile, MonkeyMode, StrategiesFile, Freq, CovMethod } from './types.ts';

const cache = new Map<string, Promise<unknown>>();

function get<T>(path: string): Promise<T> {
  let p = cache.get(path);
  if (!p) {
    p = fetch(`./data/${path}`, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return p as Promise<T>;
}

export const configKey = (window: number, cov: CovMethod, cap: string) => `L${window}_${cov}_cap${cap}`;

export const loadManifest = () => get<Manifest>('manifest.json');
export const loadMarket = () => get<Market>('market.json');
export const loadStrategies = (key: string) => get<StrategiesFile>(`strategies/${key}.json`);
export const loadHoldings = (key: string) => get<HoldingsFile>(`holdings/${key}.json`);
export const loadFrontier = (key: string) => get<FrontierFile>(`frontier/${key}.json`);
export const monkeysKey = (window: number, freq: Freq, k: number, seed: number, mode: MonkeyMode) => `L${window}_${freq}_k${k}_s${seed}_${mode}`;
export const loadMonkeys = (window: number, freq: Freq, k: number, seed: number, mode: MonkeyMode) => get<MonkeysFile>(`monkeys/${monkeysKey(window, freq, k, seed, mode)}.json`);
