// Agent model auto-pick: prefer local coder / abliterated tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPreferredAgentModel, scoreAgentModelName, type AppModel } from '../src/utils/models.ts';

const m = (id: string, name: string, provider: AppModel['provider'] = 'ollama'): AppModel => ({
  id,
  name,
  tag: provider === 'ollama' ? 'Ollama' : '',
  desc: '',
  speed: 'balanced',
  provider,
});

test('scoreAgentModelName: coder and abliterated rank above custom-v9', () => {
  assert.ok(scoreAgentModelName('nemo-abliterated:latest') > scoreAgentModelName('nemo-custom-v9:latest'));
  assert.ok(scoreAgentModelName('qwen2.5-coder:14b') > scoreAgentModelName('qwen2.5vl:7b'));
  assert.ok(scoreAgentModelName('qwen-coder-abliterated') > scoreAgentModelName('nemo-abliterated'));
});

test('pickPreferredAgentModel: picks best ollama agent tag', () => {
  const list = [
    m('gemini-3.5-flash', 'Gemini 3.5 Flash', 'gemini'),
    m('ollama:nemo-custom-v9:latest', 'nemo-custom-v9:latest'),
    m('ollama:nemo-abliterated:latest', 'nemo-abliterated:latest'),
    m('ollama:qwen2.5vl:7b', 'qwen2.5vl:7b'),
  ];
  assert.equal(pickPreferredAgentModel(list), 'ollama:nemo-abliterated:latest');
});

test('pickPreferredAgentModel: coder-abliterated beats plain abliterated', () => {
  const list = [
    m('ollama:nemo-abliterated:latest', 'nemo-abliterated:latest'),
    m('ollama:qwen-coder-abliterated:latest', 'qwen-coder-abliterated:latest'),
  ];
  assert.equal(pickPreferredAgentModel(list), 'ollama:qwen-coder-abliterated:latest');
});

test('pickPreferredAgentModel: null when no strong local candidate', () => {
  assert.equal(pickPreferredAgentModel([m('gemini-3.5-flash', 'Gemini 3.5 Flash', 'gemini')]), null);
  assert.equal(pickPreferredAgentModel([m('ollama:llama3.2:3b', 'llama3.2:3b')]), null);
});
