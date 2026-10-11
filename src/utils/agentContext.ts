import { detectLanguageFromName } from './presets.ts';

export interface AgentFile {
  name: string;
  content: string;
}

export type AgentConvoMessage = { role: 'user' | 'model'; text: string };

const MAX_CONTEXT_CHARS = 150_000;
const MAX_FILE_CHARS = 40_000;
/** How many recent agent step JSON replies keep full file bodies in the conversation. */
export const KEEP_RECENT_STEP_BODIES = 1;
/** Inject a fresh project snapshot into the convo every N completed steps. */
export const PROJECT_RESYNC_EVERY = 3;
/** Soft cap on conversation size before older run/external dumps are clipped harder. */
export const CONVO_SOFT_CHARS = 80_000;

/** Project tree + file contents for the AI, trimmed to a sane size. */
export function buildProjectContext(files: AgentFile[]): string {
  if (files.length === 0) return 'The project is empty (no files yet).';
  const tree = files.map((f) => `- ${f.name} (${f.content.split('\n').length} lines)`).join('\n');
  let out = `Project files:\n${tree}\n`;
  for (const f of files) {
    const lang = detectLanguageFromName(f.name);
    const body =
      f.content.length > MAX_FILE_CHARS ? f.content.slice(0, MAX_FILE_CHARS) + '\n... [file truncated]' : f.content;
    const block = `\n=== ${f.name} ===\n\`\`\`${lang}\n${body}\n\`\`\`\n`;
    if (out.length + block.length > MAX_CONTEXT_CHARS) {
      out += `\n[Other files omitted: the project is too large to include completely]\n`;
      break;
    }
    out += block;
  }
  return out;
}

/** Drop file bodies from an older agent-step JSON so the context stays small. */
export function summarizeAgentStepJson(text: string): string {
  try {
    const step = JSON.parse(text);
    if (!step || typeof step !== 'object' || !Array.isArray(step.files)) return text;
    return JSON.stringify({
      ...step,
      files: step.files.map((f: { path?: string; content?: string }) => ({
        path: f?.path,
        content:
          typeof f?.content === 'string'
            ? `[${f.content.length} chars; see current project snapshot]`
            : f?.content,
      })),
    });
  } catch {
    return text.length > 2000 ? text.slice(0, 2000) + '\n… [truncated]' : text;
  }
}

/** Preferred entry scripts to verify a task (first match wins). */
const ENTRY_CANDIDATES = [
  'main.py',
  'app.py',
  'run.py',
  'main.js',
  'index.js',
  'app.js',
  'main.ts',
  'index.ts',
  'main.ps1',
  'main.sh',
];

/** Pick a project file the agent should run to verify work. */
export function pickEntryToRun(files: AgentFile[]): string | null {
  const names = files.map((f) => f.name.replace(/\\/g, '/'));
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  for (const c of ENTRY_CANDIDATES) {
    const hit = lower.get(c);
    if (hit) return hit;
  }
  // Single runnable file in the project root
  const runnable = names.filter((n) => !n.includes('/') && /\.(py|js|ts|ps1|sh)$/i.test(n));
  return runnable.length === 1 ? runnable[0] : null;
}

/** User-turn nudge when the model stalls (no run / empty steps). */
export function stallContinueMessage(opts: {
  files: AgentFile[];
  idleSteps: number;
  wroteFilesThisStep: boolean;
  hadSuccessfulRun: boolean;
}): string {
  const entry = pickEntryToRun(opts.files);
  if (entry && !opts.hadSuccessfulRun && (opts.idleSteps >= 1 || (!opts.wroteFilesThisStep && opts.files.length > 0))) {
    return (
      `Do not keep saying you will continue. Set run="${entry}" now to verify the program ` +
      `(non-interactive, 20s). After a successful run, answer with done=true and run=null. ` +
      `If something is still missing, write at most one file, then run.`
    );
  }
  if (opts.hadSuccessfulRun && opts.idleSteps >= 1) {
    return (
      'The program already ran successfully. Set done=true and run=null now. ' +
      'Do not rewrite working files unless the user asked for a change.'
    );
  }
  if (opts.idleSteps >= 2) {
    return (
      'You made no progress (no file changes and no run). ' +
      'Either write the next needed file in "files", or set "run" to an entry script, or set done=true if the task is already complete.'
    );
  }
  return 'Continue with the next step. Prefer setting "run" once an entry file exists.';
}

/** Stable short fingerprint of a failed run (for detecting repeated identical failures). */
export function runFailureSignature(output: string): string {
  const lines = (output || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line =
    lines.find((l) => /\w*(Error|Exception)\b|FAILED/i.test(l)) ||
    lines.find((l) => /Traceback/i.test(l)) ||
    (output || '').trim().slice(0, 120);
  return line.replace(/\s+/g, ' ').slice(0, 160);
}

/** Nudge when the same entry fails the same way twice+ (local models often tweak one line forever). */
export function repeatedRunFailureMessage(path: string, count: number, signature: string): string {
  return (
    `You failed running "${path}" ${count} times with the same error` +
    (signature ? ` (${signature})` : '') +
    `. Stop tiny edits. Rewrite the WHOLE file in "files" (correct syntax, complete program), then set run="${path}" once. ` +
    `Do not set done=true until exit code 0.`
  );
}

/** Extra notes for common run failures (helps small local models). */
export function formatRunFailureHint(output: string): string {
  const o = output || '';
  const tips: string[] = [];
  if (/IndentationError/i.test(o)) {
    tips.push('IndentationError: rewrite the whole file; top-level statements must start at column 0 (no leading spaces).');
  }
  if (/SyntaxError:\s*unterminated string/i.test(o) || /EOL while scanning string/i.test(o)) {
    tips.push('Unterminated string: keep each string literal on ONE line; do not break print("...") across lines.');
  }
  if (/SyntaxError/i.test(o) && /f['"]/.test(o)) {
    tips.push('f-string quotes: use f"... {obj[\'key\']} ..." (double quotes outside, single inside).');
  }
  if (/ModuleNotFoundError|No module named/i.test(o)) {
    tips.push('Missing package: set install.python or install.node with the package name, then run again — or use only the standard library.');
  }
  if (/NameError:\s*name ['"]/i.test(o)) {
    tips.push('NameError: define the name before use, or fix a typo; rewrite the whole file if the structure is broken.');
  }
  if (/FileNotFoundError|ENOENT/i.test(o)) {
    tips.push('File not found: create the missing project file in "files", or fix the path to a file that exists in the project.');
  }
  if (!tips.length) return '';
  return '\n\nFix tips:\n- ' + tips.join('\n- ');
}

/**
 * Shrink agent conversation history for local models: keep recent step file bodies,
 * summarize older ones, and clip huge user dumps (run output / external reads).
 */
export function compactAgentConvo(
  convo: AgentConvoMessage[],
  opts?: { keepRecentSteps?: number; softChars?: number }
): AgentConvoMessage[] {
  const keepRecent = opts?.keepRecentSteps ?? KEEP_RECENT_STEP_BODIES;
  const softChars = opts?.softChars ?? CONVO_SOFT_CHARS;
  const modelStepIdx: number[] = [];
  for (let i = 0; i < convo.length; i++) {
    if (convo[i].role === 'model' && convo[i].text.trimStart().startsWith('{')) modelStepIdx.push(i);
  }
  const keep = new Set(modelStepIdx.slice(-keepRecent));
  let out: AgentConvoMessage[] = convo.map((m, i) => {
    if (m.role === 'model' && modelStepIdx.includes(i) && !keep.has(i)) {
      return { ...m, text: summarizeAgentStepJson(m.text) };
    }
    return m;
  });
  const total = () => out.reduce((n, m) => n + m.text.length, 0);
  if (total() > softChars) {
    out = out.map((m, i) => {
      if (i === 0 || m.role !== 'user') return m;
      if (m.text.length <= 8_000) return m;
      const head = m.text.slice(0, 5_000);
      const tail = m.text.slice(-1_500);
      return { ...m, text: `${head}\n… [${m.text.length - 6_500} chars omitted] …\n${tail}` };
    });
  }
  return out;
}
