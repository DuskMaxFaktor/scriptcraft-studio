import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Replace, ChevronRight, ChevronDown, CaseSensitive, WholeWord, Regex, X, FileCode, Undo2 } from 'lucide-react';
import { FileItem } from '../types.ts';
import { useI18n } from '../i18n.ts';
import { searchFiles, replaceInText, replaceOneInText, buildRegex, SearchOptions } from '../utils/search.ts';
import { askConfirm } from '../dialogs.tsx';

interface SearchPanelProps {
  files: FileItem[];
  /** Open a file and select the match */
  onReveal: (fileId: string, line: number, column: number, length: number) => void;
  /** Apply replacements: fileId -> new content */
  onReplace: (changes: { fileId: string; content: string }[]) => void;
  onClose: () => void;
  focusNonce: number;
}

export const SearchPanel: React.FC<SearchPanelProps> = ({ files, onReveal, onReplace, onClose, focusNonce }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [include, setInclude] = useState('');
  const [debounced, setDebounced] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  // The file contents before the last replace, so it can be undone in one click
  const [undo, setUndo] = useState<{ changes: { fileId: string; content: string }[]; count: number } | null>(null);

  /** Apply replacements and remember what the files looked like before. */
  const applyWithUndo = (changes: { fileId: string; content: string }[], count: number) => {
    const before = changes
      .map((c) => ({ fileId: c.fileId, content: files.find((f) => f.id === c.fileId)?.content }))
      .filter((c): c is { fileId: string; content: string } => typeof c.content === 'string');
    onReplace(changes);
    setUndo({ changes: before, count });
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  const options: SearchOptions = { query: debounced, caseSensitive, wholeWord, regex, include };

  const { results, total, truncated, error } = useMemo(() => {
    try {
      buildRegex(options);
      return { ...searchFiles(files, options), error: null as string | null };
    } catch (e: any) {
      return { results: [], total: 0, truncated: false, error: e.message as string };
    }
  }, [files, debounced, caseSensitive, wholeWord, regex, include]);

  const replaceIn = async (fileIds: string[]) => {
    const changes: { fileId: string; content: string }[] = [];
    let count = 0;
    for (const id of fileIds) {
      const f = files.find((x) => x.id === id);
      if (!f) continue;
      const r = replaceInText(f.content, options, replacement);
      if (r.count > 0) {
        changes.push({ fileId: id, content: r.text });
        count += r.count;
      }
    }
    if (changes.length === 0) return;
    if (!(await askConfirm(t('search.confirmReplace', { count, files: changes.length, text: replacement }), { okLabel: t('search.replaceAll') }))) return;
    applyWithUndo(changes, count);
  };

  /** Replace just this one occurrence (no confirmation: it is a single, visible change). */
  const replaceOne = (fileId: string, line: number, column: number) => {
    const f = files.find((x) => x.id === fileId);
    if (!f) return;
    const r = replaceOneInText(f.content, options, replacement, line, column);
    if (r.count) applyWithUndo([{ fileId, content: r.text }], 1);
  };

  const toggle = (on: boolean, set: (v: boolean) => void, Icon: React.FC<any>, title: string) => (
    <button
      onClick={() => set(!on)}
      title={title}
      className={`p-0.5 rounded ${on ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-fg hover:bg-slate-800'}`}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );

  const highlight = (preview: string, column: number, length: number) => {
    // Show a window around the match so long lines stay readable
    const start = Math.max(0, column - 1 - 30);
    const before = (start > 0 ? '…' : '') + preview.slice(start, column - 1).replace(/^\s+/, '');
    const match = preview.slice(column - 1, column - 1 + length);
    const after = preview.slice(column - 1 + length, column - 1 + length + 80);
    return (
      <>
        <span className="text-slate-400">{before}</span>
        <span className="bg-amber-400/30 text-fg rounded-sm">{showReplace && replacement ? <s>{match}</s> : match}</span>
        {showReplace && replacement && <span className="bg-emerald-500/30 text-fg rounded-sm">{replacement}</span>}
        <span className="text-slate-400">{after}</span>
      </>
    );
  };

  return (
    <aside className="w-full h-full border-r border-slate-800 bg-side flex flex-col select-none">
      <div className="px-3 py-2.5 flex items-center justify-between border-b border-slate-800/80">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
          <Search className="w-3.5 h-3.5" />
          <span>{t('search.title')}</span>
        </div>
        <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800" title={t('search.backToFiles')}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-2 space-y-1.5 border-b border-slate-800/80">
        <div className="flex items-start gap-1">
          <button
            onClick={() => setShowReplace(!showReplace)}
            className="p-0.5 mt-1 rounded text-slate-400 hover:text-fg"
            title={t('search.toggleReplace')}
          >
            {showReplace ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
          <div className="flex-1 space-y-1.5 min-w-0">
            <div className="flex items-center gap-1 bg-deep border border-slate-700 rounded px-1.5 focus-within:border-indigo-500">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && onClose()}
                placeholder={t('search.placeholder')}
                className="flex-1 min-w-0 bg-transparent py-1 text-xs text-fg placeholder-slate-500 focus:outline-none font-mono"
              />
              {toggle(caseSensitive, setCaseSensitive, CaseSensitive, t('search.case'))}
              {toggle(wholeWord, setWholeWord, WholeWord, t('search.word'))}
              {toggle(regex, setRegex, Regex, t('search.regex'))}
            </div>
            {showReplace && (
              <div className="flex items-center gap-1">
                <input
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  placeholder={t('search.replacePlaceholder')}
                  className="flex-1 min-w-0 bg-deep border border-slate-700 rounded px-1.5 py-1 text-xs text-fg placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  onClick={() => replaceIn(results.map((r) => r.fileId))}
                  disabled={total === 0}
                  className="p-1 rounded text-slate-300 hover:text-fg hover:bg-slate-800 disabled:opacity-30"
                  title={t('search.replaceAll')}
                >
                  <Replace className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            <input
              value={include}
              onChange={(e) => setInclude(e.target.value)}
              placeholder={t('search.include')}
              className="w-full bg-deep border border-slate-700 rounded px-1.5 py-1 text-[11px] text-fg placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono"
            />
          </div>
        </div>
        <div className="text-[11px] text-slate-500 px-1">
          {error
            ? <span className="text-rose-400">{error}</span>
            : debounced
              ? t('search.summary', { count: total, files: results.length }) + (truncated ? ` ${t('search.truncated')}` : '')
              : t('search.hint')}
        </div>
        {undo && (
          <div className="flex items-center gap-2 px-1 text-[11px] text-emerald-300" data-replace-done>
            <span>{t('search.replacedCount', { count: undo.count })}</span>
            <button
              onClick={() => {
                onReplace(undo.changes);
                setUndo(null);
              }}
              className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-700 text-slate-200 hover:bg-slate-800"
              data-replace-undo
            >
              <Undo2 className="w-3 h-3" /> {t('search.undoReplace')}
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-1 text-xs">
        {results.map((r) => {
          const isCollapsed = collapsed.has(r.fileId);
          return (
            <div key={r.fileId}>
              <div
                onClick={() =>
                  setCollapsed((prev) => {
                    const n = new Set(prev);
                    n.has(r.fileId) ? n.delete(r.fileId) : n.add(r.fileId);
                    return n;
                  })
                }
                className="group flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-panel text-slate-300"
                title={r.name}
              >
                {isCollapsed ? <ChevronRight className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />}
                <FileCode className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span className="font-mono truncate">{r.name.slice(r.name.lastIndexOf('/') + 1)}</span>
                <span className="text-[10px] text-slate-500 truncate">{r.name.includes('/') ? r.name.slice(0, r.name.lastIndexOf('/')) : ''}</span>
                <span className="ml-auto text-[10px] px-1.5 rounded-full bg-slate-800 text-slate-400 shrink-0">{r.matches.length}</span>
                {showReplace && replacement !== undefined && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      replaceIn([r.fileId]);
                    }}
                    className="hidden group-hover:block p-0.5 rounded hover:bg-slate-700 text-slate-300"
                    title={t('search.replaceInFile')}
                  >
                    <Replace className="w-3 h-3" />
                  </button>
                )}
              </div>
              {!isCollapsed &&
                r.matches.map((m, i) => (
                  <div
                    key={i}
                    onClick={() => onReveal(r.fileId, m.line, m.column, m.length)}
                    className="group/match flex items-baseline gap-2 pl-8 pr-2 py-0.5 cursor-pointer hover:bg-active font-mono text-[11px] whitespace-nowrap overflow-hidden"
                    data-search-match
                  >
                    <span className="text-slate-500 shrink-0 w-6 text-right">{m.line}</span>
                    <span className="truncate flex-1">{highlight(m.preview, m.column, m.length)}</span>
                    {showReplace && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          replaceOne(r.fileId, m.line, m.column);
                        }}
                        className="shrink-0 p-0.5 rounded text-slate-400 hover:text-fg hover:bg-slate-700 opacity-0 group-hover/match:opacity-100 focus:opacity-100"
                        title={t('search.replaceOne')}
                        data-replace-one
                      >
                        <Replace className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
};
