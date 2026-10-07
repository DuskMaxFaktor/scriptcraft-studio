import { FileItem, LogEntry, TableData } from '../types.ts';
import { t } from '../i18n.ts';
import type { Database, SqlJsStatic } from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

declare global {
  interface Window {
    loadPyodide?: any;
    pyodideInstance?: any;
    isPyodideLoading?: boolean;
  }
}

// Generate unique ID
export function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

// Format timestamp
export function getTimestamp(): string {
  const d = new Date();
  return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/**
 * Execute script via server runner or fallback to browser
 */
export async function executeUniversalScript(
  language: string,
  code: string,
  onLog: (entry: LogEntry) => void
): Promise<{ success: boolean; durationMs: number }> {
  const t0 = performance.now();

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language, code }),
    });

    if (res.ok) {
      const data = await res.json();

      if (data.stdout) {
        const lines = data.stdout.split('\n');
        for (const line of lines) {
          if (line !== '') {
            onLog({
              id: generateId(),
              type: 'log',
              message: line,
              timestamp: getTimestamp(),
            });
          }
        }
      }

      if (data.stderr) {
        const errLines = data.stderr.split('\n');
        for (const line of errLines) {
          if (line !== '') {
            onLog({
              id: generateId(),
              type: 'error',
              message: line,
              timestamp: getTimestamp(),
            });
          }
        }
      }

      const durationMs = data.durationMs || Math.round(performance.now() - t0);
      onLog({
        id: generateId(),
        type: data.success ? 'success' : 'error',
        message: t('run.exited', { code: data.exitCode ?? (data.success ? 0 : 1), ms: durationMs }),
        timestamp: getTimestamp(),
      });

      return { success: data.success, durationMs };
    }
  } catch (err: any) {
    console.warn('Server execution runner unavailable, using client fallback:', err.message);
  }

  // Fallback to client runners
  if (language === 'python' || language === 'py') {
    return executePythonClientFallback(code, onLog);
  } else if (language === 'bash' || language === 'sh') {
    return executeBashClientFallback(code, onLog);
  } else {
    return executeJavaScriptClientFallback(code, onLog);
  }
}

/**
 * Client JavaScript Runner
 */
export async function executeJavaScript(
  code: string,
  onLog: (entry: LogEntry) => void
): Promise<{ success: boolean; durationMs: number }> {
  return executeUniversalScript('javascript', code, onLog);
}

/**
 * Client Python Runner
 */
export async function executePython(
  code: string,
  onLog: (entry: LogEntry) => void
): Promise<{ success: boolean; durationMs: number }> {
  return executeUniversalScript('python', code, onLog);
}

/**
 * Client Bash Runner
 */
export async function executeBash(
  code: string,
  onLog: (entry: LogEntry) => void
): Promise<{ success: boolean; durationMs: number }> {
  return executeUniversalScript('bash', code, onLog);
}

/**
 * Client Fallbacks
 */
async function executeJavaScriptClientFallback(
  code: string,
  onLog: (entry: LogEntry) => void
): Promise<{ success: boolean; durationMs: number }> {
  const t0 = performance.now();

  const customConsole = {
    log: (...args: any[]) => {
      onLog({
        id: generateId(),
        type: 'log',
        message: args.map(formatArg).join(' '),
        timestamp: getTimestamp(),
      });
    },
    info: (...args: any[]) => {
      onLog({
        id: generateId(),
        type: 'info',
        message: args.map(formatArg).join(' '),
        timestamp: getTimestamp(),
      });
    },
    warn: (...args: any[]) => {
      onLog({
        id: generateId(),
        type: 'warn',
        message: args.map(formatArg).join(' '),
        timestamp: getTimestamp(),
      });
    },
    error: (...args: any[]) => {
      onLog({
        id: generateId(),
        type: 'error',
        message: args.map(formatArg).join(' '),
        timestamp: getTimestamp(),
      });
    },
  };

  try {
    const cleanJs = code
      .replace(/:\s*(string|number|boolean|any|void|object|unknown|never|Record<.*?>|Array<.*?>|\w+\[\])/g, '')
      .replace(/interface\s+\w+\s*\{[\s\S]*?\}/g, '')
      .replace(/type\s+\w+\s*=[\s\S]*?;/g, '');

    const runner = new Function('console', `
      "use strict";
      try {
        ${cleanJs}
      } catch (err) {
        console.error(err.stack || err.message || String(err));
        throw err;
      }
    `);

    runner(customConsole);
    const durationMs = Math.round(performance.now() - t0);
    return { success: true, durationMs };
  } catch (err: any) {
    const durationMs = Math.round(performance.now() - t0);
    onLog({
      id: generateId(),
      type: 'error',
      message: t('run.runtimeError', { error: err.message || String(err) }),
      timestamp: getTimestamp(),
    });
    return { success: false, durationMs };
  }
}

function formatArg(arg: any): string {
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  if (typeof arg === 'object') {
    try {
      return JSON.stringify(arg, null, 2);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

async function executePythonClientFallback(
  code: string,
  onLog: (entry: LogEntry) => void
): Promise<{ success: boolean; durationMs: number }> {
  const t0 = performance.now();

  try {
    if (!window.pyodideInstance) {
      onLog({
        id: generateId(),
        type: 'system',
        message: t('run.pyConnecting'),
        timestamp: getTimestamp(),
      });

      if (!window.loadPyodide) {
        await loadScript('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
      }

      window.pyodideInstance = await window.loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
      });
    }

    const pyodide = window.pyodideInstance;

    pyodide.setStdout({
      batched: (text: string) => {
        onLog({
          id: generateId(),
          type: 'log',
          message: text,
          timestamp: getTimestamp(),
        });
      },
    });

    pyodide.setStderr({
      batched: (text: string) => {
        onLog({
          id: generateId(),
          type: 'error',
          message: text,
          timestamp: getTimestamp(),
        });
      },
    });

    await pyodide.runPythonAsync(code);
    const durationMs = Math.round(performance.now() - t0);
    return { success: true, durationMs };
  } catch (err: any) {
    const durationMs = Math.round(performance.now() - t0);
    onLog({
      id: generateId(),
      type: 'error',
      message: t('run.pyNotice', { error: err.message || String(err) }),
      timestamp: getTimestamp(),
    });
    return { success: false, durationMs };
  }
}

async function executeBashClientFallback(
  code: string,
  onLog: (entry: LogEntry) => void
): Promise<{ success: boolean; durationMs: number }> {
  const t0 = performance.now();
  const lines = code.split('\n');

  const envVars: Record<string, string> = {
    USER: 'developer',
    HOME: '/home/developer',
    PATH: '/usr/local/bin:/usr/bin:/bin',
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine || rawLine.startsWith('#')) continue;

    const assignMatch = rawLine.match(/^([A-Za-z_][A-Za-z0-9_]*)=["']?(.*?)["']?$/);
    if (assignMatch) {
      envVars[assignMatch[1]] = assignMatch[2];
      continue;
    }

    if (rawLine.startsWith('echo ') || rawLine === 'echo') {
      let text = rawLine.replace(/^echo\s+(-e\s+)?/, '').replace(/^["']|["']$/g, '');
      text = text.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, varName) => envVars[varName] || '');
      onLog({
        id: generateId(),
        type: 'log',
        message: text,
        timestamp: getTimestamp(),
      });
      continue;
    }

    if (rawLine.startsWith('log ') || rawLine.startsWith('warn ') || rawLine.startsWith('err ')) {
      const type = rawLine.startsWith('err ') ? 'error' : rawLine.startsWith('warn ') ? 'warn' : 'info';
      const text = rawLine.replace(/^(log|warn|err)\s+/, '').replace(/^["']|["']$/g, '');
      onLog({
        id: generateId(),
        type,
        message: text,
        timestamp: getTimestamp(),
      });
      continue;
    }
  }

  const durationMs = Math.round(performance.now() - t0);
  onLog({
    id: generateId(),
    type: 'success',
    message: t('run.completed', { ms: durationMs }),
    timestamp: getTimestamp(),
  });

  return { success: true, durationMs };
}

let sqlEnginePromise: Promise<SqlJsStatic> | null = null;

export function loadSqlEngine(): Promise<SqlJsStatic> {
  if (!sqlEnginePromise) {
    // sql.js loads only when the first SQL file runs
    sqlEnginePromise = import('sql.js').then((m) => m.default({ locateFile: () => sqlWasmUrl })).catch((err) => {
      sqlEnginePromise = null; // allow a retry on the next run
      throw err;
    });
  }
  return sqlEnginePromise;
}

const MAX_RESULT_ROWS = 1000;

function shortStatement(sql: string): string {
  const oneLine = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return oneLine.length > 90 ? oneLine.slice(0, 87) + '...' : oneLine;
}

/**
 * Execute a SQL script in a fresh in-browser SQLite database (sql.js).
 * Every statement that returns rows produces its own result table.
 */
export async function executeSQL(
  code: string,
  onLog: (entry: LogEntry) => void
): Promise<{ success: boolean; durationMs: number; tables: TableData[] }> {
  const t0 = performance.now();
  const tables: TableData[] = [];
  const log = (type: LogEntry['type'], message: string) =>
    onLog({ id: generateId(), type, message, timestamp: getTimestamp() });

  log('system', t('run.sqlExec'));

  let SQL: SqlJsStatic;
  try {
    SQL = await loadSqlEngine();
  } catch (err: any) {
    log('error', t('run.sqlEngineFailed', { error: err?.message || String(err) }));
    return { success: false, durationMs: Math.round(performance.now() - t0), tables };
  }

  const db: Database = new SQL.Database();
  let statements = 0;
  let changed = 0;
  let success = true;
  // Errors thrown while a statement runs belong to it; errors from preparing come from the next one
  let failedAt: number | null = null;

  try {
    for (const stmt of db.iterateStatements(code)) {
      const sqlText = stmt.getSQL();
      try {
        statements++;
        const columns = stmt.getColumnNames();
        if (columns.length > 0) {
          const rows: TableData['rows'] = [];
          let total = 0;
          while (stmt.step()) {
            total++;
            if (rows.length < MAX_RESULT_ROWS) {
              rows.push(
                stmt.get().map((v) => (v instanceof Uint8Array ? `<BLOB ${v.length} bytes>` : (v as string | number | null)))
              );
            }
          }
          tables.push({ columns, rows, statement: shortStatement(sqlText), totalRows: total });
          log('info', t('run.sqlResult', { n: tables.length, rows: total }));
          if (total > MAX_RESULT_ROWS) log('warn', t('run.sqlTruncated', { max: MAX_RESULT_ROWS }));
        } else {
          stmt.step();
          changed += db.getRowsModified();
        }
      } catch (err) {
        failedAt = statements;
        throw err;
      } finally {
        stmt.free();
      }
    }
  } catch (err: any) {
    success = false;
    log('error', t('run.sqlError', { n: failedAt ?? statements + 1, error: err?.message || String(err) }));
  } finally {
    db.close();
  }

  const durationMs = Math.round(performance.now() - t0);
  if (success) {
    log('success', t('run.sqlDone', { statements, changed, results: tables.length, ms: durationMs }));
  }
  return { success, durationMs, tables };
}

/** Load a script from a URL once (used for the in-browser Python fallback, Pyodide). */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}
