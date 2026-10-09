import React, { useState, useRef, useEffect, Suspense } from 'react';
import { 
  Terminal, 
  Globe, 
  Database, 
  Trash2, 
  Copy, 
  Check, 
  RefreshCw, 
  Smartphone, 
  Tablet, 
  Monitor,
  ChevronUp,
  ChevronDown,
  Download,
  Loader2,
  CornerDownLeft,
  Sparkles,
  SquareTerminal,
  Bug,
  ExternalLink
} from 'lucide-react';
import { LogEntry, TableData, FileItem } from '../types.ts';
import { useI18n } from '../i18n.ts';
import { useTheme } from '../theme.ts';
import type { DebugUiState } from './DebugPanel.tsx';
import { lazyNamed } from '../utils/lazy.tsx';
import { renderAnsi, stripAnsi } from '../utils/ansi.tsx';
import { FlaskConical } from 'lucide-react';

// Terminal (xterm.js) and debugger UI load as separate chunks
const ShellTerminals = lazyNamed(() => import('./ShellTerminals.tsx'), 'ShellTerminals');
const DebugPanel = lazyNamed(() => import('./DebugPanel.tsx'), 'DebugPanel');
const TestsPanel = lazyNamed(() => import('./TestsPanel.tsx'), 'TestsPanel');
import type { DebugCommand } from '../utils/debugClient.ts';

interface ExecutionPanelProps {
  logs: LogEntry[];
  tables: TableData[];
  files: FileItem[];
  activeFile: FileItem | null;
  onClearLogs: () => void;
  /** Present after a failed run: sends the code and error to the AI chat */
  onFixWithAI?: () => void;
  isRunning: boolean;
  /** Present while a program is running and accepts stdin */
  onSendInput?: (text: string) => void;
  activeTab: 'console' | 'preview' | 'table' | 'shell' | 'debug' | 'tests';
  onSelectTab: (tab: 'console' | 'preview' | 'table' | 'shell' | 'debug' | 'tests') => void;
  /** Save editor changes before project tests run */
  onBeforeTests?: () => Promise<void>;
  debug: DebugUiState | null;
  onDebugCommand: (cmd: DebugCommand) => void;
  onDebugStop: () => void;
  onDebugEvaluate: (expr: string) => void;
  watches: string[];
  onAddWatch: (expr: string) => void;
  onRemoveWatch: (expr: string) => void;
  onOpenFrame: (file: string, line: number) => void;
  /** Increases after every autosave: the web preview reloads with the saved files */
  previewVersion: number;
  /** Current project: shell terminals open in its folder */
  projectId: string | null;
  height: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export const ExecutionPanel: React.FC<ExecutionPanelProps> = ({
  logs,
  tables,
  files,
  activeFile,
  onClearLogs,
  onFixWithAI,
  isRunning,
  onSendInput,
  activeTab,
  onSelectTab,
  projectId,
  onBeforeTests,
  debug,
  onDebugCommand,
  onDebugStop,
  onDebugEvaluate,
  watches,
  onAddWatch,
  onRemoveWatch,
  onOpenFrame,
  previewVersion,
  height,
  collapsed,
  onToggleCollapsed,
}) => {
  const { t } = useI18n();
  const [deviceMode, setDeviceMode] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [previewKey, setPreviewKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [testsVisited, setTestsVisited] = useState(false);
  if (activeTab === 'tests' && !testsVisited) setTestsVisited(true);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputValue, setInputValue] = useState('');

  // The program printed a prompt without a newline (e.g. input("Name? ")): it is probably waiting for input
  const lastLog = logs[logs.length - 1];
  const awaitingInput = !!onSendInput && !!lastLog && lastLog.id.startsWith('p-') && !lastLog.final && lastLog.type === 'log';

  useEffect(() => {
    if (awaitingInput && activeTab === 'console') inputRef.current?.focus();
  }, [awaitingInput, activeTab]);

  useEffect(() => {
    if (!onSendInput) setInputValue('');
  }, [onSendInput]);

  const submitInput = () => {
    if (!onSendInput) return;
    onSendInput(inputValue);
    setInputValue('');
  };

  // Auto-scroll to bottom of terminal when logs change
  useEffect(() => {
    if (activeTab === 'console') {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, activeTab, onFixWithAI]);

  const hasHtml = files.some((f) => f.language === 'html');
  const [selectedTable, setSelectedTable] = useState(0);
  const tableIndex = Math.min(selectedTable, Math.max(0, tables.length - 1));
  const currentTable: TableData | undefined = tables[tableIndex];
  // A new run starts from the last result set (usually the final report query)
  useEffect(() => setSelectedTable(Math.max(0, tables.length - 1)), [tables]);

  const isSql = activeFile?.language === 'sql' || tables.length > 0;

  const handleCopyLogs = () => {
    const text = logs.map((l) => `[${l.timestamp}] [${l.type.toUpperCase()}] ${stripAnsi(l.message)}`).join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadCsv = () => {
    if (!currentTable) return;
    const cell = (v: unknown) => (v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`);
    const csvContent = [
      currentTable.columns.map(cell).join(','),
      ...currentTable.rows.map((row) => row.map(cell).join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'query_results.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const getLogColor = (type: LogEntry['type']) => {
    switch (type) {
      case 'error':
        return 'text-rose-400 bg-rose-950/20 border-l-2 border-rose-500';
      case 'warn':
        return 'text-amber-400 bg-amber-950/20 border-l-2 border-amber-500';
      case 'info':
        return 'text-sky-300';
      case 'system':
        return 'text-slate-400 font-semibold';
      case 'success':
        return 'text-emerald-400 font-medium';
      default:
        return 'text-slate-200';
    }
  };

  // ---------- live web preview (project files served at /preview/<project>/...) ----------
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f.name));
  const defaultPage =
    htmlFiles.find((f) => f.isEntry)?.name ||
    htmlFiles.find((f) => f.name.toLowerCase() === 'index.html')?.name ||
    (activeFile && /\.html?$/i.test(activeFile.name) ? activeFile.name : htmlFiles[0]?.name) ||
    '';
  const [selectedPage, setPage] = useState(defaultPage);
  // Right after switching projects the selected page may not exist there yet: fall back to the default
  const page = htmlFiles.some((f) => f.name === selectedPage) ? selectedPage : defaultPage;
  const [autoReload, setAutoReload] = useState(true);
  // Path the preview is showing now (follows clicks on links inside the page)
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // The preview is served on its own port (another origin): ask the server which one
  const [previewPort, setPreviewPort] = useState(0);
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setPreviewPort(d.previewPort || 0))
      .catch(() => {});
  }, []);
  const previewBase =
    projectId && previewPort ? `${location.protocol}//${location.hostname}:${previewPort}/preview/${encodeURIComponent(projectId)}/` : '';
  const pageUrl = (p: string) => previewBase + p.split('/').map(encodeURIComponent).join('/');

  // Scrollbars inside the preview follow the studio's theme (the page itself keeps its own design)
  const { theme } = useTheme();
  const sendTheme = () => {
    try {
      iframeRef.current?.contentWindow?.postMessage({ source: 'scriptcraft-studio', type: 'theme', theme }, '*');
    } catch {
      // the page is still loading
    }
  };
  useEffect(sendTheme, [theme]);

  useEffect(() => {
    if (!htmlFiles.some((f) => f.name === page)) setPage(defaultPage);
  }, [htmlFiles.map((f) => f.name).join('|'), defaultPage]);
  useEffect(() => setCurrentPath(null), [page, projectId]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.source === 'scriptcraft-preview' && e.data.type === 'location' && previewPort && e.origin.endsWith(`:${previewPort}`)) {
        setCurrentPath(`${e.origin}${e.data.message}`);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [previewPort]);

  // After each save: reload the page the user is on (not necessarily the one selected in the list)
  useEffect(() => {
    if (!autoReload || activeTab !== 'preview' || !iframeRef.current) return;
    iframeRef.current.src = currentPath || pageUrl(page);
  }, [previewVersion]);

  return (
    <div 
      data-tour="panel"
      className="border-t border-slate-800 bg-bar flex flex-col shrink-0"
      style={{ height: collapsed ? 37 : height }}
    >
      {/* Panel Navigation Bar */}
      <div className="h-9 px-3 bg-canvas border-b border-slate-800 flex items-center justify-between select-none">
        <div className="flex items-center gap-1">
          {/* Console Tab */}
          <button
            onClick={() => onSelectTab('console')}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded font-medium transition-colors ${
              activeTab === 'console'
                ? 'bg-active text-fg shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>{t('exec.terminal')}</span>
            {logs.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-400 ml-1">
                {logs.length}
              </span>
            )}
            {isRunning && (
              <Loader2 className="w-3 h-3 text-amber-400 animate-spin ml-1" />
            )}
          </button>

          {/* Debugger */}
          <button
            onClick={() => onSelectTab('debug')}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded font-medium transition-colors ${
              activeTab === 'debug' ? 'bg-active text-fg shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Bug className={`w-3.5 h-3.5 ${debug?.status === 'paused' ? 'text-amber-400' : 'text-rose-400'}`} />
            <span>{t('debug.tab')}</span>
            {debug?.status === 'paused' && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
          </button>

          {/* Project tests (pytest / node --test) */}
          <button
            data-tab="tests"
            onClick={() => onSelectTab('tests')}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded font-medium transition-colors ${
              activeTab === 'tests' ? 'bg-active text-fg shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FlaskConical className="w-3.5 h-3.5 text-violet-400" />
            <span>{t('tests.tab')}</span>
          </button>

          {/* Shell terminals (PowerShell / cmd / Git Bash) */}
          <button
            onClick={() => onSelectTab('shell')}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded font-medium transition-colors ${
              activeTab === 'shell' ? 'bg-active text-fg shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <SquareTerminal className="w-3.5 h-3.5 text-emerald-400" />
            <span>{t('shell.tab')}</span>
          </button>

          {/* Web Preview Tab (if HTML exists) */}
          {hasHtml && (
            <button
              onClick={() => onSelectTab('preview')}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded font-medium transition-colors ${
                activeTab === 'preview'
                  ? 'bg-active text-fg shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Globe className="w-3.5 h-3.5 text-sky-400" />
              <span>{t('exec.preview')}</span>
            </button>
          )}

          {/* SQL Table Tab */}
          {isSql && (
            <button
              onClick={() => onSelectTab('table')}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded font-medium transition-colors ${
                activeTab === 'table'
                  ? 'bg-active text-fg shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Database className="w-3.5 h-3.5 text-indigo-400" />
              <span>{t('exec.table')}</span>
            </button>
          )}
        </div>

        {/* Tab-specific Actions */}
        <div className="flex items-center gap-2">
          {activeTab === 'console' && (
            <>
              <button
                onClick={handleCopyLogs}
                disabled={logs.length === 0}
                className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-30"
                title={t('exec.copyLogs')}
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={onClearLogs}
                disabled={logs.length === 0}
                className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-30"
                title={t('exec.clear')}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}

          {activeTab === 'preview' && (
            <div className="flex items-center gap-1 text-slate-400">
              <button
                onClick={() => setDeviceMode('desktop')}
                className={`p-1 rounded ${deviceMode === 'desktop' ? 'bg-slate-800 text-fg' : 'hover:bg-slate-800'}`}
                title={t('exec.desktop')}
              >
                <Monitor className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setDeviceMode('tablet')}
                className={`p-1 rounded ${deviceMode === 'tablet' ? 'bg-slate-800 text-fg' : 'hover:bg-slate-800'}`}
                title={t('exec.tablet')}
              >
                <Tablet className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setDeviceMode('mobile')}
                className={`p-1 rounded ${deviceMode === 'mobile' ? 'bg-slate-800 text-fg' : 'hover:bg-slate-800'}`}
                title={t('exec.mobile')}
              >
                <Smartphone className="w-3.5 h-3.5" />
              </button>
              <div className="h-4 w-px bg-slate-800 mx-1" />
              {htmlFiles.length > 1 && (
                <select
                  value={page}
                  onChange={(e) => setPage(e.target.value)}
                  className="bg-panel border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 max-w-[160px] focus:outline-none"
                  title={t('exec.previewPage')}
                >
                  {htmlFiles.map((f) => (
                    <option key={f.id} value={f.name}>
                      {f.name}
                    </option>
                  ))}
                </select>
              )}
              <label className="flex items-center gap-1 text-[11px] cursor-pointer px-1" title={t('exec.autoReloadTitle')}>
                <input type="checkbox" checked={autoReload} onChange={(e) => setAutoReload(e.target.checked)} />
                {t('exec.autoReload')}
              </label>
              <button
                onClick={() => setPreviewKey((k) => k + 1)}
                className="p-1 rounded hover:bg-slate-800"
                title={t('exec.reload')}
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => window.open(currentPath || pageUrl(page), '_blank')}
                disabled={!projectId || !page}
                className="p-1 rounded hover:bg-slate-800 disabled:opacity-30"
                title={t('exec.openInBrowser')}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {activeTab === 'table' && currentTable && (
            <button
              onClick={handleDownloadCsv}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 text-slate-300 hover:text-fg text-xs"
              title={t('exec.downloadCsv')}
            >
              <Download className="w-3 h-3" />
              <span>{t('exec.exportCsv')}</span>
            </button>
          )}

          {/* Height Expand/Collapse */}
          <div className="h-4 w-px bg-slate-800 mx-1" />
          <button
            onClick={onToggleCollapsed}
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            title={collapsed ? t('exec.expand') : t('exec.collapse')}
          >
            {collapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Panel Content Area */}
      <div
        className={`flex-1 bg-deep relative ${activeTab === 'shell' ? 'overflow-hidden' : 'overflow-auto'} ${collapsed ? 'hidden' : ''}`}
      >
        {/* Kept mounted while other tabs are shown, so shell sessions keep running */}
        <Suspense fallback={null}>
          <ShellTerminals projectId={projectId} active={activeTab === 'shell' && !collapsed} />
          {/* Kept mounted once opened, so a test run survives switching tabs */}
          {testsVisited && (
            <div className={activeTab === 'tests' ? 'h-full' : 'hidden'}>
              <TestsPanel projectId={projectId} files={files} onBeforeRun={onBeforeTests || (async () => {})} onOpenFile={onOpenFrame} />
            </div>
          )}
          {activeTab === 'debug' && (
            <DebugPanel state={debug} onCommand={onDebugCommand} onStop={onDebugStop} onEvaluate={onDebugEvaluate} onOpenFrame={onOpenFrame} watches={watches} onAddWatch={onAddWatch} onRemoveWatch={onRemoveWatch} />
          )}
        </Suspense>
        {/* Console View */}
        {activeTab === 'console' && (
          <div className="p-3 font-mono text-xs space-y-1">
            {logs.length === 0 ? (
              <div className="text-slate-600 select-none py-4 text-center">
                {t('exec.idle')}
              </div>
            ) : (
              logs.map((log) => (
                <div
                  key={log.id}
                  className={`flex items-start gap-2.5 px-2 py-0.5 rounded leading-relaxed whitespace-pre-wrap break-all ${getLogColor(
                    log.type
                  )}`}
                >
                  <span className="text-[10px] text-slate-400 select-none shrink-0 font-mono mt-0.5">
                    {log.timestamp}
                  </span>
                  <span className="flex-1">{renderAnsi(log.message)}</span>
                </div>
              ))
            )}
            {onFixWithAI && (
              <div className="flex items-center gap-2 px-2 pt-2">
                <button
                  onClick={onFixWithAI}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-sans font-semibold shadow"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{t('exec.fixWithAI')}</span>
                </button>
                <span className="text-[11px] font-sans text-slate-500">{t('exec.fixHint')}</span>
              </div>
            )}
            <div ref={terminalEndRef} />
          </div>
        )}

        {/* Program input (stdin) while a program is running */}
        {activeTab === 'console' && onSendInput && (
          <div className="sticky bottom-0 px-3 py-1.5 bg-deep border-t border-slate-800">
            <div
              className={`flex items-center gap-2 rounded-md border px-2 py-1 bg-canvas transition-colors ${
                awaitingInput ? 'border-indigo-500 ring-1 ring-indigo-500/40' : 'border-slate-700'
              }`}
            >
              <span className="text-indigo-400 font-mono text-xs select-none">›</span>
              <input
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submitInput();
                  }
                }}
                placeholder={awaitingInput ? t('exec.inputWaiting') : t('exec.inputPlaceholder')}
                className="flex-1 bg-transparent text-xs font-mono text-fg placeholder-slate-500 focus:outline-none"
              />
              <button
                onClick={submitInput}
                className="p-1 rounded text-slate-400 hover:text-fg hover:bg-slate-800"
                title={t('exec.inputSend')}
              >
                <CornerDownLeft className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Live Web Preview View */}
        {activeTab === 'preview' && (
          <div className="w-full h-full bg-void flex items-center justify-center p-2">
            <div
              className="h-full bg-white rounded shadow-xl overflow-hidden transition-all duration-300 border border-slate-700"
              style={{
                width:
                  deviceMode === 'mobile'
                    ? '375px'
                    : deviceMode === 'tablet'
                    ? '768px'
                    : '100%',
              }}
            >
              {projectId && page && previewBase ? (
                // Served from another origin (preview port), so it is isolated from the studio API
                <iframe
                  ref={iframeRef}
                  key={`${previewKey}-${page}-${projectId}`}
                  title="Web App Preview"
                  src={pageUrl(page)}
                  sandbox="allow-scripts allow-modals allow-forms allow-popups allow-same-origin"
                  onLoad={sendTheme}
                  className="w-full h-full border-none"
                />
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-slate-500">{t('exec.noHtml')}</div>
              )}
            </div>
          </div>
        )}

        {/* SQL Data Grid View */}
        {activeTab === 'table' && (
          <div className="w-full h-full flex flex-col">
            {tables.length > 1 && (
              <div className="flex items-center gap-1 px-2 pt-2 flex-wrap">
                {tables.map((tbl, i) => (
                  <button
                    key={i}
                    onClick={() => setSelectedTable(i)}
                    title={tbl.statement}
                    className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                      i === tableIndex ? 'bg-indigo-600 text-white' : 'bg-panel text-slate-400 hover:text-fg'
                    }`}
                  >
                    {t('exec.resultN', { n: i + 1, rows: tbl.totalRows ?? tbl.rows.length })}
                  </button>
                ))}
              </div>
            )}
            <div className="flex-1 p-2 overflow-auto">
              {currentTable && currentTable.columns.length > 0 ? (
                <>
                  {currentTable.statement && (
                    <div className="text-[10px] font-mono text-slate-500 mb-1.5 truncate" title={currentTable.statement}>
                      {currentTable.statement}
                    </div>
                  )}
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="bg-panel border-b border-slate-700 text-slate-300 font-mono">
                        {currentTable.columns.map((col, idx) => (
                          <th key={idx} className="p-2 font-semibold">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 text-slate-300 font-mono">
                      {currentTable.rows.map((row, rIdx) => (
                        <tr key={rIdx} className="hover:bg-panel/50 transition-colors">
                          {row.map((cell, cIdx) => (
                            <td key={cIdx} className="p-2 whitespace-nowrap">
                              {cell === null ? (
                                <span className="text-slate-500 italic">NULL</span>
                              ) : typeof cell === 'number' ? (
                                <span className="text-emerald-400">{cell}</span>
                              ) : (
                                String(cell)
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {currentTable.rows.length === 0 && (
                    <div className="text-slate-500 text-center py-3 text-xs">{t('exec.emptyResult')}</div>
                  )}
                </>
              ) : (
                <div className="text-slate-600 text-center py-6 text-xs">{t('exec.noTable')}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
