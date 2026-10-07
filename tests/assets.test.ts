// "Other files" of a project (images, SQLite databases...) and serving them safely to the viewers.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-assets-test-'));
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

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  process.chdir(tmp);
  fs.writeFileSync('settings.json', JSON.stringify({ ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434' } }));
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

test('assets: binary files a program created are listed by kind; text files and service folders are not', async () => {
  const p = (await api('POST', '/api/projects', { name: 'assets', files: [{ name: 'main.py', content: 'print(1)' }] })).data;
  const dir = path.join(tmp, 'projects', p.id);
  fs.mkdirSync(path.join(dir, 'img'));
  fs.writeFileSync(path.join(dir, 'img', 'logo.png'), PNG);
  fs.writeFileSync(path.join(dir, 'data.db'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)]));
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'text, shown in the explorer after a rescan');
  fs.mkdirSync(path.join(dir, '.packages', 'python'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.packages', 'python', 'x.png'), PNG);
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.writeFileSync(path.join(dir, 'dist', 'app.exe'), Buffer.from([0, 0]));

  const { assets } = (await api('GET', `/api/projects/${p.id}/assets`)).data;
  assert.deepEqual(
    assets.map((a: any) => [a.name, a.kind]),
    [
      ['blob.bin', 'binary'],
      ['data.db', 'sqlite'],
      ['img/logo.png', 'image'],
    ]
  );
  await api('DELETE', `/api/projects/${p.id}`);
});

test('raw files: right type, cannot run scripts on the studio address, no service files, no traversal', async () => {
  const p = (await api('POST', '/api/projects', { name: 'raw', files: [{ name: 'main.py', content: 'print(1)' }] })).data;
  const dir = path.join(tmp, 'projects', p.id);
  fs.writeFileSync(path.join(dir, 'pic.png'), PNG);
  fs.writeFileSync(path.join(dir, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=secret');

  const png = await fetch(`${base}/api/projects/${p.id}/raw?path=pic.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), PNG);

  const svg = await fetch(`${base}/api/projects/${p.id}/raw?path=evil.svg`);
  assert.match(svg.headers.get('content-security-policy') || '', /sandbox/);
  assert.match(svg.headers.get('content-security-policy') || '', /default-src 'none'/);
  assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');

  for (const bad of ['.env', '../settings.json', '..%2F..%2Fsettings.json', '.scriptcraft.json', 'missing.png']) {
    const r = await fetch(`${base}/api/projects/${p.id}/raw?path=${bad}`);
    assert.ok(r.status === 400 || r.status === 404, `${bad}: ${r.status}`);
  }
  await api('DELETE', `/api/projects/${p.id}`);
});
