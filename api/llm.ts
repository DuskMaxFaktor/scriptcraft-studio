import { readSettings } from './settings.ts';

// Models outside Gemini, chosen by the user: local Ollama models ("ollama:<name>")
// and any OpenAI-compatible server ("custom:<name>"), e.g. LM Studio, OpenRouter, Groq.

export interface LlmMessage {
  role: 'user' | 'model';
  text: string;
}

export interface ExternalModel {
  id: string;
  name: string;
  provider: 'ollama' | 'custom';
}

export const isExternalModel = (id?: string) => !!id && (id.startsWith('ollama:') || id.startsWith('custom:'));

interface Endpoint {
  url: string;
  apiKey: string;
  model: string;
  label: string;
}

function resolve(modelId: string): Endpoint {
  const s = readSettings();
  if (modelId.startsWith('ollama:')) {
    if (!s.ollama.enabled) throw new Error('Ollama отключена в настройках нейросетей / Ollama is disabled in AI settings');
    return { url: `${s.ollama.baseUrl}/v1/chat/completions`, apiKey: '', model: modelId.slice(7), label: 'Ollama' };
  }
  if (!s.custom.enabled) throw new Error('Свой сервер отключён в настройках нейросетей / Custom server is disabled');
  return { url: `${s.custom.baseUrl}/chat/completions`, apiKey: s.custom.apiKey, model: modelId.slice(7), label: s.custom.name };
}

function toOpenAiMessages(system: string, messages: LlmMessage[]) {
  return [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...messages.map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text })),
  ];
}

async function post(ep: Endpoint, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(ep.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {}),
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'ScriptCraft Studio',
      },
      body: JSON.stringify({ model: ep.model, ...body }),
      signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(
      ep.label === 'Ollama'
        ? 'Ollama не отвечает. Установите её с https://ollama.com и запустите (или проверьте адрес в настройках нейросетей).'
        : `Сервер «${ep.label}» не отвечает (${ep.url}): ${err?.message || err}`
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.error?.message || j.error || j.message || text;
    } catch {
      // plain text error
    }
    if (res.status === 404 && ep.label === 'Ollama') {
      msg = `Модель «${ep.model}» не найдена в Ollama. Скачайте её командой: ollama pull ${ep.model}`;
    }
    throw new Error(`${ep.label}: ${String(msg).slice(0, 400)} (HTTP ${res.status})`);
  }
  return res;
}

// ---------- Ollama: its own API, so the context window (num_ctx) can be set ----------

/** Smaller context windows that worked for a model after an out-of-memory error (until the studio restarts). */
const ollamaCtx = new Map<string, number>();
const MIN_CTX = 2048;
const isOutOfMemory = (msg: string) => /out.of.memory|failed to allocate|insufficient memory|requires more system memory|cudaMalloc|not enough memory/i.test(msg);

function ollamaMessages(system: string, messages: LlmMessage[]) {
  return [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...messages.map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text })),
  ];
}

/** POST /api/chat, retrying with a halved context window while the model does not fit into memory. */
async function ollamaPost(modelId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const s = readSettings();
  if (!s.ollama.enabled) throw new Error('Ollama отключена в настройках нейросетей / Ollama is disabled in AI settings');
  const model = modelId.slice(7);
  let ctx = Math.min(ollamaCtx.get(model) ?? s.ollama.contextLength, s.ollama.contextLength);
  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${s.ollama.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, ...body, options: { ...((body.options as object) || {}), num_ctx: ctx } }),
        signal,
      });
    } catch (err: any) {
      if (err?.name === 'TimeoutError') throw new Error(`Ollama: модель не ответила за ${OLLAMA_REQUEST_MS / 60000} мин (возможно, видеокарта занята другой программой, например игрой). / The model did not answer in time.`);
      if (err?.name === 'AbortError') throw err;
      throw new Error('Ollama не отвечает. Установите её с https://ollama.com и запустите (или проверьте адрес в настройках нейросетей).');
    }
    if (res.ok) {
      if (ctx < s.ollama.contextLength) ollamaCtx.set(model, ctx);
      return res;
    }
    const text = await res.text().catch(() => '');
    let msg = text;
    try {
      msg = JSON.parse(text).error || text;
    } catch {
      // plain text error
    }
    if (res.status === 404) throw new Error(`Модель «${model}» не найдена в Ollama. Скачайте её командой: ollama pull ${model}`);
    if (isOutOfMemory(msg)) {
      if (ctx > MIN_CTX) {
        ctx = Math.max(MIN_CTX, Math.floor(ctx / 2));
        continue;
      }
      throw new Error(
        `Модели «${model}» не хватает памяти даже с коротким контекстом (${MIN_CTX} токенов). Выберите модель поменьше ` +
          `(например, с меньшим числом параметров или квантованием q4), закройте другие программы или остановите лишние модели (ollama ps / ollama stop). ` +
          `/ The model does not fit into memory even with a ${MIN_CTX}-token context. (Ollama: ${String(msg).slice(0, 200)})`
      );
    }
    throw new Error(`Ollama: ${String(msg).slice(0, 400)} (HTTP ${res.status})`);
  }
}

export interface JsonOptions {
  /** JSON schema of the answer: Ollama then generates only valid JSON of that shape (and stops at its end) */
  schema?: Record<string, unknown>;
  /** Longest answer in tokens */
  maxTokens?: number;
}

/** A non-streamed answer never takes longer than this: a stuck generation is cancelled (Ollama stops on disconnect). */
const OLLAMA_REQUEST_MS = 6 * 60 * 1000;

async function ollamaChat(modelId: string, system: string, messages: LlmMessage[], temperature: number, json = false, jsonOpts: JsonOptions = {}): Promise<string> {
  const res = await ollamaPost(
    modelId,
    {
      messages: ollamaMessages(system, messages),
      stream: false,
      // Plain "json" mode lets small models emit whitespace forever; a schema keeps the answer finite
      ...(json ? { format: jsonOpts.schema || 'json' } : {}),
      options: { temperature, ...(json ? { num_predict: jsonOpts.maxTokens ?? 8192 } : {}) },
    },
    AbortSignal.timeout(OLLAMA_REQUEST_MS)
  );
  const data = await res.json();
  const text = data.message?.content;
  if (!text) throw new Error('Ollama: empty response');
  return text;
}

async function ollamaStream(
  modelId: string,
  system: string,
  messages: LlmMessage[],
  onChunk: (t: string) => void,
  isAborted: () => boolean,
  temperature: number
): Promise<void> {
  const controller = new AbortController();
  const res = await ollamaPost(modelId, { messages: ollamaMessages(system, messages), stream: true, options: { temperature } }, controller.signal);
  if (!res.body) throw new Error('Ollama: no response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let produced = false;
  for (;;) {
    if (isAborted()) {
      controller.abort();
      return;
    }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      // The model can still run out of memory after the answer started
      if (j.error) throw new Error(isOutOfMemory(j.error) ? `Ollama: не хватает памяти (${j.error}). Уменьшите контекст в настройках нейросетей.` : `Ollama: ${j.error}`);
      const t = j.message?.content;
      if (t) {
        produced = true;
        onChunk(t);
      }
      if (j.done) return;
    }
  }
  if (!produced && !isAborted()) throw new Error('Ollama: empty response');
}

export async function externalChat(modelId: string, system: string, messages: LlmMessage[], temperature = 0.7): Promise<string> {
  if (modelId.startsWith('ollama:')) return ollamaChat(modelId, system, messages, temperature);
  const ep = resolve(modelId);
  const res = await post(ep, { messages: toOpenAiMessages(system, messages), temperature, stream: false });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${ep.label}: empty response`);
  return text;
}

/** Stream an answer; calls onChunk with text pieces as they arrive. */
export async function externalChatStream(
  modelId: string,
  system: string,
  messages: LlmMessage[],
  onChunk: (t: string) => void,
  isAborted: () => boolean,
  temperature = 0.7
): Promise<void> {
  if (modelId.startsWith('ollama:')) return ollamaStream(modelId, system, messages, onChunk, isAborted, temperature);
  const ep = resolve(modelId);
  const controller = new AbortController();
  const res = await post(ep, { messages: toOpenAiMessages(system, messages), temperature, stream: true }, controller.signal);
  if (!res.body) throw new Error(`${ep.label}: no response body`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let produced = false;
  for (;;) {
    if (isAborted()) {
      controller.abort();
      break;
    }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const j = JSON.parse(payload);
        const t = j.choices?.[0]?.delta?.content;
        if (t) {
          produced = true;
          onChunk(t);
        }
      } catch {
        // keep-alive or partial line
      }
    }
  }
  if (!produced && !isAborted()) throw new Error(`${ep.label}: empty response`);
}

/**
 * Local models (Ollama, small open models) often ignore a language hint buried at the end of a long English system
 * prompt. For Russian replies say it first in the system prompt and once more right before the answer, at the end
 * of the last user message (only in the request: the chat history is not changed).
 */
export function withReplyLanguage(system: string, messages: LlmMessage[], lang?: string, json = false): { system: string; messages: LlmMessage[] } {
  if (lang !== 'ru') return { system, messages };
  const head = json
    ? 'ВАЖНО: текст поля "message" пиши на русском языке (код и имена в коде — как обычно).'
    : 'ВАЖНО: отвечай пользователю на русском языке (код и имена в коде — как обычно).';
  const tail = json ? '\n\n(Поле "message" — на русском языке.)' : '\n\n(Ответь на русском языке.)';
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user') {
      out[i] = { ...out[i], text: out[i].text + tail };
      break;
    }
  }
  return { system: `${head}\n\n${system}`, messages: out };
}

/** Pull the first JSON object out of a reply (models sometimes wrap it in text or ``` fences). */
export function extractJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        // fall through
      }
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('The model did not return JSON');
  }
}

/** JSON answer (agent steps). Retries once with a reminder if the model replies with something else. */
export async function externalJson(modelId: string, system: string, messages: LlmMessage[], jsonOpts: JsonOptions = {}): Promise<any> {
  if (modelId.startsWith('ollama:')) {
    const first = await ollamaChat(modelId, system, messages, 0.3, true, jsonOpts);
    try {
      return extractJson(first);
    } catch {
      return extractJson(
        await ollamaChat(
          modelId,
          system,
          [
            ...messages,
            { role: 'model', text: first.slice(0, 2000) },
            { role: 'user', text: 'Your previous answer was not valid JSON. Reply again with ONLY the JSON object, nothing else.' },
          ],
          0.3,
          true,
          jsonOpts
        )
      );
    }
  }
  const ep = resolve(modelId);
  const ask = async (msgs: LlmMessage[]) => {
    const res = await post(ep, {
      messages: toOpenAiMessages(system, msgs),
      temperature: 0.3,
      stream: false,
      response_format: { type: 'json_object' },
    });
    const data = await res.json();
    return String(data.choices?.[0]?.message?.content || '');
  };
  const first = await ask(messages);
  try {
    return extractJson(first);
  } catch {
    const second = await ask([
      ...messages,
      { role: 'model', text: first.slice(0, 2000) },
      { role: 'user', text: 'Your previous answer was not valid JSON. Reply again with ONLY the JSON object, nothing else.' },
    ]);
    return extractJson(second);
  }
}

/** Models available right now: installed Ollama models + the custom server's models. */
export async function listExternalModels(): Promise<{ models: ExternalModel[]; ollama: 'off' | 'ok' | 'unreachable'; custom: 'off' | 'ok' | 'unreachable' }> {
  const s = readSettings();
  const models: ExternalModel[] = [];
  let ollama: 'off' | 'ok' | 'unreachable' = 'off';
  let custom: 'off' | 'ok' | 'unreachable' = 'off';

  if (s.ollama.enabled) {
    try {
      const res = await fetch(`${s.ollama.baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
      const data = await res.json();
      for (const m of data.models || []) models.push({ id: `ollama:${m.name}`, name: m.name, provider: 'ollama' });
      ollama = 'ok';
    } catch {
      ollama = 'unreachable';
    }
  }

  if (s.custom.enabled) {
    let names = s.custom.models;
    custom = 'ok';
    if (names.length === 0) {
      try {
        const res = await fetch(`${s.custom.baseUrl}/models`, {
          headers: s.custom.apiKey ? { Authorization: `Bearer ${s.custom.apiKey}` } : {},
          signal: AbortSignal.timeout(3000),
        });
        const data = await res.json();
        names = (data.data || []).map((m: any) => String(m.id)).slice(0, 100);
      } catch {
        custom = 'unreachable';
      }
    }
    for (const n of names) models.push({ id: `custom:${n}`, name: n, provider: 'custom' });
  }
  return { models, ollama, custom };
}

/**
 * Inline code completion with a local Ollama model ("fill in the middle": code before and after the cursor).
 * Returns '' when suggestions are off. Kept short: it runs on every pause in typing.
 */
export async function inlineComplete(prefix: string, suffix: string, signal: AbortSignal): Promise<string> {
  const s = readSettings();
  if (!s.completion.enabled || !s.completion.model || !s.ollama.enabled) return '';
  let res: Response;
  try {
    res = await fetch(`${s.ollama.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: s.completion.model,
        prompt: prefix.slice(-4000),
        // A non-empty suffix makes Ollama use the model's fill-in-the-middle template instead of chat
        suffix: suffix.slice(0, 1500) || '\n',
        stream: false,
        keep_alive: '30m',
        // Small context = much faster on PCs where the model does not fit into video memory.
        // Stop at the end of the current block instead of inventing the next functions.
        options: {
          temperature: 0.2,
          num_predict: 64,
          num_ctx: 4096,
          stop: ['\n\n\n', '\ndef ', '\nclass ', '\nfunction ', '\nexport ', '\nasync def ', '<|endoftext|>', '<|file_sep|>'],
        },
      }),
      signal,
    });
  } catch {
    return '';
  }
  if (!res.ok) return '';
  const data = await res.json().catch(() => ({}));
  return String(data.response || '').replace(/\s+$/, '');
}

/** Gemini-style schema (OBJECT / STRING / nullable) as a standard JSON schema for Ollama's structured output. */
export function toJsonSchema(schema: any): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return {};
  const type = String(schema.type || '').toLowerCase();
  const out: Record<string, unknown> = { type: schema.nullable ? [type, 'null'] : type };
  if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toJsonSchema(v)]));
  if (schema.items) out.items = toJsonSchema(schema.items);
  if (schema.required) out.required = schema.required;
  return out;
}
