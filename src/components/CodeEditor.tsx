import React, { useState, useRef, useEffect } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import {
  Copy,
  Check,
  Search,
  X,
  Download,
  Sparkles,
  ZoomIn,
  ZoomOut,
  AlignLeft,
  ChevronDown,
  Loader2,
  CircleCheck,
  TriangleAlert,
  Wrench,
  Columns2,
  Eye,
} from 'lucide-react';
import { MarkdownPreview } from './MarkdownPreview.tsx';
import type { Breakpoint } from '../utils/debugClient.ts';
import { FileItem, FileLanguage } from '../types.ts';
import { useI18n } from '../i18n.ts';
import { useTheme } from '../theme.ts';
import { monaco } from '../monacoSetup.ts';
import { registerInlineCompletions } from '../inlineCompletions.ts';
import { setPyIntelHooks } from '../pythonIntel.ts';
import {
  registerCodeTools,
  setModelFile,
  setCodeToolsProject,
  scheduleLint,
  subscribeCodeTools,
  getCodeToolsState,
  problemCount,
  formatsWithTools,
} from '../codeTools.ts';

registerInlineCompletions();
registerCodeTools();

type MonacoEditor = Parameters<OnMount>[0];

interface CodeEditorProps {
  files: FileItem[];
  activeFile: FileItem;
  /** All files of the project (used to drop editor models of deleted files) */
  allFiles: FileItem[];
  onUpdateContent: (fileId: string, content: string) => void;
  onSelectFile: (fileId: string) => void;
  onCloseFile?: (fileId: string) => void;
  onTriggerAIAction: (action: 'explain' | 'refactor' | 'debug' | 'generate_tests') => void;
  onRun: () => void;
  /** Select and scroll to a range (from project search); nonce makes repeated clicks work */
  reveal?: { fileId: string; line: number; column: number; length: number; nonce: number } | null;
  /** Breakpoints of the active file (left-click the margin to toggle, right-click for a condition) */
  breakpoints?: Breakpoint[];
  onBreakpointsChange?: (bps: Breakpoint[]) => void;
  /** Line where the debugger is paused in the active file */
  debugLine?: number | null;
  /** Current project (its pyproject.toml / .prettierrc settings apply to formatting) */
  projectId?: string | null;
  /** Install Ruff (formatter and checks) or Jedi (completions, hints); output goes to the terminal */
  onInstallTool?: (tool: 'ruff' | 'jedi') => void;
  /** Go to definition into another project file */
  onOpenFileAt?: (name: string, line: number) => void;
  /** Rename changed other project files */
  onApplyFiles?: (files: { name: string; content: string }[]) => void;
  /** Split editor (a second file on the right): toggle and current state */
  onToggleSplit?: () => void;
  splitOpen?: boolean;
}

const MONACO_LANGUAGE: Record<FileLanguage, string> = {
  javascript: 'javascript',
  typescript: 'typescript',
  python: 'python',
  html: 'html',
  css: 'css',
  bash: 'shell',
  sql: 'sql',
  json: 'json',
  markdown: 'markdown',
  text: 'plaintext',
};

const FONT_SIZE_KEY = 'scriptcraft-editor-font';

export const CodeEditor: React.FC<CodeEditorProps> = ({
  files,
  activeFile,
  allFiles,
  onUpdateContent,
  onSelectFile,
  onCloseFile,
  onTriggerAIAction,
  onRun,
  reveal,
  breakpoints = [],
  onBreakpointsChange,
  debugLine = null,
  projectId = null,
  onInstallTool,
  onOpenFileAt,
  onApplyFiles,
  onToggleSplit,
  splitOpen = false,
}) => {
  const { t } = useI18n();
  const { theme } = useTheme();
  const [copied, setCopied] = useState(false);
  const [fontSize, setFontSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(FONT_SIZE_KEY));
      if (saved >= 10 && saved <= 24) return saved;
    } catch {
      // storage unavailable
    }
    return 13;
  });
  const [showAIMenu, setShowAIMenu] = useState(false);
  const [mdPreview, setMdPreview] = useState(true);
  const isMarkdown = activeFile.language === 'markdown' || /\.(md|markdown)$/i.test(activeFile.name);
  const showMdPreview = isMarkdown && mdPreview;
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [tools, setTools] = useState(getCodeToolsState);
  const activeFileNameRef = useRef(activeFile.name);
  activeFileNameRef.current = activeFile.name;
  const [problems, setProblems] = useState(0);

  const editorRef = useRef<MonacoEditor | null>(null);
  const aiMenuRef = useRef<HTMLDivElement>(null);
  // Keep the latest callbacks for editor commands registered once on mount
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  useEffect(() => {
    try {
      localStorage.setItem(FONT_SIZE_KEY, String(fontSize));
    } catch {
      // storage unavailable
    }
  }, [fontSize]);

  // Close AI menu on outside click
  useEffect(() => {
    if (!showAIMenu) return;
    const onDown = (e: MouseEvent) => {
      if (aiMenuRef.current && !aiMenuRef.current.contains(e.target as Node)) setShowAIMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showAIMenu]);

  // Each file has its own Monaco model (own undo history); dispose models of files that no longer exist
  useEffect(() => {
    const alive = new Set(allFiles.map((f) => f.id));
    for (const model of monaco.editor.getModels()) {
      const id = decodeURIComponent(model.uri.path.replace(/^\//, ''));
      if (model.uri.scheme === 'file' && id.startsWith('file-') && !alive.has(id)) model.dispose();
    }
  }, [allFiles]);

  // ---------- breakpoints & current debug line ----------
  const bpCollectionRef = useRef<ReturnType<MonacoEditor['createDecorationsCollection']> | null>(null);
  const debugCollectionRef = useRef<ReturnType<MonacoEditor['createDecorationsCollection']> | null>(null);
  const bpPropsRef = useRef({ breakpoints, onBreakpointsChange, debugLine });
  bpPropsRef.current = { breakpoints, onBreakpointsChange, debugLine };

  const applyDecorations = () => {
    const editor = editorRef.current;
    if (!editor || !bpCollectionRef.current || !debugCollectionRef.current) return;
    const { breakpoints: bps, debugLine: dl } = bpPropsRef.current;
    bpCollectionRef.current.set(
      bps.map((bp) => ({
        range: new monaco.Range(bp.line, 1, bp.line, 1),
        options: {
          glyphMarginClassName: bp.condition ? 'sc-breakpoint sc-breakpoint-cond' : 'sc-breakpoint',
          glyphMarginHoverMessage: { value: bp.condition ? t('debug.breakpointCondHover', { cond: bp.condition }) : t('debug.breakpointHover') },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      }))
    );
    debugCollectionRef.current.set(
      dl
        ? [
            {
              range: new monaco.Range(dl, 1, dl, 1),
              options: { isWholeLine: true, className: 'sc-debug-line', glyphMarginClassName: 'sc-debug-arrow' },
            },
          ]
        : []
    );
  };

  const bpKey = breakpoints.map((b) => (b.condition ? `${b.line}:${b.condition}` : `${b.line}`)).join(',');
  useEffect(() => {
    applyDecorations();
    if (debugLine) editorRef.current?.revealLineInCenterIfOutsideViewport(debugLine);
  }, [bpKey, debugLine, activeFile.id]);

  // Formatting and Ruff checks need the file name (editor models are keyed by file id)
  useEffect(() => subscribeCodeTools(setTools), []);
  useEffect(() => setCodeToolsProject(projectId), [projectId]);
  useEffect(() => setPyIntelHooks({ openFile: onOpenFileAt, applyFiles: onApplyFiles }), [onOpenFileAt, onApplyFiles]);
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    setModelFile(model, activeFile.name);
    scheduleLint(model);
    setProblems(problemCount(model));
  }, [activeFile.id, activeFile.name, tools.ruff]);
  useEffect(() => {
    const sub = monaco.editor.onDidChangeMarkers(() => setProblems(problemCount(editorRef.current?.getModel() ?? null)));
    return () => sub.dispose();
  }, []);

  // Jump to a project-search match once its file is shown in the editor
  useEffect(() => {
    if (!reveal || reveal.fileId !== activeFile.id) return;
    const timer = setTimeout(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const range = new monaco.Range(reveal.line, reveal.column, reveal.line, reveal.column + reveal.length);
      editor.setSelection(range);
      editor.revealRangeInCenter(range);
      editor.focus();
    }, 60);
    return () => clearTimeout(timer);
  }, [reveal?.nonce, activeFile.id]);

  const handleMount: OnMount = (editor, m) => {
    editorRef.current = editor;
    // Ctrl+Enter runs the script (Monaco would otherwise insert a line)
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => onRunRef.current());
    // Files are autosaved; just keep the browser "Save page" dialog away
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {});
    editor.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, column: e.position.column }));

    bpCollectionRef.current = editor.createDecorationsCollection();
    debugCollectionRef.current = editor.createDecorationsCollection();
    // Left-click in the left margin toggles a breakpoint; right-click sets/edits a condition
    editor.onMouseDown((e) => {
      const type = e.target.type;
      if (type !== m.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && type !== m.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
      const line = e.target.position?.lineNumber;
      const { breakpoints: bps, onBreakpointsChange: change } = bpPropsRef.current;
      if (!line || !change) return;
      if (e.event.rightButton) {
        e.event.preventDefault();
        const existing = bps.find((b) => b.line === line);
        const cond = window.prompt(t('debug.conditionPrompt'), existing?.condition || '');
        if (cond === null) return; // cancelled: no change
        const trimmed = cond.trim();
        const rest = bps.filter((b) => b.line !== line);
        change([...rest, { line, ...(trimmed ? { condition: trimmed } : {}) }].sort((a, b) => a.line - b.line));
        return;
      }
      change(bps.some((b) => b.line === line) ? bps.filter((b) => b.line !== line) : [...bps, { line }].sort((a, b) => a.line - b.line));
    });
    // Breakpoints move with their lines when code above is added or removed (conditions kept by order)
    editor.onDidChangeModelContent(() => {
      const coll = bpCollectionRef.current;
      const { breakpoints: bps, onBreakpointsChange: change } = bpPropsRef.current;
      if (!coll || !change) return;
      const ranges = coll.getRanges();
      const moved: { line: number; condition?: string }[] = ranges.map((r, i) => ({ line: r.startLineNumber, ...(bps[i]?.condition ? { condition: bps[i].condition } : {}) }));
      // Collapse duplicates that may appear if two breakpoints end up on the same line
      const byLine = new Map<number, { line: number; condition?: string }>();
      for (const b of moved) if (!byLine.has(b.line)) byLine.set(b.line, b);
      const next = [...byLine.values()].sort((a, b) => a.line - b.line);
      const key = (list: typeof next) => list.map((b) => (b.condition ? `${b.line}:${b.condition}` : `${b.line}`)).join(',');
      if (key(next) !== key(bps)) change(next);
    });
    editor.onDidChangeModelContent(() => {
      const model = editor.getModel();
      if (model) scheduleLint(model);
    });
    // The first file: Monaco mounts after the effects below have already run
    const firstModel = editor.getModel();
    if (firstModel) {
      setModelFile(firstModel, activeFileNameRef.current);
      scheduleLint(firstModel);
    }
    // Decorations belong to a model: re-apply them when another file is opened
    editor.onDidChangeModel(() => setTimeout(applyDecorations, 0));
    applyDecorations();
    editor.focus();
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(activeFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([activeFile.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeFile.name.slice(activeFile.name.lastIndexOf('/') + 1);
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSearch = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    editor.getAction('editor.action.startFindReplaceAction')?.run();
  };

  const handleFormatCode = async () => {
    const editor = editorRef.current;
    if (!editor) return;
    // Ruff (Python) and Prettier (JS/TS/CSS/HTML/JSON/Markdown) via the server; other languages: trim trailing spaces
    const model0 = editor.getModel();
    const formatter = editor.getAction('editor.action.formatDocument');
    if (model0 && formatter && formatsWithTools(model0.getLanguageId())) {
      if (model0.getLanguageId() === 'python' && tools.ruff === false) {
        onInstallTool?.('ruff');
        return;
      }
      await formatter.run();
      return;
    }
    const model = editor.getModel();
    if (!model) return;
    const trimmed = model
      .getValue()
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n');
    // Apply as an edit so Ctrl+Z can undo it
    editor.executeEdits('format', [{ range: model.getFullModelRange(), text: trimmed }]);
    editor.pushUndoStop();
  };

  const lineCount = activeFile.content.split('\n').length;

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 bg-canvas border-r border-slate-800 overflow-hidden">
      {/* Top File Tabs */}
      <div className="h-10 bg-bar border-b border-slate-800 flex items-center justify-between gap-2 px-2 select-none shrink-0">
        <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto">
          {files.map((file) => {
            const isActive = file.id === activeFile.id;
            return (
              <div
                key={file.id}
                onClick={() => onSelectFile(file.id)}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs rounded-t-md cursor-pointer border-t-2 font-mono transition-colors ${
                  isActive
                    ? 'bg-canvas text-fg border-indigo-500 font-medium'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-panel border-transparent'
                }`}
              >
                <span title={file.name}>{file.name.slice(file.name.lastIndexOf('/') + 1)}</span>
                {onCloseFile && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseFile(file.id);
                    }}
                    className="p-0.5 rounded hover:bg-slate-700/50 text-slate-500 hover:text-slate-300"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Editor Actions */}
        <div className="flex items-center gap-1 text-slate-400 shrink-0">
          {/* AI Quick Actions Dropdown */}
          <div className="relative" ref={aiMenuRef}>
            <button
              onClick={() => setShowAIMenu(!showAIMenu)}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-slate-800 text-indigo-400 hover:text-indigo-300"
              title={t('editor.aiAssistTitle')}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{t('editor.aiAssist')}</span>
              <ChevronDown className="w-3 h-3" />
            </button>

            {showAIMenu && (
              <div className="absolute right-0 mt-1 w-52 bg-panel border border-slate-700 rounded-md shadow-xl py-1 z-50 text-xs">
                {(
                  [
                    ['explain', 'editor.explain'],
                    ['refactor', 'editor.refactor'],
                    ['debug', 'editor.debug'],
                    ['generate_tests', 'editor.tests'],
                  ] as const
                ).map(([action, label]) => (
                  <button
                    key={action}
                    onClick={() => {
                      setShowAIMenu(false);
                      onTriggerAIAction(action);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-slate-800 text-slate-300 hover:text-fg"
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="h-4 w-px bg-slate-800 mx-1" />

          <button
            onClick={handleSearch}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            title={t('editor.searchTitle')}
          >
            <Search className="w-3.5 h-3.5" />
          </button>

          {onToggleSplit && (
            <button
              onClick={onToggleSplit}
              data-toggle-split
              className={`p-1 rounded hover:bg-slate-800 ${splitOpen ? 'text-indigo-400' : 'text-slate-400 hover:text-slate-200'}`}
              title={splitOpen ? t('split.close') : t('split.open')}
            >
              <Columns2 className="w-3.5 h-3.5" />
            </button>
          )}

          {isMarkdown && (
            <button
              onClick={() => setMdPreview((v) => !v)}
              data-md-preview-toggle
              className={`p-1 rounded hover:bg-slate-800 ${showMdPreview ? 'text-indigo-400' : 'text-slate-400 hover:text-slate-200'}`}
              title={showMdPreview ? t('md.hidePreview') : t('md.showPreview')}
            >
              <Eye className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            onClick={handleFormatCode}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            title={t('editor.formatTitle')}
          >
            <AlignLeft className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => setFontSize(Math.max(10, fontSize - 1))}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            title={t('editor.zoomOut')}
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="text-[11px] font-mono px-0.5">{fontSize}px</span>
          <button
            onClick={() => setFontSize(Math.min(24, fontSize + 1))}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            title={t('editor.zoomIn')}
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>

          <div className="h-4 w-px bg-slate-800 mx-1" />

          <button
            onClick={handleCopy}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            title={t('editor.copy')}
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={handleDownload}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            title={t('editor.download')}
          >
            <Download className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Monaco editor (+ live Markdown preview on the right for .md files) */}
      <div className="flex-1 min-h-0 flex">
      <div className={`min-h-0 ${showMdPreview ? 'w-1/2 border-r border-slate-800' : 'flex-1'}`} data-active-file={activeFile.name} data-active-file-id={activeFile.id}>
        <Editor
          path={activeFile.id}
          language={MONACO_LANGUAGE[activeFile.language] || 'plaintext'}
          value={activeFile.content}
          onChange={(value) => onUpdateContent(activeFile.id, value ?? '')}
          onMount={handleMount}
          theme={theme === 'light' ? 'scriptcraft-light' : 'scriptcraft-dark'}
          loading={
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('editor.loading')}
            </div>
          }
          options={{
            fontSize,
            fontFamily: "'Fira Code', 'JetBrains Mono', Consolas, monospace",
            fontLigatures: true,
            minimap: { enabled: lineCount > 80 },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: activeFile.language === 'python' ? 4 : 2,
            insertSpaces: true,
            wordWrap: 'off',
            renderWhitespace: 'selection',
            bracketPairColorization: { enabled: true },
            guides: { bracketPairs: true, indentation: true },
            stickyScroll: { enabled: true },
            smoothScrolling: true,
            cursorSmoothCaretAnimation: 'on',
            padding: { top: 10 },
            fixedOverflowWidgets: true,
            inlineSuggest: { enabled: true, showToolbar: 'onHover' },
            glyphMargin: true,
          }}
        />
      </div>
        {showMdPreview && (
          <div className="w-1/2 min-h-0 overflow-auto bg-canvas">
            <MarkdownPreview content={activeFile.content} projectId={projectId || undefined} />
          </div>
        )}
      </div>

      {/* Footer Info */}
      <div className="h-6 bg-bar border-t border-slate-800 px-3 flex items-center justify-between text-[11px] text-slate-500 select-none shrink-0">
        <div className="flex items-center gap-3">
          <span>
            {t('editor.position', { line: cursor.line, col: cursor.column })}
          </span>
          <span>
            {lineCount} {t('editor.lines')}
          </span>
          <span>
            {activeFile.content.length} {t('editor.chars')}
          </span>
          <span className="uppercase font-mono text-indigo-400">{activeFile.language}</span>
        </div>
        <div className="flex items-center gap-2">
          {tools.error && (
            <span className="text-red-400 truncate max-w-[360px]" title={tools.error}>
              {tools.error}
            </span>
          )}
          {activeFile.language === 'python' && tools.jedi === false && tools.installing !== 'jedi' && (
            <button onClick={() => onInstallTool?.('jedi')} className="flex items-center gap-1 text-amber-400 hover:text-amber-300" title={t('pyintel.installTitle')} data-jedi-install>
              <Wrench className="w-3 h-3" /> {t('pyintel.install')}
            </button>
          )}
          {activeFile.language === 'python' &&
            (tools.installing ? (
              <span className="flex items-center gap-1 text-slate-400">
                <Loader2 className="w-3 h-3 animate-spin" /> {tools.installing === 'jedi' ? t('pyintel.installing') : t('tools.installing')}
              </span>
            ) : tools.ruff === false ? (
              <button onClick={() => onInstallTool?.('ruff')} className="flex items-center gap-1 text-amber-400 hover:text-amber-300" title={t('tools.ruffMissingTitle')}>
                <Wrench className="w-3 h-3" /> {t('tools.ruffInstall')}
              </button>
            ) : tools.ruff ? (
              <button
                data-ruff-status
                onClick={() => {
                  editorRef.current?.focus();
                  editorRef.current?.getAction('editor.action.marker.next')?.run();
                }}
                className={`flex items-center gap-1 ${problems ? 'text-amber-400 hover:text-amber-300' : 'text-emerald-400'}`}
                title={t('tools.ruffTitle')}
              >
                {problems ? <TriangleAlert className="w-3 h-3" /> : <CircleCheck className="w-3 h-3" />}
                Ruff: {problems ? t('tools.problems', { count: problems }) : t('tools.noProblems')}
              </button>
            ) : null)}
          <span>UTF-8</span>
          <span>{activeFile.language === 'python' ? t('editor.spaces4') : t('editor.spaces')}</span>
        </div>
      </div>
    </div>
  );
};
