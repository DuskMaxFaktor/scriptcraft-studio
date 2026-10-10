// Agent conversation compaction: old step file bodies must not grow forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactAgentConvo,
  formatRunFailureHint,
  pickEntryToRun,
  stallContinueMessage,
  summarizeAgentStepJson,
} from '../src/utils/agentContext.ts';

test('summarizeAgentStepJson: keeps paths, drops file bodies', () => {
  const raw = JSON.stringify({
    message: 'wrote hello',
    files: [{ path: 'hello.py', content: 'print("hi")\n'.repeat(50) }],
    run: null,
    done: false,
  });
  const out = JSON.parse(summarizeAgentStepJson(raw));
  assert.equal(out.files[0].path, 'hello.py');
  assert.match(out.files[0].content, /chars; see current project snapshot/);
  assert.ok(!out.files[0].content.includes('print'));
  assert.equal(out.message, 'wrote hello');
});

test('compactAgentConvo: keeps only the latest step body, summarizes older ones', () => {
  const big = 'x'.repeat(500);
  const step = (n: number) =>
    JSON.stringify({ message: `s${n}`, files: [{ path: `f${n}.py`, content: big }], run: null, done: false });
  const convo = [
    { role: 'user' as const, text: 'Task…' },
    { role: 'model' as const, text: step(1) },
    { role: 'user' as const, text: 'Continue.' },
    { role: 'model' as const, text: step(2) },
    { role: 'user' as const, text: 'Continue.' },
    { role: 'model' as const, text: step(3) },
  ];
  const out = compactAgentConvo(convo, { keepRecentSteps: 1 });
  assert.match(JSON.parse(out[1].text).files[0].content, /chars; see current/);
  assert.match(JSON.parse(out[3].text).files[0].content, /chars; see current/);
  assert.equal(JSON.parse(out[5].text).files[0].content, big);
});

test('compactAgentConvo: clips huge user dumps when over softChars', () => {
  const dump = 'Result of running a.py:\n' + 'line\n'.repeat(4000) + '\nFix and continue.';
  const convo = [
    { role: 'user' as const, text: 'Task' },
    { role: 'model' as const, text: '{"message":"ok","files":[],"done":false}' },
    { role: 'user' as const, text: dump },
  ];
  const out = compactAgentConvo(convo, { softChars: 1000 });
  assert.ok(out[2].text.length < dump.length);
  assert.match(out[2].text, /chars omitted/);
  assert.match(out[2].text, /Fix and continue/);
});

test('pickEntryToRun: prefers main.py', () => {
  assert.equal(pickEntryToRun([{ name: 'README.md', content: '' }, { name: 'main.py', content: 'print(1)' }]), 'main.py');
  assert.equal(pickEntryToRun([{ name: 'lib.py', content: '' }]), 'lib.py');
  assert.equal(pickEntryToRun([{ name: 'a.py', content: '' }, { name: 'b.py', content: '' }]), null);
});

test('stallContinueMessage: demands run when entry exists', () => {
  const msg = stallContinueMessage({
    files: [{ name: 'main.py', content: 'print(1)' }],
    idleSteps: 1,
    wroteFilesThisStep: false,
    hadSuccessfulRun: false,
  });
  assert.match(msg, /run="main\.py"/);
  assert.match(msg, /Do not keep saying/);
});

test('formatRunFailureHint: IndentationError and unterminated string', () => {
  const h = formatRunFailureHint('IndentationError: unexpected indent\nSyntaxError: unterminated string literal');
  assert.match(h, /IndentationError/);
  assert.match(h, /ONE line/);
});
