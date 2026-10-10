// Ollama chats: the context window (num_ctx) is set explicitly and shrinks by itself when a model runs out of memory.
// A fake Ollama server stands in for the real one. Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-ollama-test-'));
let fake: http.Server;
/** num_ctx of each request the fake server received */
const seen: number[] = [];
/** Messages of the last request */
let lastMessages: { role: string; content: string }[] = [];
let lastBody: any = null;
/** Largest context the fake "machine" can hold (0: nothing fits) */
let fits = 4096;
/** When true, the next JSON reply is truncated once, then a valid short object. */
let truncateOnce = false;
let llm: typeof import('../api/llm.ts');

before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      const ctx = j.options?.num_ctx;
      seen.push(ctx);
      lastMessages = j.messages || [];
      lastBody = j;
      if (!ctx || ctx > fits) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `llama-server reported out-of-memory during startup: failed to allocate buffer for kv cache (${ctx})` }));
      }
      if (j.stream) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ message: { content: 'При' }, done: false }) + '\n');
        res.end(JSON.stringify({ message: { content: 'вет' }, done: true }) + '\n');
      } else if (j.format && truncateOnce) {
        truncateOnce = false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { content: '{"message":"cut","files":[{"path":"a.py","content":"print(' }, done: true, done_reason: 'length' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { content: j.format ? '{"ok":true}' : `ctx=${ctx}` }, done: true, done_reason: 'stop' }));
      }
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  const port = (fake.address() as AddressInfo).port;
  process.chdir(tmp);
  fs.writeFileSync('settings.json', JSON.stringify({ ollama: { enabled: true, baseUrl: `http://127.0.0.1:${port}`, contextLength: 16384 } }));
  llm = await import(pathToFileURL(path.join(studioRoot, 'api', 'llm.ts')).href);
});

after(() => {
  fake.close();
  process.chdir(studioRoot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('ollama: num_ctx comes from the settings and halves until the model fits', async () => {
  seen.length = 0;
  assert.equal(await llm.externalChat('ollama:nemo', 'sys', [{ role: 'user', text: 'hi' }]), 'ctx=4096');
  assert.deepEqual(seen, [16384, 8192, 4096]);
  // The working size is remembered: no more failed attempts for this model
  seen.length = 0;
  let streamed = '';
  await llm.externalChatStream('ollama:nemo', 'sys', [{ role: 'user', text: 'hi' }], (t) => (streamed += t), () => false);
  assert.equal(streamed, 'Привет');
  assert.deepEqual(seen, [4096]);
  assert.deepEqual(await llm.externalJson('ollama:nemo', 'sys', [{ role: 'user', text: 'json' }]), { ok: true });
});

test('ollama: a model that never fits gets a clear explanation', async () => {
  fits = 0;
  seen.length = 0;
  await assert.rejects(llm.externalChat('ollama:huge', 'sys', [{ role: 'user', text: 'hi' }]), /не хватает памяти даже с коротким контекстом/);
  assert.equal(seen.at(-1), 2048);
  fits = 4096;
});

test('local models are reminded to answer in Russian: first in the system prompt, again after the last question', async () => {
  const gemini = await import(pathToFileURL(path.join(studioRoot, 'api', 'gemini.ts')).href);
  const history = [
    { role: 'user', text: 'Привет' },
    { role: 'model', text: 'Hello!' },
    { role: 'user', text: 'Explain closures' },
  ];
  await gemini.handleMultiTurnChat({ model: 'ollama:nemo', systemInstruction: 'You are a helpful assistant.', messages: history, lang: 'ru' });
  assert.match(lastMessages[0].content, /^ВАЖНО: отвечай пользователю на русском языке/);
  assert.match(lastMessages[0].content, /You are a helpful assistant\.$/);
  assert.equal(lastMessages.at(-1)!.content, 'Explain closures\n\n(Ответь на русском языке.)');
  assert.equal(lastMessages[1].content, 'Привет'); // earlier messages are untouched
  assert.equal(history[2].text, 'Explain closures'); // the caller's history is not changed

  // English interface: nothing is added
  await gemini.handleMultiTurnChat({ model: 'ollama:nemo', systemInstruction: 'Sys', messages: [{ role: 'user', text: 'Hi' }], lang: 'en' });
  assert.equal(lastMessages[0].content, 'Sys');
  assert.equal(lastMessages[1].content, 'Hi');
});

test('JSON answers: a schema keeps small models from rambling forever, and the length is capped', async () => {
  const schema = llm.toJsonSchema({ type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' }, note: { type: 'STRING', nullable: true } }, required: ['ok'] });
  assert.deepEqual(schema, { type: 'object', properties: { ok: { type: 'boolean' }, note: { type: ['string', 'null'] } }, required: ['ok'] });
  assert.deepEqual(await llm.externalJson('ollama:nemo', 'sys', [{ role: 'user', text: 'json' }], { schema, maxTokens: 500 }), { ok: true });
  assert.deepEqual(lastBody.format, schema);
  assert.equal(lastBody.options.num_predict, 500);
  // Without a schema: plain JSON mode, still with a length cap
  await llm.externalJson('ollama:nemo', 'sys', [{ role: 'user', text: 'json' }]);
  assert.equal(lastBody.format, 'json');
  assert.equal(lastBody.options.num_predict, 8192);
});

test('ollama: an attached image rides on the message (base64, for vision models)', async () => {
  const gemini = await import(pathToFileURL(path.join(studioRoot, 'api', 'gemini.ts')).href);
  await gemini.handleMultiTurnChat({
    model: 'ollama:qwen2.5vl',
    systemInstruction: 'Sys',
    lang: 'en',
    messages: [{ role: 'user', text: 'what is this?', images: [{ mime: 'image/png', data: 'QUJD' }] }],
  });
  const last = lastMessages.at(-1) as { content: string; images?: string[] };
  assert.deepEqual(last.images, ['QUJD']); // base64 only, no mime / data: prefix
  assert.equal(last.content, 'what is this?');
});

test('ollama agent: short local system prompt, low temperature, files maxItems=2', async () => {
  const gemini = await import(pathToFileURL(path.join(studioRoot, 'api', 'gemini.ts')).href);
  await gemini.handleAgentStep({
    model: 'ollama:nemo',
    lang: 'en',
    messages: [{ role: 'user', text: 'Create hello.py' }],
  });
  const sys = lastMessages[0].content;
  assert.match(sys, /at most 2 project files/i);
  assert.match(sys, /done:\s*true ONLY after a successful run/i);
  assert.doesNotMatch(sys, /Windows PC/); // long Gemini prompt
  assert.equal(lastBody.options.temperature, 0.15);
  assert.equal(lastBody.format.properties.files.maxItems, 2);
});

test('ollama JSON: truncated reply retries with one-file nudge', async () => {
  truncateOnce = true;
  const schema = llm.toJsonSchema({
    type: 'OBJECT',
    properties: {
      message: { type: 'STRING' },
      files: { type: 'ARRAY', items: { type: 'OBJECT', properties: { path: { type: 'STRING' }, content: { type: 'STRING' } } } },
      done: { type: 'BOOLEAN' },
    },
    required: ['message', 'files', 'done'],
  });
  (schema.properties as any).files.maxItems = 2;
  const out = await llm.externalJson('ollama:nemo', 'sys', [{ role: 'user', text: 'json' }], { schema, maxTokens: 12000, temperature: 0.15 });
  assert.deepEqual(out, { ok: true });
  assert.match(lastMessages.at(-1)!.content, /cut off|ONE file/i);
  assert.equal(lastBody.format.properties.files.maxItems, 1);
  assert.ok(lastBody.options.num_predict <= 6000);
});
