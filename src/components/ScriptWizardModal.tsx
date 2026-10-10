import React, { useState } from 'react';
import { 
  Sparkles, 
  X, 
  Loader2
} from 'lucide-react';
import { FileLanguage } from '../types.ts';
import { useI18n, getLang } from '../i18n.ts';
import { useModels, getSelectedModelId } from '../utils/models.ts';

interface WizardPreset {
  id: string;
  title: string;
  description: string;
  language: FileLanguage;
  defaultFilename: string;
  prompt: string;
  icon: string;
}

const WIZARD_PRESETS: WizardPreset[] = [
  {
    id: 'file_organizer',
    title: 'Automated File Organizer & Archiver',
    description: 'Scans directory, sorts files by extension and date, handles collision, logs actions.',
    language: 'python',
    defaultFilename: 'organizer.py',
    prompt: 'Write a robust Python script to automatically organize files in a folder into subfolders by year/month and file extension. Include hashing to skip duplicates and a JSON audit log.',
    icon: 'py',
  },
  {
    id: 'csv_cleaner',
    title: 'CSV Data Cleaner & Aggregator',
    description: 'Validates rows, fills missing values, computes group statistics, exports clean reports.',
    language: 'python',
    defaultFilename: 'clean_data.py',
    prompt: 'Write a Python script that generates sample tabular customer purchase data, cleans invalid records, standardizes dates and amounts, and calculates cohort metrics.',
    icon: 'py',
  },
  {
    id: 'bash_deployer',
    title: 'Server Deployment & Health Audit',
    description: 'Docker check, SSL cert expiry tester, database backup, zero-downtime reload.',
    language: 'bash',
    defaultFilename: 'deploy.sh',
    prompt: 'Write a production-grade Bash deployment script with strict error handling (set -euo pipefail), prerequisite checks, disk space safety check, and Slack/Discord webhook alert hook.',
    icon: 'sh',
  },
  {
    id: 'api_fetcher',
    title: 'REST API Client with Retry & Cache',
    description: 'TypeScript client with exponential backoff, circuit breaker, and in-memory TTL caching.',
    language: 'typescript',
    defaultFilename: 'api_client.ts',
    prompt: 'Write a TypeScript async REST API fetcher with exponential backoff retries, request timeout with AbortController, and an in-memory TTL caching layer.',
    icon: 'ts',
  },
  {
    id: 'sql_reporting',
    title: 'E-Commerce Analytics & Cohorts',
    description: 'Window functions, rolling 30-day revenue, retention rate, customer churn indicators.',
    language: 'sql',
    defaultFilename: 'cohort_analysis.sql',
    prompt: 'Write SQL queries using window functions and CTEs to calculate monthly customer retention rates, average order frequency, and cumulative revenue cohorts.',
    icon: 'sql',
  },
  {
    id: 'canvas_game',
    title: 'Interactive HTML5 Canvas Arcade Game',
    description: 'Complete standalone game with keyboard controls, score, particle effects, and sound synth.',
    language: 'html',
    defaultFilename: 'game.html',
    prompt: 'Create a standalone single-file HTML5 canvas space dodger game with keyboard arrows/touch controls, particle explosions on impact, score counter, and Web Audio API sound effects.',
    icon: 'html',
  },
];

interface ScriptWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScriptGenerated: (filename: string, language: FileLanguage, code: string) => void;
}

export const ScriptWizardModal: React.FC<ScriptWizardModalProps> = ({
  isOpen,
  onClose,
  onScriptGenerated,
}) => {
  const { t } = useI18n();
  const [selectedPreset, setSelectedPreset] = useState<WizardPreset>(WIZARD_PRESETS[0]);
  const [customPrompt, setCustomPrompt] = useState(() => t(`preset.${WIZARD_PRESETS[0].id}.prompt`));
  const [targetLanguage, setTargetLanguage] = useState<FileLanguage>(WIZARD_PRESETS[0].language);
  const [filename, setFilename] = useState(WIZARD_PRESETS[0].defaultFilename);
  const { models } = useModels();
  const [model, setModel] = useState(() => getSelectedModelId());
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hooks must run on every render, so the early return goes after them
  if (!isOpen) return null;

  const handleSelectPreset = (p: WizardPreset) => {
    setSelectedPreset(p);
    setCustomPrompt(t(`preset.${p.id}.prompt`));
    setTargetLanguage(p.language);
    setFilename(p.defaultFilename);
  };

  const handleGenerate = async () => {
    if (!customPrompt.trim() || isGenerating) return;
    setIsGenerating(true);
    setError(null);

    try {
      const fullPrompt = `You are generating a complete, standalone script/program for ScriptCraft Studio.
Target Language: ${targetLanguage}
Filename: ${filename}
Requirements: ${customPrompt}

Provide clean, production-grade, immediately runnable code with realistic sample data or inputs and helpful comments.
Format your output as a single markdown code block with the appropriate language tag.`;

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', text: fullPrompt }],
          model,
          systemInstruction: 'You are an expert script engineer. Write clean, working, standalone code in the requested language. Do not truncate.',
          lang: getLang(),
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Server returned ${res.status}`);
      }

      const data = await res.json();
      let extractedCode = data.response || '';

      // Extract code inside ``` ... ``` if present
      const match = extractedCode.match(/```(?:\w+)?\n([\s\S]*?)```/);
      if (match && match[1]) {
        extractedCode = match[1];
      }

      onScriptGenerated(filename, targetLanguage, extractedCode);
      onClose();
    } catch (err: any) {
      setError(err.message || t('wizard.failed'));
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-raised border border-slate-700/80 rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-modal">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-fg">{t('wizard.title')}</h2>
              <p className="text-xs text-slate-400">{t('wizard.subtitle')}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-fg rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {/* Preset Buttons */}
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              {t('wizard.choose')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              {WIZARD_PRESETS.map((p) => {
                const isSelected = selectedPreset.id === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => handleSelectPreset(p)}
                    className={`text-left p-2.5 rounded-lg border transition-all ${
                      isSelected
                        ? 'bg-indigo-950/40 border-indigo-500 text-fg'
                        : 'bg-card border-slate-800 hover:border-slate-700 text-slate-300'
                    }`}
                  >
                    <div className="font-medium text-xs flex items-center justify-between mb-1">
                      <span>{t(`preset.${p.id}.title`)}</span>
                      <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                        {p.language}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 line-clamp-2">{t(`preset.${p.id}.desc`)}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Prompt Editor */}
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
              {t('wizard.requirements')}
            </label>
            <textarea
              rows={3}
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder={t('wizard.placeholder')}
              className="w-full bg-deep border border-slate-700 rounded-lg p-2.5 text-xs text-fg placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono"
            />
          </div>

          {/* Config row */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">{t('wizard.language')}</label>
              <select
                value={targetLanguage}
                onChange={(e) => setTargetLanguage(e.target.value as FileLanguage)}
                className="w-full bg-deep border border-slate-700 rounded-lg p-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="python">Python (.py)</option>
                <option value="javascript">JavaScript (.js)</option>
                <option value="typescript">TypeScript (.ts)</option>
                <option value="bash">Bash / Shell (.sh)</option>
                <option value="powershell">PowerShell (.ps1)</option>
                <option value="sql">SQL (.sql)</option>
                <option value="html">{t('wizard.htmlApp')}</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">{t('wizard.filename')}</label>
              <input
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                className="w-full bg-deep border border-slate-700 rounded-lg p-2 text-xs text-fg focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">{t('wizard.engine')}</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full bg-deep border border-slate-700 rounded-lg p-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.provider === 'gemini'
                      ? t(m.id === 'gemini-3.5-flash' ? 'wizard.m35' : m.id === 'gemini-3.1-flash-lite' ? 'wizard.m31lite' : 'wizard.m31pro')
                      : `${m.name} (${m.tag})`}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {error && (
            <div className="p-2.5 rounded-lg bg-rose-950/30 border border-rose-800 text-xs text-rose-300">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 bg-modal flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-slate-400 hover:text-fg rounded-lg hover:bg-slate-800 transition-colors"
          >
            {t('wizard.cancel')}
          </button>

          <button
            onClick={handleGenerate}
            disabled={isGenerating || !customPrompt.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold shadow-lg shadow-indigo-600/20 transition-all active:scale-95"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>{t('wizard.generating')}</span>
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5" />
                <span>{t('wizard.generate')}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
