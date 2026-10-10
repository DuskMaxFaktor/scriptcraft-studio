import React, { useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { History, X, RotateCcw, Loader2 } from 'lucide-react';
import { FileItem, FileLanguage } from '../types.ts';
import { useI18n } from '../i18n.ts';
import { useTheme } from '../theme.ts';
import { detectLanguageFromName } from '../utils/presets.ts';
import '../monacoSetup.ts';

interface HistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string | null;
  files: FileItem[];
  /** File to show first (e.g. clicked in the explorer) */
  initialFile: string | null;
  onRestore: (name: string, content: string) => void;
}

interface HistoryFile {
  name: string;
  versions: number;
  latest: number;
  deleted: boolean;
}

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

export const HistoryModal: React.FC<HistoryModalProps> = ({ isOpen, onClose, projectId, files, initialFile, onRestore }) => {
  const { t, lang } = useI18n();
  const { theme } = useTheme();
  const [historyFiles, setHistoryFiles] = useState<HistoryFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [versions, setVersions] = useState<{ ts: number; size: number }[]>([]);
  const [selectedTs, setSelectedTs] = useState<number | null>(null);
  const [versionContent, setVersionContent] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const api = (p: string) => `/api/projects/${encodeURIComponent(projectId || '')}${p}`;

  useEffect(() => {
    if (!isOpen || !projectId) return;
    setSelectedFile(initialFile);
    setSelectedTs(null);
    fetch(api('/history'))
      .then((r) => r.json())
      .then((d) => {
        const list: HistoryFile[] = d.files || [];
        setHistoryFiles(list);
        if (!initialFile && list[0]) setSelectedFile(list[0].name);
      })
      .catch(() => setHistoryFiles([]));
  }, [isOpen, projectId, initialFile]);

  useEffect(() => {
    if (!isOpen || !projectId || !selectedFile) {
      setVersions([]);
      return;
    }
    fetch(api(`/history/file?name=${encodeURIComponent(selectedFile)}`))
      .then((r) => r.json())
      .then((d) => {
        const v = d.versions || [];
        setVersions(v);
        setSelectedTs(v[0]?.ts ?? null);
      })
      .catch(() => setVersions([]));
  }, [isOpen, projectId, selectedFile]);

  useEffect(() => {
    if (!selectedFile || !selectedTs) {
      setVersionContent('');
      return;
    }
    setLoading(true);
    fetch(api(`/history/version?name=${encodeURIComponent(selectedFile)}&ts=${selectedTs}`))
      .then((r) => r.json())
      .then((d) => setVersionContent(d.content ?? ''))
      .finally(() => setLoading(false));
  }, [selectedFile, selectedTs]);

  if (!isOpen) return null;

  const current = files.find((f) => f.name === selectedFile);
  const fmt = (ts: number) =>
    new Date(ts).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  // Files with history first, then current files that have no versions yet
  const fileList = [
    ...historyFiles,
    ...files.filter((f) => !historyFiles.some((h) => h.name === f.name)).map((f) => ({ name: f.name, versions: 0, latest: 0, deleted: false })),
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="bg-raised border border-slate-700/80 rounded-xl w-full max-w-6xl h-[85vh] shadow-2xl overflow-hidden flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between bg-modal shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
              <History className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-fg">{t('history.title')}</h2>
              <p className="text-xs text-slate-400">{t('history.subtitle')}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-fg rounded-lg hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Files */}
          <div className="w-56 border-r border-slate-800 overflow-y-auto py-1 shrink-0">
            {fileList.map((f) => (
              <button
                key={f.name}
                onClick={() => setSelectedFile(f.name)}
                className={`w-full text-left px-3 py-1.5 text-xs font-mono flex items-center justify-between gap-2 ${
                  selectedFile === f.name ? 'bg-active text-fg' : 'text-slate-400 hover:bg-panel'
                }`}
                title={f.name}
              >
                <span className={`truncate ${f.deleted ? 'line-through text-slate-500' : ''}`}>{f.name}</span>
                <span className="text-[10px] text-slate-500 shrink-0">{f.deleted ? t('history.deleted') : f.versions || ''}</span>
              </button>
            ))}
          </div>

          {/* Versions */}
          <div className="w-44 border-r border-slate-800 overflow-y-auto py-1 shrink-0">
            {versions.length === 0 ? (
              <div className="px-3 py-3 text-[11px] text-slate-500">{t('history.noVersions')}</div>
            ) : (
              versions.map((v) => (
                <button
                  key={v.ts}
                  onClick={() => setSelectedTs(v.ts)}
                  className={`w-full text-left px-3 py-1.5 text-xs ${
                    selectedTs === v.ts ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-panel'
                  }`}
                >
                  <div className="font-mono">{fmt(v.ts)}</div>
                  <div className={`text-[10px] ${selectedTs === v.ts ? 'text-indigo-200' : 'text-slate-500'}`}>
                    {(v.size / 1024).toFixed(1)} KB
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Diff */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between text-[11px] text-slate-400 shrink-0">
              <span>
                {selectedTs ? t('history.compare', { time: fmt(selectedTs) }) : ''}
                {selectedFile && !current ? ` · ${t('history.fileDeleted')}` : ''}
              </span>
              <button
                onClick={() => {
                  if (selectedFile && selectedTs) {
                    onRestore(selectedFile, versionContent);
                    onClose();
                  }
                }}
                disabled={!selectedTs || loading}
                className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{t('history.restore')}</span>
              </button>
            </div>
            <div className="flex-1 min-h-0">
              {selectedTs ? (
                loading ? (
                  <div className="h-full flex items-center justify-center">
                    <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
                  </div>
                ) : (
                  <DiffEditor
                    original={versionContent}
                    modified={current?.content ?? ''}
                    language={MONACO_LANGUAGE[detectLanguageFromName(selectedFile || '')] || 'plaintext'}
                    theme={theme === 'light' ? 'scriptcraft-light' : 'scriptcraft-dark'}
                    options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, automaticLayout: true, fontSize: 12 }}
                  />
                )
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-slate-500 px-6 text-center">
                  {t('history.pick')}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
