import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { readSettings, writeSettings } from './settings.ts';

// Updates: the latest GitHub release of the repository set in the studio ("owner/name") is compared with this
// version. An installed studio (made by ScriptCraftStudio-Setup.exe: the ".installed" marker) downloads the new
// installer, checks it against the release's .sha256 file and runs it silently; the installer closes the studio,
// replaces the program files (projects, keys and settings stay) and starts it again.
// A portable or developer copy only gets a link to the release page.

const STUDIO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET = 'ScriptCraftStudio-Setup.exe';
// Tests point this at a fake GitHub
const apiBase = () => (process.env.SCRIPTCRAFT_UPDATE_API || 'https://api.github.com').replace(/\/+$/, '');
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

class UpdateError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function currentVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(STUDIO_ROOT, 'package.json'), 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** -1 / 0 / 1; "v1.2.10" > "1.2.9"; a pre-release ("1.3.0-beta") is older than the release itself. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre = ''] = v.trim().replace(/^v/i, '').split('-', 2);
    return { nums: main.split('.').map((x) => parseInt(x, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// SCRIPTCRAFT_UPDATE_INSTALLED: tests act as an installed copy without a marker in the repository
const isInstalled = () => process.env.SCRIPTCRAFT_UPDATE_INSTALLED === '1' || fs.existsSync(path.join(STUDIO_ROOT, '.installed'));

interface Release {
  version: string;
  name: string;
  notes: string;
  page: string;
  published: string;
  installer?: { url: string; size: number };
  checksum?: string;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ScriptCraft-Studio' },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) throw new UpdateError(404, 'No releases found in this repository');
  if (!res.ok) throw new UpdateError(502, `GitHub answered ${res.status}`);
  return res.json();
}

async function latestRelease(repo: string): Promise<Release> {
  const r = await getJson(`${apiBase()}/repos/${repo}/releases/latest`);
  const assets: { name: string; browser_download_url: string; size: number }[] = r.assets || [];
  const exe = assets.find((a) => a.name === ASSET);
  const sha = assets.find((a) => a.name === `${ASSET}.sha256`);
  return {
    version: String(r.tag_name || '').replace(/^v/i, ''),
    name: String(r.name || r.tag_name || ''),
    notes: String(r.body || '').slice(0, 20000),
    page: String(r.html_url || `https://github.com/${repo}/releases`),
    published: String(r.published_at || ''),
    installer: exe ? { url: exe.browser_download_url, size: exe.size } : undefined,
    checksum: sha?.browser_download_url,
  };
}

/** Only https downloads from GitHub (or the test server set by SCRIPTCRAFT_UPDATE_API). */
function checkDownloadUrl(u: string) {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new UpdateError(502, 'Bad download link in the release');
  }
  const testBase = process.env.SCRIPTCRAFT_UPDATE_API;
  if (testBase && u.startsWith(testBase)) return;
  if (url.protocol !== 'https:' || !/(^|\.)github(usercontent)?\.com$/.test(url.hostname)) throw new UpdateError(502, 'The release points outside GitHub');
}

async function download(url: string, file: string) {
  checkDownloadUrl(url);
  const res = await fetch(url, { headers: { 'User-Agent': 'ScriptCraft-Studio' }, signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!res.ok || !res.body) throw new UpdateError(502, `Download failed (${res.status})`);
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
}

const sha256 = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });

let installing = false;

export const updateRouter = Router();

const wrap =
  (fn: (req: any) => unknown) =>
  async (req: any, res: any) => {
    try {
      res.json(await fn(req));
    } catch (err: any) {
      const status = err instanceof UpdateError ? err.status : 500;
      if (status === 500) console.error('Update error:', err);
      res.status(status).json({ error: err.message || 'Update error' });
    }
  };

updateRouter.get(
  '/',
  wrap(() => {
    const s = readSettings().update;
    return { version: currentVersion(), installed: isInstalled(), repo: s.repo, autoCheck: s.autoCheck };
  })
);

updateRouter.put(
  '/',
  wrap((req) => {
    const s = readSettings();
    const repo = String(req.body?.repo ?? s.update.repo)
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
    if (repo && !REPO_RE.test(repo)) throw new UpdateError(400, 'Repository must look like owner/name');
    s.update = { repo, autoCheck: req.body?.autoCheck === undefined ? s.update.autoCheck : !!req.body.autoCheck };
    writeSettings(s);
    return { ok: true, repo };
  })
);

updateRouter.post(
  '/check',
  wrap(async () => {
    const { repo } = readSettings().update;
    if (!repo) throw new UpdateError(400, 'No update repository set');
    const r = await latestRelease(repo);
    const current = currentVersion();
    return {
      current,
      latest: r.version,
      available: !!r.version && compareVersions(r.version, current) > 0,
      name: r.name,
      notes: r.notes,
      page: r.page,
      published: r.published,
      canInstall: isInstalled() && !!r.installer && !!r.checksum,
      size: r.installer?.size || 0,
    };
  })
);

updateRouter.post(
  '/install',
  wrap(async () => {
    if (!isInstalled()) throw new UpdateError(400, 'This copy was not installed with the installer: download the new version from the release page');
    if (installing) throw new UpdateError(409, 'Already updating');
    const { repo } = readSettings().update;
    if (!repo) throw new UpdateError(400, 'No update repository set');
    installing = true;
    try {
      const r = await latestRelease(repo);
      if (compareVersions(r.version, currentVersion()) <= 0) throw new UpdateError(400, 'Already up to date');
      if (!r.installer || !r.checksum) throw new UpdateError(502, `The release has no ${ASSET} with its .sha256 file`);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-update-'));
      const exe = path.join(dir, ASSET);
      const sumFile = path.join(dir, 'sum.txt');
      await download(r.checksum, sumFile);
      const expected = (fs.readFileSync(sumFile, 'utf-8').match(/\b[0-9a-f]{64}\b/i)?.[0] || '').toLowerCase();
      if (!expected) throw new UpdateError(502, 'The .sha256 file of the release is empty');
      await download(r.installer.url, exe);
      const actual = await sha256(exe);
      if (actual !== expected) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new UpdateError(502, 'The downloaded installer does not match its checksum — not installed');
      }
      const args = ['/S', `/D=${STUDIO_ROOT}`, '/launch'];
      // Tests: everything up to running the installer
      if (process.env.SCRIPTCRAFT_UPDATE_DRYRUN) return { ok: true, version: r.version, installer: exe, args, dryRun: true };
      // Detached: the installer outlives the studio it is about to close
      spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return { ok: true, version: r.version };
    } finally {
      installing = false;
    }
  })
);
