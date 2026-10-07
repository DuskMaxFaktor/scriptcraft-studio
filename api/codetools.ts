import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { startSession, spawnCommand } from './run.ts';
import { hasJedi, resetJediCache } from './pyintel.ts';

// Code formatting and checks:
// - Python: Ruff (formatter compatible with Black + linter with automatic fixes)
// - JS / TS / CSS / HTML / JSON / Markdown / YAML: Prettier
// Ruff lives in the studio's own tools folder (installed on request) or comes with the portable build.

const isWin = process.platform === 'win32';
const MAX_CODE = 2 * 1024 * 1024;
// Next to the studio's code (not the current folder), so it is found wherever the server was started from
const STUDIO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = () => path.join(STUDIO_ROOT, 'tools', 'python');

const PRETTIER_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'css', 'scss', 'less', 'html', 'htm', 'vue', 'json', 'md', 'markdown', 'yaml', 'yml', 'graphql']);
const extOf = (name: string) => name.split('.').pop()?.toLowerCase() || '';

class ToolError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

/** Ruff executable: the studio's tools folder, the portable Python, or one on PATH. */
let ruffCache: { path: string | null; at: number } | null = null;
export function findRuff(): string | null {
  if (ruffCache && Date.now() - ruffCache.at < 10_000) return ruffCache.path;
  const exe = isWin ? 'ruff.exe' : 'ruff';
  const candidates = [
    path.join(TOOLS_DIR(), 'bin', exe),
    path.join(STUDIO_ROOT, 'runtime', 'python', 'Scripts', exe),
  ];
  let found = candidates.find((p) => fs.existsSync(p)) || null;
  if (!found) {
    const r = spawnSync(isWin ? 'where' : 'which', ['ruff'], { encoding: 'utf-8', windowsHide: true });
    if (r.status === 0) found = r.stdout.split(/\r?\n/).find(Boolean)?.trim() || null;
  }
  ruffCache = { path: found, at: Date.now() };
  return found;
}

/** Run a tool with the code on stdin (no shell). */
function runTool(cmd: string, args: string[], input: string, cwd: string, timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf-8'), stderr: Buffer.concat(err).toString('utf-8') });
    });
    child.stdin.on('error', () => {}); // the tool may exit before reading everything
    child.stdin.end(input, 'utf-8');
  });
}

/** Folder the tools run in: the project (so its pyproject.toml / .prettierrc apply) or the studio. */
function workDir(projectId: unknown): string {
  if (typeof projectId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(projectId)) {
    const dir = path.join(process.cwd(), 'projects', projectId);
    if (fs.existsSync(dir)) return dir;
  }
  return process.cwd();
}

function input(req: any) {
  const name = String(req.body?.name || '').replace(/\\/g, '/');
  const code = req.body?.code;
  if (!name || name.length > 300 || name.split('/').some((s) => s === '..')) throw new ToolError(400, 'Invalid file name');
  if (typeof code !== 'string') throw new ToolError(400, 'Code is required');
  if (code.length > MAX_CODE) throw new ToolError(400, 'File too large');
  return { name, code, cwd: workDir(req.body?.projectId) };
}

function requireRuff(): string {
  const ruff = findRuff();
  if (!ruff) throw new ToolError(409, 'Ruff is not installed', 'ruff-missing');
  return ruff;
}

/** Ruff prints "error: Failed to parse ..." for code with syntax errors: report it as a normal answer. */
const ruffSyntaxError = (stderr: string) => stderr.replace(/^error:\s*/i, '').trim().split('\n')[0];

export async function formatCode(name: string, code: string, cwd: string): Promise<string> {
  const ext = extOf(name);
  if (ext === 'py' || ext === 'pyi') {
    const r = await runTool(requireRuff(), ['format', '--stdin-filename', name, '-'], code, cwd);
    if (r.code !== 0) throw new ToolError(422, ruffSyntaxError(r.stderr) || 'ruff format failed');
    return r.stdout;
  }
  if (PRETTIER_EXT.has(ext)) {
    const prettier = await import('prettier');
    const filepath = path.join(cwd, name);
    const config = (await prettier.resolveConfig(filepath).catch(() => null)) || {};
    try {
      return await prettier.format(code, { ...config, filepath });
    } catch (e: any) {
      throw new ToolError(422, String(e.message || e).split('\n')[0]);
    }
  }
  throw new ToolError(400, `No formatter for .${ext} files`);
}

export interface Diagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  url?: string;
  fix?: { message: string; edits: { line: number; column: number; endLine: number; endColumn: number; text: string }[] };
}

export async function lintPython(name: string, code: string, cwd: string): Promise<Diagnostic[]> {
  const r = await runTool(requireRuff(), ['check', '--output-format=json', '--no-cache', '--exit-zero', '--stdin-filename', name, '-'], code, cwd);
  let raw: any[];
  try {
    raw = JSON.parse(r.stdout || '[]');
  } catch {
    throw new ToolError(500, r.stderr.trim() || 'ruff check failed');
  }
  return raw.map((d) => ({
    line: d.location?.row || 1,
    column: d.location?.column || 1,
    endLine: d.end_location?.row || d.location?.row || 1,
    endColumn: d.end_location?.column || d.location?.column || 1,
    // Syntax errors and likely bugs (undefined names...) are errors; the rest are style hints
    severity: !d.code || d.code === 'invalid-syntax' || /^(F8|F6|E9|F7|PLE)/.test(d.code) ? 'error' : 'warning',
    code: d.code || 'syntax',
    message: d.message,
    url: d.url || undefined,
    fix: d.fix?.edits?.length
      ? {
          message: d.fix.message || d.message,
          edits: d.fix.edits.map((e: any) => ({
            line: e.location.row,
            column: e.location.column,
            endLine: e.end_location.row,
            endColumn: e.end_location.column,
            text: e.content || '',
          })),
        }
      : undefined,
  }));
}

const wrap =
  (fn: (req: any) => Promise<unknown>) =>
  async (req: any, res: any) => {
    try {
      res.json(await fn(req));
    } catch (err: any) {
      const status = err instanceof ToolError ? err.status : 500;
      if (status === 500) console.error('Code tools error:', err);
      res.status(status).json({ error: err.message || 'Code tools error', code: err.code });
    }
  };

export const codeToolsRouter = Router();

codeToolsRouter.get(
  '/tools',
  wrap(async () => {
    const ruff = findRuff();
    let ruffVersion: string | null = null;
    if (ruff) ruffVersion = spawnSync(ruff, ['--version'], { encoding: 'utf-8', windowsHide: true }).stdout?.trim() || null;
    return { ruff: !!ruff, ruffVersion, prettier: true, jedi: hasJedi() };
  })
);

/** Install Ruff (formatter, checks) or Jedi (completions...) into the studio's tools folder; output streams like a program run. */
codeToolsRouter.post(
  '/tools/:tool/install',
  wrap(async (req) => {
    const tool = String(req.params.tool);
    if (tool !== 'ruff' && tool !== 'jedi') throw new ToolError(400, 'Unknown tool');
    fs.mkdirSync(TOOLS_DIR(), { recursive: true });
    const python = isWin ? 'python' : 'python3';
    const proc = spawnCommand(python, ['-m', 'pip', 'install', '--upgrade', '--target', TOOLS_DIR(), tool, '--disable-pip-version-check', '--no-warn-script-location'], process.cwd());
    ruffCache = null;
    resetJediCache();
    return {
      runId: startSession(
        proc,
        () => {
          ruffCache = null;
          resetJediCache();
        },
        5 * 60 * 1000
      ),
    };
  })
);

codeToolsRouter.post(
  '/format',
  wrap(async (req) => {
    const { name, code, cwd } = input(req);
    return { code: await formatCode(name, code, cwd) };
  })
);

codeToolsRouter.post(
  '/lint',
  wrap(async (req) => {
    const { name, code, cwd } = input(req);
    const ext = extOf(name);
    if (ext !== 'py' && ext !== 'pyi') return { diagnostics: [] };
    return { diagnostics: await lintPython(name, code, cwd) };
  })
);

/** Apply every safe automatic fix (ruff check --fix). */
codeToolsRouter.post(
  '/fix',
  wrap(async (req) => {
    const { name, code, cwd } = input(req);
    const r = await runTool(requireRuff(), ['check', '--fix', '--exit-zero', '--no-cache', '--quiet', '--stdin-filename', name, '-'], code, cwd);
    if (r.code !== 0) throw new ToolError(422, ruffSyntaxError(r.stderr) || 'ruff --fix failed');
    return { code: r.stdout };
  })
);
