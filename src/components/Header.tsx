import React, { useState } from 'react';
import { 
  Play, 
  Terminal, 
  Sparkles, 
  Download, 
  FolderDown, 
  FileCode, 
  Layers, 
  Check, 
  Cpu,
  ChevronDown,
  FolderOpen,
  Sun,
  Moon,
  Square,
  Keyboard,
  Bug,
  Package,
  SlidersHorizontal,
  Braces,
  AppWindow,
  Info,
  HelpCircle,
} from 'lucide-react';
import { Cpu as CpuIcon } from 'lucide-react';
import { FileItem } from '../types.ts';
import { useI18n } from '../i18n.ts';
import { useTheme } from '../theme.ts';
import { useUpdateInfo } from '../updates.ts';

// The studio's server runs on this same computer, so the window's OS is the server's OS
const IS_WINDOWS = typeof navigator === 'undefined' || /Windows/i.test(navigator.userAgent);

interface HeaderProps {
  activeFile: FileItem | null;
  isRunning: boolean;
  onRun: () => void;
  canStop: boolean;
  onStop: () => void;
  /** File that "Run" will execute (the ★ main file, or the active one) */
  runTargetName: string | null;
  onShowHotkeys: () => void;
  onOpenAbout: () => void;
  onOpenHelp: () => void;
  /** Start debugging the run target (Python / JavaScript) */
  onDebug: () => void;
  canDebug: boolean;
  onOpenAiSettings: () => void;
  onOpenWizard: () => void;
  onExportProject: () => void;
  /** Python project → one Windows program (PyInstaller) */
  onBuildExe: () => void;
  /** Environment variables and arguments of the project's programs */
  onOpenRunConfig: () => void;
  onOpenSnippets: () => void;
  onOpenApps: () => void;
  projectName: string;
  saveStatus: 'saving' | 'saved' | 'error' | 'idle';
  onOpenProjects: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeFile,
  isRunning,
  onRun,
  canStop,
  onStop,
  runTargetName,
  onShowHotkeys,
  onOpenAbout,
  onOpenHelp,
  onDebug,
  canDebug,
  onOpenAiSettings,
  onOpenWizard,
  onExportProject,
  onBuildExe,
  onOpenRunConfig,
  onOpenSnippets,
  onOpenApps,
  projectName,
  saveStatus,
  onOpenProjects,
}) => {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const { lang, setLang, t } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const update = useUpdateInfo();

  const handleDownloadFullApp = () => {
    setShowExportMenu(false);
    window.location.href = '/api/download-full-project';
  };

  return (
    <header className="h-12 border-b border-slate-800 bg-bar px-4 flex items-center justify-between select-none shrink-0 z-20">
      {/* Left: Branding & Templates */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold shadow-md shadow-indigo-600/30">
            <Terminal className="w-4 h-4" />
          </div>
          <span className="font-semibold text-sm tracking-tight text-fg">
            ScriptCraft <span className="text-indigo-400 font-mono text-xs">Studio</span>
          </span>
        </div>

        <div className="h-4 w-px bg-slate-800 mx-1" />

        {/* Current project / Projects manager */}
        <button
          onClick={onOpenProjects}
          className="flex items-center gap-2 bg-raised hover:bg-card text-xs text-slate-200 border border-slate-700/80 rounded-md py-1.5 px-2.5 font-medium transition-colors max-w-[320px]"
          title={t('header.projectsTitle')}
        >
          <FolderOpen className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
          <span className="truncate">{projectName}</span>
          <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
        </button>
        <span
          className={`text-[10px] font-mono ${
            saveStatus === 'error' ? 'text-rose-400' : saveStatus === 'saving' ? 'text-amber-400' : 'text-slate-500'
          }`}
        >
          {saveStatus === 'saving' && t('header.saving')}
          {saveStatus === 'saved' && t('header.saved')}
          {saveStatus === 'error' && t('header.saveError')}
        </span>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        {/* AI Generator Wizard */}
        <button
          onClick={onOpenWizard}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 border border-indigo-500/30 text-xs font-medium transition-all shadow-sm"
          title={t('header.wizardTitle')}
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>{t('header.wizard')}</span>
        </button>

        {/* Export Dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowExportMenu(!showExportMenu)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-panel text-slate-300 hover:text-fg hover:bg-hover border border-slate-700 text-xs font-medium transition-colors"
            title={t('header.exportTitle')}
          >
            <FolderDown className="w-3.5 h-3.5 text-slate-400" />
            <span>{t('header.export')}</span>
            <ChevronDown className="w-3 h-3 text-slate-400" />
          </button>

          {showExportMenu && (
            <div className="absolute right-0 mt-1 w-64 bg-panel border border-slate-700 rounded-md shadow-2xl py-1 z-40 text-xs">
              <button
                onClick={() => {
                  setShowExportMenu(false);
                  onExportProject();
                }}
                className="w-full text-left px-3 py-2 hover:bg-slate-800 text-slate-200 hover:text-fg flex flex-col"
              >
                <div className="font-semibold flex items-center gap-1.5">
                  <FileCode className="w-3.5 h-3.5 text-indigo-400" />
                  <span>{t('header.exportScripts')}</span>
                </div>
                <span className="text-[10px] text-slate-400 mt-0.5">
                  {t('header.exportScriptsDesc')}
                </span>
              </button>

              <button
                data-menu-build-exe
                onClick={() => {
                  setShowExportMenu(false);
                  onBuildExe();
                }}
                className="w-full text-left px-3 py-2 hover:bg-slate-800 text-slate-200 hover:text-fg flex flex-col"
              >
                <div className="font-semibold flex items-center gap-1.5">
                  <Package className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{t('exe.menu')}</span>
                </div>
                <span className="text-[10px] text-slate-400 mt-0.5">{t('exe.menuDesc')}</span>
              </button>

              <div className="h-px bg-slate-800 my-1" />

              <button
                onClick={handleDownloadFullApp}
                className="w-full text-left px-3 py-2 hover:bg-slate-800 text-slate-200 hover:text-fg flex flex-col"
              >
                <div className="font-semibold flex items-center gap-1.5">
                  <Download className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{t('header.downloadFull')}</span>
                </div>
                <span className="text-[10px] text-slate-400 mt-0.5">
                  {t('header.downloadFullDesc')}
                </span>
              </button>
            </div>
          )}
        </div>

        {/* AI providers */}
        <button
          onClick={onOpenAiSettings}
          className="p-1.5 rounded-md bg-panel hover:bg-hover border border-slate-700 text-slate-300 hover:text-fg transition-colors"
          title={t('ai.title')}
        >
          <CpuIcon className="w-3.5 h-3.5" />
        </button>

        {/* Hotkeys help */}
        <button
          onClick={onShowHotkeys}
          className="p-1.5 rounded-md bg-panel hover:bg-hover border border-slate-700 text-slate-300 hover:text-fg transition-colors"
          title={t('hotkeys.title')}
        >
          <Keyboard className="w-3.5 h-3.5" />
        </button>

        {/* Help */}
        <button
          onClick={onOpenHelp}
          className="p-1.5 rounded-md bg-panel hover:bg-hover border border-slate-700 text-slate-300 hover:text-fg transition-colors"
          title={t('help.title')}
          data-open-help
        >
          <HelpCircle className="w-3.5 h-3.5" />
        </button>

        {/* About: version, updates (a dot when a new version is out) */}
        <button
          onClick={onOpenAbout}
          className="relative p-1.5 rounded-md bg-panel hover:bg-hover border border-slate-700 text-slate-300 hover:text-fg transition-colors"
          title={update?.available ? t('about.availableShort', { version: update.latest }) : t('about.title')}
          data-open-about
        >
          <Info className="w-3.5 h-3.5" />
          {update?.available && <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-[var(--color-bg,#11131a)]" data-update-dot />}
        </button>

        {/* Theme Switcher */}
        <button
          onClick={toggleTheme}
          className="p-1.5 rounded-md bg-panel hover:bg-hover border border-slate-700 text-slate-300 hover:text-fg transition-colors"
          title={theme === 'dark' ? t('header.themeLight') : t('header.themeDark')}
        >
          {theme === 'dark' ? <Sun className="w-3.5 h-3.5 text-amber-300" /> : <Moon className="w-3.5 h-3.5 text-indigo-500" />}
        </button>

        {/* Language Switcher */}
        <div
          className="flex items-center rounded-md border border-slate-700 overflow-hidden text-[11px] font-semibold"
          title={t('header.langTitle')}
        >
          {(['ru', 'en'] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLang(l)}
              className={`px-2 py-1.5 uppercase transition-colors ${
                lang === l ? 'bg-indigo-600 text-white' : 'bg-panel text-slate-400 hover:text-fg'
              }`}
            >
              {l}
            </button>
          ))}
        </div>

        <div className="h-5 w-px bg-slate-800 mx-1" />

        {/* Run parameters (env vars, arguments) */}
        <button
          onClick={onOpenRunConfig}
          data-open-run-config
          className="p-1.5 rounded-md bg-panel hover:bg-hover border border-slate-700 text-slate-300 hover:text-fg transition-colors"
          title={t('runcfg.open')}
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>

        {/* Snippets manager */}
        <button
          onClick={onOpenSnippets}
          data-open-snippets
          className="p-1.5 rounded-md bg-panel hover:bg-hover border border-slate-700 text-slate-300 hover:text-fg transition-colors"
          title={t('snip.open')}
        >
          <Braces className="w-4 h-4" />
        </button>

        {/* Programs installed on this PC (Windows only: registry, winget, startup list) */}
        {IS_WINDOWS && (
          <button
            onClick={onOpenApps}
            data-open-apps
            className="p-1.5 rounded-md bg-panel hover:bg-hover border border-slate-700 text-slate-300 hover:text-fg transition-colors"
            title={t('apps.open')}
          >
            <AppWindow className="w-4 h-4" />
          </button>
        )}

        {/* Debug Button */}
        {!canStop && (
          <button
            onClick={onDebug}
            data-debug-start
            disabled={isRunning || !canDebug}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border border-slate-700 bg-panel hover:bg-hover text-slate-200 disabled:opacity-40 transition-colors"
            title={canDebug ? t('debug.startTitle') : t('debug.unsupported')}
          >
            <Bug className="w-3.5 h-3.5 text-rose-400" />
            <span>{t('debug.start')}</span>
          </button>
        )}

        {/* Run / Stop Button */}
        {canStop ? (
          <button
            onClick={onStop}
            className="flex items-center gap-2 px-4 py-1.5 rounded-md text-xs font-semibold shadow-md transition-all bg-rose-600 hover:bg-rose-500 text-white shadow-rose-900/30 active:scale-95"
            title={t('header.stopTitle')}
          >
            <Square className="w-3.5 h-3.5 fill-current" />
            <span>{t('header.stop')}</span>
          </button>
        ) : (
          <button
            data-tour="run"
            onClick={onRun}
            disabled={isRunning || !activeFile}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-xs font-semibold shadow-md transition-all ${
              isRunning
                ? 'bg-amber-600/80 text-white cursor-wait'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-900/30 active:scale-95 disabled:opacity-50'
            }`}
            title={runTargetName ? t('header.runTitleFile', { name: runTargetName }) : t('header.runTitle')}
          >
            <Play className={`w-3.5 h-3.5 ${isRunning ? 'animate-spin' : 'fill-current'}`} />
            <span>{isRunning ? t('header.running') : t('header.run')}</span>
            {runTargetName && !isRunning && (
              <span className="max-w-[120px] truncate font-mono text-[10px] opacity-80">
                {runTargetName.slice(runTargetName.lastIndexOf('/') + 1)}
              </span>
            )}
            <span className="hidden sm:inline-block text-[10px] opacity-70 ml-1 font-mono">Ctrl+↵</span>
          </button>
        )}
      </div>
    </header>
  );
};
