// The agent may request package installs; the step carries a cleaned {python, node} list (or null).
// A fake Gemini server returns the agent's JSON. Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-agent-install-'));
let fake: http.Server;
let nextStep = '';
let gemini: typeof import('../api/gemini.ts');

before(async () => {
  fake = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const body = { candidates: [{ content: { role: 'model', parts: [{ text: nextStep }] }, finishReason: 'STOP' }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  process.env.SCRIPTCRAFT_GEMINI_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.chdir(tmp);
  fs.writeFileSync('.env', 'GEMINI_API_KEY="test-key-1234567890"\n');
  gemini = await import(pathToFileURL(path.join(studioRoot, 'api', 'gemini.ts')).href);
});

after(() => {
  fake.closeAllConnections();
  fake.close();
  delete process.env.SCRIPTCRAFT_GEMINI_BASE_URL;
  process.chdir(studioRoot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ask = [{ role: 'user' as const, text: 'Сделай HTTP-запрос' }];

test('an install request is cleaned: trimmed, deduped, empty lists kept', async () => {
  nextStep = JSON.stringify({
    message: 'Нужен requests',
    files: [],
    run: null,
    install: { python: ['requests', 'requests', ' numpy ', '', 42], node: [] },
    done: false,
  });
  const { step } = await gemini.handleAgentStep({ model: 'gemini-3.5-flash', messages: ask, lang: 'ru' });
  assert.deepEqual(step.install, { python: ['requests', 'numpy'], node: [] });
});

test('no real packages -> install is null', async () => {
  nextStep = JSON.stringify({ message: 'ok', files: [], run: null, install: { python: [], node: [null] }, done: true });
  const a = await gemini.handleAgentStep({ model: 'gemini-3.5-flash', messages: ask, lang: 'ru' });
  assert.equal(a.step.install, null);

  // Missing install field entirely is also null
  nextStep = JSON.stringify({ message: 'ok', files: [], run: null, done: true });
  const b = await gemini.handleAgentStep({ model: 'gemini-3.5-flash', messages: ask, lang: 'ru' });
  assert.equal(b.step.install, null);
});

test('node packages are parsed too', async () => {
  nextStep = JSON.stringify({ message: 'нужен chalk', files: [], run: null, install: { node: ['chalk'] }, done: false });
  const { step } = await gemini.handleAgentStep({ model: 'gemini-3.5-flash', messages: ask, lang: 'ru' });
  assert.deepEqual(step.install, { python: [], node: ['chalk'] });
});
