import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { fileURLToPath } from 'url';
import { projectPackagesDir } from './run.ts';

// Python code intelligence (Jedi): completions, signature help, hover, go to definition, rename.
// One long-lived Python worker answers JSON requests; Jedi lives in the studio's tools folder
// (or comes with the portable build's Python).

const isWin = process.platform === 'win32';
const STUDIO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = path.join(STUDIO_ROOT, 'tools', 'python');
const WORKER = path.join(STUDIO_ROOT, 'api', 'python', 'jedi_worker.py');
const REQUEST_TIMEOUT_MS = 8000;
const MAX_CODE = 1024 * 1024;

const workerEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PYTHONPATH: [TOOLS_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  PYTHONIOENCODING: 'utf-8',
  PYTHONDONTWRITEBYTECODE: '1',
});

let jediCache: { ok: boolean; at: number } | null = null;
export function hasJedi(): boolean {
  if (jediCache && Date.now() - jediCache.at < 15_000) return jediCache.ok;
  const r = spawnSync(isWin ? 'python' : 'python3', ['-c', 'import jedi'], { env: workerEnv(), windowsHide: true, timeout: 20_000 });
  jediCache = { ok: r.status === 0, at: Date.now() };
  return jediCache.ok;
}
export const resetJediCache = () => {
  jediCache = null;
  stopWorker();
};

// ---------- the worker ----------
let worker: ChildProcessWithoutNullStreams | null = null;
let ready: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

export function stopWorker() {
  if (worker) worker.kill();
  worker = null;
  ready = null;
}

function startWorker(): Promise<void> {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    const proc = spawn(isWin ? 'python' : 'python3', ['-u', WORKER], { env: workerEnv(), cwd: STUDIO_ROOT, windowsHide: true });
    worker = proc;
    let buf = '';
    let started = false;
    proc.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf-8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.ready) {
          started = true;
          resolve();
          continue;
        }
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg);
        else p.reject(new Error(msg.error || 'Jedi error'));
      }
    });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf-8')).slice(-2000)));
    proc.on('exit', () => {
      if (worker === proc) {
        worker = null;
        ready = null;
      }
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Python intelligence stopped'));
        pending.delete(id);
      }
      if (!started) reject(new Error(stderr.trim().split('\n').pop() || 'Cannot start Jedi'));
    });
  });
  return ready;
}

async function ask(req: Record<string, unknown>): Promise<any> {
  await startWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Python intelligence timed out'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    worker!.stdin.write(JSON.stringify({ ...req, id }) + '\n');
  });
}

process.on('exit', stopWorker);

// ---------- requests from the editor ----------
class IntelError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

interface Ctx {
  root: string;
  abs: string;
  extra: string[];
}

function context(req: any): Ctx & { code: string; line: number; column: number } {
  const name = String(req.body?.name || '').replace(/\\/g, '/');
  if (!/\.pyw?$/i.test(name) || name.split('/').some((s) => s === '..' || s === '')) throw new IntelError(400, 'A .py file is required');
  const code = req.body?.code;
  if (typeof code !== 'string' || code.length > MAX_CODE) throw new IntelError(400, 'Code is required');
  const projectId = req.body?.projectId;
  let root = path.join(os.tmpdir(), 'scriptcraft-pyintel');
  const extra: string[] = [];
  if (typeof projectId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(projectId)) {
    const dir = path.join(process.cwd(), 'projects', projectId);
    if (fs.existsSync(dir)) {
      root = dir;
      // Packages installed with the "Packages" button
      const pkg = projectPackagesDir(projectId);
      if (pkg && fs.existsSync(path.join(pkg, 'python'))) extra.push(path.join(pkg, 'python'));
    }
  }
  const abs = path.join(root, name);
  if (!path.resolve(abs).startsWith(path.resolve(root) + path.sep)) throw new IntelError(400, 'Invalid file name');
  // Editor positions are 1-based; Jedi columns are 0-based
  const line = Math.max(1, Number(req.body?.line) || 1);
  const column = Math.max(0, (Number(req.body?.column) || 1) - 1);
  return { root, abs, extra, code, line, column };
}

/** A path from Jedi as a project file name, or null for files outside the project (libraries). */
function projectName(root: string, p: string | null): string | null {
  if (!p) return null;
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const name = rel.replace(/\\/g, '/');
  return name.split('/').some((s) => s.startsWith('.')) ? null : name;
}

const wrap =
  (fn: (req: any) => Promise<unknown>) =>
  async (req: any, res: any) => {
    try {
      if (!hasJedi()) throw new IntelError(409, 'Jedi is not installed', 'jedi-missing');
      res.json(await fn(req));
    } catch (err: any) {
      const status = err instanceof IntelError ? err.status : 500;
      if (status === 500 && !/timed out/.test(err?.message)) console.error('Python intelligence error:', err?.message);
      res.status(status).json({ error: err?.message || 'Error', code: err?.code });
    }
  };

export const pyIntelRouter = Router();

const run = (op: string, c: ReturnType<typeof context>, more: Record<string, unknown> = {}) =>
  ask({ op, path: c.abs, code: c.code, line: c.line, column: c.column, root: c.root, extra: c.extra, ...more });

pyIntelRouter.post('/complete', wrap(async (req) => ({ items: (await run('complete', context(req))).items })));
pyIntelRouter.post('/signatures', wrap(async (req) => ({ signatures: (await run('signatures', context(req))).signatures })));
pyIntelRouter.post('/hover', wrap(async (req) => ({ items: (await run('hover', context(req))).items })));

pyIntelRouter.post(
  '/definition',
  wrap(async (req) => {
    const c = context(req);
    const { locations } = await run('definition', c);
    return {
      locations: locations.map((l: any) => {
        const file = projectName(c.root, l.path);
        // Jedi columns are 0-based
        return { file, line: l.line, column: l.column + 1, module: l.module, name: l.name, external: !file, builtin: l.builtin };
      }),
    };
  })
);

pyIntelRouter.post(
  '/rename',
  wrap(async (req) => {
    const c = context(req);
    const newName = String(req.body?.newName || '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) throw new IntelError(400, 'Not a valid Python name');
    const { files } = await run('rename', c, { newName });
    const changes: { name: string; content: string }[] = [];
    for (const [p, content] of Object.entries(files as Record<string, string>)) {
      const name = projectName(c.root, p);
      // Only project files: never rewrite installed libraries
      if (name) changes.push({ name, content });
    }
    return { files: changes };
  })
);
