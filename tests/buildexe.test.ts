// "Build .exe": PyInstaller turns a Python project (with a module and a data file) into one program.
// Run with: npm test   (skipped until PyInstaller is installed: "Export" → "Build .exe" → "Install")
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-exe-test-'));
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
  // An antivirus may still be scanning the fresh .exe: a leftover temp folder is not a test failure
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // the OS cleans its temp folder
  }
});

test('build exe: project module + data file packed into one program that runs', { timeout: 300_000 }, async (t) => {
  const p = (
    await api('POST', '/api/projects', {
      name: 'exe',
      files: [
        { name: 'main.py', isEntry: true, content: 'import sys, os\nfrom helper import greet\nbase = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))\nprint(greet(open(os.path.join(base, "data", "name.txt"), encoding="utf-8").read().strip()))\n' },
        { name: 'helper.py', content: 'def greet(n):\n    return f"Привет, {n}!"\n' },
        { name: 'data/name.txt', content: 'Аня\n' },
      ],
    })
  ).data;
  const info = (await api('GET', `/api/projects/${p.id}/exe`)).data;
  if (!info.pyinstaller) return t.skip('PyInstaller not installed');

  // Unsafe or wrong entries are refused
  assert.equal((await api('POST', `/api/projects/${p.id}/exe/build`, { entry: '../x.py' })).status, 400);
  assert.equal((await api('POST', `/api/projects/${p.id}/exe/build`, { entry: 'data/name.txt' })).status, 400);
  assert.equal((await api('POST', `/api/projects/${p.id}/exe/build`, { entry: 'main.py', name: 'a&calc' })).status, 400);

  const start = await api('POST', `/api/projects/${p.id}/exe/build`, { entry: 'main.py', name: 'Приветствие' });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const events = await (await fetch(`${base}/api/run/${start.data.runId}/events`)).text();
  const exit = events.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).find((e) => e.type === 'exit');
  assert.equal(exit?.code, 0, events.slice(-2000));

  const builds = (await api('GET', `/api/projects/${p.id}/exe`)).data.builds;
  assert.equal(builds[0].path, start.data.exe);
  const exe = path.join(tmp, 'projects', p.id, start.data.exe);
  const run = spawnSync(exe, [], { timeout: 60_000 });
  // A frozen program writes to a pipe in the Windows code page (a console window shows Unicode either way)
  const out = [new TextDecoder('utf-8', { fatal: false }), new TextDecoder('windows-1251')].map((d) => d.decode(run.stdout).trim());
  assert.ok(out.includes('Привет, Аня!'), `${out.join(' | ')} ${run.stderr}`);
  // No build leftovers in the project
  assert.equal(fs.existsSync(path.join(tmp, 'projects', p.id, 'build')), false);
  assert.equal(fs.readdirSync(path.join(tmp, 'projects', p.id)).some((f) => f.endsWith('.spec')), false);
  await api('DELETE', `/api/projects/${p.id}`);
});
