import { Router } from 'express';
import fs from 'fs';
import path from 'path';

// AI provider settings live in settings.json next to the studio (never sent back with keys in clear).

export interface AiSettings {
  /** contextLength: the chat's context window (num_ctx); a model's own default (up to 128K tokens)
   *  can need tens of GB of memory for its KV cache */
  ollama: { enabled: boolean; baseUrl: string; contextLength: number };
  /** Inline code suggestions in the editor (local Ollama model only: they fire on every pause in typing) */
  completion: { enabled: boolean; model: string };
  custom: { enabled: boolean; name: string; baseUrl: string; apiKey: string; models: string[] };
  /** Daily backups of all projects; dir '' = Documents\ScriptCraft Studio Backups */
  backups: { enabled: boolean; keep: number; dir: string };
  /** Updates: GitHub repository "owner/name" whose releases carry ScriptCraftStudio-Setup.exe; '' = off */
  update: { repo: string; autoCheck: boolean };
}

const SETTINGS_FILE = path.join(process.cwd(), 'settings.json');
const ENV_FILE = path.join(process.cwd(), '.env');

const DEFAULTS: AiSettings = {
  ollama: { enabled: true, baseUrl: 'http://127.0.0.1:11434', contextLength: 8192 },
  completion: { enabled: false, model: '' },
  custom: { enabled: false, name: 'My server', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', models: [] },
  backups: { enabled: true, keep: 7, dir: '' },
  update: { repo: '', autoCheck: true },
};

export function readSettings(): AiSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    return {
      ollama: { ...DEFAULTS.ollama, ...(raw.ollama || {}) },
      completion: { ...DEFAULTS.completion, ...(raw.completion || {}) },
      custom: { ...DEFAULTS.custom, ...(raw.custom || {}) },
      backups: { ...DEFAULTS.backups, ...(raw.backups || {}) },
      update: { ...DEFAULTS.update, ...(raw.update || {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function writeSettings(s: AiSettings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf-8');
}

const mask = (key: string) => (key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '');

function geminiKey(): string {
  try {
    const m = fs.readFileSync(ENV_FILE, 'utf-8').match(/^GEMINI_API_KEY\s*=\s*"?([^"\r\n]*)"?/m);
    const key = (m?.[1] || '').trim();
    return key.startsWith('MY_GEMINI') ? '' : key;
  } catch {
    return '';
  }
}

/** Replace (or add) GEMINI_API_KEY in .env, keeping the other lines. */
function setGeminiKey(key: string) {
  let text = '';
  try {
    text = fs.readFileSync(ENV_FILE, 'utf-8');
  } catch {
    // no .env yet
  }
  const line = `GEMINI_API_KEY="${key}"`;
  text = /^GEMINI_API_KEY\s*=.*$/m.test(text) ? text.replace(/^GEMINI_API_KEY\s*=.*$/m, line) : `${text.trimEnd()}\n${line}\n`;
  fs.writeFileSync(ENV_FILE, text, 'utf-8');
}

const isHttpUrl = (u: string) => /^https?:\/\/[^\s]+$/i.test(u);

export const settingsRouter = Router();

settingsRouter.get('/', (_req, res) => {
  const s = readSettings();
  const g = geminiKey();
  res.json({
    gemini: { hasKey: !!g, keyMasked: mask(g) },
    ollama: s.ollama,
    completion: s.completion,
    custom: { ...s.custom, apiKey: '', hasKey: !!s.custom.apiKey, keyMasked: mask(s.custom.apiKey) },
  });
});

settingsRouter.put('/', (req, res) => {
  const body = req.body || {};
  const s = readSettings();

  if (typeof body.gemini?.apiKey === 'string' && body.gemini.apiKey.trim()) {
    const key = body.gemini.apiKey.trim();
    if (!/^[\w.\-]{10,200}$/.test(key)) return res.status(400).json({ error: 'Invalid Gemini API key format' });
    setGeminiKey(key);
  }

  if (body.ollama) {
    const baseUrl = String(body.ollama.baseUrl ?? s.ollama.baseUrl).trim().replace(/\/+$/, '');
    if (!isHttpUrl(baseUrl)) return res.status(400).json({ error: 'Invalid Ollama URL' });
    const ctx = Number(body.ollama.contextLength ?? s.ollama.contextLength);
    if (!Number.isInteger(ctx) || ctx < 2048 || ctx > 131072) return res.status(400).json({ error: 'Context length must be 2048-131072' });
    s.ollama = { enabled: !!body.ollama.enabled, baseUrl, contextLength: ctx };
  }

  if (body.completion) {
    const model = String(body.completion.model || '').trim();
    if (model && !/^[\w.:/@-]{1,200}$/.test(model)) return res.status(400).json({ error: 'Invalid model name' });
    s.completion = { enabled: !!body.completion.enabled && !!model, model };
  }

  if (body.custom) {
    const baseUrl = String(body.custom.baseUrl ?? s.custom.baseUrl).trim().replace(/\/+$/, '');
    if (body.custom.enabled && !isHttpUrl(baseUrl)) return res.status(400).json({ error: 'Invalid server URL' });
    const models = (Array.isArray(body.custom.models) ? body.custom.models : String(body.custom.models || '').split(/[\s,]+/))
      .map((m: unknown) => String(m).trim())
      .filter(Boolean)
      .slice(0, 50);
    s.custom = {
      enabled: !!body.custom.enabled,
      name: String(body.custom.name || 'My server').slice(0, 40),
      baseUrl,
      // An empty key field means "keep the saved key"; clearKey removes it
      apiKey: body.custom.clearKey ? '' : typeof body.custom.apiKey === 'string' && body.custom.apiKey.trim() ? body.custom.apiKey.trim() : s.custom.apiKey,
      models,
    };
  }

  writeSettings(s);
  res.json({ ok: true });
});
