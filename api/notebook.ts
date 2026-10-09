import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type { ChildProcess } from 'child_process';
import { spawnCommand, projectPackagesDir, killProcessTree } from './run.ts';

// Python notebook kernels: a long-lived Python process per notebook that keeps its namespace
// between cells (like Jupyter). The process runs api/python/kernel.py and talks JSON lines on
// stdin/stdout; this module forwards cell code to it and streams its output events over SSE.

const isWin = process.platform === 'win32';
const KERNEL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'kernel.py');
const KERNEL_MAX_MS = 6 * 60 * 60 * 1000; // a safety cap; the UI shuts kernels down when a notebook closes

interface Kernel {
  id: string;
  proc: ChildProcess;
  ready: boolean;
  events: any[];
  listeners: Set<(e: any, index: number) => void>;
  projectId: string | null;
  killTimer: NodeJS.Timeout;
  buf: string;
}

const kernels = new Map<string, Kernel>();
let seq = 0;

function emit(k: Kernel, e: any) {
  k.events.push(e);
  if (k.events.length > 3000) k.events.splice(0, k.events.length - 3000);
  k.listeners.forEach((l) => l(e, k.events.length - 1));
}

function kernelEnv(projectId: string | null): { cwd: string; env: NodeJS.ProcessEnv } {
  let cwd = process.cwd();
  // Non-interactive matplotlib: plots are captured inline, plt.show() never opens a blocking window
  const env: NodeJS.ProcessEnv = { MPLBACKEND: 'Agg' };
  if (projectId && /^[a-zA-Z0-9_-]{1,80}$/.test(projectId)) {
    const dir = path.join(process.cwd(), 'projects', projectId);
    if (fs.existsSync(dir)) cwd = dir; // run relative to the project, like the rest of the studio
    const pkg = projectPackagesDir(projectId);
    const pyDir = pkg ? path.join(pkg, 'python') : null;
    if (pyDir && fs.existsSync(pyDir)) env.PYTHONPATH = [pyDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  }
  return { cwd, env };
}

function attachProc(k: Kernel) {
  k.buf = '';
  const proc = k.proc; // bind handlers to THIS process, so a restart's old process stays quiet
  proc.stdout?.on('data', (chunk: Buffer) => {
    k.buf += chunk.toString('utf-8');
    let i;
    while ((i = k.buf.indexOf('\n')) >= 0) {
      const line = k.buf.slice(0, i);
      k.buf = k.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a non-JSON line (shouldn't happen) is ignored
      }
      if (msg.ready) {
        k.ready = true;
        emit(k, { type: 'kernel', status: 'ready' });
      } else {
        emit(k, msg);
      }
    }
  });
  // The kernel routes program output as JSON on stdout; raw stderr means a crash/import error
  proc.stderr?.on("data", (chunk: Buffer) => emit(k, { type: 'stream', name: 'stderr', text: chunk.toString('utf-8') }));
  proc.on('exit', (code) => {
    // Only report death for the CURRENT process (a restart's old process exiting is expected)
    if (kernels.get(k.id) === k && k.proc === proc) emit(k, { type: 'kernel', status: 'dead', code });
  });
}

function spawnKernel(projectId: string | null): ChildProcess {
  const { cwd, env } = kernelEnv(projectId);
  return spawnCommand(isWin ? 'python' : 'python3', ['-u', KERNEL], cwd, env);
}

function disposeKernel(k: Kernel) {
  clearTimeout(k.killTimer);
  emit(k, { type: 'kernel', status: 'dead' }); // tells open event streams to close
  try {
    killProcessTree(k.proc); // on Windows the shell child must be killed with its whole tree
  } catch {
    // already gone
  }
  kernels.delete(k.id);
}

export const notebookRouter = Router();

notebookRouter.post('/kernel/start', (req, res) => {
  const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : null;
  const id = `k${Date.now()}-${++seq}`;
  const proc = spawnKernel(projectId);
  const k: Kernel = {
    id,
    proc,
    ready: false,
    events: [],
    listeners: new Set(),
    projectId,
    killTimer: setTimeout(() => disposeKernel(k), KERNEL_MAX_MS),
    buf: '',
  };
  proc.on('error', (e: any) => emit(k, { type: 'kernel', status: 'error', message: e?.code === 'ENOENT' ? 'Python was not found' : String(e?.message || e) }));
  attachProc(k);
  kernels.set(id, k);
  res.json({ kernelId: id });
});

notebookRouter.get('/kernel/:id/events', (req, res) => {
  const k = kernels.get(req.params.id);
  if (!k) return res.status(404).json({ error: 'Kernel not found' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let ended = false;
  const send = (e: any, index: number) => {
    if (ended) return;
    res.write(`id: ${index}\ndata: ${JSON.stringify(e)}\n\n`);
    // When the kernel is gone there is nothing more to stream: close so the client stops waiting
    if (e?.type === 'kernel' && e.status === 'dead') {
      ended = true;
      res.end();
    }
  };
  const lastId = Number(req.headers['last-event-id']);
  k.events.forEach((e, i) => {
    if (!Number.isFinite(lastId) || i > lastId) send(e, i);
  });
  k.listeners.add(send);
  // unref: a quiet kernel's keep-alive ping must not hold the process open on its own
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  keepAlive.unref?.();
  res.on('close', () => {
    clearInterval(keepAlive);
    k.listeners.delete(send);
  });
});

notebookRouter.post('/kernel/:id/exec', (req, res) => {
  const k = kernels.get(req.params.id);
  if (!k) return res.status(404).json({ error: 'Kernel not found' });
  const code = String(req.body?.code ?? '');
  if (code.length > 1_000_000) return res.status(400).json({ error: 'Cell is too large' });
  const execId = `e${++seq}`;
  try {
    k.proc.stdin?.write(JSON.stringify({ execId, code }) + '\n');
  } catch {
    return res.status(500).json({ error: 'Kernel is not accepting input' });
  }
  res.json({ execId });
});

// Interrupt the running cell (soft: KeyboardInterrupt in the kernel; the namespace is kept)
notebookRouter.post('/kernel/:id/interrupt', (req, res) => {
  const k = kernels.get(req.params.id);
  if (!k) return res.status(404).json({ error: 'Kernel not found' });
  try {
    k.proc.stdin?.write(JSON.stringify({ cmd: 'interrupt' }) + '\n');
  } catch {
    // kernel gone
  }
  res.json({ ok: true });
});

// Restart: a fresh namespace. The kernel id stays the same, so the open event stream keeps working.
notebookRouter.post('/kernel/:id/restart', (req, res) => {
  const k = kernels.get(req.params.id);
  if (!k) return res.status(404).json({ error: 'Kernel not found' });
  try {
    killProcessTree(k.proc);
  } catch {
    // already gone
  }
  k.ready = false;
  k.proc = spawnKernel(k.projectId);
  k.proc.on('error', (e: any) => emit(k, { type: 'kernel', status: 'error', message: String(e?.message || e) }));
  attachProc(k);
  emit(k, { type: 'kernel', status: 'restarted' });
  res.json({ ok: true });
});

notebookRouter.delete('/kernel/:id', (req, res) => {
  const k = kernels.get(req.params.id);
  if (k) disposeKernel(k);
  res.json({ ok: true });
});

/** For tests/shutdown: stop every kernel. */
export function stopAllKernels() {
  for (const k of [...kernels.values()]) disposeKernel(k);
}

/** Shut down any kernels running inside a project (called before the project folder is deleted). */
export function stopProjectKernels(projectId: string) {
  for (const k of [...kernels.values()]) if (k.projectId === projectId) disposeKernel(k);
}
