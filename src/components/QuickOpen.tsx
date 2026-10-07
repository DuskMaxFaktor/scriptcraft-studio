import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { FileItem } from '../types.ts';
import { useI18n } from '../i18n.ts';

interface QuickOpenProps {
  isOpen: boolean;
  files: FileItem[];
  onClose: () => void;
  onOpen: (fileId: string) => void;
}

/** Fuzzy score: all query characters must appear in order; consecutive and file-name matches rank higher. */
function score(name: string, query: string): number {
  if (!query) return 1;
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  const base = n.slice(n.lastIndexOf('/') + 1);
  if (base.startsWith(q)) return 1000 - base.length;
  if (base.includes(q)) return 800 - base.length;
  if (n.includes(q)) return 600 - n.length;
  let pos = 0;
  let total = 0;
  let streak = 0;
  for (const ch of q) {
    const found = n.indexOf(ch, pos);
    if (found < 0) return -1;
    streak = found === pos ? streak + 1 : 0;
    total += 10 + streak * 5;
    pos = found + 1;
  }
  return total - n.length;
}

export const QuickOpen: React.FC<QuickOpenProps> = ({ isOpen, files, onClose, onOpen }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus before the next keystroke arrives, so quickly typed letters never land in the editor
  useLayoutEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelected(0);
      inputRef.current?.focus();
    }
  }, [isOpen]);

  const results = useMemo(
    () =>
      files
        .map((f) => ({ f, s: score(f.name, query) }))
        .filter((r) => r.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 50)
        .map((r) => r.f),
    [files, query]
  );

  if (!isOpen) return null;

  const open = (f?: FileItem) => {
    if (!f) return;
    onOpen(f.id);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex justify-center pt-[12vh] px-4" onMouseDown={onClose}>
      <div
        className="w-full max-w-lg h-fit bg-raised border border-slate-700 rounded-xl shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-800">
          <Search className="w-4 h-4 text-slate-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelected((s) => Math.min(s + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelected((s) => Math.max(s - 1, 0));
              } else if (e.key === 'Enter') {
                open(results[selected]);
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
            placeholder={t('quick.placeholder')}
            className="flex-1 bg-transparent text-sm text-fg placeholder-slate-500 focus:outline-none"
          />
          <kbd className="text-[10px] text-slate-500 border border-slate-700 rounded px-1">Esc</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-3 text-xs text-slate-500">{t('quick.none')}</div>
          ) : (
            results.map((f, i) => {
              const slash = f.name.lastIndexOf('/');
              return (
                <button
                  key={f.id}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => open(f)}
                  className={`w-full text-left px-4 py-1.5 text-xs font-mono flex items-baseline gap-2 ${
                    i === selected ? 'bg-indigo-600 text-white' : 'text-slate-300'
                  }`}
                >
                  <span>{f.name.slice(slash + 1)}</span>
                  {slash > 0 && <span className={i === selected ? 'text-indigo-200' : 'text-slate-500'}>{f.name.slice(0, slash)}</span>}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
