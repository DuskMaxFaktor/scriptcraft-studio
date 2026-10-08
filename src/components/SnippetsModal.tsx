import React, { useEffect, useState } from 'react';
import { Braces, X, Plus, Trash2, Save } from 'lucide-react';
import { useI18n } from '../i18n.ts';
import { getCustomSnippets, setCustomSnippets, SNIPPET_LANGUAGES, type Snippet } from '../snippets.ts';

// Manage your own code snippets: a prefix expands to the body (use ${1}, ${2}… for tab stops).
// Stored per language in this browser; completions pick them up as soon as you save.

const LANG_LABEL: Record<string, string> = {
  python: 'Python',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  html: 'HTML',
  css: 'CSS',
  shell: 'Bash',
  sql: 'SQL',
  json: 'JSON',
  markdown: 'Markdown',
  plaintext: 'Text',
};

export const SnippetsModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const { t } = useI18n();
  const [map, setMap] = useState<Record<string, Snippet[]>>({});
  const [lang, setLang] = useState('python');

  useEffect(() => {
    if (isOpen) setMap(getCustomSnippets());
  }, [isOpen]);

  if (!isOpen) return null;

  const list = map[lang] || [];
  const setList = (next: Snippet[]) => setMap((m) => ({ ...m, [lang]: next }));
  const update = (i: number, patch: Partial<Snippet>) => setList(list.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const add = () => setList([...list, { prefix: '', body: '', description: '' }]);
  const remove = (i: number) => setList(list.filter((_, k) => k !== i));

  const save = () => {
    setCustomSnippets(map);
    onClose();
  };

  const total = Object.values(map).reduce((n, l) => n + l.filter((s) => s.prefix.trim() && s.body).length, 0);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onMouseDown={onClose}>
      <div className="bg-raised border border-slate-700 rounded-xl w-full max-w-2xl h-[80vh] flex flex-col shadow-2xl overflow-hidden" onMouseDown={(e) => e.stopPropagation()} data-snippets-modal>
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between bg-modal shrink-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Braces className="w-4 h-4 text-indigo-400" />
            {t('snip.title')}
            <span className="text-slate-500 font-normal">({total})</span>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-fg rounded-lg hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-2 border-b border-slate-800 flex items-center gap-2 text-xs shrink-0">
          <span className="text-slate-400">{t('snip.language')}</span>
          <select value={lang} onChange={(e) => setLang(e.target.value)} data-snip-lang className="bg-deep border border-slate-700 rounded px-2 py-1 text-slate-200 focus:outline-none">
            {SNIPPET_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {LANG_LABEL[l] || l}
                {map[l]?.filter((s) => s.prefix.trim() && s.body).length ? ` (${map[l].filter((s) => s.prefix.trim() && s.body).length})` : ''}
              </option>
            ))}
          </select>
          <span className="ml-auto text-[11px] text-slate-500">{t('snip.tabstopHint')}</span>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
          {list.length === 0 && <p className="text-slate-500 text-xs text-center py-6">{t('snip.empty')}</p>}
          {list.map((s, i) => (
            <div key={i} className="border border-slate-800 rounded-lg p-3 space-y-2 bg-panel/40" data-snip-row>
              <div className="flex items-center gap-2">
                <input
                  value={s.prefix}
                  onChange={(e) => update(i, { prefix: e.target.value })}
                  placeholder={t('snip.prefix')}
                  data-snip-prefix
                  className="w-32 bg-deep border border-slate-700 rounded px-2 py-1 font-mono text-xs text-fg focus:outline-none focus:border-indigo-500"
                />
                <input
                  value={s.description}
                  onChange={(e) => update(i, { description: e.target.value })}
                  placeholder={t('snip.description')}
                  className="flex-1 bg-deep border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-indigo-500"
                />
                <button onClick={() => remove(i)} className="p-1.5 text-slate-500 hover:text-rose-400" title={t('snip.delete')}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <textarea
                value={s.body}
                onChange={(e) => update(i, { body: e.target.value })}
                placeholder={t('snip.body')}
                data-snip-body
                rows={Math.min(8, Math.max(2, s.body.split('\n').length))}
                spellCheck={false}
                className="w-full bg-deep border border-slate-700 rounded px-2 py-1.5 font-mono text-[12px] leading-5 text-fg resize-y focus:outline-none focus:border-indigo-500"
              />
            </div>
          ))}
          <button onClick={add} data-snip-add className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-dashed border-slate-700 text-slate-300 hover:text-fg hover:bg-hover text-xs">
            <Plus className="w-3.5 h-3.5" /> {t('snip.add')}
          </button>
        </div>

        <div className="px-5 py-3 border-t border-slate-800 flex items-center justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:bg-hover text-xs">
            {t('snip.cancel')}
          </button>
          <button onClick={save} data-snip-save className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs">
            <Save className="w-3.5 h-3.5" /> {t('snip.save')}
          </button>
        </div>
      </div>
    </div>
  );
};
