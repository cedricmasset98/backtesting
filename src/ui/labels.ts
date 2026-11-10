/** Series names (no DOM or Plotly dependency: also used by the report build in Node). */

import type { SeriesId } from '../data/types.ts';

export const LABEL: Record<SeriesId, string> = {
  CW: 'Market-Cap Weighted (SPI TR)',
  EW: 'Equally-Weighted',
  GMV: 'Global Minimum Variance',
  ERC: 'Equal Risk Contribution',
  TP: 'Tangency Portfolio',
  MDP: 'Most Diversified Portfolio',
  IVP: 'Inverse Volatility',
  MONKEYS: "Malkiel's Monkeys (average)",
  TP_SAMPLE: 'Tangency (sample mean, sensitivity)',
};

export const SHORT: Record<SeriesId, string> = {
  CW: 'CW (SPI)',
  EW: 'EW',
  GMV: 'GMV',
  ERC: 'ERC',
  TP: 'TP',
  MDP: 'MDP',
  IVP: 'IVP',
  MONKEYS: 'Monkeys',
  TP_SAMPLE: 'TP (sample μ)',
};
