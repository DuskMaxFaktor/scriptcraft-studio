import { useEffect, useSyncExternalStore } from 'react';
import { ModelOption } from '../types.ts';

// Shared AI model list (Gemini + the user's providers). Chat and agent can use different models.

export interface AppModel extends ModelOption {
  provider: 'gemini' | 'ollama' | 'custom';
}

const GEMINI_MODELS: AppModel[] = [
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', tag: 'Default', desc: '', speed: 'balanced', provider: 'gemini' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', tag: 'Fast', desc: '', speed: 'fast', provider: 'gemini' },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', tag: 'Paid Plan', desc: '', speed: 'deep', provider: 'gemini' },
];

const STORAGE_KEY = 'scriptcraft-model';
/**
 * Agent/plan model:
 * - missing key → auto (prefer local coder / abliterated when present)
 * - "same" → always follow the chat model
 * - model id → fixed choice
 */
const STORAGE_KEY_AGENT = 'scriptcraft-agent-model';

let models: AppModel[] = GEMINI_MODELS;
let status: { ollama: string; custom: string } = { ollama: 'off', custom: 'off' };
let selectedId: string = (() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    // "gcli:" models (Gemini CLI with a Google account) are no longer offered
    return saved && !saved.startsWith('gcli:') ? saved : GEMINI_MODELS[0].id;
  } catch {
    return GEMINI_MODELS[0].id;
  }
})();

type AgentPick = 'auto' | 'same' | string;
let agentPick: AgentPick = (() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_AGENT);
    if (saved === null) return 'auto';
    if (!saved || saved === 'same' || saved.startsWith('gcli:')) return 'same';
    return saved;
  } catch {
    return 'auto';
  }
})();

let version = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

/** Score a model name for agent/JSON work; higher is better. */
export function scoreAgentModelName(name: string): number {
  const n = name.toLowerCase();
  let s = 0;
  if (/\bcoder\b/.test(n) || n.includes('coder')) s += 30;
  if (n.includes('abliterated')) s += 25;
  if (n.includes('nemo') && n.includes('abliterated')) s += 10;
  if (n.includes('qwen')) s += 8;
  if (n.includes('instruct')) s += 3;
  // Fine-tunes without abliterated often wander on unschemed JSON
  if (/custom-v\d+/i.test(n) && !n.includes('abliterated')) s -= 10;
  return s;
}

/**
 * Best local model for agent steps/plans, or null if nothing looks better than a generic chat model.
 * Prefers *coder* / *abliterated* Ollama tags.
 */
export function pickPreferredAgentModel(list: AppModel[]): string | null {
  const ollama = list.filter((m) => m.provider === 'ollama');
  if (ollama.length === 0) return null;
  const ranked = [...ollama].sort((a, b) => {
    const d = scoreAgentModelName(b.name) - scoreAgentModelName(a.name);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  const best = ranked[0];
  // Need at least an abliterated (25) or coder (30) signal — plain chat tags stay on "follow chat".
  return scoreAgentModelName(best.name) >= 25 ? best.id : null;
}

export async function refreshModels(): Promise<void> {
  try {
    const data = await (await fetch('/api/models')).json();
    const external: AppModel[] = (data.models || [])
      .filter((m: any) => m.provider !== 'gemini')
      .map((m: any) => ({ id: m.id, name: m.name, tag: m.tag, desc: '', speed: 'balanced', provider: m.provider }));
    models = [...GEMINI_MODELS, ...external];
    status = data.status || status;
  } catch {
    models = GEMINI_MODELS;
  }
  emit();
}

export function getSelectedModelId(): string {
  return selectedId;
}

/** Model used for agent steps and plans (falls back to the chat model). */
export function getSelectedAgentModelId(): string {
  if (agentPick === 'same') return selectedId;
  if (agentPick !== 'auto') return agentPick;
  return pickPreferredAgentModel(models) || selectedId;
}

export function setSelectedModel(id: string) {
  selectedId = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // storage unavailable
  }
  emit();
}

/**
 * Choose the agent model:
 * - null / "same" → always follow chat
 * - "auto" → prefer local coder/abliterated when available
 * - model id → fixed choice
 */
export function setSelectedAgentModel(id: string | null | 'auto' | 'same') {
  if (!id || id === 'same') agentPick = 'same';
  else if (id === 'auto') agentPick = 'auto';
  else agentPick = id;
  try {
    if (agentPick === 'auto') localStorage.removeItem(STORAGE_KEY_AGENT);
    else localStorage.setItem(STORAGE_KEY_AGENT, agentPick === 'same' ? 'same' : agentPick);
  } catch {
    // storage unavailable
  }
  emit();
}

/** Display info for a model id (also for ids that are not in the current list, e.g. Ollama stopped). */
export function modelInfo(id: string): AppModel {
  return (
    models.find((m) => m.id === id) || {
      id,
      name: id.replace(/^(ollama|custom):/, ''),
      tag: id.startsWith('ollama:') ? 'Ollama' : id.startsWith('custom:') ? 'API' : '',
      desc: '',
      speed: 'balanced',
      provider: id.startsWith('ollama:') ? 'ollama' : id.startsWith('custom:') ? 'custom' : 'gemini',
    }
  );
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

let loaded = false;

/** React hook: the model list, chat + agent selection, and provider status. */
export function useModels() {
  useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => {
    if (!loaded) {
      loaded = true;
      refreshModels();
    }
  }, []);
  const agentFollowsChat = agentPick === 'same';
  const agentIsAuto = agentPick === 'auto';
  const effectiveAgentId = getSelectedAgentModelId();
  return {
    models,
    status,
    selected: modelInfo(selectedId),
    setSelectedModel,
    /** Effective agent model (never null). */
    selectedAgent: modelInfo(effectiveAgentId),
    /** True when the user pinned the agent to the chat model. */
    agentFollowsChat,
    /** True when auto-picking coder/abliterated (default until the user chooses). */
    agentIsAuto,
    setSelectedAgentModel,
    refreshModels,
  };
}
