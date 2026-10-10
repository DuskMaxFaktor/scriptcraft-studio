// Git API tests: a project in a temporary folder goes through init, commit, diff, discard and history.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-git-test-'));
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
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('git: init, commit, diff, discard, history', { skip: !hasGit && 'git not installed' }, async () => {
  const p = (
    await api('POST', '/api/projects', {
      name: 'repo',
      files: [
        { name: 'main.py', content: 'print("v1")\n', isEntry: true },
        { name: 'lib/util.py', content: 'X = 1\n' },
      ],
    })
  ).data;
  const g = `/api/git/${p.id}`;

  assert.equal((await api('GET', `${g}/status`)).data.repo, false);
  let s = (await api('POST', `${g}/init`)).data;
  assert.equal(s.repo, true);
  const ignore = fs.readFileSync(path.join(tmp, 'projects', p.id, '.gitignore'), 'utf-8');
  for (const entry of ['.scriptcraft.json', '.scriptcraft-chat.json', '.history/', '.packages/']) assert.ok(ignore.includes(entry), entry);
  // Studio service files are not offered for commit
  assert.deepEqual(s.files.map((f: any) => f.path).sort(), ['.gitignore', 'lib/util.py', 'main.py']);
  assert.ok(s.files.every((f: any) => f.status === '?'));

  // Repo-local identity, so the test does not depend on the PC's git config
  assert.equal((await api('POST', `${g}/identity`, { name: 'Test', email: 'nope' })).status, 400);
  s = (await api('POST', `${g}/identity`, { name: 'Test User', email: 'test@example.com' })).data;
  assert.equal(s.identity, true);

  assert.equal((await api('POST', `${g}/commit`, { message: '  ' })).status, 400);
  s = (await api('POST', `${g}/commit`, { message: 'Первый коммит' })).data;
  assert.deepEqual(s.files, []);
  assert.equal(s.hasCommits, true);
  assert.ok(s.branch);

  // Edit through the studio (as the editor's autosave does) and see the change
  await api('PUT', `/api/projects/${p.id}`, {
    files: [
      { name: 'main.py', content: 'print("v2")\n', isEntry: true },
      { name: 'lib/util.py', content: 'X = 1\n' },
      { name: 'new.py', content: 'NEW = True\n' },
    ],
  });
  s = (await api('GET', `${g}/status`)).data;
  const byPath = Object.fromEntries(s.files.map((f: any) => [f.path, f.status]));
  assert.deepEqual(byPath, { 'main.py': 'M', 'new.py': '?' });

  const diff = (await api('GET', `${g}/diff?path=main.py`)).data;
  assert.equal(diff.original, 'print("v1")\n');
  assert.equal(diff.modified, 'print("v2")\n');

  // Commit only one file
  s = (await api('POST', `${g}/commit`, { message: 'Добавлен new.py', paths: ['new.py'] })).data;
  assert.deepEqual(s.files.map((f: any) => f.path), ['main.py']);

  // Discard: back to the committed version
  s = (await api('POST', `${g}/discard`, { path: 'main.py' })).data;
  assert.deepEqual(s.files, []);
  assert.equal(fs.readFileSync(path.join(tmp, 'projects', p.id, 'main.py'), 'utf-8'), 'print("v1")\n');

  // Discarding an untracked file deletes it
  fs.writeFileSync(path.join(tmp, 'projects', p.id, 'scratch.txt'), 'tmp');
  await api('POST', `${g}/discard`, { path: 'scratch.txt' });
  assert.equal(fs.existsSync(path.join(tmp, 'projects', p.id, 'scratch.txt')), false);

  const log = (await api('GET', `${g}/log`)).data.commits;
  assert.deepEqual(log.map((c: any) => c.subject), ['Добавлен new.py', 'Первый коммит']);
  assert.equal(log[0].author, 'Test User');
  const changed = (await api('GET', `${g}/commit/${log[0].hash}`)).data.files;
  assert.deepEqual(changed, [{ status: 'A', path: 'new.py' }]);

  await api('DELETE', `/api/projects/${p.id}`);
});

test('git: unsafe paths, remotes and ids are rejected', { skip: !hasGit && 'git not installed' }, async () => {
  const p = (await api('POST', '/api/projects', { name: 'safe', files: [{ name: 'a.py', content: 'x' }] })).data;
  const g = `/api/git/${p.id}`;
  await api('POST', `${g}/init`);
  for (const bad of ['../../server.ts', '..\\x', 'C:/Windows/win.ini', '/etc/passwd', '.git/config', '.GIT/config', 'sub/.Git/HEAD']) {
    assert.equal((await api('GET', `${g}/diff?path=${encodeURIComponent(bad)}`)).status, 400, bad);
    assert.equal((await api('POST', `${g}/discard`, { path: bad })).status, 400, bad);
  }
  for (const bad of ['ext::sh -c calc', 'file:///C:/repo', 'C:\\repo', '--upload-pack=calc', 'http://insecure/repo.git']) {
    assert.equal((await api('POST', `${g}/remote`, { url: bad })).status, 400, bad);
  }
  const ok = await api('POST', `${g}/remote`, { url: 'https://github.com/example/repo.git' });
  assert.equal(ok.data.remote, 'https://github.com/example/repo.git');
  assert.equal((await api('GET', '/api/git/..%2F..%2Fapi/status')).status, 400);
  assert.equal((await api('GET', '/api/git/missing-project/status')).status, 404);
  assert.equal((await api('GET', `${g}/commit/not-a-hash;rm`)).status, 400);
  await api('DELETE', `/api/projects/${p.id}`);
});

test('git: branches — create, switch (not with changes), delete only merged; file history', { skip: !hasGit && 'git not installed' }, async () => {
  const p = (await api('POST', '/api/projects', { name: 'branches', files: [{ name: 'app.py', content: 'v = 1\n', isEntry: true }] })).data;
  const g = `/api/git/${p.id}`;
  const file = path.join(tmp, 'projects', p.id, 'app.py');
  await api('POST', `${g}/init`);
  await api('POST', `${g}/identity`, { name: 'Test User', email: 'test@example.com' });

  // No branches before the first commit
  assert.equal((await api('POST', `${g}/branches`, { name: 'feature' })).status, 409);
  assert.equal((await api('POST', `${g}/commit`, { message: 'first' })).status, 200);
  const main = (await api('GET', `${g}/branches`)).data.current;
  assert.ok(main);

  // Invalid names are refused
  for (const bad of ['-x', 'a b', 'a..b', '']) assert.equal((await api('POST', `${g}/branches`, { name: bad })).status, 400, bad);

  // Create + switch, commit on the branch
  let s = (await api('POST', `${g}/branches`, { name: 'feature/fast' })).data;
  assert.equal(s.branch, 'feature/fast');
  fs.writeFileSync(file, 'v = 2\n');
  await api('POST', `${g}/commit`, { message: 'faster' });
  const list = (await api('GET', `${g}/branches`)).data;
  assert.deepEqual(list.branches.map((b: any) => b.name).sort(), ['feature/fast', main].sort());
  assert.equal(list.current, 'feature/fast');

  // Switching with uncommitted changes is refused; after a commit it works and files follow the branch
  fs.writeFileSync(file, 'v = 3\n');
  assert.equal((await api('POST', `${g}/switch`, { name: main })).status, 409);
  await api('POST', `${g}/discard`, { path: 'app.py' });
  s = (await api('POST', `${g}/switch`, { name: main })).data;
  assert.equal(s.branch, main);
  assert.equal(fs.readFileSync(file, 'utf-8'), 'v = 1\n');

  // An unmerged branch is not deleted; the current branch never
  assert.equal((await api('POST', `${g}/branches/delete`, { name: 'feature/fast' })).status, 409);
  assert.equal((await api('POST', `${g}/branches/delete`, { name: main })).status, 409);
  // After merging (fast-forward) it can be deleted
  spawnSync('git', ['-C', path.join(tmp, 'projects', p.id), 'merge', '--ff-only', 'feature/fast']);
  assert.equal((await api('POST', `${g}/branches/delete`, { name: 'feature/fast' })).status, 200);

  // File history and the file before/after a commit
  const hist = (await api('GET', `${g}/file-log?path=app.py`)).data.commits;
  assert.deepEqual(hist.map((c: any) => c.subject), ['faster', 'first']);
  const at = (await api('GET', `${g}/file-at?path=app.py&hash=${hist[0].hash}`)).data;
  assert.equal(at.original, 'v = 1\n');
  assert.equal(at.modified, 'v = 2\n');
  const first = (await api('GET', `${g}/file-at?path=app.py&hash=${hist[1].hash}`)).data;
  assert.equal(first.original, '');
  assert.equal((await api('GET', `${g}/file-log?path=..%2Fx`)).status, 400);
  await api('DELETE', `/api/projects/${p.id}`);
});

test('git: merge — clean merge, conflict with both sides shown, abort, resolve and commit', { skip: !hasGit && 'git not installed' }, async () => {
  const p = (await api('POST', '/api/projects', { name: 'merge', files: [{ name: 'app.py', content: 'v = 1\n', isEntry: true }] })).data;
  const g = `/api/git/${p.id}`;
  const dir = path.join(tmp, 'projects', p.id);
  const file = path.join(dir, 'app.py');
  await api('POST', `${g}/init`);
  await api('POST', `${g}/identity`, { name: 'Test User', email: 'test@example.com' });
  await api('POST', `${g}/commit`, { message: 'first' });
  const main = (await api('GET', `${g}/branches`)).data.current;

  // Two branches change the same line
  await api('POST', `${g}/branches`, { name: 'feature' });
  fs.writeFileSync(file, 'v = 2\n');
  await api('POST', `${g}/commit`, { message: 'feature: two' });
  await api('POST', `${g}/switch`, { name: main });
  fs.writeFileSync(file, 'v = 3\n');
  await api('POST', `${g}/commit`, { message: 'main: three' });

  // Refusals
  assert.equal((await api('POST', `${g}/merge`, { name: main })).status, 400);
  fs.writeFileSync(file, 'v = 99\n');
  assert.equal((await api('POST', `${g}/merge`, { name: 'feature' })).status, 409);
  await api('POST', `${g}/discard`, { path: 'app.py' });

  // Conflict: the merge stays open and both sides can be seen
  let r = (await api('POST', `${g}/merge`, { name: 'feature' })).data;
  assert.equal(r.merged, false);
  assert.equal(r.merging, true);
  assert.equal(r.mergeBranch, 'feature');
  assert.deepEqual(r.conflicts, ['app.py']);
  const sides = (await api('GET', `${g}/conflict?path=app.py`)).data;
  assert.equal(sides.ours, 'v = 3\n');
  assert.equal(sides.theirs, 'v = 2\n');
  // The file still has conflict markers: cannot be marked as resolved by hand
  assert.equal((await api('POST', `${g}/conflict/resolve`, { path: 'app.py', take: 'edited' })).status, 409);

  // Abort: back to how it was
  r = (await api('POST', `${g}/merge/abort`)).data;
  assert.equal(r.merging, false);
  assert.equal(fs.readFileSync(file, 'utf-8'), 'v = 3\n');

  // Again, take the branch's version, then commit to finish the merge
  await api('POST', `${g}/merge`, { name: 'feature' });
  r = (await api('POST', `${g}/conflict/resolve`, { path: 'app.py', take: 'theirs' })).data;
  assert.equal(fs.readFileSync(file, 'utf-8'), 'v = 2\n');
  assert.ok(!r.files.some((f: any) => f.status === 'U'));
  r = (await api('POST', `${g}/commit`, { message: "Merge branch 'feature'" })).data;
  assert.equal(r.merging, false);
  const log = (await api('GET', `${g}/log`)).data.commits;
  assert.equal(log[0].subject, "Merge branch 'feature'");

  // A merge without conflicts finishes at once
  await api('POST', `${g}/branches`, { name: 'docs' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Docs\n');
  await api('POST', `${g}/commit`, { message: 'docs' });
  await api('POST', `${g}/switch`, { name: main });
  r = (await api('POST', `${g}/merge`, { name: 'docs' })).data;
  assert.equal(r.merged, true);
  assert.ok(fs.existsSync(path.join(dir, 'README.md')));
  assert.equal((await api('POST', `${g}/merge/abort`)).status, 409);
  await api('DELETE', `/api/projects/${p.id}`);
});
