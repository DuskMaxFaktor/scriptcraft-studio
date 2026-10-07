import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { startSession, spawnCommand } from './run.ts';

// "Disassembler": inspect and patch .exe / .dll and other binaries (like Ghidra's basics).
// Analysis and disassembly run in Python (pefile + capstone, installed on request into the studio's
// tools folder or shipped with the portable build). Hex viewing and byte patching are plain file I/O
// done here in Node, so they always work even without the Python libraries.

const isWin = process.platform === 'win32';
const STUDIO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = path.join(STUDIO_ROOT, 'tools', 'python');
const SCRIPT = path.join(STUDIO_ROOT, 'api', 'python', 'disasm.py');
const PY = () => (isWin ? 'python' : 'python3');
const MAX_FILE = 64 * 1024 * 1024;
const ANALYZE_MS = 60_000;

const pyEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PYTHONPATH: [TOOLS_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  PYTHONIOENCODING: 'utf-8',
  PYTHONDONTWRITEBYTECODE: '1',
});

class DisasmError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

/** Resolve a project file safely; the same rules as the project /raw route. */
function resolveFile(projectId: unknown, rel: unknown): string {
  const id = String(projectId || '');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new DisasmError(400, 'Invalid project id');
  const dir = path.join(process.cwd(), 'projects', id);
  if (!fs.existsSync(dir)) throw new DisasmError(404, 'Project not found');
  const name = String(rel || '').replace(/\\/g, '/');
  if (!name || name.split('/').some((s) => !s || s === '..' || s.startsWith('.'))) throw new DisasmError(400, 'Invalid path');
  const abs = path.join(dir, name);
  if (!path.resolve(abs).startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new DisasmError(404, 'File not found');
  }
  if (fs.statSync(abs).size > MAX_FILE) throw new DisasmError(413, 'File is too large to analyze (over 64 MB)');
  return abs;
}

/** Run disasm.py with a JSON request on stdin, parse the JSON reply. */
function runPython(request: object, timeoutMs = ANALYZE_MS): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(PY(), ['-u', SCRIPT], { env: pyEnv(), cwd: STUDIO_ROOT, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e: any) => {
      clearTimeout(timer);
      if (e?.code === 'ENOENT') reject(new DisasmError(409, 'Python is not available', 'python-missing'));
      else reject(new DisasmError(500, e.message));
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) return reject(new DisasmError(504, 'Analysis timed out'));
      const text = Buffer.concat(out).toString('utf-8').trim();
      if (!text) return reject(new DisasmError(500, Buffer.concat(err).toString('utf-8').trim() || 'No output from analyzer'));
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        return reject(new DisasmError(500, 'Bad analyzer output'));
      }
      if (!msg.ok) {
        const m = String(msg.error || 'Analysis failed');
        if (/is not installed/.test(m)) return reject(new DisasmError(409, m, 'libs-missing'));
        return reject(new DisasmError(422, m));
      }
      resolve(msg.result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request), 'utf-8');
  });
}

export function hasDisasmLibs(): { pefile: boolean; capstone: boolean } {
  const check = (mod: string) => spawnSync(PY(), ['-c', `import ${mod}`], { env: pyEnv(), windowsHide: true, timeout: 20_000 }).status === 0;
  return { pefile: check('pefile'), capstone: check('capstone') };
}

const wrap =
  (fn: (req: any) => Promise<unknown>) =>
  async (req: any, res: any) => {
    try {
      res.json(await fn(req));
    } catch (err: any) {
      const status = err instanceof DisasmError ? err.status : 500;
      if (status === 500) console.error('Disassembler error:', err);
      res.status(status).json({ error: err.message || 'Disassembler error', code: err.code });
    }
  };

export const disasmRouter = Router();

disasmRouter.get(
  '/available',
  wrap(async () => {
    const libs = hasDisasmLibs();
    return { ...libs, ready: libs.pefile && libs.capstone };
  })
);

/** Install pefile + capstone into the studio's tools folder; output streams like a program run. */
disasmRouter.post(
  '/install',
  wrap(async () => {
    fs.mkdirSync(TOOLS_DIR, { recursive: true });
    const proc = spawnCommand(
      PY(),
      ['-m', 'pip', 'install', '--upgrade', '--target', TOOLS_DIR, 'pefile', 'capstone', '--disable-pip-version-check', '--no-warn-script-location'],
      process.cwd()
    );
    return { runId: startSession(proc, undefined, 5 * 60 * 1000) };
  })
);

disasmRouter.post(
  '/analyze',
  wrap(async (req) => {
    const file = resolveFile(req.body?.projectId, req.body?.path);
    return runPython({ cmd: 'analyze', file });
  })
);

disasmRouter.post(
  '/disasm',
  wrap(async (req) => {
    const file = resolveFile(req.body?.projectId, req.body?.path);
    const offset = Math.max(0, Math.floor(Number(req.body?.offset) || 0));
    const length = Math.min(Math.max(1, Math.floor(Number(req.body?.length) || 4096)), 256 * 1024);
    const vaddr = Math.max(0, Math.floor(Number(req.body?.vaddr) || offset));
    const arch = String(req.body?.arch || 'x64');
    return runPython({ cmd: 'disasm', file, offset, length, vaddr, arch }, 30_000);
  })
);

/** Raw bytes for the hex view (paged); plain file read, no Python needed. */
disasmRouter.post(
  '/bytes',
  wrap(async (req) => {
    const file = resolveFile(req.body?.projectId, req.body?.path);
    const total = fs.statSync(file).size;
    const offset = Math.min(Math.max(0, Math.floor(Number(req.body?.offset) || 0)), total);
    const length = Math.min(Math.max(1, Math.floor(Number(req.body?.length) || 4096)), 64 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(length, total - offset));
      const read = fs.readSync(fd, buf, 0, buf.length, offset);
      return { offset, total, bytes: buf.subarray(0, read).toString('base64') };
    } finally {
      fs.closeSync(fd);
    }
  })
);

/** Patch bytes in place. A one-time .bak backup is made first; the file size never changes. */
disasmRouter.post(
  '/patch',
  wrap(async (req) => {
    const file = resolveFile(req.body?.projectId, req.body?.path);
    const total = fs.statSync(file).size;
    const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
    if (!edits.length) throw new DisasmError(400, 'No edits');
    if (edits.length > 10000) throw new DisasmError(400, 'Too many edits');
    const normalized: { offset: number; buf: Buffer }[] = [];
    for (const e of edits) {
      const offset = Math.floor(Number(e?.offset));
      const hex = String(e?.hex || '').replace(/\s+/g, '');
      if (!Number.isInteger(offset) || offset < 0) throw new DisasmError(400, 'Invalid offset');
      if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new DisasmError(400, 'Invalid hex bytes');
      const buf = Buffer.from(hex, 'hex');
      if (offset + buf.length > total) throw new DisasmError(400, 'Patch would extend past the end of the file');
      normalized.push({ offset, buf });
    }
    const bak = file + '.bak';
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
    const fd = fs.openSync(file, 'r+');
    try {
      for (const { offset, buf } of normalized) fs.writeSync(fd, buf, 0, buf.length, offset);
    } finally {
      fs.closeSync(fd);
    }
    return { patched: normalized.length, backup: path.basename(bak), size: total };
  })
);
