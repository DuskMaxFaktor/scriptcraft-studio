// "Run tests" for projects: pytest and node --test, with results parsed from JUnit reports.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-projtests-'));
const hasPytest = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import pytest']).status === 0;
let server: import('http').Server;
let base = '';

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

/** Wait for a run session to end and return its output. */
async function waitSession(runId: string) {
  const res = await fetch(`${base}/api/run/${runId}/events`);
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)))
    .filter((e) => e.type !== 'exit')
    .map((e) => e.data)
    .join('');
}

async function runTests(projectId: string, framework: 'pytest' | 'node', coverage = false) {
  const start = await api('POST', `/api/projects/${projectId}/tests/run`, { framework, coverage });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const output = await waitSession(start.data.runId);
  for (let i = 0; i < 50; i++) {
    const r = await api('GET', `/api/projects/${projectId}/tests/results/${start.data.runId}`);
    if (!r.data.running) return { report: r.data, output };
    await new Promise((x) => setTimeout(x, 100));
  }
  throw new Error('no report');
}

before(async () => {
  process.chdir(tmp);
  fs.writeFileSync('settings.json', JSON.stringify({ ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434' } }));
  const express = (await import('express')).default;
  const { apiRouter } = await import(pathToFileURL(path.join(studioRoot, 'api', 'router.ts')).href);
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api', apiRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  const { stopPreviewServer } = await import(pathToFileURL(path.join(studioRoot, 'api', 'preview.ts')).href);
  await stopPreviewServer();
  server?.close();
  process.chdir(studioRoot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('pytest: passed, failed (with file and line) and skipped tests', { skip: !hasPytest && 'pytest not installed' }, async () => {
  const p = (
    await api('POST', '/api/projects', {
      name: 'pytests',
      files: [
        { name: 'calc.py', content: 'def add(a, b):\n    return a + b\n' },
        {
          name: 'tests/test_calc.py',
          content:
            'import pytest\nfrom calc import add\n\n\ndef test_add():\n    assert add(2, 2) == 4\n\n\ndef test_wrong():\n    assert add(2, 2) == 5\n\n\n@pytest.mark.skip(reason="later")\ndef test_later():\n    pass\n',
        },
      ],
    })
  ).data;
  const found = (await api('GET', `/api/projects/${p.id}/tests`)).data;
  assert.deepEqual(found.python, ['tests/test_calc.py']);
  assert.equal(found.pytest, true);

  const { report, output } = await runTests(p.id, 'pytest');
  assert.equal(report.total, 3, output);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.skipped, 1);
  const failed = report.cases.find((c: any) => c.status === 'failed');
  assert.equal(failed.name, 'test_wrong');
  assert.equal(failed.file, 'tests/test_calc.py');
  assert.equal(failed.line, 10, failed.details);
  assert.match(failed.message, /assert 4 == 5/);
  assert.equal(report.cases.find((c: any) => c.status === 'skipped').message, 'later');
  // Nothing left behind in the project
  assert.equal(fs.existsSync(path.join(tmp, 'projects', p.id, '.pytest_cache')), false);
  await api('DELETE', `/api/projects/${p.id}`);
});

test('node --test: JS and TypeScript tests, failure location from the stack', async () => {
  const p = (
    await api('POST', '/api/projects', {
      name: 'jstests',
      files: [
        { name: 'math.js', content: 'exports.mul = (a, b) => a * b;\n' },
        {
          name: 'math.test.js',
          content:
            "const test = require('node:test');\nconst assert = require('node:assert');\nconst { mul } = require('./math');\n\ntest('multiplies', () => assert.equal(mul(3, 4), 12));\ntest('broken', () => {\n  assert.equal(mul(2, 2), 5);\n});\n",
        },
        { name: 'types.spec.ts', content: "import test from 'node:test';\nimport assert from 'node:assert';\n\nconst x: number = 2;\ntest('typed', () => assert.equal(x * 2, 4));\n" },
      ],
    })
  ).data;
  assert.deepEqual((await api('GET', `/api/projects/${p.id}/tests`)).data.js, ['math.test.js', 'types.spec.ts']);
  const { report, output } = await runTests(p.id, 'node');
  assert.equal(report.total, 3, output + JSON.stringify(report));
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 1);
  const broken = report.cases.find((c: any) => c.name === 'broken');
  assert.equal(broken.status, 'failed');
  assert.equal(broken.file, 'math.test.js');
  assert.equal(broken.line, 7);
  assert.match(broken.message, /4 == 5/);
  assert.match(output, /multiplies/);
  await api('DELETE', `/api/projects/${p.id}`);
});

test('pytest coverage: which project lines the tests ran, test files left out', { skip: !hasPytest && 'pytest not installed' }, async () => {
  const p = (
    await api('POST', '/api/projects', {
      name: 'pycover',
      files: [
        { name: 'calc.py', content: '"""Calc."""\n\n\ndef add(a, b):\n    return a + b\n\n\ndef unused(x):\n    if x:\n        return 1\n    return 2\n' },
        { name: 'other.py', content: 'VALUE = 1\n' },
        { name: 'test_calc.py', content: 'from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n' },
      ],
    })
  ).data;
  const { report, output } = await runTests(p.id, 'pytest', true);
  assert.equal(report.passed, 1, output);
  const cov = report.coverage;
  assert.ok(cov, output);
  assert.deepEqual(Object.keys(cov.files).sort(), ['calc.py', 'other.py']);
  // def lines and the docstring run on import, add() ran, unused() did not
  assert.ok(cov.files['calc.py'].covered.includes(5));
  assert.deepEqual(cov.files['calc.py'].missing, [9, 10, 11]);
  // Never imported: all of it missing
  assert.deepEqual(cov.files['other.py'], { covered: [], missing: [1] });
  assert.ok(cov.percent > 0 && cov.percent < 100);
  // Without the option: no coverage
  assert.equal((await runTests(p.id, 'pytest')).report.coverage, undefined);
  // Nothing left behind in the project
  assert.deepEqual(
    fs.readdirSync(path.join(tmp, 'projects', p.id)).filter((f) => !f.startsWith('.') && f !== '__pycache__').sort(),
    ['calc.py', 'other.py', 'test_calc.py']
  );
  await api('DELETE', `/api/projects/${p.id}`);
});

test('node coverage: lcov turned into covered / missing code lines', async () => {
  const p = (
    await api('POST', '/api/projects', {
      name: 'jscover',
      files: [
        { name: 'lib.js', content: '// helpers\nfunction a(x) {\n  if (x) {\n    return 1;\n  }\n\n  return 2;\n}\nmodule.exports = { a };\n' },
        { name: 'lib.test.js', content: "const test = require('node:test');\nconst { a } = require('./lib');\ntest('a', () => a(1));\n" },
      ],
    })
  ).data;
  const { report, output } = await runTests(p.id, 'node', true);
  assert.equal(report.passed, 1, output);
  const f = report.coverage?.files['lib.js'];
  assert.ok(f, JSON.stringify(report.coverage));
  assert.equal(report.coverage.files['lib.test.js'], undefined);
  // The comment (1) and the blank line (6) are not code; "return 2" never ran
  assert.ok(!f.covered.includes(1) && !f.missing.includes(1) && !f.missing.includes(6));
  assert.deepEqual(f.missing, [7]);
  assert.ok(f.covered.includes(4));
  await api('DELETE', `/api/projects/${p.id}`);
});

test('node coverage: TypeScript sources stay notMeasured (lcov paints unreachable returns green)', async () => {
  const p = (
    await api('POST', '/api/projects', {
      name: 'tscover',
      files: [
        {
          name: 'lib.ts',
          content:
            "export function grade(n: number): string {\n  if (n >= 90) {\n    return 'A';\n  }\n  if (n >= 70) {\n    return 'B';\n  }\n  return 'C';\n}\n",
        },
        {
          name: 'lib.test.ts',
          content:
            "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { grade } from './lib.ts';\ntest('B', () => { assert.equal(grade(75), 'B'); });\n",
        },
      ],
    })
  ).data;
  const { report, output } = await runTests(p.id, 'node', true);
  assert.equal(report.passed, 1, output);
  assert.equal(report.coverage?.files['lib.ts'], undefined, JSON.stringify(report.coverage));
  assert.ok(report.coverage?.notMeasured?.includes('lib.ts'), JSON.stringify(report.coverage));
  await api('DELETE', `/api/projects/${p.id}`);
});

test('parseLcov: absolute paths, files outside the project and packages are dropped', async () => {
  const { parseLcov } = await import(pathToFileURL(path.join(studioRoot, 'api', 'tests.ts')).href);
  const dir = path.join(tmp, 'lcovdir');
  const lcov = [
    `SF:${path.join(dir, 'src', 'a.js')}\nDA:1,3\nDA:2,0\nend_of_record`,
    `SF:${path.join(tmp, 'elsewhere.js')}\nDA:1,1\nend_of_record`,
    'SF:node_modules/x/index.js\nDA:1,1\nend_of_record',
    'SF:util.ts\nDA:1,1\nend_of_record',
  ].join('\n');
  const r = parseLcov(lcov, dir);
  assert.deepEqual(r.files, { 'src/a.js': { covered: [1], missing: [2] } });
  // TypeScript: listed as not measured instead of wrongly green
  assert.deepEqual(r.notMeasured, ['util.ts']);
  assert.equal(r.percent, 50);
});

test('tests: no test files and bad ids are reported clearly', async () => {
  const p = (await api('POST', '/api/projects', { name: 'notests', files: [{ name: 'main.py', content: 'print(1)' }] })).data;
  const found = (await api('GET', `/api/projects/${p.id}/tests`)).data;
  assert.deepEqual([found.python, found.js, found.pytest], [[], [], null]);
  assert.equal((await api('POST', `/api/projects/${p.id}/tests/run`, { framework: 'pytest' })).status, 400);
  assert.equal((await api('GET', '/api/projects/..%2Fx/tests')).status, 400);
  assert.equal((await api('GET', `/api/projects/${p.id}/tests/results/nope`)).status, 404);
  await api('DELETE', `/api/projects/${p.id}`);
});
