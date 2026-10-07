import React, { useEffect, useState } from 'react';
import { Github, Loader2, LogIn, RefreshCw, Lock, Globe, ExternalLink } from 'lucide-react';
import { useI18n } from '../i18n.ts';

// "Publish to GitHub" in the Git panel: the official GitHub CLI creates the repository and pushes the project.
// Sign-in happens in gh's own window (browser + one-time code); the studio never sees a token.

interface Props {
  projectId: string;
  /** Default repository name (the project folder name is already Latin) */
  defaultName: string;
  /** Save pending editor changes first */
  onBeforePublish: () => Promise<void>;
  onPublished: (url: string | null) => void;
}

interface GhInfo {
  installed: boolean;
  account: string | null;
}

export const GitHubPublish: React.FC<Props> = ({ projectId, defaultName, onBeforePublish, onPublished }) => {
  const { t } = useI18n();
  const base = `/api/git/${encodeURIComponent(projectId)}/github`;
  const [info, setInfo] = useState<GhInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitingLogin, setWaitingLogin] = useState(false);

  const load = async () => {
    try {
      setInfo(await (await fetch(base)).json());
    } catch {
      // server restarting
    }
  };
  useEffect(() => {
    setName(defaultName);
    load();
  }, [projectId]);
  // After "Sign in": check until gh reports the account
  useEffect(() => {
    if (!waitingLogin) return;
    const timer = setInterval(async () => {
      const d: GhInfo = await (await fetch(base)).json();
      setInfo(d);
      if (d.account) setWaitingLogin(false);
    }, 4000);
    return () => clearInterval(timer);
  }, [waitingLogin]);

  const publish = async () => {
    if (visibility === 'public' && !confirm(t('gh.confirmPublic', { name }))) return;
    setBusy(true);
    setError(null);
    try {
      await onBeforePublish();
      const res = await fetch(`${base}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), visibility, description }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setOpen(false);
      onPublished(data.url);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!info) return null;
  const field = 'w-full bg-canvas text-[11px] text-fg border border-slate-700 rounded px-2 py-1 focus:outline-none focus:border-indigo-500';

  return (
    <div className="space-y-1.5" data-github-publish>
      {!info.installed ? (
        <p className="px-1 text-[11px] text-slate-500 leading-snug">
          {t('gh.notInstalled')}{' '}
          <a href="https://cli.github.com" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
            cli.github.com
          </a>
        </p>
      ) : !info.account ? (
        <div className="space-y-1">
          <div className="flex gap-1">
            <button
              onClick={async () => {
                setError(null);
                const r = await fetch(`${base}/login`, { method: 'POST' });
                if (!r.ok) setError((await r.json()).error);
                else setWaitingLogin(true);
              }}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-white text-[11px] font-semibold"
            >
              <LogIn className="w-3 h-3" /> {t('gh.login')}
            </button>
            <button onClick={load} className="px-2 py-1.5 rounded bg-panel border border-slate-700 text-slate-300" title={t('gh.check')}>
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
          {waitingLogin && <p className="px-1 text-[10px] text-slate-500">{t('gh.loginHint')}</p>}
        </div>
      ) : !open ? (
        <button
          onClick={() => setOpen(true)}
          className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-600 text-white text-[11px] font-semibold"
          data-github-open
        >
          <Github className="w-3.5 h-3.5" /> {t('gh.publish')}
        </button>
      ) : (
        <div className="p-2 rounded border border-slate-700 bg-deep space-y-1.5 text-[11px]">
          <label className="block space-y-0.5">
            <span className="text-slate-400">{t('gh.name')}</span>
            <input value={name} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9._-]/g, '-'))} className={`${field} font-mono`} maxLength={100} data-github-name />
          </label>
          <div className="flex gap-3">
            <label className="flex items-center gap-1 cursor-pointer text-slate-300">
              <input type="radio" checked={visibility === 'private'} onChange={() => setVisibility('private')} />
              <Lock className="w-3 h-3" /> {t('gh.private')}
            </label>
            <label className="flex items-center gap-1 cursor-pointer text-slate-300">
              <input type="radio" checked={visibility === 'public'} onChange={() => setVisibility('public')} />
              <Globe className="w-3 h-3" /> {t('gh.public')}
            </label>
          </div>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('gh.description')} className={field} maxLength={350} />
          <p className="text-[10px] text-slate-500 leading-snug">{t('gh.hint')}</p>
          <div className="flex gap-1">
            <button
              onClick={publish}
              disabled={busy || !name.trim()}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold"
              data-github-submit
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Github className="w-3 h-3" />}
              {t('gh.publishAs', { account: info.account })}
            </button>
            <button onClick={() => setOpen(false)} disabled={busy} className="px-2 py-1.5 rounded bg-panel border border-slate-700 text-slate-300">
              {t('gh.cancel')}
            </button>
          </div>
        </div>
      )}
      {error && <div className="p-1.5 rounded border border-rose-500/40 bg-rose-500/10 text-[11px] text-rose-300 whitespace-pre-wrap">{error}</div>}
    </div>
  );
};

/** Link to the repository page (shown once the project is connected to GitHub). */
export const GitHubLink: React.FC<{ remote: string }> = ({ remote }) => {
  const { t } = useI18n();
  if (!/github\.com[/:]/i.test(remote)) return null;
  const url = remote.replace(/^git@github\.com:/i, 'https://github.com/').replace(/\.git$/, '');
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 px-1 text-[11px] text-indigo-400 hover:underline" data-github-link>
      <ExternalLink className="w-3 h-3" /> {t('gh.openRepo')}
    </a>
  );
};
