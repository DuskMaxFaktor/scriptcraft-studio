import React, { useEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { X, Columns2 } from 'lucide-react';
import { FileItem, FileLanguage } from '../types.ts';
import { useI18n } from '../i18n.ts';
import { useTheme } from '../theme.ts';
import { monaco } from '../monacoSetup.ts';
import { setModelFile, scheduleLint } from '../codeTools.ts';

// The right side of a split editor: any project file next to the main editor (Ctrl+\).
// Editors share Monaco models by file id, so the same file open on both sides stays in sync.

const MONACO_LANGUAGE: Record<FileLanguage, string> = {
  javascript: 'javascript',
  typescript: 'typescript',
  python: 'python',
  html: 'html',
  css: 'css',
  bash: 'shell',
  powershell: 'powershell',
  sql: 'sql',
  json: 'json',
  markdown: 'markdown',
  text: 'plaintext',
};

interface Props {
  files: FileItem[];
  file: FileItem;
  onSelect: (fileId: string) => void;
  onClose: () => void;
  onUpdateContent: (fileId: string, content: string) => void;
  onRun: () => void;
}

type MonacoEditor = Parameters<OnMount>[0];

export const SecondaryEditor: React.FC<Props> = ({ files, file, onSelect, onClose, onUpdateContent, onRun }) => {
  const { t } = useI18n();
  const { theme } = useTheme();
  const editorRef = useRef<MonacoEditor | null>(null);
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  let fontSize = 13;
  try {
    const saved = Number(localStorage.getItem('scriptcraft-editor-font'));
    if (saved >= 10 && saved <= 24) fontSize = saved;
  } catch {
    // storage unavailable
  }

  // Formatting, Ruff checks and Python hints need the file name of the model
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    setModelFile(model, file.name);
    scheduleLint(model);
  }, [file.id, file.name]);

  const handleMount: OnMount = (editor, m) => {
    editorRef.current = editor;
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => onRunRef.current());
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {});
    const model = editor.getModel();
    if (model) {
      setModelFile(model, file.name);
      scheduleLint(model);
    }
    editor.onDidChangeModelContent(() => {
      const current = editor.getModel();
      if (current) scheduleLint(current);
    });
  };

  return (
    <div className="h-full flex flex-col min-h-0 bg-canvas border-l border-slate-800 overflow-hidden" data-split-editor>
      <div className="h-10 bg-bar border-b border-slate-800 flex items-center gap-2 px-2 select-none shrink-0">
        <Columns2 className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        <select
          value={file.id}
          onChange={(e) => onSelect(e.target.value)}
          className="flex-1 min-w-0 bg-panel border border-slate-700 rounded px-2 py-1 text-xs font-mono text-fg focus:outline-none focus:border-indigo-500"
          title={t('split.choose')}
          data-split-file
        >
          {files.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-fg hover:bg-slate-800" title={t('split.close')}>
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <Editor
          path={file.id}
          language={MONACO_LANGUAGE[file.language] || 'plaintext'}
          value={file.content}
          onChange={(value) => onUpdateContent(file.id, value ?? '')}
          onMount={handleMount}
          theme={theme === 'light' ? 'scriptcraft-light' : 'scriptcraft-dark'}
          options={{
            fontSize,
            fontFamily: "'Fira Code', 'JetBrains Mono', Consolas, monospace",
            fontLigatures: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: file.language === 'python' ? 4 : 2,
            insertSpaces: true,
            renderWhitespace: 'selection',
            bracketPairColorization: { enabled: true },
            guides: { bracketPairs: true, indentation: true },
            stickyScroll: { enabled: true },
            padding: { top: 10 },
            fixedOverflowWidgets: true,
          }}
        />
      </div>
    </div>
  );
};

void monaco;
