import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { currentVersion } from './update.ts';

// Error journal and problem reports.
// logs/errors.log (next to the studio, kept across restarts; rotated at 2 MB) gets server errors (console.error,
// crashes) and interface errors (sent by the page). A report = system info + the end of the journals with
// secrets removed: keys from .env, API keys / tokens by their shape, the user's name in paths.
// Nothing is sent anywhere by the studio: the user copies or saves the report.

const LOG_DIR = () => path.join(process.cwd(), 'logs');
const ERRORS = () => path.join(LOG_DIR(), 'errors.log');
const MAX_SIZE = 2 * 1024 * 1024;

export function logError(source: string, message: string, details?: string) {
  try {
    fs.mkdirSync(LOG_DIR(), { recursive: true });
    const file = ERRORS();
    try {
      if (fs.statSync(file).size > MAX_SIZE) fs.renameSync(file, path.join(LOG_DIR(), 'errors.1.log'));
    } catch {
      /* no file yet */
    }
    const text = [message, details].filter(Boolean).join('\n').slice(0, 20000);
    fs.appendFileSync(file, `[${new Date().toISOString()}] [${source}] ${text.replace(/\n/g, '\n    ')}\n`, 'utf-8');
  } catch {
    /* the journal must never break the studio */
  }
}

/** Server side: console.error and crashes also go to the journal. */
export function installServerErrorLog() {
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    orig(...args);
    logError(
      'server',
      args
        .map((a) => (a instanceof Error ? `${a.message}\n${a.stack || ''}` : typeof a === 'string' ? a : safeJson(a)))
        .join(' ')
    );
  };
  // Monitor only: Node still crashes as before, but the reason is in the journal
  process.on('uncaughtExceptionMonitor', (err, origin) => logError('crash', `${origin}: ${err?.message}`, err?.stack));
}

const safeJson = (v: unknown) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

// ---------- secrets out ----------
function envValues(): string[] {
  try {
    return fs
      .readFileSync(path.join(process.cwd(), '.env'), 'utf-8')
      .split(/\r?\n/)
      .map((l) => /^\s*[\w.]+\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(l)?.[1]?.trim() || '')
      .filter((v) => v.length >= 6 && !/^(true|false|\d+)$/i.test(v));
  } catch {
    return [];
  }
}

export function redact(text: string): string {
  let t = text;
  for (const v of envValues()) t = t.split(v).join('[secret]');
  try {
    const custom = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'settings.json'), 'utf-8'))?.custom?.apiKey;
    if (typeof custom === 'string' && custom.length >= 6) t = t.split(custom).join('[secret]');
  } catch {
    /* no settings */
  }
  t = t
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[google-key]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[api-key]')
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[github-token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[github-token]')
    .replace(/\bya29\.[0-9A-Za-z_-]{20,}/g, '[oauth-token]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[token]')
    .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi, '$1[secret]')
    .replace(/("(?:apiKey|api_key|token|password|secret)"\s*:\s*")[^"]+"/gi, '$1[secret]"');
  // The user's name in paths (C:\Users\Name\...) and the computer name
  const home = os.homedir();
  const user = path.basename(home);
  if (user.length >= 2) {
    const homeToken = process.platform === 'win32' ? '%USERPROFILE%' : '$HOME';
    t = t.split(home).join(homeToken).split(home.replace(/\\/g, '/')).join(homeToken);
    t = t.replace(new RegExp(`([\\\\/]Users[\\\\/])${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\\\/]|$)`, 'gi'), '$1<user>');
    t = t.replace(new RegExp(`(/home/|/Users/)${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/|$)`, 'g'), '$1<user>');
  }
  const host = os.hostname();
  if (host.length >= 3) t = t.split(host).join('<pc>');
  return t;
}

function tail(file: string, lines: number): string {
  try {
    const text = fs.readFileSync(file, 'utf-8');
    return text.split(/\r?\n/).slice(-lines).join('\n').trim();
  } catch {
    return '';
  }
}

function pythonVersion(): string {
  const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['--version'], { encoding: 'utf-8', windowsHide: true, timeout: 5000 });
  return r.status === 0 ? (r.stdout || r.stderr).trim() : 'not found';
}

export function buildReport(description = '', ui: Record<string, unknown> = {}): string {
  const installed = fs.existsSync(path.join(process.cwd(), '.installed'));
  const portable = fs.existsSync(path.join(process.cwd(), '.portable-build'));
  const sys = [
    `ScriptCraft Studio ${currentVersion()} (${installed ? 'installed' : portable ? 'portable' : 'developer copy'})`,
    `OS: ${os.type()} ${os.release()} ${os.arch()}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, ${os.cpus().length} CPU`,
    `Node.js: ${process.version}`,
    `Python: ${pythonVersion()}`,
    ...Object.entries(ui).map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`),
  ];
  const parts = [
    '## Описание / Description',
    description.trim() || '(нет)',
    '',
    '## Система / System',
    sys.join('\n'),
    '',
    '## Журнал ошибок / Error log (logs/errors.log)',
    tail(ERRORS(), 300) || '(пусто)',
    '',
    '## Последний запуск / Last start (studio.log)',
    tail(path.join(process.cwd(), 'studio.log'), 120) || '(нет)',
  ];
  return redact(parts.join('\n'));
}

// ---------- routes ----------
export const logsRouter = Router();

// The page reports its errors here; a broken loop must not flood the disk
let clientWindow = { start: Date.now(), count: 0 };
logsRouter.post('/client', (req, res) => {
  const now = Date.now();
  if (now - clientWindow.start > 60_000) clientWindow = { start: now, count: 0 };
  if (++clientWindow.count > 30) return res.status(429).json({ error: 'Too many reports' });
  const b = req.body || {};
  const message = String(b.message || 'Unknown error').slice(0, 2000);
  const stack = String(b.stack || '').slice(0, 8000);
  const where = [b.kind, b.url].filter(Boolean).map(String).join(' ').slice(0, 300);
  logError('ui', `${message}${where ? ` (${where})` : ''}`, stack);
  res.json({ ok: true });
});

logsRouter.post('/report', (req, res) => {
  const ui = req.body?.ui && typeof req.body.ui === 'object' ? req.body.ui : {};
  res.json({ report: buildReport(String(req.body?.description || '').slice(0, 5000), ui) });
});

logsRouter.post('/open-folder', (_req, res) => {
  fs.mkdirSync(LOG_DIR(), { recursive: true });
  if (process.env.SCRIPTCRAFT_APPS_DRYRUN) return res.json({ ok: true, dir: LOG_DIR() });
  const dir = LOG_DIR();
  if (process.platform === 'win32') spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
  res.json({ ok: true });
});
