import React, { useMemo, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { Check, X, CheckCheck, GitCompare, Play, FilePlus, FileEdit, Package } from 'lucide-react';
import { useI18n } from '../i18n.ts';
import { useTheme } from '../theme.ts';
import { detectLanguageFromName } from '../utils/presets.ts';
import { lineDiffStats, type AgentApproval, type AgentApprovalRequest } from '../utils/agent.ts';
import '../monacoSetup.ts';

const MONACO_LANGUAGE: Record<string, string> = { bash: 'shell' };

interface Props {
  request: AgentApprovalRequest;
  onAnswer: (answer: AgentApproval) => void;
}

/** Card in the chat: the agent asks before changing files or running code. */
export const AgentApprovalCard: React.FC<Props> = ({ request, onAnswer }) => {
  const { t } = useI18n();
  const { theme } = useTheme();
  const [diffPath, setDiffPath] = useState<string | null>(null);

  const stats = useMemo(
    () =>
      request.kind === 'files'
        ? request.changes.map((c) => ({ ...c, ...lineDiffStats(c.oldContent, c.newContent) }))
        : [],
    [request]
  );
  const diffChange = request.kind === 'files' ? request.changes.find((c) => c.path === diffPath) : undefined;

  return (
    <div className="rounded-xl border border-amber-500/50 bg-amber-950/20 p-3 text-xs space-y-2 select-text" data-agent-approval={request.kind}>
      <div className="font-semibold text-amber-300">
        {request.kind === 'files'
          ? t('approve.filesTitle', { count: request.changes.length })
          : request.kind === 'run'
            ? t('approve.runTitle')
            : t('approve.installTitle')}
      </div>

      {request.kind === 'files' ? (
        <div className="space-y-1">
          {stats.map((c) => (
            <div key={c.path} className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-panel border border-slate-800">
              <div className="flex items-center gap-1.5 min-w-0">
                {c.oldContent === null ? (
                  <FilePlus className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                ) : (
                  <FileEdit className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                )}
                <span className="font-mono truncate text-fg" title={c.path}>
                  {c.path}
                </span>
                <span className="font-mono text-emerald-400 shrink-0">+{c.added}</span>
                <span className="font-mono text-rose-400 shrink-0">−{c.removed}</span>
              </div>
              <button
                onClick={() => setDiffPath(c.path)}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-slate-800 text-slate-300 shrink-0"
                title={t('approve.compare')}
              >
                <GitCompare className="w-3.5 h-3.5" />
                <span>{t('approve.compare')}</span>
              </button>
            </div>
          ))}
        </div>
      ) : request.kind === 'run' ? (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-panel border border-slate-800">
          <Play className="w-3.5 h-3.5 text-emerald-400" />
          <span className="font-mono text-fg">{request.path}</span>
          <span className="text-slate-500">{t('approve.runNote')}</span>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-slate-400">
            <Package className="w-3.5 h-3.5 text-amber-400" />
            <span>{t('approve.installNote')}</span>
          </div>
          {[
            ['pip', request.python],
            ['npm', request.node],
          ]
            .filter(([, list]) => (list as string[]).length > 0)
            .map(([mgr, list]) => (
              <div key={mgr as string} className="flex items-start gap-2 px-2 py-1 rounded bg-panel border border-slate-800">
                <span className="font-mono text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 shrink-0">{mgr as string}</span>
                <span className="font-mono text-fg break-all">{(list as string[]).join(', ')}</span>
              </div>
            ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <button
          onClick={() => onAnswer('yes')}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
        >
          <Check className="w-3.5 h-3.5" />
          {request.kind === 'files' ? t('approve.apply') : request.kind === 'run' ? t('approve.run') : t('approve.install')}
        </button>
        <button
          onClick={() => onAnswer('all')}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-panel hover:bg-hover border border-slate-700 text-slate-200"
          title={t('approve.allTitle')}
        >
          <CheckCheck className="w-3.5 h-3.5" />
          {t('approve.all')}
        </button>
        <button
          onClick={() => onAnswer('no')}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-panel hover:bg-hover border border-slate-700 text-rose-300"
        >
          <X className="w-3.5 h-3.5" />
          {t('approve.reject')}
        </button>
      </div>

      {diffChange && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4" onMouseDown={() => setDiffPath(null)}>
          <div
            className="bg-raised border border-slate-700 rounded-xl w-full max-w-5xl h-[80vh] flex flex-col overflow-hidden shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between text-xs">
              <span className="font-mono text-fg">
                {diffChange.path} · <span className="text-slate-400">{t('approve.diffLegend')}</span>
              </span>
              <button onClick={() => setDiffPath(null)} className="p-1 rounded hover:bg-slate-800 text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <DiffEditor
                original={diffChange.oldContent ?? ''}
                modified={diffChange.newContent}
                language={MONACO_LANGUAGE[detectLanguageFromName(diffChange.path)] || detectLanguageFromName(diffChange.path)}
                theme={theme === 'light' ? 'scriptcraft-light' : 'scriptcraft-dark'}
                options={{ readOnly: true, minimap: { enabled: false }, automaticLayout: true, fontSize: 12 }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
