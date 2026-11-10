/** Shapes of the derived files written by the private pipeline (pipeline/build.py). */

export type Freq = 'M' | 'Q' | 'A';
export type CovMethod = 'sample' | 'lw';
export type StratId = 'EW' | 'GMV' | 'ERC' | 'TP' | 'MDP' | 'IVP' | 'TP_SAMPLE';
export type SeriesId = 'CW' | StratId | 'MONKEYS';
export type MonkeyMode = 'keep' | 'redraw';

export interface ConfigMeta {
  key: string;
  window: number;
  cov: CovMethod;
  cap: string;
  first_decision: string;
  first_return: string;
  last_return: string;
  n_decisions: number;
  tp_fallbacks: number;
  tp_sample_fallbacks: number;
  exits: Record<string, number>;
  solver: Record<string, number>;
  seconds: number;
}

export interface Manifest {
  title: string;
  generated_at: string;
  market_data_commit: string | null;
  data_last_date: string;
  last_complete_month: string;
  grid: { windows: number[]; freqs: Freq[]; cov: CovMethod[]; caps: Record<string, number>; monkey_sizes: number[]; monkey_seeds: number[]; monkey_modes?: MonkeyMode[]; n_monkeys: number };
  default: { window: number; freq: Freq; cov: CovMethod; cap: string; monkeys_k: number; seed: number; monkeys_mode?: MonkeyMode; bps?: number; spread?: boolean };
  quick: boolean;
  configs: ConfigMeta[];
  survivorship: { delistings_by_year: Record<string, number>; first_covered_year: number | null; controlled_start: string | null };
  universe: {
    rules: Record<string, number>;
    candidates: number;
    included: number;
    excluded: { code: string; name: string; reason: string }[];
    no_price_data: string[];
    duplicates_same_isin: { isin: string; kept: string; dropped: string; common_days: number; identical_return_share: number; is_duplicate: boolean }[];
    duplicates_cross: { kept: string; dropped: string; common_months: number; identical_return_share: number }[];
    dropped_duplicates: string[];
    stocks_in_panel: number;
    delisted_in_panel: number;
    cleaning: { invalid_rows: number; spike_rows: number; level_break_rows: number; by_code: Record<string, Record<string, number>> };
    reversal_months_flagged: number;
    spike_months_affecting_last_return?: number;
    max_listed_at_once: number;
    months: string[];
    eligible: Record<string, number[]>;
    listed: number[];
  };
  risk_free: { segments: { start: string; end: string; method: string }[]; checks: Record<string, { n: number; corr: number; mean_diff_annual: number }> };
  factors: Record<string, { jkp_characteristic: string; label: string; first: string; last: string; n: number }>;
  benchmark: { ticker: string; name: string; first: string; last: string };
  regimes: { name: string; start: string; end: string }[];
  costs?: { spread_estimator: string; spread_groups: number; groups: { group: number; median_daily_value_chf: number | null; median_spread: number | null }[] };
  files: Record<string, number>;
  build_seconds: number;
  privacy?: { status: string; problems: string[]; files_checked: number; portfolio_months_with_fewer_than_3_holdings: number; longest_single_stock_match_months: number };
}

export interface Market {
  months: string[];
  spi: (number | null)[];
  rf: (number | null)[];
  factors: Record<'MKT' | 'SMB' | 'HML' | 'RMW' | 'CMA' | 'MOM' | 'BAB', (number | null)[]>;
}

export interface StratSeries {
  gross: (number | null)[];
  turnover: (number | null)[];
  /** spread cost of the trades, Σ|Δw_i|·s_i/2 (fraction of wealth) */
  spread?: (number | null)[];
  rebalanced: number[];
  n_pos: (number | null)[];
  eff_n: (number | null)[];
  max_w: (number | null)[];
  top10: (number | null)[];
}

export interface ExAnte {
  vol: (number | null)[];
  mu: (number | null)[];
  dr: (number | null)[];
  max_rc: (number | null)[];
  eff_rc: (number | null)[];
}

export interface StrategiesFile {
  key: string;
  window: number;
  cov: CovMethod;
  cap: string;
  cap_value: number;
  first_decision: string;
  months: string[];
  freqs: Record<Freq, Record<StratId, StratSeries>>;
  decisions: {
    months: string[];
    n_eligible: number[];
    shrinkage: (number | null)[];
    bs_phi: (number | null)[];
    rf: (number | null)[];
    tp_fallback: string[];
    tp_sample_fallback: string[];
    erc_capped?: number[];
    exante: Record<StratId, ExAnte>;
  };
}

export interface HoldingsFile {
  key: string;
  snapshots: {
    month: string;
    n_eligible: number;
    strategies: Record<StratId, { top: { code: string; name: string; w: number; rc: number }[]; n_pos: number; top10_rc: number }>;
  }[];
}

export interface FrontierFile {
  key: string;
  cap_value: number;
  snapshots: {
    month: string;
    rf: number;
    strategies: Record<StratId, [number, number]>;
    frontier: [number, number][];
    monkeys: [number, number][];
  }[];
}

export interface MonkeysFile {
  key: string;
  window: number;
  freq: Freq;
  k: number;
  seed: number;
  mode?: MonkeyMode;
  months: string[];
  scale: number;
  gross: number[][];
  turnover: number[][];
  spread?: number[][];
}
