// Formatting and checks: Prettier (JS/CSS/JSON...) and Ruff (Python).
// Run with: npm test   (Ruff tests are skipped until Ruff is installed: editor status bar → "Ruff: install")
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-tools-test-'));
let server: import('http').Server;
let base = '';
let hasRuff = false;

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
  hasRuff = (await api('GET', '/api/code/tools')).data.ruff;
});

after(async () => {
  const { stopPreviewServer } = await import(pathToFileURL(path.join(studioRoot, 'api', 'preview.ts')).href);
  await stopPreviewServer();
  server?.close();
  process.chdir(studioRoot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('prettier formats JS, CSS and JSON; syntax errors are reported, not crashed on', async () => {
  const js = await api('POST', '/api/code/format', { name: 'src/app.js', code: "const a = {b:1,c:[1,2,3]}\nfunction f(x){return x*2}" });
  assert.equal(js.data.code, 'const a = { b: 1, c: [1, 2, 3] };\nfunction f(x) {\n  return x * 2;\n}\n');
  const css = await api('POST', '/api/code/format', { name: 'style.css', code: 'body{margin:0;color:red}' });
  assert.equal(css.data.code, 'body {\n  margin: 0;\n  color: red;\n}\n');
  const json = await api('POST', '/api/code/format', { name: 'data.json', code: '{"a":1,"b":[true,null]}' });
  assert.equal(json.data.code, '{ "a": 1, "b": [true, null] }\n');
  const bad = await api('POST', '/api/code/format', { name: 'broken.js', code: 'function (' });
  assert.equal(bad.status, 422);
  assert.ok(bad.data.error);
});

test('format: unknown types and unsafe names are rejected', async () => {
  assert.equal((await api('POST', '/api/code/format', { name: 'a.xyz', code: 'x' })).status, 400);
  assert.equal((await api('POST', '/api/code/format', { name: '../../a.js', code: 'x' })).status, 400);
  assert.equal((await api('POST', '/api/code/format', { name: 'a.js' })).status, 400);
  // Linting other languages is a no-op
  assert.deepEqual((await api('POST', '/api/code/lint', { name: 'a.js', code: 'x' })).data, { diagnostics: [] });
});

test('ruff formats Python like Black', async (t) => {
  if (!hasRuff) return t.skip('ruff not installed');
  const r = await api('POST', '/api/code/format', { name: 'main.py', code: "x=1\ndef f( a ,b ):\n  return {'a':a,'b':b}\n" });
  assert.equal(r.data.code, 'x = 1\n\n\ndef f(a, b):\n    return {"a": a, "b": b}\n');
  const bad = await api('POST', '/api/code/format', { name: 'main.py', code: 'def f(:\n' });
  assert.equal(bad.status, 422);
});

test('ruff finds problems with positions and automatic fixes', async (t) => {
  if (!hasRuff) return t.skip('ruff not installed');
  const code = 'import os\nprint(undefined_name)\n';
  const { diagnostics } = (await api('POST', '/api/code/lint', { name: 'main.py', code })).data;
  const unused = diagnostics.find((d: any) => d.code === 'F401');
  const undefinedName = diagnostics.find((d: any) => d.code === 'F821');
  assert.ok(unused && undefinedName, JSON.stringify(diagnostics));
  assert.deepEqual([unused.line, unused.column, unused.endLine, unused.endColumn], [1, 8, 1, 10]);
  assert.equal(undefinedName.severity, 'error');
  assert.equal(undefinedName.line, 2);
  assert.ok(unused.fix?.edits?.length, 'unused import has a fix');

  const fixed = (await api('POST', '/api/code/fix', { name: 'main.py', code })).data.code;
  assert.equal(fixed, 'print(undefined_name)\n');

  // A syntax error comes back as a diagnostic
  const syntax = (await api('POST', '/api/code/lint', { name: 'main.py', code: 'def f(:\n' })).data.diagnostics;
  assert.ok(syntax.some((d: any) => d.severity === 'error'));
});
