import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pty from '@lydell/node-pty';
import { projectPackagesDir } from './run.ts';
import { projectEnv } from './runconfig.ts';

// Real shell terminals (PowerShell / cmd / Git Bash) in a pseudo-terminal, opened in the project folder.
// Output goes to the browser over Server-Sent Events, keystrokes come back with POST requests.

type ShellKind = 'powershell' | 'cmd' | 'bash';

interface TermSession {
  id: string;
  proc: pty.IPty;
  projectId: string | null;
  chunks: { id: number; data: string }[];
  nextId: number;
  bufferedBytes: number;
  listeners: Set<(c: { id: number; data: string }) => void>;
  exited: boolean;
  exitCode: number | null;
  orphanTimer?: NodeJS.Timeout;
}

const sessions = new Map<string, TermSession>();
const MAX_BUFFER = 256 * 1024; // replay buffer for reconnects
const ORPHAN_KILL_MS = 60 * 1000;
const MAX_SESSIONS = 8;

function findGitBash(): string | null {
  if (process.platform !== 'win32') return '/bin/bash';
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function shellCommand(kind: ShellKind): { file: string; args: string[] } {
  if (process.platform !== 'win32') return { file: process.env.SHELL || '/bin/bash', args: [] };
  if (kind === 'cmd') return { file: 'cmd.exe', args: [] };
  if (kind === 'bash') {
    const bash = findGitBash();
    if (bash) return { file: bash, args: ['--login', '-i'] };
  }
  return { file: 'powershell.exe', args: ['-NoLogo'] };
}

function projectDirOf(projectId: unknown): string {
  if (typeof projectId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(projectId)) {
    const dir = path.join(process.cwd(), 'projects', projectId);
    if (fs.existsSync(dir)) return dir;
  }
  return os.homedir();
}

/** Same package folders as program runs, so `python script.py` in the terminal sees installed packages. */
function terminalEnv(projectId: unknown): Record<string, string> {
  // The project's run parameters (.env) are available in its terminals too
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...projectEnv(projectId), TERM: 'xterm-256color', PYTHONIOENCODING: 'utf-8' };
  const pkgDir = typeof projectId === 'string' ? projectPackagesDir(projectId) : null;
  if (pkgDir) {
    const py = path.join(pkgDir, 'python');
    const nm = path.join(pkgDir, 'node', 'node_modules');
    if (fs.existsSync(py)) env.PYTHONPATH = [py, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    if (fs.existsSync(nm)) env.NODE_PATH = [nm, env.NODE_PATH].filter(Boolean).join(path.delimiter);
  }
  return env;
}

function push(session: TermSession, data: string) {
  const chunk = { id: session.nextId++, data };
  session.chunks.push(chunk);
  session.bufferedBytes += data.length;
  while (session.bufferedBytes > MAX_BUFFER && session.chunks.length > 1) {
    session.bufferedBytes -= session.chunks.shift()!.data.length;
  }
  session.listeners.forEach((l) => l(chunk));
}

function kill(session: TermSession) {
  if (!session.exited) {
    try {
      session.proc.kill();
    } catch {
      // already gone
    }
  }
  sessions.delete(session.id);
}

/** Close the terminals opened in a project before its folder is deleted (Windows can't remove a folder a shell is in). */
export async function closeProjectTerminals(projectId: string) {
  const mine = [...sessions.values()].filter((s) => s.projectId === projectId);
  await Promise.all(
    mine.map(
      (s) =>
        new Promise<void>((resolve) => {
          if (s.exited) return resolve();
          const timer = setTimeout(resolve, 3000);
          s.proc.onExit(() => {
            clearTimeout(timer);
            resolve();
          });
          kill(s);
        })
    )
  );
}

// Don't leave shells behind when the studio stops
process.on('exit', () => sessions.forEach((s) => kill(s)));

export const terminalRouter = Router();

terminalRouter.get('/shells', (_req, res) => {
  res.json({ shells: process.platform === 'win32' ? ['powershell', 'cmd', ...(findGitBash() ? ['bash'] : [])] : ['bash'] });
});

terminalRouter.post('/start', (req, res) => {
  if (sessions.size >= MAX_SESSIONS) return res.status(429).json({ error: `Too many terminals (max ${MAX_SESSIONS})` });
  const kind: ShellKind = ['cmd', 'bash'].includes(req.body?.shell) ? req.body.shell : 'powershell';
  const cols = Math.min(Math.max(Number(req.body?.cols) || 100, 20), 400);
  const rows = Math.min(Math.max(Number(req.body?.rows) || 24, 5), 200);
  const { file, args } = shellCommand(kind);
  let proc: pty.IPty;
  try {
    proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: projectDirOf(req.body?.projectId),
      env: terminalEnv(req.body?.projectId),
    });
  } catch (err: any) {
    return res.status(500).json({ error: `Cannot start ${kind}: ${err.message}` });
  }
  const session: TermSession = {
    id: `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    proc,
    projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : null,
    chunks: [],
    nextId: 0,
    bufferedBytes: 0,
    listeners: new Set(),
    exited: false,
    exitCode: null,
  };
  sessions.set(session.id, session);
  proc.onData((d) => push(session, d));
  proc.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
    push(session, '');
    session.listeners.forEach((l) => l({ id: -1, data: '' }));
    setTimeout(() => sessions.delete(session.id), 30 * 1000);
  });
  res.json({ id: session.id, shell: kind });
});

terminalRouter.get('/:id/events', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Terminal not found' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (c: { id: number; data: string }) => {
    if (c.id === -1) {
      res.write(`event: exit\ndata: ${JSON.stringify({ code: session.exitCode })}\n\n`);
      return res.end();
    }
    if (c.data) res.write(`id: ${c.id}\ndata: ${JSON.stringify(c.data)}\n\n`);
  };
  const lastId = Number(req.headers['last-event-id']);
  for (const c of session.chunks) if (!Number.isFinite(lastId) || c.id > lastId) send(c);
  if (session.exited) return send({ id: -1, data: '' });

  if (session.orphanTimer) clearTimeout(session.orphanTimer);
  session.listeners.add(send);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    session.listeners.delete(send);
    if (session.listeners.size === 0 && !session.exited) {
      session.orphanTimer = setTimeout(() => session.listeners.size === 0 && kill(session), ORPHAN_KILL_MS);
    }
  });
});

terminalRouter.post('/:id/input', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session || session.exited) return res.status(404).json({ error: 'Terminal not found' });
  const data = typeof req.body?.data === 'string' ? req.body.data : '';
  if (data.length > 100_000) return res.status(400).json({ error: 'Input too large' });
  session.proc.write(data);
  res.json({ ok: true });
});

terminalRouter.post('/:id/resize', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session || session.exited) return res.status(404).json({ error: 'Terminal not found' });
  const cols = Math.min(Math.max(Number(req.body?.cols) || 0, 20), 400);
  const rows = Math.min(Math.max(Number(req.body?.rows) || 0, 5), 200);
  try {
    session.proc.resize(cols, rows);
  } catch {
    // resizing an exiting pty can throw; harmless
  }
  res.json({ ok: true });
});

terminalRouter.post('/:id/kill', (req, res) => {
  const session = sessions.get(req.params.id);
  if (session) kill(session);
  res.json({ ok: true });
});
