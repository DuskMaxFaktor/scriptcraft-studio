import express, { Router } from 'express';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { spawn } from 'child_process';
import { closeProjectTerminals } from './terminal.ts';
import { stopProjectKernels } from './notebook.ts';
import { stopProjectRuns } from './run.ts';
import { ENV_FILE, ENV_KEY, BAD_ARG_CHARS, readProjectEnv, readRunArgs, formatEnv, splitArgs } from './runconfig.ts';

// User projects live on disk: projects/<id>/ holds the real files plus a meta file,
// so they are visible (and editable) in Windows Explorer as ordinary files.
const PROJECTS_DIR = path.join(process.cwd(), 'projects');
const META_FILE = '.scriptcraft.json';
const CHAT_FILE = '.scriptcraft-chat.json';
// Service folders inside a project folder that project files must never overlap
const RESERVED_DIRS = new Set(['.packages', '.history']);
const HISTORY_DIR = '.history';
const SNAPSHOT_INTERVAL_MS = 3 * 60 * 1000;
const MAX_VERSIONS_PER_FILE = 30;
const MAX_CHAT_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_DEPTH = 12;

interface ProjectFileMeta {
  name: string;
  language: string;
  isEntry?: boolean;
}

interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  files: ProjectFileMeta[];
}

interface IncomingFile {
  name: string;
  language?: string;
  /** Omitted: unchanged since the last save */
  content?: string;
  isEntry?: boolean;
}

function ensureDir() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  // Programs run in their project folder: without this file Node would take "type": "module" from the studio's
  // own package.json and break require() in every project's .js files (a project's own package.json still wins)
  const marker = path.join(PROJECTS_DIR, 'package.json');
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, JSON.stringify({ private: true, type: 'commonjs', description: 'ScriptCraft Studio projects' }, null, 2) + '\n');
  }
}

function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id);
}

function projectDir(id: string): string {
  if (!isValidId(id)) throw new HttpError(400, 'Invalid project id');
  return path.join(PROJECTS_DIR, id);
}

/**
 * Reduce a user-supplied relative path ("src/utils/a.py") to a safe path inside the project folder.
 * Each segment is cleaned; "..", "." and empty segments are rejected so nothing can escape the folder.
 */
function safeFilePath(name: unknown): string {
  const segments = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '');
  if (segments.length === 0 || segments.length > MAX_DEPTH) {
    throw new HttpError(400, `Invalid file name: ${String(name)}`);
  }
  const cleaned = segments.map((seg) => {
    const c = seg.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 120);
    if (!c || c === '.' || c === '..') throw new HttpError(400, `Invalid file name: ${String(name)}`);
    return c;
  });
  const rel = cleaned.join('/');
  if (rel === META_FILE || rel === CHAT_FILE || RESERVED_DIRS.has(cleaned[0].toLowerCase())) {
    throw new HttpError(400, `Invalid file name: ${String(name)}`);
  }
  return rel;
}

/** Remove now-empty folders between a deleted file and the project root. */
function pruneEmptyDirs(dir: string, fromFile: string) {
  let current = path.dirname(fromFile);
  while (current.startsWith(dir + path.sep)) {
    try {
      if (fs.readdirSync(current).length > 0) break;
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

function slugify(name: string): string {
  const translit: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  const slug = name
    .toLowerCase()
    .split('')
    .map((c) => translit[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'project';
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function readMeta(id: string): ProjectMeta {
  const file = path.join(projectDir(id), META_FILE);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Project not found');
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeMeta(meta: ProjectMeta) {
  fs.writeFileSync(path.join(projectDir(meta.id), META_FILE), JSON.stringify(meta, null, 2), 'utf-8');
}

// ---------- sync with changes made on disk (terminal, other editors) ----------

/** Folders never picked up from disk: dependencies, caches, VCS data and the studio's own service folders. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.packages', '.history', '.idea', '.vscode', '.pytest_cache', '.mypy_cache']);
const LANG_BY_EXT: Record<string, string> = {
  py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', html: 'html', htm: 'html',
  css: 'css', sh: 'bash', bash: 'bash', sql: 'sql', json: 'json', md: 'markdown', markdown: 'markdown',
};

/** Files the studio itself just wrote: their watcher events are not "external" changes. */
// (an event counts as the studio's own only while the file still holds what the studio wrote: a change right
// after a save — git checkout, another editor — must still reach the open studio)
const recentWrites = new Map<string, { at: number; hash: string | null }>();
const hashOf = (content: string | Buffer) => crypto.createHash('sha1').update(content).digest('hex');
/** Remember a write (`content`) or a deletion (`null`) the studio is about to make. */
const markWritten = (absPath: string, content: string | null) => {
  const now = Date.now();
  for (const [k, v] of recentWrites) if (now - v.at > 5000) recentWrites.delete(k);
  recentWrites.set(path.resolve(absPath).toLowerCase(), { at: now, hash: content === null ? null : hashOf(content) });
};
const isOwnWrite = (absPath: string) => {
  const rec = recentWrites.get(path.resolve(absPath).toLowerCase());
  if (!rec || Date.now() - rec.at > 5000) return false;
  try {
    return rec.hash !== null && hashOf(fs.readFileSync(absPath)) === rec.hash;
  } catch {
    return rec.hash === null; // deleted, as the studio did
  }
};

// .env holds the run parameters (secrets): managed by the "Run parameters" dialog, never listed or sent to the AI
const isServiceFile = (rel: string) => rel === META_FILE || rel === CHAT_FILE || rel === ENV_FILE;
const skippedPath = (rel: string) => rel.split('/').some((seg) => SKIP_DIRS.has(seg)) || isServiceFile(rel);

/** Text files on disk that the project does not list yet (created in the terminal, copied in by hand...). */
function discoverUntracked(dir: string, known: Set<string>): ProjectFileMeta[] {
  const found: ProjectFileMeta[] = [];
  const walk = (abs: string, rel: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (skippedPath(r) || found.length + known.size >= MAX_FILES) continue;
      const p = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(p, r);
      else if (entry.isFile() && !known.has(r.toLowerCase())) {
        try {
          if (fs.statSync(p).size > MAX_FILE_BYTES) continue;
          const head = fs.readFileSync(p).subarray(0, 8000);
          if (head.includes(0)) continue; // binary
          const ext = entry.name.split('.').pop()?.toLowerCase() || '';
          found.push({ name: r, language: LANG_BY_EXT[ext] || 'text', isEntry: false });
        } catch {
          // unreadable file: skip
        }
      }
    }
  };
  walk(dir, '');
  return found;
}

/** Bring the file list in line with the disk: add new files, drop files deleted outside the studio. */
function rescanProject(id: string) {
  const meta = readMeta(id);
  const dir = projectDir(id);
  const existing = meta.files.filter((f) => fs.existsSync(path.join(dir, f.name)));
  const added = discoverUntracked(dir, new Set(existing.map((f) => f.name.toLowerCase())));
  if (added.length || existing.length !== meta.files.length) {
    meta.files = [...existing, ...added];
    writeMeta(meta);
  }
}

function loadProject(id: string) {
  const meta = readMeta(id);
  const dir = projectDir(id);
  // One read per file (no separate "exists?" check: each file access is costly on Windows with an antivirus)
  const files: (ProjectFileMeta & { content: string })[] = [];
  for (const f of meta.files) {
    if (isServiceFile(f.name)) continue;
    try {
      files.push({ ...f, content: fs.readFileSync(path.join(dir, f.name), 'utf-8') });
    } catch {
      // deleted outside the studio
    }
  }
  return { ...meta, files };
}

/** Write the given file list into the project folder, removing files that were dropped from the project. */
// ---------- file history: old versions are kept in .history/<encoded file path>/<timestamp>.txt ----------

/** One folder per file; the path is encoded into a single, Windows-safe folder name. */
function historyFolder(dir: string, name: string): string {
  const encoded = encodeURIComponent(name).replace(/\*/g, '%2A');
  return path.join(dir, HISTORY_DIR, encoded);
}

function listVersions(folder: string): number[] {
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .map((f) => Number(f.replace(/\.txt$/, '')))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a);
}

/** Store the previous content of a file, at most once per SNAPSHOT_INTERVAL_MS unless forced. */
function snapshot(dir: string, name: string, oldContent: string, force: boolean) {
  const folder = historyFolder(dir, name);
  const versions = listVersions(folder);
  const now = Date.now();
  if (!force && versions.length > 0 && now - versions[0] < SNAPSHOT_INTERVAL_MS) return;
  // Don't store the same content twice in a row
  if (versions.length > 0) {
    try {
      if (fs.readFileSync(path.join(folder, `${versions[0]}.txt`), 'utf-8') === oldContent) return;
    } catch {
      // unreadable: just write a new one
    }
  }
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${now}.txt`), oldContent, 'utf-8');
  for (const old of versions.slice(MAX_VERSIONS_PER_FILE - 1)) {
    fs.rmSync(path.join(folder, `${old}.txt`), { force: true });
  }
}

function saveFiles(meta: ProjectMeta, incoming: unknown, forceSnapshot = false): ProjectFileMeta[] {
  if (!Array.isArray(incoming)) throw new HttpError(400, 'files must be an array');
  if (incoming.length > MAX_FILES) throw new HttpError(400, `Too many files (max ${MAX_FILES})`);
  const dir = projectDir(meta.id);
  const seen = new Set<string>();
  const result: ProjectFileMeta[] = [];

  for (const raw of incoming as IncomingFile[]) {
    // A .env listed by an older version of the studio: it belongs to the run parameters now
    if (raw?.name === ENV_FILE) continue;
    const name = safeFilePath(raw?.name);
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new HttpError(400, `Duplicate file name: ${name}`);
    seen.add(lower);
    const target = path.join(dir, name);
    const entry = { name, language: String(raw.language || 'javascript'), isEntry: !!raw.isEntry };
    // No content: the studio saved this file before and it did not change since — keep it as it is on disk
    // (big projects: an autosave sends only the edited files). Gone from the disk meanwhile: drop it.
    if (raw.content === undefined) {
      if (fs.existsSync(target)) result.push(entry);
      continue;
    }
    const content = typeof raw.content === 'string' ? raw.content : '';
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) throw new HttpError(400, `File too large: ${name}`);
    if (fs.existsSync(target)) {
      const previous = fs.readFileSync(target, 'utf-8');
      if (previous === content) {
        // Unchanged: no write (no disk churn, no "changed on disk" event, file time stays)
        result.push(entry);
        continue;
      }
      snapshot(dir, name, previous, forceSnapshot);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    markWritten(target, content);
    fs.writeFileSync(target, content, 'utf-8');
    result.push(entry);
  }

  // Only delete files this project tracked before — never arbitrary files the user put in the folder
  for (const old of meta.files) {
    if (!seen.has(old.name.toLowerCase()) && !isServiceFile(old.name)) {
      const p = path.join(dir, old.name);
      if (fs.existsSync(p)) {
        // A deleted file can always be restored from history
        snapshot(dir, old.name, fs.readFileSync(p, 'utf-8'), true);
        markWritten(p, null);
        fs.unlinkSync(p);
        pruneEmptyDirs(dir, p);
      }
    }
  }
  return result;
}

export const projectsRouter = Router();

const wrap =
  (fn: (req: any, res: any) => unknown) =>
  (req: any, res: any) => {
    try {
      const out = fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('Projects API error:', err);
      res.status(status).json({ error: err.message || 'Projects API error' });
    }
  };

// List projects
projectsRouter.get(
  '/',
  wrap(() => {
    ensureDir();
    const list = fs
      .readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidId(d.name) && fs.existsSync(path.join(PROJECTS_DIR, d.name, META_FILE)))
      .map((d) => {
        const meta = readMeta(d.name);
        return { id: meta.id, name: meta.name, createdAt: meta.createdAt, updatedAt: meta.updatedAt, fileCount: meta.files.length };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { projects: list };
  })
);

// Create project
projectsRouter.post(
  '/',
  wrap((req) => {
    ensureDir();
    const name = String(req.body?.name || '').trim().slice(0, 100) || 'Project';
    let id = slugify(name);
    while (fs.existsSync(path.join(PROJECTS_DIR, id))) {
      id = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
    }
    fs.mkdirSync(projectDir(id));
    const now = Date.now();
    const meta: ProjectMeta = { id, name, createdAt: now, updatedAt: now, files: [] };
    try {
      meta.files = saveFiles(meta, req.body?.files || []);
    } catch (err) {
      fs.rmSync(projectDir(id), { recursive: true, force: true });
      throw err;
    }
    writeMeta(meta);
    return loadProject(id);
  })
);

// Get project with file contents
projectsRouter.get(
  '/:id',
  wrap((req) => {
    if (req.query.rescan === '1') rescanProject(req.params.id);
    return loadProject(req.params.id);
  })
);

// ---------- other files: images, SQLite databases, sound, video... (the files a program creates) ----------
const ASSET_KINDS: Record<string, { kind: 'image' | 'sqlite' | 'audio' | 'video' | 'binary' | 'other'; type: string }> = {
  png: { kind: 'image', type: 'image/png' },
  jpg: { kind: 'image', type: 'image/jpeg' },
  jpeg: { kind: 'image', type: 'image/jpeg' },
  gif: { kind: 'image', type: 'image/gif' },
  webp: { kind: 'image', type: 'image/webp' },
  bmp: { kind: 'image', type: 'image/bmp' },
  ico: { kind: 'image', type: 'image/x-icon' },
  svg: { kind: 'image', type: 'image/svg+xml' },
  db: { kind: 'sqlite', type: 'application/octet-stream' },
  sqlite: { kind: 'sqlite', type: 'application/octet-stream' },
  sqlite3: { kind: 'sqlite', type: 'application/octet-stream' },
  mp3: { kind: 'audio', type: 'audio/mpeg' },
  wav: { kind: 'audio', type: 'audio/wav' },
  ogg: { kind: 'audio', type: 'audio/ogg' },
  mp4: { kind: 'video', type: 'video/mp4' },
  webm: { kind: 'video', type: 'video/webm' },
  // Binaries: inspected and patched in the "Disassembler" (PE/ELF/Mach-O, object files, firmware images)
  exe: { kind: 'binary', type: 'application/octet-stream' },
  dll: { kind: 'binary', type: 'application/octet-stream' },
  sys: { kind: 'binary', type: 'application/octet-stream' },
  ocx: { kind: 'binary', type: 'application/octet-stream' },
  pyd: { kind: 'binary', type: 'application/octet-stream' },
  so: { kind: 'binary', type: 'application/octet-stream' },
  dylib: { kind: 'binary', type: 'application/octet-stream' },
  o: { kind: 'binary', type: 'application/octet-stream' },
  obj: { kind: 'binary', type: 'application/octet-stream' },
  bin: { kind: 'binary', type: 'application/octet-stream' },
};
const ASSET_SKIP = new Set([...SKIP_DIRS, 'dist', 'build']);

/** Files of the project folder that are not in the (text) file list. */
function listAssets(id: string) {
  const dir = projectDir(id);
  const known = new Set(readMeta(id).files.map((f) => f.name.toLowerCase()));
  const out: { name: string; size: number; kind: string; mtime: number }[] = [];
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.') || ASSET_SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile() && !known.has(r.toLowerCase()) && out.length < 500) {
        const ext = e.name.split('.').pop()?.toLowerCase() || '';
        const kind = ASSET_KINDS[ext]?.kind;
        const st = fs.statSync(p);
        // Text files not yet in the list appear after a rescan; show only real "other" files here
        if (!kind) {
          if (st.size <= MAX_FILE_BYTES) {
            try {
              if (!fs.readFileSync(p).subarray(0, 8000).includes(0)) continue;
            } catch {
              continue;
            }
          }
        }
        out.push({ name: r, size: st.size, kind: kind || 'other', mtime: st.mtimeMs });
      }
    }
  };
  walk(dir, '');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

projectsRouter.get(
  '/:id/assets',
  wrap((req) => ({ assets: listAssets(req.params.id) }))
);

/**
 * Put a binary file from the PC (an .exe to disassemble, a picture, a database...) into the project folder
 * as it is. Text files go through the normal file list instead. An existing file is never overwritten:
 * the new one gets a free name ("tool (2).exe").
 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
projectsRouter.put('/:id/upload', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), (req, res) => {
  try {
    const meta = readMeta(req.params.id);
    const dir = projectDir(req.params.id);
    const name = safeFilePath(req.query.path);
    if (name.split('/').some((s) => s.startsWith('.')) || isServiceFile(name) || skippedPath(name)) throw new HttpError(400, 'Invalid file name');
    const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) throw new HttpError(400, 'Empty file');
    const taken = (n: string) => fs.existsSync(path.join(dir, n)) || meta.files.some((f) => f.name.toLowerCase() === n.toLowerCase());
    let final = name;
    for (let i = 2; taken(final); i++) {
      const slash = name.lastIndexOf('/') + 1;
      const dot = name.lastIndexOf('.');
      final = dot > slash ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
    }
    const abs = path.join(dir, final);
    if (!path.resolve(abs).startsWith(path.resolve(dir) + path.sep)) throw new HttpError(400, 'Invalid file name');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    res.json({ name: final, size: body.length });
  } catch (err: any) {
    const status = err instanceof HttpError ? err.status : err?.type === 'entity.too.large' ? 413 : 500;
    if (status === 500) console.error('Upload error:', err);
    res.status(status).json({ error: err.message || 'Upload failed' });
  }
});

/** A project file as it is on disk (for the image / database viewers). */
projectsRouter.get('/:id/raw', (req, res) => {
  try {
    readMeta(req.params.id);
    const rel = String(req.query.path || '').replace(/\\/g, '/');
    if (!rel || rel.split('/').some((s) => !s || s === '..' || s.startsWith('.'))) throw new HttpError(400, 'Invalid path');
    const dir = projectDir(req.params.id);
    const abs = path.join(dir, rel);
    if (!path.resolve(abs).startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new HttpError(404, 'File not found');
    }
    const ext = rel.split('.').pop()?.toLowerCase() || '';
    res.setHeader('Content-Type', ASSET_KINDS[ext]?.type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    // Served from the studio's own address: nothing in the file (an SVG, an HTML page...) may run scripts here
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'self'; sandbox");
    if (!ASSET_KINDS[ext]) res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(rel))}"`);
    fs.createReadStream(abs).pipe(res);
  } catch (err) {
    wrap(() => {
      throw err;
    })(req, res);
  }
});

// Run parameters: environment variables (.env) and command-line arguments
projectsRouter.get(
  '/:id/run-config',
  wrap((req) => {
    readMeta(req.params.id);
    return { args: readRunArgs(req.params.id), env: readProjectEnv(req.params.id) };
  })
);

projectsRouter.put(
  '/:id/run-config',
  wrap((req) => {
    const meta = readMeta(req.params.id) as ProjectMeta & { runArgs?: string };
    const args = String(req.body?.args ?? '').trim();
    if (args.length > 2000) throw new HttpError(400, 'Arguments are too long');
    if (/[\r\n]/.test(args) || splitArgs(args).some((a) => BAD_ARG_CHARS.test(a))) throw new HttpError(400, 'Arguments cannot contain " % ^ ! or line breaks');
    const env = Array.isArray(req.body?.env) ? req.body.env : [];
    if (env.length > 200) throw new HttpError(400, 'Too many variables');
    const vars: { key: string; value: string }[] = [];
    for (const v of env) {
      const key = String(v?.key ?? '').trim();
      const value = String(v?.value ?? '');
      if (!key && !value) continue;
      if (!ENV_KEY.test(key)) throw new HttpError(400, `Invalid variable name: ${key || '(empty)'}`);
      if (value.length > 10000) throw new HttpError(400, `Value of ${key} is too long`);
      vars.push({ key, value });
    }
    const dir = projectDir(req.params.id);
    const envPath = path.join(dir, ENV_FILE);
    if (vars.length) fs.writeFileSync(envPath, formatEnv(vars), 'utf-8');
    else fs.rmSync(envPath, { force: true });
    meta.runArgs = args;
    writeMeta(meta);
    return { args, env: vars };
  })
);

// Server-Sent Events: "files changed on disk" (not by the studio itself), debounced
projectsRouter.get('/:id/watch', (req, res) => {
  let dir: string;
  try {
    readMeta(req.params.id);
    dir = projectDir(req.params.id);
  } catch {
    return res.status(404).json({ error: 'Project not found' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const changed = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename).replace(/\\/g, '/');
      if (skippedPath(rel) || isOwnWrite(path.join(dir, rel))) return;
      changed.add(rel);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        res.write(`data: ${JSON.stringify({ changed: [...changed] })}\n\n`);
        changed.clear();
      }, 400);
    });
  } catch {
    res.write(`data: ${JSON.stringify({ unsupported: true })}\n\n`);
    return res.end();
  }
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  const id = req.params.id;
  const stop = () => {
    clearInterval(keepAlive);
    if (timer) clearTimeout(timer);
    watcher.close();
    watchers.get(id)?.delete(stop);
  };
  if (!watchers.has(id)) watchers.set(id, new Set());
  watchers.get(id)!.add(stop);
  req.on('close', stop);
});

/** Open folder watchers per project: Windows cannot move a folder while it is watched. */
const watchers = new Map<string, Set<() => void>>();
function closeWatchers(id: string) {
  for (const stop of [...(watchers.get(id) || [])]) stop();
}

// Save project (files and/or name)
projectsRouter.put(
  '/:id',
  wrap((req) => {
    const meta = readMeta(req.params.id);
    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      meta.name = req.body.name.trim().slice(0, 100);
    }
    if (req.body?.files !== undefined) {
      meta.files = saveFiles(meta, req.body.files, req.body?.snapshot === true);
    }
    meta.updatedAt = Date.now();
    writeMeta(meta);
    return { ok: true, updatedAt: meta.updatedAt, name: meta.name };
  })
);

// Delete project folder
// Delete project: it goes to the trash (projects/.trash) and can be restored for TRASH_DAYS days
projectsRouter.delete('/:id', async (req, res) => {
  try {
    const meta = readMeta(req.params.id); // 404 if it is not a project folder
    await closeProjectTerminals(req.params.id);
    stopProjectKernels(req.params.id); // a notebook kernel would otherwise hold the folder open
    await stopProjectRuns(req.params.id); // so would a running program, debugger, tests or build
    closeWatchers(req.params.id);
    const trashId = `${meta.id}~${Date.now()}`;
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    await moveDir(projectDir(req.params.id), path.join(TRASH_DIR, trashId));
    fs.writeFileSync(path.join(TRASH_DIR, trashId, DELETED_FILE), JSON.stringify({ deletedAt: Date.now() }));
    res.json({ ok: true, trashId });
  } catch (err) {
    wrap(() => {
      throw err;
    })(req, res);
  }
});

// ---------- trash ----------
const TRASH_DIR = path.join(PROJECTS_DIR, '.trash');
const TRASH_DAYS = 30;
const DELETED_FILE = '.deleted.json';
const isTrashId = (t: string) => /^[a-zA-Z0-9_-]{1,80}~\d{10,16}$/.test(t);

/** Move a folder; a just-closed shell or an antivirus scan may hold it for a moment, so retry, then copy. */
async function moveDir(from: string, to: string) {
  for (let i = 0; i < 15; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err: any) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  fs.cpSync(from, to, { recursive: true });
  fs.rmSync(from, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function trashEntries() {
  if (!fs.existsSync(TRASH_DIR)) return [];
  const out: { trashId: string; id: string; name: string; deletedAt: number; fileCount: number }[] = [];
  for (const d of fs.readdirSync(TRASH_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || !isTrashId(d.name)) continue;
    const dir = path.join(TRASH_DIR, d.name);
    try {
      const meta: ProjectMeta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf-8'));
      let deletedAt = Number(d.name.split('~')[1]);
      try {
        deletedAt = JSON.parse(fs.readFileSync(path.join(dir, DELETED_FILE), 'utf-8')).deletedAt || deletedAt;
      } catch {
        // the time from the folder name
      }
      out.push({ trashId: d.name, id: meta.id, name: meta.name, deletedAt, fileCount: meta.files.length });
    } catch {
      // not a project folder
    }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Projects deleted more than TRASH_DAYS days ago are removed for good. */
export function purgeOldTrash() {
  const limit = Date.now() - TRASH_DAYS * 24 * 3600 * 1000;
  for (const e of trashEntries()) {
    if (e.deletedAt < limit) fs.rmSync(path.join(TRASH_DIR, e.trashId), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export const trashRouter = Router();

trashRouter.get(
  '/',
  wrap(() => {
    try {
      purgeOldTrash();
    } catch {
      // a locked folder is removed next time
    }
    return { projects: trashEntries(), days: TRASH_DAYS };
  })
);

trashRouter.post('/:trashId/restore', async (req, res) => {
  try {
    const trashId = String(req.params.trashId);
    if (!isTrashId(trashId)) throw new HttpError(400, 'Invalid trash id');
    const from = path.join(TRASH_DIR, trashId);
    if (!fs.existsSync(path.join(from, META_FILE))) throw new HttpError(404, 'Not in the trash');
    ensureDir();
    const meta: ProjectMeta = JSON.parse(fs.readFileSync(path.join(from, META_FILE), 'utf-8'));
    // The id may have been taken by a new project in the meantime
    let id = isValidId(meta.id) ? meta.id : slugify(meta.name);
    while (fs.existsSync(path.join(PROJECTS_DIR, id))) id = `${meta.id.slice(0, 70)}-${Math.random().toString(36).slice(2, 6)}`;
    await moveDir(from, path.join(PROJECTS_DIR, id));
    fs.rmSync(path.join(PROJECTS_DIR, id, DELETED_FILE), { force: true });
    if (id !== meta.id) {
      meta.id = id;
      writeMeta(meta);
    }
    res.json({ id, name: meta.name });
  } catch (err) {
    wrap(() => {
      throw err;
    })(req, res);
  }
});

trashRouter.delete(
  '/:trashId',
  wrap((req) => {
    const trashId = String(req.params.trashId);
    if (!isTrashId(trashId)) throw new HttpError(400, 'Invalid trash id');
    const dir = path.join(TRASH_DIR, trashId);
    if (!fs.existsSync(dir)) throw new HttpError(404, 'Not in the trash');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return { ok: true };
  })
);

trashRouter.delete(
  '/',
  wrap(() => {
    for (const e of trashEntries()) fs.rmSync(path.join(TRASH_DIR, e.trashId), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return { ok: true };
  })
);

// Open project folder in the OS file manager (this is a local desktop app)
projectsRouter.post(
  '/:id/open-folder',
  wrap((req) => {
    readMeta(req.params.id);
    const dir = projectDir(req.params.id);
    const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, path: dir };
  })
);

// AI chat history of a project (kept next to the project files)
projectsRouter.get(
  '/:id/chat',
  wrap((req) => {
    readMeta(req.params.id);
    const file = path.join(projectDir(req.params.id), CHAT_FILE);
    if (!fs.existsSync(file)) return { messages: [] };
    try {
      return { messages: JSON.parse(fs.readFileSync(file, 'utf-8')).messages || [] };
    } catch {
      return { messages: [] };
    }
  })
);

projectsRouter.put(
  '/:id/chat',
  wrap((req) => {
    readMeta(req.params.id);
    const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-200) : [];
    const json = JSON.stringify({ messages }, null, 1);
    if (Buffer.byteLength(json, 'utf-8') > MAX_CHAT_BYTES) throw new HttpError(400, 'Chat history is too large');
    fs.writeFileSync(path.join(projectDir(req.params.id), CHAT_FILE), json, 'utf-8');
    return { ok: true };
  })
);

// ---------- file history API ----------

// All files that have saved versions (including deleted ones)
projectsRouter.get(
  '/:id/history',
  wrap((req) => {
    const meta = readMeta(req.params.id);
    const root = path.join(projectDir(req.params.id), HISTORY_DIR);
    if (!fs.existsSync(root)) return { files: [] };
    const current = new Set(meta.files.map((f) => f.name));
    const files = fs
      .readdirSync(root)
      .map((enc) => {
        let name = '';
        try {
          name = decodeURIComponent(enc);
        } catch {
          return null;
        }
        const versions = listVersions(path.join(root, enc));
        if (versions.length === 0) return null;
        return { name, versions: versions.length, latest: versions[0], deleted: !current.has(name) };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => b.latest - a.latest);
    return { files };
  })
);

projectsRouter.get(
  '/:id/history/file',
  wrap((req) => {
    readMeta(req.params.id);
    const name = safeFilePath(req.query.name);
    const folder = historyFolder(projectDir(req.params.id), name);
    return {
      versions: listVersions(folder).map((ts) => ({ ts, size: fs.statSync(path.join(folder, `${ts}.txt`)).size })),
    };
  })
);

projectsRouter.get(
  '/:id/history/version',
  wrap((req) => {
    readMeta(req.params.id);
    const name = safeFilePath(req.query.name);
    const ts = Number(req.query.ts);
    if (!Number.isFinite(ts) || ts <= 0) throw new HttpError(400, 'Invalid version');
    const file = path.join(historyFolder(projectDir(req.params.id), name), `${ts}.txt`);
    if (!fs.existsSync(file)) throw new HttpError(404, 'Version not found');
    return { content: fs.readFileSync(file, 'utf-8') };
  })
);
