import React, { useEffect, useState } from 'react';
import { Cpu, X, Loader2, Check, ExternalLink, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n.ts';
import { useModels } from '../utils/models.ts';

interface Settings {
  gemini: { hasKey: boolean; keyMasked: string };
  ollama: { enabled: boolean; baseUrl: string; contextLength: number };
  completion: { enabled: boolean; model: string };
  custom: { enabled: boolean; name: string; baseUrl: string; hasKey: boolean; keyMasked: string; models: string[] };
}

export const AiSettingsModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const { t } = useI18n();
  const { models, status, refreshModels } = useModels();
  const [s, setS] = useState<Settings | null>(null);
  const [geminiKey, setGeminiKey] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [customModels, setCustomModels] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const data: Settings = await (await fetch('/api/settings')).json();
    setS(data);
    setCustomModels(data.custom.models.join(', '));
    await refreshModels();
  };

  useEffect(() => {
    if (isOpen) {
      setGeminiKey('');
      setCustomKey('');
      setSaved(false);
      setError(null);
      load().catch((e) => setError(String(e)));
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const save = async () => {
    if (!s) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gemini: geminiKey.trim() ? { apiKey: geminiKey.trim() } : undefined,
          ollama: s.ollama,
          completion: s.completion,
          custom: { ...s.custom, apiKey: customKey, models: customModels },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setGeminiKey('');
      setCustomKey('');
      await load();
      setSaved(true);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const ollamaModels = models.filter((m) => m.provider === 'ollama');
  const customList = models.filter((m) => m.provider === 'custom');
  const statusBadge = (st: string) =>
    st === 'ok' ? (
      <span className="text-emerald-400">● {t('ai.connected')}</span>
    ) : st === 'unreachable' ? (
      <span className="text-rose-400">● {t('ai.unreachable')}</span>
    ) : (
      <span className="text-slate-500">● {t('ai.off')}</span>
    );

  const field = 'w-full bg-deep border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-fg placeholder-slate-500 focus:outline-none focus:border-indigo-500';
  const section = 'p-3 rounded-lg border border-slate-800 bg-card space-y-2';

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="bg-raised border border-slate-700/80 rounded-xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-modal">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-fg">{t('ai.title')}</h2>
              <p className="text-xs text-slate-400">{t('ai.subtitle')}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-fg rounded-lg hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        {!s ? (
          <div className="p-8 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
          </div>
        ) : (
          <div className="p-5 space-y-3 overflow-y-auto text-xs">
            {/* Gemini */}
            <div className={section}>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-fg">Google Gemini</span>
                {s.gemini.hasKey ? (
                  <span className="text-emerald-400">● {t('ai.keySet', { key: s.gemini.keyMasked })}</span>
                ) : (
                  <span className="text-amber-400">● {t('ai.noKey')}</span>
                )}
              </div>
              <input
                type="password"
                value={geminiKey}
                onChange={(e) => setGeminiKey(e.target.value)}
                placeholder={s.gemini.hasKey ? t('ai.replaceKey') : t('ai.pasteKey')}
                className={field}
                autoComplete="off"
              />
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-indigo-400 hover:underline">
                {t('ai.getGeminiKey')} <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            {/* Ollama */}
            <div className={section}>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 font-semibold text-fg cursor-pointer">
                  <input
                    type="checkbox"
                    checked={s.ollama.enabled}
                    onChange={(e) => setS({ ...s, ollama: { ...s.ollama, enabled: e.target.checked } })}
                  />
                  Ollama · {t('ai.local')}
                </label>
                {statusBadge(status.ollama)}
              </div>
              <input
                value={s.ollama.baseUrl}
                onChange={(e) => setS({ ...s, ollama: { ...s.ollama, baseUrl: e.target.value } })}
                className={field}
              />
              <label className="flex items-center gap-2 text-slate-400" title={t('ai.ollamaCtxHint')}>
                <span className="shrink-0">{t('ai.ollamaCtx')}</span>
                <select
                  value={s.ollama.contextLength}
                  onChange={(e) => setS({ ...s, ollama: { ...s.ollama, contextLength: Number(e.target.value) } })}
                  className={field}
                  data-ollama-ctx
                >
                  {[2048, 4096, 8192, 16384, 32768, 65536, 131072].map((n) => (
                    <option key={n} value={n}>
                      {t('ai.ollamaCtxOption', { tokens: n.toLocaleString('ru-RU'), gb: ((n / 131072) * 37.5).toFixed(n < 16384 ? 1 : 0) })}
                    </option>
                  ))}
                </select>
              </label>
              <div className="text-[11px] text-slate-500">{t('ai.ollamaCtxHint')}</div>
              <div className="text-slate-400">
                {ollamaModels.length > 0
                  ? t('ai.ollamaModels', { list: ollamaModels.map((m) => m.name).join(', ') })
                  : status.ollama === 'ok'
                    ? t('ai.ollamaNoModels')
                    : t('ai.ollamaHint')}
              </div>
              <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-indigo-400 hover:underline">
                {t('ai.getOllama')} <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            {/* Inline suggestions in the editor */}
            <div className={section}>
              <label className="flex items-center gap-2 font-semibold text-fg cursor-pointer">
                <input
                  type="checkbox"
                  checked={s.completion.enabled}
                  disabled={ollamaModels.length === 0}
                  onChange={(e) => {
                    // Prefer a regular code model; the user can pick any other in the list below
                    const model =
                      s.completion.model ||
                      ollamaModels.find((m) => /^(qwen2\.5-coder|deepseek-coder|codellama|starcoder|codegemma)/i.test(m.name))?.name ||
                      ollamaModels.find((m) => /coder/i.test(m.name) && !/abliterat|uncensor/i.test(m.name))?.name ||
                      ollamaModels[0]?.name ||
                      '';
                    setS({ ...s, completion: { enabled: e.target.checked, model } });
                  }}
                />
                {t('ai.completionTitle')}
              </label>
              <select
                value={s.completion.model}
                disabled={ollamaModels.length === 0}
                onChange={(e) => setS({ ...s, completion: { ...s.completion, model: e.target.value } })}
                className={field}
              >
                <option value="">—</option>
                {ollamaModels.map((m) => (
                  <option key={m.id} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
              <div className="text-slate-500">{ollamaModels.length === 0 ? t('ai.completionNeedsOllama') : t('ai.completionHint')}</div>
            </div>

            {/* OpenAI-compatible server */}
            <div className={section}>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 font-semibold text-fg cursor-pointer">
                  <input
                    type="checkbox"
                    checked={s.custom.enabled}
                    onChange={(e) => setS({ ...s, custom: { ...s.custom, enabled: e.target.checked } })}
                  />
                  {t('ai.customTitle')}
                </label>
                {statusBadge(status.custom)}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <input
                  value={s.custom.name}
                  onChange={(e) => setS({ ...s, custom: { ...s.custom, name: e.target.value } })}
                  placeholder={t('ai.customName')}
                  className={field}
                />
                <input
                  value={s.custom.baseUrl}
                  onChange={(e) => setS({ ...s, custom: { ...s.custom, baseUrl: e.target.value } })}
                  placeholder="http://127.0.0.1:1234/v1"
                  className={`${field} col-span-2`}
                />
              </div>
              <input
                type="password"
                value={customKey}
                onChange={(e) => setCustomKey(e.target.value)}
                placeholder={s.custom.hasKey ? t('ai.keySavedReplace', { key: s.custom.keyMasked }) : t('ai.customKey')}
                className={field}
                autoComplete="off"
              />
              <input
                value={customModels}
                onChange={(e) => setCustomModels(e.target.value)}
                placeholder={t('ai.customModels')}
                className={field}
              />
              {customList.length > 0 && (
                <div className="text-slate-400">{t('ai.customFound', { count: customList.length })}</div>
              )}
              <div className="text-slate-500">{t('ai.customHint')}</div>
            </div>

            {error && <div className="p-2.5 rounded-lg bg-rose-950/30 border border-rose-800 text-rose-300">{error}</div>}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => refreshModels()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-panel hover:bg-hover border border-slate-700 text-slate-300"
              >
                <RefreshCw className="w-3.5 h-3.5" /> {t('ai.check')}
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <Check className="w-3.5 h-3.5" /> : null}
                {saved ? t('ai.saved') : t('ai.save')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
