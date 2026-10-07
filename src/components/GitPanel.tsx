import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import {
  GitBranch,
  GitCommitHorizontal,
  X,
  RefreshCw,
  Undo2,
  Loader2,
  ArrowUp,
  ArrowDown,
  ChevronRight,
  ChevronDown,
  Link2,
} from 'lucide-react';
import { FileItem } from '../types.ts';
import { useI18n } from '../i18n.ts';
import { useTheme } from '../theme.ts';
import { detectLanguageFromName } from '../utils/presets.ts';
import '../monacoSetup.ts';
import { GitHubPublish, GitHubLink } from './GitHubPublish.tsx';

interface GitFile {
  path: string;
  status: string;
}

interface GitStatus {
  available: boolean;
  repo: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files?: GitFile[];
  remote?: string | null;
  identity?: boolean;
  hasCommits?: boolean;
  output?: string;
}

interface Commit {
  hash: string;
  short: string;
  author: string;
  date: number;
  subject: string;
}

interface GitPanelProps {
  projectId: string | null;
  /** Project files: a change (after autosave) refreshes the status */
  files: FileItem[];
  /** Save pending editor changes to disk before git looks at them */
  onBeforeAction: () => Promise<void>;
  onClose: () => void;
  onLog: (type: 'info' | 'success' | 'error', message: string) => void;
}

const STATUS_COLOR: Record<string, string> = {
  M: 'text-amber-400',
  A: 'text-emerald-400',
  '?': 'text-emerald-400',
  D: 'text-red-400',
  R: 'text-sky-400',
  U: 'text-fuchsia-400',
};

async function call<T = GitStatus>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

const monacoLang = (name: string) => {
  const l = detectLanguageFromName(name);
  return l === 'bash' ? 'shell' : l === 'text' ? 'plaintext' : l;
};

export const GitPanel: React.FC<GitPanelProps> = ({ projectId, files, onBeforeAction, onClose, onLog }) => {
  const { t, lang } = useI18n();
  const { theme } = useTheme();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [commits, setCommits] = useState<Commit[]>([]);
  const [expanded, setExpanded] = useState<Record<string, GitFile[] | 'loading'>>({});
  const [remoteUrl, setRemoteUrl] = useState('');
  const [identity, setIdentity] = useState({ name: '', email: '' });
  const [diff, setDiff] = useState<{ path: string; original: string; modified: string } | null>(null);
  const [showHistory, setShowHistory] = useState(true);
  const base = projectId ? `/api/git/${encodeURIComponent(projectId)}` : '';
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    if (!base) return;
    const seq = ++loadSeq.current;
    try {
      const s = await call(`${base}/status`);
      if (seq !== loadSeq.current) return;
      setStatus(s);
      setError(null);
      if (s.repo) {
        const log = await call<{ commits: Commit[] }>(`${base}/log`);
        if (seq === loadSeq.current) setCommits(log.commits);
      }
    } catch (e: any) {
      if (seq === loadSeq.current) setError(e.message);
    }
  }, [base]);

  // On open, when files change (after the autosave) and when the window gets focus (terminal, other editors)
  useEffect(() => {
    setStatus(null);
    setCommits([]);
    setExpanded({});
    load();
  }, [load]);
  useEffect(() => {
    const timer = setTimeout(load, 1500);
    return () => clearTimeout(timer);
  }, [files, load]);
  useEffect(() => {
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  const run = async (name: string, action: () => Promise<GitStatus | void>, done?: (s: GitStatus) => void) => {
    setBusy(name);
    setError(null);
    try {
      await onBeforeAction();
      const s = await action();
      if (s) {
        setStatus(s);
        done?.(s);
      }
      await load();
    } catch (e: any) {
      setError(e.message);
      onLog('error', `git: ${e.message}`);
    } finally {
      setBusy(null);
    }
  };

  const changed = status?.files || [];
  const selected = changed.filter((f) => !unchecked.has(f.path));

  const commit = () => {
    const msg = message.trim();
    if (!msg || selected.length === 0 || busy) return;
    const all = selected.length === changed.length;
    run('commit', () => call(`${base}/commit`, { message: msg, ...(all ? {} : { paths: selected.map((f) => f.path) }) }), () => {
      setMessage('');
      setUnchecked(new Set());
      onLog('success', t('git.committed', { message: msg.split('\n')[0] }));
    });
  };

  const discard = (f: GitFile) => {
    const text = f.status === '?' || f.status === 'A' ? t('git.confirmDiscardNew', { name: f.path }) : t('git.confirmDiscard', { name: f.path });
    if (!confirm(text)) return;
    run(`discard:${f.path}`, () => call(`${base}/discard`, { path: f.path }));
  };

  const openDiff = async (f: GitFile) => {
    try {
      await onBeforeAction();
      setDiff(await call(`${base}/diff?path=${encodeURIComponent(f.path)}`));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const toggleCommit = async (c: Commit) => {
    if (expanded[c.hash]) {
      const next = { ...expanded };
      delete next[c.hash];
      setExpanded(next);
      return;
    }
    setExpanded((x) => ({ ...x, [c.hash]: 'loading' }));
    try {
      const r = await call<{ files: GitFile[] }>(`${base}/commit/${c.hash}`);
      setExpanded((x) => ({ ...x, [c.hash]: r.files }));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const remoteName = (url: string) => url.replace(/^https:\/\/|^git@|\.git$/g, '').replace(/^[^/:]+[/:]/, '');
  const when = (ms: number) => new Date(ms).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  const statusBadge = (s: string) => (
    <span className={`w-3 text-center font-mono text-[11px] font-bold shrink-0 ${STATUS_COLOR[s] || 'text-slate-400'}`} title={t(`git.status.${s}`)}>
      {s === '?' ? 'N' : s}
    </span>
  );

  const header = (
    <div className="px-3 py-2.5 flex items-center justify-between border-b border-slate-800/80">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider min-w-0">
        <GitBranch className="w-3.5 h-3.5 shrink-0" />
        <span>{t('git.title')}</span>
        {status?.branch && (
          <span className="normal-case tracking-normal font-mono text-[11px] text-indigo-300 truncate" title={t('git.branch')}>
            {status.branch}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        <button onClick={() => load()} className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800" title={t('git.refresh')}>
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
        </button>
        <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800" title={t('search.backToFiles')}>
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );

  const body = () => {
    if (!projectId || !status) {
      return (
        <div className="p-4 flex justify-center">
          <Loader2 className="w-4 h-4 animate-spin text-slate-500" />
        </div>
      );
    }
    if (!status.available) return <p className="p-3 text-xs text-slate-400 leading-relaxed">{t('git.notInstalled')}</p>;
    if (!status.repo) {
      return (
        <div className="p-3 space-y-3">
          <p className="text-xs text-slate-400 leading-relaxed">{t('git.noRepo')}</p>
          <button
            onClick={() => run('init', () => call(`${base}/init`, {}))}
            disabled={!!busy}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold"
          >
            {busy === 'init' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitBranch className="w-3.5 h-3.5" />}
            {t('git.init')}
          </button>
        </div>
      );
    }
    return (
      <div className="flex-1 overflow-y-auto">
        {!status.identity && (
          <div className="p-3 border-b border-slate-800 space-y-1.5">
            <p className="text-[11px] text-amber-300">{t('git.identityHint')}</p>
            <input
              value={identity.name}
              onChange={(e) => setIdentity({ ...identity, name: e.target.value })}
              placeholder={t('git.name')}
              className="w-full bg-canvas text-xs text-fg border border-slate-700 rounded px-2 py-1 focus:outline-none focus:border-indigo-500"
            />
            <input
              value={identity.email}
              onChange={(e) => setIdentity({ ...identity, email: e.target.value })}
              placeholder={t('git.email')}
              className="w-full bg-canvas text-xs text-fg border border-slate-700 rounded px-2 py-1 focus:outline-none focus:border-indigo-500"
            />
            <button
              onClick={() => run('identity', () => call(`${base}/identity`, identity))}
              className="px-2.5 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-[11px] font-semibold"
            >
              {t('git.save')}
            </button>
          </div>
        )}

        {/* Commit */}
        <div className="p-2 border-b border-slate-800 space-y-1.5">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                e.stopPropagation(); // not the studio's "run" shortcut
                commit();
              }
            }}
            rows={2}
            placeholder={t('git.message')}
            className="w-full resize-y bg-canvas text-xs text-fg border border-slate-700 rounded px-2 py-1.5 focus:outline-none focus:border-indigo-500"
          />
          <button
            onClick={commit}
            disabled={!message.trim() || selected.length === 0 || !!busy || !status.identity}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold"
          >
            {busy === 'commit' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitCommitHorizontal className="w-3.5 h-3.5" />}
            {t('git.commit', { count: selected.length })}
          </button>
        </div>

        {/* Changes */}
        <div className="py-1">
          <div className="px-3 py-1 flex items-center justify-between text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
            <span>
              {t('git.changes')} {changed.length > 0 && `(${changed.length})`}
            </span>
            {changed.length > 1 && (
              <input
                type="checkbox"
                title={t('git.selectAll')}
                checked={unchecked.size === 0}
                onChange={(e) => setUnchecked(e.target.checked ? new Set() : new Set(changed.map((f) => f.path)))}
                className="accent-indigo-500"
              />
            )}
          </div>
          {changed.length === 0 ? (
            <p className="px-3 py-1 text-xs text-slate-500">{t('git.noChanges')}</p>
          ) : (
            changed.map((f) => (
              <div
                key={f.path}
                data-git-file={f.path}
                className="group flex items-center gap-1.5 px-3 py-1 text-xs hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDiff(f)}
                title={`${f.path} — ${t(`git.status.${f.status}`)}`}
              >
                <input
                  type="checkbox"
                  checked={!unchecked.has(f.path)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const next = new Set(unchecked);
                    if (e.target.checked) next.delete(f.path);
                    else next.add(f.path);
                    setUnchecked(next);
                  }}
                  className="accent-indigo-500 shrink-0"
                />
                <span className={`truncate flex-1 font-mono ${f.status === 'D' ? 'line-through text-slate-500' : 'text-slate-300'}`}>{f.path}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    discard(f);
                  }}
                  className="p-0.5 rounded text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100"
                  title={t('git.discard')}
                >
                  {busy === `discard:${f.path}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />}
                </button>
                {statusBadge(f.status)}
              </div>
            ))
          )}
        </div>

        {/* Remote */}
        <div className="p-2 border-t border-slate-800 space-y-1.5">
          <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider px-1">{t('git.remote')}</div>
          {status.remote ? (
            <>
              <div className="flex items-center gap-1 px-1 text-[11px] text-slate-400 min-w-0" title={status.remote}>
                <Link2 className="w-3 h-3 shrink-0" />
                <span className="truncate font-mono">{remoteName(status.remote)}</span>
              </div>
              <GitHubLink remote={status.remote} />
              <div className="flex gap-1.5">
                <button
                  onClick={() =>
                    run('push', () => call(`${base}/push`, {}), () => onLog('success', t('git.pushed', { remote: remoteName(status.remote!) })))
                  }
                  disabled={!!busy || !status.hasCommits}
                  title={t('git.pushTitle')}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white text-[11px] font-semibold"
                >
                  {busy === 'push' ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUp className="w-3 h-3" />}
                  {t('git.push')} {status.ahead ? `(${status.ahead})` : ''}
                </button>
                <button
                  onClick={() =>
                    run('pull', () => call(`${base}/pull`, {}), () => onLog('success', t('git.pulled', { remote: remoteName(status.remote!) })))
                  }
                  disabled={!!busy}
                  title={t('git.pullTitle')}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white text-[11px] font-semibold"
                >
                  {busy === 'pull' ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowDown className="w-3 h-3" />}
                  {t('git.pull')} {status.behind ? `(${status.behind})` : ''}
                </button>
              </div>
            </>
          ) : (
            <div className="flex gap-1">
              <input
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                placeholder={t('git.remotePlaceholder')}
                className="flex-1 min-w-0 bg-canvas text-[11px] text-fg border border-slate-700 rounded px-2 py-1 focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={() => run('remote', () => call(`${base}/remote`, { url: remoteUrl.trim() }), () => setRemoteUrl(''))}
                disabled={!remoteUrl.trim() || !!busy}
                className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white text-[11px] font-semibold"
              >
                {t('git.connect')}
              </button>
            </div>
          )}
          {!status.remote && projectId && (
            <GitHubPublish
              projectId={projectId}
              defaultName={projectId}
              onBeforePublish={onBeforeAction}
              onPublished={async (url) => {
                onLog('success', url ? t('gh.published', { url }) : t('gh.publishedNoUrl'));
                await load();
              }}
            />
          )}
        </div>

        {/* History */}
        <div className="py-1 border-t border-slate-800">
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="w-full px-3 py-1 flex items-center gap-1 text-[11px] font-semibold text-slate-500 uppercase tracking-wider hover:text-slate-300"
          >
            {showHistory ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {t('git.history')} {commits.length > 0 && `(${commits.length})`}
          </button>
          {showHistory &&
            (commits.length === 0 ? (
              <p className="px-3 py-1 text-xs text-slate-500">{t('git.noCommits')}</p>
            ) : (
              commits.map((c) => {
                const exp = expanded[c.hash];
                return (
                  <div key={c.hash}>
                    <div
                      onClick={() => toggleCommit(c)}
                      className="px-3 py-1 hover:bg-slate-800/60 cursor-pointer"
                      title={`${c.hash}\n${c.author}`}
                    >
                      <div className="text-xs text-slate-300 truncate">{c.subject}</div>
                      <div className="text-[10px] text-slate-500 flex gap-2">
                        <span className="font-mono text-indigo-300/80">{c.short}</span>
                        <span className="truncate">{c.author}</span>
                        <span className="ml-auto shrink-0">{when(c.date)}</span>
                      </div>
                    </div>
                    {exp && (
                      <div className="pl-6 pr-3 pb-1">
                        {exp === 'loading' ? (
                          <Loader2 className="w-3 h-3 animate-spin text-slate-500" />
                        ) : (
                          exp.map((f) => (
                            <div key={f.path} className="flex items-center gap-1.5 text-[11px] font-mono text-slate-400">
                              {statusBadge(f.status)}
                              <span className="truncate">{f.path}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            ))}
        </div>
      </div>
    );
  };

  return (
    <aside className="w-full h-full border-r border-slate-800 bg-side flex flex-col select-none">
      {header}
      {error && (
        <div className="mx-2 mt-2 p-2 rounded border border-red-500/40 bg-red-500/10 text-[11px] text-red-300 whitespace-pre-wrap break-words select-text">
          {error}
        </div>
      )}
      {body()}

      {diff && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4" onMouseDown={() => setDiff(null)}>
          <div
            className="w-full max-w-6xl h-[80vh] bg-panel border border-slate-700 rounded-xl shadow-2xl flex flex-col overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2.5 flex items-center justify-between border-b border-slate-800">
              <span className="text-sm font-semibold text-fg truncate">{t('git.diffTitle', { name: diff.path })}</span>
              <button onClick={() => setDiff(null)} className="p-1 rounded text-slate-400 hover:text-fg hover:bg-slate-800">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <DiffEditor
                original={diff.original}
                modified={diff.modified}
                language={monacoLang(diff.path)}
                theme={theme === 'light' ? 'scriptcraft-light' : 'scriptcraft-dark'}
                options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, automaticLayout: true, fontSize: 12 }}
              />
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};
