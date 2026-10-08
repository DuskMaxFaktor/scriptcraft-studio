import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { isExternalModel, externalChat, externalChatStream, externalJson, withReplyLanguage, toJsonSchema, type LlmMessage } from './llm.ts';

// Lazily initialize the GoogleGenAI instance server-side so a missing key
// produces a clear error instead of a startup warning / opaque API failure.
// .env is re-read on every call, so a newly added key works without a restart.
let aiInstance: GoogleGenAI | null = null;
let aiInstanceKey = '';

function getAI(): GoogleGenAI {
  dotenv.config({ path: path.join(process.cwd(), '.env'), override: true, quiet: true });
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey.startsWith('MY_GEMINI')) {
    throw new Error(
      'GEMINI_API_KEY не задан. Получите бесплатный ключ на https://aistudio.google.com/apikey и впишите его в файл .env (строка GEMINI_API_KEY="...").'
    );
  }
  if (!aiInstance || aiInstanceKey !== apiKey) {
    aiInstance = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
        // The SDK's own retries (5 attempts, pauses up to 60 s) made an overloaded model look frozen;
        // one quick retry, then the studio moves on to the next model itself
        retryOptions: { attempts: 2, initialDelay: 1, maxDelay: 3 },
        // Tests point this at a fake Gemini server
        ...(process.env.SCRIPTCRAFT_GEMINI_BASE_URL ? { baseUrl: process.env.SCRIPTCRAFT_GEMINI_BASE_URL } : {}),
      },
    });
    aiInstanceKey = apiKey;
  }
  return aiInstance;
}

/** An image attached to a chat message: base64 data (no data: prefix) and its MIME type. */
export interface ChatImage {
  mime: string;
  data: string;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  images?: ChatImage[];
}

export interface ChatOptions {
  model?: string;
  systemInstruction?: string;
  messages: ChatMessage[];
  temperature?: number;
}

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);
const MAX_IMAGES_PER_MSG = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // ~8 MB per image

/** Keep only well-formed images of an allowed type within the size limit. */
function cleanImages(images: unknown): ChatImage[] | undefined {
  if (!Array.isArray(images)) return undefined;
  const out: ChatImage[] = [];
  for (const im of images) {
    const mime = String((im as any)?.mime || '').toLowerCase();
    const data = String((im as any)?.data || '');
    if (!IMAGE_MIME.has(mime) || !/^[A-Za-z0-9+/=]+$/.test(data)) continue;
    if (data.length * 0.75 > MAX_IMAGE_BYTES) continue;
    out.push({ mime, data });
    if (out.length >= MAX_IMAGES_PER_MSG) break;
  }
  return out.length ? out : undefined;
}

/** Normalize every message's images (drop bad ones). Returns a new array. */
function withCleanImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    const images = cleanImages((m as any).images);
    return images ? { role: m.role, text: m.text, images } : { role: m.role, text: m.text };
  });
}

/** Gemini parts for one message: the text plus any inline images. */
function toGeminiParts(m: ChatMessage): any[] {
  const parts: any[] = [];
  if (m.text) parts.push({ text: m.text });
  for (const im of m.images || []) parts.push({ inlineData: { mimeType: im.mime, data: im.data } });
  return parts.length ? parts : [{ text: '' }];
}

/** Convert chat messages (with {mime,data} images) to LlmMessages (images as plain base64 for Ollama). */
function toLlmMessages(messages: ChatMessage[]): LlmMessage[] {
  return messages.map((m) => (m.images?.length ? { role: m.role, text: m.text, images: m.images.map((i) => i.data) } : { role: m.role, text: m.text }));
}

// Allowed models based on task requirements
export const ALLOWED_MODELS = [
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', tag: 'General', desc: 'Balanced speed and high code quality (Default)' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', tag: 'Fast', desc: 'Ultra-fast snippets, regex & quick answers' },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', tag: 'Paid Plan', desc: 'Deep architectural reasoning (Requires paid API key)' },
];

type UiLang = 'ru' | 'en';

const FALLBACK_CHAIN = ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'];

// Models that recently failed with a quota/availability error are skipped until this time,
// so each request doesn't first waste a round-trip on a model that is known to be exhausted.
type FailureKind = 'daily' | 'rate' | 'overloaded' | 'notfound' | 'timeout' | 'other';

// How long one model may take before the next one is tried (Google's servers can hang when overloaded)
export const GEMINI_TIMEOUTS = { chat: 60_000, code: 90_000, agent: 120_000, plan: 60_000, streamFirst: 45_000, streamIdle: 60_000, total: 150_000 };

class GeminiTimeoutError extends Error {
  constructor(ms: number) {
    super(`GEMINI_TIMEOUT: no answer in ${Math.round(ms / 1000)} s`);
    this.name = 'GeminiTimeoutError';
  }
}

/** Reject after `ms` (and abort the request through `ctrl`) unless the promise settles first. */
function withTimeout<T>(promise: Promise<T>, ms: number, ctrl: AbortController): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new GeminiTimeoutError(ms);
      ctrl.abort(err);
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const modelCooldown = new Map<string, { until: number; kind: FailureKind }>();
/** Forget the paused models (tests). */
export const resetModelCooldowns = () => modelCooldown.clear();

function classifyError(err: any): { kind: FailureKind; retryMs: number } {
  const msg = String(err?.message || err);
  const retry = msg.match(/retry in ([\d.]+)s/i) || msg.match(/"retryDelay":\s*"(\d+)s"/);
  const retryMs = retry ? Math.ceil(parseFloat(retry[1]) * 1000) : 0;
  if (err instanceof GeminiTimeoutError || /GEMINI_TIMEOUT/.test(msg)) return { kind: 'timeout', retryMs: 3 * 60 * 1000 }; // a silent model usually stays silent for a while
  if (/PerDay/i.test(msg)) return { kind: 'daily', retryMs: 60 * 60 * 1000 };
  if (/"code":\s*429|RESOURCE_EXHAUSTED|quota/i.test(msg)) return { kind: 'rate', retryMs: retryMs || 60 * 1000 };
  if (/"code":\s*503|UNAVAILABLE|overloaded|high demand/i.test(msg)) return { kind: 'overloaded', retryMs: 30 * 1000 };
  if (/"code":\s*404|NOT_FOUND|not found/i.test(msg)) return { kind: 'notfound', retryMs: 6 * 60 * 60 * 1000 };
  return { kind: 'other', retryMs: 0 };
}

const REASONS: Record<UiLang, Record<FailureKind, string>> = {
  ru: {
    daily: 'исчерпан дневной лимит бесплатных запросов',
    rate: 'превышен лимит запросов в минуту',
    overloaded: 'модель сейчас перегружена',
    notfound: 'модель недоступна для этого ключа',
    timeout: 'модель не ответила вовремя',
    other: 'модель вернула ошибку',
  },
  en: {
    daily: 'the free daily request limit is used up',
    rate: 'the per-minute request limit was hit',
    overloaded: 'the model is overloaded right now',
    notfound: 'the model is not available for this key',
    timeout: 'the model did not answer in time',
    other: 'the model returned an error',
  },
};

function fallbackNotice(lang: UiLang, preferred: string, used: string, kind: FailureKind): string {
  return lang === 'ru'
    ? `> 💡 **${preferred}**: ${REASONS.ru[kind]}. Ответ сгенерирован моделью **${used}**.\n\n`
    : `> 💡 **${preferred}**: ${REASONS.en[kind]}. This answer was generated by **${used}**.\n\n`;
}

function allFailedMessage(lang: UiLang, kind: FailureKind): string {
  if (kind === 'timeout' || kind === 'overloaded') {
    return lang === 'ru'
      ? 'Gemini сейчас не отвечает: серверы Google перегружены. Повторите через пару минут или выберите другую модель в списке над чатом (например, локальную через Ollama).'
      : 'Gemini is not answering right now: Google\'s servers are overloaded. Try again in a couple of minutes or pick another model above the chat (e.g. a local one via Ollama).';
  }
  if (lang === 'ru') {
    return kind === 'daily' || kind === 'rate'
      ? 'Все модели Gemini временно недоступны: исчерпан лимит бесплатных запросов. Попробуйте позже или подключите платный план в Google AI Studio.'
      : 'Все модели Gemini сейчас недоступны. Попробуйте ещё раз через минуту.';
  }
  return kind === 'daily' || kind === 'rate'
    ? 'All Gemini models are temporarily unavailable: the free request limit is used up. Try later or enable billing in Google AI Studio.'
    : 'All Gemini models are unavailable right now. Please try again in a minute.';
}

/**
 * Run `call` with the preferred model, falling back through FALLBACK_CHAIN on quota/availability errors.
 * Models in cooldown are skipped (unless every model is in cooldown).
 */
async function runWithFallback(
  preferred: string,
  lang: UiLang,
  call: (model: string, signal: AbortSignal) => Promise<string>,
  timeoutMs = GEMINI_TIMEOUTS.chat
): Promise<string> {
  const r = await runWithFallbackRaw(preferred, lang, call, timeoutMs);
  return (r.notice || '') + r.text;
}

/** Like runWithFallback, but returns the fallback notice separately (for structured/JSON answers). */
async function runWithFallbackRaw(
  preferred: string,
  lang: UiLang,
  call: (model: string, signal: AbortSignal) => Promise<string>,
  timeoutMs = GEMINI_TIMEOUTS.chat
): Promise<{ text: string; model: string; notice: string | null }> {
  const started = Date.now();
  const chain = Array.from(new Set([preferred, ...FALLBACK_CHAIN]));
  const now = Date.now();
  const available = chain.filter((m) => (modelCooldown.get(m)?.until || 0) <= now);
  const toTry = available.length > 0 ? available : chain;

  // If the preferred model is cooling down, still explain why another one answered
  let firstFailure: FailureKind | null = toTry[0] === preferred ? null : modelCooldown.get(preferred)?.kind || 'rate';
  let lastError: any = null;
  let lastKind: FailureKind = 'other';

  for (const model of toTry) {
    // The whole chain has a limit too: never keep the user waiting for minutes
    const left = GEMINI_TIMEOUTS.total - (Date.now() - started);
    if (left <= 0) break;
    try {
      const ctrl = new AbortController();
      const text = await withTimeout(call(model, ctrl.signal), Math.min(timeoutMs, left), ctrl);
      if (!text) throw new Error('Model returned an empty response');
      modelCooldown.delete(model);
      return {
        text,
        model,
        notice: model === preferred ? null : fallbackNotice(lang, preferred, model, firstFailure || lastKind),
      };
    } catch (err: any) {
      const { kind, retryMs } = classifyError(err);
      if (err?.message?.startsWith('GEMINI_API_KEY')) throw err;
      console.warn(`Model ${model} failed (${kind}): ${String(err?.message || err).slice(0, 300)}`);
      if (retryMs > 0) modelCooldown.set(model, { until: Date.now() + retryMs, kind });
      if (model === preferred) firstFailure = kind;
      lastError = err;
      lastKind = kind;
    }
  }

  if (lastKind === 'other' && lastError) throw lastError;
  throw new Error(allFailedMessage(lang, lastKind));
}

export async function handleMultiTurnChat(options: ChatOptions & { lang?: UiLang }): Promise<string> {
  const preferredModel = options.model || 'gemini-3.5-flash';
  const systemInstruction =
    options.systemInstruction ||
    'You are an expert AI Software Engineer and Script Developer in ScriptCraft Studio. Provide precise, production-grade code, clear explanations, and working examples. Format code blocks with appropriate language tags.';

  if (!options.messages || options.messages.length === 0) {
    throw new Error('Messages list cannot be empty');
  }
  const messages = withCleanImages(options.messages);

  // A model chosen by the user (Ollama / own server): no silent switching to another provider
  if (isExternalModel(preferredModel)) {
    const l = withReplyLanguage(systemInstruction, toLlmMessages(messages), options.lang === 'en' ? 'en' : 'ru');
    return externalChat(preferredModel, l.system, l.messages, options.temperature ?? 0.7);
  }

  return runWithFallback(preferredModel, options.lang === 'en' ? 'en' : 'ru', async (model, signal) => {
    const chat = getAI().chats.create({
      model,
      config: {
        systemInstruction,
        temperature: options.temperature ?? 0.7,
      },
      history: messages.slice(0, -1).map((msg) => ({
        role: msg.role,
        parts: toGeminiParts(msg),
      })),
    });
    const response = await chat.sendMessage({ message: toGeminiParts(messages[messages.length - 1]), config: { abortSignal: signal } });
    return response.text || '';
  }, GEMINI_TIMEOUTS.chat);
}

export async function handleCodeAction(params: {
  action: 'explain' | 'refactor' | 'debug' | 'generate_tests' | 'convert_lang';
  code: string;
  language: string;
  targetLanguage?: string;
  customPrompt?: string;
  model?: string;
  responseLanguageInstruction?: string;
  lang?: UiLang;
}): Promise<string> {
  const preferredModel = params.model || 'gemini-3.5-flash';

  const actionPrompts: Record<string, string> = {
    explain: `Explain the following ${params.language} code clearly: its purpose, key mechanisms, complexity, and how it works step by step. Code:\n\`\`\`${params.language}\n${params.code}\n\`\`\``,
    refactor: `Refactor and optimize the following ${params.language} code. Make it cleaner, more idiomatic, faster, and adhere to best practices. Return the optimized code with bullet-point summary of improvements:\n\`\`\`${params.language}\n${params.code}\n\`\`\``,
    debug: `Analyze the following ${params.language} code for bugs, logic errors, edge cases, security issues, or performance pitfalls. Provide fixed code and explanations:\n\`\`\`${params.language}\n${params.code}\n\`\`\``,
    generate_tests: `Write comprehensive unit tests for the following ${params.language} code using standard testing practices or assertions. Provide test cases covering edge cases:\n\`\`\`${params.language}\n${params.code}\n\`\`\``,
    convert_lang: `Translate the following ${params.language} code into ${params.targetLanguage || 'JavaScript'}. Ensure idiomatic syntax and equivalent functionality:\n\`\`\`${params.language}\n${params.code}\n\`\`\``,
  };

  const prompt = params.customPrompt
    ? `${params.customPrompt}\n\nLanguage: ${params.language}\nCode:\n\`\`\`${params.language}\n${params.code}\n\`\`\``
    : actionPrompts[params.action] || actionPrompts.explain;

  const codeSystem =
    'You are a senior software engineer assistant. Always provide well-documented, clean code blocks with language tags and direct, useful answers without filler.' +
    (params.responseLanguageInstruction || '');
  if (isExternalModel(preferredModel)) {
    const l = withReplyLanguage(codeSystem, [{ role: 'user', text: prompt }], params.lang === 'en' ? 'en' : 'ru');
    return externalChat(preferredModel, l.system, l.messages, 0.4);
  }

  return runWithFallback(preferredModel, params.lang === 'en' ? 'en' : 'ru', async (model, signal) => {
    const response = await getAI().models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction:
          'You are a senior software engineer assistant. Always provide well-documented, clean code blocks with language tags and direct, useful answers without filler.' +
          (params.responseLanguageInstruction || ''),
        abortSignal: signal,
      },
    });
    return response.text || '';
  }, GEMINI_TIMEOUTS.code);
}

// ---------------------------------------------------------------------------
// Agent mode: the model plans file changes and runs, the studio executes them and reports back
// ---------------------------------------------------------------------------

export interface AgentStep {
  message: string;
  files: { path: string; content: string }[];
  run: string | null;
  done: boolean;
  /** Number (1-based) of the approved plan step this answer works on */
  planStep: number | null;
}

const AGENT_SYSTEM = `You are an autonomous coding agent working inside ScriptCraft Studio, a local code studio on the user's Windows PC.
You work in steps. In every step you answer ONLY with JSON matching the schema:
- "message": a short note for the user about what you are doing in this step (markdown allowed).
- "files": files to create or overwrite in the project, each with the path and the COMPLETE new content (never a fragment, never "..." placeholders). Use [] if nothing changes.
- "run": path of ONE project file to execute now to verify your work, or null.
- "done": true only when the task is finished and verified.

How running works:
- Python (python 3), JavaScript (Node.js), TypeScript (tsx), Bash (Git Bash) and SQL (SQLite, fresh in-memory database) files can be run.
- The whole project is copied to a temp folder and the file is run from its folder, so files can import each other.
- Programs run NON-interactively: there is no stdin (input() would fail) and there is a 20 second time limit. Make programs demonstrate themselves with sample data.
- Only the standard library / built-in Node modules and the packages listed as installed in the task are available. Do not use other pip/npm packages; if one is really needed, tell the user to install it via the Packages button.
- After a run you receive the exit code, stdout and stderr. If it failed, fix the code and run again.
Keep the number of steps small. Do not rewrite files that do not need changes.
If the task comes with an approved plan, follow it in order and set "planStep" to the number of the plan step this answer works on (otherwise null).`;

const AGENT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    message: { type: 'STRING' },
    files: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { path: { type: 'STRING' }, content: { type: 'STRING' } },
        required: ['path', 'content'],
      },
    },
    run: { type: 'STRING', nullable: true },
    done: { type: 'BOOLEAN' },
    planStep: { type: 'INTEGER', nullable: true },
  },
  required: ['message', 'files', 'done'],
};

export async function handleAgentStep(params: {
  messages: ChatMessage[];
  model?: string;
  lang?: UiLang;
  languageInstruction?: string;
}): Promise<{ step: AgentStep; notice: string | null; model: string }> {
  const { messages } = params;
  if (!messages || messages.length === 0) throw new Error('Messages list cannot be empty');
  const lang: UiLang = params.lang === 'en' ? 'en' : 'ru';
  const preferred = params.model || 'gemini-3.5-flash';
  const agentSystem =
    AGENT_SYSTEM +
    (lang === 'ru' ? '\nWrite the "message" field in Russian (code and code comments stay in English).' : '') +
    (params.languageInstruction || '');

  let r: { text: string; model: string; notice: string | null };
  if (isExternalModel(preferred)) {
    const l = withReplyLanguage(
      agentSystem +
        '\nAnswer ONLY with one JSON object of the form {"message": string, "files": [{"path": string, "content": string}], "run": string or null, "done": boolean, "planStep": number or null}.',
      toLlmMessages(messages),
      lang,
      true
    );
    const json = await externalJson(preferred, l.system, l.messages, { schema: toJsonSchema(AGENT_SCHEMA), maxTokens: 12000 });
    r = { text: JSON.stringify(json), model: preferred, notice: null };
  } else r = await runWithFallbackRaw(preferred, lang, async (model, signal) => {
    const response = await getAI().models.generateContent({
      model,
      contents: messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
      config: {
        systemInstruction: agentSystem,
        responseMimeType: 'application/json',
        responseSchema: AGENT_SCHEMA as any,
        temperature: 0.4,
        abortSignal: signal,
      },
    });
    const text = response.text || '';
    JSON.parse(text); // invalid JSON counts as a failure, so the next model is tried
    return text;
  }, GEMINI_TIMEOUTS.agent);

  const raw = JSON.parse(r.text);
  const step: AgentStep = {
    message: String(raw.message || ''),
    files: Array.isArray(raw.files)
      ? raw.files
          .filter((f: any) => f && typeof f.path === 'string' && typeof f.content === 'string')
          .map((f: any) => ({ path: f.path.replace(/\\/g, '/').replace(/^\/+/, ''), content: f.content }))
      : [],
    run: typeof raw.run === 'string' && raw.run.trim() ? raw.run.trim().replace(/\\/g, '/').replace(/^\/+/, '') : null,
    done: !!raw.done,
    planStep: Number.isInteger(raw.planStep) && raw.planStep > 0 ? raw.planStep : null,
  };
  return { step, notice: r.notice, model: r.model };
}

// ---------------------------------------------------------------------------
// Agent plan: before changing anything the agent proposes a short plan the user approves
// ---------------------------------------------------------------------------

export interface AgentPlan {
  summary: string;
  steps: { title: string; files: string[] }[];
  questions: string[];
}

const PLAN_SYSTEM = `You are an autonomous coding agent in ScriptCraft Studio, a local code studio. Before doing a task you write a short plan for the user to approve.
Do NOT write code now. Answer ONLY with JSON:
- "summary": one or two sentences: what will be built or changed and how it will be checked.
- "steps": 2 to 7 ordered steps; each has "title" (one short sentence a beginner understands) and "files" (project files it creates or changes, [] if none). The last step checks the result by running a file when that is possible.
- "questions": important things that are unclear and change the plan a lot (at most 3); [] when everything is clear.
Programs run non-interactively with a 20 second limit; only the standard library and the packages listed as installed are available.`;

const PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    steps: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { title: { type: 'STRING' }, files: { type: 'ARRAY', items: { type: 'STRING' } } },
        required: ['title', 'files'],
      },
    },
    questions: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['summary', 'steps', 'questions'],
};

export function normalizePlan(raw: any): AgentPlan {
  const steps = (Array.isArray(raw?.steps) ? raw.steps : [])
    .filter((s: any) => s && typeof s.title === 'string' && s.title.trim())
    .slice(0, 10)
    .map((s: any) => ({
      title: s.title.trim().slice(0, 300),
      files: (Array.isArray(s.files) ? s.files : [])
        .filter((f: any) => typeof f === 'string' && f.trim())
        .map((f: string) => f.trim().replace(/\\/g, '/').replace(/^\/+/, ''))
        .slice(0, 20),
    }));
  if (steps.length === 0) throw new Error('The model returned an empty plan');
  return {
    summary: String(raw?.summary || '').trim().slice(0, 1000),
    steps,
    questions: (Array.isArray(raw?.questions) ? raw.questions : []).filter((q: any) => typeof q === 'string' && q.trim()).slice(0, 3),
  };
}

export async function handleAgentPlan(params: { messages: ChatMessage[]; model?: string; lang?: UiLang }): Promise<{ plan: AgentPlan; notice: string | null; model: string }> {
  const { messages } = params;
  if (!messages || messages.length === 0) throw new Error('Messages list cannot be empty');
  const lang: UiLang = params.lang === 'en' ? 'en' : 'ru';
  const preferred = params.model || 'gemini-3.5-flash';
  const system = PLAN_SYSTEM + (lang === 'ru' ? '\nWrite "summary", step titles and questions in Russian (file names stay as they are).' : '');

  let r: { text: string; model: string; notice: string | null };
  if (isExternalModel(preferred)) {
    const l = withReplyLanguage(
      system + '\nAnswer ONLY with one JSON object of the form {"summary": string, "steps": [{"title": string, "files": [string]}], "questions": [string]}.',
      toLlmMessages(messages),
      lang,
      true
    );
    r = { text: JSON.stringify(await externalJson(preferred, l.system, l.messages, { schema: toJsonSchema(PLAN_SCHEMA), maxTokens: 2000 })), model: preferred, notice: null };
  } else
    r = await runWithFallbackRaw(preferred, lang, async (model, signal) => {
      const response = await getAI().models.generateContent({
        model,
        contents: messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
        config: { systemInstruction: system, responseMimeType: 'application/json', responseSchema: PLAN_SCHEMA as any, temperature: 0.3, abortSignal: signal },
      });
      const text = response.text || '';
      JSON.parse(text);
      return text;
    }, GEMINI_TIMEOUTS.plan);
  return { plan: normalizePlan(JSON.parse(r.text)), notice: r.notice, model: r.model };
}

// ---------------------------------------------------------------------------
// Streaming chat: text is pushed to the client as it is generated
// ---------------------------------------------------------------------------

/**
 * Stream a chat answer. Falls back to the next model only if a model fails before producing any text
 * (once text has been shown, switching models mid-answer would be confusing).
 */
export async function streamMultiTurnChat(
  options: ChatOptions & { lang?: UiLang },
  onChunk: (text: string) => void,
  isAborted: () => boolean
): Promise<{ model: string }> {
  const preferred = options.model || 'gemini-3.5-flash';
  const lang: UiLang = options.lang === 'en' ? 'en' : 'ru';
  if (!options.messages || options.messages.length === 0) throw new Error('Messages list cannot be empty');
  const messages = withCleanImages(options.messages);
  const systemInstruction =
    options.systemInstruction ||
    'You are an expert AI Software Engineer and Script Developer in ScriptCraft Studio. Provide precise, production-grade code, clear explanations, and working examples. Format code blocks with appropriate language tags.';

  if (isExternalModel(preferred)) {
    const l = withReplyLanguage(systemInstruction, toLlmMessages(messages), options.lang === 'en' ? 'en' : 'ru');
    await externalChatStream(preferred, l.system, l.messages, onChunk, isAborted, options.temperature ?? 0.7);
    return { model: preferred };
  }

  const chain = Array.from(new Set([preferred, ...FALLBACK_CHAIN]));
  const now = Date.now();
  const available = chain.filter((m) => (modelCooldown.get(m)?.until || 0) <= now);
  const toTry = available.length > 0 ? available : chain;
  let firstFailure: FailureKind | null = toTry[0] === preferred ? null : modelCooldown.get(preferred)?.kind || 'rate';
  let lastError: any = null;
  let lastKind: FailureKind = 'other';

  const started = Date.now();
  for (const model of toTry) {
    let produced = false;
    if (GEMINI_TIMEOUTS.total - (Date.now() - started) <= 0) break;
    try {
      const ctrl = new AbortController();
      const chat = getAI().chats.create({
        model,
        config: { systemInstruction, temperature: options.temperature ?? 0.7 },
        history: messages.slice(0, -1).map((msg) => ({ role: msg.role, parts: toGeminiParts(msg) })),
      });
      const stream = await withTimeout(
        chat.sendMessageStream({ message: toGeminiParts(messages[messages.length - 1]), config: { abortSignal: ctrl.signal } }),
        GEMINI_TIMEOUTS.streamFirst,
        ctrl
      );
      const iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        // The first piece must come quickly; after that the answer may not stall for long
        const next = await withTimeout(iterator.next(), produced ? GEMINI_TIMEOUTS.streamIdle : GEMINI_TIMEOUTS.streamFirst, ctrl);
        if (next.done) break;
        const chunk = next.value;
        if (isAborted()) {
          ctrl.abort();
          break;
        }
        const text = chunk.text;
        if (!text) continue;
        if (!produced) {
          produced = true;
          if (model !== preferred) onChunk(fallbackNotice(lang, preferred, model, firstFailure || lastKind));
        }
        onChunk(text);
      }
      if (!produced && !isAborted()) throw new Error('Model returned an empty response');
      modelCooldown.delete(model);
      return { model };
    } catch (err: any) {
      if (produced || err?.message?.startsWith('GEMINI_API_KEY')) throw err;
      const { kind, retryMs } = classifyError(err);
      console.warn(`Model ${model} failed (${kind}): ${String(err?.message || err).slice(0, 300)}`);
      if (retryMs > 0) modelCooldown.set(model, { until: Date.now() + retryMs, kind });
      if (model === preferred) firstFailure = kind;
      lastError = err;
      lastKind = kind;
    }
  }

  if (lastKind === 'other' && lastError) throw lastError;
  throw new Error(allFailedMessage(lang, lastKind));
}
