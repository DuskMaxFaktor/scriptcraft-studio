import React, { useEffect, useState } from 'react';
import { X, SlidersHorizontal, Plus, Trash2, Eye, EyeOff, Loader2, Check } from 'lucide-react';
import { useI18n } from '../i18n.ts';

// "Run parameters": environment variables (stored in the project's .env, hidden from the explorer and the AI)
// and command-line arguments, used by runs, the debugger, tests and the project's terminals.

interface Props {
  isOpen: boolean;
  onClose: () => void;
  projectId: string | null;
  onSaved?: (summary: { vars: number; args: string }) => void;
}

interface Row {
  key: string;
  value: string;
  /** undefined: hidden automatically when the name looks like a secret */
  shown?: boolean;
}

const SECRET = /TOKEN|KEY|SECRET|PASS|PWD|AUTH|CREDENTIAL/i;

export const RunConfigModal: React.FC<Props> = ({ isOpen, onClose, projectId, onSaved }) => {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [args, setArgs] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = projectId ? `/api/projects/${encodeURIComponent(projectId)}/run-config` : '';

  useEffect(() => {
    if (!isOpen || !base) return;
    setRows(null);
    setError(null);
    setSaved(false);
    fetch(base)
      .then((r) => r.json())
      .then((d) => {
        setArgs(d.args || '');
        const list: Row[] = (d.env || []).map((v: { key: string; value: string }) => ({ ...v }));
        setRows(list.length ? list : [{ key: '', value: '' }]);
      })
      .catch((e) => setError(e.message));
  }, [isOpen, base]);

  if (!isOpen) return null;

  const update = (i: number, patch: Partial<Row>) => setRows((r) => r!.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args, env: (rows || []).map(({ key, value }) => ({ key: key.trim(), value })) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSaved(true);
      onSaved?.({ vars: data.env.length, args: data.args });
      setTimeout(onClose, 500);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const field = 'bg-deep border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-fg placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono';
  const exampleKey = rows?.find((r) => r.key.trim())?.key.trim() || 'BOT_TOKEN';

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4" onMouseDown={onClose}>
      <div className="bg-raised border border-slate-700/80 rounded-xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]" onMouseDown={(e) => e.stopPropagation()} data-run-config>
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-modal">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
              <SlidersHorizontal className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-fg">{t('runcfg.title')}</h2>
              <p className="text-xs text-slate-400">{t('runcfg.subtitle')}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-fg rounded-lg hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto text-xs">
          {!rows ? (
            <Loader2 className="w-4 h-4 animate-spin text-slate-500" />
          ) : (
            <>
              <div className="space-y-1.5">
                <div className="font-semibold text-slate-300">{t('runcfg.env')}</div>
                {rows.map((row, i) => {
                  const shown = row.shown ?? !SECRET.test(row.key);
                  return (
                  <div key={i} className="flex items-center gap-1.5" data-env-row={i}>
                    <input
                      value={row.key}
                      onChange={(e) => update(i, { key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
                      placeholder="BOT_TOKEN"
                      className={`${field} w-40`}
                      spellCheck={false}
                    />
                    <span className="text-slate-500">=</span>
                    <input
                      type={shown ? 'text' : 'password'}
                      value={row.value}
                      onChange={(e) => update(i, { value: e.target.value })}
                      placeholder={t('runcfg.value')}
                      className={`${field} flex-1 min-w-0`}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <button onClick={() => update(i, { shown: !shown })} className="p-1 text-slate-400 hover:text-fg" title={shown ? t('runcfg.hide') : t('runcfg.show')}>
                      {shown ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                    <button onClick={() => setRows(rows.filter((_, j) => j !== i))} className="p-1 text-slate-500 hover:text-rose-400" title={t('runcfg.remove')}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  );
                })}
                <button onClick={() => setRows([...rows, { key: '', value: '' }])} className="flex items-center gap-1 text-indigo-400 hover:underline">
                  <Plus className="w-3.5 h-3.5" /> {t('runcfg.add')}
                </button>
                <p className="text-[11px] text-slate-500 leading-relaxed">{t('runcfg.envHint')}</p>
                <pre className="p-2 rounded bg-canvas border border-slate-800 text-[11px] text-slate-400 font-mono">
                  {`# Python\nimport os\ntoken = os.environ["${exampleKey}"]\n\n// JavaScript\nconst token = process.env.${exampleKey};`}
                </pre>
              </div>

              <div className="space-y-1.5">
                <div className="font-semibold text-slate-300">{t('runcfg.args')}</div>
                <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder={'--name "Ann Lee" -v'} className={`${field} w-full`} spellCheck={false} data-run-args />
                <p className="text-[11px] text-slate-500">{t('runcfg.argsHint')}</p>
              </div>
            </>
          )}

          {error && <div className="p-2 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300">{error}</div>}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg bg-panel hover:bg-hover border border-slate-700 text-slate-200">
              {t('runcfg.cancel')}
            </button>
            <button onClick={save} disabled={saving || !rows} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <Check className="w-3.5 h-3.5" /> : null}
              {saved ? t('runcfg.saved') : t('runcfg.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
