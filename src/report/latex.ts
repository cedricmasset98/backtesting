/**
 * LaTeX rendering of the results report (pdflatex, standard TeX Live packages).
 *
 * Tables are set at the full text width (columns spread with \extracolsep) and
 * scaled down only when their natural width exceeds it; charts are pgfplots
 * figures drawn from the data, so the PDF is entirely vector.
 */

import type { Block, ChartSpec } from './blocks.ts';

const L = String.raw;

/** Unicode characters of the report text and their LaTeX equivalent (text mode). */
const UNI: Record<string, string> = {
  '−': '$-$', '≥': L`$\geq$`, '≤': L`$\leq$`, '×': L`$\times$`, '→': L`$\to$`, 'Δ': L`$\Delta$`, 'μ': L`$\mu$`, 'σ': L`$\sigma$`,
  'Σ': L`$\Sigma$`, 'φ': L`$\varphi$`, 'λ': L`$\lambda$`, '≈': L`$\approx$`, '²': L`\textsuperscript{2}`, '·': L`\textperiodcentered{}`,
  '\u00a0': '~', '…': L`\dots{}`, '’': "'", '‘': '`',
};
const ALLOWED = /^[\x09\x0a\x0d\x20-\x7e\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u00ff–—“”«»]*$/u;

/** Report text to LaTeX: `$…$` is math (kept), `**…**` bold, `[[label]]` a reference; the rest is escaped. */
export function tx(s: string): string {
  const parts = s.split('$');
  if (parts.length % 2 === 0) throw new Error(`Unbalanced $ in report text: ${s}`);
  return parts.map((p, i) => (i % 2 ? `$${p}$` : text(p))).join('');
}

function text(p: string): string {
  let t = p.replace(/[\\{}#%&_^~]/g, (ch) => ({ '\\': L`\textbackslash{}`, '{': L`\{`, '}': L`\}`, '#': L`\#`, '%': L`\%`, '&': L`\&`, '_': L`\_`, '^': L`\^{}`, '~': L`\textasciitilde{}` })[ch]!);
  t = t.replace(/(^|[\s(\[\/;])-(?=\d)/g, '$1$-$');
  t = t.replace(/(\d) (?=\\%)/g, '$1\\,');
  t = t.replace(/[^\x00-\x7f]/gu, (ch) => UNI[ch] ?? ch);
  if (!ALLOWED.test(t)) throw new Error(`Unsupported character in report text: ${[...t].filter((ch) => !ALLOWED.test(ch)).join(' ')}`);
  const b = t.split('**');
  if (b.length % 2 === 0) throw new Error(`Unbalanced ** in report text: ${p}`);
  t = b.map((x, i) => (i % 2 ? L`\textbf{${x}}` : x)).join('');
  return t.replace(/ ?\[\[(eq:[\w-]+)\]\]/g, L`~\eqref{$1}`).replace(/ ?\[\[((?:tab|fig):[\w-]+)\]\]/g, L`~\ref{$1}`);
}

const colors = new Map<string, string>();
function color(hex: string): string {
  const h = hex.replace('#', '').toUpperCase();
  const name = `c${h}`;
  colors.set(name, h);
  return name;
}

const f = (x: number, d = 4) => (Number.isFinite(x) ? Number(x.toFixed(d)).toString() : 'nan');
const AXIS = L`tick label style={font=\scriptsize}, label style={font=\small}, axis line style={gray!60}, tick style={gray!60}, major grid style={gray!18}, legend cell align=left`;
const LEGEND = (n: number, y = -0.16) => L`legend columns=${n}, legend style={draw=none, font=\scriptsize, at={(0.5,${y})}, anchor=north, /tikz/every even column/.append style={column sep=7pt}}`;

function yearFrac(d: string): number {
  const [y, m, day] = d.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return y + (m - 1 + day / days) / 12;
}

function yearTicks(x0: number, x1: number): string {
  const span = x1 - x0;
  const step = span > 24 ? 4 : span > 12 ? 2 : 1;
  const t: number[] = [];
  for (let y = Math.ceil(x0); y <= Math.floor(x1); y++) if (y % step === 0 || step === 1) t.push(y);
  return t.join(',');
}

function chart(ch: ChartSpec): string {
  if (ch.type === 'line') {
    const x = ch.x.map(yearFrac);
    const k = ch.yFormat === 'pct' ? 100 : 1;
    const h = 6.4 * (ch.height ?? 1);
    const plots = ch.series
      .map((s) => `\\addplot[color=${color(s.color)}, line width=${f(0.75 * (s.width ?? 1), 2)}pt${s.dash ? ', dashed' : ''}, line join=round] coordinates {${s.y.map((v, i) => `(${f(x[i])},${f(k * v, 3)})`).join(' ')}};\n\\addlegendentry{${tx(s.name)}}`)
      .join('\n');
    const ref = ch.refY !== undefined ? `\\addplot[gray, densely dotted, forget plot] coordinates {(${f(x[0])},${ch.refY}) (${f(x.at(-1)!)},${ch.refY})};\n` : '';
    return L`\begin{tikzpicture}
\begin{axis}[width=0.98\linewidth, height=${f(h, 2)}cm, xmin=${f(x[0])}, xmax=${f(x.at(-1)!)}, xtick={${yearTicks(x[0], x.at(-1)!)}}, x tick label style={/pgf/number format/1000 sep={}}, ylabel={${tx(ch.yTitle)}}, ymajorgrids, xmajorgrids, ${ch.yFormat === 'pct' ? L`yticklabel={\pgfmathprintnumber{\tick}\,\%}, ` : ''}${AXIS}, ${LEGEND(ch.series.length, ch.height !== undefined && ch.height < 1 ? -0.24 : -0.15)}]
${ref}${plots}
\end{axis}
\end{tikzpicture}`;
  }
  if (ch.type === 'dots') {
    const n = ch.categories.length;
    const k = ch.xFormat === 'pct' ? 100 : 1;
    const plots = ch.categories
      .map((_, i) => {
        const c = color(ch.colors[i]);
        const v = k * ch.value[i];
        return `\\addplot[color=${c}, only marks, mark=*, mark size=2.4pt, error bars/.cd, x dir=both, x explicit, error bar style={line width=1pt, color=${c}}, error mark options={mark size=3pt, line width=1pt, color=${c}}] coordinates {(${f(v)},${i + 1}) += (${f(k * ch.high[i] - v)},0) -= (${f(v - k * ch.low[i])},0)};`;
      })
      .join('\n');
    const ref = ch.refX !== undefined ? `\\addplot[gray, densely dashed, forget plot] coordinates {(${ch.refX},0.4) (${ch.refX},${n + 0.6})};\n` : '';
    return L`\begin{tikzpicture}
\begin{axis}[width=0.98\linewidth, height=${f(0.62 * n + 1.9, 2)}cm, y dir=reverse, ymin=0.4, ymax=${n + 0.6}, ytick={${ch.categories.map((_, i) => i + 1).join(',')}}, yticklabels={${ch.categories.map((c) => `{${tx(c)}}`).join(',')}}, xlabel={${tx(ch.xTitle)}}, xmajorgrids, ${ch.xFormat === 'pct' ? L`xticklabel={\pgfmathprintnumber{\tick}\,\%}, ` : ''}${AXIS}]
${ref}${plots}
\end{axis}
\end{tikzpicture}`;
  }
  // histogram with vertical markers
  const lo = Math.min(...ch.values);
  const hi = Math.max(...ch.values);
  const w = (hi - lo) / ch.bins || 1;
  const counts = new Array(ch.bins).fill(0);
  for (const v of ch.values) counts[Math.min(ch.bins - 1, Math.floor((v - lo) / w))]++;
  const top = Math.max(...counts) * 1.1;
  const xs = [lo, hi, ...ch.markers.map((m) => m.x)];
  const pad = 0.04 * (Math.max(...xs) - Math.min(...xs));
  const bars = counts.map((c, i) => `(${f(lo + i * w)},${c})`).join(' ') + ` (${f(hi)},${counts.at(-1)})`;
  const hc = color(ch.color);
  const marks = ch.markers.map((m) => `\\addplot[color=${color(m.color)}, line width=1.3pt] coordinates {(${f(m.x)},0) (${f(m.x)},${f(top, 2)})};\n\\addlegendentry{${tx(m.name)}}`).join('\n');
  return L`\begin{tikzpicture}
\begin{axis}[width=0.98\linewidth, height=6cm, ymin=0, ymax=${f(top, 2)}, xmin=${f(Math.min(...xs) - pad)}, xmax=${f(Math.max(...xs) + pad)}, xlabel={${tx(ch.xTitle)}}, ylabel={Number of portfolios}, ymajorgrids, ${AXIS}, ${LEGEND(ch.markers.length + 1, -0.22)}]
\addplot[ybar interval, fill=${hc}!28, draw=${hc}!55, area legend] coordinates {${bars}};
\addlegendentry{${tx(ch.label)}}
${marks}
\end{axis}
\end{tikzpicture}`;
}

function table(b: Extract<Block, { kind: 'table' }>): string {
  const n = b.head.length;
  const num = b.starred ? 'c' : 'r'; // coefficients centred over their t-statistics
  const spec = `l${num.repeat(n - 1)}`;
  const head = b.head.map(tx).join(' & ');
  const rows = b.rows
    .map((r, i) => {
      const cells = r.map((c) => (b.sub?.[i] && c ? L`{\footnotesize ${tx(c)}}` : tx(c))).join(' & ');
      return `${cells} \\\\${b.sub?.[i] && i < b.rows.length - 1 ? ' \\addlinespace[3pt]' : ''}`;
    })
    .join('\n');
  const body = `\\toprule\n${head} \\\\\n\\midrule\n${rows}\n\\bottomrule`;
  return L`\begin{reptable}{${tx(b.caption)}}{${b.label}}
\fittable{${spec}}{${body}}
${b.note ? L`\tablenote{${tx(b.note)}}` : ''}\end{reptable}`;
}

function block(b: Block): string {
  switch (b.kind) {
    case 'title':
      return L`\begin{center}
{\LARGE\bfseries ${tx(b.text)}\par}\vspace{4pt}
{\large ${tx(b.subtitle)}\par}
\end{center}`;
    case 'meta':
      return L`\begin{center}\small ${tx(b.text)}\end{center}`;
    case 'note':
      return L`{\footnotesize\itshape ${tx(b.text)}\par}\bigskip`;
    case 'warn':
      return L`\noindent\fcolorbox{orange!70!black}{orange!8}{\parbox{\dimexpr\linewidth-2\fboxsep-2\fboxrule}{\small\textbf{Survivorship bias.} ${tx(b.text)}}}\par\medskip`;
    case 'h2':
      return L`\section{${tx(b.text)}}`;
    case 'h3':
      return L`\subsection{${tx(b.text)}}`;
    case 'p':
      return `${tx(b.text)}\n`;
    case 'eq':
      return b.label ? L`\begin{equation}\label{${b.label}}
${b.tex}
\end{equation}` : L`\[
${b.tex}
\]`;
    case 'bullets':
      return L`\begin{itemize}[leftmargin=*, itemsep=3pt]
${b.items.map((i) => L`\item ${tx(i)}`).join('\n')}
\end{itemize}`;
    case 'table':
      return table(b);
    case 'figure':
      return L`\begin{repfigure}{${tx(b.caption)}}{${b.label}}
${chart(b.chart)}
${b.note ? L`\tablenote{${tx(b.note)}}` : ''}\end{repfigure}`;
  }
}

export function toLatex(blocks: Block[], opts: { footer: string; title: string }): string {
  colors.clear();
  const body = blocks.map(block).join('\n\n');
  const defs = [...colors].map(([name, h]) => L`\definecolor{${name}}{HTML}{${h}}`).join('\n');
  return L`\documentclass[11pt,a4paper]{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{lmodern}
\usepackage[a4paper, margin=2.3cm, footskip=1.1cm]{geometry}
\usepackage{microtype}
\usepackage{amsmath, amssymb, mathtools}
\usepackage{array, booktabs, graphicx}
\usepackage[table]{xcolor}
\usepackage{pgfplots}
\pgfplotsset{compat=1.18}
\usepackage{caption}
\usepackage{enumitem}
\usepackage{fancyhdr, lastpage}
\usepackage[hidelinks]{hyperref}
\hypersetup{pdftitle={${tx(opts.title)}}}

\captionsetup{font=small, labelfont=bf, labelsep=period, skip=5pt}
\captionsetup[table]{position=top}
\setlength{\parindent}{0pt}
\setlength{\parskip}{5pt plus 1pt}
\renewcommand{\arraystretch}{1.12}
\pagestyle{fancy}
\fancyhf{}
\renewcommand{\headrulewidth}{0pt}
\fancyfoot[L]{\footnotesize\color{gray}${tx(opts.footer)}}
\fancyfoot[R]{\footnotesize\color{gray}\thepage\ / \pageref*{LastPage}}

% Tables: full text width; scaled down only when wider than the text.
\newsavebox{\tblbox}
\newcommand{\fittable}[2]{%
  \sbox{\tblbox}{\begin{tabular}{#1}#2\end{tabular}}%
  \ifdim\wd\tblbox>\linewidth
    \resizebox{\linewidth}{!}{\usebox{\tblbox}}%
  \else
    \begin{tabular*}{\linewidth}{@{\extracolsep{\fill}}#1}#2\end{tabular*}%
  \fi}
\newenvironment{reptable}[2]{\par\medskip\noindent\begin{minipage}{\linewidth}\small\captionof{table}{#1}\label{#2}\centering}{\end{minipage}\par\medskip}
\newenvironment{repfigure}[2]{\par\medskip\noindent\begin{minipage}{\linewidth}\centering\def\repcap{#1}\def\replab{#2}}{\captionof{figure}{\repcap}\label{\replab}\end{minipage}\par\medskip}
\newcommand{\tablenote}[1]{\par\vspace{3pt}{\raggedright\footnotesize\textit{Note.} #1\par}}

${defs}

\begin{document}
${body}
\end{document}
`;
}
