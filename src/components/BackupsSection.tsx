import React, { useEffect, useState } from 'react';
import { Archive, ChevronDown, ChevronRight, FolderOpen, Loader2, RotateCcw, Save } from 'lucide-react';
import { useI18n } from '../i18n.ts';

// "Backups" section of the Projects dialog: daily zips of all projects, restore a project from any of them.

interface BackupInfo {
  enabled: boolean;
  keep: number;
  dir: string;
  customDir: boolean;
  running: boolean;
  backups: { file: string; size: number; createdAt: number }[];
}

async function call<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

export const BackupsSection: React.FC<{ onRestored: (name: string) => void; formatDate: (ms: number) => string }> = ({ onRestored, formatDate }) => {
  const { t } = useI18n();
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirInput, setDirInput] = useState('');
  const [inside, setInside] = useState<Record<string, { id: string; name: string }[] | 'loading'>>({});

  const load = async () => {
    try {
      const i = await call<BackupInfo>('/api/backups');
      setInfo(i);
      setDirInput(i.customDir ? i.dir : '');
    } catch (e: any) {
      setError(e.message);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = (patch: Partial<{ enabled: boolean; keep: number; dir: string }>) =>
    act('settings', async () => {
      await call('/api/backups/settings', 'PUT', patch);
      await load();
    });

  const toggleBackup = async (file: string) => {
    if (inside[file]) {
      const next = { ...inside };
      delete next[file];
      setInside(next);
      return;
    }
    setInside((x) => ({ ...x, [file]: 'loading' }));
    try {
      const r = await call<{ projects: { id: string; name: string }[] }>(`/api/backups/${encodeURIComponent(file)}/projects`);
      setInside((x) => ({ ...x, [file]: r.projects }));
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (!info) return null;
  const last = info.backups[0];
  const size = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

  return (
    <div data-backups>
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-xs font-semibold text-slate-400 uppercase tracking-wider hover:text-slate-200">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <Archive className="w-3.5 h-3.5" />
          {t('backups.title')}
        </button>
        <span className="text-[11px] text-slate-500 truncate" data-backups-last>
          {last ? t('backups.last', { date: formatDate(last.createdAt) }) + (info.enabled ? '' : ` · ${t('backups.off')}`) : info.enabled ? t('backups.none') : t('backups.off')}
        </span>
      </div>

      {open && (
        <div className="mt-2 space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => act('now', async () => { await call('/api/backups/now', 'POST'); await load(); })}
              disabled={!!busy}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold"
            >
              {busy === 'now' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
              {t('backups.now')}
            </button>
            <button onClick={() => call('/api/backups/open-folder', 'POST').catch((e) => setError(e.message))} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-panel hover:bg-hover border border-slate-700 text-slate-200">
              <FolderOpen className="w-3.5 h-3.5 text-amber-300" /> {t('backups.openFolder')}
            </button>
            <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer ml-auto">
              <input type="checkbox" checked={info.enabled} onChange={(e) => saveSettings({ enabled: e.target.checked })} />
              {t('backups.daily')}
            </label>
            <label className="flex items-center gap-1.5 text-slate-400">
              {t('backups.keep')}
              <select value={info.keep} onChange={(e) => saveSettings({ keep: Number(e.target.value) })} className="bg-deep border border-slate-700 rounded px-1.5 py-1 text-fg">
                {[3, 7, 14, 30].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex gap-2">
            <input
              value={dirInput}
              onChange={(e) => setDirInput(e.target.value)}
              placeholder={info.customDir ? '' : info.dir}
              className="flex-1 min-w-0 bg-deep border border-slate-700 rounded-lg px-2.5 py-1.5 text-fg placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono text-[11px]"
              title={t('backups.dirHint')}
            />
            <button onClick={() => saveSettings({ dir: dirInput.trim() })} disabled={!!busy} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white disabled:opacity-40">
              <Save className="w-3.5 h-3.5" /> {t('backups.saveDir')}
            </button>
          </div>
          <p className="text-[11px] text-slate-500">{t('backups.hint')}</p>

          {info.backups.map((b) => {
            const list = inside[b.file];
            return (
              <div key={b.file} className="rounded-lg bg-deep border border-slate-800" data-backup={b.file}>
                <button onClick={() => toggleBackup(b.file)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-800/50 rounded-lg">
                  {list ? <ChevronDown className="w-3 h-3 text-slate-500" /> : <ChevronRight className="w-3 h-3 text-slate-500" />}
                  <span className="text-slate-300">{formatDate(b.createdAt)}</span>
                  <span className="ml-auto text-[11px] text-slate-500">{size(b.size)}</span>
                </button>
                {list === 'loading' && <Loader2 className="w-3 h-3 animate-spin text-slate-500 mx-3 mb-2" />}
                {Array.isArray(list) && (
                  <div className="px-3 pb-2 space-y-1">
                    {list.map((p) => (
                      <div key={p.id} className="flex items-center gap-2" data-backup-project={p.name}>
                        <span className="text-slate-400 truncate flex-1">{p.name}</span>
                        <button
                          onClick={() =>
                            act(`${b.file}:${p.id}`, async () => {
                              const r = await call<{ name: string }>(`/api/backups/${encodeURIComponent(b.file)}/restore`, 'POST', { id: p.id });
                              onRestored(r.name);
                            })
                          }
                          disabled={!!busy}
                          className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-[11px] font-semibold"
                        >
                          {busy === `${b.file}:${p.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                          {t('backups.restore')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {error && <div className="p-2 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 whitespace-pre-wrap">{error}</div>}
        </div>
      )}
    </div>
  );
};
