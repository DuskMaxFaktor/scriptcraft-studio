import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TEMP, CHAT_TEMP, chatSystemInstruction } from '../src/utils/aiPrefs.ts';

test('temperature presets: agent stays colder than chat', () => {
  assert.ok(AGENT_TEMP.precise < CHAT_TEMP.precise);
  assert.ok(AGENT_TEMP.balanced < CHAT_TEMP.balanced);
  assert.equal(AGENT_TEMP.balanced, 0.15);
  assert.equal(CHAT_TEMP.balanced, 0.7);
});

test('chatSystemInstruction: Ollama gets a short role prompt', () => {
  const full = 'You are a Principal Software Architect and Lead Engineer. '.repeat(5);
  const lite = chatSystemInstruction('architect', full, 'ollama');
  assert.ok(lite.length < full.length);
  assert.match(lite, /ScriptCraft Studio/);
  assert.doesNotMatch(lite, /Principal Software Architect/);
  assert.equal(chatSystemInstruction('architect', full, 'gemini'), full);
});
