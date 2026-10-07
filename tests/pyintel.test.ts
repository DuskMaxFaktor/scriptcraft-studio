// Python code intelligence (Jedi): completions, signatures, hover, go to definition and rename across files.
// Run with: npm test   (skipped until Jedi is installed: editor status bar → "Python hints: install")
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-pyintel-test-'));
let server: import('http').Server;
let base = '';
let hasJedi = false;
let projectId = '';

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const py = (op: string, name: string, code: string, line: number, column: number, more = {}) =>
  api('POST', `/api/code/py/${op}`, { name, code, line, column, projectId, ...more });

// (Jedi caches the code it is sent per file name, as the editor's live buffer: made-up snippets use their own name)
const HELPERS = 'def greet(name: str, excited: bool = False) -> str:\n    """Return a friendly greeting."""\n    return f"Hi, {name}" + ("!" if excited else "")\n';

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
  hasJedi = (await api('GET', '/api/code/tools')).data.jedi;
  projectId = (
    await api('POST', '/api/projects', {
      name: 'intel',
      files: [
        { name: 'helpers.py', content: HELPERS },
        { name: 'main.py', content: 'from helpers import greet\nprint(greet("Ann"))\n' },
      ],
    })
  ).data.id;
  // A package installed into the project with the "Packages" button
  const pkg = path.join(tmp, 'projects', projectId, '.packages', 'python', 'colorsx');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, '__init__.py'), 'def paint(text):\n    return text\n');
});

after(async () => {
  const { stopWorker } = await import(pathToFileURL(path.join(studioRoot, 'api', 'pyintel.ts')).href);
  stopWorker();
  const { stopPreviewServer } = await import(pathToFileURL(path.join(studioRoot, 'api', 'preview.ts')).href);
  await stopPreviewServer();
  server?.close();
  process.chdir(studioRoot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('completions: project modules, the standard library and project packages', { timeout: 60_000 }, async (t) => {
  if (!hasJedi) return t.skip('jedi not installed');
  const fromProject = (await py('complete', 'scratch.py', 'from helpers import gr', 1, 23)).data.items;
  const greet = fromProject.find((i: any) => i.name === 'greet');
  assert.ok(greet, JSON.stringify(fromProject));
  assert.equal(greet.type, 'function');
  assert.match(greet.signature, /greet\(name: str, excited: bool=False\) -> str/);
  assert.match(greet.doc, /friendly greeting/);

  const stdlib = (await py('complete', 'scratch.py', 'import os\nos.path.jo', 2, 11)).data.items.map((i: any) => i.name);
  assert.ok(stdlib.includes('join'));

  const pkg = (await py('complete', 'scratch.py', 'import colorsx\ncolorsx.pa', 2, 11)).data.items.map((i: any) => i.name);
  assert.deepEqual(pkg, ['paint']);
});

test('signature help and hover', { timeout: 60_000 }, async (t) => {
  if (!hasJedi) return t.skip('jedi not installed');
  const code = 'from helpers import greet\ngreet("Ann", ';
  const sig = (await py('signatures', 'scratch.py', code, 2, 14)).data.signatures[0];
  assert.match(sig.label, /^greet\(name: str, excited: bool=False\) -> str$/);
  assert.equal(sig.index, 1);
  assert.equal(sig.params.length, 2);
  const hover = (await py('hover', 'scratch.py', 'from helpers import greet\ngreet("Ann")\n', 2, 2)).data.items[0];
  assert.equal(hover.name, 'greet');
  assert.match(hover.doc, /friendly greeting/);
});

test('go to definition: into another project file, or a library', { timeout: 60_000 }, async (t) => {
  if (!hasJedi) return t.skip('jedi not installed');
  const inProject = (await py('definition', 'main.py', 'from helpers import greet\nprint(greet("Ann"))\n', 2, 8)).data.locations[0];
  assert.deepEqual([inProject.file, inProject.line, inProject.column, inProject.external], ['helpers.py', 1, 5, false]);
  const lib = (await py('definition', 'scratch.py', 'import json\njson.dumps({})\n', 2, 7)).data.locations[0];
  assert.equal(lib.external, true);
  assert.equal(lib.file, null);
  assert.equal(lib.name, 'dumps');
});

test('rename: every project file that uses the name changes, libraries never', { timeout: 60_000 }, async (t) => {
  if (!hasJedi) return t.skip('jedi not installed');
  const r = await py('rename', 'helpers.py', HELPERS, 1, 6, { newName: 'welcome' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const byName = Object.fromEntries(r.data.files.map((f: any) => [f.name, f.content]));
  assert.deepEqual(Object.keys(byName).sort(), ['helpers.py', 'main.py']);
  assert.match(byName['helpers.py'], /^def welcome\(name: str/);
  assert.equal(byName['main.py'], 'from helpers import welcome\nprint(welcome("Ann"))\n');
  assert.equal((await py('rename', 'helpers.py', HELPERS, 1, 6, { newName: 'not valid' })).status, 400);
  assert.equal((await py('complete', '../evil.py', 'x', 1, 1)).status, 400);
  assert.equal((await py('complete', 'notes.txt', 'x', 1, 1)).status, 400);
});
