import React, { useState, useRef, useEffect, useMemo, Suspense } from 'react';
import { 
  Bot, 
  Send, 
  Sparkles, 
  Trash2, 
  Copy, 
  Check, 
  FileCode, 
  ArrowRightCircle, 
  Paperclip, 
  ChevronDown, 
  Zap, 
  Cpu, 
  ShieldAlert, 
  HelpCircle,
  Loader2,
  FilePlus,
  RefreshCw,
  Square,
  Workflow
} from 'lucide-react';
import { ChatMessage, AIRole, FileItem } from '../types.ts';
import { useModels } from '../utils/models.ts';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlightCode } from '../utils/highlighter.ts';
import { useI18n, aiLanguageInstruction, getLang } from '../i18n.ts';
import {
  runAgent,
  buildProjectContext,
  filesFromItems,
  formatRunReport,
  type AgentFile,
  type AgentApproval,
  type AgentApprovalRequest,
  planAgent,
  formatPlan,
  type AgentPlan,
} from '../utils/agent.ts';
import { lazyNamed } from '../utils/lazy.tsx';
import { extractCodeFiles, namedFiles } from '../utils/codeFiles.ts';
import { AgentPlanCard } from './AgentPlanCard.tsx';

const AI_ROLES: AIRole[] = [
  {
    id: 'architect',
    name: 'Architect & Full-Stack',
    badge: 'Senior Lead',
    description: 'System design, algorithm design, clean architecture and full programs',
    systemInstruction: 
      'You are a Principal Software Architect and Lead Engineer. Provide clean, production-grade, well-architected solutions. Explain architectural trade-offs, scalability, and code structure. Format all code blocks with explicit language tags.',
  },
  {
    id: 'script_wizard',
    name: 'Script & Automation Wizard',
    badge: 'DevOps / CLI',
    description: 'Bash scripts, Python automation, cron jobs, file batching, and system tools',
    systemInstruction: 
      'You are a DevOps and CLI Automation Master. You write resilient, fault-tolerant Python scripts, Bash pipelines, and automated utilities with robust error handling, logging, and performance. Format all code blocks with explicit language tags.',
  },
  {
    id: 'debugger',
    name: 'Debug & Security Specialist',
    badge: 'SecOps / QA',
    description: 'Pinpoints subtle bugs, memory leaks, race conditions, and security issues',
    systemInstruction: 
      'You are an expert Security Engineer and Debugger. Deeply analyze code for edge cases, undefined behavior, security vulnerabilities, off-by-one errors, and performance bottlenecks. Provide concrete, fixed code blocks with explanation of the vulnerability.',
  },
  {
    id: 'mentor',
    name: 'Code Mentor & Explainer',
    badge: 'Educator',
    description: 'Explains complex syntax, algorithms, and concepts step-by-step',
    systemInstruction: 
      'You are a clear and patient Senior Code Mentor. Break down code mechanics line-by-line, explain underlying principles and idioms, and give practical tips for improvement. Format all code blocks with explicit language tags.',
  },
];



interface AIChatBotProps {
  activeFile: FileItem | null;
  /** All files of the current project (for "whole project" context and the agent) */
  files: FileItem[];
  /** Current project id: chat history is stored per project */
  projectId: string | null;
  onInsertCodeToEditor: (code: string) => void;
  onReplaceFileContent: (code: string) => void;
  onCreateNewFileWithCode: (filename: string, code: string) => void;
  /** Agent mode: create/overwrite project files */
  onApplyFiles: (changes: AgentFile[]) => void;
  /** A prompt sent from elsewhere in the app (e.g. "Fix with AI" in the terminal) */
  externalRequest?: { id: number; prompt: string; display: string } | null;
  onOpenAiSettings: () => void;
}

type ContextMode = 'none' | 'file' | 'project';

const welcomeMessage = (): ChatMessage => ({
  id: 'msg-welcome',
  role: 'model',
  text: '',
  timestamp: '',
  modelUsed: 'gemini-3.5-flash',
});

const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    if (v && allowed.includes(v)) return v;
  } catch {
    // storage unavailable
  }
  return fallback;
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
}

// Diff view of the agent's changes (Monaco) loads only when the agent asks for approval
const AgentApprovalCard = lazyNamed(() => import('./AgentApprovalCard.tsx'), 'AgentApprovalCard');

export const AIChatBot: React.FC<AIChatBotProps> = ({
  activeFile,
  files,
  projectId,
  onInsertCodeToEditor,
  onReplaceFileContent,
  onCreateNewFileWithCode,
  onApplyFiles,
  externalRequest,
  onOpenAiSettings,
}) => {
  const { t } = useI18n();
  const handledRequestRef = useRef<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([welcomeMessage()]);

  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  // Pending "may I change files / run code?" question of the agent
  const [approval, setApproval] = useState<{ request: AgentApprovalRequest; resolve: (a: AgentApproval) => void } | null>(null);
  // Plan first: the agent proposes steps and waits for "Run" / "Change the plan" / "Cancel"
  const [planFirst, setPlanFirst] = useState(() => readPref('scriptcraft-agent-plan', ['on', 'off'] as const, 'on') === 'on');
  useEffect(() => writePref('scriptcraft-agent-plan', planFirst ? 'on' : 'off'), [planFirst]);
  const [planDecision, setPlanDecision] = useState<{
    plan: AgentPlan;
    busy: boolean;
    resolve: (d: { kind: 'run' } | { kind: 'revise'; feedback: string } | { kind: 'cancel' }) => void;
  } | null>(null);
  const [confirmAgent, setConfirmAgent] = useState(() => readPref('scriptcraft-agent-confirm', ['on', 'off'] as const, 'on') === 'on');
  useEffect(() => writePref('scriptcraft-agent-confirm', confirmAgent ? 'on' : 'off'), [confirmAgent]);
  const [selectedRole, setSelectedRole] = useState<AIRole>(AI_ROLES[0]);
  const { models, selected: selectedModel, setSelectedModel } = useModels();
  const [contextMode, setContextMode] = useState<ContextMode>(() =>
    readPref('scriptcraft-chat-context', ['none', 'file', 'project'] as const, 'file')
  );
  const [agentMode, setAgentMode] = useState(() => readPref('scriptcraft-agent-mode', ['on', 'off'] as const, 'off') === 'on');
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showRoleMenu, setShowRoleMenu] = useState(false);
  const selectorBarRef = useRef<HTMLDivElement>(null);
  // A click anywhere else closes the model / role menus
  useEffect(() => {
    if (!showRoleMenu && !showModelMenu) return;
    const onDown = (e: MouseEvent) => {
      if (selectorBarRef.current?.contains(e.target as Node)) return;
      setShowRoleMenu(false);
      setShowModelMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showRoleMenu, showModelMenu]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const historyProjectRef = useRef<string | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  useEffect(() => writePref('scriptcraft-chat-context', contextMode), [contextMode]);
  useEffect(() => writePref('scriptcraft-agent-mode', agentMode ? 'on' : 'off'), [agentMode]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // ---------- chat history per project ----------
  useEffect(() => {
    historyProjectRef.current = null;
    abortRef.current?.abort();
    if (!projectId) {
      setMessages([welcomeMessage()]);
      return;
    }
    let cancelled = false;
    fetch(`/api/projects/${encodeURIComponent(projectId)}/chat`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const loaded: ChatMessage[] = Array.isArray(data.messages) ? data.messages : [];
        setMessages(loaded.length > 0 ? loaded : [welcomeMessage()]);
        historyProjectRef.current = projectId;
      })
      .catch(() => {
        if (!cancelled) {
          setMessages([welcomeMessage()]);
          historyProjectRef.current = projectId;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Save the conversation (after each completed answer) into the project folder
  useEffect(() => {
    if (!projectId || historyProjectRef.current !== projectId || isLoading) return;
    const toSave = messages.filter((m) => m.id !== 'msg-welcome' && m.id !== 'msg-welcome-new');
    const timer = setTimeout(() => {
      fetch(`/api/projects/${encodeURIComponent(projectId)}/chat`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: toSave }),
      }).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [messages, isLoading, projectId]);

  const addModelMessage = (text: string, extra: Partial<ChatMessage> = {}) =>
    setMessages((prev) => [
      ...prev,
      { id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, role: 'model', text, timestamp: nowTime(), ...extra },
    ]);

  const handleStop = () => {
    abortRef.current?.abort();
    // A question waiting for an answer is treated as "no"
    setPlanDecision((cur) => {
      cur?.resolve({ kind: 'cancel' });
      return null;
    });
    setApproval((cur) => {
      cur?.resolve('no');
      return null;
    });
  };

  const askApproval = (request: AgentApprovalRequest, signal: AbortSignal) =>
    new Promise<AgentApproval>((resolve) => {
      if (signal.aborted) return resolve('no');
      setAgentStatus(t('agent.waitingApproval'));
      setApproval({
        request,
        resolve: (a) => {
          setApproval(null);
          setAgentStatus(a === 'no' ? null : t('agent.working'));
          resolve(a);
        },
      });
    });

  // ---------- agent mode ----------
  const handleRunAgent = async (task: string) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setMessages((prev) => [
      ...prev,
      { id: `usr-${Date.now()}`, role: 'user', text: task, timestamp: nowTime(), roleUsed: 'agent' },
    ]);
    setInput('');
    setIsLoading(true);

    // 1. Plan: propose, let the user revise it as often as needed, then run it (or cancel)
    let plan: AgentPlan | undefined;
    let planMessageId: string | null = null;
    if (planFirst) {
      setAgentStatus(t('plan.making'));
      try {
        let current = await planAgent({ task, files: filesFromItems(filesRef.current), model: selectedModel.id, projectId, signal: controller.signal });
        for (;;) {
          setAgentStatus(t('plan.waiting'));
          const decision = await new Promise<{ kind: 'run' } | { kind: 'revise'; feedback: string } | { kind: 'cancel' }>((resolve) =>
            setPlanDecision({ plan: current.plan, busy: false, resolve })
          );
          if (decision.kind === 'cancel' || controller.signal.aborted) {
            setPlanDecision(null);
            addModelMessage(t('plan.cancelled'), { roleUsed: 'agent' });
            setIsLoading(false);
            setAgentStatus(null);
            abortRef.current = null;
            return;
          }
          if (decision.kind === 'run') {
            setPlanDecision(null);
            plan = current.plan;
            break;
          }
          setPlanDecision((d) => (d ? { ...d, busy: true } : d));
          setAgentStatus(t('plan.revising'));
          current = await planAgent({
            task,
            files: filesFromItems(filesRef.current),
            model: selectedModel.id,
            projectId,
            signal: controller.signal,
            revise: { plan: current.plan, feedback: decision.feedback },
          });
        }
        planMessageId = `plan-${Date.now()}`;
        setMessages((prev) => [...prev, { id: planMessageId!, role: 'model', text: formatPlan(plan!, 1), timestamp: nowTime(), roleUsed: 'agent' }]);
      } catch (err: any) {
        setPlanDecision(null);
        if (!controller.signal.aborted && err?.name !== 'AbortError') addModelMessage(t('agent.error', { error: err?.message || String(err) }), { roleUsed: 'agent' });
        else addModelMessage(t('agent.stopped'), { roleUsed: 'agent' });
        setIsLoading(false);
        setAgentStatus(null);
        abortRef.current = null;
        return;
      }
    }
    // Progress of the approved plan: the checklist message is updated as the agent moves on
    const markPlan = (current: number | null, finished = false) => {
      if (!plan || !planMessageId) return;
      const text = formatPlan(plan, current, finished);
      setMessages((prev) => prev.map((m) => (m.id === planMessageId ? { ...m, text } : m)));
    };

    setAgentStatus(t('agent.thinking'));
    await runAgent({
      task,
      files: filesFromItems(filesRef.current),
      model: selectedModel.id,
      projectId,
      signal: controller.signal,
      applyFiles: onApplyFiles,
      confirm: confirmAgent ? (req) => askApproval(req, controller.signal) : undefined,
      plan,
      onEvent: (e) => {
        if (e.kind === 'step') {
          if (e.planStep) markPlan(e.planStep);
          const changed = e.changed.length ? `\n\n📝 **${t('agent.changed')}:** ${e.changed.map((f) => `\`${f}\``).join(', ')}` : '';
          addModelMessage(e.text + changed, { modelUsed: e.model, roleUsed: 'agent' });
          setAgentStatus(t('agent.working'));
        } else if (e.kind === 'run') {
          addModelMessage(formatRunReport(e.path, e.report), { roleUsed: 'agent' });
          setAgentStatus(t('agent.thinking'));
        } else {
          if (e.reason === 'done') markPlan(null, true);
          const text =
            e.reason === 'done'
              ? t('agent.done', { steps: e.steps })
              : e.reason === 'stopped'
                ? t('agent.stopped')
                : e.reason === 'rejected'
                  ? t('agent.rejected')
                : e.reason === 'max-steps'
                  ? t('agent.maxSteps', { steps: e.steps })
                  : t('agent.error', { error: e.error || '' });
          addModelMessage(text, { roleUsed: 'agent' });
        }
      },
    });

    setIsLoading(false);
    setAgentStatus(null);
    abortRef.current = null;
  };

  // ---------- normal chat (streamed) ----------
  const handleSendMessage = async (customPrompt?: string, displayText?: string) => {
    const textToSend = customPrompt || input.trim();
    if (!textToSend || isLoading) return;

    if (agentMode && !customPrompt) return handleRunAgent(textToSend);

    let fullPromptText = textToSend;
    let snippetMeta: ChatMessage['attachedCodeSnippet'];

    // Attach context: the active file or the whole project
    if (!customPrompt && contextMode === 'file' && activeFile) {
      snippetMeta = { filename: activeFile.name, language: activeFile.language, code: activeFile.content };
      fullPromptText = `${textToSend}\n\n[Context: Currently editing file "${activeFile.name}" (${activeFile.language})]:\n\`\`\`${activeFile.language}\n${activeFile.content}\n\`\`\``;
    } else if (!customPrompt && contextMode === 'project' && files.length > 0) {
      fullPromptText =
        `${textToSend}\n\n[Context: the whole project${activeFile ? `; the user is currently editing "${activeFile.name}"` : ''}]\n` +
        buildProjectContext(filesFromItems(files));
    }

    const userMessage: ChatMessage = {
      id: `usr-${Date.now()}`,
      role: 'user',
      text: displayText || textToSend,
      timestamp: nowTime(),
      attachedCodeSnippet: snippetMeta,
    };

    const newMessagesList = [...messages, userMessage];
    const aiId = `ai-${Date.now()}`;
    setMessages([...newMessagesList, { id: aiId, role: 'model', text: '', timestamp: nowTime(), modelUsed: selectedModel.id, roleUsed: selectedRole.id }]);
    setInput('');
    setIsLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const appendText = (chunk: string) =>
      setMessages((prev) => prev.map((m) => (m.id === aiId ? { ...m, text: m.text + chunk } : m)));

    try {
      // Build conversation payload; the last prompt carries the full attached context
      const payloadMessages = newMessagesList
        .filter((m) => m.id !== 'msg-welcome' && m.id !== 'msg-welcome-new' && m.text)
        .map((m) => ({ role: m.role, text: m.text }));
      payloadMessages[payloadMessages.length - 1].text = fullPromptText;

      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: payloadMessages,
          model: selectedModel.id,
          systemInstruction: selectedRole.systemInstruction + aiLanguageInstruction(),
          lang: getLang(),
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Server returned ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const line = buffer.slice(0, sep).split('\n').find((l) => l.startsWith('data: '));
          buffer = buffer.slice(sep + 2);
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.t) appendText(ev.t);
          else if (ev.error) throw new Error(ev.error);
          else if (ev.done) setMessages((prev) => prev.map((m) => (m.id === aiId ? { ...m, modelUsed: ev.model } : m)));
        }
      }
    } catch (err: any) {
      if (controller.signal.aborted || err?.name === 'AbortError') {
        appendText(`\n\n_${t('chat.stopped')}_`);
      } else {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === aiId
              ? { ...m, text: (m.text ? m.text + '\n\n' : '') + t('chat.error', { model: selectedModel.name, error: err.message || t('chat.errorDefault') }) }
              : m
          )
        );
      }
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  };

  // Prompts coming from other parts of the app are sent once, as soon as they arrive
  useEffect(() => {
    if (!externalRequest || handledRequestRef.current === externalRequest.id || isLoading) return;
    handledRequestRef.current = externalRequest.id;
    handleSendMessage(externalRequest.prompt, externalRequest.display);
  }, [externalRequest, isLoading]);

  const handleClearHistory = () => {
    abortRef.current?.abort();
    setMessages([{ ...welcomeMessage(), id: 'msg-welcome-new' }]);
  };

  const handleQuickPrompt = (prompt: string) => {
    if (!activeFile) return;
    const full = `${prompt} (${activeFile.name}):\n\`\`\`${activeFile.language}\n${activeFile.content}\n\`\`\``;
    handleSendMessage(full, `${prompt} (${activeFile.name})`);
  };

  const lastMessage = messages[messages.length - 1];
  const fileNamesKey = files.map((f) => f.name).join('|');
  const lastModelId = [...messages].reverse().find((m) => m.role === 'model' && !m.id.startsWith('msg-welcome'))?.id;
  const waitingForFirstToken = isLoading && !agentMode && lastMessage?.role === 'model' && !lastMessage.text;

  return (
    <div className="w-full border-l border-slate-800 bg-side flex flex-col h-full select-none">
      {/* Top Header */}
      <div className="px-3 py-2.5 bg-bar border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <div className="text-xs font-semibold text-fg">{t('chat.title')}</div>
            <div className="text-[10px] text-slate-400">{agentMode ? t('agent.subtitle') : t('chat.subtitle')}</div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setAgentMode(!agentMode)}
            disabled={isLoading}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold transition-colors disabled:opacity-50 ${
              agentMode ? 'bg-indigo-600 text-white' : 'bg-panel text-slate-400 hover:text-fg border border-slate-700'
            }`}
            title={t('agent.toggleTitle')}
          >
            <Workflow className="w-3.5 h-3.5" />
            <span>{t('agent.toggle')}</span>
          </button>
          <button
            onClick={handleClearHistory}
            className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors"
            title={t('chat.clear')}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Model & Role Selectors Bar */}
      <div ref={selectorBarRef} className="relative px-3 py-2 bg-raised border-b border-slate-800/80 flex items-center gap-2">
        {/* Model Selector (both menus open under the whole bar, aligned with its edges) */}
        <div className="flex-1 min-w-0">
          <button
            onClick={() => {
              setShowModelMenu(!showModelMenu);
              setShowRoleMenu(false);
            }}
            className="w-full flex items-center justify-between px-2 py-1 bg-panel hover:bg-active border border-slate-700/80 rounded text-[11px] text-slate-200 transition-colors"
          >
            <div className="flex items-center gap-1.5 truncate">
              {selectedModel.speed === 'fast' && <Zap className="w-3 h-3 text-amber-400" />}
              {selectedModel.speed === 'balanced' && <Sparkles className="w-3 h-3 text-sky-400" />}
              {selectedModel.speed === 'deep' && <Cpu className="w-3 h-3 text-indigo-400" />}
              <span className="truncate font-medium">{selectedModel.name}</span>
            </div>
            <ChevronDown className="w-3 h-3 text-slate-400 shrink-0 ml-1" />
          </button>

          {showModelMenu && (
            <div className="absolute left-3 right-3 top-full -mt-1 max-h-[60vh] overflow-y-auto bg-panel border border-slate-700 rounded-md shadow-2xl py-1 z-40 text-xs">
              <div className="px-2.5 py-1 text-[10px] uppercase font-semibold text-slate-400 tracking-wider">
                {t('chat.selectModel')}
              </div>
              {(
                [
                  ['gemini', 'Google Gemini'],
                  ['ollama', t('ai.groupOllama')],
                  ['custom', t('ai.groupCustom')],
                ] as const
              ).map(([provider, label]) => {
                const group = models.filter((m) => m.provider === provider);
                if (group.length === 0) return null;
                return (
                  <div key={provider}>
                    <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold text-slate-500">{label}</div>
                    {group.map((model) => (
                      <button
                        key={model.id}
                        onClick={() => {
                          setSelectedModel(model.id);
                          setShowModelMenu(false);
                        }}
                        className={`w-full text-left px-2.5 py-1.5 hover:bg-slate-800 flex flex-col gap-0.5 ${
                          selectedModel.id === model.id ? 'bg-indigo-950/40 text-indigo-200' : 'text-slate-300'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-xs text-fg truncate">{model.name}</span>
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 shrink-0">
                            {provider === 'gemini' ? t(`model.${model.id}.tag`) : model.tag}
                          </span>
                        </div>
                        {provider === 'gemini' && (
                          <span className="text-[10px] text-slate-400 leading-tight">{t(`model.${model.id}.desc`)}</span>
                        )}
                      </button>
                    ))}
                  </div>
                );
              })}
              <div className="h-px bg-slate-800 my-1" />
              <button
                onClick={() => {
                  setShowModelMenu(false);
                  onOpenAiSettings();
                }}
                className="w-full text-left px-2.5 py-1.5 hover:bg-slate-800 text-indigo-300 flex items-center gap-1.5"
              >
                <Cpu className="w-3.5 h-3.5" />
                {t('ai.configure')}
              </button>
            </div>
          )}
        </div>

        {/* Role Selector */}
        <div className="flex-1 min-w-0">
          <button
            onClick={() => {
              setShowRoleMenu(!showRoleMenu);
              setShowModelMenu(false);
            }}
            className="w-full flex items-center justify-between px-2 py-1 bg-panel hover:bg-active border border-slate-700/80 rounded text-[11px] text-slate-200 transition-colors"
          >
            <span className="truncate font-medium">{t(`role.${selectedRole.id}`)}</span>
            <ChevronDown className="w-3 h-3 text-slate-400 shrink-0 ml-1" />
          </button>

          {showRoleMenu && (
            <div className="absolute left-3 right-3 top-full -mt-1 max-h-[60vh] overflow-y-auto bg-panel border border-slate-700 rounded-md shadow-2xl py-1 z-40 text-xs">
              <div className="px-2.5 py-1 text-[10px] uppercase font-semibold text-slate-400 tracking-wider">
                {t('chat.selectRole')}
              </div>
              {AI_ROLES.map((role) => (
                <button
                  key={role.id}
                  onClick={() => {
                    setSelectedRole(role);
                    setShowRoleMenu(false);
                  }}
                  className={`w-full text-left px-2.5 py-2 hover:bg-slate-800 flex flex-col gap-0.5 ${
                    selectedRole.id === role.id ? 'bg-indigo-950/40 text-indigo-200' : 'text-slate-300'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-xs text-fg min-w-0">{t(`role.${role.id}`)}</span>
                    <span className="shrink-0 whitespace-nowrap text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                      {t(`role.${role.id}.badge`)}
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-400 leading-tight">{t(`role.${role.id}.desc`)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Messages Thread */}
      <div className="flex-1 p-3 overflow-y-auto space-y-3 bg-deep">
        {messages.map((msg) =>
          msg.role === 'model' && !msg.text && !msg.id.startsWith('msg-welcome') ? null : (
            <ChatMessageBubble
              key={msg.id}
              message={
                msg.id === 'msg-welcome' || msg.id === 'msg-welcome-new'
                  ? { ...msg, text: t(msg.id === 'msg-welcome' ? 'chat.welcome' : 'chat.reset'), timestamp: t('chat.justNow') }
                  : msg
              }
              onInsertCode={onInsertCodeToEditor}
              onReplaceFile={onReplaceFileContent}
              onCreateFile={onCreateNewFileWithCode}
              onCreateFiles={onApplyFiles}
              fileNamesKey={fileNamesKey}
              showAgentHint={!agentMode && msg.id === lastModelId}
              onEnableAgent={() => setAgentMode(true)}
            />
          )
        )}

        {planDecision && (
          <AgentPlanCard
            plan={planDecision.plan}
            busy={planDecision.busy}
            onRun={() => planDecision.resolve({ kind: 'run' })}
            onRevise={(feedback) => planDecision.resolve({ kind: 'revise', feedback })}
            onCancel={() => planDecision.resolve({ kind: 'cancel' })}
          />
        )}

        {approval && (
          <Suspense fallback={null}>
            <AgentApprovalCard request={approval.request} onAnswer={approval.resolve} />
          </Suspense>
        )}

        {(waitingForFirstToken || agentStatus) && !approval && (
          <div className="flex items-center gap-2 p-2 text-xs text-indigo-400 bg-indigo-950/20 border border-indigo-800/30 rounded-lg">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>{agentStatus || t('chat.thinking', { model: selectedModel.name })}</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Quick Prompts Bar */}
      {activeFile && !agentMode && (
        <div className="px-2 py-1.5 bg-bar border-t border-slate-800 flex items-center gap-1.5 overflow-x-auto text-[10px] text-slate-400">
          <span className="text-slate-400 uppercase font-mono shrink-0">{t('chat.quick')}</span>
          {(
            [
              ['chat.pExplain', 'chat.qExplain'],
              ['chat.pOptimize', 'chat.qOptimize'],
              ['chat.pDebug', 'chat.qDebug'],
              ['chat.pTests', 'chat.qTests'],
            ] as const
          ).map(([prompt, label]) => (
            <button
              key={label}
              onClick={() => handleQuickPrompt(t(prompt))}
              disabled={isLoading}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 hover:text-slate-200 shrink-0 transition-colors disabled:opacity-50"
            >
              {t(label)}
            </button>
          ))}
        </div>
      )}

      {/* Input Form */}
      <div className="p-3 bg-canvas border-t border-slate-800">
        {/* Context selector (normal chat) / agent hint */}
        {agentMode ? (
          <div className="text-[11px] text-indigo-300 mb-1.5 flex items-start gap-1.5">
            <Workflow className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span className="flex-1">{t('agent.hint')}</span>
            <div className="flex flex-col gap-0.5 shrink-0">
              <label className="flex items-center gap-1 cursor-pointer text-slate-300" title={t('plan.toggleTitle')}>
                <input type="checkbox" checked={planFirst} onChange={(e) => setPlanFirst(e.target.checked)} disabled={isLoading} data-plan-toggle />
                {t('plan.toggle')}
              </label>
              <label className="flex items-center gap-1 cursor-pointer text-slate-300" title={t('agent.confirmTitle')}>
                <input type="checkbox" checked={confirmAgent} onChange={(e) => setConfirmAgent(e.target.checked)} disabled={isLoading} />
                {t('agent.confirm')}
              </label>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mb-1.5">
            <span className="shrink-0">{t('chat.context')}</span>
            <div className="flex rounded-md border border-slate-700 overflow-hidden">
              {(
                [
                  ['none', t('chat.ctxNone')],
                  ['file', t('chat.ctxFile')],
                  ['project', t('chat.ctxProject')],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setContextMode(mode)}
                  className={`px-2 py-0.5 transition-colors ${
                    contextMode === mode ? 'bg-indigo-600 text-white' : 'bg-panel hover:text-fg'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="truncate text-[10px] font-mono text-slate-500">
              {contextMode === 'file' && activeFile
                ? activeFile.name
                : contextMode === 'project'
                  ? t('chat.ctxProjectFiles', { count: files.length })
                  : ''}
            </span>
          </div>
        )}

        <div className="flex items-end gap-1.5 bg-panel border border-slate-700/80 rounded-lg p-1.5 focus-within:border-indigo-500 transition-colors">
          <textarea
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
            placeholder={agentMode ? t('agent.placeholder') : t('chat.placeholder')}
            className="w-full bg-transparent text-xs text-fg placeholder-slate-400 focus:outline-none resize-none p-1"
          />
          {isLoading ? (
            <button
              onClick={handleStop}
              className="p-1.5 rounded-md bg-rose-600 hover:bg-rose-500 text-white shrink-0 shadow transition-colors"
              title={t('chat.stop')}
            >
              <Square className="w-3.5 h-3.5 fill-current" />
            </button>
          ) : (
            <button
              onClick={() => handleSendMessage()}
              disabled={!input.trim()}
              className="p-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white shrink-0 shadow transition-colors"
              title={t('chat.send')}
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// Render Individual Chat Message Bubble with Markdown and Code Snippets
interface BubbleProps {
  message: ChatMessage;
  onInsertCode: (code: string) => void;
  onReplaceFile: (code: string) => void;
  onCreateFile: (filename: string, code: string) => void;
  /** Create (or overwrite) every named file of the answer at once */
  onCreateFiles?: (files: { name: string; content: string }[]) => void;
  /** Names of the project's files, "|"-joined (a string keeps React.memo effective) */
  fileNamesKey?: string;
  /** Under the latest answer with code while agent mode is off: explain how the AI can write files itself */
  showAgentHint?: boolean;
  onEnableAgent?: () => void;
}

const ChatMessageBubble: React.FC<BubbleProps> = React.memo(({
  message,
  onInsertCode,
  onReplaceFile,
  onCreateFile,
  onCreateFiles,
  fileNamesKey = '',
  showAgentHint,
  onEnableAgent,
}) => {
  const isUser = message.role === 'user';
  const { t } = useI18n();
  const blocks = useMemo(() => (isUser ? [] : extractCodeFiles(message.text)), [isUser, message.text]);
  const named = useMemo(() => namedFiles(blocks), [blocks]);

  const createAll = () => {
    const existing = new Set(fileNamesKey.split('|').map((n) => n.toLowerCase()));
    const replaced = named.filter((f) => existing.has(f.name.toLowerCase())).map((f) => f.name);
    if (replaced.length && !confirm(t('chat.overwriteConfirm', { list: replaced.join(', ') }))) return;
    onCreateFiles?.(named);
  };

  // Markdown for AI answers; fenced code blocks keep highlighting and Insert/Replace/New File actions
  const markdownComponents: Components = {
    pre: ({ children, node }) => {
      const codeEl = React.Children.toArray(children)[0] as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
      const lang = /language-([\w+#-]+)/.exec(codeEl?.props?.className || '')?.[1] || 'text';
      const code = String(codeEl?.props?.children ?? '').replace(/\n$/, '');
      const offset = node?.position?.start.offset;
      const filename = blocks.find((b) => b.offset === offset)?.filename || undefined;
      return (
        <CodeBlockItem language={lang} code={code} filename={filename} onInsert={onInsertCode} onReplace={onReplaceFile} onCreate={onCreateFile} />
      );
    },
    code: ({ children, className }) => <code className={className}>{children}</code>,
    a: ({ children, href }) => (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
    table: ({ children }) => (
      <div className="chat-md-table">
        <table>{children}</table>
      </div>
    ),
  };

  return (
    <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[94%] min-w-0 rounded-xl px-3 py-2 text-xs select-text ${
          isUser
            ? 'bg-indigo-600 text-white shadow-sm'
            : 'bg-panel text-slate-200 border border-slate-700/80 shadow-md'
        }`}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap leading-relaxed text-xs break-words">{message.text}</div>
        ) : (
          <div className="chat-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {message.text}
            </ReactMarkdown>
          </div>
        )}
      </div>

      {!isUser && named.length > 0 && onCreateFiles && (
        <button
          onClick={createAll}
          data-create-files
          className="mt-1 flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold max-w-[94%]"
          title={named.map((f) => f.name).join('\n')}
        >
          <FilePlus className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">
            {t('chat.createFiles', { count: named.length })}: {named.map((f) => f.name).join(', ')}
          </span>
        </button>
      )}
      {!isUser && showAgentHint && blocks.length > 0 && (
        <div className="mt-1 max-w-[94%] px-1 text-[10px] text-slate-400 leading-snug" data-agent-hint>
          💡 {t('chat.agentHint')}{' '}
          {onEnableAgent && (
            <button onClick={onEnableAgent} className="text-indigo-400 hover:underline">
              {t('chat.enableAgent')}
            </button>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 mt-1 px-1 text-[10px] text-slate-400">
        <span>{message.timestamp}</span>
        {message.modelUsed && <span>· {message.modelUsed}</span>}
      </div>
    </div>
  );
});

// Code block with insert, replace, copy actions
interface CodeBlockProps {
  language: string;
  code: string;
  /** File name found in the answer (caption, title or first-line comment) */
  filename?: string;
  onInsert: (code: string) => void;
  onReplace: (code: string) => void;
  onCreate: (filename: string, code: string) => void;
}

const CodeBlockItem: React.FC<CodeBlockProps> = ({
  language,
  code,
  filename,
  onInsert,
  onReplace,
  onCreate,
}) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getSuggestedFilename = (lang: string) => {
    switch (lang.toLowerCase()) {
      case 'python':
      case 'py':
        return 'script.py';
      case 'javascript':
      case 'js':
        return 'script.js';
      case 'typescript':
      case 'ts':
        return 'app.ts';
      case 'bash':
      case 'sh':
        return 'task.sh';
      case 'sql':
        return 'query.sql';
      case 'html':
        return 'index.html';
      case 'css':
        return 'style.css';
      default:
        return 'code.txt';
    }
  };

  return (
    <div className="my-2 rounded-lg border border-slate-700 bg-bar overflow-hidden">
      {/* Code Header */}
      <div className="px-2.5 py-1 bg-raised border-b border-slate-800 flex items-center justify-between text-[11px] text-slate-400">
        {filename ? (
          <span className="font-mono text-emerald-300 text-[11px] truncate" title={language}>
            {filename}
          </span>
        ) : (
          <span className="font-mono text-indigo-400 uppercase text-[10px] font-bold">{language}</span>
        )}
        <div className="flex items-center gap-1">
          <button
            onClick={() => onInsert(code)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-slate-800 text-slate-300 hover:text-fg"
            title={t('chat.insertTitle')}
          >
            <ArrowRightCircle className="w-3 h-3 text-sky-400" />
            <span>{t('chat.insert')}</span>
          </button>
          <button
            onClick={() => onReplace(code)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-slate-800 text-slate-300 hover:text-fg"
            title={t('chat.replaceTitle')}
          >
            <RefreshCw className="w-3 h-3 text-amber-400" />
            <span>{t('chat.replace')}</span>
          </button>
          <button
            onClick={() => onCreate(filename || getSuggestedFilename(language), code)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-slate-800 text-slate-300 hover:text-fg"
            title={t('chat.newFileTitle')}
          >
            <FilePlus className="w-3 h-3 text-emerald-400" />
            <span>{t('chat.newFile')}</span>
          </button>
          <button
            onClick={handleCopy}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-fg"
            title={t('chat.copy')}
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Code Body */}
      <pre
        className="p-2.5 font-mono text-[11px] leading-relaxed overflow-x-auto text-slate-300 whitespace-pre"
        dangerouslySetInnerHTML={{
          __html: highlightCode(code, language),
        }}
      />
    </div>
  );
};
