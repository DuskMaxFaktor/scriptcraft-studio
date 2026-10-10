import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { backupDir } from './backups.ts';

// The agent's access to files outside the project. Every read and write is approved by the user in the
// chat first (the studio asks even after "allow all"); this module only does what was approved, and still
// refuses places the agent must never touch: the studio itself (keys, settings, projects), .env files,
// and Windows / Program Files. An overwritten file is copied to the backups folder first.

const STUDIO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_READ_BYTES = 200 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_LIST = 300;
const MAX_PATHS = 20;

class AgentFsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const inside = (p: string, dir: string) => {
  const a = norm(p);
  const d = norm(dir);
  return a === d || a.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
};

/** Folders the agent may never read or write: the studio's code and data (projects, .env, settings). */
function forbiddenDirs(): string[] {
  const dirs = [STUDIO_ROOT, process.cwd()];
  if (process.platform === 'win32') {
    for (const v of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
      const d = process.env[v];
      if (d) dirs.push(d);
    }
  }
  return dirs;
}

/** An absolute path the agent may use, or an error that says why not. */
export function checkExternalPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new AgentFsError(400, 'Empty path');
  const p = raw.trim();
  if (!path.isAbsolute(p) || (process.platform === 'win32' && !/^[a-zA-Z]:[\\/]/.test(p))) {
    throw new AgentFsError(400, `Not a full path: ${p} (use e.g. C:\\Users\\Name\\file.txt)`);
  }
  const full = path.resolve(p);
  if (/^\.env/i.test(path.basename(full))) throw new AgentFsError(403, `.env files hold keys and are never given to the AI: ${full}`);
  for (const dir of forbiddenDirs()) {
    if (inside(full, dir)) throw new AgentFsError(403, `The agent may not use this folder: ${full}`);
  }
  return full;
}

const looksBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

export type ReadResult =
  | { path: string; kind: 'file'; content: string; truncated: boolean; size: number }
  | { path: string; kind: 'binary'; size: number }
  | { path: string; kind: 'dir'; entries: { name: string; dir: boolean; size: number }[]; truncated: boolean }
  | { path: string; kind: 'missing' }
  | { path: string; kind: 'error'; error: string };

export function readExternal(raw: unknown): ReadResult {
  let full: string;
  try {
    full = checkExternalPath(raw);
  } catch (err: any) {
    return { path: String(raw), kind: 'error', error: err.message };
  }
  try {
    if (!fs.existsSync(full)) return { path: full, kind: 'missing' };
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      const all = fs.readdirSync(full, { withFileTypes: true });
      const entries = all.slice(0, MAX_LIST).map((d) => {
        let size = 0;
        if (d.isFile()) {
          try {
            size = fs.statSync(path.join(full, d.name)).size;
          } catch {
            /* locked or gone */
          }
        }
        return { name: d.name, dir: d.isDirectory(), size };
      });
      return { path: full, kind: 'dir', entries, truncated: all.length > MAX_LIST };
    }
    const fd = fs.openSync(full, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_READ_BYTES));
      fs.readSync(fd, buf, 0, buf.length, 0);
      if (looksBinary(buf)) return { path: full, kind: 'binary', size: st.size };
      return { path: full, kind: 'file', content: buf.toString('utf-8'), truncated: st.size > MAX_READ_BYTES, size: st.size };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err: any) {
    return { path: full, kind: 'error', error: err.message };
  }
}

export type WriteResult = { path: string; ok: true; created: boolean; backup: string | null } | { path: string; ok: false; error: string };

/** Copy of a file about to be overwritten: <backups>\agent\<time>\C\Users\...\file */
function backupCopy(full: string, stamp: string): string {
  const rel = full.replace(/^([a-zA-Z]):/, '$1').replace(/^[\\/]+/, '');
  const target = path.join(backupDir(), 'agent', stamp, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(full, target);
  return target;
}

export function writeExternal(files: unknown, stamp = new Date().toISOString().replace(/[:.]/g, '-')): WriteResult[] {
  if (!Array.isArray(files) || files.length === 0) throw new AgentFsError(400, 'files must be a non-empty array');
  if (files.length > MAX_PATHS) throw new AgentFsError(400, `Too many files (max ${MAX_PATHS})`);
  return files.map((f: any): WriteResult => {
    try {
      const full = checkExternalPath(f?.path);
      if (typeof f.content !== 'string') throw new AgentFsError(400, 'No content');
      if (Buffer.byteLength(f.content, 'utf-8') > MAX_WRITE_BYTES) throw new AgentFsError(400, 'Content too large');
      const exists = fs.existsSync(full);
      if (exists && fs.statSync(full).isDirectory()) throw new AgentFsError(400, 'This is a folder, not a file');
      const backup = exists ? backupCopy(full, stamp) : null;
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content, 'utf-8');
      return { path: full, ok: true, created: !exists, backup };
    } catch (err: any) {
      return { path: String(f?.path), ok: false, error: err.message };
    }
  });
}

export const agentFsRouter = Router();

agentFsRouter.post('/read', (req, res) => {
  const paths = req.body?.paths;
  if (!Array.isArray(paths) || paths.length === 0) return res.status(400).json({ error: 'paths must be a non-empty array' });
  if (paths.length > MAX_PATHS) return res.status(400).json({ error: `Too many paths (max ${MAX_PATHS})` });
  res.json({ results: paths.map(readExternal) });
});

agentFsRouter.post('/write', (req, res) => {
  try {
    res.json({ results: writeExternal(req.body?.files) });
  } catch (err: any) {
    res.status(err instanceof AgentFsError ? err.status : 500).json({ error: err.message });
  }
});
