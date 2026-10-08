// Images in the AI chat: an attached picture is sent to the model as an inline image part.
// A fake Gemini server captures the request body. Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-chat-images-'));
let fake: http.Server;
let lastBody = '';
let gemini: typeof import('../api/gemini.ts');
// A tiny 1x1 PNG, base64 (no data: prefix)
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

before(async () => {
  fake = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf-8');
      const body = { candidates: [{ content: { role: 'model', parts: [{ text: 'вижу картинку' }] }, finishReason: 'STOP' }] };
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

test('an attached image is sent to Gemini as an inline image part', async () => {
  lastBody = '';
  const answer = await gemini.handleMultiTurnChat({
    model: 'gemini-3.5-flash',
    lang: 'ru',
    messages: [{ role: 'user', text: 'Что на картинке?', images: [{ mime: 'image/png', data: PNG_B64 }] }],
  });
  assert.equal(answer, 'вижу картинку');
  const sent = JSON.parse(lastBody);
  // The request carries a part with inline image data of the right type
  const parts = sent.contents.flatMap((c: any) => c.parts);
  const img = parts.find((p: any) => p.inlineData);
  assert.ok(img, `no inlineData part in ${lastBody.slice(0, 300)}`);
  assert.equal(img.inlineData.mimeType, 'image/png');
  assert.equal(img.inlineData.data, PNG_B64);
  assert.ok(parts.some((p: any) => p.text?.includes('Что на картинке?')));
});

test('a bad image (wrong type or not base64) is dropped, not sent', async () => {
  lastBody = '';
  await gemini.handleMultiTurnChat({
    model: 'gemini-3.5-flash',
    lang: 'ru',
    messages: [
      { role: 'user', text: 'привет', images: [{ mime: 'application/zip', data: PNG_B64 }, { mime: 'image/png', data: 'not valid base64 !!!' }] },
    ],
  });
  assert.ok(!lastBody.includes('inlineData'), 'bad images must not reach the model');
});
