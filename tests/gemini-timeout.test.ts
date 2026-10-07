// Gemini that hangs (overloaded servers): every attempt has a time limit, the next model is tried,
// and when nothing answers the user gets a clear message instead of waiting forever.
// A fake Gemini server stands in for Google. Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-gemini-timeout-'));
let fake: http.Server;
/** Models that never answer */
let hanging = new Set<string>();
/** Models that answer 503 "overloaded" */
let overloaded = new Set<string>();
const hits: string[] = [];
let gemini: typeof import('../api/gemini.ts');

before(async () => {
  fake = http.createServer((req, res) => {
    const model = /models\/([^:]+):/.exec(req.url || '')?.[1] || '?';
    hits.push(model);
    req.resume();
    if (hanging.has(model)) return; // never answers (the client must give up)
    if (overloaded.has(model)) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' } }));
    }
    const body = { candidates: [{ content: { role: 'model', parts: [{ text: `ответ от ${model}` }] }, finishReason: 'STOP' }] };
    if ((req.url || '').includes('streamGenerateContent')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(body)}\n\n`);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  process.env.SCRIPTCRAFT_GEMINI_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.chdir(tmp);
  fs.writeFileSync('.env', 'GEMINI_API_KEY="test-key-1234567890"\n');
  gemini = await import(pathToFileURL(path.join(studioRoot, 'api', 'gemini.ts')).href);
  // Short limits for the test
  Object.assign(gemini.GEMINI_TIMEOUTS, { chat: 400, code: 400, agent: 400, plan: 400, streamFirst: 400, streamIdle: 400, total: 3000 });
});

after(() => {
  fake.closeAllConnections();
  fake.close();
  delete process.env.SCRIPTCRAFT_GEMINI_BASE_URL;
  process.chdir(studioRoot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ask = [{ role: 'user' as const, text: 'Привет' }];

test('a hanging model is given up after its time limit and the next model answers, with a note why', async () => {
  hanging = new Set(['gemini-3.5-flash']);
  hits.length = 0;
  const t0 = Date.now();
  const answer = await gemini.handleMultiTurnChat({ model: 'gemini-3.5-flash', messages: ask, lang: 'ru' });
  assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
  assert.match(answer, /модель не ответила вовремя/);
  assert.match(answer, /ответ от gemini-3\.8-flash$/);
  // The hanging model now waits out its pause: the next request goes straight to a working one
  hits.length = 0;
  await gemini.handleMultiTurnChat({ model: 'gemini-3.5-flash', messages: ask, lang: 'ru' });
  assert.deepEqual(hits, ['gemini-3.8-flash']);
});

test('streamed answers: no first piece in time -> next model', async () => {
  hanging = new Set(['gemini-3.1-flash-lite']);
  let text = '';
  const r = await gemini.streamMultiTurnChat({ model: 'gemini-3.1-flash-lite', messages: ask, lang: 'ru' }, (c) => (text += c), () => false);
  assert.notEqual(r.model, 'gemini-3.1-flash-lite');
  assert.match(text, /модель не ответила вовремя/);
});

test('nothing answers: a clear message instead of waiting forever', async () => {
  hanging = new Set(['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-9-test']);
  const t0 = Date.now();
  await assert.rejects(gemini.handleMultiTurnChat({ model: 'gemini-9-test', messages: ask, lang: 'ru' }), /Gemini сейчас не отвечает/);
  assert.ok(Date.now() - t0 < 3500, `took ${Date.now() - t0} ms`);
});

test('an overloaded model (503) is retried at most once, then the next model answers at once', async () => {
  hanging = new Set();
  overloaded = new Set(['gemini-overloaded-test']);
  gemini.resetModelCooldowns(); // the previous test paused every model
  // Room for the SDK's one quick retry (1 s) within an attempt
  Object.assign(gemini.GEMINI_TIMEOUTS, { chat: 3000, total: 6000 });
  hits.length = 0;
  const t0 = Date.now();
  const answer = await gemini.handleMultiTurnChat({ model: 'gemini-overloaded-test', messages: ask, lang: 'ru' });
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
  assert.equal(hits.filter((m) => m === 'gemini-overloaded-test').length, 2); // one quick retry, not five slow ones
  assert.match(answer, /модель сейчас перегружена/);
  overloaded = new Set();
});
