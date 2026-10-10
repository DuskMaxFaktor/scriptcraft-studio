// The agent's access to files outside the project: reading, writing with a backup copy, and the places
// it must never touch (the studio itself, .env files). Everything happens in temporary folders.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-agentfs-'));
// The studio's data folder (projects, .env, settings) and, apart from it, the user's own files
const data = path.join(tmp, 'studio-data');
const outside = path.join(tmp, 'Мои файлы');
const backups = path.join(tmp, 'backups');
let afs: typeof import('../api/agentfs.ts');

before(async () => {
  fs.mkdirSync(data);
  fs.mkdirSync(outside);
  process.chdir(data);
  fs.writeFileSync('settings.json', JSON.stringify({ ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434' }, backups: { enabled: false, keep: 7, dir: backups } }));
  fs.writeFileSync('.env', 'GEMINI_API_KEY="secret"\n');
  afs = await import(pathToFileURL(path.join(studioRoot, 'api', 'agentfs.ts')).href);
});

after(() => {
  process.chdir(studioRoot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('read: a file gives its text, a folder its entries, a missing path says so', () => {
  fs.writeFileSync(path.join(outside, 'заметки.txt'), 'привет\n');
  fs.mkdirSync(path.join(outside, 'sub'));
  const file = afs.readExternal(path.join(outside, 'заметки.txt'));
  assert.equal(file.kind, 'file');
  assert.equal(file.kind === 'file' && file.content, 'привет\n');

  const dir = afs.readExternal(outside);
  assert.equal(dir.kind, 'dir');
  const names = dir.kind === 'dir' ? dir.entries.map((e) => `${e.name}${e.dir ? '/' : ''}`).sort() : [];
  assert.deepEqual(names, ['sub/', 'заметки.txt']);

  assert.equal(afs.readExternal(path.join(outside, 'нет.txt')).kind, 'missing');
});

test('read: binary files are not shown, big files are cut', () => {
  fs.writeFileSync(path.join(outside, 'app.exe'), Buffer.from([0x4d, 0x5a, 0, 0, 1, 2]));
  assert.equal(afs.readExternal(path.join(outside, 'app.exe')).kind, 'binary');
  fs.writeFileSync(path.join(outside, 'big.log'), 'x'.repeat(300 * 1024));
  const big = afs.readExternal(path.join(outside, 'big.log'));
  assert.ok(big.kind === 'file' && big.truncated && big.content.length === 200 * 1024);
});

test('never: relative paths, .env files, the studio data folder or the studio itself', () => {
  for (const p of ['notes.txt', '..\\secret.txt', path.join(outside, '.env'), path.join(outside, '.env.local'), path.join(data, 'settings.json'), path.join(data, 'projects', 'x', 'main.py'), path.join(studioRoot, 'package.json')]) {
    const r = afs.readExternal(p);
    assert.equal(r.kind, 'error', `reading ${p} must be refused`);
    const [w] = afs.writeExternal([{ path: p, content: 'x' }]);
    assert.equal(w.ok, false, `writing ${p} must be refused`);
  }
  // Nothing was created or changed
  assert.equal(fs.readFileSync(path.join(data, '.env'), 'utf-8'), 'GEMINI_API_KEY="secret"\n');
  assert.equal(fs.existsSync(path.join(outside, '.env')), false);
});

test('write: a new file is created (with its folders), an existing one is backed up first', () => {
  const fresh = path.join(outside, 'new', 'deep', 'a.txt');
  const [created] = afs.writeExternal([{ path: fresh, content: 'один' }], 'stamp1');
  assert.ok(created.ok && created.created && created.backup === null);
  assert.equal(fs.readFileSync(fresh, 'utf-8'), 'один');

  const [over] = afs.writeExternal([{ path: fresh, content: 'два' }], 'stamp2');
  assert.ok(over.ok && !over.created && over.backup);
  assert.equal(fs.readFileSync(fresh, 'utf-8'), 'два');
  // The old version is kept in the backups folder, under the original path
  assert.ok(over.ok && over.backup!.startsWith(path.join(backups, 'agent', 'stamp2')));
  assert.equal(fs.readFileSync(over.ok ? over.backup! : '', 'utf-8'), 'один');
});

test('write: a folder is never replaced by a file', () => {
  const [r] = afs.writeExternal([{ path: path.join(outside, 'sub'), content: 'x' }]);
  assert.equal(r.ok, false);
  assert.ok(fs.statSync(path.join(outside, 'sub')).isDirectory());
});
