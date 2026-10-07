import { LogEntry } from '../types.ts';
import { t } from '../i18n.ts';
import { generateId, getTimestamp } from './execution.ts';

export interface InteractiveRun {
  runId: string;
  /** Send a line of input to the program's stdin (a newline is appended). */
  sendInput: (text: string) => Promise<void>;
  /** Kill the program. */
  stop: () => Promise<void>;
  /** Resolves when the program has exited. */
  done: Promise<RunOutcome>;
}

export interface RunOutcome {
  success: boolean;
  exitCode: number | null;
  stopped?: boolean;
}

/** Ids of terminal lines that are still being written (e.g. an input() prompt without a newline). */
export const PARTIAL_PREFIX = 'p-';

type ServerEvent =
  | { type: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; code: number | null; durationMs: number; reason: 'exit' | 'stopped' | 'timeout' | 'output-limit' | 'error' };

/**
 * Start a program on the local server and stream its output into the terminal.
 * `upsertLog` adds a line, or replaces the line with the same id (used for lines still being written).
 * Returns null if the server runner is unreachable (caller may fall back to the in-browser runner).
 */
export async function startInteractiveRun(
  language: string,
  code: string,
  upsertLog: (entry: LogEntry) => void,
  project?: { files: { name: string; content: string }[]; entry: string; projectId?: string | null }
): Promise<InteractiveRun | null> {
  let runId: string;
  try {
    const res = await fetch('/api/run/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language, code, files: project?.files, entry: project?.entry, projectId: project?.projectId || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
    runId = data.runId;
  } catch (err: any) {
    if (err instanceof TypeError) return null; // network error: server not reachable
    throw err;
  }
  return attachRunStream(runId, upsertLog);
}

/** Stream an already started server session (program run, package install...) into the terminal. */
export function attachRunStream(runId: string, upsertLog: (entry: LogEntry) => void): InteractiveRun {

  // Per-stream assembly of complete lines; the unfinished tail is shown live as a "partial" line
  const streams = {
    stdout: { buf: '', partialId: null as string | null, type: 'log' as LogEntry['type'] },
    stderr: { buf: '', partialId: null as string | null, type: 'error' as LogEntry['type'] },
  };

  const write = (name: 'stdout' | 'stderr', chunk: string) => {
    const s = streams[name];
    const lines = (s.buf + chunk.replace(/\r\n?/g, '\n')).split('\n');
    s.buf = lines.pop() ?? '';
    for (const line of lines) {
      upsertLog({ id: s.partialId || generateId(), type: s.type, message: line, timestamp: getTimestamp() });
      s.partialId = null;
    }
    if (s.buf) {
      s.partialId = s.partialId || PARTIAL_PREFIX + generateId();
      upsertLog({ id: s.partialId, type: s.type, message: s.buf, timestamp: getTimestamp() });
    }
  };

  const finishPartials = () => {
    for (const s of Object.values(streams)) {
      if (s.partialId) {
        // Re-emit under a normal id so the line is no longer treated as "waiting for input"
        upsertLog({ id: s.partialId, type: s.type, message: s.buf, timestamp: getTimestamp(), final: true });
      }
      s.buf = '';
      s.partialId = null;
    }
  };

  let resolveDone!: (v: RunOutcome) => void;
  const done = new Promise<RunOutcome>((r) => (resolveDone = r));
  let finished = false;
  let errorCount = 0;

  const es = new EventSource(`/api/run/${encodeURIComponent(runId)}/events`);
  es.onmessage = (msg) => {
    errorCount = 0;
    const ev: ServerEvent = JSON.parse(msg.data);
    if (ev.type === 'exit') {
      finished = true;
      es.close();
      finishPartials();
      const success = ev.reason === 'exit' && ev.code === 0;
      const message =
        ev.reason === 'stopped'
          ? t('run.stopped', { ms: ev.durationMs })
          : ev.reason === 'timeout'
            ? t('run.timeout')
            : ev.reason === 'output-limit'
              ? t('run.outputLimit')
              : t('run.exited', { code: ev.code ?? '?', ms: ev.durationMs });
      upsertLog({ id: generateId(), type: success ? 'success' : ev.reason === 'stopped' ? 'warn' : 'error', message, timestamp: getTimestamp() });
      resolveDone({ success, exitCode: ev.code, stopped: ev.reason === 'stopped' });
    } else {
      write(ev.type, ev.data);
    }
  };
  es.onerror = () => {
    // EventSource reconnects by itself (resuming via Last-Event-ID); give up if the run is gone
    if (finished) return;
    if (++errorCount >= 5) {
      finished = true;
      es.close();
      finishPartials();
      upsertLog({ id: generateId(), type: 'error', message: t('run.connectionLost'), timestamp: getTimestamp() });
      resolveDone({ success: false, exitCode: null });
    }
  };

  const sendInput = async (text: string) => {
    // Echo the input after the prompt, like a real terminal does
    const s = streams.stdout;
    if (s.partialId) {
      upsertLog({ id: s.partialId, type: 'log', message: s.buf + text, timestamp: getTimestamp(), final: true });
      s.partialId = null;
      s.buf = '';
    } else {
      upsertLog({ id: generateId(), type: 'info', message: `› ${text}`, timestamp: getTimestamp() });
    }
    await fetch(`/api/run/${encodeURIComponent(runId)}/stdin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: text + '\n' }),
    });
  };

  const stop = async () => {
    await fetch(`/api/run/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
  };

  return { runId, sendInput, stop, done };
}
