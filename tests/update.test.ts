// Updates: a fake GitHub (releases API + downloads) on localhost; the installer is never run (dry run).
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-update-'));
let server: http.Server;
let gh: http.Server;
let base = '';
let ghBase = '';
const installer = Buffer.from('MZ fake installer ' + 'x'.repeat(5000));
let release: any = null;
let checksum = crypto.createHash('sha256').update(installer).digest('hex');
let downloads = 0;

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

before(async () => {
  gh = http.createServer((req, res) => {
    if (req.url === '/repos/me/studio/releases/latest') {
      if (!release) return res.writeHead(404).end('{}');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(release));
    } else if (req.url === '/dl/setup.exe') {
      downloads++;
      res.writeHead(200).end(installer);
    } else if (req.url === '/dl/setup.exe.sha256') {
      res.writeHead(200).end(`${checksum}  ScriptCraftStudio-Setup.exe\n`);
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => gh.listen(0, '127.0.0.1', () => r()));
  ghBase = `http://127.0.0.1:${(gh.address() as AddressInfo).port}`;
  process.env.SCRIPTCRAFT_UPDATE_API = ghBase;
  process.env.SCRIPTCRAFT_UPDATE_DRYRUN = '1';

  process.chdir(tmp);
  fs.writeFileSync('settings.json', JSON.stringify({ ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434' } }));
  const express = (await import('express')).default;
  const { apiRouter } = await import(pathToFileURL(path.join(studioRoot, 'api', 'router.ts')).href);
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  gh?.close();
  delete process.env.SCRIPTCRAFT_UPDATE_API;
  delete process.env.SCRIPTCRAFT_UPDATE_DRYRUN;
  delete process.env.SCRIPTCRAFT_UPDATE_INSTALLED;
  process.chdir(studioRoot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('compareVersions', async () => {
  const { compareVersions } = await import(pathToFileURL(path.join(studioRoot, 'api', 'update.ts')).href);
  assert.equal(compareVersions('v1.2.10', '1.2.9'), 1);
  assert.equal(compareVersions('1.2.0', '1.2'), 0);
  assert.equal(compareVersions('1.3.0-beta', '1.3.0'), -1);
  assert.equal(compareVersions('1.1.0', '2.0.0'), -1);
});

test('update settings: the repository is checked and normalized', async () => {
  const st = (await api('GET', '/api/update')).data;
  assert.equal(st.repo, 'DuskMaxFaktor/scriptcraft-studio'); // the studio's own releases by default
  assert.equal(st.version, JSON.parse(fs.readFileSync(path.join(studioRoot, 'package.json'), 'utf-8')).version);
  assert.equal((await api('PUT', '/api/update', { repo: '' })).data.repo, '');
  assert.equal((await api('POST', '/api/update/check')).status, 400); // turned off
  assert.equal((await api('PUT', '/api/update', { repo: 'not a repo' })).status, 400);
  assert.equal((await api('PUT', '/api/update', { repo: 'https://github.com/me/studio.git' })).data.repo, 'me/studio');
  assert.equal((await api('GET', '/api/update')).data.repo, 'me/studio');
});

test('update check: newer release found, a portable copy only gets the page', async () => {
  assert.equal((await api('POST', '/api/update/check')).status, 404); // no releases yet
  release = {
    tag_name: 'v99.0.0',
    name: 'Big one',
    body: '- new things',
    html_url: 'https://github.com/me/studio/releases/tag/v99.0.0',
    assets: [
      { name: 'ScriptCraftStudio-Setup.exe', browser_download_url: `${ghBase}/dl/setup.exe`, size: installer.length },
      { name: 'ScriptCraftStudio-Setup.exe.sha256', browser_download_url: `${ghBase}/dl/setup.exe.sha256`, size: 90 },
    ],
  };
  const c = (await api('POST', '/api/update/check')).data;
  assert.equal(c.available, true);
  assert.equal(c.latest, '99.0.0');
  assert.equal(c.notes, '- new things');
  assert.equal(c.canInstall, false); // not installed with the installer
  assert.equal((await api('POST', '/api/update/install')).status, 400);

  // An older release is not an update
  release = { ...release, tag_name: 'v0.0.1' };
  assert.equal((await api('POST', '/api/update/check')).data.available, false);
});

test('download: a file that cannot be written fails the download, never the server', async () => {
  const { download } = await import(pathToFileURL(path.join(studioRoot, 'api', 'update.ts')).href);
  // The target is a folder: the write stream errors (like a full disk or a locked file would)
  const target = path.join(tmp, 'a-folder');
  fs.mkdirSync(target);
  await assert.rejects(download(`${ghBase}/dl/setup.exe`, target), /Cannot save the download|Download failed/);
  assert.ok(fs.statSync(target).isDirectory());
});

test('update install: downloads, verifies the checksum, refuses a mismatch and foreign hosts', async () => {
  process.env.SCRIPTCRAFT_UPDATE_INSTALLED = '1';
  release = { ...release, tag_name: 'v99.0.0' };
  assert.equal((await api('POST', '/api/update/check')).data.canInstall, true);

  const ok = await api('POST', '/api/update/install');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.dryRun, true);
  assert.deepEqual(ok.data.args.slice(0, 1), ['/S']);
  assert.ok(ok.data.args.includes('/launch'));
  assert.deepEqual(fs.readFileSync(ok.data.installer), installer);
  fs.rmSync(path.dirname(ok.data.installer), { recursive: true, force: true });

  // A tampered download is refused
  checksum = 'f'.repeat(64);
  const bad = await api('POST', '/api/update/install');
  assert.equal(bad.status, 502);
  assert.match(bad.data.error, /checksum/);
  checksum = crypto.createHash('sha256').update(installer).digest('hex');

  // Links outside GitHub are refused before anything is downloaded
  const before = downloads;
  release.assets[0].browser_download_url = 'https://evil.example.com/setup.exe';
  const foreign = await api('POST', '/api/update/install');
  assert.equal(foreign.status, 502);
  assert.match(foreign.data.error, /outside GitHub/);
  assert.equal(downloads, before);
});
