// API tests: the studio server runs in a temporary folder, so real projects/settings are never touched.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-test-'));
let base = '';
let server: import('http').Server;

const hasPython = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['--version'], { shell: true }).status === 0;

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

/** Read a run session's SSE stream until it exits; `onOutput` may react (e.g. send stdin). */
async function readSession(runId: string, onOutput?: (text: string) => Promise<void> | void) {
  const res = await fetch(`${base}/api/run/${runId}/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(i + 2);
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === 'exit') return { out, exit: ev };
      out += ev.data;
      await onOutput?.(out);
    }
  }
  return { out, exit: null };
}

before(async () => {
  process.chdir(tmp);
  // Disable Ollama discovery so tests don't depend on what is installed on this PC
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

// ---------------- projects ----------------

test('projects: create, read, rename, list, delete', async () => {
  const created = await api('POST', '/api/projects', {
    name: 'Тестовый проект',
    files: [
      { name: 'main.py', language: 'python', content: 'print(1)', isEntry: true },
      { name: 'lib/util.py', language: 'python', content: 'X = 1' },
    ],
  });
  assert.equal(created.status, 200);
  assert.match(created.data.id, /^testovyy-proekt/);
  assert.ok(fs.existsSync(path.join(tmp, 'projects', created.data.id, 'lib', 'util.py')), 'files are real files on disk');

  const got = await api('GET', `/api/projects/${created.data.id}`);
  assert.deepEqual(got.data.files.map((f: any) => f.name).sort(), ['lib/util.py', 'main.py']);
  assert.equal(got.data.files.find((f: any) => f.name === 'main.py').isEntry, true);

  await api('PUT', `/api/projects/${created.data.id}`, { name: 'Переименован' });
  const list = await api('GET', '/api/projects');
  assert.ok(list.data.projects.some((p: any) => p.name === 'Переименован'));

  assert.equal((await api('DELETE', `/api/projects/${created.data.id}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(tmp, 'projects', created.data.id)));
});

test('projects: file paths cannot escape the project folder or hit service files', async () => {
  const p = (await api('POST', '/api/projects', { name: 'paths', files: [] })).data;
  for (const bad of ['../evil.txt', 'a/../../evil.txt', '..', '.scriptcraft.json', '.history/x.txt', '.packages/x.py']) {
    const r = await api('PUT', `/api/projects/${p.id}`, { files: [{ name: bad, content: 'x' }] });
    assert.equal(r.status, 400, `"${bad}" must be rejected`);
  }
  assert.ok(!fs.existsSync(path.join(tmp, 'evil.txt')));
  assert.ok(!fs.existsSync(path.join(tmp, 'projects', 'evil.txt')));
  assert.equal((await api('GET', '/api/projects/..%2F..%2Fapi')).status, 400);
  await api('DELETE', `/api/projects/${p.id}`);
});

test('projects: version history keeps old and deleted content', async () => {
  const p = (await api('POST', '/api/projects', { name: 'history', files: [{ name: 'a.py', content: 'v1' }] })).data;
  await api('PUT', `/api/projects/${p.id}`, { files: [{ name: 'a.py', content: 'v2' }] });
  await api('PUT', `/api/projects/${p.id}`, { files: [{ name: 'a.py', content: 'v3' }] }); // within the interval: no snapshot
  await api('PUT', `/api/projects/${p.id}`, { files: [{ name: 'a.py', content: 'v4' }], snapshot: true }); // forced
  await api('PUT', `/api/projects/${p.id}`, { files: [] }); // delete keeps the last content

  const files = (await api('GET', `/api/projects/${p.id}/history`)).data.files;
  assert.deepEqual(files.map((f: any) => [f.name, f.deleted]), [['a.py', true]]);
  const versions = (await api('GET', `/api/projects/${p.id}/history/file?name=a.py`)).data.versions;
  const contents = [];
  for (const v of versions) contents.push((await api('GET', `/api/projects/${p.id}/history/version?name=a.py&ts=${v.ts}`)).data.content);
  assert.deepEqual(contents, ['v4', 'v3', 'v1']);
  await api('DELETE', `/api/projects/${p.id}`);
});

test('projects: chat history is stored per project', async () => {
  const p = (await api('POST', '/api/projects', { name: 'chat', files: [] })).data;
  assert.deepEqual((await api('GET', `/api/projects/${p.id}/chat`)).data.messages, []);
  const messages = [{ id: 'u1', role: 'user', text: 'привет', timestamp: '10:00' }];
  await api('PUT', `/api/projects/${p.id}/chat`, { messages });
  assert.deepEqual((await api('GET', `/api/projects/${p.id}/chat`)).data.messages, messages);
  await api('DELETE', `/api/projects/${p.id}`);
});

// ---------------- running code ----------------

test('run: JavaScript one-shot', async () => {
  const r = await api('POST', '/api/run', { language: 'javascript', code: 'console.log(6 * 7)' });
  assert.equal(r.data.success, true);
  assert.equal(r.data.stdout.trim(), '42');
});

test('run: files of a project can import each other', { skip: !hasPython && 'python not installed' }, async () => {
  const files = [
    { name: 'main.py', content: 'from pkg.helpers import double\nprint(double(21))' },
    { name: 'pkg/__init__.py', content: '' },
    { name: 'pkg/helpers.py', content: 'def double(x):\n    return x * 2' },
  ];
  const r = await api('POST', '/api/run', { language: 'python', code: files[0].content, files, entry: 'main.py' });
  assert.equal(r.data.stdout.trim(), '42', r.data.stderr);
});

test('run: a saved project runs in its own folder, so files the program writes stay in the project', async () => {
  // CommonJS require(): projects must not inherit "type": "module" from the studio's own package.json
  const files = [{ name: 'main.js', content: "require('fs').writeFileSync('out.txt', 'made by the program')" }];
  const p = (await api('POST', '/api/projects', { name: 'inplace', files })).data;
  const dir = path.join(tmp, 'projects', p.id);
  const r = await api('POST', '/api/run', { language: 'javascript', code: files[0].content, files, entry: 'main.js', projectId: p.id });
  assert.equal(r.data.exitCode, 0, r.data.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'out.txt'), 'utf-8'), 'made by the program');
  assert.equal(fs.readFileSync(path.join(dir, 'main.js'), 'utf-8'), files[0].content); // never rewritten or deleted
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'projects', 'package.json'), 'utf-8')).type, 'commonjs');

  // Unsaved changes: a temporary copy runs and the project folder stays untouched
  const edited = "require('fs').writeFileSync('other.txt', 'x')";
  await api('POST', '/api/run', { language: 'javascript', code: edited, files: [{ name: 'main.js', content: edited }], entry: 'main.js', projectId: p.id });
  assert.equal(fs.existsSync(path.join(dir, 'other.txt')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'main.js'), 'utf-8'), files[0].content);
  await api('DELETE', `/api/projects/${p.id}`);
});

test('run: time limit stops endless programs', async () => {
  const r = await api('POST', '/api/run', { language: 'javascript', code: 'while (true) {}', timeoutMs: 1500 });
  assert.equal(r.data.success, false);
  assert.equal(r.data.exitCode, -1);
  assert.match(r.data.stderr, /timed out/);
});

test('interactive run: stdin reaches input() and output streams', { skip: !hasPython && 'python not installed' }, async () => {
  const { data } = await api('POST', '/api/run/start', {
    language: 'python',
    code: 'name = input("Name? ")\nprint(f"Hello, {name}!")',
  });
  let sent = false;
  const { out, exit } = await readSession(data.runId, async (text) => {
    if (!sent && text.includes('Name?')) {
      sent = true;
      await api('POST', `/api/run/${data.runId}/stdin`, { data: 'Ann\n' });
    }
  });
  assert.match(out, /Hello, Ann!/);
  assert.equal(exit.code, 0);
});

test('interactive run: Stop kills the program', async () => {
  const { data } = await api('POST', '/api/run/start', { language: 'javascript', code: 'setInterval(() => console.log("tick"), 100)' });
  setTimeout(() => api('POST', `/api/run/${data.runId}/stop`), 700);
  const { out, exit } = await readSession(data.runId);
  assert.match(out, /tick/);
  assert.equal(exit.reason, 'stopped');
});

// ---------------- packages & settings ----------------

test('packages: dangerous package names are rejected', async () => {
  const p = (await api('POST', '/api/projects', { name: 'pkgs', files: [] })).data;
  for (const bad of ['six & calc', 'six; rm -rf /', '../x', 'a|b', '--index-url=http://evil', '"quoted"']) {
    const r = await api('POST', `/api/projects/${p.id}/packages/install`, { manager: 'pip', packages: [bad] });
    assert.equal(r.status, 400, `"${bad}" must be rejected`);
  }
  const npmBad = await api('POST', `/api/projects/${p.id}/packages/install`, { manager: 'npm', packages: ['lodash && calc'] });
  assert.equal(npmBad.status, 400);
  assert.deepEqual((await api('GET', `/api/projects/${p.id}/packages`)).data, { python: [], node: [] });
  await api('DELETE', `/api/projects/${p.id}`);
});

test('settings: keys are never returned, bad URLs are rejected', async () => {
  const saved = await api('PUT', '/api/settings', {
    custom: { enabled: true, name: 'Test', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'secret-key-1234567', models: 'm1, m2' },
  });
  assert.equal(saved.status, 200);
  const s = (await api('GET', '/api/settings')).data;
  assert.equal(s.custom.apiKey, '');
  assert.equal(s.custom.hasKey, true);
  assert.ok(!JSON.stringify(s).includes('secret-key-1234567'));
  assert.deepEqual(s.custom.models, ['m1', 'm2']);
  assert.equal((await api('PUT', '/api/settings', { custom: { enabled: true, baseUrl: 'file:///etc/passwd' } })).status, 400);

  const models = (await api('GET', '/api/models')).data.models.map((m: any) => m.id);
  assert.ok(models.includes('gemini-3.5-flash'));
  assert.ok(models.includes('custom:m1') && models.includes('custom:m2'));
});

// ---------------- security ----------------

test('security: requests from other websites are rejected (DNS rebinding, cross-site)', async () => {
  const runBody = JSON.stringify({ language: 'javascript', code: 'console.log("pwned")' });
  const send = (headers: Record<string, string>) =>
    fetch(`${base}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: runBody });

  // Node's fetch does not let us override Host, so check it through a raw HTTP request
  const http = await import('http');
  const port = new URL(base).port;
  const rawStatus = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port, path: '/api/projects', method: 'GET', headers: { Host: host } },
        (res) => {
          res.resume();
          resolve(res.statusCode || 0);
        }
      );
      r.on('error', reject);
      r.end();
    });

  assert.equal(await rawStatus('evil.example:3000'), 403, 'foreign Host must be rejected');
  assert.equal(await rawStatus(`localhost:${port}`), 200);
  assert.equal(await rawStatus(`127.0.0.1:${port}`), 200);

  assert.equal((await send({ Origin: 'http://evil.example' })).status, 403, 'foreign Origin must be rejected');
  assert.equal((await send({ Origin: 'null' })).status, 403, 'opaque origin must be rejected');
  assert.equal((await send({ 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'cross-site fetch must be rejected');

  // The web preview runs on another port: same host, different origin -> must not reach the API
  assert.equal((await send({ Origin: `http://127.0.0.1:${Number(port) + 1}` })).status, 403, 'preview origin must be rejected');

  const ok = await send({ Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).stdout.trim(), 'pwned');
});

// ---------------- shell terminal & disk sync ----------------

/** ConPTY needs a console: under `node --test` on Windows a pseudo-terminal may exit immediately. */
async function ptyWorksHere(): Promise<boolean> {
  const mod: any = await import('@lydell/node-pty');
  const pty = mod.default ?? mod;
  return new Promise((resolve) => {
    const p = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : 'bash', [], { cols: 80, rows: 24 });
    const timer = setTimeout(() => {
      p.kill();
      resolve(true);
    }, 1000);
    p.onExit(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

test('terminal: a real shell runs commands in the project folder', async (t) => {
  if (!(await ptyWorksHere())) {
    // (run tests with the tsx CLI, as "npm test" does: with "node --import tsx" node-pty's worker thread can't load
    // after the tests switch to their temporary folder)
    t.skip('pseudo-terminals are not available in this test process');
    return;
  }
  const p = (await api('POST', '/api/projects', { name: 'term', files: [{ name: 'marker.txt', content: 'x' }] })).data;
  const shell = process.platform === 'win32' ? 'cmd' : 'bash';
  const { data } = await api('POST', '/api/terminal/start', { shell, projectId: p.id, cols: 100, rows: 30 });
  assert.ok(data.id, JSON.stringify(data));
  const res = await fetch(`${base}/api/terminal/${data.id}/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  const listCmd = process.platform === 'win32' ? 'dir /b\r' : 'ls\r';
  await api('POST', `/api/terminal/${data.id}/input`, { data: listCmd });
  const deadline = Date.now() + 15000;
  while (!out.includes('marker.txt') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder
      .decode(value, { stream: true })
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)))
      .join('');
  }
  await reader.cancel();
  await api('POST', `/api/terminal/${data.id}/kill`);
  assert.match(out, /marker\.txt/, `the shell must start in the project folder; got: ${JSON.stringify(out.slice(-400))}`);
  await api('DELETE', `/api/projects/${p.id}`);
});

test('disk sync: files created / deleted outside the studio are picked up', async () => {
  const p = (await api('POST', '/api/projects', { name: 'sync', files: [{ name: 'a.py', content: 'a' }] })).data;
  const dir = path.join(tmp, 'projects', p.id);

  // watcher reports external changes, but not the studio's own saves.
  // One reader loop collects all events (racing reader.read() against a timer would lose chunks).
  const res = await fetch(`${base}/api/projects/${p.id}/watch`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: any[] = [];
  (async () => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (line) events.push(JSON.parse(line.slice(6)));
      }
    }
  })();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await sleep(300);
  await api('PUT', `/api/projects/${p.id}`, { files: [{ name: 'a.py', content: 'saved by studio' }] });
  await sleep(1500);
  assert.deepEqual(events, [], 'own saves must not be reported');

  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'new.py'), 'print("from terminal")');
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), 'ignored');
  for (let k = 0; k < 50 && events.length === 0; k++) await sleep(100);
  const all = (events as any[]).flatMap((e) => e.changed || []);
  assert.ok(all.some((c: string) => c.includes('new.py')), JSON.stringify(events));
  assert.ok(!all.some((c: string) => c.includes('node_modules')), 'node_modules changes are ignored');
  await reader.cancel();

  const synced = (await api('GET', `/api/projects/${p.id}?rescan=1`)).data;
  assert.deepEqual(synced.files.map((f: any) => f.name).sort(), ['a.py', 'sub/new.py'], 'node_modules is never imported');
  assert.equal(synced.files.find((f: any) => f.name === 'sub/new.py').language, 'python');

  fs.unlinkSync(path.join(dir, 'a.py'));
  const afterDelete = (await api('GET', `/api/projects/${p.id}?rescan=1`)).data;
  assert.deepEqual(afterDelete.files.map((f: any) => f.name), ['sub/new.py']);
  await api('DELETE', `/api/projects/${p.id}`);
});

// ---------------- debugger ----------------

/** Collect debugger events of a session; `next()` waits for the next non-"running" event. */
async function debugEvents(runId: string) {
  const res = await fetch(`${base}/api/debug/${runId}/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const queue: any[] = [];
  let buf = '';
  (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (line) queue.push(JSON.parse(line.slice(6)));
      }
    }
  })();
  return async () => {
    for (let k = 0; k < 150; k++) {
      const e = queue.shift();
      if (e && e.event !== 'running') return e;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { event: 'timeout' };
  };
}

const debugProjects = {
  python: {
    entry: 'main.py',
    breakpoints: { 'main.py': [6] },
    stepTo: 'lib/calc.py',
    files: [
      { name: 'main.py', content: 'from lib.calc import double\n\ndef compute(values):\n    total = 0\n    for v in values:\n        total += double(v)\n    return total\n\nprint("result", compute([1, 2, 3]))\n' },
      { name: 'lib/__init__.py', content: '' },
      { name: 'lib/calc.py', content: 'def double(x):\n    y = x * 2\n    return y\n' },
    ],
  },
  javascript: {
    entry: 'main.js',
    breakpoints: { 'main.js': [5] },
    stepTo: 'lib/calc.js',
    files: [
      { name: 'main.js', content: 'const { double } = require("./lib/calc.js");\nfunction compute(values) {\n  let total = 0;\n  for (const v of values) {\n    total += double(v);\n  }\n  return total;\n}\nconsole.log("result", compute([1, 2, 3]));\n' },
      { name: 'lib/calc.js', content: 'function double(x) {\n  const y = x * 2;\n  return y;\n}\nmodule.exports = { double };\n' },
    ],
  },
};

for (const [language, p] of Object.entries(debugProjects)) {
  test(`debugger (${language}): breakpoint, variables, evaluate, step into another file, continue`, { skip: language === 'python' && !hasPython && 'python not installed' }, async () => {
    const entry = p.files.find((f) => f.name === p.entry)!;
    const { data } = await api('POST', '/api/debug/start', { language, code: entry.content, files: p.files, entry: p.entry, breakpoints: p.breakpoints });
    assert.ok(data.runId, JSON.stringify(data));
    const next = await debugEvents(data.runId);
    const cmd = (c: string, extra: object = {}) => api('POST', `/api/debug/${data.runId}/command`, { cmd: c, ...extra });

    const stop = await next();
    assert.equal(stop.event, 'stopped');
    assert.equal(stop.reason, 'breakpoint');
    assert.equal(stop.file, p.entry);
    assert.equal(stop.stack[0].name, 'compute');
    const vars = Object.fromEntries(stop.locals.map((v: any) => [v.name, v.value]));
    assert.equal(vars.total, '0');
    assert.equal(vars.v, '1');

    await cmd('eval', { expr: 'total * 10 + v' });
    assert.equal((await next()).value, '1');

    await cmd('step');
    const inside = await next();
    assert.equal(inside.file, p.stepTo);
    assert.deepEqual(inside.stack.map((f: any) => f.name).slice(0, 2), ['double', 'compute']);

    await cmd('setBreakpoints', { breakpoints: {} });
    await cmd('continue');
    assert.equal((await next()).event, 'terminated');
  });
}

// ---------------- web preview ----------------

test('web preview: serves project files as a site on its own port, safely', async () => {
  const { startPreviewServer, getPreviewPort } = await import(pathToFileURL(path.join(studioRoot, 'api', 'preview.ts')).href);
  const port = await startPreviewServer(Number(new URL(base).port));
  assert.ok(port > 0 && port === getPreviewPort());
  assert.notEqual(String(port), new URL(base).port, 'preview must be a different origin than the API');

  const p = (await api('POST', '/api/projects', {
    name: 'site',
    files: [
      { name: 'index.html', content: '<html><head><title>x</title></head><body>home</body></html>' },
      { name: 'about/index.html', content: '<p>about</p>' },
      { name: 'css/site.css', content: 'body{}' },
    ],
  })).data;
  const pv = `http://127.0.0.1:${port}/preview/${p.id}`;

  const home = await fetch(`${pv}/`);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /<head><script>[\s\S]*scriptcraft-preview[\s\S]*<\/script><title>/, 'console bridge goes first in <head>');
  assert.match(await (await fetch(`${pv}/about/`)).text(), /about/, 'folders serve their index.html');
  assert.equal((await fetch(`${pv}/css/site.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await fetch(`${pv}/missing.html`)).status, 404);
  assert.equal((await fetch(`${pv}/.scriptcraft.json`)).status, 400, 'service files are not served');
  assert.equal((await fetch(`${pv}/..%2F..%2Fsettings.json`)).status, 400, 'no path traversal');

  const http = await import('http');
  const status = await new Promise<number>((resolve) => {
    http.get({ host: '127.0.0.1', port, path: `/preview/${p.id}/`, headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
  });
  assert.equal(status, 403, 'DNS rebinding: foreign Host is rejected');
  await api('DELETE', `/api/projects/${p.id}`);
});
