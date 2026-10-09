// Error journal and "Report a problem": interface errors are stored, the report never holds secrets.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-logs-'));
let server: import('http').Server;
let base = '';
const GEMINI = 'AIzaSyD-thisIsAFakeKeyForTests_123456';
const CUSTOM = 'my-local-server-secret-42';

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

before(async () => {
  process.chdir(tmp);
  fs.writeFileSync('.env', `GEMINI_API_KEY="${GEMINI}"\nOTHER_TOKEN=plain-value-123\nDEBUG=true\n`);
  fs.writeFileSync('settings.json', JSON.stringify({ ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434' }, custom: { apiKey: CUSTOM } }));
  fs.writeFileSync('studio.log', `Server started on port 3000\nUsing key ${GEMINI}\n`);
  const express = (await import('express')).default;
  const { apiRouter } = await import(pathToFileURL(path.join(studioRoot, 'api', 'router.ts')).href);
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  process.chdir(studioRoot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('redact: keys from .env and settings, tokens by shape, the user name in paths', async () => {
  const { redact } = await import(pathToFileURL(path.join(studioRoot, 'api', 'logs.ts')).href);
  const home = os.homedir();
  const text = [
    `key=${GEMINI}`,
    'token plain-value-123 here',
    `custom ${CUSTOM}`,
    'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'auth: Bearer abc.def.ghi-jkl_mno',
    'url https://x.com/api?key=SECRET123&a=1',
    '{"apiKey":"zzz-secret"}',
    `path ${home}\\projects\\a.py`,
    `other D:/users/${path.basename(home)}/x`,
    'other sk-proj1234567890abcdefXYZ',
  ].join('\n');
  const r = redact(text);
  for (const secret of [GEMINI, 'plain-value-123', CUSTOM, 'ghp_abcdefghij', 'abc.def.ghi', 'SECRET123', 'zzz-secret', 'sk-proj1234567890']) {
    assert.ok(!r.includes(secret), `${secret} leaked:\n${r}`);
  }
  assert.ok(!r.includes(home));
  assert.match(r, /%USERPROFILE%\\projects\\a\.py/);
  assert.match(r, /D:\/users\/<user>\/x/); // another drive, other case and slashes
  assert.match(r, /DEBUG|token \[secret\] here/); // short / boolean values are left alone
});

test('interface errors go to logs/errors.log; a flood is cut off', async () => {
  assert.equal((await api('POST', '/api/logs/client', { message: 'Boom in the editor', stack: 'at CodeEditor (x.tsx:1:1)', kind: 'crash' })).status, 200);
  const log = fs.readFileSync(path.join(tmp, 'logs', 'errors.log'), 'utf-8');
  assert.match(log, /\[ui\] Boom in the editor \(crash/);
  assert.match(log, /at CodeEditor/);
  let limited = false;
  for (let i = 0; i < 40; i++) if ((await api('POST', '/api/logs/client', { message: `e${i}` })).status === 429) limited = true;
  assert.ok(limited);
});

test('report: description, system, both journals — without secrets', async () => {
  const { logError } = await import(pathToFileURL(path.join(studioRoot, 'api', 'logs.ts')).href);
  logError('server', `Gemini failed with key ${GEMINI}`);
  const { report } = (await api('POST', '/api/logs/report', { description: 'Окно зависло после запуска', ui: { language: 'ru' } })).data;
  assert.match(report, /Окно зависло после запуска/);
  assert.match(report, /ScriptCraft Studio \d+\.\d+\.\d+ \(developer copy\)/);
  assert.match(report, /Node\.js: v\d+/);
  assert.match(report, /language: ru/);
  assert.match(report, /Boom in the editor/);
  assert.match(report, /Gemini failed with key \[secret\]/);
  assert.match(report, /Server started on port 3000/);
  assert.ok(!report.includes(GEMINI));
  assert.ok(!report.includes(CUSTOM));
  assert.ok(!report.includes(os.homedir()));
});

test('the journal rotates at 2 MB', async () => {
  const { logError } = await import(pathToFileURL(path.join(studioRoot, 'api', 'logs.ts')).href);
  fs.writeFileSync(path.join(tmp, 'logs', 'errors.log'), 'x'.repeat(2 * 1024 * 1024 + 10));
  logError('server', 'after rotation');
  assert.ok(fs.existsSync(path.join(tmp, 'logs', 'errors.1.log')));
  assert.match(fs.readFileSync(path.join(tmp, 'logs', 'errors.log'), 'utf-8'), /after rotation/);
});
