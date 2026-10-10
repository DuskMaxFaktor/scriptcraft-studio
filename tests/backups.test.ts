// Automatic backups of all projects and restoring one project from a backup.
// Run with: npm test   (backups go to a temporary folder, never to the real Documents folder)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import JSZip from 'jszip';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-backup-test-'));
const bk = path.join(tmp, 'my backups');
let server: import('http').Server;
let base = '';

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

before(async () => {
  process.chdir(tmp);
  fs.writeFileSync('settings.json', JSON.stringify({ ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434' }, backups: { enabled: false, keep: 7, dir: bk } }));
  const express = (await import('express')).default;
  const { apiRouter } = await import(pathToFileURL(path.join(studioRoot, 'api', 'router.ts')).href);
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api', apiRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  const { stopPreviewServer } = await import(pathToFileURL(path.join(studioRoot, 'api', 'preview.ts')).href);
  await stopPreviewServer();
  server?.close();
  process.chdir(studioRoot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('backup: all projects in one zip, without packages / builds / trash; old backups pruned', { timeout: 60_000 }, async () => {
  const a = (await api('POST', '/api/projects', { name: 'Альфа', files: [{ name: 'main.py', content: 'print("a")' }, { name: 'data/x.csv', content: '1,2' }] })).data;
  const b = (await api('POST', '/api/projects', { name: 'Бета', files: [{ name: 'app.js', content: 'console.log(1)' }] })).data;
  const gone = (await api('POST', '/api/projects', { name: 'trashed', files: [] })).data;
  await api('DELETE', `/api/projects/${gone.id}`);
  fs.mkdirSync(path.join(tmp, 'projects', a.id, '.packages', 'python'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'projects', a.id, '.packages', 'python', 'big.py'), 'x');
  fs.mkdirSync(path.join(tmp, 'projects', a.id, 'dist'));
  fs.writeFileSync(path.join(tmp, 'projects', a.id, 'dist', 'app.exe'), 'MZ');

  const info = (await api('GET', '/api/backups')).data;
  assert.equal(info.dir, bk);
  assert.deepEqual(info.backups, []);

  const made = await api('POST', '/api/backups/now');
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal(made.data.projects, 2);
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(bk, made.data.file)));
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  assert.ok(names.includes(`projects/${a.id}/main.py`));
  assert.ok(names.includes(`projects/${a.id}/data/x.csv`));
  assert.ok(names.includes(`projects/${b.id}/app.js`));
  assert.ok(!names.some((n) => n.includes('.packages') || n.includes('/dist/') || n.includes('.trash')), names.join('\n'));
  assert.deepEqual(JSON.parse(await zip.file('backup.json')!.async('string')).projects.map((p: any) => p.name).sort(), ['Альфа', 'Бета']);

  // Keep only the 2 newest
  assert.equal((await api('PUT', '/api/backups/settings', { keep: 2 })).status, 200);
  await api('POST', '/api/backups/now');
  await api('POST', '/api/backups/now');
  const list = (await api('GET', '/api/backups')).data.backups;
  assert.equal(list.length, 2);
  assert.ok(!list.some((x: any) => x.file === made.data.file), 'the oldest backup was removed');

  // Bad settings
  assert.equal((await api('PUT', '/api/backups/settings', { keep: 0 })).status, 400);
  assert.equal((await api('PUT', '/api/backups/settings', { dir: 'relative/path' })).status, 400);
});

test('restore: a project from a backup comes back as a new project; nothing escapes its folder', { timeout: 60_000 }, async () => {
  const [latest] = (await api('GET', '/api/backups')).data.backups;
  const inside = (await api('GET', `/api/backups/${latest.file}/projects`)).data.projects;
  const alpha = inside.find((p: any) => p.name === 'Альфа');
  const r = await api('POST', `/api/backups/${latest.file}/restore`, { id: alpha.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.name, /^Альфа \(\d{2}\.\d{2} \d{2}:\d{2}\)$/);
  const restored = (await api('GET', `/api/projects/${r.data.id}`)).data;
  assert.deepEqual(restored.files.map((f: any) => f.name).sort(), ['data/x.csv', 'main.py']);
  // The original is untouched
  assert.equal((await api('GET', `/api/projects/${alpha.id}`)).data.name, 'Альфа');

  // A crafted backup with "../" paths cannot write outside the project
  const evil = new JSZip();
  evil.file('backup.json', JSON.stringify({ projects: [{ id: 'evil', name: 'evil' }] }));
  evil.file('projects/evil/.scriptcraft.json', JSON.stringify({ id: 'evil', name: 'evil', files: [] }));
  evil.file('projects/evil/../../escaped.txt', 'x');
  const evilName = 'scriptcraft-backup-2020-01-01_00-00-00.zip';
  fs.writeFileSync(path.join(bk, evilName), await evil.generateAsync({ type: 'nodebuffer' }));
  const e = await api('POST', `/api/backups/${evilName}/restore`, { id: 'evil' });
  assert.equal(e.status, 200);
  assert.equal(fs.existsSync(path.join(tmp, 'escaped.txt')), false);
  assert.equal(fs.existsSync(path.join(tmp, 'projects', 'escaped.txt')), false);

  assert.equal((await api('GET', '/api/backups/..%2Fsettings.json/projects')).status, 400);
  assert.equal((await api('POST', `/api/backups/${latest.file}/restore`, { id: 'nope' })).status, 404);
});

test('backup: a big file goes into the archive whole (streamed, not held in memory)', { timeout: 120_000 }, async () => {
  const p = (await api('POST', '/api/projects', { name: 'big', files: [{ name: 'main.py', content: 'print(1)' }] })).data;
  // 12 MB of varied bytes: above the streaming threshold, poorly compressible
  const big = Buffer.alloc(12 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
  fs.writeFileSync(path.join(tmp, 'projects', p.id, 'video.bin'), big);
  const made = await api('POST', '/api/backups/now');
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(bk, made.data.file)));
  const inZip = await zip.file(`projects/${p.id}/video.bin`)!.async('nodebuffer');
  assert.ok(inZip.equals(big));
  assert.ok(!fs.readdirSync(bk).some((f) => f.endsWith('.part')), 'no half-written archive left');
  await api('DELETE', `/api/projects/${p.id}`);
});
