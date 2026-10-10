// "Publish to GitHub": a fake GitHub CLI (tests/fixtures/fake-gh.mjs) pushes into a local bare repository.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-github-test-'));
const remotes = path.join(tmp, 'remotes');
const hasGit = spawnSync('git', ['--version']).status === 0;
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
  fs.mkdirSync(remotes);
  process.env.SCRIPTCRAFT_GH_SCRIPT = path.join(studioRoot, 'tests', 'fixtures', 'fake-gh.mjs');
  process.env.FAKE_GH_REMOTES = remotes;
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
  delete process.env.SCRIPTCRAFT_GH_SCRIPT;
  const { stopPreviewServer } = await import(pathToFileURL(path.join(studioRoot, 'api', 'preview.ts')).href);
  await stopPreviewServer();
  server?.close();
  process.chdir(studioRoot);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('publish: signed-out state, then a private repository with the project and a first commit', { skip: !hasGit && 'git not installed' }, async () => {
  const p = (
    await api('POST', '/api/projects', { name: 'pub', files: [{ name: 'main.py', content: 'print("hi")\n' }, { name: 'README.md', content: '# Hi\n' }] })
  ).data;
  const g = `/api/git/${p.id}`;
  await api('PUT', `/api/projects/${p.id}/run-config`, { args: '', env: [{ key: 'TOKEN', value: 'never-published' }] });

  process.env.FAKE_GH_LOGGED = '0';
  assert.deepEqual((await api('GET', `${g}/github`)).data, {
    installed: true,
    account: null,
    remote: null,
    repoUrl: null,
    loginInStudio: process.platform === 'win32',
  });
  assert.equal((await api('POST', `${g}/github/publish`, { name: 'pub' })).status, 409);

  process.env.FAKE_GH_LOGGED = '1';
  assert.equal((await api('GET', `${g}/github`)).data.account, 'TestUser');
  assert.equal((await api('POST', `${g}/github/publish`, { name: 'bad name!' })).status, 400);

  // The author is needed for the first commit (repo-local, independent of this PC)
  await api('POST', `${g}/init`);
  await api('POST', `${g}/identity`, { name: 'Test User', email: 'test@example.com' });
  const r = await api('POST', `${g}/github/publish`, { name: 'my-project', visibility: 'private', description: 'Тестовый\nпроект' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.url, 'https://github.com/TestUser/my-project');
  assert.equal(r.data.visibility, 'private');
  assert.deepEqual(r.data.files, []);

  // What reached the "GitHub" repository: the project files, never the studio's service files or .env
  const bare = path.join(remotes, 'my-project.git');
  const tree = spawnSync('git', ['-C', bare, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf-8' }).stdout.split('\n').filter(Boolean).sort();
  assert.deepEqual(tree, ['.gitignore', 'README.md', 'main.py']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(remotes, 'my-project.json'), 'utf-8')), { visibility: 'private', description: 'Тестовый проект' });

  // Connected now: the link is shown, a second publish is refused
  const info = (await api('GET', `${g}/github`)).data;
  assert.equal(info.remote, 'https://github.com/TestUser/my-project.git');
  assert.equal(info.repoUrl, 'https://github.com/TestUser/my-project');
  assert.equal((await api('POST', `${g}/github/publish`, { name: 'again' })).status, 409);
  await api('DELETE', `/api/projects/${p.id}`);
});
