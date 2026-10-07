import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { projectPackagesDir, spawnCommand, startSession } from './run.ts';

// Packages are installed per project into projects/<id>/.packages/{python,node},
// never into the system Python / global npm, and are attached automatically when code runs.

type Manager = 'pip' | 'npm';

const isWin = process.platform === 'win32';
const PIP_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?((==|>=|<=|~=|!=|>|<)[A-Za-z0-9.*+!_-]+)?$/;
const NPM_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9.^~*_-]+)?$/;
const MAX_PACKAGES = 30;

function dirs(projectId: string) {
  const base = projectPackagesDir(projectId);
  if (!base || !fs.existsSync(path.join(process.cwd(), 'projects', projectId))) {
    throw Object.assign(new Error('Project not found'), { status: 404 });
  }
  return { base, python: path.join(base, 'python'), node: path.join(base, 'node') };
}

/** Validate package specs strictly: commands run through a shell on Windows. */
function validSpecs(manager: Manager, raw: unknown): string[] {
  const list = (Array.isArray(raw) ? raw : []).map((p) => String(p).trim()).filter(Boolean);
  if (list.length === 0) throw Object.assign(new Error('No packages given'), { status: 400 });
  if (list.length > MAX_PACKAGES) throw Object.assign(new Error(`Too many packages (max ${MAX_PACKAGES})`), { status: 400 });
  const re = manager === 'pip' ? PIP_SPEC : NPM_SPEC;
  const bad = list.filter((p) => !re.test(p));
  if (bad.length) throw Object.assign(new Error(`Invalid package name: ${bad.join(', ')}`), { status: 400 });
  return list;
}

const normalize = (n: string) => n.toLowerCase().replace(/[-_.]+/g, '-');

function listPython(pyDir: string) {
  if (!fs.existsSync(pyDir)) return [];
  return fs
    .readdirSync(pyDir)
    .filter((d) => d.endsWith('.dist-info'))
    .map((d) => {
      let name = d.replace(/-[^-]+\.dist-info$/, '');
      let version = d.replace(/\.dist-info$/, '').split('-').pop() || '';
      try {
        const meta = fs.readFileSync(path.join(pyDir, d, 'METADATA'), 'utf-8');
        name = meta.match(/^Name:\s*(.+)$/m)?.[1].trim() || name;
        version = meta.match(/^Version:\s*(.+)$/m)?.[1].trim() || version;
      } catch {
        // keep names from the folder
      }
      return { name, version };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listNode(nodeDir: string) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(nodeDir, 'package.json'), 'utf-8'));
    return Object.keys(pkg.dependencies || {})
      .map((name) => {
        let version = String(pkg.dependencies[name]);
        try {
          version = JSON.parse(fs.readFileSync(path.join(nodeDir, 'node_modules', name, 'package.json'), 'utf-8')).version;
        } catch {
          // not installed yet
        }
        return { name, version };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** pip has no "uninstall --target": remove the files listed in the package's RECORD. */
function uninstallPython(pyDir: string, name: string): boolean {
  const info = fs
    .readdirSync(pyDir)
    .find((d) => d.endsWith('.dist-info') && normalize(d.replace(/-[^-]+\.dist-info$/, '')) === normalize(name));
  if (!info) return false;
  const root = path.resolve(pyDir);
  try {
    const record = fs.readFileSync(path.join(pyDir, info, 'RECORD'), 'utf-8');
    for (const line of record.split('\n')) {
      const rel = line.split(',')[0]?.trim();
      if (!rel) continue;
      const target = path.resolve(pyDir, rel);
      if (!target.startsWith(root + path.sep)) continue; // never touch anything outside the packages folder
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // already gone
      }
    }
  } catch {
    // no RECORD: remove at least the metadata below
  }
  fs.rmSync(path.join(pyDir, info), { recursive: true, force: true });
  // Drop folders the package left empty (e.g. requests/__pycache__)
  for (const d of fs.readdirSync(pyDir)) {
    const p = path.join(pyDir, d);
    try {
      if (fs.statSync(p).isDirectory()) removeEmptyDirs(p);
    } catch {
      // ignore
    }
  }
  return true;
}

function removeEmptyDirs(dir: string): boolean {
  let empty = true;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() && removeEmptyDirs(p)) continue;
    empty = false;
  }
  if (empty) fs.rmdirSync(dir);
  return empty;
}

export const packagesRouter = Router({ mergeParams: true });

const handle =
  (fn: (req: any, res: any) => unknown) =>
  (req: any, res: any) => {
    try {
      const out = fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || 'Packages error' });
    }
  };

packagesRouter.get(
  '/',
  handle((req) => {
    const d = dirs(req.params.id);
    return { python: listPython(d.python), node: listNode(d.node) };
  })
);

packagesRouter.post(
  '/install',
  handle((req) => {
    const manager: Manager = req.body?.manager === 'npm' ? 'npm' : 'pip';
    const specs = validSpecs(manager, req.body?.packages);
    const d = dirs(req.params.id);
    let proc;
    if (manager === 'pip') {
      fs.mkdirSync(d.python, { recursive: true });
      proc = spawnCommand(
        isWin ? 'python' : 'python3',
        ['-m', 'pip', 'install', '--target', d.python, '--upgrade', '--disable-pip-version-check', '--no-input', ...specs],
        d.base
      );
    } else {
      fs.mkdirSync(d.node, { recursive: true });
      if (!fs.existsSync(path.join(d.node, 'package.json'))) {
        fs.writeFileSync(path.join(d.node, 'package.json'), JSON.stringify({ name: 'project-packages', private: true }, null, 2));
      }
      proc = spawnCommand('npm', ['install', '--prefix', d.node, '--no-audit', '--no-fund', ...specs], d.node);
    }
    proc.stdin?.end();
    return { runId: startSession(proc, undefined, 15 * 60 * 1000) };
  })
);

packagesRouter.post(
  '/uninstall',
  handle((req) => {
    const manager: Manager = req.body?.manager === 'npm' ? 'npm' : 'pip';
    const [name] = validSpecs(manager, [req.body?.name]);
    const d = dirs(req.params.id);
    if (manager === 'pip') {
      if (!fs.existsSync(d.python) || !uninstallPython(d.python, name)) {
        throw Object.assign(new Error(`Package "${name}" is not installed`), { status: 404 });
      }
      return { ok: true };
    }
    const proc = spawnCommand('npm', ['uninstall', '--prefix', d.node, '--no-audit', '--no-fund', name], d.node);
    proc.stdin?.end();
    return { runId: startSession(proc) };
  })
);
