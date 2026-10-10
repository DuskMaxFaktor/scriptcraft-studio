import React, { useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { Play, Plus, RotateCcw, Trash2, ChevronUp, ChevronDown, Loader2, Code2, FileText, Circle, Square, Variable, Download, RefreshCw, X } from 'lucide-react';
import { useI18n } from '../i18n.ts';
import { useTheme } from '../theme.ts';
import '../monacoSetup.ts';
import { previewToHtml } from '../utils/markdownHtml.ts';
// Loaded when the first text cell is shown
const MarkdownPreview = lazy(() => import('./MarkdownPreview.tsx').then((m) => ({ default: m.MarkdownPreview })));

// Jupyter-style Python notebook. Cells (code / markdown) run against one long-lived kernel that keeps
// its state between cells. The file is the standard .ipynb JSON, so it opens in Jupyter/VS Code too.

type OutKind = 'stream' | 'result' | 'error' | 'display';
interface NbOutput {
  kind: OutKind;
  name?: 'stdout' | 'stderr';
  text?: string;
  ename?: string;
  evalue?: string;
  traceback?: string;
  mime?: string; // for 'display' (e.g. image/png)
  data?: string; // base64
}
interface Cell {
  id: string;
  type: 'code' | 'markdown';
  source: string;
  outputs: NbOutput[];
  running?: boolean;
  edit?: boolean; // markdown: show the editor instead of the rendered view
}

interface Props {
  content: string;
  /** The .ipynb file's name in the project (for exported file names) */
  fileName?: string;
  projectId: string | null;
  onChange: (content: string) => void;
}

let uid = 0;
const newId = () => `cell-${Date.now()}-${++uid}`;
const asText = (s: unknown): string => (Array.isArray(s) ? s.join('') : String(s ?? ''));

// ---------- .ipynb parse / serialize ----------
function parseNotebook(content: string): Cell[] {
  try {
    const nb = JSON.parse(content);
    if (Array.isArray(nb.cells)) {
      return nb.cells.map((c: any): Cell => {
        const type = c.cell_type === 'markdown' ? 'markdown' : 'code';
        const outputs: NbOutput[] = Array.isArray(c.outputs)
          ? c.outputs
              .map((o: any): NbOutput | null => {
                if (o.output_type === 'stream') return { kind: 'stream', name: o.name === 'stderr' ? 'stderr' : 'stdout', text: asText(o.text) };
                if (o.output_type === 'execute_result' || o.output_type === 'display_data') {
                  if (o.data?.['image/png']) return { kind: 'display', mime: 'image/png', data: asText(o.data['image/png']).replace(/\s/g, '') };
                  return { kind: 'result', text: asText(o.data?.['text/plain']) };
                }
                if (o.output_type === 'error') return { kind: 'error', ename: o.ename, evalue: o.evalue, traceback: asText(o.traceback) };
                return null;
              })
              .filter(Boolean)
          : [];
        return { id: newId(), type, source: asText(c.source), outputs, edit: type === 'markdown' && !asText(c.source).trim() };
      });
    }
  } catch {
    // not valid JSON yet
  }
  // A new / empty notebook starts with one code cell
  return [{ id: newId(), type: 'code', source: '', outputs: [] }];
}

const toLines = (s: string): string[] => {
  const parts = s.split('\n');
  return parts.map((l, i) => (i < parts.length - 1 ? l + '\n' : l)).filter((l, i) => !(i === parts.length - 1 && l === ''));
};

function serializeNotebook(cells: Cell[]): string {
  const nb = {
    cells: cells.map((c) =>
      c.type === 'markdown'
        ? { cell_type: 'markdown', metadata: {}, source: toLines(c.source) }
        : {
            cell_type: 'code',
            metadata: {},
            execution_count: null,
            source: toLines(c.source),
            outputs: c.outputs.map((o) =>
              o.kind === 'stream'
                ? { output_type: 'stream', name: o.name || 'stdout', text: toLines(o.text || '') }
                : o.kind === 'display'
                  ? { output_type: 'display_data', data: { [o.mime || 'image/png']: o.data || '' }, metadata: {} }
                  : o.kind === 'result'
                    ? { output_type: 'execute_result', data: { 'text/plain': toLines(o.text || '') }, metadata: {}, execution_count: null }
                    : { output_type: 'error', ename: o.ename || '', evalue: o.evalue || '', traceback: (o.traceback || '').split('\n') }
            ),
          }
    ),
    metadata: { language_info: { name: 'python' }, kernelspec: { name: 'python3', display_name: 'Python 3' } },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return JSON.stringify(nb, null, 1);
}

// ---------- export ----------
/** Python script in the "percent" format (# %% cells), which VS Code, Spyder and Jupytext open as cells. */
export function notebookToPython(cells: { type: 'code' | 'markdown'; source: string }[]): string {
  return (
    cells
      .map((c) =>
        c.type === 'code'
          ? `# %%\n${c.source.trimEnd()}`
          : `# %% [markdown]\n${c.source
              .trimEnd()
              .split('\n')
              .map((l) => (l ? `# ${l}` : '#'))
              .join('\n')}`
      )
      .join('\n\n') + '\n'
  );
}

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** One cell's outputs as HTML (text escaped, pictures inline). */
function outputsHtml(outputs: NbOutput[]): string {
  if (!outputs.length) return '';
  return (
    '<div class="nb-out">' +
    outputs
      .map((o) =>
        o.kind === 'display'
          ? `<img src="data:${escHtml(o.mime || 'image/png')};base64,${(o.data || '').replace(/[^A-Za-z0-9+/=]/g, '')}" alt="">`
          : `<pre class="${o.kind === 'error' ? 'nb-err' : o.name === 'stderr' ? 'nb-stderr' : o.kind === 'result' ? 'nb-result' : ''}">${escHtml(
              o.kind === 'error' ? `${o.ename}: ${o.evalue}\n${o.traceback || ''}` : o.text || ''
            )}</pre>`
      )
      .join('') +
    '</div>'
  );
}

const NB_CSS = `<style>
  .nb-code { margin: 1.2em 0 0; } .nb-code pre { margin: 0; border-radius: 8px 8px 0 0; }
  .nb-code:last-child pre, .nb-code pre:only-child { border-radius: 8px; }
  .nb-out { border: 1px solid #e5e7eb; border-top: 0; border-radius: 0 0 8px 8px; padding: 8px 12px; background: #fff; }
  .nb-out pre { background: none; border: 0; padding: 0; margin: .2em 0; white-space: pre-wrap; }
  .nb-out img { display: block; margin: .4em 0; }
  .nb-err { color: #b91c1c; } .nb-stderr { color: #b45309; } .nb-result { color: #1d4ed8; }
</style>`;

// ---------- a code cell's editor (Monaco, syntax-highlighted, auto-growing) ----------
const CellEditor: React.FC<{ cellId: string; value: string; onChange: (v: string) => void; onRun: () => void }> = ({ cellId, value, onChange, onRun }) => {
  const { theme } = useTheme();
  const wrapRef = useRef<HTMLDivElement>(null);
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  const handleMount: OnMount = (editor, monaco) => {
    const fit = () => {
      const h = Math.min(Math.max(editor.getContentHeight(), 22), 1200);
      if (wrapRef.current) {
        wrapRef.current.style.height = h + 'px';
        editor.layout({ width: wrapRef.current.clientWidth, height: h });
      }
    };
    editor.onDidContentSizeChange(fit);
    fit();
    // Shift+Enter / Ctrl+Enter run the cell (instead of inserting a newline)
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => onRunRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onRunRef.current());
  };

  return (
    <div ref={wrapRef} className="w-full">
      <Editor
        path={`nb-${cellId}.py`}
        language="python"
        value={value}
        onChange={(v) => onChange(v ?? '')}
        onMount={handleMount}
        theme={theme === 'light' ? 'scriptcraft-light' : 'scriptcraft-dark'}
        options={{
          fontSize: 12.5,
          fontFamily: "'Fira Code', 'JetBrains Mono', Consolas, monospace",
          lineNumbers: 'off',
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          folding: false,
          glyphMargin: false,
          lineDecorationsWidth: 0,
          lineNumbersMinChars: 0,
          overviewRulerLanes: 0,
          renderLineHighlight: 'none',
          scrollbar: { vertical: 'hidden', horizontalScrollbarSize: 8, alwaysConsumeMouseWheel: false },
          wordWrap: 'on',
          automaticLayout: false,
          padding: { top: 6, bottom: 6 },
          tabSize: 4,
          bracketPairColorization: { enabled: true },
          guides: { indentation: false },
          contextmenu: false,
        }}
      />
    </div>
  );
};

// ---------- a markdown cell's text editor (auto-growing) ----------
const CodeArea: React.FC<{ value: string; onChange: (v: string) => void; onRun: () => void; placeholder: string }> = ({ value, onChange, onRun, placeholder }) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.max(el.scrollHeight, 22) + 'px';
    }
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      spellCheck={false}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey)) {
          e.preventDefault();
          onRun();
        }
      }}
      className="w-full bg-transparent font-mono text-[12.5px] leading-5 text-fg resize-none focus:outline-none p-2"
    />
  );
};

export const NotebookView: React.FC<Props> = ({ content, fileName = 'notebook.ipynb', projectId, onChange }) => {
  const { t } = useI18n();
  const [showVars, setShowVars] = useState(false);
  const [vars, setVars] = useState<{ name: string; type: string; size: string; value: string }[] | null>(null);
  const [varsError, setVarsError] = useState<string | null>(null);
  const [exportMenu, setExportMenu] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const showVarsRef = useRef(showVars);
  showVarsRef.current = showVars;
  const [cells, setCells] = useState<Cell[]>(() => parseNotebook(content));
  const [kernelStatus, setKernelStatus] = useState<'off' | 'starting' | 'ready' | 'busy' | 'dead'>('off');
  const kernelIdRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const execToCell = useRef<Map<string, string>>(new Map());
  const execDone = useRef<Map<string, () => void>>(new Map());
  // Events for an execId can arrive before the POST /exec response registers it: buffer and replay them
  const pendingEvents = useRef<Map<string, any[]>>(new Map());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Autosave: serialize to .ipynb a short moment after any change
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  useEffect(() => {
    const id = setTimeout(() => onChangeRef.current(serializeNotebook(cellsRef.current)), 400);
    return () => clearTimeout(id);
  }, [cells]);

  useEffect(() => () => void shutdownKernel(), []);

  async function shutdownKernel() {
    esRef.current?.close();
    esRef.current = null;
    const id = kernelIdRef.current;
    kernelIdRef.current = null;
    if (id) await fetch(`/api/notebook/kernel/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  function handleEvent(e: any) {
    if (e.type === 'kernel') {
      if (e.status === 'ready' || e.status === 'restarted') setKernelStatus('ready');
      else if (e.status === 'dead' || e.status === 'error') setKernelStatus('dead');
      return;
    }
    const cellId = execToCell.current.get(e.execId);
    if (!cellId) {
      // The exec hasn't been registered yet — keep the event and replay it once it is
      if (e.execId) pendingEvents.current.set(e.execId, [...(pendingEvents.current.get(e.execId) || []), e]);
      return;
    }
    if (e.type === 'done') {
      setCells((cs) => cs.map((c) => (c.id === cellId ? { ...c, running: false } : c)));
      if (showVarsRef.current) void loadVars();
      execDone.current.get(e.execId)?.();
      execDone.current.delete(e.execId);
      execToCell.current.delete(e.execId);
      setKernelStatus((s) => (s === 'busy' ? 'ready' : s));
      return;
    }
    const out: NbOutput | null =
      e.type === 'stream'
        ? { kind: 'stream', name: e.name, text: e.text }
        : e.type === 'result'
          ? { kind: 'result', text: e.text }
          : e.type === 'display'
            ? { kind: 'display', mime: e.mime, data: e.data }
            : e.type === 'error'
              ? { kind: 'error', ename: e.ename, evalue: e.evalue, traceback: e.traceback }
              : null;
    if (!out) return;
    setCells((cs) =>
      cs.map((c) => {
        if (c.id !== cellId) return c;
        // print() writes in pieces ("total", " ", "60", "\n"): text of the same stream continues the last block
        const last = c.outputs[c.outputs.length - 1];
        if (out.kind === 'stream' && last?.kind === 'stream' && last.name === out.name) {
          return { ...c, outputs: [...c.outputs.slice(0, -1), { ...last, text: (last.text || '') + (out.text || '') }] };
        }
        return { ...c, outputs: [...c.outputs, out] };
      })
    );
  }

  /** Ensure a kernel is running and its event stream is open; resolves when it is ready. */
  async function ensureKernel(): Promise<string | null> {
    if (kernelIdRef.current && kernelStatus !== 'dead') return kernelIdRef.current;
    setKernelStatus('starting');
    try {
      const res = await fetch('/api/notebook/kernel/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();
      if (!res.ok || !data.kernelId) throw new Error(data.error || 'Cannot start the kernel');
      kernelIdRef.current = data.kernelId;
      await new Promise<void>((resolve) => {
        const es = new EventSource(`/api/notebook/kernel/${data.kernelId}/events`);
        esRef.current = es;
        let opened = false;
        es.onmessage = (m) => {
          const e = JSON.parse(m.data);
          if (!opened && e.type === 'kernel' && (e.status === 'ready' || e.status === 'restarted')) {
            opened = true;
            resolve();
          }
          handleEvent(e);
        };
        es.onerror = () => {
          if (!opened) {
            opened = true;
            resolve();
          }
        };
      });
      return kernelIdRef.current;
    } catch {
      setKernelStatus('dead');
      return null;
    }
  }

  async function runCell(cell: Cell): Promise<void> {
    if (cell.type === 'markdown') {
      setCells((cs) => cs.map((c) => (c.id === cell.id ? { ...c, edit: false } : c)));
      return;
    }
    const kernelId = await ensureKernel();
    if (!kernelId) return;
    setKernelStatus('busy');
    setCells((cs) => cs.map((c) => (c.id === cell.id ? { ...c, running: true, outputs: [] } : c)));
    const res = await fetch(`/api/notebook/kernel/${kernelId}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: cellsRef.current.find((c) => c.id === cell.id)?.source ?? cell.source }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.execId) {
      setCells((cs) => cs.map((c) => (c.id === cell.id ? { ...c, running: false } : c)));
      return;
    }
    await new Promise<void>((resolve) => {
      execDone.current.set(data.execId, resolve);
      execToCell.current.set(data.execId, cell.id);
      // Replay any events that arrived before this registration
      const buffered = pendingEvents.current.get(data.execId);
      if (buffered) {
        pendingEvents.current.delete(data.execId);
        buffered.forEach((ev) => handleEvent(ev));
      }
    });
  }

  async function runAll() {
    for (const c of cellsRef.current) if (c.type === 'code') await runCell(c);
  }

  /** The kernel's variables (the panel is refreshed after every cell). */
  async function loadVars() {
    const id = kernelIdRef.current;
    if (!id) {
      setVars(null);
      return;
    }
    try {
      const res = await fetch(`/api/notebook/kernel/${id}/vars`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setVars(data.vars);
      setVarsError(null);
    } catch (e: any) {
      setVarsError(e.message);
    }
  }

  const download = (name: string, text: string, type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const baseName = fileName.slice(fileName.lastIndexOf('/') + 1).replace(/\.ipynb$/i, '');

  /** HTML with the rendered text cells, the code and every output (pictures included). */
  async function exportHtml() {
    setExportMenu(false);
    setExporting(true);
    try {
    // The hidden copy below renders every markdown cell (also the ones being edited); wait for diagrams
    const started = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 100));
      const box = exportRef.current;
      const previews = box ? box.querySelectorAll('[data-md-preview]').length : 0;
      const pending = box
        ? previews < box.querySelectorAll('[data-export-md]').length ||
          !!box.querySelector('[data-md-math="loading"]') ||
          [...box.querySelectorAll('[data-mermaid]')].some((d) => !d.querySelector('svg') && !d.querySelector('pre'))
        : true;
      if (box && !pending) break;
      if (Date.now() - started > 5000) break;
    }
    const rendered = exportRef.current ? [...exportRef.current.querySelectorAll('[data-export-md]')] : [];
    let mdIndex = 0;
    const body = cellsRef.current
      .map((c) => {
        if (c.type === 'markdown') return rendered[mdIndex++]?.innerHTML || '';
        return `<div class="nb-code"><pre><code>${escHtml(c.source)}</code></pre>${outputsHtml(c.outputs)}</div>`;
      })
      .join('\n');
    const holder = document.createElement('div');
    holder.innerHTML = NB_CSS + body;
    download(`${baseName}.html`, previewToHtml(holder, baseName), 'text/html;charset=utf-8');
    } finally {
      setExporting(false); // never leave the spinner (and the hidden copy) behind after an error
    }
  }

  async function interruptKernel() {
    const id = kernelIdRef.current;
    if (id) await fetch(`/api/notebook/kernel/${id}/interrupt`, { method: 'POST' }).catch(() => {});
  }

  async function restartKernel() {
    const id = kernelIdRef.current;
    if (!id) return;
    setKernelStatus('starting');
    await fetch(`/api/notebook/kernel/${id}/restart`, { method: 'POST' }).catch(() => {});
  }

  // ---------- cell editing ----------
  const update = (id: string, patch: Partial<Cell>) => setCells((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const addCell = (type: 'code' | 'markdown', after?: number) =>
    setCells((cs) => {
      const cell: Cell = { id: newId(), type, source: '', outputs: [], edit: type === 'markdown' };
      const at = after === undefined ? cs.length : after + 1;
      return [...cs.slice(0, at), cell, ...cs.slice(at)];
    });
  const removeCell = (id: string) => setCells((cs) => (cs.length <= 1 ? cs : cs.filter((c) => c.id !== id)));
  const move = (index: number, dir: -1 | 1) =>
    setCells((cs) => {
      const j = index + dir;
      if (j < 0 || j >= cs.length) return cs;
      const next = cs.slice();
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });

  const statusDot = useMemo(
    () => ({ off: 'text-slate-600', starting: 'text-amber-400', ready: 'text-emerald-400', busy: 'text-amber-400', dead: 'text-rose-400' })[kernelStatus],
    [kernelStatus]
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-canvas" data-notebook>
      {/* Toolbar */}
      <div className="h-10 bg-bar border-b border-slate-800 flex items-center gap-1.5 px-3 shrink-0 text-xs">
        <button onClick={runAll} className="flex items-center gap-1 px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white" title={t('nb.runAll')}>
          <Play className="w-3.5 h-3.5" /> {t('nb.runAll')}
        </button>
        <button onClick={() => addCell('code')} className="flex items-center gap-1 px-2 py-1 rounded border border-slate-700 hover:bg-hover text-slate-200">
          <Code2 className="w-3.5 h-3.5" /> {t('nb.addCode')}
        </button>
        <button onClick={() => addCell('markdown')} className="flex items-center gap-1 px-2 py-1 rounded border border-slate-700 hover:bg-hover text-slate-200">
          <FileText className="w-3.5 h-3.5" /> {t('nb.addMd')}
        </button>
        {kernelStatus === 'busy' && (
          <button onClick={interruptKernel} data-nb-interrupt className="flex items-center gap-1 px-2 py-1 rounded border border-rose-500/60 text-rose-300 hover:bg-rose-500/10" title={t('nb.interrupt')}>
            <Square className="w-3 h-3 fill-current" /> {t('nb.interrupt')}
          </button>
        )}
        <button onClick={restartKernel} className="flex items-center gap-1 px-2 py-1 rounded border border-slate-700 hover:bg-hover text-slate-200" title={t('nb.restart')}>
          <RotateCcw className="w-3.5 h-3.5" /> {t('nb.restart')}
        </button>
        <button
          onClick={() => {
            const next = !showVars;
            setShowVars(next);
            if (next) void loadVars();
          }}
          className={`flex items-center gap-1 px-2 py-1 rounded border ${showVars ? 'border-indigo-500 text-indigo-200 bg-indigo-500/10' : 'border-slate-700 text-slate-200 hover:bg-hover'}`}
          data-nb-vars-toggle
        >
          <Variable className="w-3.5 h-3.5" /> {t('nb.vars')}
        </button>
        <div className="relative">
          <button onClick={() => setExportMenu(!exportMenu)} className="flex items-center gap-1 px-2 py-1 rounded border border-slate-700 hover:bg-hover text-slate-200" data-nb-export>
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} {t('nb.export')}
          </button>
          {exportMenu && (
            <div className="absolute left-0 top-full mt-1 z-20 w-56 rounded-lg border border-slate-700 bg-raised shadow-xl py-1">
              <button
                onClick={() => {
                  setExportMenu(false);
                  download(`${baseName}.py`, notebookToPython(cellsRef.current), 'text/x-python;charset=utf-8');
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-hover text-slate-200"
                data-nb-export-py
              >
                {t('nb.exportPy')}
              </button>
              <button onClick={exportHtml} className="w-full text-left px-3 py-1.5 hover:bg-hover text-slate-200" data-nb-export-html>
                {t('nb.exportHtml')}
              </button>
            </div>
          )}
        </div>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-400" data-kernel-status={kernelStatus}>
          <Circle className={`w-2.5 h-2.5 fill-current ${statusDot}`} /> {t('nb.kernel')}: {t('nb.status.' + kernelStatus)}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex">
      {/* Cells */}
      <div className="flex-1 min-w-0 overflow-auto p-3 space-y-2">
        {cells.map((cell, i) => (
          <div key={cell.id} className="group flex gap-2" data-cell data-cell-type={cell.type}>
            {/* Run / gutter */}
            <div className="w-7 shrink-0 flex flex-col items-center pt-1.5">
              <button onClick={() => runCell(cell)} className="text-slate-500 hover:text-indigo-400" title={t('nb.runCell')} data-run-cell>
                {cell.running ? <Loader2 className="w-4 h-4 animate-spin text-indigo-400" /> : <Play className="w-4 h-4" />}
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 min-w-0 rounded-lg border border-slate-800 overflow-hidden">
              {cell.type === 'markdown' && !cell.edit ? (
                <div onDoubleClick={() => update(cell.id, { edit: true })} className="min-h-[2rem] cursor-text" data-md-cell>
                  {cell.source.trim() ? (
                    <Suspense fallback={<div className="p-3 min-h-[2rem]" />}>
                      <MarkdownPreview content={cell.source} projectId={projectId || undefined} />
                    </Suspense>
                  ) : <div className="p-3 text-slate-500 text-xs italic">{t('nb.emptyMd')}</div>}
                </div>
              ) : cell.type === 'code' ? (
                <div className="bg-deep/40">
                  <CellEditor cellId={cell.id} value={cell.source} onChange={(v) => update(cell.id, { source: v })} onRun={() => runCell(cell)} />
                </div>
              ) : (
                <div className="bg-panel/40">
                  <CodeArea value={cell.source} onChange={(v) => update(cell.id, { source: v })} onRun={() => runCell(cell)} placeholder={t('nb.mdPlaceholder')} />
                </div>
              )}

              {/* Outputs */}
              {cell.outputs.length > 0 && (
                <div className="border-t border-slate-800 bg-deep/60 p-2 space-y-1 font-mono text-[11.5px] select-text" data-cell-output>
                  {cell.outputs.map((o, k) =>
                    o.kind === 'display' ? (
                      <img key={k} src={`data:${o.mime || 'image/png'};base64,${o.data}`} alt="" className="max-w-full rounded bg-white" data-cell-image />
                    ) : (
                      <pre
                        key={k}
                        className={`whitespace-pre-wrap break-words ${o.kind === 'error' ? 'text-rose-300' : o.name === 'stderr' ? 'text-amber-300' : o.kind === 'result' ? 'text-sky-200' : 'text-slate-200'}`}
                      >
                        {o.kind === 'error' ? `${o.ename}: ${o.evalue}\n${o.traceback || ''}` : o.text}
                      </pre>
                    )
                  )}
                </div>
              )}
            </div>

            {/* Cell actions */}
            <div className="w-6 shrink-0 flex flex-col items-center gap-0.5 pt-1 opacity-0 group-hover:opacity-100">
              <button onClick={() => move(i, -1)} className="text-slate-500 hover:text-fg" title={t('nb.moveUp')}>
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => move(i, 1)} className="text-slate-500 hover:text-fg" title={t('nb.moveDown')}>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => update(cell.id, cell.type === 'code' ? { type: 'markdown', edit: true } : { type: 'code', edit: false })}
                className="text-slate-500 hover:text-fg"
                title={t('nb.toggleType')}
              >
                {cell.type === 'code' ? <FileText className="w-3.5 h-3.5" /> : <Code2 className="w-3.5 h-3.5" />}
              </button>
              <button onClick={() => removeCell(cell.id)} className="text-slate-500 hover:text-rose-400" title={t('nb.deleteCell')} data-delete-cell>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
        <button onClick={() => addCell('code')} className="mt-1 ml-9 flex items-center gap-1 text-[11px] text-slate-500 hover:text-indigo-400">
          <Plus className="w-3.5 h-3.5" /> {t('nb.addCode')}
        </button>
      </div>

      {/* Variables of the kernel */}
      {showVars && (
        <aside className="w-80 shrink-0 border-l border-slate-800 bg-panel/40 flex flex-col text-[11px]" data-nb-vars>
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800">
            <span className="font-semibold text-slate-200">{t('nb.vars')}</span>
            <button onClick={() => void loadVars()} className="ml-auto text-slate-400 hover:text-fg" title={t('nb.varsRefresh')}>
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setShowVars(false)} className="text-slate-400 hover:text-fg">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            {varsError && <div className="p-3 text-rose-300">{varsError}</div>}
            {!varsError && vars === null && <div className="p-3 text-slate-500">{t('nb.varsNoKernel')}</div>}
            {!varsError && vars?.length === 0 && <div className="p-3 text-slate-500">{t('nb.varsEmpty')}</div>}
            {vars && vars.length > 0 && (
              <table className="w-full">
                <tbody>
                  {vars.map((v) => (
                    <tr key={v.name} className="border-b border-slate-800/60 align-top" data-nb-var={v.name}>
                      <td className="px-2 py-1 font-mono text-sky-300 whitespace-nowrap">{v.name}</td>
                      <td className="px-1 py-1 text-slate-400 whitespace-nowrap">
                        {v.type}
                        {v.size && <span className="text-slate-500"> [{v.size}]</span>}
                      </td>
                      <td className="px-2 py-1 font-mono text-slate-200 break-all" title={v.value}>
                        {v.value.length > 80 ? v.value.slice(0, 80) + '…' : v.value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </aside>
      )}
      </div>

      {/* Hidden: every markdown cell rendered, for the HTML export */}
      {exporting && (
        <div ref={exportRef} className="fixed -left-[10000px] top-0 w-[860px]" aria-hidden>
          {cells
            .filter((c) => c.type === 'markdown')
            .map((c) => (
              <div key={c.id} data-export-md>
                <Suspense fallback={null}>
                  <MarkdownPreview content={c.source} projectId={projectId || undefined} />
                </Suspense>
              </div>
            ))}
        </div>
      )}
    </div>
  );
};
