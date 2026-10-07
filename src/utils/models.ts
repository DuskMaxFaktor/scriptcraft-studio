import { useEffect, useSyncExternalStore } from 'react';
import { ModelOption } from '../types.ts';

// One shared list of AI models (Gemini + the user's own providers) and one selected model,
// used by the chat, the agent, the script wizard and the editor's AI actions.

export interface AppModel extends ModelOption {
  provider: 'gemini' | 'ollama' | 'custom';
}

const GEMINI_MODELS: AppModel[] = [
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', tag: 'Default', desc: '', speed: 'balanced', provider: 'gemini' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', tag: 'Fast', desc: '', speed: 'fast', provider: 'gemini' },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', tag: 'Paid Plan', desc: '', speed: 'deep', provider: 'gemini' },
];

const STORAGE_KEY = 'scriptcraft-model';

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
let version = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

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

export function setSelectedModel(id: string) {
  selectedId = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
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

/** React hook: the model list, the selected model and the provider status; loads the list once. */
export function useModels() {
  useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => {
    if (!loaded) {
      loaded = true;
      refreshModels();
    }
  }, []);
  return { models, status, selected: modelInfo(selectedId), setSelectedModel, refreshModels };
}
