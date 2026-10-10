import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import JSZip from 'jszip';
import { readSettings, writeSettings } from './settings.ts';

// Automatic backups: once a day (checked at start and every hour) all projects are zipped into a folder outside
// the studio (Documents\ScriptCraft Studio Backups by default), keeping the newest N. Any project of any backup
// can be restored as a new project next to the current ones.

/** Not worth backing up: installed packages, the trash, build outputs and caches */
const SKIP_DIRS = new Set(['.packages', 'node_modules', '__pycache__', 'dist', 'build', '.pytest_cache', '.mypy_cache', '.venv', 'venv']);
const FILE_RE = /^scriptcraft-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/;
const DAY = 24 * 3600 * 1000;
const PROJECTS_DIR = () => path.join(process.cwd(), 'projects');

let documentsDir: string | null = null;
function defaultDir(): string {
  if (!documentsDir) {
    let docs = '';
    if (process.platform === 'win32') {
      // The real Documents folder (it may be moved, e.g. to OneDrive)
      const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('MyDocuments')"], { encoding: 'utf-8', windowsHide: true, timeout: 10_000 });
      docs = r.status === 0 ? r.stdout.trim() : '';
    }
    if (!docs || !fs.existsSync(docs)) docs = path.join(os.homedir(), 'Documents');
    documentsDir = path.join(docs, 'ScriptCraft Studio Backups');
  }
  return documentsDir;
}

export function backupDir(): string {
  const dir = readSettings().backups.dir;
  return dir && path.isAbsolute(dir) ? dir : defaultDir();
}

export function listBackups() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, size: st.size, createdAt: st.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

let running: Promise<{ file: string; projects: number }> | null = null;
/** Files bigger than this go into the archive as streams */
const STREAM_FROM = 8 * 1024 * 1024;

/** Zip every project now (one backup at a time) and drop the oldest beyond the limit. */
export function createBackup(): Promise<{ file: string; projects: number }> {
  if (running) return running;
  running = (async () => {
    const root = PROJECTS_DIR();
    const zip = new JSZip();
    const manifest: { id: string; name: string }[] = [];
    if (fs.existsSync(root)) {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue; // .trash
        const metaFile = path.join(root, d.name, '.scriptcraft.json');
        if (!fs.existsSync(metaFile)) continue;
        try {
          manifest.push({ id: d.name, name: JSON.parse(fs.readFileSync(metaFile, 'utf-8')).name || d.name });
        } catch {
          manifest.push({ id: d.name, name: d.name });
        }
        const walk = (abs: string, rel: string) => {
          for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
            if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
            const p = path.join(abs, e.name);
            const r = `${rel}/${e.name}`;
            if (e.isDirectory()) walk(p, r);
            else if (e.isFile()) {
              try {
                const st = fs.statSync(p);
                // Big files (uploaded programs, videos) are read while the archive is written, not all at once
                zip.file(r, st.size > STREAM_FROM ? fs.createReadStream(p) : fs.readFileSync(p), { date: st.mtime });
              } catch {
                // a file locked right now: the next backup gets it
              }
            }
          }
        };
        walk(path.join(root, d.name), `projects/${d.name}`);
      }
    }
    zip.file('backup.json', JSON.stringify({ app: 'ScriptCraft Studio', createdAt: new Date().toISOString(), projects: manifest }, null, 2));
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    let file = `scriptcraft-backup-${stamp()}.zip`;
    // Names have one-second precision: never overwrite a backup made in the same second
    while (fs.existsSync(path.join(dir, file))) {
      await new Promise((r) => setTimeout(r, 1100));
      file = `scriptcraft-backup-${stamp()}.zip`;
    }
    const tmp = path.join(dir, `${file}.part`);
    try {
      await new Promise<void>((resolve, reject) => {
        // Errors of both ends are handled: a failing archive must not crash the studio from the scheduler
        const source = zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const target = fs.createWriteStream(tmp);
        source.on('error', (e: Error) => {
          target.destroy();
          reject(e);
        });
        target.on('error', reject).on('finish', () => resolve());
        source.pipe(target);
      });
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    fs.renameSync(tmp, path.join(dir, file));
    // Keep the newest N
    const keep = readSettings().backups.keep;
    for (const old of listBackups().slice(keep)) fs.rmSync(path.join(dir, old.file), { force: true });
    return { file, projects: manifest.length };
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Daily backups while the studio runs (started by the server only, never by tests). */
export function startBackupScheduler() {
  const check = async () => {
    const s = readSettings().backups;
    if (!s.enabled) return;
    const last = listBackups()[0];
    if (last && Date.now() - last.createdAt < DAY) return;
    try {
      const r = await createBackup();
      console.log(`[backup] ${r.projects} projects -> ${path.join(backupDir(), r.file)}`);
    } catch (err: any) {
      console.error('[backup] failed:', err?.message || err);
    }
  };
  setTimeout(check, 60_000).unref(); // a minute after start: the studio opens first
  setInterval(check, 3600_000).unref();
}

function backupPath(file: unknown): string {
  if (typeof file !== 'string' || !FILE_RE.test(file)) throw Object.assign(new Error('Invalid backup name'), { status: 400 });
  const p = path.join(backupDir(), file);
  if (!fs.existsSync(p)) throw Object.assign(new Error('Backup not found'), { status: 404 });
  return p;
}

async function loadZip(file: unknown) {
  const zip = await JSZip.loadAsync(fs.readFileSync(backupPath(file)));
  let projects: { id: string; name: string }[] = [];
  try {
    projects = JSON.parse(await zip.file('backup.json')!.async('string')).projects || [];
  } catch {
    // no manifest
  }
  return { zip, projects: projects.filter((p) => /^[a-zA-Z0-9_-]{1,80}$/.test(p.id)) };
}

const wrap =
  (fn: (req: any) => unknown) =>
  async (req: any, res: any) => {
    try {
      res.json(await fn(req));
    } catch (err: any) {
      const status = err?.status || 500;
      if (status === 500) console.error('Backups error:', err);
      res.status(status).json({ error: err?.message || 'Backup error' });
    }
  };

export const backupsRouter = Router();

backupsRouter.get(
  '/',
  wrap(() => ({ ...readSettings().backups, dir: backupDir(), customDir: !!readSettings().backups.dir, backups: listBackups(), running: !!running }))
);

backupsRouter.put(
  '/settings',
  wrap((req) => {
    const s = readSettings();
    const b = req.body || {};
    const keep = Number(b.keep ?? s.backups.keep);
    if (!Number.isInteger(keep) || keep < 1 || keep > 60) throw Object.assign(new Error('Keep 1-60 backups'), { status: 400 });
    const dir = typeof b.dir === 'string' ? b.dir.trim() : s.backups.dir;
    if (dir && (!path.isAbsolute(dir) || dir.length > 400)) throw Object.assign(new Error('Use a full folder path, e.g. D:\\Backups'), { status: 400 });
    s.backups = { enabled: b.enabled === undefined ? s.backups.enabled : !!b.enabled, keep, dir };
    writeSettings(s);
    return { ...s.backups, dir: backupDir() };
  })
);

backupsRouter.post('/now', wrap(async () => createBackup()));

backupsRouter.post(
  '/open-folder',
  wrap(() => {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    spawn(process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, dir };
  })
);

/** Projects inside one backup. */
backupsRouter.get(
  '/:file/projects',
  wrap(async (req) => ({ projects: (await loadZip(req.params.file)).projects }))
);

/** Restore one project of a backup as a new project ("<name> (backup 06.10 18:30)"); nothing is overwritten. */
backupsRouter.post(
  '/:file/restore',
  wrap(async (req) => {
    const { zip, projects } = await loadZip(req.params.file);
    const src = projects.find((p) => p.id === req.body?.id);
    if (!src) throw Object.assign(new Error('Project not in this backup'), { status: 404 });
    const root = PROJECTS_DIR();
    let id = `${src.id.slice(0, 60)}-restored`;
    for (let n = 2; fs.existsSync(path.join(root, id)); n++) id = `${src.id.slice(0, 60)}-restored-${n}`;
    const target = path.join(root, id);
    const prefix = `projects/${src.id}/`;
    let count = 0;
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || !entry.name.startsWith(prefix)) continue;
      const rel = entry.name.slice(prefix.length);
      // Never write outside the new project folder
      if (!rel || rel.split('/').some((s) => s === '..' || s === '' || /[<>:"|?*\x00-\x1f]/.test(s))) continue;
      const dest = path.join(target, rel);
      if (!path.resolve(dest).startsWith(path.resolve(target) + path.sep)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, await entry.async('nodebuffer'));
      count++;
    }
    const metaFile = path.join(target, '.scriptcraft.json');
    if (!fs.existsSync(metaFile)) {
      fs.rmSync(target, { recursive: true, force: true });
      throw Object.assign(new Error('The backup copy of this project is damaged'), { status: 422 });
    }
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    const when = String(req.params.file).replace(/^scriptcraft-backup-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2}).*$/, '$3.$2 $4:$5');
    meta.id = id;
    meta.name = `${meta.name || src.name} (${when})`.slice(0, 100);
    meta.updatedAt = Date.now();
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    return { id, name: meta.name, files: count };
  })
);
