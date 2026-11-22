/**
 * Mathematical notation: \( … \) inline and \[ … \] displayed, typeset with KaTeX
 * (loaded from a CDN in index.html). Without KaTeX the LaTeX source stays readable.
 */

declare global {
  interface Window {
    renderMathInElement?: (el: HTMLElement, opts: Record<string, unknown>) => void;
  }
}

const OPTIONS = {
  delimiters: [
    { left: '\\[', right: '\\]', display: true },
    { left: '\\(', right: '\\)', display: false },
  ],
  throwOnError: false,
  ignoredClasses: ['js-plotly-plot'],
};

export function typeset(el: HTMLElement): void {
  window.renderMathInElement?.(el, OPTIONS);
}

/** Typesets everything written into `el`, now and after every re-render. */
export function watchMath(el: HTMLElement): void {
  let pending = false;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(run, 0); // not requestAnimationFrame: it does not fire in background tabs
  });
  function run(): void {
    pending = false;
    observer.disconnect();
    typeset(el);
    observer.observe(el, { childList: true, subtree: true });
  }
  observer.observe(el, { childList: true, subtree: true });
  if (!window.renderMathInElement) window.addEventListener('load', () => run(), { once: true });
}
