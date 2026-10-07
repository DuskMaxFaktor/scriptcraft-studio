// Trash for projects: a deleted project can be restored for 30 days.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-trash-test-'));
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

test('trash: delete moves a project to the trash, restore brings it back with its files', async () => {
  const p = (await api('POST', '/api/projects', { name: 'Важный проект', files: [{ name: 'main.py', content: 'print("v1")' }, { name: 'data/a.txt', content: 'x' }] })).data;
  // A watched project (the open studio watches its folder) can still be deleted
  const watch = await fetch(`${base}/api/projects/${p.id}/watch`);
  const del = await api('DELETE', `/api/projects/${p.id}`);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  await watch.body?.cancel().catch(() => {});
  assert.equal((await api('GET', `/api/projects/${p.id}`)).status, 404);
  assert.ok(!(await api('GET', '/api/projects')).data.projects.some((x: any) => x.id === p.id));

  const trash = (await api('GET', '/api/trash')).data;
  assert.equal(trash.days, 30);
  const entry = trash.projects.find((x: any) => x.id === p.id);
  assert.equal(entry.name, 'Важный проект');
  assert.equal(entry.fileCount, 2);

  const restored = (await api('POST', `/api/trash/${entry.trashId}/restore`)).data;
  assert.equal(restored.id, p.id);
  const back = (await api('GET', `/api/projects/${p.id}`)).data;
  assert.deepEqual(back.files.map((f: any) => [f.name, f.content]).sort(), [['data/a.txt', 'x'], ['main.py', 'print("v1")']]);
  assert.equal((await api('GET', '/api/trash')).data.projects.length, 0);
  await api('DELETE', `/api/projects/${p.id}`);
  await api('DELETE', '/api/trash');
});

test('trash: restoring when the id is taken gets a new id; delete forever and empty trash', async () => {
  const a = (await api('POST', '/api/projects', { name: 'demo', files: [{ name: 'old.py', content: 'old' }] })).data;
  await api('DELETE', `/api/projects/${a.id}`);
  const b = (await api('POST', '/api/projects', { name: 'demo', files: [{ name: 'new.py', content: 'new' }] })).data;
  assert.equal(b.id, a.id); // the name is free again
  const [entry] = (await api('GET', '/api/trash')).data.projects;
  const restored = (await api('POST', `/api/trash/${entry.trashId}/restore`)).data;
  assert.notEqual(restored.id, a.id);
  assert.equal((await api('GET', `/api/projects/${restored.id}`)).data.files[0].content, 'old');
  assert.equal((await api('GET', `/api/projects/${b.id}`)).data.files[0].content, 'new');

  await api('DELETE', `/api/projects/${restored.id}`);
  await api('DELETE', `/api/projects/${b.id}`);
  const two = (await api('GET', '/api/trash')).data.projects;
  assert.equal(two.length, 2);
  assert.equal((await api('DELETE', `/api/trash/${two[0].trashId}`)).status, 200);
  assert.equal((await api('GET', '/api/trash')).data.projects.length, 1);
  await api('DELETE', '/api/trash');
  assert.equal((await api('GET', '/api/trash')).data.projects.length, 0);

  // Bad ids
  assert.equal((await api('POST', '/api/trash/..%2F..%2Fapi/restore')).status, 400);
  assert.equal((await api('DELETE', '/api/trash/nope~123')).status, 400);
  assert.equal((await api('POST', '/api/trash/nope~1791281517117/restore')).status, 404);
});

test('trash: projects deleted more than 30 days ago are removed for good', async () => {
  const p = (await api('POST', '/api/projects', { name: 'old', files: [] })).data;
  await api('DELETE', `/api/projects/${p.id}`);
  const [entry] = (await api('GET', '/api/trash')).data.projects;
  const marker = path.join(tmp, 'projects', '.trash', entry.trashId, '.deleted.json');
  fs.writeFileSync(marker, JSON.stringify({ deletedAt: Date.now() - 31 * 24 * 3600 * 1000 }));
  assert.equal((await api('GET', '/api/trash')).data.projects.length, 0);
  assert.equal(fs.existsSync(path.dirname(marker)), false);
});
