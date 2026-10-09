import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Info, X, RefreshCw, Download, ExternalLink, Loader2, CheckCircle2, Copy, Save, FolderOpen, MessageSquareWarning } from 'lucide-react';
import { useI18n } from '../i18n.ts';
import { checkForUpdates, useUpdateInfo } from '../updates.ts';
import { askConfirm } from '../dialogs.tsx';

// "About ScriptCraft Studio": version and updates, reporting a problem.

export type Tab = 'help' | 'updates' | 'report';

const MarkdownPreview = lazy(() => import('./MarkdownPreview.tsx').then((m) => ({ default: m.MarkdownPreview })));

interface Status {
  version: string;
  installed: boolean;
  repo: string;
  autoCheck: boolean;
}

export const AboutModal: React.FC<{ isOpen: boolean; onClose: () => void; initialTab?: Tab; onShowTour?: () => void }> = ({ isOpen, onClose, initialTab = 'help', onShowTour }) => {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => {
    if (isOpen) setTab(initialTab);
  }, [isOpen, initialTab]);
  const info = useUpdateInfo();
  const [status, setStatus] = useState<Status | null>(null);
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState<'check' | 'install' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    fetch('/api/update')
      .then((r) => r.json())
      .then((s: Status) => {
        setStatus(s);
        setRepo(s.repo);
      })
      .catch(() => {});
  }, [isOpen]);

  if (!isOpen) return null;

  const save = async (patch: Partial<Status>) => {
    setBusy('save');
    setError(null);
    try {
      const res = await fetch('/api/update', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStatus((s) => (s ? { ...s, ...patch, repo: data.repo ?? s.repo } : s));
      if (data.repo !== undefined) setRepo(data.repo);
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    if (repo !== status?.repo && !(await save({ repo }))) return;
    setBusy('check');
    setError(null);
    try {
      await checkForUpdates();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    if (!info) return;
    if (!(await askConfirm(t('about.installConfirm', { version: info.latest }), { okLabel: t('about.install') }))) return;
    setBusy('install');
    setError(null);
    try {
      const res = await fetch('/api/update/install', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setInstalling(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const input = 'w-full px-2 py-1.5 rounded bg-panel border border-slate-700 text-xs text-fg outline-none focus:border-indigo-500';
  const btn = 'flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className={`bg-raised border border-slate-700 rounded-xl w-full ${tab === 'help' ? 'max-w-4xl h-[85vh]' : 'max-w-lg max-h-[90vh]'} shadow-2xl overflow-hidden flex flex-col`}
        onMouseDown={(e) => e.stopPropagation()}
        data-about
      >
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between bg-modal">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Info className="w-4 h-4 text-indigo-400" />
            {t('about.title')}
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-fg rounded-lg hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className={`p-5 space-y-4 text-xs flex-1 min-h-0 ${tab === 'help' ? 'flex flex-col' : 'overflow-auto'}`}>
          <div>
            <div className="text-base font-semibold text-fg">ScriptCraft Studio</div>
            <div className="text-slate-400" data-about-version>
              {t('about.version', { version: status?.version || '…' })} ·{' '}
              {status ? (status.installed ? t('about.kindInstalled') : t('about.kindPortable')) : ''}
            </div>
          </div>

          <div className="flex gap-1 border-b border-slate-800">
            {(['help', 'updates', 'report'] as Tab[]).map((id) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`px-3 py-1.5 -mb-px border-b-2 font-semibold ${tab === id ? 'border-indigo-500 text-fg' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
                data-about-tab={id}
              >
                {t(`about.tab.${id}`)}
              </button>
            ))}
          </div>

          {tab === 'help' && <HelpSection onShowTour={onShowTour} />}
          {tab === 'report' && <ReportSection repo={status?.repo || ''} />}

          {tab === 'updates' && (
          <section className="space-y-2">
            <label className="block text-slate-400">{t('about.repo')}</label>
            <div className="flex gap-2">
              <input className={input} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/scriptcraft-studio" data-update-repo />
              <button onClick={check} disabled={!repo.trim() || !!busy} className={`${btn} bg-indigo-600 hover:bg-indigo-500 text-white shrink-0`} data-update-check>
                {busy === 'check' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                {t('about.check')}
              </button>
            </div>
            <div className="text-slate-500">{t('about.repoHint')}</div>
            <label className="flex items-center gap-2 text-slate-300 cursor-pointer select-none">
              <input type="checkbox" checked={!!status?.autoCheck} onChange={(e) => save({ autoCheck: e.target.checked })} />
              {t('about.autoCheck')}
            </label>

            {error && <div className="p-2 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 whitespace-pre-wrap">{error}</div>}

            {info && !info.available && (
              <div className="flex items-center gap-2 text-emerald-400" data-update-latest>
                <CheckCircle2 className="w-4 h-4" /> {t('about.upToDate', { version: info.current })}
              </div>
            )}
            {info?.available && (
              <div className="p-3 rounded border border-indigo-500/40 bg-indigo-500/10 space-y-2" data-update-available>
                <div className="font-semibold text-indigo-200">
                  {t('about.available', { version: info.latest })}
                  {info.size > 0 && <span className="text-slate-400 font-normal"> · {(info.size / 1024 / 1024).toFixed(0)} MB</span>}
                </div>
                {info.notes && <pre className="whitespace-pre-wrap font-sans text-slate-300 max-h-40 overflow-auto">{info.notes}</pre>}
                <div className="flex gap-2 flex-wrap">
                  {info.canInstall ? (
                    <button onClick={install} disabled={!!busy || installing} className={`${btn} bg-emerald-600 hover:bg-emerald-500 text-white`} data-update-install>
                      {busy === 'install' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                      {busy === 'install' ? t('about.downloading') : t('about.install')}
                    </button>
                  ) : (
                    <span className="text-slate-400">{status?.installed ? t('about.noInstaller') : t('about.portableHint')}</span>
                  )}
                  <a href={info.page} target="_blank" rel="noreferrer" className={`${btn} bg-slate-700 hover:bg-slate-600 text-white`}>
                    <ExternalLink className="w-3.5 h-3.5" /> {t('about.releasePage')}
                  </a>
                </div>
                {installing && <div className="text-amber-200" data-update-installing>{t('about.installing')}</div>}
              </div>
            )}
          </section>
          )}
        </div>
      </div>
    </div>
  );
};

/** "Report a problem": a report without secrets to copy, save or attach to a GitHub issue. */
const ReportSection: React.FC<{ repo: string }> = ({ repo }) => {
  const { t, lang } = useI18n();
  const [description, setDescription] = useState('');
  const [report, setReport] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const build = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/logs/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, ui: { language: lang, screen: `${screen.width}x${screen.height}`, userAgent: navigator.userAgent } }),
      });
      setReport((await res.json()).report || '');
      setCopied(false);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(report);
    setCopied(true);
  };

  const save = () => {
    const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scriptcraft-report-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // The issue gets the description and system info; the full report is attached by the user (URLs are short)
  const issueUrl = () => {
    const system = report.split('## ')[2] || '';
    const body = `${description.trim()}\n\n## ${system.trim()}\n\n${t('report.attachHint')}`;
    const title = description.trim().split('\n')[0].slice(0, 80) || 'Problem';
    return `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body.slice(0, 6000))}`;
  };

  const btn = 'flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold disabled:opacity-40';
  return (
    <section className="space-y-2" data-report>
      <p className="text-slate-400">{t('report.intro')}</p>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t('report.placeholder')}
        rows={4}
        className="w-full px-2 py-1.5 rounded bg-panel border border-slate-700 text-xs text-fg outline-none focus:border-indigo-500 resize-y"
        data-report-description
      />
      <div className="flex gap-2 flex-wrap">
        <button onClick={build} disabled={busy} className={`${btn} bg-indigo-600 hover:bg-indigo-500 text-white`} data-report-build>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquareWarning className="w-3.5 h-3.5" />}
          {t('report.build')}
        </button>
        <button onClick={() => fetch('/api/logs/open-folder', { method: 'POST' })} className={`${btn} bg-slate-700 hover:bg-slate-600 text-white`}>
          <FolderOpen className="w-3.5 h-3.5" /> {t('report.openLogs')}
        </button>
      </div>
      {report && (
        <>
          <div className="text-slate-500">{t('report.checked')}</div>
          <textarea readOnly value={report} rows={10} className="w-full px-2 py-1.5 rounded bg-canvas border border-slate-800 font-mono text-[11px] text-slate-300" data-report-text />
          <div className="flex gap-2 flex-wrap">
            <button onClick={copy} className={`${btn} bg-slate-700 hover:bg-slate-600 text-white`} data-report-copy>
              <Copy className="w-3.5 h-3.5" /> {copied ? t('report.copied') : t('report.copy')}
            </button>
            <button onClick={save} className={`${btn} bg-slate-700 hover:bg-slate-600 text-white`}>
              <Save className="w-3.5 h-3.5" /> {t('report.save')}
            </button>
            {repo && (
              <a href={issueUrl()} target="_blank" rel="noreferrer" className={`${btn} bg-slate-700 hover:bg-slate-600 text-white`} data-report-issue>
                <ExternalLink className="w-3.5 h-3.5" /> {t('report.issue')}
              </a>
            )}
          </div>
        </>
      )}
    </section>
  );
};

/** The help text (public/help/<lang>.md) with a table of contents. */
const HelpSection: React.FC<{ onShowTour?: () => void }> = ({ onShowTour }) => {
  const { t, lang } = useI18n();
  const [text, setText] = useState('');
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fetch(`/help/${lang === 'en' ? 'en' : 'ru'}.md`)
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then(setText)
      .catch(() => setText(t('help.missing')));
  }, [lang]);
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  const jump = (h: string) => {
    const el = [...(body.current?.querySelectorAll('h2') || [])].find((x) => x.textContent?.trim() === h);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <div className="flex gap-4 flex-1 min-h-0" data-help>
      <nav className="w-48 shrink-0 overflow-auto space-y-0.5 border-r border-slate-800 pr-2">
        {headings.map((h) => (
          <button key={h} onClick={() => jump(h)} className="block w-full text-left px-2 py-1 rounded text-slate-300 hover:bg-slate-800 hover:text-fg" data-help-link>
            {h}
          </button>
        ))}
        {onShowTour && (
          <button onClick={onShowTour} className="block w-full text-left px-2 py-1 mt-2 rounded text-indigo-300 hover:bg-slate-800" data-help-tour>
            {t('help.tour')}
          </button>
        )}
      </nav>
      <div ref={body} className="flex-1 min-w-0 overflow-auto pr-2 text-sm">
        <Suspense fallback={<Loader2 className="w-4 h-4 animate-spin text-slate-500" />}>{text && <MarkdownPreview content={text} />}</Suspense>
      </div>
    </div>
  );
};
