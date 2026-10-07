import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { projectPackagesDir, spawnCommand, startSession } from './run.ts';

// "Build .exe": a Python project becomes one Windows program (PyInstaller --onefile) in the project's dist folder.
// PyInstaller lives in the studio's tools folder (installed on request), shared by all projects.

const isWin = process.platform === 'win32';
const STUDIO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PYI_DIR = path.join(STUDIO_ROOT, 'tools', 'pyinstaller');
const python = () => (isWin ? 'python' : 'python3');
/** Not packed into the program: studio service files, outputs and caches */
const SKIP = new Set(['dist', 'build', '.packages', '.history', '.git', 'node_modules', '__pycache__', '.venv', 'venv', '.pytest_cache']);
const SKIP_FILES = new Set(['.scriptcraft.json', '.scriptcraft-chat.json', '.gitignore']);

class BuildError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function projectDir(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new BuildError(400, 'Invalid project id');
  const dir = path.join(process.cwd(), 'projects', id);
  if (!fs.existsSync(path.join(dir, '.scriptcraft.json'))) throw new BuildError(404, 'Project not found');
  return dir;
}

function pyEnv(projectId: string): NodeJS.ProcessEnv {
  const pkg = projectPackagesDir(projectId);
  const parts = [PYI_DIR, pkg ? path.join(pkg, 'python') : '', process.env.PYTHONPATH || ''].filter((p) => p && fs.existsSync(p));
  return { PYTHONPATH: parts.join(path.delimiter) };
}

let pyiCache: { ok: boolean; version: string | null; at: number } | null = null;
function pyinstallerInfo() {
  if (pyiCache && Date.now() - pyiCache.at < 15_000) return pyiCache;
  const r = spawnSync(python(), ['-c', 'import PyInstaller; print(PyInstaller.__version__)'], {
    env: { ...process.env, PYTHONPATH: [PYI_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 20_000,
  });
  pyiCache = { ok: r.status === 0, version: r.status === 0 ? r.stdout.trim() : null, at: Date.now() };
  return pyiCache;
}

function listBuilds(dir: string) {
  const dist = path.join(dir, 'dist');
  if (!fs.existsSync(dist)) return [];
  return fs
    .readdirSync(dist)
    .filter((f) => /\.exe$/i.test(f) || (!isWin && !f.includes('.')))
    .map((f) => {
      const st = fs.statSync(path.join(dist, f));
      return { name: f, path: `dist/${f}`, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** Project files the program may read at run time (templates, images, data...), as PyInstaller --add-data. */
function dataFiles(dir: string): { abs: string; destDir: string }[] {
  const out: { abs: string; destDir: string }[] = [];
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (SKIP.has(e.name) || (rel === '' && SKIP_FILES.has(e.name))) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile() && !/\.(py|pyc|pyw)$/i.test(e.name) && out.length < 500) out.push({ abs: p, destDir: rel || '.' });
    }
  };
  walk(dir, '');
  return out;
}

const wrap =
  (fn: (req: any) => unknown) =>
  async (req: any, res: any) => {
    try {
      res.json(await fn(req));
    } catch (err: any) {
      const status = err instanceof BuildError ? err.status : 500;
      if (status === 500) console.error('Build exe error:', err);
      res.status(status).json({ error: err.message || 'Build error' });
    }
  };

export const buildExeRouter = Router({ mergeParams: true });

buildExeRouter.get(
  '/',
  wrap((req) => {
    const dir = projectDir(req.params.id);
    const info = pyinstallerInfo();
    return { pyinstaller: info.ok, version: info.version, builds: listBuilds(dir), platform: process.platform };
  })
);

/** Install PyInstaller into the studio's tools folder (once for all projects). */
buildExeRouter.post(
  '/install',
  wrap(() => {
    fs.mkdirSync(PYI_DIR, { recursive: true });
    const proc = spawnCommand(python(), ['-m', 'pip', 'install', '--upgrade', '--target', PYI_DIR, 'pyinstaller', '--disable-pip-version-check', '--no-warn-script-location'], STUDIO_ROOT);
    pyiCache = null;
    return { runId: startSession(proc, () => (pyiCache = null), 10 * 60 * 1000) };
  })
);

buildExeRouter.post(
  '/build',
  wrap((req) => {
    const id = req.params.id;
    const dir = projectDir(id);
    const entry = String(req.body?.entry || '').replace(/\\/g, '/');
    if (!/\.pyw?$/i.test(entry) || entry.split('/').some((p) => p === '..' || p === '') || !fs.existsSync(path.join(dir, entry))) {
      throw new BuildError(400, 'Choose a .py file of the project');
    }
    const name = String(req.body?.name || path.basename(entry).replace(/\.pyw?$/i, '')).trim();
    if (!/^[\w\- .а-яА-ЯёЁ]{1,60}$/.test(name) || name.startsWith('.')) throw new BuildError(400, 'Invalid program name');
    if (!pyinstallerInfo().ok) throw new BuildError(409, 'PyInstaller is not installed');

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-exe-'));
    const args = [
      '-m',
      'PyInstaller',
      '--noconfirm',
      '--clean',
      '--onefile',
      '--name',
      name,
      '--distpath',
      path.join(dir, 'dist'),
      '--workpath',
      path.join(work, 'build'),
      '--specpath',
      work,
      '--paths',
      dir,
    ];
    if (req.body?.windowed) args.push('--windowed');
    // Files the program opens at run time travel inside the .exe (sys._MEIPASS keeps the same layout)
    if (req.body?.includeData !== false) {
      for (const f of dataFiles(dir)) args.push('--add-data', `${f.abs}${path.delimiter}${f.destDir}`);
    }
    const pkg = projectPackagesDir(id);
    if (pkg && fs.existsSync(path.join(pkg, 'python'))) args.push('--paths', path.join(pkg, 'python'));
    const icon = path.join(dir, 'icon.ico');
    if (isWin && fs.existsSync(icon)) args.push('--icon', icon);
    args.push(path.join(dir, entry));

    const proc = spawnCommand(python(), args, dir, pyEnv(id));
    const runId = startSession(proc, () => fs.rmSync(work, { recursive: true, force: true }), 20 * 60 * 1000);
    return { runId, exe: `dist/${name}${isWin ? '.exe' : ''}` };
  })
);

/** Show the built program in Explorer (this is a local desktop app). */
buildExeRouter.post(
  '/reveal',
  wrap((req) => {
    const dir = projectDir(req.params.id);
    const file = String(req.body?.path || '');
    const build = listBuilds(dir).find((b) => b.path === file);
    if (!build) throw new BuildError(404, 'Build not found');
    const abs = path.join(dir, build.path);
    if (isWin) spawn('explorer.exe', [`/select,${abs}`], { detached: true, stdio: 'ignore' }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [path.dirname(abs)], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  })
);
