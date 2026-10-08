import { LogEntry } from '../types.ts';
import { attachRunStream, InteractiveRun } from './interactiveRun.ts';

/** A breakpoint: a 1-based line, optionally conditional (stops only when the expression is truthy). */
export interface Breakpoint {
  line: number;
  condition?: string;
}
export type Breakpoints = Record<string, Breakpoint[]>;

export interface DebugVariable {
  name: string;
  value: string;
  type: string;
}

export interface StoppedState {
  reason: string;
  file: string | null;
  line: number;
  stack: { file: string; line: number; name: string }[];
  locals: DebugVariable[];
  globals: DebugVariable[];
}

export interface EvalResult {
  expr: string;
  value?: string;
  type?: string;
  error?: string;
}

export type DebugCommand = 'continue' | 'next' | 'step' | 'out';

export interface DebugSessionHandle {
  run: InteractiveRun;
  command: (cmd: DebugCommand) => void;
  setBreakpoints: (bps: Breakpoints) => void;
  evaluate: (expr: string) => void;
}

/** Languages the debugger supports, by file extension */
export function debuggableLanguage(fileName: string): 'python' | 'javascript' | null {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'py') return 'python';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'javascript';
  return null;
}

/**
 * Start a debug session: the program's output/stdin go through the usual terminal stream,
 * debugger events (stopped / running / eval results) arrive through `onEvent`.
 */
export async function startDebugSession(opts: {
  language: 'python' | 'javascript';
  code: string;
  files: { name: string; content: string }[];
  entry: string;
  projectId: string | null;
  breakpoints: Breakpoints;
  upsertLog: (e: LogEntry) => void;
  onStopped: (s: StoppedState) => void;
  onRunning: () => void;
  onEval: (r: EvalResult) => void;
}): Promise<DebugSessionHandle> {
  const res = await fetch('/api/debug/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      language: opts.language,
      code: opts.code,
      files: opts.files,
      entry: opts.entry,
      projectId: opts.projectId || undefined,
      breakpoints: opts.breakpoints,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  const runId: string = data.runId;

  const run = attachRunStream(runId, opts.upsertLog);
  const es = new EventSource(`/api/debug/${runId}/events`);
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.event === 'stopped') opts.onStopped(e);
    else if (e.event === 'running') opts.onRunning();
    else if (e.event === 'evalResult') opts.onEval(e);
    else if (e.event === 'terminated') es.close();
  };
  run.done.finally(() => es.close());

  const post = (body: unknown) =>
    fetch(`/api/debug/${runId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});

  return {
    run,
    command: (cmd) => post({ cmd }),
    setBreakpoints: (bps) => post({ cmd: 'setBreakpoints', breakpoints: bps }),
    evaluate: (expr) => post({ cmd: 'eval', expr }),
  };
}
