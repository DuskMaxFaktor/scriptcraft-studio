// Python notebook kernel: one process keeps its namespace between cells (like Jupyter);
// cell output (stream / result / error) comes back over SSE. Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-notebook-'));
const hasPython = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['--version'], { shell: true }).status === 0;
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

/** Read a kernel's event stream; `until(execId)` collects events for one exec up to its "done". */
function kernelEvents(kernelId: string) {
  const queue: any[] = [];
  (async () => {
    const res = await fetch(`${base}/api/notebook/kernel/${kernelId}/events`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (line) queue.push(JSON.parse(line.slice(6)));
      }
    }
  })();
  return async (execId: string) => {
    const out: any[] = [];
    for (let k = 0; k < 150; k++) {
      while (queue.length) {
        const e = queue.shift();
        if (e.execId === execId) {
          out.push(e);
          if (e.type === 'done') return out;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return out;
  };
}

before(async () => {
  process.chdir(tmp);
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
  const { stopAllKernels } = await import(pathToFileURL(path.join(studioRoot, 'api', 'notebook.ts')).href);
  stopAllKernels();
  server?.close();
  process.chdir(studioRoot);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('kernel: state persists between cells, output streams, errors and restart clear state', { skip: !hasPython && 'python not installed' }, async () => {
  const start = await api('POST', '/api/notebook/kernel/start', {});
  assert.equal(start.status, 200);
  const kernelId = start.data.kernelId;
  const wait = kernelEvents(kernelId);
  const exec = async (code: string) => {
    const r = await api('POST', `/api/notebook/kernel/${kernelId}/exec`, { code });
    return wait(r.data.execId);
  };

  // A variable set in one cell is visible in the next (shared namespace)
  let ev = await exec('x = 21');
  assert.equal(ev.at(-1).status, 'ok');
  assert.ok(!ev.some((e) => e.type === 'result'), 'an assignment has no result');

  ev = await exec('x * 2');
  assert.equal(ev.find((e) => e.type === 'result')?.text, '42');
  assert.equal(ev.at(-1).status, 'ok');

  // print() streams to stdout (print emits the text and the newline as separate writes)
  ev = await exec('print("hello")');
  const stdout = ev.filter((e) => e.type === 'stream' && e.name === 'stdout').map((e) => e.text).join('');
  assert.equal(stdout, 'hello\n');

  // An exception is reported with its name, not a kernel crash
  ev = await exec('1 / 0');
  const err = ev.find((e) => e.type === 'error');
  assert.equal(err?.ename, 'ZeroDivisionError');
  assert.equal(ev.at(-1).status, 'error');

  // The kernel still works after an error (same namespace)
  ev = await exec('x + 1');
  assert.equal(ev.find((e) => e.type === 'result')?.text, '22');

  // Restart: a fresh namespace, so x is gone
  assert.equal((await api('POST', `/api/notebook/kernel/${kernelId}/restart`)).status, 200);
  await new Promise((r) => setTimeout(r, 300)); // let the new kernel come up
  ev = await exec('x');
  assert.equal(ev.find((e) => e.type === 'error')?.ename, 'NameError');

  assert.equal((await api('DELETE', `/api/notebook/kernel/${kernelId}`)).status, 200);
});

test('a rich object (_repr_png_) is shown as an image, not text', { skip: !hasPython && 'python not installed' }, async () => {
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const start = await api('POST', '/api/notebook/kernel/start', {});
  const kernelId = start.data.kernelId;
  const wait = kernelEvents(kernelId);
  const exec = async (code: string) => wait((await api('POST', `/api/notebook/kernel/${kernelId}/exec`, { code })).data.execId);

  await exec(`import base64\nclass Img:\n    def _repr_png_(self):\n        return base64.b64decode("${PNG_B64}")`);
  const ev = await exec('Img()');
  const img = ev.find((e) => e.type === 'display');
  assert.equal(img?.mime, 'image/png');
  assert.equal(img?.data, PNG_B64); // the image is emitted, not a text repr
  assert.ok(!ev.some((e) => e.type === 'result'), 'the image replaces the text output');

  await api('DELETE', `/api/notebook/kernel/${kernelId}`);
});
