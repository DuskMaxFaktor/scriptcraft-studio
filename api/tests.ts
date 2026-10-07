import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { attachPackages, cleanup, spawnCommand, startSession, type PreparedRun } from './run.ts';

// Project tests: Python with pytest (also runs unittest-style tests), JavaScript / TypeScript with `node --test`.
// Tests run in the project folder; the output streams like a program run and a JUnit report is turned
// into a list of results (passed / failed / skipped, with the failing file and line).

const isWin = process.platform === 'win32';
const STUDIO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.packages', '.history', '__pycache__', '.venv', 'venv', '.pytest_cache']);
const PY_TEST = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/;
const JS_TEST = /(^|\/)[^/]*\.(test|spec)\.(m?js|cjs|ts|mts)$/;

export interface TestCase {
  name: string;
  suite: string;
  status: 'passed' | 'failed' | 'skipped';
  /** seconds */
  time: number;
  file?: string;
  line?: number;
  message?: string;
  details?: string;
}

export interface TestReport {
  framework: 'pytest' | 'node';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  cases: TestCase[];
  /** The run itself failed (no report): e.g. a syntax error in a test file */
  error?: string;
}

class TestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function projectDir(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new TestError(400, 'Invalid project id');
  const dir = path.join(process.cwd(), 'projects', id);
  if (!fs.existsSync(path.join(dir, '.scriptcraft.json'))) throw new TestError(404, 'Project not found');
  return dir;
}

function findTestFiles(dir: string) {
  const python: string[] = [];
  const js: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(abs, entry.name), r);
      else if (PY_TEST.test(r)) python.push(r);
      else if (JS_TEST.test(r)) js.push(r);
    }
  };
  walk(dir, '');
  return { python: python.sort(), js: js.sort() };
}

/** pytest importable for this project (system Python or the project's own packages)? */
function hasPytest(projectId: string): boolean {
  const env = { ...process.env, ...attachPackages({ command: '', args: [], filePath: '', cwd: '' }, projectId) };
  const r = spawnSync(isWin ? 'python' : 'python3', ['-c', 'import pytest'], { env, windowsHide: true, timeout: 15000 });
  return r.status === 0;
}

// ---------- JUnit XML ----------
// Colored output (--color=yes / FORCE_COLOR) also colors the report text
// eslint-disable-next-line no-control-regex
// (XML cannot hold the ESC character, so pytest writes it as the text "#x1B")
const stripAnsi = (s: string) => s.replace(/(?:\x1b|#x1B)\[[0-9;]*[A-Za-z]/gi, '');
const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : undefined;
};

/** Where a failure happened: the first stack line pointing into a project file. */
function locate(text: string, dir: string): { file: string; line: number } | null {
  const norm = dir.replace(/\\/g, '/').toLowerCase();
  // Node: (C:\...\file.js:3:26) or file:///C:/.../file.js:3:26 ; pytest: file.py:12: AssertionError
  const re = /(?:file:\/\/\/)?([A-Za-z]:[\\/][^\s():]+|[^\s():]+\.py):(\d+)/g;
  for (const m of text.matchAll(re)) {
    let file = m[1].replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(file)) {
      if (!file.toLowerCase().startsWith(norm + '/')) continue;
      file = file.slice(norm.length + 1);
    }
    if (file.includes('node_modules') || file.startsWith('.packages')) continue;
    return { file, line: Number(m[2]) };
  }
  return null;
}

export function parseJunit(xml: string, framework: 'pytest' | 'node', dir: string): TestReport {
  const cases: TestCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const head = m[1];
    const body = m[3] || '';
    const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const skipped = /<skipped\b([^>]*?)(?:\/>|>([\s\S]*?)<\/skipped>)/.exec(body);
    const c: TestCase = {
      name: attr(head, 'name') || '?',
      suite: attr(head, 'classname') || '',
      status: failure ? 'failed' : skipped ? 'skipped' : 'passed',
      time: Number(attr(head, 'time') || 0),
    };
    const file = attr(head, 'file');
    const line = attr(head, 'line');
    if (file) c.file = file.replace(/\\/g, '/');
    // pytest reports 0-based lines of the test function
    if (line) c.line = Number(line) + (framework === 'pytest' ? 1 : 0);
    if (failure) {
      c.message = stripAnsi(attr(failure[2], 'message') || failure[1]);
      c.details = stripAnsi(decode(failure[3] || '')).trim().slice(0, 8000);
      const where = locate(c.details, dir);
      if (where && (!c.file || where.file === c.file || framework === 'node')) {
        c.file = where.file;
        c.line = where.line;
      }
    } else if (skipped) {
      const msg = attr(skipped[1], 'message');
      if (msg && msg !== 'true') c.message = msg;
    }
    cases.push(c);
  }
  return {
    framework,
    total: cases.length,
    passed: cases.filter((c) => c.status === 'passed').length,
    failed: cases.filter((c) => c.status === 'failed').length,
    skipped: cases.filter((c) => c.status === 'skipped').length,
    cases,
  };
}

// ---------- runs ----------
const reports = new Map<string, TestReport | 'running'>();

export const testsRouter = Router({ mergeParams: true });

const wrap =
  (fn: (req: any) => unknown) =>
  async (req: any, res: any) => {
    try {
      res.json(await fn(req));
    } catch (err: any) {
      const status = err instanceof TestError ? err.status : 500;
      if (status === 500) console.error('Tests API error:', err);
      res.status(status).json({ error: err.message || 'Tests error' });
    }
  };

/** Test files found in the project and which runners can run them. */
testsRouter.get(
  '/',
  wrap((req) => {
    const dir = projectDir(req.params.id);
    const files = findTestFiles(dir);
    return { ...files, pytest: files.python.length ? hasPytest(req.params.id) : null };
  })
);

testsRouter.post(
  '/run',
  wrap((req) => {
    const id = req.params.id;
    const dir = projectDir(id);
    const framework = req.body?.framework === 'node' ? 'node' : 'pytest';
    const files = findTestFiles(dir);
    const list = framework === 'node' ? files.js : files.python;
    if (list.length === 0) throw new TestError(400, framework === 'node' ? 'No *.test.js / *.spec.js files' : 'No test_*.py files');

    const report = path.join(os.tmpdir(), `scriptcraft-junit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xml`);
    const prepared: PreparedRun = { command: '', args: [], filePath: '', cwd: dir, rootDir: dir, inPlace: true };
    // NODE_TEST_CONTEXT: when the studio itself runs under a test runner, a nested `node --test` would report
    // to that runner instead of writing its own report
    const env: NodeJS.ProcessEnv = { ...attachPackages(prepared, id), FORCE_COLOR: '1', NODE_TEST_CONTEXT: undefined };
    let command: string;
    let args: string[];
    if (framework === 'pytest') {
      command = isWin ? 'python' : 'python3';
      // No .pytest_cache in the project; tests can import project modules from the project root
      args = ['-m', 'pytest', '--color=yes', '-p', 'no:cacheprovider', '--rootdir', dir, `--junitxml=${report}`, '-o', 'junit_family=xunit1', ...list];
      env.PYTHONPATH = [dir, env.PYTHONPATH || process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    } else {
      command = 'node';
      const needsTs = list.some((f) => /\.m?ts$/.test(f));
      // The full tsx loader (ESM + CommonJS): project .ts files are CommonJS by default
      const tsx = pathToFileURL(path.join(STUDIO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
      args = [
        ...(needsTs ? ['--import', tsx] : []),
        '--test',
        '--test-reporter=spec',
        '--test-reporter-destination=stdout',
        '--test-reporter=junit',
        `--test-reporter-destination=${report}`,
        ...list,
      ];
    }
    const proc = spawnCommand(command, args, dir, env);
    let runId = '';
    runId = startSession(
      proc,
      () => {
        let result: TestReport;
        try {
          result = parseJunit(fs.readFileSync(report, 'utf-8'), framework, dir);
          if (result.total === 0) result.error = 'no-tests';
        } catch {
          result = { framework, total: 0, passed: 0, failed: 0, skipped: 0, cases: [], error: 'no-report' };
        }
        fs.rmSync(report, { force: true });
        cleanup(prepared);
        reports.set(runId, result);
        setTimeout(() => reports.delete(runId), 30 * 60 * 1000).unref();
      },
      10 * 60 * 1000
    );
    reports.set(runId, 'running');
    return { runId, framework, files: list };
  })
);

testsRouter.get(
  '/results/:runId',
  wrap((req) => {
    projectDir(req.params.id);
    const r = reports.get(String(req.params.runId));
    if (!r) throw new TestError(404, 'Unknown test run');
    return r === 'running' ? { running: true } : r;
  })
);
