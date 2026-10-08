import React, { useState } from 'react';
import { Play, ArrowRightToLine, ArrowDownToLine, ArrowUpFromLine, Square, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import { useI18n } from '../i18n.ts';
import type { StoppedState, EvalResult, DebugCommand, DebugVariable } from '../utils/debugClient.ts';

export interface DebugUiState {
  status: 'running' | 'paused';
  stopped: StoppedState | null;
  evals: EvalResult[];
  /** Latest value of each watch expression, re-evaluated at every pause */
  watchResults: Record<string, EvalResult>;
}

interface DebugPanelProps {
  state: DebugUiState | null;
  onCommand: (cmd: DebugCommand) => void;
  onStop: () => void;
  onEvaluate: (expr: string) => void;
  onOpenFrame: (file: string, line: number) => void;
  /** Watch expressions and how to change them */
  watches: string[];
  onAddWatch: (expr: string) => void;
  onRemoveWatch: (expr: string) => void;
}

/** Watch list: expressions kept across pauses, each showing its latest value. */
const WatchList: React.FC<{
  watches: string[];
  results: Record<string, EvalResult>;
  onAdd: (expr: string) => void;
  onRemove: (expr: string) => void;
}> = ({ watches, results, onAdd, onRemove }) => {
  const { t } = useI18n();
  const [expr, setExpr] = useState('');
  return (
    <div className="mb-3" data-watch-panel>
      <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider pb-1">{t('debug.watch')}</div>
      <input
        value={expr}
        onChange={(e) => setExpr(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && expr.trim()) {
            onAdd(expr.trim());
            setExpr('');
          }
        }}
        placeholder={t('debug.watchPlaceholder')}
        data-watch-input
        className="w-full bg-deep border border-slate-700 rounded px-2 py-1 font-mono text-[11px] text-fg placeholder-slate-500 focus:outline-none focus:border-indigo-500"
      />
      {watches.length === 0 && <div className="text-slate-600 text-[11px] py-1">{t('debug.watchEmpty')}</div>}
      {watches.map((w) => {
        const r = results[w];
        return (
          <div key={w} className="group flex items-baseline gap-2 py-0.5 font-mono text-[11px] select-text" data-watch-row>
            <span className="text-sky-300 shrink-0">{w}</span>
            <span className="text-slate-600 shrink-0">→</span>
            {r ? (
              r.error ? <span className="text-rose-400 truncate">{r.error}</span> : <span className="text-fg truncate">{r.value}</span>
            ) : (
              <span className="text-slate-600 truncate">—</span>
            )}
            <button
              onClick={() => onRemove(w)}
              className="ml-auto shrink-0 text-slate-600 hover:text-rose-400 opacity-0 group-hover:opacity-100"
              title={t('debug.watchRemove')}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
};

const VarList: React.FC<{ title: string; vars: DebugVariable[]; defaultOpen?: boolean }> = ({ title, vars, defaultOpen = true }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider py-1">
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {title} <span className="text-slate-600 normal-case font-normal">({vars.length})</span>
      </button>
      {open &&
        vars.map((v) => (
          <div key={v.name} className="flex items-baseline gap-2 pl-4 py-0.5 font-mono text-[11px] select-text" title={`${v.name}: ${v.type}`}>
            <span className="text-sky-300 shrink-0">{v.name}</span>
            <span className="text-slate-500 shrink-0">=</span>
            <span className="text-fg truncate">{v.value}</span>
            <span className="text-slate-600 shrink-0 ml-auto">{v.type}</span>
          </div>
        ))}
    </div>
  );
};

export const DebugPanel: React.FC<DebugPanelProps> = ({ state, onCommand, onStop, onEvaluate, onOpenFrame, watches, onAddWatch, onRemoveWatch }) => {
  const { t } = useI18n();
  const [expr, setExpr] = useState('');

  if (!state) {
    return <div className="text-slate-500 text-center py-6 text-xs px-6">{t('debug.idle')}</div>;
  }
  const paused = state.status === 'paused';
  const s = state.stopped;

  const btn = (cmd: DebugCommand, Icon: React.FC<any>, label: string, keys: string) => (
    <button
      onClick={() => onCommand(cmd)}
      disabled={!paused}
      title={`${label} (${keys})`}
      className="flex items-center gap-1 px-2 py-1 rounded bg-panel hover:bg-hover border border-slate-700 text-slate-200 disabled:opacity-35 text-[11px]"
    >
      <Icon className="w-3.5 h-3.5" />
      <span className="hidden xl:inline">{label}</span>
    </button>
  );

  return (
    <div className="h-full flex flex-col text-xs">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-800 bg-bar shrink-0 flex-wrap">
        {btn('continue', Play, t('debug.continue'), 'F5')}
        {btn('next', ArrowRightToLine, t('debug.stepOver'), 'F10')}
        {btn('step', ArrowDownToLine, t('debug.stepInto'), 'F11')}
        {btn('out', ArrowUpFromLine, t('debug.stepOut'), 'Shift+F11')}
        <button
          onClick={onStop}
          title={`${t('debug.stop')} (Shift+F5)`}
          className="flex items-center gap-1 px-2 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white text-[11px]"
        >
          <Square className="w-3.5 h-3.5 fill-current" />
          <span className="hidden xl:inline">{t('debug.stop')}</span>
        </button>
        <span className="ml-2 text-[11px] text-slate-400 flex items-center gap-1.5">
          {paused ? (
            <>
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              {t(s?.reason === 'breakpoint' ? 'debug.pausedBreakpoint' : 'debug.pausedStep', { file: s?.file || '', line: s?.line || 0 })}
            </>
          ) : (
            <>
              <Loader2 className="w-3 h-3 animate-spin" /> {t('debug.running')}
            </>
          )}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Call stack */}
        <div className="w-56 border-r border-slate-800 overflow-y-auto p-2 shrink-0">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider py-1">{t('debug.callStack')}</div>
          {paused && s
            ? s.stack.map((f, i) => (
                <button
                  key={i}
                  onClick={() => onOpenFrame(f.file, f.line)}
                  className={`w-full text-left px-1.5 py-0.5 rounded font-mono text-[11px] hover:bg-active ${i === 0 ? 'text-amber-300' : 'text-slate-300'}`}
                >
                  <div className="truncate">{f.name}</div>
                  <div className="text-[10px] text-slate-500 truncate">
                    {f.file}:{f.line}
                  </div>
                </button>
              ))
            : <div className="text-slate-600 text-[11px]">—</div>}
        </div>

        {/* Watch + variables + evaluate */}
        <div className="flex-1 min-w-0 overflow-y-auto p-2">
          <WatchList watches={watches} results={state.watchResults} onAdd={onAddWatch} onRemove={onRemoveWatch} />
          {paused && s ? (
            <>
              {s.locals.length > 0 && <VarList title={t('debug.locals')} vars={s.locals} />}
              <VarList title={t('debug.globals')} vars={s.globals} defaultOpen={s.locals.length === 0} />
            </>
          ) : (
            <div className="text-slate-600 text-[11px]">{t('debug.varsWhenPaused')}</div>
          )}

          <div className="mt-3 border-t border-slate-800 pt-2">
            <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider pb-1">{t('debug.evaluate')}</div>
            <input
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && expr.trim() && paused) {
                  onEvaluate(expr.trim());
                  setExpr('');
                }
              }}
              disabled={!paused}
              placeholder={t('debug.evaluatePlaceholder')}
              className="w-full bg-deep border border-slate-700 rounded px-2 py-1 font-mono text-[11px] text-fg placeholder-slate-500 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
            />
            {state.evals
              .slice(-8)
              .reverse()
              .map((r, i) => (
                <div key={i} className="font-mono text-[11px] py-0.5 select-text">
                  <span className="text-slate-400">{r.expr}</span>
                  <span className="text-slate-600"> → </span>
                  {r.error ? <span className="text-rose-400">{r.error}</span> : <span className="text-fg">{r.value}</span>}
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
};
