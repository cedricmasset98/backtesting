declare module 'plotly.js-dist-min' {
  // Minimal typing: the "dist-min" bundle ships without its own types.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const Plotly: {
    react(el: HTMLElement, data: any[], layout?: any, config?: any): Promise<unknown>;
    purge(el: HTMLElement): void;
    downloadImage(el: HTMLElement, opts: { format: 'png' | 'svg'; filename: string; width?: number; height?: number; scale?: number }): Promise<string>;
    Plots: { resize(el: HTMLElement): void };
  };
  export default Plotly;
}
