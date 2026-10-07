import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, isExternalModel } from '../api/llm.ts';

test('extractJson: plain, fenced and wrapped JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"done":true}\n```'), { done: true });
  assert.deepEqual(extractJson('Here is the step: {"message":"hi","files":[]} — done'), { message: 'hi', files: [] });
  assert.throws(() => extractJson('no json here'));
});

test('isExternalModel: routes only user-provided models away from Gemini', () => {
  assert.equal(isExternalModel('ollama:qwen2.5-coder'), true);
  assert.equal(isExternalModel('custom:gpt-4o'), true);
  assert.equal(isExternalModel('gemini-3.5-flash'), false);
  assert.equal(isExternalModel(undefined), false);
});

test('agent plan: steps are cleaned up, empty plans are refused', async () => {
  const { normalizePlan } = await import('../api/gemini.ts');
  const plan = normalizePlan({
    summary: '  Калькулятор  ',
    steps: [{ title: ' Создать calc.py ', files: ['\\src\\calc.py', '', 5] }, { title: '' }, null, { title: 'Проверить', files: 'oops' }],
    questions: ['Нужен ли интерфейс?', '', 3],
  });
  assert.deepEqual(plan, {
    summary: 'Калькулятор',
    steps: [
      { title: 'Создать calc.py', files: ['src/calc.py'] },
      { title: 'Проверить', files: [] },
    ],
    questions: ['Нужен ли интерфейс?'],
  });
  assert.throws(() => normalizePlan({ summary: 'x', steps: [] }), /empty plan/);
});
