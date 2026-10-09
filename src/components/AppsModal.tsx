import React, { useEffect, useMemo, useState } from 'react';
import { AppWindow, X, Search, RefreshCw, Wrench, FolderOpen, Loader2, TriangleAlert, CircleCheck, ArrowUpCircle, Power } from 'lucide-react';
import { useI18n } from '../i18n.ts';

// "Programs on this PC": installed applications (as in Windows "Programs and Features"),
// with a health check and the program's own repair. Nothing changes without the user's click.

interface InstalledApp {
  id: string;
  name: string;
  version: string;
  publisher: string;
  installDate: string | null;
  sizeMB: number | null;
  location: string | null;
  scope: 'machine' | 'user';
  msi: boolean;
  repair: 'msi' | 'modify' | null;
  problems: ('folder-missing' | 'exe-missing' | 'uninstaller-missing')[];
}

type SortKey = 'name' | 'size' | 'date';

interface StartupItem {
  id: string;
  name: string;
  command: string;
  scope: 'user' | 'machine';
  kind: 'Run' | 'Run32' | 'StartupFolder';
  enabled: boolean;
  problems: 'target-missing'[];
}

interface WingetUpdate {
  name: string;
  id: string;
  version: string;
  available: string;
  source: string;
}

/** Does a winget row describe this installed program? (winget may shorten long names with "…") */
const sameProgram = (app: string, upd: string) => {
  const a = app.toLowerCase().trim();
  const u = upd.toLowerCase().replace(/…$/, '').trim();
  return a === u || (u.length >= 6 && a.startsWith(u)) || (a.length >= 6 && u.startsWith(a));
};

/** Read a run session's output until it exits. */
async function readRun(runId: string, onText: (t: string) => void): Promise<number | null> {
  const res = await fetch(`/api/run/${runId}/events`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return null;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(i + 2);
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === 'exit') {
        reader.cancel().catch(() => {});
        return ev.code;
      }
      if (typeof ev.data === 'string') onText(ev.data);
    }
  }
}

const fmtSize = (mb: number | null) => (mb === null ? '' : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

export const AppsModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const { t } = useI18n();
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [sort, setSort] = useState<SortKey>('name');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  // winget updates: null = not loaded yet
  const [updates, setUpdates] = useState<WingetUpdate[] | null>(null);
  const [wingetOk, setWingetOk] = useState(true);
  const [onlyUpdates, setOnlyUpdates] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [updateLog, setUpdateLog] = useState('');

  // Startup programs
  const [tab, setTab] = useState<'installed' | 'startup'>('installed');
  const [startup, setStartup] = useState<StartupItem[] | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const loadStartup = async () => {
    try {
      const res = await fetch('/api/apps/startup');
      const data = await res.json();
      setStartup(data.items || []);
    } catch {
      setStartup([]);
    }
  };

  const toggleStartup = async (item: StartupItem) => {
    setToggling(item.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/apps/startup/${item.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !item.enabled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(res.status === 403 ? t('apps.startupNeedsAdmin') : data.error || `HTTP ${res.status}`);
      setNotice({ ok: true, text: t(item.enabled ? 'apps.startupOff' : 'apps.startupOn', { name: item.name }) });
      await loadStartup();
    } catch (e: any) {
      setNotice({ ok: false, text: e.message });
    } finally {
      setToggling(null);
    }
  };

  const loadUpdates = async () => {
    setUpdates(null);
    try {
      const res = await fetch('/api/apps/updates');
      const data = await res.json();
      setWingetOk(data.available !== false);
      setUpdates(data.updates || []);
    } catch {
      setUpdates([]);
    }
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/apps');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSupported(data.supported !== false);
      setApps(data.apps || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setNotice(null);
      void load();
      void loadUpdates(); // slower (winget): loads alongside
      void loadStartup();
    }
  }, [isOpen]);

  const problemCount = apps.filter((a) => a.problems.length).length;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = apps.filter(
      (a) => (!onlyProblems || a.problems.length) && (!q || a.name.toLowerCase().includes(q) || a.publisher.toLowerCase().includes(q) || a.version.toLowerCase().includes(q))
    );
    if (sort === 'size') list.sort((a, b) => (b.sizeMB ?? -1) - (a.sizeMB ?? -1));
    else if (sort === 'date') list.sort((a, b) => (b.installDate || '').localeCompare(a.installDate || ''));
    return list;
  }, [apps, query, onlyProblems, sort]);

  const post = async (app: InstalledApp, action: 'repair' | 'open-folder') => {
    setBusyId(app.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/apps/${app.id}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (action === 'repair') setNotice({ ok: true, text: t('apps.repairStarted', { name: app.name }) });
    } catch (e: any) {
      setNotice({ ok: false, text: e.message });
    } finally {
      setBusyId(null);
    }
  };

  const updateFor = (app: InstalledApp) => updates?.find((u) => sameProgram(app.name, u.name)) || null;

  const installUpdate = async (u: WingetUpdate) => {
    if (!confirm(t('apps.confirmUpdate', { name: u.name, from: u.version, to: u.available }))) return;
    setUpdating(u.id);
    setNotice(null);
    setUpdateLog('');
    try {
      const res = await fetch(`/api/apps/updates/${encodeURIComponent(u.id)}/install`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.dryRun) {
        setNotice({ ok: true, text: `${data.command.exe} ${data.command.args.join(' ')}` });
        return;
      }
      const code = await readRun(data.runId, (chunk) => setUpdateLog((l) => (l + chunk).slice(-20000)));
      setNotice(code === 0 ? { ok: true, text: t('apps.updated', { name: u.name, version: u.available }) } : { ok: false, text: t('apps.updateFailed', { name: u.name }) });
      void load();
      void loadUpdates();
    } catch (e: any) {
      setNotice({ ok: false, text: e.message });
    } finally {
      setUpdating(null);
    }
  };

  const repair = (app: InstalledApp) => {
    const how = app.repair === 'msi' ? t('apps.howMsi') : t('apps.howModify');
    if (!confirm(t('apps.confirmRepair', { name: app.name, how }))) return;
    void post(app, 'repair');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onMouseDown={onClose}>
      <div className="bg-raised border border-slate-700 rounded-xl w-full max-w-4xl h-[85vh] flex flex-col shadow-2xl overflow-hidden" onMouseDown={(e) => e.stopPropagation()} data-apps-modal>
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between bg-modal shrink-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <AppWindow className="w-4 h-4 text-indigo-400" />
            {t('apps.title')}
            {!loading && supported && <span className="text-slate-500 font-normal">({apps.length})</span>}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                void load();
                void loadUpdates();
                void loadStartup();
              }}
              disabled={loading} className="p-1.5 text-slate-400 hover:text-fg rounded-lg hover:bg-slate-800 disabled:opacity-40" title={t('apps.refresh')}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-fg rounded-lg hover:bg-slate-800">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-5 pt-2 flex gap-1 text-xs shrink-0 border-b border-slate-800">
          {(
            [
              ['installed', t('apps.tabInstalled', { count: loading && apps.length === 0 ? '…' : apps.length })],
              ['startup', t('apps.tabStartup', { count: startup === null ? '…' : startup.length })],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              data-apps-tab={id}
              className={`px-3 py-1.5 border-b-2 -mb-px ${tab === id ? 'border-indigo-500 text-fg' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="px-5 py-2 border-b border-slate-800 flex flex-wrap items-center gap-2 text-xs shrink-0">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tab === 'startup' ? t('apps.searchStartup') : t('apps.search')}
              data-apps-search
              className="w-full bg-deep border border-slate-700 rounded pl-7 pr-2 py-1.5 text-slate-200 focus:outline-none focus:border-indigo-500"
            />
          </div>
          {tab === 'installed' && (<>
          <button
            onClick={() => setOnlyProblems((v) => !v)}
            data-apps-problems
            className={`flex items-center gap-1 px-2 py-1.5 rounded border ${onlyProblems ? 'border-amber-500/60 text-amber-300 bg-amber-500/10' : 'border-slate-700 text-slate-300 hover:bg-hover'}`}
          >
            <TriangleAlert className="w-3.5 h-3.5" /> {t('apps.onlyProblems', { count: problemCount })}
          </button>
          {wingetOk && (
            <button
              onClick={() => setOnlyUpdates((v) => !v)}
              disabled={updates === null}
              data-apps-updates
              className={`flex items-center gap-1 px-2 py-1.5 rounded border ${onlyUpdates ? 'border-emerald-500/60 text-emerald-300 bg-emerald-500/10' : 'border-slate-700 text-slate-300 hover:bg-hover'} disabled:opacity-60`}
              title={t('apps.updatesTitle')}
            >
              {updates === null ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpCircle className="w-3.5 h-3.5" />}
              {updates === null ? t('apps.updatesChecking') : t('apps.updatesCount', { count: updates.length })}
            </button>
          )}
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="bg-deep border border-slate-700 rounded px-2 py-1.5 text-slate-200 focus:outline-none">
            <option value="name">{t('apps.sortName')}</option>
            <option value="size">{t('apps.sortSize')}</option>
            <option value="date">{t('apps.sortDate')}</option>
          </select>
          </>)}
        </div>

        {notice && (
          <div className={`mx-5 mt-2 px-3 py-2 rounded text-xs ${notice.ok ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30' : 'bg-rose-500/10 text-rose-300 border border-rose-500/30'}`} data-apps-notice>
            {notice.text}
          </div>
        )}

        {updateLog && (
          <pre className="mx-5 mt-2 max-h-32 overflow-auto text-[10px] font-mono text-slate-400 bg-deep border border-slate-800 rounded p-2 whitespace-pre-wrap" data-apps-update-log>
            {updateLog}
          </pre>
        )}

        <div className="flex-1 min-h-0 overflow-auto px-5 py-2">
          {tab === 'startup' && (
            <div className="divide-y divide-slate-800/70" data-startup-list>
              {startup === null && (
                <div className="flex items-center gap-2 text-xs text-slate-400 py-6 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" /> {t('apps.loading')}
                </div>
              )}
              {startup?.length === 0 && <p className="text-slate-500 text-xs py-6 text-center">{t('apps.startupNone')}</p>}
              {startup
                ?.filter((i) => !query.trim() || `${i.name} ${i.command}`.toLowerCase().includes(query.trim().toLowerCase()))
                .map((i) => (
                  <div key={i.id} className="py-2 flex items-start gap-3 text-xs" data-startup-row={i.name}>
                    <Power className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${i.enabled ? 'text-emerald-400' : 'text-slate-600'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`font-medium truncate ${i.enabled ? 'text-fg' : 'text-slate-500'}`}>{i.name}</span>
                        <span className="text-[10px] px-1 rounded bg-slate-800 text-slate-400 shrink-0">{i.scope === 'user' ? t('apps.userScope') : t('apps.allUsers')}</span>
                        {i.kind === 'StartupFolder' && <span className="text-[10px] px-1 rounded bg-slate-800 text-slate-400 shrink-0">{t('apps.startupFolder')}</span>}
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500 font-mono truncate" title={i.command}>
                        {i.command}
                      </div>
                      {i.problems.length > 0 && (
                        <div className="mt-1 flex gap-1" data-startup-problems>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300" title={t('apps.targetMissingHint')}>
                            {t('apps.problem.target-missing')}
                          </span>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => void toggleStartup(i)}
                      disabled={toggling === i.id}
                      data-startup-toggle
                      className={`shrink-0 w-20 flex items-center justify-center gap-1 px-2 py-1.5 rounded border disabled:opacity-40 ${
                        i.enabled ? 'border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/10' : 'border-slate-700 text-slate-400 hover:bg-hover'
                      }`}
                      title={i.enabled ? t('apps.startupDisableTitle') : t('apps.startupEnableTitle')}
                    >
                      {toggling === i.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : i.enabled ? t('apps.on') : t('apps.off')}
                    </button>
                  </div>
                ))}
            </div>
          )}
          {tab === 'installed' && (<>
          {loading && apps.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-slate-400 py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> {t('apps.loading')}
            </div>
          )}
          {error && <p className="text-rose-300 text-xs py-4">{error}</p>}
          {!supported && <p className="text-slate-400 text-xs py-6 text-center">{t('apps.unsupported')}</p>}
          {!loading && supported && !error && shown.length === 0 && <p className="text-slate-500 text-xs py-6 text-center">{t('apps.none')}</p>}

          {onlyUpdates && updates && (
            <div className="divide-y divide-slate-800/70" data-apps-update-list>
              {updates.length === 0 && <p className="text-slate-500 text-xs py-6 text-center">{t('apps.noUpdates')}</p>}
              {updates.map((u) => (
                <div key={u.id} className="py-2 flex items-center gap-3 text-xs" data-update-row={u.id}>
                  <ArrowUpCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-fg truncate">{u.name}</div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {u.version} → <span className="text-emerald-300">{u.available}</span> · {u.id}
                    </div>
                  </div>
                  <button
                    onClick={() => void installUpdate(u)}
                    disabled={!!updating}
                    data-update-install
                    className="flex items-center gap-1 px-2 py-1.5 rounded border border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40 shrink-0"
                  >
                    {updating === u.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpCircle className="w-3.5 h-3.5" />} {t('apps.update')}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className={`divide-y divide-slate-800/70 ${onlyUpdates ? 'hidden' : ''}`}>
            {shown.map((a) => (
              <div key={a.id} className="py-2 flex items-start gap-3 text-xs" data-app-row={a.name}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    {a.problems.length ? <TriangleAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" /> : <CircleCheck className="w-3.5 h-3.5 text-emerald-500/70 shrink-0" />}
                    <span className="font-medium text-fg truncate" title={a.name}>
                      {a.name}
                    </span>
                    {a.version && <span className="text-slate-500 font-mono shrink-0">{a.version}</span>}
                    {a.scope === 'user' && <span className="text-[10px] px-1 rounded bg-slate-800 text-slate-400 shrink-0">{t('apps.userScope')}</span>}
                    {updateFor(a) && (
                      <span className="text-[10px] px-1.5 rounded bg-emerald-500/15 text-emerald-300 shrink-0 font-mono" title={t('apps.updatesTitle')}>
                        → {updateFor(a)!.available}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 pl-5 text-[11px] text-slate-500 flex flex-wrap gap-x-3">
                    {a.publisher && <span>{a.publisher}</span>}
                    {a.sizeMB !== null && <span>{fmtSize(a.sizeMB)}</span>}
                    {a.installDate && <span>{t('apps.installed', { date: a.installDate })}</span>}
                    {a.location && (
                      <span className="font-mono truncate max-w-[340px]" title={a.location}>
                        {a.location}
                      </span>
                    )}
                  </div>
                  {a.problems.length > 0 && (
                    <div className="mt-1 pl-5 flex flex-wrap gap-1" data-app-problems>
                      {a.problems.map((p) => (
                        <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300">
                          {t('apps.problem.' + p)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {a.location && !a.problems.includes('folder-missing') && (
                    <button onClick={() => void post(a, 'open-folder')} className="p-1.5 rounded border border-slate-700 text-slate-300 hover:bg-hover" title={t('apps.openFolder')}>
                      <FolderOpen className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {a.repair ? (
                    <button
                      onClick={() => repair(a)}
                      disabled={busyId === a.id}
                      data-app-repair
                      className="flex items-center gap-1 px-2 py-1.5 rounded border border-indigo-500/50 text-indigo-300 hover:bg-indigo-500/10 disabled:opacity-40"
                      title={a.repair === 'msi' ? t('apps.howMsi') : t('apps.howModify')}
                    >
                      {busyId === a.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />} {t('apps.repair')}
                    </button>
                  ) : (
                    <span className="text-[10px] text-slate-600 px-1" title={t('apps.noRepairHint')}>
                      {t('apps.noRepair')}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          </>)}
        </div>
        <div className="px-5 py-2 border-t border-slate-800 text-[11px] text-slate-500 shrink-0">{tab === 'startup' ? t('apps.startupFooter') : t('apps.footer')}</div>
      </div>
    </div>
  );
};
