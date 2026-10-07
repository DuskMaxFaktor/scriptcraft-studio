import React from 'react';

// Colors printed by programs (colorama, rich, chalk, Node's console.log...) as ANSI escape codes:
// shown as colors in the console instead of "[33m"-style garbage.

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Text without any escape sequences (for copying and for the AI). */
export const stripAnsi = (text: string) => text.replace(ANSI_RE, '');

// Readable on both the dark and the light console background
const COLORS = ['#6b7280', '#ef4444', '#22c55e', '#eab308', '#3b82f6', '#d946ef', '#06b6d4', '#9ca3af'];
const BRIGHT = ['#9ca3af', '#f87171', '#4ade80', '#facc15', '#60a5fa', '#e879f9', '#22d3ee', '#e5e7eb'];

interface Style {
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

function color256(n: number): string | undefined {
  if (n < 8) return COLORS[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const c = n - 16;
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${v(Math.floor(c / 36))},${v(Math.floor(c / 6) % 6)},${v(c % 6)})`;
  }
  if (n < 256) {
    const g = 8 + (n - 232) * 10;
    return `rgb(${g},${g},${g})`;
  }
}

function applySgr(params: number[], s: Style): Style {
  const next = { ...s };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) Object.keys(next).forEach((k) => delete next[k as keyof Style]);
    else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 22) next.bold = next.dim = false;
    else if (p === 23) next.italic = false;
    else if (p === 24) next.underline = false;
    else if (p >= 30 && p <= 37) next.color = COLORS[p - 30];
    else if (p >= 90 && p <= 97) next.color = BRIGHT[p - 90];
    else if (p === 39) delete next.color;
    else if (p >= 40 && p <= 47) next.background = COLORS[p - 40];
    else if (p >= 100 && p <= 107) next.background = BRIGHT[p - 100];
    else if (p === 49) delete next.background;
    else if (p === 38 || p === 48) {
      let value: string | undefined;
      if (params[i + 1] === 5) {
        value = color256(params[i + 2]);
        i += 2;
      } else if (params[i + 1] === 2) {
        value = `rgb(${params[i + 2] || 0},${params[i + 3] || 0},${params[i + 4] || 0})`;
        i += 4;
      }
      if (value) next[p === 38 ? 'color' : 'background'] = value;
    }
  }
  return next;
}

/** Console line with ANSI colors as styled spans; plain text is returned as is. */
export function renderAnsi(text: string): React.ReactNode {
  if (!text.includes('\x1b')) return text;
  const parts: React.ReactNode[] = [];
  let style: Style = {};
  let last = 0;
  let key = 0;
  const flush = (end: number) => {
    if (end <= last) return;
    const chunk = text.slice(last, end);
    const css: React.CSSProperties = {
      color: style.color,
      backgroundColor: style.background,
      fontWeight: style.bold ? 700 : undefined,
      opacity: style.dim ? 0.7 : undefined,
      fontStyle: style.italic ? 'italic' : undefined,
      textDecoration: style.underline ? 'underline' : undefined,
    };
    parts.push(Object.values(css).some((v) => v !== undefined) ? <span key={key++} style={css}>{chunk}</span> : chunk);
  };
  for (const m of text.matchAll(ANSI_RE)) {
    flush(m.index!);
    last = m.index! + m[0].length;
    const sgr = /^\x1b\[([\d;]*)m$/.exec(m[0]);
    if (sgr) style = applySgr(sgr[1] === '' ? [0] : sgr[1].split(';').map((x) => Number(x) || 0), style);
  }
  flush(text.length);
  return parts;
}
