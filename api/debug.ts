import { Router } from 'express';
import net from 'net';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { prepareRun, attachPackages, cleanup, spawnCommand, startSession, type ProjectFileInput } from './run.ts';

// Debugger sessions. The program itself runs as a normal streamable run session (output, stdin, Stop);
// this module adds the control channel: breakpoints, stepping, call stack and variables.
//   Python:     api/debug/py_runner.py (bdb) connected over a local TCP socket (JSON lines)
//   JavaScript: Node's inspector (Chrome DevTools Protocol) over WebSocket

/** A breakpoint: a 1-based line, optionally conditional (stops only when the expression is truthy). */
export interface Breakpoint {
  line: number;
  condition?: string;
  /** Logpoint: print this message ({expr} parts are evaluated) instead of stopping */
  log?: string;
}

/** A Node logpoint as a CDP condition: log the message, then return false so the program never stops. */
function nodeLogCondition(log: string): string {
  const parts = log.split(/(\{[^{}]+\})/);
  const body = parts
    .map((p) => (/^\{[^{}]+\}$/.test(p) ? '${(' + p.slice(1, -1) + ')}' : p.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')))
    .join('');
  return `(console.log(\`${body}\`), false)`;
}
type Breakpoints = Record<string, Breakpoint[]>; // project file path -> breakpoints

/** Accept either plain line numbers or {line, condition} objects; keep only valid, positive lines. */
function normalizeBreakpoints(raw: unknown): Breakpoints {
  const out: Breakpoints = {};
  for (const [file, list] of Object.entries((raw as Record<string, unknown>) || {})) {
    if (!Array.isArray(list)) continue;
    const bps: Breakpoint[] = [];
    for (const item of list) {
      const line = Number(typeof item === 'object' && item ? (item as any).line : item);
      if (!Number.isInteger(line) || line <= 0) continue;
      const condition = typeof item === 'object' && item && typeof (item as any).condition === 'string' ? (item as any).condition.trim().slice(0, 1000) : '';
      const log = typeof item === 'object' && item && typeof (item as any).log === 'string' ? (item as any).log.slice(0, 1000) : '';
      bps.push({ line, ...(condition ? { condition } : {}), ...(log.trim() ? { log } : {}) });
    }
    out[file] = bps;
  }
  return out;
}

export interface DebugVariable {
  name: string;
  value: string;
  type: string;
}

export type DebugEvent =
  | {
      event: 'stopped';
      reason: string;
      file: string | null;
      line: number;
      stack: { file: string; line: number; name: string }[];
      locals: DebugVariable[];
      globals: DebugVariable[];
    }
  | { event: 'running' }
  | { event: 'terminated' }
  | { event: 'evalResult'; expr: string; value?: string; type?: string; error?: string }
  | { event: 'error'; message: string };

interface Adapter {
  command(cmd: 'continue' | 'next' | 'step' | 'out' | 'stop'): void | Promise<void>;
  setBreakpoints(bps: Breakpoints): void | Promise<void>;
  evaluate(expr: string): void;
  dispose(): void;
}

interface DebugSession {
  runId: string;
  adapter: Adapter | null;
  events: DebugEvent[];
  listeners: Set<(e: DebugEvent, index: number) => void>;
  /** JavaScript: call frame used for evaluating expressions while paused */
  lastFrameId?: string;
}

const sessions = new Map<string, DebugSession>();
const DEBUG_MAX_MS = 60 * 60 * 1000; // stopping at a breakpoint can take a while

function emit(s: DebugSession, e: DebugEvent) {
  s.events.push(e);
  // keep the replay buffer small: only the latest "stopped" state matters
  if (s.events.length > 200) s.events.splice(0, s.events.length - 200);
  s.listeners.forEach((l) => l(e, s.events.length - 1));
}

// Next to this module, so it is found whatever the server's working folder is
const PY_RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'debug', 'py_runner.py');

// ---------------- Python ----------------

function startPython(s: DebugSession, root: string, entryAbs: string, bps: Breakpoints, env: NodeJS.ProcessEnv, cwd: string) {
  let sock: net.Socket | null = null;
  const pending: string[] = [];
  const write = (obj: unknown) => {
    const line = JSON.stringify(obj) + '\n';
    if (sock) sock.write(line);
    else pending.push(line);
  };
  const server = net.createServer((socket) => {
    sock = socket;
    server.close(); // one connection only
    pending.splice(0).forEach((l) => socket.write(l));
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          emit(s, JSON.parse(line));
        } catch {
          // ignore malformed lines
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise<{ proc: ReturnType<typeof spawnCommand>; adapter: Adapter }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      const proc = spawnCommand(process.platform === 'win32' ? 'python' : 'python3', ['-u', PY_RUNNER, entryAbs], cwd, {
        ...env,
        SCRIPTCRAFT_DEBUG_PORT: String(port),
        SCRIPTCRAFT_DEBUG_ROOT: root,
        SCRIPTCRAFT_BREAKPOINTS: JSON.stringify(bps),
      });
      resolve({
        proc,
        adapter: {
          command: (cmd) => write({ cmd }),
          setBreakpoints: (b) => write({ cmd: 'setBreakpoints', breakpoints: b }),
          evaluate: (expr) => write({ cmd: 'eval', expr }),
          dispose: () => {
            server.close();
            sock?.destroy();
          },
        },
      });
    });
  });
}

// ---------------- JavaScript / TypeScript (Node inspector / CDP) ----------------

/**
 * `nodeArgs` is what node receives after `--inspect-brk`: `[entry.js]` or
 * `['--experimental-strip-types', entry.ts]` (strip-types exposes .ts to the inspector; tsx CLI does not).
 * When `pathStyleScripts` is set, Node may report scripts as bare filesystem paths instead of file:// URLs.
 */
function startNode(
  s: DebugSession,
  root: string,
  nodeArgs: string[],
  bps: Breakpoints,
  env: NodeJS.ProcessEnv,
  cwd: string,
  pathStyleScripts = false
) {
  const proc = spawnCommand('node', ['--inspect-brk=127.0.0.1:0', ...nodeArgs], cwd, env);
  const rootUrl = pathToFileURL(root).href.toLowerCase() + '/';
  const rootAbs = path.resolve(root);
  const rootAbsLower = rootAbs.toLowerCase();
  let ws: WebSocket | null = null;
  let nextId = 1;
  const callbacks = new Map<number, (result: any) => void>();
  let breakpointIds: string[] = [];
  let currentBps = bps;
  let entryPauseSkipped = false;
  // Paused call frames carry only a scriptId (their url is empty in current V8): remember script urls
  const scriptUrls = new Map<string, string>();
  const frameUrl = (f: any): string => f.url || scriptUrls.get(f.location?.scriptId) || '';

  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      if (!ws || ws.readyState !== 1) return resolve(null);
      const id = nextId++;
      callbacks.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const normalizeFs = (p: string) => path.resolve(p.replace(/^\\\\\?\\/, ''));
  const underRoot = (absPath: string): string | null => {
    const abs = normalizeFs(absPath);
    const absLower = abs.toLowerCase();
    const rootPosix = rootAbsLower.replace(/\\/g, '/');
    const absPosix = absLower.replace(/\\/g, '/');
    if (absLower === rootAbsLower || absLower.startsWith(rootAbsLower + path.sep)) {
      return path.relative(rootAbs, abs).replace(/\\/g, '/');
    }
    if (absPosix === rootPosix || absPosix.startsWith(rootPosix + '/')) {
      return path.relative(rootAbs, abs).replace(/\\/g, '/');
    }
    return null;
  };
  /** Map a CDP script URL (file:// or bare path) to a project-relative path. */
  const relOf = (url: string): string | null => {
    if (!url) return null;
    try {
      if (/^file:/i.test(url)) return underRoot(fileURLToPath(url));
      if (path.isAbsolute(url) || /^[a-zA-Z]:[\\/]/.test(url)) return underRoot(url);
    } catch {
      /* not a filesystem url */
    }
    // Last resort: prefix match on the file:// form (same as older Node builds)
    const lower = url.toLowerCase();
    if (lower.startsWith(rootUrl)) {
      try {
        return underRoot(fileURLToPath(url));
      } catch {
        return null;
      }
    }
    return null;
  };
  // Case-insensitive pattern without regex flags (V8 urlRegex does not support "(?i)"): "c:" -> "[cC]:"
  const ciPattern = (t: string) =>
    t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[a-z]/gi, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);

  /** CDP scriptId → project-relative path (filled from scriptParsed). */
  const scriptRels = new Map<string, string>();
  /** Serialize breakpoint updates so clear+continue cannot race leftover hits. */
  let applyChain: Promise<void> = Promise.resolve();

  const bpExtra = (bp: Breakpoint) =>
    bp.log ? { condition: nodeLogCondition(bp.log) } : bp.condition ? { condition: bp.condition } : {};

  /** Bind by scriptId once V8 has parsed the file (most reliable on CI / Node 22+). */
  const applyBreakpointsForScript = async (scriptId: string, rel: string) => {
    const list = currentBps[rel];
    if (!list?.length) return;
    for (const bp of list) {
      const r = await send('Debugger.setBreakpoint', {
        location: { scriptId, lineNumber: bp.line - 1 },
        ...bpExtra(bp),
      });
      if (r?.breakpointId) breakpointIds.push(r.breakpointId);
    }
  };

  const applyBreakpointsInner = async (b: Breakpoints) => {
    currentBps = b;
    for (const id of breakpointIds) await send('Debugger.removeBreakpoint', { breakpointId: id });
    breakpointIds = [];
    for (const [rel, list] of Object.entries(b)) {
      if (!list?.length) continue;
      // Prefer scriptId when the file is already parsed — avoids duplicate URL hits and clear races.
      const idsForRel = [...scriptRels].filter(([, r]) => r === rel).map(([id]) => id);
      if (idsForRel.length) {
        for (const scriptId of idsForRel) await applyBreakpointsForScript(scriptId, rel);
        continue;
      }
      const abs = path.join(root, rel);
      const url = pathToFileURL(abs).href;
      const absPosix = abs.replace(/\\/g, '/');
      for (const bp of list) {
        const extra = bpExtra(bp);
        // Node may report file://, bare Windows paths, or forward-slash paths (GHA / strip-types).
        const targets: Record<string, unknown>[] = [
          { urlRegex: `^${ciPattern(url)}$` },
          { url: abs },
          { urlRegex: `^${ciPattern(absPosix)}$` },
        ];
        if (absPosix !== abs) targets.push({ url: absPosix });
        if (pathStyleScripts && absPosix === abs) targets.push({ url: absPosix });
        for (const target of targets) {
          const r = await send('Debugger.setBreakpointByUrl', {
            lineNumber: bp.line - 1,
            ...target,
            ...extra,
          });
          if (r?.breakpointId) breakpointIds.push(r.breakpointId);
        }
      }
    }
  };

  const applyBreakpoints = (b: Breakpoints) => {
    applyChain = applyChain.then(() => applyBreakpointsInner(b)).catch(() => undefined);
    return applyChain;
  };

  const describe = (v: any): { value: string; type: string } => {
    if (!v) return { value: 'undefined', type: 'undefined' };
    if (v.type === 'string') return { value: JSON.stringify(v.value), type: 'string' };
    if ('value' in v && v.type !== 'object') return { value: String(v.value), type: v.type };
    if (v.unserializableValue) return { value: v.unserializableValue, type: v.type };
    return { value: v.description || v.type, type: v.subtype || v.className || v.type };
  };

  const onPaused = async (p: any) => {
    // --inspect-brk stops before the first line: skip it, the studio runs until the first breakpoint
    if (!entryPauseSkipped && p.reason === 'Break on start') {
      entryPauseSkipped = true;
      // Late scriptParsed rebinds must finish before resume or CI gets terminated instead of stopped.
      await applyChain;
      await send('Debugger.resume');
      return;
    }
    const frames = (p.callFrames || []) as any[];
    const stack = frames
      .map((f) => ({ file: relOf(frameUrl(f)), line: f.location.lineNumber + 1, name: f.functionName || '<module>' }))
      .filter((f) => f.file) as { file: string; line: number; name: string }[];
    if (stack.length === 0) {
      // paused outside the project (node internals): step back out
      await send('Debugger.stepOut');
      return;
    }
    const top = frames.find((f) => relOf(frameUrl(f))) || frames[0];
    const locals: DebugVariable[] = [];
    const globals: DebugVariable[] = [];
    for (const scope of top.scopeChain as any[]) {
      if (!['local', 'block', 'closure', 'script', 'module'].includes(scope.type) || !scope.object?.objectId) continue;
      const props = await send('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true });
      for (const prop of props?.result || []) {
        if (prop.name === 'this' || prop.name.startsWith('__')) continue;
        if (['exports', 'require', 'module', '__filename', '__dirname'].includes(prop.name)) continue;
        const target = scope.type === 'local' || scope.type === 'block' ? locals : globals;
        target.push({ name: prop.name, ...describe(prop.value) });
      }
    }
    s.lastFrameId = top.callFrameId;
    emit(s, {
      event: 'stopped',
      reason: (p.hitBreakpoints || []).length ? 'breakpoint' : 'step',
      file: stack[0].file,
      line: stack[0].line,
      stack,
      locals,
      globals,
    });
  };

  // When the program is done, Node keeps waiting for the debugger to detach: let it exit
  proc.stderr?.on('data', (chunk: Buffer) => {
    if (chunk.toString('utf-8').includes('Waiting for the debugger to disconnect')) ws?.close();
  });

  let stderrBuf = '';
  proc.stderr?.on('data', async (chunk: Buffer) => {
    if (ws) return;
    stderrBuf += chunk.toString('utf-8');
    const m = stderrBuf.match(/Debugger listening on (ws:\/\/\S+)/);
    if (!m) return;
    ws = new WebSocket(m[1]);
    ws.onmessage = (msg) => {
      const data = JSON.parse(String(msg.data));
      if (data.id && callbacks.has(data.id)) {
        callbacks.get(data.id)!(data.result);
        callbacks.delete(data.id);
      } else if (data.method === 'Debugger.scriptParsed') {
        const { scriptId, url } = data.params || {};
        if (scriptId && url) {
          scriptUrls.set(scriptId, url);
          const rel = relOf(url);
          if (rel) {
            scriptRels.set(scriptId, rel);
            // Additive bind only — a full refresh here can clear BPs after the program has resumed.
            applyChain = applyChain.then(() => applyBreakpointsForScript(scriptId, rel)).catch(() => undefined);
          }
        }
      } else if (data.method === 'Debugger.paused') onPaused(data.params);
      else if (data.method === 'Debugger.resumed') emit(s, { event: 'running' });
    };
    ws.onopen = async () => {
      await send('Runtime.enable');
      await send('Debugger.enable');
      // never stop inside Node's own code or dependencies when stepping
      await send('Debugger.setBlackboxPatterns', { patterns: ['^node:', 'node_modules'] });
      // Debugger.enable re-emits scriptParsed for already-loaded scripts before its response;
      // one tick lets those handlers fill scriptRels before we bind + resume.
      await new Promise((r) => setImmediate(r));
      await applyBreakpoints(currentBps);
      await applyChain;
      await send('Runtime.runIfWaitingForDebugger');
    };
    ws.onerror = () => emit(s, { event: 'error', message: 'Cannot connect to the Node.js debugger' });
  });

  const adapter: Adapter = {
    command: async (cmd) => {
      const map = { continue: 'Debugger.resume', next: 'Debugger.stepOver', step: 'Debugger.stepInto', out: 'Debugger.stepOut' } as const;
      // "stop" is done by the run session (POST /api/run/:id/stop), which kills the whole process tree
      if (cmd === 'stop') return;
      // Finish pending breakpoint updates before resume/step so cleared BPs cannot still fire.
      await applyChain;
      await send(map[cmd]);
    },
    setBreakpoints: (b) => applyBreakpoints(b),
    evaluate: async (expr) => {
      const r = await send('Debugger.evaluateOnCallFrame', { callFrameId: s.lastFrameId, expression: expr, returnByValue: false });
      if (!r) return emit(s, { event: 'evalResult', expr, error: 'Not paused' });
      if (r.exceptionDetails) return emit(s, { event: 'evalResult', expr, error: r.result?.description || r.exceptionDetails.text });
      emit(s, { event: 'evalResult', expr, ...describe(r.result) });
    },
    dispose: () => ws?.close(),
  };
  return { proc, adapter };
}

// ---------------- routes ----------------

export const debugRouter = Router();

debugRouter.post('/start', async (req, res) => {
  const { language, code, files, entry, projectId, breakpoints } = req.body || {};
  const lang = String(language || '').toLowerCase();
  if (!['python', 'javascript', 'typescript'].includes(lang)) {
    return res.status(400).json({ error: 'The debugger supports Python, JavaScript and TypeScript files' });
  }
  if (typeof code !== 'string' || !Array.isArray(files) || typeof entry !== 'string') {
    return res.status(400).json({ error: 'code, files and entry are required' });
  }
  let prepared: ReturnType<typeof prepareRun>;
  try {
    prepared = prepareRun(lang, code, files as ProjectFileInput[], entry, typeof projectId === 'string' ? projectId : undefined);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'Cannot prepare the project for debugging' });
  }
  if (!prepared?.rootDir) return res.status(400).json({ error: 'Cannot prepare the project for debugging' });

  const bps = normalizeBreakpoints(breakpoints);

  const env = attachPackages(prepared, typeof projectId === 'string' ? projectId : undefined);
  const s: DebugSession = { runId: '', adapter: null, events: [], listeners: new Set() };
  const started =
    lang === 'python'
      ? await startPython(s, prepared.rootDir, prepared.filePath, bps, env, prepared.cwd)
      : startNode(
          s,
          prepared.rootDir,
          // tsx CLI does not expose .ts lines to the inspector; Node's strip-types does
          lang === 'typescript' ? ['--experimental-strip-types', prepared.filePath] : prepared.args,
          bps,
          env,
          prepared.cwd,
          lang === 'typescript'
        );
  s.adapter = started.adapter;
  s.runId = startSession(
    started.proc,
    () => {
      emit(s, { event: 'terminated' });
      started.adapter.dispose();
      cleanup(prepared);
      setTimeout(() => sessions.delete(s.runId), 60 * 1000);
    },
    DEBUG_MAX_MS
  );
  sessions.set(s.runId, s);
  res.json({ runId: s.runId });
});

debugRouter.get('/:id/events', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Debug session not found' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (e: DebugEvent, index: number) => {
    res.write(`id: ${index}\ndata: ${JSON.stringify(e)}\n\n`);
    if (e.event === 'terminated') res.end();
  };
  const lastId = Number(req.headers['last-event-id']);
  s.events.forEach((e, i) => {
    if (!Number.isFinite(lastId) || i > lastId) send(e, i);
  });
  if (s.events.some((e) => e.event === 'terminated')) return res.end();
  s.listeners.add(send);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => {
    clearInterval(keepAlive);
    s.listeners.delete(send);
  });
});

debugRouter.post('/:id/command', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s?.adapter) return res.status(404).json({ error: 'Debug session not found' });
  const cmd = req.body?.cmd;
  if (cmd === 'setBreakpoints') {
    await Promise.resolve(s.adapter.setBreakpoints(normalizeBreakpoints(req.body?.breakpoints)));
  } else if (cmd === 'eval') {
    s.adapter.evaluate(String(req.body?.expr || '').slice(0, 2000));
  } else if (['continue', 'next', 'step', 'out', 'stop'].includes(cmd)) {
    await Promise.resolve(s.adapter.command(cmd));
  } else {
    return res.status(400).json({ error: 'Unknown command' });
  }
  res.json({ ok: true });
});
