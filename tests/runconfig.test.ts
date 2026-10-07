// Run parameters: environment variables in the project's .env and command-line arguments.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';
import { parseEnv, formatEnv, splitArgs } from '../api/runconfig.ts';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-runcfg-test-'));
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
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('.env parsing and writing round-trip; arguments split like a shell', () => {
  const vars = parseEnv('# comment\nexport A=1\nB="two words # not a comment"\nC=\'single\'\nD=plain # comment\n\nbad line\nE=\n');
  assert.deepEqual(vars, [
    { key: 'A', value: '1' },
    { key: 'B', value: 'two words # not a comment' },
    { key: 'C', value: 'single' },
    { key: 'D', value: 'plain' },
    { key: 'E', value: '' },
  ]);
  const tricky = [{ key: 'TOKEN', value: 'a "quoted" \\ value\nline2' }, { key: 'EMPTY', value: '' }];
  assert.deepEqual(parseEnv(formatEnv(tricky)), tricky);
  assert.deepEqual(splitArgs(`--name "Ann Lee" -v 'x y' ""`), ['--name', 'Ann Lee', '-v', 'x y', '']);
});

test('run parameters reach the program: env vars and arguments (shell characters stay plain text)', async () => {
  const code = "console.log(JSON.stringify({ token: process.env.BOT_TOKEN, greeting: process.env.GREETING, args: process.argv.slice(2) }))";
  const p = (await api('POST', '/api/projects', { name: 'params', files: [{ name: 'main.js', content: code, isEntry: true }] })).data;
  const saved = await api('PUT', `/api/projects/${p.id}/run-config`, {
    args: '--name "Ann Lee" a&calc (x)',
    env: [
      { key: 'BOT_TOKEN', value: '123:ABC def' },
      { key: 'GREETING', value: 'Привет' },
      { key: '', value: '' }, // empty rows of the dialog are ignored
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual((await api('GET', `/api/projects/${p.id}/run-config`)).data, {
    args: '--name "Ann Lee" a&calc (x)',
    env: [
      { key: 'BOT_TOKEN', value: '123:ABC def' },
      { key: 'GREETING', value: 'Привет' },
    ],
  });
  const r = await api('POST', '/api/run', { language: 'javascript', code, files: [{ name: 'main.js', content: code }], entry: 'main.js', projectId: p.id });
  assert.equal(r.data.exitCode, 0, r.data.stderr);
  assert.deepEqual(JSON.parse(r.data.stdout), { token: '123:ABC def', greeting: 'Привет', args: ['--name', 'Ann Lee', 'a&calc', '(x)'] });
  await api('DELETE', `/api/projects/${p.id}`);
});

test('.env is a service file: not listed, not overwritten or deleted by saves, ignored in git', async () => {
  const p = (await api('POST', '/api/projects', { name: 'secret', files: [{ name: 'main.py', content: 'print(1)' }] })).data;
  await api('PUT', `/api/projects/${p.id}/run-config`, { args: '', env: [{ key: 'TOKEN', value: 's3cret' }] });
  const envPath = path.join(tmp, 'projects', p.id, '.env');
  assert.equal(fs.existsSync(envPath), true);
  assert.deepEqual((await api('GET', `/api/projects/${p.id}`)).data.files.map((f: any) => f.name), ['main.py']);
  assert.deepEqual((await api('GET', `/api/projects/${p.id}?rescan=1`)).data.files.map((f: any) => f.name), ['main.py']);
  // An old client that still lists .env cannot overwrite it; a save without it does not delete it
  await api('PUT', `/api/projects/${p.id}`, { files: [{ name: 'main.py', content: 'print(2)' }, { name: '.env', content: 'TOKEN=hacked' }] });
  await api('PUT', `/api/projects/${p.id}`, { files: [{ name: 'main.py', content: 'print(3)' }] });
  assert.match(fs.readFileSync(envPath, 'utf-8'), /TOKEN=s3cret/);
  // Removing every variable removes the file
  await api('PUT', `/api/projects/${p.id}/run-config`, { args: '', env: [] });
  assert.equal(fs.existsSync(envPath), false);
  await api('DELETE', `/api/projects/${p.id}`);
});

test('run parameters: invalid names and dangerous argument characters are refused', async () => {
  const p = (await api('POST', '/api/projects', { name: 'bad', files: [] })).data;
  for (const key of ['1ABC', 'MY-VAR', 'A B']) {
    assert.equal((await api('PUT', `/api/projects/${p.id}/run-config`, { args: '', env: [{ key, value: 'x' }] })).status, 400, key);
  }
  for (const args of ['%PATH%', 'a^b', '!x!', 'line\nbreak']) {
    assert.equal((await api('PUT', `/api/projects/${p.id}/run-config`, { args, env: [] })).status, 400, args);
  }
  await api('DELETE', `/api/projects/${p.id}`);
});
