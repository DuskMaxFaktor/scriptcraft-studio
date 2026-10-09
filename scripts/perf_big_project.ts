// Timing of the studio API on a big project (2000 files): open, autosave after one change, search, git status.
// Runs in a temporary folder. Usage: node node_modules/tsx/dist/cli.mjs scripts/perf_big_project.ts [files]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';

const N = Number(process.argv[2] || 2000);
const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-perf-'));
process.chdir(tmp);
fs.writeFileSync('settings.json', JSON.stringify({ ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434' }, backups: { enabled: false } }));

const express = (await import('express')).default;
const { apiRouter } = await import(pathToFileURL(path.join(studioRoot, 'api', 'router.ts')).href);
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use('/api', apiRouter);
const server = await new Promise<import('http').Server>((r) => {
  const s = app.listen(0, '127.0.0.1', () => r(s));
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  console.log(`${label.padEnd(44)} ${(performance.now() - t0).toFixed(0).padStart(6)} ms`);
  return r;
}
const json = (method: string, url: string, body?: unknown) =>
  fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => {
    if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
    return r.json();
  });

const line = 'def handler(request, response):\n    value = compute(request.args)\n    return response.send(value)\n';
const files = Array.from({ length: N }, (_, i) => ({
  name: `pkg${i % 40}/sub${i % 7}/module_${i}.py`,
  language: 'python',
  content: `# module ${i}\n` + line.repeat(25) + (i === 1234 ? 'NEEDLE_4711 = 1\n' : ''),
  isEntry: i === 0,
}));
console.log(`${N} files, ${(files.reduce((s, f) => s + f.content.length, 0) / 1024 / 1024).toFixed(1)} MB`);

const p = await timed('create project', () => json('POST', '/api/projects', { name: 'big', files }));
const loaded = await timed('open project (all contents)', () => json('GET', `/api/projects/${p.id}`));
const changed = loaded.files.map((f: any) => (f.name === files[5].name ? { ...f, content: f.content + '\n# edit\n' } : f));
await timed('autosave after one change (full payload)', () => json('PUT', `/api/projects/${p.id}`, { files: changed }));
await timed('autosave with no change (full payload)', () => json('PUT', `/api/projects/${p.id}`, { files: changed }));
const slim = changed.map((f: any, i: number) => (i === 5 ? { ...f, content: f.content + 'x' } : { name: f.name, language: f.language, isEntry: f.isEntry }));
await timed('autosave, only the changed file sent', () => json('PUT', `/api/projects/${p.id}`, { files: slim }).catch((e) => ({ error: String(e) })));
await timed('git init', () => json('POST', `/api/git/${p.id}/init`).catch((e) => ({ error: String(e) })));
await timed('git status (2000 untracked)', () => json('GET', `/api/git/${p.id}/status`).catch((e) => ({ error: String(e) })));
await timed('tests: find test files', () => json('GET', `/api/projects/${p.id}/tests`).catch((e) => ({ error: String(e) })));

server.close();
process.chdir(studioRoot);
const { stopPreviewServer } = await import(pathToFileURL(path.join(studioRoot, 'api', 'preview.ts')).href);
await stopPreviewServer();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
