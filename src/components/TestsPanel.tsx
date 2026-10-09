import React, { useEffect, useRef, useState } from 'react';
import { Play, Square, Loader2, CheckCircle2, XCircle, MinusCircle, ChevronRight, ChevronDown, Download, FlaskConical } from 'lucide-react';
import { FileItem } from '../types.ts';
import { useI18n } from '../i18n.ts';
import { renderAnsi } from '../utils/ansi.tsx';
import { setCoverage, useCoverage, type CoverageReport } from '../coverage.ts';

// "Tests" tab: finds test files (test_*.py, *.test.js / *.spec.ts...), runs them with pytest or node --test,
// shows the result list; a failed test opens its file at the failing line.

interface TestCase {
  name: string;
  suite: string;
  status: 'passed' | 'failed' | 'skipped';
  time: number;
  file?: string;
  line?: number;
  message?: string;
  details?: string;
}
interface Report {
  framework: 'pytest' | 'node';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  cases: TestCase[];
  error?: string;
  coverage?: CoverageReport;
}
interface Found {
  python: string[];
  js: string[];
  pytest: boolean | null;
}

interface TestsPanelProps {
  projectId: string | null;
  files: FileItem[];
  /** Save editor changes before the tests read the files */
  onBeforeRun: () => Promise<void>;
  onOpenFile: (file: string, line: number) => void;
}

async function readSession(runId: string, onText: (t: string) => void): Promise<number | null> {
  const res = await fetch(`/api/run/${runId}/events`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return null;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(i + 2);
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === 'exit') {
        reader.cancel().catch(() => {});
        return ev.code;
      }
      if (typeof ev.data === 'string') onText(ev.data);
    }
  }
}

const filePercent = (f: { covered: number[]; missing: number[] }) => {
  const all = f.covered.length + f.missing.length;
  return all ? Math.round((f.covered.length / all) * 1000) / 10 : 100;
};
const pctColor = (p: number) => (p >= 80 ? 'text-emerald-400' : p >= 50 ? 'text-amber-400' : 'text-rose-400');
/** 3, 4, 5, 9 -> "3-5, 9" */
function compactLines(lines: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    parts.push(j > i ? `${lines[i]}-${lines[j]}` : String(lines[i]));
    i = j;
  }
  return parts.join(', ');
}

export const TestsPanel: React.FC<TestsPanelProps> = ({ projectId, files, onBeforeRun, onOpenFile }) => {
  const { t } = useI18n();
  const [found, setFound] = useState<Found | null>(null);
  const [running, setRunning] = useState<{ runId: string; framework: string } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [output, setOutput] = useState('');
  const [showOutput, setShowOutput] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const base = projectId ? `/api/projects/${encodeURIComponent(projectId)}/tests` : '';
  const outRef = useRef<HTMLPreElement>(null);
  const [withCoverage, setWithCoverage] = useState(() => {
    try {
      return localStorage.getItem('scriptcraft-tests-coverage') === '1';
    } catch {
      return false;
    }
  });
  const shownCoverage = useCoverage();
  const toggleCoverage = (on: boolean) => {
    setWithCoverage(on);
    try {
      localStorage.setItem('scriptcraft-tests-coverage', on ? '1' : '0');
    } catch {
      /* private window */
    }
  };

  // Test files appear / disappear as the project changes (after the autosave)
  useEffect(() => {
    if (!base) return;
    const timer = setTimeout(async () => {
      try {
        setFound(await (await fetch(base)).json());
      } catch {
        // server restarting
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [base, files.map((f) => f.name).join('|')]);
  useEffect(() => {
    setReport(null);
    setOutput('');
    setCoverage(null, null);
  }, [projectId]);
  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [output]);

  const run = async (framework: 'pytest' | 'node') => {
    if (!base || running) return;
    setError(null);
    setOutput('');
    setReport(null);
    try {
      await onBeforeRun();
      const res = await fetch(`${base}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ framework, coverage: withCoverage }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRunning({ runId: data.runId, framework });
      await readSession(data.runId, (text) => setOutput((o) => (o + text).slice(-200_000)));
      for (let i = 0; i < 40; i++) {
        const r = await (await fetch(`${base}/results/${data.runId}`)).json();
        if (!r.running) {
          setReport(r);
          setCoverage(projectId, r.coverage || null);
          // Failures open by default; without a report the raw output explains what happened
          setOpen(new Set((r.cases || []).filter((c: TestCase) => c.status === 'failed').map((c: TestCase) => `${c.suite}::${c.name}`)));
          if (r.error) setShowOutput(true);
          break;
        }
        await new Promise((x) => setTimeout(x, 150));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(null);
    }
  };

  const stop = () => running && fetch(`/api/run/${running.runId}/stop`, { method: 'POST' }).catch(() => {});

  const installPytest = async () => {
    if (!projectId) return;
    setInstalling(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/packages/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manager: 'pip', packages: ['pytest'] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setOutput('');
      setShowOutput(true);
      const code = await readSession(data.runId, (text) => setOutput((o) => o + text));
      if (code !== 0) throw new Error(t('tests.installFailed'));
      setFound(await (await fetch(base)).json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setInstalling(false);
    }
  };

  if (!projectId) return null;
  const hasPy = !!found?.python.length;
  const hasJs = !!found?.js.length;
  const btn = 'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold disabled:opacity-40';

  return (
    <div className="h-full flex flex-col text-xs" data-tests-panel>
      <div className="px-3 py-2 border-b border-slate-800 flex flex-wrap items-center gap-2">
        {hasPy &&
          (found!.pytest === false ? (
            <button onClick={installPytest} disabled={installing} className={`${btn} bg-amber-600 hover:bg-amber-500 text-white`} title={t('tests.pytestMissing')}>
              {installing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              {t('tests.installPytest')}
            </button>
          ) : (
            <button onClick={() => run('pytest')} disabled={!!running || installing} className={`${btn} bg-emerald-600 hover:bg-emerald-500 text-white`}>
              {running?.framework === 'pytest' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {t('tests.runPython', { count: found!.python.length })}
            </button>
          ))}
        {hasJs && (
          <button onClick={() => run('node')} disabled={!!running || installing} className={`${btn} bg-emerald-600 hover:bg-emerald-500 text-white`}>
            {running?.framework === 'node' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {t('tests.runJs', { count: found!.js.length })}
          </button>
        )}
        {(hasPy || hasJs) && (
          <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer select-none" title={t('tests.coverageHint')}>
            <input type="checkbox" checked={withCoverage} onChange={(e) => toggleCoverage(e.target.checked)} data-tests-coverage-toggle />
            {t('tests.coverage')}
          </label>
        )}
        {running && (
          <button onClick={stop} className={`${btn} bg-slate-700 hover:bg-slate-600 text-white`}>
            <Square className="w-3 h-3" /> {t('tests.stop')}
          </button>
        )}
        {report && !report.error && (
          <div className="flex items-center gap-3 ml-1 font-semibold" data-tests-summary>
            <span className="flex items-center gap-1 text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5" /> {report.passed}
            </span>
            <span className={`flex items-center gap-1 ${report.failed ? 'text-rose-400' : 'text-slate-500'}`}>
              <XCircle className="w-3.5 h-3.5" /> {report.failed}
            </span>
            {report.skipped > 0 && (
              <span className="flex items-center gap-1 text-slate-400">
                <MinusCircle className="w-3.5 h-3.5" /> {report.skipped}
              </span>
            )}
            <span className="text-slate-500 font-normal">
              {t('tests.summary', { total: report.total, time: report.cases.reduce((s, c) => s + c.time, 0).toFixed(2) })}
            </span>
          </div>
        )}
        {(output || running) && (
          <button onClick={() => setShowOutput(!showOutput)} className="ml-auto text-slate-400 hover:text-slate-200 flex items-center gap-1">
            {showOutput ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {t('tests.output')}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {error && <div className="m-3 p-2 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 whitespace-pre-wrap">{error}</div>}

        {found && !hasPy && !hasJs && (
          <div className="p-4 text-slate-400 space-y-2 max-w-2xl leading-relaxed">
            <div className="flex items-center gap-2 text-slate-300 font-semibold">
              <FlaskConical className="w-4 h-4 text-indigo-400" /> {t('tests.none')}
            </div>
            <p>{t('tests.howPython')}</p>
            <pre className="p-2 rounded bg-canvas border border-slate-800 font-mono text-[11px] text-slate-300">{'# test_calc.py\nfrom main import add\n\ndef test_add():\n    assert add(2, 3) == 5'}</pre>
            <p>{t('tests.howJs')}</p>
          </div>
        )}

        {report?.error && (
          <div className="m-3 p-2 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200">
            {report.error === 'no-tests' ? t('tests.noneCollected') : t('tests.noReport')}
          </div>
        )}

        {report?.coverage && (
          <div className="mx-3 my-2 rounded border border-slate-800" data-coverage>
            <div className="flex items-center gap-2 px-2 py-1.5 border-b border-slate-800">
              <span className="font-semibold text-slate-200">{t('tests.coverage')}</span>
              <span className={`font-semibold ${pctColor(report.coverage.percent)}`} data-coverage-total>
                {report.coverage.percent}%
              </span>
              <span className="text-slate-500">{t('tests.coverageLegend')}</span>
              <button
                className="ml-auto text-slate-400 hover:text-slate-200"
                onClick={() => setCoverage(shownCoverage ? null : projectId, shownCoverage ? null : report.coverage!)}
                data-coverage-show
              >
                {shownCoverage ? t('tests.coverageHide') : t('tests.coverageShow')}
              </button>
            </div>
            {!!report.coverage.notMeasured?.length && (
              <div className="px-2 py-1.5 text-slate-500 border-b border-slate-800" data-coverage-not-measured>
                {t('tests.coverageTs', { files: report.coverage.notMeasured.join(', ') })}
              </div>
            )}
            {Object.keys(report.coverage.files).length === 0 && <div className="px-2 py-1.5 text-slate-500">{t('tests.coverageNone')}</div>}
            {Object.entries(report.coverage.files)
              .map(([file, f]) => ({ file, f, pct: filePercent(f) }))
              .sort((a, b) => a.pct - b.pct || a.file.localeCompare(b.file))
              .map(({ file, f, pct }) => (
                <div
                  key={file}
                  className="flex items-center gap-2 px-2 py-1 font-mono hover:bg-slate-800/60 cursor-pointer"
                  data-coverage-file={file}
                  title={f.missing.length ? t('tests.coverageMissing', { lines: compactLines(f.missing) }) : undefined}
                  onClick={() => {
                    if (!shownCoverage) setCoverage(projectId, report.coverage!);
                    onOpenFile(file, f.missing[0] || 1);
                  }}
                >
                  <span className="text-slate-200 truncate">{file}</span>
                  <div className="ml-auto w-24 h-1.5 rounded bg-rose-500/40 overflow-hidden shrink-0">
                    <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                  </div>
                  <span className={`w-12 text-right shrink-0 ${pctColor(pct)}`}>{pct}%</span>
                  <span className="w-20 text-right text-slate-500 shrink-0">
                    {f.covered.length}/{f.covered.length + f.missing.length}
                  </span>
                </div>
              ))}
          </div>
        )}

        {report && report.cases.length > 0 && (
          <div className="py-1 font-mono">
            {[...report.cases]
              .sort((a, b) => (a.status === 'failed' ? 0 : 1) - (b.status === 'failed' ? 0 : 1))
              .map((c) => {
                const key = `${c.suite}::${c.name}`;
                const expanded = open.has(key);
                const Icon = c.status === 'passed' ? CheckCircle2 : c.status === 'failed' ? XCircle : MinusCircle;
                const color = c.status === 'passed' ? 'text-emerald-400' : c.status === 'failed' ? 'text-rose-400' : 'text-slate-500';
                return (
                  <div key={key} data-test-case={c.name} data-status={c.status}>
                    <div
                      className="flex items-center gap-2 px-3 py-1 hover:bg-slate-800/60 cursor-pointer"
                      onClick={() => {
                        if (c.status === 'failed' || c.message) {
                          const next = new Set(open);
                          if (expanded) next.delete(key);
                          else next.add(key);
                          setOpen(next);
                        }
                        if (c.file) onOpenFile(c.file, c.line || 1);
                      }}
                      title={c.file ? `${c.file}${c.line ? ':' + c.line : ''}` : undefined}
                    >
                      <Icon className={`w-3.5 h-3.5 shrink-0 ${color}`} />
                      <span className={c.status === 'skipped' ? 'text-slate-500' : 'text-slate-200'}>{c.name}</span>
                      <span className="text-slate-500 truncate">{c.suite}</span>
                      {c.file && (
                        <span className="ml-auto text-[11px] text-indigo-300/80 shrink-0">
                          {c.file}
                          {c.line ? `:${c.line}` : ''}
                        </span>
                      )}
                      <span className="text-[11px] text-slate-500 shrink-0 w-14 text-right">{(c.time * 1000).toFixed(0)} ms</span>
                    </div>
                    {expanded && (c.message || c.details) && (
                      <div className="ml-8 mr-3 mb-1 p-2 rounded bg-rose-500/5 border border-rose-500/20">
                        {c.message && <div className="text-rose-300 whitespace-pre-wrap">{c.message}</div>}
                        {c.details && c.details !== c.message && (
                          <pre className="mt-1 text-[11px] text-slate-400 whitespace-pre-wrap max-h-60 overflow-auto">{c.details}</pre>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}

        {showOutput && (
          <pre ref={outRef} className="m-3 p-2 rounded bg-canvas border border-slate-800 font-mono text-[11px] text-slate-300 whitespace-pre-wrap max-h-80 overflow-auto">
            {renderAnsi(output) || '…'}
          </pre>
        )}
      </div>
    </div>
  );
};
