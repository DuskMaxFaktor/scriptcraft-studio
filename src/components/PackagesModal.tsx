import React, { useEffect, useState } from 'react';
import { Package, X, Loader2, Trash2, Download, FileText } from 'lucide-react';
import { useI18n } from '../i18n.ts';
import { FileItem } from '../types.ts';
import type { RunOutcome } from '../utils/interactiveRun.ts';

type Manager = 'pip' | 'npm';

interface PackagesModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string | null;
  files: FileItem[];
  /** Streams a started server session (install output) into the terminal and resolves when it ends */
  onSession: (runId: string, label: string) => Promise<RunOutcome>;
}

interface PackageInfo {
  name: string;
  version: string;
}

/** Package names from requirements.txt (options, comments, URLs and editable installs are skipped). */
function parseRequirements(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => l && !l.startsWith('-') && !l.includes('://') && !l.includes(';'))
    .map((l) => l.replace(/\s+/g, ''));
}

/** "name@version" specs from package.json dependencies (+ devDependencies). */
function parsePackageJson(text: string): string[] {
  try {
    const pkg = JSON.parse(text);
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return Object.entries(deps)
      .filter(([, v]) => typeof v === 'string' && !/[:/]/.test(v as string))
      .map(([n, v]) => (v === '*' || v === 'latest' ? n : `${n}@${(v as string).replace(/\s+/g, '')}`));
  } catch {
    return [];
  }
}

export const PackagesModal: React.FC<PackagesModalProps> = ({ isOpen, onClose, projectId, files, onSession }) => {
  const { t } = useI18n();
  const [manager, setManager] = useState<Manager>('pip');
  const [installed, setInstalled] = useState<{ python: PackageInfo[]; node: PackageInfo[] }>({ python: [], node: [] });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/packages`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setInstalled(data);
    } catch (err: any) {
      setError(err.message || String(err));
    }
  };

  useEffect(() => {
    if (isOpen) {
      setError(null);
      refresh();
    }
  }, [isOpen, projectId]);

  if (!isOpen) return null;

  const requirementsFile = files.find((f) => f.name.split('/').pop() === 'requirements.txt');
  const packageJsonFile = files.find((f) => f.name.split('/').pop() === 'package.json');
  const list = manager === 'pip' ? installed.python : installed.node;

  const install = async (packages: string[]) => {
    if (!projectId || packages.length === 0) return;
    setBusy('install');
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/packages/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manager, packages }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const outcome = await onSession(data.runId, `${manager} install ${packages.join(' ')}`);
      if (!outcome.success && !outcome.stopped) setError(t('packages.installFailed'));
      else setInput('');
      await refresh();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (name: string) => {
    if (!projectId) return;
    setBusy(name);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/packages/uninstall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manager, name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.runId) await onSession(data.runId, `npm uninstall ${name}`);
      await refresh();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setBusy(null);
    }
  };

  const fromFile = manager === 'pip' ? requirementsFile : packageJsonFile;
  const fromFileSpecs = fromFile ? (manager === 'pip' ? parseRequirements(fromFile.content) : parsePackageJson(fromFile.content)) : [];

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="bg-raised border border-slate-700/80 rounded-xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-modal">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
              <Package className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-fg">{t('packages.title')}</h2>
              <p className="text-xs text-slate-400">{t('packages.subtitle')}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-fg rounded-lg hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Manager switch */}
          <div className="flex rounded-lg border border-slate-700 overflow-hidden text-xs font-medium w-fit">
            {(
              [
                ['pip', 'Python (pip)'],
                ['npm', 'Node.js (npm)'],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setManager(m)}
                className={`px-3 py-1.5 ${manager === m ? 'bg-indigo-600 text-white' : 'bg-panel text-slate-400 hover:text-fg'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Install */}
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && install(input.split(/[\s,]+/).filter(Boolean))}
              placeholder={manager === 'pip' ? 'requests numpy==2.1.0' : 'lodash axios@1.7.0'}
              className="flex-1 bg-deep border border-slate-700 rounded-lg px-2.5 py-2 text-xs font-mono text-fg placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
            <button
              onClick={() => install(input.split(/[\s,]+/).filter(Boolean))}
              disabled={!!busy || !input.trim()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold"
            >
              {busy === 'install' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              <span>{t('packages.install')}</span>
            </button>
          </div>

          {fromFile && fromFileSpecs.length > 0 && (
            <button
              onClick={() => install(fromFileSpecs)}
              disabled={!!busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-panel hover:bg-hover border border-slate-700 text-slate-200 text-xs disabled:opacity-40"
            >
              <FileText className="w-3.5 h-3.5 text-emerald-400" />
              <span>{t('packages.fromFile', { file: fromFile.name, count: fromFileSpecs.length })}</span>
            </button>
          )}

          {busy === 'install' && <div className="text-[11px] text-indigo-300">{t('packages.seeTerminal')}</div>}
          {error && <div className="p-2.5 rounded-lg bg-rose-950/30 border border-rose-800 text-xs text-rose-300">{error}</div>}

          {/* Installed list */}
          <div>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              {t('packages.installed')} ({list.length})
            </div>
            {list.length === 0 ? (
              <div className="text-xs text-slate-500 py-3 text-center">{t('packages.none')}</div>
            ) : (
              <div className="space-y-1">
                {list.map((p) => (
                  <div key={p.name} className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-card border border-slate-800 text-xs">
                    <span className="font-mono text-fg">
                      {p.name} <span className="text-slate-500">{p.version}</span>
                    </span>
                    <button
                      onClick={() => uninstall(p.name)}
                      disabled={!!busy}
                      className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-slate-800 disabled:opacity-40"
                      title={t('packages.remove')}
                    >
                      {busy === p.name ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <p className="text-[11px] text-slate-500">{t('packages.note')}</p>
        </div>
      </div>
    </div>
  );
};
