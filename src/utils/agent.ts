import { FileItem, LogEntry } from '../types.ts';
import { detectLanguageFromName } from './presets.ts';
import { executeSQL } from './execution.ts';
import { getLang, t } from '../i18n.ts';
import { findRisks, type Risk } from './codeSafety.ts';

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
  step: {
    message: string;
    files: { path: string; content: string }[];
    run: string | null;
    done: boolean;
    planStep?: number | null;
    install?: { python: string[]; node: string[] } | null;
    delete?: string[];
    rename?: { from: string; to: string }[];
    readExternal?: string[];
    writeExternal?: { path: string; content: string }[];
  };
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

/** Install one manager's packages into the project and stream the output to completion. */
async function installOne(
  projectId: string,
  manager: 'pip' | 'npm',
  packages: string[],
  signal: AbortSignal
): Promise<{ ok: boolean; output: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/packages/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manager, packages }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.runId) return { ok: false, output: data.error || `Install failed (HTTP ${res.status})` };
  const ev = await fetch(`/api/run/${data.runId}/events`, { signal });
  const reader = ev.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return { ok: false, output: out };
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(i + 2);
      if (!line) continue;
      const m = JSON.parse(line.slice(6));
      if (m.type === 'exit') {
        reader.cancel().catch(() => {});
        return { ok: m.code === 0, output: out };
      }
      if (typeof m.data === 'string') out += m.data;
    }
  }
}

/** Install the packages of an agent step (pip and/or npm); combined result. */
async function installPackages(
  projectId: string,
  req: { python: string[]; node: string[] },
  signal: AbortSignal
): Promise<{ ok: boolean; output: string }> {
  let ok = true;
  let output = '';
  if (req.python.length) {
    const r = await installOne(projectId, 'pip', req.python, signal);
    ok = ok && r.ok;
    output += `pip install ${req.python.join(' ')}\n${r.output}\n`;
  }
  if (req.node.length) {
    const r = await installOne(projectId, 'npm', req.node, signal);
    ok = ok && r.ok;
    output += `npm install ${req.node.join(' ')}\n${r.output}\n`;
  }
  return { ok, output: output.trim() };
}

/** What the agent wants to do and needs the user's approval for. */
export type AgentApprovalRequest =
  | {
      kind: 'files';
      changes: { path: string; oldContent: string | null; newContent: string }[];
      deletes?: string[];
      renames?: { from: string; to: string }[];
    }
  | { kind: 'run'; path: string; risks?: Risk[] }
  | { kind: 'install'; python: string[]; node: string[] }
  /** Outside the project: always asked, even after "allow all" or with approvals turned off */
  | { kind: 'external-read'; paths: string[] }
  | { kind: 'external-write'; changes: { path: string; oldContent: string | null; newContent: string }[] };

/** Result of reading a path outside the project (see api/agentfs.ts). */
export type ExternalRead =
  | { path: string; kind: 'file'; content: string; truncated: boolean; size: number }
  | { path: string; kind: 'binary'; size: number }
  | { path: string; kind: 'dir'; entries: { name: string; dir: boolean; size: number }[]; truncated: boolean }
  | { path: string; kind: 'missing' }
  | { path: string; kind: 'error'; error: string };

export type ExternalWrite = { path: string; ok: true; created: boolean; backup: string | null } | { path: string; ok: false; error: string };

async function postJson<T>(url: string, body: unknown, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data;
}

const readExternal = (paths: string[], signal: AbortSignal) =>
  postJson<{ results: ExternalRead[] }>('/api/agent/fs/read', { paths }, signal).then((d) => d.results);
const writeExternal = (files: { path: string; content: string }[], signal: AbortSignal) =>
  postJson<{ results: ExternalWrite[] }>('/api/agent/fs/write', { files }, signal).then((d) => d.results);

/** What the agent read outside the project, as text for the model. */
function describeExternalReads(results: ExternalRead[]): string {
  return results
    .map((r) => {
      if (r.kind === 'file') return `=== ${r.path} (${r.size} bytes${r.truncated ? ', truncated' : ''}) ===\n${r.content}`;
      if (r.kind === 'dir') {
        const list = r.entries.map((e) => (e.dir ? `${e.name}/` : `${e.name} (${e.size} bytes)`)).join('\n') || '(empty)';
        return `=== ${r.path} (folder) ===\n${list}${r.truncated ? '\n... more entries' : ''}`;
      }
      if (r.kind === 'binary') return `=== ${r.path} === binary file, ${r.size} bytes (not shown)`;
      if (r.kind === 'missing') return `=== ${r.path} === does not exist`;
      return `=== ${r.path} === cannot be read: ${r.error}`;
    })
    .join('\n\n');
}

/** Renames and deletes that fit the project; the rest is reported back to the model. */
function checkMoves(files: AgentFile[], deletes: string[], renames: { from: string; to: string }[]) {
  const names = new Set(files.map((f) => f.name.toLowerCase()));
  const problems: string[] = [];
  const okRenames: { from: string; to: string }[] = [];
  for (const r of renames) {
    if (!names.has(r.from.toLowerCase())) problems.push(`Cannot rename "${r.from}": no such file.`);
    else if (names.has(r.to.toLowerCase()) && r.to.toLowerCase() !== r.from.toLowerCase()) problems.push(`Cannot rename "${r.from}" to "${r.to}": that file already exists.`);
    else {
      names.delete(r.from.toLowerCase());
      names.add(r.to.toLowerCase());
      okRenames.push(r);
    }
  }
  const okDeletes: string[] = [];
  for (const d of deletes) {
    if (!names.has(d.toLowerCase())) problems.push(`Cannot delete "${d}": no such file.`);
    else {
      names.delete(d.toLowerCase());
      okDeletes.push(d);
    }
  }
  return { deletes: okDeletes, renames: okRenames, problems };
}

/** Apply renames, then deletes to the agent's copy of the project. */
function applyMoves(files: AgentFile[], deletes: string[], renames: { from: string; to: string }[]): AgentFile[] {
  let out = files.map((f) => {
    const r = renames.find((x) => x.from.toLowerCase() === f.name.toLowerCase());
    return r ? { ...f, name: r.to } : f;
  });
  const gone = new Set(deletes.map((d) => d.toLowerCase()));
  out = out.filter((f) => !gone.has(f.name.toLowerCase()));
  return out;
}

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
  | {
      kind: 'step';
      text: string;
      changed: string[];
      deleted: string[];
      renamed: { from: string; to: string }[];
      model: string;
      planStep: number | null;
    }
  | { kind: 'external-read'; results: ExternalRead[] }
  | { kind: 'external-write'; results: ExternalWrite[] }
  | { kind: 'run'; path: string; report: RunReport }
  | { kind: 'install'; python: string[]; node: string[]; ok: boolean; output: string }
  | { kind: 'finished'; reason: 'done' | 'stopped' | 'rejected' | 'max-steps' | 'error'; steps: number; error?: string };

export const AGENT_MAX_STEPS = 8;
/** Step limits the user can pick; 0 = no limit (the agent works until done or Stop) */
export const AGENT_STEP_CHOICES = [8, 20, 50, 0] as const;

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
  /** Write files into the project; `moves` renames, then deletes project files first */
  applyFiles: (changes: AgentFile[], moves?: { deletes: string[]; renames: { from: string; to: string }[] }) => void;
  onEvent: (e: AgentEvent) => void;
  /** Ask the user before changing files / running code. Omitted = everything is allowed. */
  confirm?: (req: AgentApprovalRequest) => Promise<AgentApproval>;
  /** Ask about files outside the project: always, whatever `confirm` and "allow all" say. Omitted = refused. */
  confirmExternal?: (req: AgentApprovalRequest) => Promise<AgentApproval>;
  /** Steps before the agent stops; 0 or null = no limit. Default AGENT_MAX_STEPS. */
  maxSteps?: number | null;
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
  let files = opts.files.map((f) => ({ ...f }));
  const maxSteps = opts.maxSteps === undefined ? AGENT_MAX_STEPS : opts.maxSteps || Infinity;
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
    while (steps < maxSteps) {
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
        deleted: step.delete || [],
        renamed: step.rename || [],
        model: data.model,
        planStep: step.planStep ?? null,
      });

      // File changes, renames and deletes: shown to the user first (unless everything is allowed), then applied
      const moves = checkMoves(files, step.delete || [], step.rename || []);
      if (step.files.length > 0 || moves.deletes.length > 0 || moves.renames.length > 0) {
        const moved = applyMoves(files, moves.deletes, moves.renames);
        const changes = step.files.map((ch) => ({
          path: ch.path,
          oldContent: moved.find((f) => f.name.toLowerCase() === ch.path.toLowerCase())?.content ?? null,
          newContent: ch.content,
        }));
        if (!(await ask({ kind: 'files', changes, deletes: moves.deletes, renames: moves.renames }))) {
          return opts.onEvent({ kind: 'finished', reason: 'rejected', steps });
        }
        files = moved;
        for (const ch of step.files) {
          const existing = files.find((f) => f.name.toLowerCase() === ch.path.toLowerCase());
          if (existing) existing.content = ch.content;
          else files.push({ name: ch.path, content: ch.content });
        }
        opts.applyFiles(
          step.files.map((f) => ({ name: f.path, content: f.content })),
          { deletes: moves.deletes, renames: moves.renames }
        );
      }
      convo.push({ role: 'model', text: JSON.stringify(step) });
      if (moves.problems.length) convo.push({ role: 'user', text: moves.problems.join('\n') });

      // Outside the project: always asked, even after "allow all"
      const askExternal = async (req: AgentApprovalRequest) => !!opts.confirmExternal && (await opts.confirmExternal(req)) !== 'no';
      if (step.readExternal?.length) {
        if (!(await askExternal({ kind: 'external-read', paths: step.readExternal }))) {
          return opts.onEvent({ kind: 'finished', reason: 'rejected', steps });
        }
        if (opts.signal.aborted) return opts.onEvent({ kind: 'finished', reason: 'stopped', steps });
        const results = await readExternal(step.readExternal, opts.signal);
        opts.onEvent({ kind: 'external-read', results });
        convo.push({ role: 'user', text: `Files outside the project you asked for:\n\n${clip(describeExternalReads(results), 60_000)}` });
      }
      if (step.writeExternal?.length) {
        // The current content, so the user sees exactly what changes
        const before = await readExternal(step.writeExternal.map((f) => f.path), opts.signal);
        const changes = step.writeExternal.map((f, i) => {
          const b = before[i];
          return { path: b && b.kind !== 'error' ? b.path : f.path, oldContent: b?.kind === 'file' && !b.truncated ? b.content : null, newContent: f.content };
        });
        if (!(await askExternal({ kind: 'external-write', changes }))) {
          return opts.onEvent({ kind: 'finished', reason: 'rejected', steps });
        }
        if (opts.signal.aborted) return opts.onEvent({ kind: 'finished', reason: 'stopped', steps });
        const results = await writeExternal(step.writeExternal, opts.signal);
        opts.onEvent({ kind: 'external-write', results });
        convo.push({
          role: 'user',
          text:
            'Files outside the project:\n' +
            results.map((r) => (r.ok ? `${r.path}: ${r.created ? 'created' : 'overwritten'}` : `${r.path}: NOT written — ${r.error}`)).join('\n'),
        });
      }

      // Package installs: the user approves, then pip/npm run into the project's own packages folder
      if (step.install && (step.install.python.length || step.install.node.length)) {
        const { python, node } = step.install;
        if (!opts.projectId) {
          convo.push({ role: 'user', text: 'Cannot install packages: the project has not been saved yet. Continue without them.' });
        } else if (!(await ask({ kind: 'install', python, node }))) {
          return opts.onEvent({ kind: 'finished', reason: 'rejected', steps });
        } else {
          if (opts.signal.aborted) return opts.onEvent({ kind: 'finished', reason: 'stopped', steps });
          const result = await installPackages(opts.projectId, { python, node }, opts.signal);
          opts.onEvent({ kind: 'install', python, node, ok: result.ok, output: result.output });
          convo.push({
            role: 'user',
            text:
              `Package install ${result.ok ? 'succeeded' : 'FAILED'} (python: ${python.join(', ') || 'none'}; node: ${node.join(', ') || 'none'}).\n` +
              `${clip(result.output, 1500)}\n\n` +
              (result.ok ? 'The packages are now available. Continue.' : 'Do not rely on these packages; adjust your approach and continue.'),
          });
        }
      }

      if (!step.run) {
        if (step.done) return opts.onEvent({ kind: 'finished', reason: 'done', steps });
        convo.push({ role: 'user', text: 'Continue with the next step.' });
        continue;
      }

      if (opts.signal.aborted) return opts.onEvent({ kind: 'finished', reason: 'stopped', steps });
      // Risky code (deletes folders, edits the registry, downloads and runs...) is always asked about,
      // even after "allow all"
      const risks = findRisks(files.find((f) => f.name === step.run)?.content || '');
      const allowed = risks.length && opts.confirm ? (await opts.confirm({ kind: 'run', path: step.run, risks })) !== 'no' : await ask({ kind: 'run', path: step.run });
      if (!allowed) return opts.onEvent({ kind: 'finished', reason: 'rejected', steps });
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

/** Markdown for a package install shown in the chat. */
export function formatInstall(e: { python: string[]; node: string[]; ok: boolean; output: string }): string {
  const names = [...e.python, ...e.node].map((p) => `\`${p}\``).join(', ');
  const status = e.ok ? t('agent.installOk') : t('agent.installFail');
  return `📦 **${t('agent.installTitle')}:** ${names} — ${status}\n\n\`\`\`text\n${clip(e.output, 2000)}\n\`\`\``;
}

/** Markdown for what the agent read or wrote outside the project. */
export function formatExternal(e: { kind: 'external-read'; results: ExternalRead[] } | { kind: 'external-write'; results: ExternalWrite[] }): string {
  if (e.kind === 'external-read') {
    const lines = e.results.map((r) => {
      const what =
        r.kind === 'file'
          ? t('agent.extFile', { size: r.size })
          : r.kind === 'dir'
            ? t('agent.extDir', { count: r.entries.length })
            : r.kind === 'binary'
              ? t('agent.extBinary')
              : r.kind === 'missing'
                ? t('agent.extMissing')
                : `✗ ${r.error}`;
      return `- \`${r.path}\` — ${what}`;
    });
    return `📂 **${t('agent.extReadTitle')}:**\n${lines.join('\n')}`;
  }
  const lines = e.results.map((r) =>
    r.ok
      ? `- \`${r.path}\` — ${r.created ? t('agent.extCreated') : t('agent.extOverwritten')}${r.backup ? `\n  ${t('agent.extBackup')}: \`${r.backup}\`` : ''}`
      : `- \`${r.path}\` — ✗ ${r.error}`
  );
  return `💾 **${t('agent.extWriteTitle')}:**\n${lines.join('\n')}`;
}

/** Markdown for a run report shown in the chat. */
export function formatRunReport(path: string, report: RunReport): string {
  const status = report.ok ? t('agent.runOk', { code: report.exitCode ?? 0 }) : t('agent.runFail', { code: report.exitCode ?? '?' });
  return `▶ **${t('agent.run')} \`${path}\`** — ${status}\n\n\`\`\`text\n${clip(report.output, 2500)}\n\`\`\``;
}

export function filesFromItems(items: FileItem[]): AgentFile[] {
  return items.map((f) => ({ name: f.name, content: f.content }));
}
