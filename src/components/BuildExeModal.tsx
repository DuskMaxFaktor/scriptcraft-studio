import React, { useEffect, useRef, useState } from 'react';
import { X, Package, Loader2, Download, FolderOpen, Hammer, CheckCircle2, XCircle } from 'lucide-react';
import { FileItem } from '../types.ts';
import { useI18n } from '../i18n.ts';
import { renderAnsi } from '../utils/ansi.tsx';

// "Build .exe": the chosen Python file (and the project's modules and data files) becomes one program
// in the project's dist folder, built with PyInstaller.

interface Build {
  name: string;
  path: string;
  size: number;
  mtime: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  projectId: string | null;
  files: FileItem[];
  /** Save editor changes before PyInstaller reads the files */
  onBeforeBuild: () => Promise<void>;
}

async function readSession(runId: string, onText: (t: string) => void): Promise<number | null> {
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

const sizeText = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

export const BuildExeModal: React.FC<Props> = ({ isOpen, onClose, projectId, files, onBeforeBuild }) => {
  const { t } = useI18n();
  const pyFiles = files.filter((f) => /\.pyw?$/i.test(f.name));
  const [entry, setEntry] = useState('');
  const [name, setName] = useState('');
  const [windowed, setWindowed] = useState(false);
  const [includeData, setIncludeData] = useState(true);
  const [info, setInfo] = useState<{ pyinstaller: boolean; version: string | null; builds: Build[] } | null>(null);
  const [busy, setBusy] = useState<'install' | 'build' | null>(null);
  const [output, setOutput] = useState('');
  const [result, setResult] = useState<'ok' | 'fail' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const outRef = useRef<HTMLPreElement>(null);
  const base = projectId ? `/api/projects/${encodeURIComponent(projectId)}/exe` : '';

  const load = async () => {
    if (!base) return;
    try {
      setInfo(await (await fetch(base)).json());
    } catch {
      // server restarting
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    load();
    setResult(null);
    setError(null);
    const main = pyFiles.find((f) => f.isEntry) || pyFiles[0];
    setEntry(main?.name || '');
    setName(main ? main.name.split('/').pop()!.replace(/\.pyw?$/i, '') : '');
    // Games and window programs usually import a GUI library: no console window for them by default
    setWindowed(!!main && /import\s+(pygame|tkinter|PyQt\d|PySide\d|customtkinter|kivy|arcade|pyglet)|from\s+(tkinter|PyQt\d|PySide\d)\b/.test(main.content));
  }, [isOpen, projectId]);

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [output]);

  if (!isOpen) return null;

  const install = async () => {
    setBusy('install');
    setError(null);
    setOutput('');
    try {
      const res = await fetch(`${base}/install`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const code = await readSession(data.runId, (s) => setOutput((o) => o + s));
      if (code !== 0) throw new Error(t('exe.installFailed'));
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const build = async () => {
    setBusy('build');
    setError(null);
    setResult(null);
    setOutput('');
    try {
      await onBeforeBuild();
      const res = await fetch(`${base}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry, name: name.trim(), windowed, includeData }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const code = await readSession(data.runId, (s) => setOutput((o) => (o + s).slice(-300_000)));
      setResult(code === 0 ? 'ok' : 'fail');
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const reveal = (b: Build) => fetch(`${base}/reveal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: b.path }) });
  const field = 'w-full bg-deep border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-fg focus:outline-none focus:border-indigo-500';

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4" onMouseDown={() => !busy && onClose()}>
      <div className="bg-raised border border-slate-700/80 rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]" onMouseDown={(e) => e.stopPropagation()} data-build-exe>
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-modal">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
              <Package className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-fg">{t('exe.title')}</h2>
              <p className="text-xs text-slate-400">{t('exe.subtitle')}</p>
            </div>
          </div>
          <button onClick={onClose} disabled={!!busy} className="p-1.5 text-slate-400 hover:text-fg rounded-lg hover:bg-slate-800 disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto text-xs">
          {!info ? (
            <Loader2 className="w-4 h-4 animate-spin text-slate-500" />
          ) : pyFiles.length === 0 ? (
            <p className="text-slate-400">{t('exe.noPython')}</p>
          ) : !info.pyinstaller ? (
            <div className="space-y-2">
              <p className="text-slate-400 leading-relaxed">{t('exe.needPyinstaller')}</p>
              <button onClick={install} disabled={!!busy} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold">
                {busy === 'install' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                {busy === 'install' ? t('exe.installing') : t('exe.install')}
              </button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-slate-400">{t('exe.entry')}</span>
                  <select value={entry} onChange={(e) => setEntry(e.target.value)} className={field} disabled={!!busy}>
                    {pyFiles.map((f) => (
                      <option key={f.id} value={f.name}>
                        {f.name}
                        {f.isEntry ? ' ★' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">{t('exe.name')}</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} className={field} disabled={!!busy} maxLength={60} />
                </label>
              </div>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="checkbox" checked={windowed} onChange={(e) => setWindowed(e.target.checked)} disabled={!!busy} className="mt-0.5" />
                <span>
                  <span className="text-fg">{t('exe.windowed')}</span>
                  <span className="block text-slate-500">{t('exe.windowedHint')}</span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="checkbox" checked={includeData} onChange={(e) => setIncludeData(e.target.checked)} disabled={!!busy} className="mt-0.5" />
                <span>
                  <span className="text-fg">{t('exe.includeData')}</span>
                  <span className="block text-slate-500">{t('exe.includeDataHint')}</span>
                </span>
              </label>
              <p className="text-slate-500">{t('exe.iconHint')}</p>
              <button
                onClick={build}
                disabled={!!busy || !entry || !name.trim()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold"
              >
                {busy === 'build' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Hammer className="w-3.5 h-3.5" />}
                {busy === 'build' ? t('exe.building') : t('exe.build')}
              </button>
            </>
          )}

          {result === 'ok' && (
            <div className="flex items-center gap-1.5 text-emerald-400" data-build-result="ok">
              <CheckCircle2 className="w-4 h-4" /> {t('exe.done')}
            </div>
          )}
          {result === 'fail' && (
            <div className="flex items-center gap-1.5 text-rose-400" data-build-result="fail">
              <XCircle className="w-4 h-4" /> {t('exe.failed')}
            </div>
          )}
          {error && <div className="p-2 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 whitespace-pre-wrap">{error}</div>}

          {(output || busy) && (
            <pre ref={outRef} className="p-2 rounded bg-canvas border border-slate-800 font-mono text-[11px] text-slate-400 whitespace-pre-wrap max-h-56 overflow-auto">
              {renderAnsi(output) || '…'}
            </pre>
          )}

          {info && info.builds.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">{t('exe.builds')}</div>
              {info.builds.map((b) => (
                <div key={b.path} className="flex items-center gap-2 px-2 py-1.5 rounded bg-deep border border-slate-800" data-build={b.name}>
                  <Package className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="font-mono text-fg truncate">{b.path}</span>
                  <span className="text-slate-500 shrink-0">{sizeText(b.size)}</span>
                  <button onClick={() => reveal(b)} className="ml-auto flex items-center gap-1 text-indigo-400 hover:underline shrink-0">
                    <FolderOpen className="w-3.5 h-3.5" /> {t('exe.reveal')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
