import { FileItem, LogEntry } from '../types.ts';
import { detectLanguageFromName } from './presets.ts';
import { executeSQL } from './execution.ts';
import { getLang, t } from '../i18n.ts';

export interface AgentFile {
  name: string;
  content: string;
}

const MAX_CONTEXT_CHARS = 150_000;
const MAX_FILE_CHARS = 40_000;

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

export interface RunReport {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n... [${s.length - n} more characters]` : s);

/** Run one project file non-interactively (20 s limit) for the agent. */
export async function runProjectFile(
  path: string,
  files: AgentFile[],
  signal?: AbortSignal,
  projectId?: string | null
): Promise<RunReport> {
  const file = files.find((f) => f.name === path);
  if (!file) return { ok: false, exitCode: null, output: `File "${path}" does not exist in the project.` };
  const lang = detectLanguageFromName(file.name);
  const ext = file.name.split('.').pop()?.toLowerCase();

  if (ext === 'sql') {
    const logs: string[] = [];
    const res = await executeSQL(file.content, (e: LogEntry) => logs.push(e.message));
    const tables = res.tables
      .map((tbl, i) => {
        const rows = tbl.rows.slice(0, 20).map((r) => r.map((c) => (c === null ? 'NULL' : String(c))).join(' | '));
        return `Result ${i + 1}: ${tbl.columns.join(' | ')}\n${rows.join('\n')}${tbl.rows.length > 20 ? '\n...' : ''}`;
      })
      .join('\n\n');
    return { ok: res.success, exitCode: res.success ? 0 : 1, output: clip(`${logs.join('\n')}\n\n${tables}`.trim(), 6000) };
  }

  if (!['py', 'js', 'mjs', 'ts', 'sh', 'bash'].includes(ext || '')) {
    return { ok: false, exitCode: null, output: `"${path}" (${lang}) cannot be executed; only .py, .js, .ts, .sh and .sql files can be run.` };
  }

  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language: lang, code: file.content, files, entry: file.name, timeoutMs: 20000, projectId: projectId || undefined }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, exitCode: null, output: data.error || `Server returned ${res.status}` };
  const output = [data.stdout ? `stdout:\n${data.stdout}` : 'stdout: (empty)', data.stderr ? `stderr:\n${data.stderr}` : '']
    .filter(Boolean)
    .join('\n');
  return { ok: !!data.success, exitCode: data.exitCode ?? null, output: clip(output.replace(/\r\n/g, '\n'), 6000) };
}

interface AgentStepResponse {
  step: { message: string; files: { path: string; content: string }[]; run: string | null; done: boolean; planStep?: number | null };
  notice: string | null;
  model: string;
}

/** Packages the user installed into the project (the agent may use them). */
async function describePackages(projectId?: string | null): Promise<string> {
  if (!projectId) return 'Installed packages: none (standard library only).';
  try {
    const d = await (await fetch(`/api/projects/${encodeURIComponent(projectId)}/packages`)).json();
    const fmt = (l: { name: string; version: string }[]) => (l?.length ? l.map((p) => `${p.name} ${p.version}`).join(', ') : 'none');
    return `Installed packages — Python: ${fmt(d.python)}; Node.js: ${fmt(d.node)}.`;
  } catch {
    return 'Installed packages: unknown.';
  }
}

/** What the agent wants to do and needs the user's approval for. */
export type AgentApprovalRequest =
  | { kind: 'files'; changes: { path: string; oldContent: string | null; newContent: string }[] }
  | { kind: 'run'; path: string };

/** 'yes' = this action, 'all' = this and every following action of the current task, 'no' = stop. */
export type AgentApproval = 'yes' | 'all' | 'no';

/** Added / removed line counts between two versions (exact LCS for normal files, approximate for huge ones). */
export function lineDiffStats(oldText: string | null, newText: string): { added: number; removed: number } {
  const a = oldText === null ? [] : oldText.split('\n');
  const b = newText.split('\n');
  if (oldText === null) return { added: b.length, removed: 0 };
  if (a.length * b.length > 4_000_000) {
    const count = (arr: string[]) => arr.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map<string, number>());
    const ca = count(a);
    const cb = count(b);
    let common = 0;
    for (const [line, n] of ca) common += Math.min(n, cb.get(line) || 0);
    return { added: b.length - common, removed: a.length - common };
  }
  // LCS length with two rolling rows
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const lcs = prev[b.length];
  return { added: b.length - lcs, removed: a.length - lcs };
}

/** A plan the agent proposes before changing anything (the user approves, revises or cancels it). */
export interface AgentPlan {
  summary: string;
  steps: { title: string; files: string[] }[];
  questions: string[];
}

/** Ask the model for a plan; `revise` = the previous plan and what the user wants changed. */
export async function planAgent(opts: {
  task: string;
  files: AgentFile[];
  model: string;
  projectId?: string | null;
  signal: AbortSignal;
  revise?: { plan: AgentPlan; feedback: string };
}): Promise<{ plan: AgentPlan; model: string; notice: string | null }> {
  const messages: { role: 'user' | 'model'; text: string }[] = [
    { role: 'user', text: `Task from the user:\n${opts.task}\n\n${buildProjectContext(opts.files)}\n\n${await describePackages(opts.projectId)}` },
  ];
  if (opts.revise) {
    messages.push({ role: 'model', text: JSON.stringify(opts.revise.plan) });
    messages.push({ role: 'user', text: `Revise the plan. The user says: ${opts.revise.feedback}` });
  }
  const res = await fetch('/api/agent/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, model: opts.model, lang: getLang() }),
    signal: opts.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data;
}

/** The plan as a markdown checklist: steps before `current` are done, `current` is in progress. */
export function formatPlan(plan: AgentPlan, current: number | null, finished = false): string {
  const lines = plan.steps.map((s, i) => {
    const n = i + 1;
    const done = finished || (current !== null && n < current);
    const active = !finished && current === n;
    const files = s.files.length ? ` — ${s.files.map((f) => `\`${f}\``).join(', ')}` : '';
    return `- [${done ? 'x' : ' '}] ${active ? `**${n}. ${s.title}** ⏳` : `${n}. ${s.title}`}${files}`;
  });
  return `📋 **${t('plan.title')}:** ${plan.summary}\n\n${lines.join('\n')}`;
}

export type AgentEvent =
  | { kind: 'step'; text: string; changed: string[]; model: string; planStep: number | null }
  | { kind: 'run'; path: string; report: RunReport }
  | { kind: 'finished'; reason: 'done' | 'stopped' | 'rejected' | 'max-steps' | 'error'; steps: number; error?: string };

export const AGENT_MAX_STEPS = 8;

/**
 * Agent loop: ask the model for the next step, apply its file changes, run what it asks to run,
 * feed the results back, repeat until it reports done (or the step limit / Stop).
 */
export async function runAgent(opts: {
  task: string;
  files: AgentFile[];
  model: string;
  projectId?: string | null;
  signal: AbortSignal;
  applyFiles: (changes: AgentFile[]) => void;
  onEvent: (e: AgentEvent) => void;
  /** Ask the user before changing files / running code. Omitted = everything is allowed. */
  confirm?: (req: AgentApprovalRequest) => Promise<AgentApproval>;
  /** A plan the user approved: the agent follows it and reports which step it works on */
  plan?: AgentPlan;
}): Promise<void> {
  let approveAll = !opts.confirm;
  const ask = async (req: AgentApprovalRequest): Promise<boolean> => {
    if (approveAll) return true;
    const answer = await opts.confirm!(req);
    if (answer === 'all') approveAll = true;
    return answer !== 'no';
  };
  const files = opts.files.map((f) => ({ ...f }));
  const convo: { role: 'user' | 'model'; text: string }[] = [
    {
      role: 'user',
      text:
        `Task from the user:\n${opts.task}\n\n` +
        (opts.plan
          ? `Approved plan (follow it in order; set "planStep" in every answer):\n${opts.plan.summary}\n` +
            opts.plan.steps.map((s, i) => `${i + 1}. ${s.title}${s.files.length ? ` (files: ${s.files.join(', ')})` : ''}`).join('\n') +
            '\n\n'
          : '') +
        `${buildProjectContext(files)}\n\n${await describePackages(opts.projectId)}`,
    },
  ];
  let steps = 0;

  try {
    while (steps < AGENT_MAX_STEPS) {
      if (opts.signal.aborted) return opts.onEvent({ kind: 'finished', reason: 'stopped', steps });
      steps++;

      const res = await fetch('/api/agent/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: convo, model: opts.model, lang: getLang() }),
        signal: opts.signal,
      });
      const data: AgentStepResponse & { error?: string } = await res.json().catch(() => ({}) as any);
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
      const { step } = data;

      opts.onEvent({
        kind: 'step',
        text: (data.notice || '') + step.message,
        changed: step.files.map((f) => f.path),
        model: data.model,
        planStep: step.planStep ?? null,
      });

      // File changes: shown to the user first (unless everything is allowed), then applied
      if (step.files.length > 0) {
        const changes = step.files.map((ch) => ({
          path: ch.path,
          oldContent: files.find((f) => f.name === ch.path)?.content ?? null,
          newContent: ch.content,
        }));
        if (!(await ask({ kind: 'files', changes }))) return opts.onEvent({ kind: 'finished', reason: 'rejected', steps });
        for (const ch of step.files) {
          const existing = files.find((f) => f.name === ch.path);
          if (existing) existing.content = ch.content;
          else files.push({ name: ch.path, content: ch.content });
        }
        opts.applyFiles(step.files.map((f) => ({ name: f.path, content: f.content })));
      }
      convo.push({ role: 'model', text: JSON.stringify(step) });

      if (!step.run) {
        if (step.done) return opts.onEvent({ kind: 'finished', reason: 'done', steps });
        convo.push({ role: 'user', text: 'Continue with the next step.' });
        continue;
      }

      if (opts.signal.aborted) return opts.onEvent({ kind: 'finished', reason: 'stopped', steps });
      if (!(await ask({ kind: 'run', path: step.run }))) return opts.onEvent({ kind: 'finished', reason: 'rejected', steps });
      if (opts.signal.aborted) return opts.onEvent({ kind: 'finished', reason: 'stopped', steps });
      const report = await runProjectFile(step.run, files, opts.signal, opts.projectId);
      opts.onEvent({ kind: 'run', path: step.run, report });

      // Finished and verified by a successful run: no need to spend another request
      if (step.done && report.ok) return opts.onEvent({ kind: 'finished', reason: 'done', steps });
      convo.push({
        role: 'user',
        text:
          `Result of running ${step.run}: exit code ${report.exitCode ?? 'n/a'}${report.ok ? ' (success)' : ' (FAILED)'}\n${report.output}\n\n` +
          (report.ok
            ? 'If the output shows the task is complete, answer with done=true and run=null. Otherwise continue.'
            : 'Fix the problem and run again.'),
      });
    }
    opts.onEvent({ kind: 'finished', reason: 'max-steps', steps });
  } catch (err: any) {
    if (opts.signal.aborted || err?.name === 'AbortError') return opts.onEvent({ kind: 'finished', reason: 'stopped', steps });
    opts.onEvent({ kind: 'finished', reason: 'error', steps, error: err?.message || String(err) });
  }
}

/** Markdown for a run report shown in the chat. */
export function formatRunReport(path: string, report: RunReport): string {
  const status = report.ok ? t('agent.runOk', { code: report.exitCode ?? 0 }) : t('agent.runFail', { code: report.exitCode ?? '?' });
  return `▶ **${t('agent.run')} \`${path}\`** — ${status}\n\n\`\`\`text\n${clip(report.output, 2500)}\n\`\`\``;
}

export function filesFromItems(items: FileItem[]): AgentFile[] {
  return items.map((f) => ({ name: f.name, content: f.content }));
}
