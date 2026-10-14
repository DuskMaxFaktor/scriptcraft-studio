import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import { StringDecoder } from 'string_decoder';
import { projectEnv, projectArgs } from './runconfig.ts';

/** Studio install root (next to `api/`), so tsx is found even when cwd is a temp test folder. */
const STUDIO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface RunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

const isWin = process.platform === 'win32';

// On Windows the script runs under cmd.exe (shell: true), so proc.kill() would only
// terminate the shell and leave the actual interpreter running. Kill the whole tree.
export function killProcessTree(proc: ChildProcess) {
  if (isWin && proc.pid) {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  } else if (proc.pid) {
    // Linux / macOS: the program runs in its own process group (spawnCommand), so its children
    // (pytest workers, node --test files, subprocesses) stop with it
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      proc.kill('SIGKILL');
    }
  }
}

/** On Windows prefer Git Bash: a bare "bash" may resolve to WSL, which cannot see Windows temp paths. */
function findBash(): string {
  if (!isWin) return 'bash';
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  return found ? `"${found}"` : 'bash';
}

export interface PreparedRun {
  command: string;
  args: string[];
  filePath: string;
  /** Working directory of the program */
  cwd: string;
  /** Temp project folder to delete afterwards (multi-file runs) */
  tempDir?: string;
  /** Folder the project's files are in: the project folder itself (run in place) or the temp copy */
  rootDir?: string;
  /** Run in the real project folder: files the program creates stay in the project */
  inPlace?: boolean;
  /** node_modules link created for this run (removed afterwards) */
  linkPath?: string;
}

export interface ProjectFileInput {
  name: string;
  content: string;
}

const MAX_PROJECT_BYTES = 20 * 1024 * 1024;

/** A run request that cannot be run as sent (reported to the user as a 400). */
export class RunInputError extends Error {}

/** Windows PowerShell, or PowerShell Core (`pwsh`) on Linux / macOS when installed. */
function findPowerShell(): string {
  if (isWin) return 'powershell.exe';
  for (const p of ['pwsh', '/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh', '/usr/bin/pwsh']) {
    const probe = spawnSync(p, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf-8', timeout: 8000 });
    if (probe.status === 0) return p;
  }
  throw new RunInputError(
    'PowerShell Core (pwsh) is not installed. Install it from https://github.com/PowerShell/PowerShell/releases or run .ps1 scripts on Windows.'
  );
}

/** Safe relative path inside the temp project folder, or null if the name tries to escape it. */
function safeRelative(name: string): string | null {
  const parts = String(name).replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '..' || p === '.' || /[<>:"|?*\x00-\x1f]/.test(p))) return null;
  return parts.join('/');
}

/** The project folder, when everything sent for the run is exactly what is saved there. */
/**
 * The full form of a folder path. Windows may name TEMP (or the studio folder) by its 8.3 short name
 * ("C:\Users\8E54~1\..." for a long or non-Latin user name), while Node, Python and the debuggers
 * report the long one; paths compared between them (breakpoints!) must use the same form.
 */
function longPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function savedProjectDir(projectId: string | undefined, code: string, files: ProjectFileInput[], entryRel: string): string | null {
  if (!projectId || !/^[a-zA-Z0-9_-]{1,80}$/.test(projectId)) return null;
  const dir = path.join(process.cwd(), 'projects', projectId);
  if (!fs.existsSync(path.join(dir, '.scriptcraft.json'))) return null;
  const same = (rel: string, content: string) => {
    try {
      return fs.readFileSync(path.join(dir, rel), 'utf-8') === content;
    } catch {
      return false;
    }
  };
  if (!same(entryRel, code)) return null;
  for (const f of files) {
    const rel = safeRelative(f?.name);
    if (!rel || typeof f.content !== 'string' || !same(rel, f.content)) return null;
  }
  return dir;
}

/**
 * Pick the interpreter and the files to run. Returns null for unsupported languages.
 * - A saved project runs in its own folder (files the program writes stay in the project).
 * - Otherwise (unsaved changes, no project) the files are copied to a temp folder so they can still import
 *   each other (e.g. "from helpers import ..."), and `entry` is run from there.
 */
export function prepareRun(language: string, code: string, files?: ProjectFileInput[], entry?: string, projectId?: string): PreparedRun | null {
  const fileId = `script_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const lang = language.toLowerCase();
  const tmp = longPath(os.tmpdir());
  let cwd = tmp;
  let tempDir: string | undefined;
  let rootDir: string | undefined;
  const entryRel = entry ? safeRelative(entry) : null;
  const saved = Array.isArray(files) && entryRel ? savedProjectDir(projectId, code, files, entryRel) : null;
  const projectDir = saved && longPath(saved);

  if (projectDir && entryRel) {
    rootDir = projectDir;
    cwd = path.dirname(path.join(projectDir, entryRel));
  } else if (Array.isArray(files) && files.length > 0 && entryRel) {
    tempDir = fs.mkdtempSync(path.join(tmp, 'scriptcraft-run-'));
    let total = 0;
    for (const f of files) {
      const rel = safeRelative(f?.name);
      if (!rel || typeof f.content !== 'string') continue;
      total += f.content.length;
      if (total > MAX_PROJECT_BYTES) {
        // Half a project would fail with a confusing "module not found": say what is wrong instead
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw new RunInputError(`The project is too big to run with unsaved changes (over ${MAX_PROJECT_BYTES / 1024 / 1024} MB): save it and run again`);
      }
      const target = path.join(tempDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content, 'utf-8');
    }
    cwd = path.dirname(path.join(tempDir, entryRel));
    rootDir = tempDir;
  }

  const write = (ext: string) => {
    // In place: the saved file itself (never rewritten)
    if (projectDir && entryRel) return path.join(projectDir, entryRel);
    // Multi-file run: the entry file is written with the current editor content under its real name
    const filePath = tempDir && entryRel ? path.join(tempDir, entryRel) : path.join(tmp, `${fileId}.${ext}`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, code, 'utf-8');
    return filePath;
  };
  const result = (command: string, args: string[], filePath: string): PreparedRun => ({
    command,
    args,
    filePath,
    cwd,
    tempDir,
    rootDir,
    inPlace: !!projectDir,
  });

  if (lang === 'python' || lang === 'py') {
    const filePath = write('py');
    return result(isWin ? 'python' : 'python3', ['-u', filePath], filePath);
  }
  if (lang === 'bash' || lang === 'sh') {
    const filePath = write('sh');
    return result(findBash(), [filePath], filePath);
  }
  if (lang === 'javascript' || lang === 'js') {
    const filePath = write('js');
    return result('node', [filePath], filePath);
  }
  if (lang === 'typescript' || lang === 'ts') {
    const filePath = write('ts');
    // Studio's own tsx (not cwd): tests and the portable build keep node_modules next to the studio, not in temp
    const tsxCli = path.join(STUDIO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (fs.existsSync(tsxCli)) return result('node', [tsxCli, filePath], filePath);
    const cwdTsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (fs.existsSync(cwdTsx)) return result('node', [cwdTsx, filePath], filePath);
    return result('npx', ['--yes', 'tsx', filePath], filePath);
  }
  if (lang === 'powershell' || lang === 'ps1') {
    const filePath = write('ps1');
    // -File runs the script; project run-parameter args are appended after the path by spawnPrepared
    return result(findPowerShell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', filePath], filePath);
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  return null;
}

/** Folder with packages installed for a project (pip --target / npm --prefix). */
export function projectPackagesDir(projectId: string): string | null {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(projectId)) return null;
  return path.join(process.cwd(), 'projects', projectId, '.packages');
}

/** Make a project's installed packages visible to the program. */
export function attachPackages(run: PreparedRun, projectId?: string): NodeJS.ProcessEnv {
  // The project's run parameters (.env) first; package paths are added on top
  const env: NodeJS.ProcessEnv = { ...projectEnv(projectId) };
  const pkgDir = projectId ? projectPackagesDir(projectId) : null;
  if (!pkgDir) return env;
  const pyDir = path.join(pkgDir, 'python');
  if (fs.existsSync(pyDir)) {
    env.PYTHONPATH = [pyDir, env.PYTHONPATH || process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  }
  const nodeModules = path.join(pkgDir, 'node', 'node_modules');
  if (fs.existsSync(nodeModules)) {
    env.NODE_PATH = [nodeModules, env.NODE_PATH || process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    // NODE_PATH only helps require(); a node_modules link next to the code also makes ESM imports work
    const link = run.rootDir ? path.join(run.rootDir, 'node_modules') : '';
    if (link && !fs.existsSync(link)) {
      try {
        fs.symlinkSync(nodeModules, link, isWin ? 'junction' : 'dir');
        run.linkPath = link;
      } catch {
        // NODE_PATH still works for require()
      }
    }
  }
  return env;
}

/** `extraEnv` entries set to undefined remove that variable for the child. */
export function spawnCommand(command: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  // With shell: true arguments are joined by spaces, so quote paths and anything cmd.exe would interpret
  const spawnArgs = isWin ? args.map((a) => (a === '' || /[\s&|<>()]/.test(a) ? `"${a}"` : a)) : args;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    NODE_OPTIONS: '--no-warnings',
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const proc = spawn(command, spawnArgs, {
    cwd,
    env,
    shell: isWin,
    windowsHide: true,
    // Its own process group on Linux / macOS, so killProcessTree reaches the whole tree
    detached: !isWin,
  });
  procCwd.set(proc, path.resolve(cwd));
  return proc;
}

/** The folder each spawned process works in, so a project's processes can be found before it is deleted. */
const procCwd = new WeakMap<ChildProcess, string>();

function spawnPrepared(run: PreparedRun, projectId?: string): ChildProcess {
  // Command-line arguments from the project's run parameters go after the script
  return spawnCommand(run.command, [...run.args, ...projectArgs(projectId)], run.cwd, attachPackages(run, projectId));
}

export function cleanup(run: PreparedRun) {
  try {
    // Remove the node_modules link first so rmSync never walks into the real packages folder
    const link = run.linkPath;
    if (link && fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    // A run in the project folder leaves everything as it is
    if (run.inPlace) return;
    if (run.tempDir) fs.rmSync(run.tempDir, { recursive: true, force: true });
    else if (run.filePath && fs.existsSync(run.filePath)) fs.unlinkSync(run.filePath);
  } catch {
    // ignore cleanup error
  }
}

/** One-shot execution (used by tests / simple callers): waits for the process and returns all output. */
export async function executeCodeOnServer(
  language: string,
  code: string,
  timeoutMs = 10000,
  files?: ProjectFileInput[],
  entry?: string,
  projectId?: string
): Promise<RunResult> {
  const t0 = performance.now();
  let prepared: PreparedRun | null;
  try {
    prepared = prepareRun(language, code, files, entry, projectId);
  } catch (err: any) {
    return { success: false, stdout: '', stderr: err?.message || String(err), exitCode: 1, durationMs: 0 };
  }
  if (!prepared) {
    return {
      success: false,
      stdout: '',
      stderr: `Language "${language}" is evaluated in client sandbox or preview.`,
      exitCode: 1,
      durationMs: 0,
    };
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let isTimedOut = false;
    const proc = spawnPrepared(prepared, projectId);
    proc.stdin?.end();

    const timer = setTimeout(() => {
      isTimedOut = true;
      killProcessTree(proc);
    }, timeoutMs);

    // One decoder per stream: a character split between two chunks is joined, not garbled
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    proc.stdout?.on('data', (data: Buffer) => {
      stdout += outDec.write(data);
      if (stdout.length > 500000) killProcessTree(proc);
    });
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += errDec.write(data);
      if (stderr.length > 500000) killProcessTree(proc);
    });
    proc.on('error', (err) => {
      stderr += `\nExecution error: ${err.message}`;
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      cleanup(prepared);
      stdout += outDec.end();
      stderr += errDec.end();
      if (isTimedOut) stderr += `\n[Process timed out after ${timeoutMs / 1000}s]`;
      resolve({
        success: !isTimedOut && code === 0,
        stdout,
        stderr,
        exitCode: isTimedOut ? -1 : code,
        durationMs: Math.round(performance.now() - t0),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Interactive runs: start → stream output (SSE) → send stdin → stop
// ---------------------------------------------------------------------------

type RunEvent =
  | { type: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; code: number | null; durationMs: number; reason: 'exit' | 'stopped' | 'timeout' | 'output-limit' | 'error' };

interface RunSession {
  id: string;
  proc: ChildProcess;
  events: RunEvent[];
  listeners: Set<(index: number) => void>;
  done: boolean;
  outputBytes: number;
  stopReason: 'stopped' | 'timeout' | 'output-limit' | null;
  orphanTimer?: NodeJS.Timeout;
}

const sessions = new Map<string, RunSession>();
const MAX_RUN_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const ORPHAN_KILL_MS = 20 * 1000;

function pushEvent(session: RunSession, event: RunEvent) {
  session.events.push(event);
  const index = session.events.length - 1;
  session.listeners.forEach((l) => l(index));
}

function stopSession(session: RunSession, reason: 'stopped' | 'timeout' | 'output-limit') {
  if (session.done) return;
  session.stopReason = reason;
  killProcessTree(session.proc);
}

/**
 * Stop every running session (program, debugger, tests, package install, .exe build) that works inside
 * a project's folder, and wait for it to exit — otherwise Windows keeps the folder locked and the project
 * cannot be moved to the trash.
 */
export async function stopProjectRuns(projectId: string): Promise<number> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(projectId)) return 0;
  const dir = path.resolve(process.cwd(), 'projects', projectId);
  const exits: Promise<void>[] = [];
  for (const s of sessions.values()) {
    if (s.done) continue;
    const cwd = procCwd.get(s.proc);
    if (!cwd || (cwd !== dir && !cwd.startsWith(dir + path.sep))) continue;
    exits.push(
      new Promise<void>((resolve) => {
        if (s.proc.exitCode !== null) return resolve();
        s.proc.once('close', () => resolve());
        setTimeout(resolve, 5000); // never wait forever
      })
    );
    stopSession(s, 'stopped');
  }
  await Promise.all(exits);
  return exits.length;
}

export const runRouter = Router();

/**
 * Start a process as a streamable session (output over SSE, stdin, stop).
 * Used for program runs and for package installation.
 */
export function startSession(proc: ChildProcess, onClose?: () => void, maxRunMs = MAX_RUN_MS): string {
  const t0 = Date.now();
  const session: RunSession = {
    id: `run_${t0}_${Math.random().toString(36).slice(2, 8)}`,
    proc,
    events: [],
    listeners: new Set(),
    done: false,
    outputBytes: 0,
    stopReason: null,
  };
  sessions.set(session.id, session);

  const timer = setTimeout(() => stopSession(session, 'timeout'), maxRunMs);
  // One decoder per stream: a multi-byte character (Cyrillic...) split between two chunks stays whole
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const onData = (type: 'stdout' | 'stderr') => (chunk: Buffer) => {
    session.outputBytes += chunk.length;
    const text = decoders[type].write(chunk);
    if (text) pushEvent(session, { type, data: text });
    if (session.outputBytes > MAX_OUTPUT_BYTES) stopSession(session, 'output-limit');
  };
  proc.stdout?.on('data', onData('stdout'));
  proc.stderr?.on('data', onData('stderr'));
  proc.stdin?.on('error', () => {
    // process exited while we were writing; ignore
  });
  proc.on('error', (err) => pushEvent(session, { type: 'stderr', data: `Execution error: ${err.message}\n` }));
  proc.on('close', (code) => {
    clearTimeout(timer);
    for (const type of ['stdout', 'stderr'] as const) {
      const rest = decoders[type].end();
      if (rest) pushEvent(session, { type, data: rest });
    }
    onClose?.();
    session.done = true;
    pushEvent(session, {
      type: 'exit',
      code,
      durationMs: Date.now() - t0,
      reason: session.stopReason || 'exit',
    });
    // Keep the finished session briefly so a reconnecting client can still read the tail
    setTimeout(() => sessions.delete(session.id), 60 * 1000);
  });
  return session.id;
}

runRouter.post('/start', (req, res) => {
  const { language, code, files, entry, projectId } = req.body || {};
  if (typeof code !== 'string' || !code) return res.status(400).json({ error: 'Code content is required' });

  let prepared: PreparedRun | null;
  try {
    prepared = prepareRun(String(language || 'python'), code, files, entry, typeof projectId === 'string' ? projectId : undefined);
  } catch (err: any) {
    if (err instanceof RunInputError) return res.status(400).json({ error: err.message });
    throw err;
  }
  if (!prepared) return res.status(400).json({ error: `Language "${language}" cannot be run on the server` });

  const proc = spawnPrepared(prepared, typeof projectId === 'string' ? projectId : undefined);
  res.json({ runId: startSession(proc, () => cleanup(prepared)) });
});

// Server-Sent Events stream of the run output. Supports Last-Event-ID for reconnects (no duplicates).
runRouter.get('/:id/events', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Run not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (index: number) => {
    const event = session.events[index];
    res.write(`id: ${index}\ndata: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'exit') res.end();
  };

  const lastId = Number(req.headers['last-event-id']);
  const from = Number.isFinite(lastId) ? lastId + 1 : 0;
  for (let i = from; i < session.events.length; i++) send(i);
  if (session.done && from >= session.events.length) return res.end();

  if (session.orphanTimer) clearTimeout(session.orphanTimer);
  session.listeners.add(send);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    session.listeners.delete(send);
    // Nobody is watching any more (tab closed): don't leave the process running forever
    if (!session.done && session.listeners.size === 0) {
      session.orphanTimer = setTimeout(() => {
        if (session.listeners.size === 0) stopSession(session, 'stopped');
      }, ORPHAN_KILL_MS);
    }
  });
});

runRouter.post('/:id/stdin', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session || session.done) return res.status(404).json({ error: 'Run not found or already finished' });
  const data = typeof req.body?.data === 'string' ? req.body.data : '';
  session.proc.stdin?.write(data);
  if (req.body?.eof) session.proc.stdin?.end();
  res.json({ ok: true });
});

runRouter.post('/:id/stop', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Run not found' });
  stopSession(session, 'stopped');
  res.json({ ok: true });
});
