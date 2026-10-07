import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { Header } from './components/Header.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { ExecutionPanel } from './components/ExecutionPanel.tsx';
import { ResizeHandle, usePersistentSize } from './components/ResizeHandle.tsx';
import { QuickOpen } from './components/QuickOpen.tsx'; // small; must catch keystrokes right after Ctrl+P
import { lazyNamed, Deferred } from './utils/lazy.tsx';
import { stripAnsi } from './utils/ansi.tsx';
import type { DebugUiState } from './components/DebugPanel.tsx';
import { startDebugSession, debuggableLanguage, type Breakpoints, type DebugSessionHandle, type DebugCommand } from './utils/debugClient.ts';
import { getSelectedModelId } from './utils/models.ts';
import {
  projectsApi,
  filesToPayload,
  payloadToFiles,
  downloadProjectZip,
  readImportedFiles,
  PickedFile,
  ProjectData,
  ProjectFilePayload,
} from './utils/projects.ts';
import { FileItem, FileLanguage, LogEntry, TableData, ProjectAsset } from './types.ts';
import { TEMPLATE_PROJECTS, ALL_TEMPLATES, INITIAL_FILES, detectLanguageFromName } from './utils/presets.ts';
import { 
  executeJavaScript, 
  executePython, 
  executeBash, 
  executeSQL, 
  generateId, 
  getTimestamp 
} from './utils/execution.ts';
import { startInteractiveRun, attachRunStream, InteractiveRun, RunOutcome } from './utils/interactiveRun.ts';
import { t, useI18n, aiLanguageInstruction, getLang } from './i18n.ts';

export default function App() {
  useI18n();
  const [files, setFiles] = useState<FileItem[]>(INITIAL_FILES);
  const [currentProject, setCurrentProject] = useState<{ id: string; name: string } | null>(null);
  const [saveStatus, setSaveStatus] = useState<'saving' | 'saved' | 'error' | 'idle'>('idle');
  const [isProjectsOpen, setIsProjectsOpen] = useState(false);
  const [isPackagesOpen, setIsPackagesOpen] = useState(false);
  const [historyFor, setHistoryFor] = useState<{ file: string | null } | null>(null);
  const [isQuickOpen, setIsQuickOpen] = useState(false);
  const [isBuildExeOpen, setIsBuildExeOpen] = useState(false);
  const [isRunConfigOpen, setIsRunConfigOpen] = useState(false);
  // Non-text files of the project (images, SQLite databases...) and the one open in the viewer
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [viewAsset, setViewAsset] = useState<string | null>(null);
  // Split editor: a second file on the right (Ctrl+\)
  const [splitFileId, setSplitFileId] = useState<string | null>(null);
  const [splitWidth, setSplitWidth] = usePersistentSize('scriptcraft-split-width', 520);
  const [isHotkeysOpen, setIsHotkeysOpen] = useState(false);
  const [isAiSettingsOpen, setIsAiSettingsOpen] = useState(false);
  // Bumped after every autosave so the web preview shows the saved files
  const [previewVersion, setPreviewVersion] = useState(0);
  // Left panel: file explorer or project-wide search
  const [sidebarView, setSidebarView] = useState<'files' | 'search' | 'git'>('files');
  const [searchFocusNonce, setSearchFocusNonce] = useState(0);
  const [reveal, setReveal] = useState<{ fileId: string; line: number; column: number; length: number; nonce: number } | null>(null);
  const openSearch = () => {
    setSidebarView('search');
    setSearchFocusNonce((n) => n + 1);
  };
  // Next autosave should keep a version of the previous content (AI edits, restores)
  const forceSnapshotRef = useRef(false);
  const currentProjectRef = useRef<{ id: string; name: string } | null>(null);
  const pendingSaveRef = useRef<(() => Promise<void>) | null>(null);
  /** Save pending edits before a run (a failed save just means the run uses a temporary copy). */
  const saveBeforeRun = async () => {
    const pending = pendingSaveRef.current;
    if (pending) await pending().catch(() => {});
  };
  const skipNextSaveRef = useRef(false);
  const filesRef = useRef(files);
  filesRef.current = files;
  const [activeFileId, setActiveFileId] = useState<string>(INITIAL_FILES[0].id);
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: 'init-log',
      type: 'system',
      message: t('app.init'),
      timestamp: getTimestamp(),
    },
  ]);
  const [tables, setTables] = useState<TableData[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = usePersistentSize('scriptcraft-sidebar-w', 256);
  const [chatWidth, setChatWidth] = usePersistentSize('scriptcraft-chat-w', 384);
  const [panelHeight, setPanelHeight] = usePersistentSize('scriptcraft-panel-h', 256);
  // 1 = terminal collapsed down to its tab bar (stored as a number by usePersistentSize)
  const [panelCollapsedNum, setPanelCollapsedNum] = usePersistentSize('scriptcraft-panel-collapsed', 2);
  const panelCollapsed = panelCollapsedNum === 1;
  const setPanelCollapsed = (v: boolean) => setPanelCollapsedNum(v ? 1 : 2);
  const [executionTab, setExecutionTab] = useState<'console' | 'preview' | 'table' | 'shell' | 'debug' | 'tests'>('console');

  const [openTabIds, setOpenTabIds] = useState<string[]>([INITIAL_FILES[0].id]);
  const activeFile = files.find((f) => f.id === activeFileId) || null;

  // Any file that becomes active gets an editor tab
  useEffect(() => {
    if (activeFileId && !openTabIds.includes(activeFileId)) {
      setOpenTabIds((prev) => [...prev, activeFileId]);
    }
  }, [activeFileId]);

  const tabFiles = openTabIds
    .map((id) => files.find((f) => f.id === id))
    .filter((f): f is FileItem => !!f);

  // Closing a tab only hides the file from the editor; it is not deleted
  const handleCloseTab = (fileId: string) => {
    const idx = openTabIds.indexOf(fileId);
    const nextTabs = openTabIds.filter((id) => id !== fileId);
    setOpenTabIds(nextTabs);
    if (activeFileId === fileId) {
      setActiveFileId(nextTabs[Math.min(idx, nextTabs.length - 1)] || '');
    }
  };

  // Add a log entry
  const addLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => [...prev, entry]);
  }, []);

  // Add a line, or replace the line with the same id (lines streamed from a running program)
  const upsertLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => {
      for (let i = prev.length - 1; i >= Math.max(0, prev.length - 200); i--) {
        if (prev[i].id === entry.id) {
          const next = prev.slice();
          next[i] = entry;
          return next;
        }
      }
      return [...prev, entry];
    });
  }, []);

  const [activeRun, setActiveRun] = useState<InteractiveRun | null>(null);
  const [lastFailure, setLastFailure] = useState<{
    fileId: string;
    name: string;
    language: string;
    code: string;
    errorText: string;
  } | null>(null);
  const [aiRequest, setAiRequest] = useState<{ id: number; prompt: string; display: string } | null>(null);

  const handleStopRun = useCallback(() => {
    activeRun?.stop().catch(() => {});
  }, [activeRun]);

  // Listen for iframe postMessage logs from Live Web Preview
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Only the web preview (another localhost port) may send these
      const fromPreview = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(event.origin) && event.origin !== location.origin;
      if (fromPreview && event.data && event.data.source === 'scriptcraft-preview' && event.data.type !== 'location') {
        addLog({
          id: generateId(),
          type: event.data.type || 'log',
          message: t('app.preview', { message: event.data.message }),
          timestamp: getTimestamp(),
        });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [addLog]);

  // Execute active file based on its language
  const entryFile = files.find((f) => f.isEntry) || null;

  // ---------- debugger ----------
  // Breakpoints per project: file name -> lines (kept in this browser)
  const [breakpoints, setBreakpoints] = useState<Breakpoints>({});
  const breakpointsRef = useRef<Breakpoints>({});
  breakpointsRef.current = breakpoints;
  const [debugUi, setDebugUi] = useState<DebugUiState | null>(null);
  const debugRef = useRef<DebugSessionHandle | null>(null);

  useEffect(() => {
    const id = currentProject?.id;
    if (!id) return setBreakpoints({});
    try {
      setBreakpoints(JSON.parse(localStorage.getItem(`scriptcraft-bp-${id}`) || '{}'));
    } catch {
      setBreakpoints({});
    }
  }, [currentProject?.id]);

  const updateBreakpoints = (fileName: string, lines: number[]) => {
    const next = { ...breakpointsRef.current, [fileName]: lines };
    if (lines.length === 0) delete next[fileName];
    setBreakpoints(next);
    breakpointsRef.current = next;
    try {
      if (currentProjectRef.current) localStorage.setItem(`scriptcraft-bp-${currentProjectRef.current.id}`, JSON.stringify(next));
    } catch {
      // storage unavailable
    }
    debugRef.current?.setBreakpoints(next); // a running session picks them up immediately
  };

  // The file on the right side of the split editor (closed when that file is deleted)
  const splitFile = splitFileId ? files.find((f) => f.id === splitFileId) || null : null;
  const splitStateRef = useRef({ split: splitFileId, tabs: openTabIds, active: activeFileId });
  splitStateRef.current = { split: splitFile?.id || null, tabs: openTabIds, active: activeFileId };

  /** Open / close the split editor; it starts with another open tab (or the same file) */
  const toggleSplit = () => {
    const { split, tabs, active } = splitStateRef.current;
    if (split) return setSplitFileId(null);
    const other = tabs.find((id) => id !== active);
    setSplitFileId(other || active || null);
  };

  const openFileAt = (fileName: string, line: number) => {
    const f = filesRef.current.find((x) => x.name === fileName);
    if (!f) return;
    setActiveFileId(f.id);
    setReveal({ fileId: f.id, line, column: 1, length: 0, nonce: Date.now() });
  };

  const handleDebug = useCallback(async () => {
    if (debugRef.current) return;
    const file = entryFile || activeFile;
    if (!file || isRunning) return;
    const language = debuggableLanguage(file.name);
    if (!language) {
      addLog({ id: generateId(), type: 'warn', message: t('debug.unsupported'), timestamp: getTimestamp() });
      return;
    }
    setIsRunning(true);
    setPanelCollapsed(false);
    setLastFailure(null);
    setExecutionTab('debug');
    addLog({ id: generateId(), type: 'system', message: t('debug.starting', { name: file.name }), timestamp: getTimestamp() });
    try {
      await saveBeforeRun();
      const handle = await startDebugSession({
        language,
        code: file.content,
        files: filesRef.current.map((f) => ({ name: f.name, content: f.content })),
        entry: file.name,
        projectId: currentProjectRef.current?.id || null,
        breakpoints: breakpointsRef.current,
        upsertLog,
        onStopped: (stopped) => {
          setDebugUi((prev) => ({ status: 'paused', stopped, evals: prev?.evals || [] }));
          if (stopped.file) {
            const f = filesRef.current.find((x) => x.name === stopped.file);
            if (f) setActiveFileId(f.id);
          }
          setExecutionTab('debug');
        },
        onRunning: () => setDebugUi((prev) => (prev ? { ...prev, status: 'running' } : prev)),
        onEval: (r) => setDebugUi((prev) => (prev ? { ...prev, evals: [...prev.evals, r] } : prev)),
      });
      debugRef.current = handle;
      setActiveRun(handle.run);
      setDebugUi({ status: 'running', stopped: null, evals: [] });
      await handle.run.done;
    } catch (err: any) {
      addLog({ id: generateId(), type: 'error', message: t('debug.failed', { error: err?.message || String(err) }), timestamp: getTimestamp() });
    } finally {
      debugRef.current = null;
      setActiveRun(null);
      setDebugUi(null);
      setIsRunning(false);
    }
  }, [entryFile, activeFile, isRunning, addLog, upsertLog]);

  const debugCommand = (cmd: DebugCommand) => {
    if (debugUi?.status === 'paused') debugRef.current?.command(cmd);
  };
  const runTarget = entryFile || activeFile;

  const handleRunCode = useCallback(async (runActive = false) => {
    const file = (runActive ? activeFile : entryFile || activeFile) || null;
    if (!file || isRunning) return;
    setIsRunning(true);
    setPanelCollapsed(false);
    setTables([]);
    setLastFailure(null);

    // Auto-switch execution tab based on file language
    if (file.language === 'html' || file.language === 'css') {
      setExecutionTab('preview');
    } else if (file.language === 'sql') {
      setExecutionTab('table');
    } else {
      setExecutionTab('console');
    }

    addLog({
      id: generateId(),
      type: 'system',
      message: t('app.running', { name: file.name, lang: file.language }),
      timestamp: getTimestamp(),
    });

    // Collect error output of this run so it can be handed to the AI ("Fix with AI")
    const errorLines: string[] = [];
    const track = (e: LogEntry) => {
      const complete = !e.id.startsWith('p-') || e.final;
      if (e.type === 'error' && complete && e.message.trim()) errorLines.push(stripAnsi(e.message));
    };
    const addLogTracked = (e: LogEntry) => {
      track(e);
      addLog(e);
    };
    const upsertLogTracked = (e: LogEntry) => {
      track(e);
      upsertLog(e);
    };

    let success = true;
    let stopped = false;
    try {
      if (['python', 'javascript', 'typescript', 'bash'].includes(file.language)) {
        // Run on the local server with live output, stdin and a Stop button
        // The whole project is sent so files can import each other; when it is saved, the program runs
        // in the project folder itself (files it creates stay in the project)
        await saveBeforeRun();
        const run = await startInteractiveRun(file.language, file.content, upsertLogTracked, {
          files: files.map((f) => ({ name: f.name, content: f.content })),
          entry: file.name,
          projectId: currentProjectRef.current?.id,
        });
        if (run) {
          setActiveRun(run);
          try {
            const outcome = await run.done;
            success = outcome.success;
            stopped = !!outcome.stopped;
          } finally {
            setActiveRun(null);
          }
        } else if (file.language === 'python') {
          // Server unreachable: fall back to the in-browser runners
          success = (await executePython(file.content, addLogTracked)).success;
        } else if (file.language === 'bash') {
          success = (await executeBash(file.content, addLogTracked)).success;
        } else {
          success = (await executeJavaScript(file.content, addLogTracked)).success;
        }
      } else if (file.language === 'sql') {
        const res = await executeSQL(file.content, addLogTracked);
        success = res.success;
        setTables(res.tables);
        // Errors are reported in the terminal
        if (!res.success || res.tables.length === 0) setExecutionTab('console');
      } else if (file.language === 'html' || file.language === 'css') {
        addLog({
          id: generateId(),
          type: 'success',
          message: t('app.htmlUpdated'),
          timestamp: getTimestamp(),
        });
      } else {
        addLog({
          id: generateId(),
          type: 'info',
          message: t('app.saved', { name: file.name }),
          timestamp: getTimestamp(),
        });
      }
    } catch (err: any) {
      success = false;
      addLogTracked({
        id: generateId(),
        type: 'error',
        message: t('app.execFailed', { error: err.message || String(err) }),
        timestamp: getTimestamp(),
      });
    } finally {
      setIsRunning(false);
    }

    if (!success && !stopped) {
      setLastFailure({
        fileId: file.id,
        name: file.name,
        language: file.language,
        code: file.content,
        errorText: errorLines.slice(-60).join('\n'),
      });
    }
  }, [activeFile, entryFile, isRunning, addLog, upsertLog, files]);

  // Agent mode: create or overwrite project files proposed by the AI
  const handleApplyAgentFiles = (changes: { name: string; content: string }[]) => {
    forceSnapshotRef.current = true;
    const now = Date.now();
    const next = filesRef.current.slice();
    let lastTouchedId = '';
    changes.forEach((ch, i) => {
      const idx = next.findIndex((f) => f.name.toLowerCase() === ch.name.toLowerCase());
      if (idx >= 0) {
        next[idx] = { ...next[idx], content: ch.content, updatedAt: now };
        lastTouchedId = next[idx].id;
      } else {
        const item: FileItem = {
          id: `file-${now}-a${i}`,
          name: ch.name,
          language: detectLanguageFromName(ch.name),
          content: ch.content,
          updatedAt: now,
        };
        next.push(item);
        lastTouchedId = item.id;
      }
    });
    filesRef.current = next;
    setFiles(next);
    // Show the last changed file in the editor
    if (lastTouchedId) setActiveFileId(lastTouchedId);
  };

  // Python rename (F2) changed other project files: update them in place, the current file stays open
  const handleRenameInFiles = (changes: { name: string; content: string }[]) => {
    forceSnapshotRef.current = true;
    const byName = new Map(changes.map((c) => [c.name, c.content]));
    const next = filesRef.current.map((f) => (byName.has(f.name) ? { ...f, content: byName.get(f.name)!, updatedAt: Date.now() } : f));
    filesRef.current = next;
    setFiles(next);
    addLog({ id: generateId(), type: 'success', message: t('pyintel.renamed', { files: changes.length + 1 }), timestamp: getTimestamp() });
  };

  // Project search: open the file at the match / apply replacements (a version is kept in history)
  const handleSearchReveal = (fileId: string, line: number, column: number, length: number) => {
    setActiveFileId(fileId);
    setReveal({ fileId, line, column, length, nonce: Date.now() });
  };
  const handleSearchReplace = (changes: { fileId: string; content: string }[]) => {
    forceSnapshotRef.current = true;
    const byId = new Map(changes.map((c) => [c.fileId, c.content]));
    const next = filesRef.current.map((f) => (byId.has(f.id) ? { ...f, content: byId.get(f.id)!, updatedAt: Date.now() } : f));
    filesRef.current = next;
    setFiles(next);
    addLog({ id: generateId(), type: 'success', message: t('search.replaced', { files: changes.length }), timestamp: getTimestamp() });
  };

  // ★ main file: "Run" executes it whatever file is open (click again to unset)
  const handleToggleEntry = (fileId: string) => {
    setFiles((prev) => prev.map((f) => ({ ...f, isEntry: f.id === fileId ? !f.isEntry : false })));
  };

  // Restore a version from history (re-creates the file if it was deleted)
  const handleRestoreVersion = (name: string, content: string) => {
    forceSnapshotRef.current = true;
    const existing = filesRef.current.find((f) => f.name === name);
    if (existing) {
      handleUpdateFileContent(existing.id, content);
      setActiveFileId(existing.id);
    } else {
      handleApplyAgentFiles([{ name, content }]);
    }
    addLog({ id: generateId(), type: 'success', message: t('app.restored', { name }), timestamp: getTimestamp() });
  };

  // Show a package install/uninstall in the terminal (with the Stop button)
  const handlePackageSession = async (runId: string, label: string): Promise<RunOutcome> => {
    setPanelCollapsed(false);
    setExecutionTab('console');
    addLog({ id: generateId(), type: 'system', message: `▶ ${label}`, timestamp: getTimestamp() });
    const run = attachRunStream(runId, upsertLog);
    setActiveRun(run);
    setIsRunning(true);
    try {
      return await run.done;
    } finally {
      setActiveRun(null);
      setIsRunning(false);
    }
  };

  // Ruff (formatter, checks) or Jedi (Python completions) into the studio's tools folder; output in the terminal
  const handleInstallTool = async (tool: 'ruff' | 'jedi') => {
    const tools = await import('./codeTools.ts');
    try {
      const runId = await tools.startToolInstall(tool);
      const outcome = await handlePackageSession(runId, `pip install ${tool}`);
      if (!outcome.success && !outcome.stopped) throw new Error(`pip install ${tool}`);
    } catch {
      addLog({ id: generateId(), type: 'error', message: t('tools.installFailed'), timestamp: getTimestamp() });
    } finally {
      await tools.finishToolInstall();
    }
  };

  // Ask the AI chat to fix the last failed run
  const handleFixWithAI = () => {
    if (!lastFailure) return;
    const f = lastFailure;
    if (files.some((x) => x.id === f.fileId)) setActiveFileId(f.fileId);
    const errorText = f.errorText.length > 6000 ? '…' + f.errorText.slice(-6000) : f.errorText;
    const prompt =
      `The file "${f.name}" (${f.language}) fails when it is run in ScriptCraft Studio.\n\n` +
      `Error output:\n\`\`\`text\n${errorText || '(no error output, non-zero exit code)'}\n\`\`\`\n\n` +
      `Full file:\n\`\`\`${f.language}\n${f.code}\n\`\`\`\n\n` +
      `Find the root cause and explain it briefly. Then return the COMPLETE corrected file in a single ${f.language} code block ` +
      `(not a fragment), so it can replace the file as is.`;
    setAiRequest({ id: Date.now(), prompt, display: t('app.fixRequest', { name: f.name }) });
    setLastFailure(null);
  };

  // Fetch the dialogs' chunks once the studio is idle, so they open instantly (no lost keystrokes)
  useEffect(() => {
    const preload = () =>
      [SearchPanel, GitPanel, ScriptWizardModal, ProjectsModal, PackagesModal, HistoryModal, HotkeysModal, AiSettingsModal].forEach((c) => c.preload());
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(preload, { timeout: 3000 });
    else setTimeout(preload, 1500);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Debugger keys (F5 starts/continues, so the browser does not reload the page)
      if (e.key === 'F5' && !e.ctrlKey) {
        e.preventDefault();
        if (e.shiftKey) {
          if (debugRef.current) activeRun?.stop().catch(() => {});
        } else if (debugRef.current) debugCommand('continue');
        else handleDebug();
        return;
      }
      if (debugRef.current && (e.key === 'F10' || e.key === 'F11')) {
        e.preventDefault();
        debugCommand(e.key === 'F10' ? 'next' : e.shiftKey ? 'out' : 'step');
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRunCode(e.shiftKey);
      } else if (e.code === 'KeyF' && e.shiftKey) {
        e.preventDefault();
        openSearch();
      } else if (e.code === 'Backslash' && !e.shiftKey) {
        e.preventDefault();
        toggleSplit();
      } else if (e.code === 'KeyG' && e.shiftKey) {
        e.preventDefault();
        setSidebarView('git');
      } else if (e.code === 'KeyP' && !e.shiftKey) {
        e.preventDefault();
        setIsQuickOpen(true);
      } else if (e.code === 'Backquote') {
        e.preventDefault();
        setPanelCollapsed(!panelCollapsed);
      } else if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) {
        e.preventDefault();
        setIsHotkeysOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleRunCode, panelCollapsed, handleDebug, debugUi, activeRun]);

  // ---------- Projects (stored on disk under projects/, autosaved) ----------
  /** `focusName`: file to show first (e.g. a template's README), next to the main file */
  const openProjectData = useCallback((data: ProjectData, focusName?: string) => {
    const loaded = payloadToFiles(data.files);
    skipNextSaveRef.current = true;
    currentProjectRef.current = { id: data.id, name: data.name };
    setCurrentProject({ id: data.id, name: data.name });
    setFiles(loaded);
    const main = loaded.find((f) => f.isEntry) || loaded[0];
    const focus = (focusName && loaded.find((f) => f.name === focusName)) || main;
    setActiveFileId(focus?.id || '');
    setOpenTabIds([...new Set([main?.id, focus?.id].filter((x): x is string => !!x))]);
    setSaveStatus('saved');
    try {
      localStorage.setItem(LAST_PROJECT_KEY, data.id);
    } catch {
      // storage unavailable
    }
    setLogs([
      {
        id: generateId(),
        type: 'system',
        message: t('app.projectOpened', { name: data.name }),
        timestamp: getTimestamp(),
      },
    ]);
  }, []);

  const logError = useCallback(
    (err: any) =>
      addLog({
        id: generateId(),
        type: 'error',
        message: t('app.projectError', { error: err?.message || String(err) }),
        timestamp: getTimestamp(),
      }),
    [addLog]
  );

  // Save any pending (debounced) changes right away
  const flushSave = useCallback(async () => {
    const pending = pendingSaveRef.current;
    if (pending) await pending();
  }, []);

  const handleOpenProject = useCallback(
    async (id: string) => {
      try {
        await flushSave();
        openProjectData(await projectsApi.get(id));
      } catch (err) {
        logError(err);
      }
    },
    [flushSave, openProjectData, logError]
  );

  const handleCreateProject = async (name: string, templateId: string | null) => {
    const template = ALL_TEMPLATES.find((x) => x.id === templateId);
    const payload: ProjectFilePayload[] = template
      ? template.files.map((f) => ({ name: f.name, language: f.language, content: f.content, isEntry: f.isEntry }))
      : [defaultProjectFile()];
    await flushSave();
    const data = await projectsApi.create(name, payload);
    // A template opens on its README, so the next steps are in front of the user
    openProjectData(data, template?.files.some((f) => f.name === 'README.md') ? 'README.md' : undefined);
    if (template?.packages) void installTemplatePackages(data.id, template.packages);
  };

  /** Packages a template needs, installed into the new project (output in the terminal). */
  const installTemplatePackages = async (projectId: string, packages: { pip?: string[]; npm?: string[] }) => {
    for (const manager of ['pip', 'npm'] as const) {
      const list = packages[manager];
      if (!list?.length) continue;
      const label = `${manager} install ${list.join(' ')}`;
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/packages/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ manager, packages: list }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        const outcome = await handlePackageSession(data.runId, t('projects.installing', { list: label }));
        if (!outcome.success && !outcome.stopped) throw new Error(label);
      } catch {
        addLog({ id: generateId(), type: 'error', message: t('projects.installFailed', { list: list.join(', ') }), timestamp: getTimestamp() });
      }
    }
  };

  const handleImportAsProject = async (name: string, payload: ProjectFilePayload[]) => {
    await flushSave();
    openProjectData(await projectsApi.create(name, payload));
  };

  const handleProjectRenamed = (id: string, name: string) => {
    if (currentProjectRef.current?.id === id) {
      currentProjectRef.current = { id, name };
      setCurrentProject({ id, name });
    }
  };

  const handleProjectDeleted = async (id: string) => {
    if (currentProjectRef.current?.id !== id) return;
    pendingSaveRef.current = null;
    currentProjectRef.current = null;
    try {
      const list = await projectsApi.list();
      if (list.length > 0) {
        openProjectData(await projectsApi.get(list[0].id));
      } else {
        openProjectData(await projectsApi.create(t('projects.untitled'), [defaultProjectFile()]));
      }
    } catch (err) {
      logError(err);
    }
  };

  // Import files from the PC into the current project
  const handleImportFiles = async (picked: FileList | PickedFile[]) => {
    try {
      const { files: imported, skipped } = await readImportedFiles(picked, files.map((f) => f.name));
      if (imported.length > 0) {
        const newItems = payloadToFiles(imported);
        setFiles((prev) => [...prev, ...newItems]);
        setActiveFileId(newItems[0].id);
        addLog({
          id: generateId(),
          type: 'success',
          message: t('app.filesImported', { count: imported.length }),
          timestamp: getTimestamp(),
        });
      }
      if (skipped.length > 0) {
        addLog({
          id: generateId(),
          type: 'warn',
          message: t('projects.skipped', { files: skipped.join(', ') }),
          timestamp: getTimestamp(),
        });
      }
    } catch (err) {
      logError(err);
    }
  };

  // On startup: open the last used project, or create one from the first template
  useEffect(() => {
    (async () => {
      try {
        const list = await projectsApi.list();
        let lastId: string | null = null;
        try {
          lastId = localStorage.getItem(LAST_PROJECT_KEY);
        } catch {
          // storage unavailable
        }
        const target = list.find((p) => p.id === lastId) || list[0];
        if (target) {
          openProjectData(await projectsApi.get(target.id));
        } else {
          const tpl = TEMPLATE_PROJECTS[0];
          const label = t(`tpl.${tpl.id}`);
          openProjectData(
            await projectsApi.create(label.startsWith('tpl.') ? tpl.name : label, filesToPayload(INITIAL_FILES))
          );
        }
      } catch (err) {
        setSaveStatus('error');
        logError(err);
      }
    })();
  }, []);

  // Autosave the current project 800ms after the last change
  useEffect(() => {
    const project = currentProjectRef.current;
    if (!project) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    setSaveStatus('saving');
    const payload = filesToPayload(files);
    const doSave = async () => {
      if (pendingSaveRef.current === doSave) pendingSaveRef.current = null;
      try {
        const snapshot = forceSnapshotRef.current;
        forceSnapshotRef.current = false;
        await projectsApi.save(project.id, { files: payload, ...(snapshot ? { snapshot: true } : {}) });
        if (!pendingSaveRef.current) setSaveStatus('saved');
        setPreviewVersion((v) => v + 1);
      } catch (err) {
        setSaveStatus('error');
        logError(err);
      }
    };
    pendingSaveRef.current = doSave;
    const timer = setTimeout(doSave, 800);
    return () => clearTimeout(timer);
  }, [files, logError]);

  // ---------- sync with changes made on disk (shell terminal, other editors) ----------
  const syncFromDisk = useCallback(async () => {
    const project = currentProjectRef.current;
    if (!project) return;
    // Unsaved edits in the editor win: sync again after they are saved
    if (pendingSaveRef.current) {
      setTimeout(() => syncFromDiskRef.current(), 1200);
      return;
    }
    try {
      const data = await projectsApi.get(project.id, true);
      if (currentProjectRef.current?.id !== project.id || pendingSaveRef.current) return;
      const current = filesRef.current;
      const byName = new Map(data.files.map((f) => [f.name, f]));
      let changed = false;
      const next: FileItem[] = [];
      for (const f of current) {
        const disk = byName.get(f.name);
        if (!disk) {
          changed = true; // deleted on disk
          continue;
        }
        if (disk.content !== f.content) {
          changed = true;
          next.push({ ...f, content: disk.content, updatedAt: Date.now() });
        } else next.push(f);
        byName.delete(f.name);
      }
      const added = payloadToFiles([...byName.values()]);
      if (added.length) changed = true;
      if (!changed) return;
      const merged = [...next, ...added];
      skipNextSaveRef.current = true; // this is the disk's content already
      filesRef.current = merged;
      setFiles(merged);
      if (!merged.some((f) => f.id === activeFileId)) setActiveFileId(merged[0]?.id || '');
      addLog({ id: generateId(), type: 'info', message: t('app.diskSynced'), timestamp: getTimestamp() });
    } catch {
      // project switched or server restarting; the next change triggers another sync
    }
  }, [activeFileId, addLog]);
  const syncFromDiskRef = useRef(syncFromDisk);
  syncFromDiskRef.current = syncFromDisk;

  useEffect(() => {
    if (!currentProject?.id) return;
    const projectId = currentProject.id;
    const loadAssets = () =>
      fetch(`/api/projects/${encodeURIComponent(projectId)}/assets`)
        .then((r) => r.json())
        .then((d) => currentProjectRef.current?.id === projectId && setAssets(d.assets || []))
        .catch(() => {});
    setAssets([]);
    setViewAsset(null);
    loadAssets();
    const es = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/watch`);
    es.onmessage = () => {
      syncFromDiskRef.current();
      loadAssets(); // a program created or changed an image, a database...
    };
    return () => es.close();
  }, [currentProject?.id]);

  // Best-effort save if the window is closed during the debounce delay
  useEffect(() => {
    const onUnload = () => {
      const project = currentProjectRef.current;
      if (!pendingSaveRef.current || !project) return;
      fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: filesToPayload(filesRef.current) }),
        keepalive: true,
      });
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  // File management
  const handleUpdateFileContent = (fileId: string, newContent: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, content: newContent, updatedAt: Date.now() } : f))
    );
  };

  const isNameTaken = (name: string, exceptId?: string) =>
    files.some((f) => f.id !== exceptId && f.name.toLowerCase() === name.toLowerCase());

  const handleCreateFile = (name: string, language: FileLanguage) => {
    if (isNameTaken(name)) {
      alert(t('app.nameTaken', { name }));
      return;
    }
    const newFile: FileItem = {
      id: `file-${Date.now()}`,
      name,
      language,
      content: getDefaultContentForLanguage(name, language),
      updatedAt: Date.now(),
    };
    setFiles((prev) => [...prev, newFile]);
    setActiveFileId(newFile.id);
  };

  const handleRenameFile = (fileId: string, newName: string) => {
    if (isNameTaken(newName, fileId)) {
      alert(t('app.nameTaken', { name: newName }));
      return;
    }
    const newLang = detectLanguageFromName(newName);
    setFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, name: newName, language: newLang } : f))
    );
  };

  // Pick what to show after the active file disappears: another open tab, else any file
  const fallbackActive = (remaining: FileItem[], tabs: string[]) =>
    tabs.find((id) => remaining.some((f) => f.id === id)) || remaining[0]?.id || '';

  const handleDeleteFile = (fileId: string) => {
    const file = files.find((f) => f.id === fileId);
    if (!file || !confirm(t('app.confirmDeleteFile', { name: file.name }))) return;
    const remaining = files.filter((f) => f.id !== fileId);
    const tabs = openTabIds.filter((id) => id !== fileId);
    setFiles(remaining);
    setOpenTabIds(tabs);
    if (activeFileId === fileId) setActiveFileId(fallbackActive(remaining, tabs));
  };

  const handleDeleteFolder = (folderPath: string) => {
    const prefix = `${folderPath}/`;
    const remaining = files.filter((f) => !f.name.startsWith(prefix));
    if (remaining.length === files.length) return;
    const tabs = openTabIds.filter((id) => remaining.some((f) => f.id === id));
    setFiles(remaining);
    setOpenTabIds(tabs);
    if (!remaining.some((f) => f.id === activeFileId)) setActiveFileId(fallbackActive(remaining, tabs));
  };

  // Download the current project as ZIP to the PC
  const handleExportProject = async () => {
    try {
      await downloadProjectZip(currentProject?.name || 'project', files);
      addLog({
        id: generateId(),
        type: 'success',
        message: t('app.exported', { count: files.length }),
        timestamp: getTimestamp(),
      });
    } catch (err: any) {
      addLog({
        id: generateId(),
        type: 'error',
        message: t('app.exportFailed', { error: err.message }),
        timestamp: getTimestamp(),
      });
    }
  };

  // AI Actions on Editor Code
  const handleTriggerAIAction = async (action: 'explain' | 'refactor' | 'debug' | 'generate_tests') => {
    if (!activeFile) return;
    setExecutionTab('console');
    setPanelCollapsed(false);

    addLog({
      id: generateId(),
      type: 'info',
      message: t('app.aiRequest', { action, name: activeFile.name }),
      timestamp: getTimestamp(),
    });

    try {
      const res = await fetch('/api/code-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          code: activeFile.content,
          language: activeFile.language,
          model: getSelectedModelId(),
          responseLanguageInstruction: aiLanguageInstruction(),
          lang: getLang(),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);

      addLog({
        id: generateId(),
        type: 'success',
        message: t('app.aiDone'),
        timestamp: getTimestamp(),
      });

      addLog({
        id: generateId(),
        type: 'log',
        message: data.result,
        timestamp: getTimestamp(),
      });
    } catch (err: any) {
      addLog({
        id: generateId(),
        type: 'error',
        message: t('app.aiFailed', { error: err.message || String(err) }),
        timestamp: getTimestamp(),
      });
    }
  };

  // Direct insertions from AI ChatBot
  const handleInsertCodeToEditor = (snippet: string) => {
    if (!activeFile) return;
    const newContent = activeFile.content ? `${activeFile.content}\n\n${snippet}` : snippet;
    handleUpdateFileContent(activeFile.id, newContent);
    addLog({
      id: generateId(),
      type: 'info',
      message: t('app.inserted', { name: activeFile.name }),
      timestamp: getTimestamp(),
    });
  };

  const handleReplaceFileContent = (newContent: string) => {
    if (!activeFile) return;
    forceSnapshotRef.current = true;
    handleUpdateFileContent(activeFile.id, newContent);
    addLog({
      id: generateId(),
      type: 'info',
      message: t('app.replaced', { name: activeFile.name }),
      timestamp: getTimestamp(),
    });
  };

  const handleCreateNewFileWithCode = (rawFilename: string, code: string) => {
    // Avoid clashing with an existing file name (e.g. a second "script.py" from the AI)
    let filename = rawFilename;
    for (let n = 2; isNameTaken(filename); n++) {
      const dot = rawFilename.lastIndexOf('.');
      filename = dot > 0 ? `${rawFilename.slice(0, dot)}_${n}${rawFilename.slice(dot)}` : `${rawFilename}_${n}`;
    }
    const lang = detectLanguageFromName(filename);
    const newFile: FileItem = {
      id: `file-${Date.now()}`,
      name: filename,
      language: lang,
      content: code,
      updatedAt: Date.now(),
    };
    setFiles((prev) => [...prev, newFile]);
    setActiveFileId(newFile.id);
    addLog({
      id: generateId(),
      type: 'success',
      message: t('app.created', { name: filename }),
      timestamp: getTimestamp(),
    });
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-canvas text-slate-200">
      {/* Top Application Header */}
      <Header
        activeFile={activeFile}
        isRunning={isRunning}
        onRun={() => handleRunCode()}
        canStop={!!activeRun}
        onDebug={handleDebug}
        canDebug={!!(entryFile || activeFile) && !!debuggableLanguage((entryFile || activeFile)!.name)}
        onStop={handleStopRun}
        onOpenWizard={() => setIsWizardOpen(true)}
        onExportProject={handleExportProject}
        onBuildExe={() => setIsBuildExeOpen(true)}
        onOpenRunConfig={() => setIsRunConfigOpen(true)}
        projectName={currentProject?.name || '…'}
        saveStatus={saveStatus}
        onOpenProjects={() => setIsProjectsOpen(true)}
        runTargetName={runTarget?.name || null}
        onShowHotkeys={() => setIsHotkeysOpen(true)}
        onOpenAiSettings={() => setIsAiSettingsOpen(true)}
      />

      {/* Main Workspace Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Project Explorer Sidebar */}
        <div className="shrink-0 h-full" style={{ width: sidebarWidth }}>
          {sidebarView === 'search' ? (
            <Suspense fallback={null}>
            <SearchPanel
              files={files}
              onReveal={handleSearchReveal}
              onReplace={handleSearchReplace}
              onClose={() => setSidebarView('files')}
              focusNonce={searchFocusNonce}
            />
            </Suspense>
          ) : sidebarView === 'git' ? (
            <Suspense fallback={null}>
              <GitPanel
                projectId={currentProject?.id || null}
                files={files}
                onBeforeAction={flushSave}
                onClose={() => setSidebarView('files')}
                onLog={(type, message) => addLog({ id: generateId(), type, message, timestamp: getTimestamp() })}
              />
            </Suspense>
          ) : (
            <Sidebar
              files={files}
              activeFileId={activeFileId}
              onSelectFile={(id) => {
                setViewAsset(null);
                setActiveFileId(id);
              }}
              onCreateFile={handleCreateFile}
              onRenameFile={handleRenameFile}
              onDeleteFile={handleDeleteFile}
              onDeleteFolder={handleDeleteFolder}
              onImportFiles={handleImportFiles}
              onOpenPackages={() => setIsPackagesOpen(true)}
              onOpenHistory={(file) => setHistoryFor({ file })}
              onToggleEntry={handleToggleEntry}
              onOpenSearch={openSearch}
              onOpenGit={() => setSidebarView('git')}
              assets={assets}
              activeAsset={viewAsset}
              onOpenAsset={(a) => setViewAsset(a.name)}
            />
          )}
        </div>
        <ResizeHandle axis="x" size={sidebarWidth} direction={1} min={160} max={500} onResize={setSidebarWidth} />

        {/* Center: Editor + Bottom Execution Panel */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {currentProject && viewAsset && assets.some((x) => x.name === viewAsset) ? (
            <Suspense fallback={<div className="flex-1 bg-deep" />}>
              <AssetViewer projectId={currentProject.id} asset={assets.find((x) => x.name === viewAsset)!} onClose={() => setViewAsset(null)} />
            </Suspense>
          ) : activeFile ? (
            <div className="flex-1 flex min-h-0 min-w-0">
            <Suspense fallback={<div className="flex-1 bg-deep" />}>
            <CodeEditor
              files={tabFiles}
              allFiles={files}
              projectId={currentProject?.id || null}
              onInstallTool={handleInstallTool}
              onOpenFileAt={openFileAt}
              onApplyFiles={handleRenameInFiles}
              onToggleSplit={toggleSplit}
              splitOpen={!!splitFile}
              onRun={() => handleRunCode()}
              reveal={reveal}
              breakpoints={activeFile ? breakpoints[activeFile.name] || [] : []}
              onBreakpointsChange={(lines) => activeFile && updateBreakpoints(activeFile.name, lines)}
              debugLine={debugUi?.status === 'paused' && debugUi.stopped?.file === activeFile?.name ? debugUi.stopped.line : null}
              activeFile={activeFile}
              onUpdateContent={handleUpdateFileContent}
              onSelectFile={(id) => setActiveFileId(id)}
              onCloseFile={handleCloseTab}
              onTriggerAIAction={handleTriggerAIAction}
            />
            </Suspense>
            {splitFile && (
              <>
                <ResizeHandle axis="x" size={splitWidth} direction={-1} min={240} max={1400} onResize={setSplitWidth} />
                <div className="shrink-0 h-full min-h-0" style={{ width: splitWidth }}>
                  <Suspense fallback={<div className="h-full bg-deep" />}>
                    <SecondaryEditor
                      files={files}
                      file={splitFile}
                      onSelect={setSplitFileId}
                      onClose={() => setSplitFileId(null)}
                      onUpdateContent={handleUpdateFileContent}
                      onRun={() => handleRunCode()}
                    />
                  </Suspense>
                </div>
              </>
            )}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-500 text-xs">
              {files.length === 0 ? t('app.emptyProject') : t('app.noFile')}
            </div>
          )}

          {/* Bottom Execution & Terminal Panel */}
          <ResizeHandle
            axis="y"
            size={panelHeight}
            direction={-1}
            min={120}
            max={Math.max(200, window.innerHeight - 200)}
            onResize={(h) => {
              setPanelHeight(h);
              setPanelCollapsed(false);
            }}
          />
          <ExecutionPanel
            logs={logs}
            tables={tables}
            files={files}
            activeFile={activeFile}
            onClearLogs={() => setLogs([])}
            onFixWithAI={lastFailure && !isRunning ? handleFixWithAI : undefined}
            isRunning={isRunning}
            onSendInput={activeRun ? (text) => activeRun.sendInput(text).catch(() => {}) : undefined}
            activeTab={executionTab}
            onSelectTab={setExecutionTab}
            debug={debugUi}
            onDebugCommand={debugCommand}
            onDebugStop={() => activeRun?.stop().catch(() => {})}
            onDebugEvaluate={(expr) => debugRef.current?.evaluate(expr)}
            onOpenFrame={openFileAt}
            previewVersion={previewVersion}
            projectId={currentProject?.id || null}
            onBeforeTests={flushSave}
            height={panelHeight}
            collapsed={panelCollapsed}
            onToggleCollapsed={() => setPanelCollapsed(!panelCollapsed)}
          />
        </div>

        {/* Right: Multi-Turn Gemini AI Code Co-Pilot */}
        <ResizeHandle axis="x" size={chatWidth} direction={-1} min={280} max={800} onResize={setChatWidth} />
        <div className="shrink-0 h-full" style={{ width: chatWidth }}>
          <Suspense fallback={null}>
          <AIChatBot
            onOpenAiSettings={() => setIsAiSettingsOpen(true)}
            externalRequest={aiRequest}
            files={files}
            projectId={currentProject?.id || null}
            onApplyFiles={handleApplyAgentFiles}
            activeFile={activeFile}
            onInsertCodeToEditor={handleInsertCodeToEditor}
            onReplaceFileContent={handleReplaceFileContent}
            onCreateNewFileWithCode={handleCreateNewFileWithCode}
          />
          </Suspense>
        </div>
      </div>

      {/* Packages, history, quick open, hotkeys */}
      <Deferred when={isPackagesOpen}>
      <PackagesModal
        isOpen={isPackagesOpen}
        onClose={() => setIsPackagesOpen(false)}
        projectId={currentProject?.id || null}
        files={files}
        onSession={handlePackageSession}
      />
      </Deferred>
      <Deferred when={!!historyFor}>
      <HistoryModal
        isOpen={!!historyFor}
        onClose={() => setHistoryFor(null)}
        projectId={currentProject?.id || null}
        files={files}
        initialFile={historyFor?.file ?? null}
        onRestore={handleRestoreVersion}
      />
      </Deferred>
      <QuickOpen isOpen={isQuickOpen} files={files} onClose={() => setIsQuickOpen(false)} onOpen={(id) => setActiveFileId(id)} />
      <Deferred when={isHotkeysOpen}>
      <HotkeysModal isOpen={isHotkeysOpen} onClose={() => setIsHotkeysOpen(false)} />
      </Deferred>
      <Deferred when={isAiSettingsOpen}>
      <AiSettingsModal isOpen={isAiSettingsOpen} onClose={() => setIsAiSettingsOpen(false)} />
      </Deferred>

      <Deferred when={isBuildExeOpen}>
      <BuildExeModal
        isOpen={isBuildExeOpen}
        onClose={() => setIsBuildExeOpen(false)}
        projectId={currentProject?.id || null}
        files={files}
        onBeforeBuild={flushSave}
      />
      </Deferred>

      <Deferred when={isRunConfigOpen}>
      <RunConfigModal
        isOpen={isRunConfigOpen}
        onClose={() => setIsRunConfigOpen(false)}
        projectId={currentProject?.id || null}
        onSaved={({ vars, args }) =>
          addLog({ id: generateId(), type: 'info', message: t('runcfg.applied', { vars, args: args || '—' }), timestamp: getTimestamp() })
        }
      />
      </Deferred>

      {/* Projects Manager */}
      <Deferred when={isProjectsOpen}>
      <ProjectsModal
        isOpen={isProjectsOpen}
        onClose={() => setIsProjectsOpen(false)}
        currentProjectId={currentProject?.id || null}
        onOpenProject={handleOpenProject}
        onCreateProject={handleCreateProject}
        onImportAsProject={handleImportAsProject}
        onProjectRenamed={handleProjectRenamed}
        onProjectDeleted={handleProjectDeleted}
      />
      </Deferred>

      {/* Script Generator Wizard Modal */}
      <Deferred when={isWizardOpen}>
      <ScriptWizardModal
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        onScriptGenerated={(filename, _language, code) => handleCreateNewFileWithCode(filename, code)}
      />
      </Deferred>
    </div>
  );
}

// Heavy parts load as separate chunks: the editor (Monaco) and the chat (Markdown) right after the
// studio frame is drawn, dialogs only when first opened
const CodeEditor = lazyNamed(() => import('./components/CodeEditor.tsx'), 'CodeEditor');
const AIChatBot = lazyNamed(() => import('./components/AIChatBot.tsx'), 'AIChatBot');
const SearchPanel = lazyNamed(() => import('./components/SearchPanel.tsx'), 'SearchPanel');
const GitPanel = lazyNamed(() => import('./components/GitPanel.tsx'), 'GitPanel');
const ScriptWizardModal = lazyNamed(() => import('./components/ScriptWizardModal.tsx'), 'ScriptWizardModal');
const ProjectsModal = lazyNamed(() => import('./components/ProjectsModal.tsx'), 'ProjectsModal');
const PackagesModal = lazyNamed(() => import('./components/PackagesModal.tsx'), 'PackagesModal');
const HistoryModal = lazyNamed(() => import('./components/HistoryModal.tsx'), 'HistoryModal');
const HotkeysModal = lazyNamed(() => import('./components/HotkeysModal.tsx'), 'HotkeysModal');
const AiSettingsModal = lazyNamed(() => import('./components/AiSettingsModal.tsx'), 'AiSettingsModal');
const BuildExeModal = lazyNamed(() => import('./components/BuildExeModal.tsx'), 'BuildExeModal');
const RunConfigModal = lazyNamed(() => import('./components/RunConfigModal.tsx'), 'RunConfigModal');
const SecondaryEditor = lazyNamed(() => import('./components/SecondaryEditor.tsx'), 'SecondaryEditor');
const AssetViewer = lazyNamed(() => import('./components/AssetViewer.tsx'), 'AssetViewer');

const LAST_PROJECT_KEY = 'scriptcraft-last-project';

function defaultProjectFile(): ProjectFilePayload {
  return { name: 'main.py', language: 'python', content: getDefaultContentForLanguage('main.py', 'python'), isEntry: true };
}

function getDefaultContentForLanguage(name: string, lang: FileLanguage): string {
  switch (lang) {
    case 'python':
      return `"""\n${name}\n"""\n\ndef main():\n    print("Hello from ${name}!")\n\nif __name__ == "__main__":\n    main()\n`;
    case 'javascript':
      return `// ${name}\nconsole.log("Hello from ${name}!");\n`;
    case 'typescript':
      return `// ${name}\nconst greeting: string = "Hello from ${name}!";\nconsole.log(greeting);\n`;
    case 'bash':
      return `#!/usr/bin/env bash\n# ${name}\nset -euo pipefail\n\necho "Running ${name}..."\n`;
    case 'sql':
      return `-- ${name}\nSELECT 'Hello SQL' AS message, CURRENT_TIMESTAMP AS executed_at;\n`;
    case 'html':
      return `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>${name}</title>\n</head>\n<body>\n  <h1>${name}</h1>\n</body>\n</html>\n`;
    case 'css':
      return `/* ${name} */\nbody {\n  margin: 0;\n  padding: 16px;\n}\n`;
    case 'json':
      return `{\n  "name": "${name}",\n  "version": "1.0.0"\n}\n`;
    default:
      return ``;
  }
}
