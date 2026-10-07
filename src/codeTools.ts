// Formatting (Shift+Alt+F, the editor's "Format" button) and Python checks in the editor:
// Prettier for JS/TS/CSS/HTML/JSON/Markdown/YAML, Ruff for Python (underlines + quick fixes on the 💡 lightbulb).
import { monaco } from './monacoSetup.ts';
import { t } from './i18n.ts';
import { registerPythonIntel, setPyIntelHooks } from './pythonIntel.ts';

type Monaco = typeof monaco;
type Model = ReturnType<Monaco['editor']['createModel']>;

interface Diagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  url?: string;
  fix?: { message: string; edits: { line: number; column: number; endLine: number; endColumn: number; text: string }[] };
}

export interface CodeToolsState {
  /** null: not checked yet */
  ruff: boolean | null;
  /** Jedi (Python completions, hints, go to definition) */
  jedi: boolean | null;
  /** Tool being installed */
  installing: false | 'ruff' | 'jedi';
  /** Last formatter/linter error, shown in the status bar */
  error: string | null;
}

const PRETTIER_LANGUAGES = ['javascript', 'typescript', 'css', 'scss', 'less', 'html', 'json', 'markdown', 'yaml'];
const LINT_DELAY_MS = 500;
const OWNER = 'ruff';

let state: CodeToolsState = { ruff: null, jedi: null, installing: false, error: null };
const listeners = new Set<(s: CodeToolsState) => void>();
const setState = (patch: Partial<CodeToolsState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
};
export const getCodeToolsState = () => state;
export function subscribeCodeTools(fn: (s: CodeToolsState) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** File name and project of each editor model (models are keyed by file id). */
const modelInfo = new Map<string, { name: string }>();
let projectId: string | null = null;
export function setModelFile(model: Model, name: string) {
  modelInfo.set(model.uri.toString(), { name });
}
export function setCodeToolsProject(id: string | null) {
  projectId = id;
}
const fileName = (model: Model) => modelInfo.get(model.uri.toString())?.name || `file.${model.getLanguageId() === 'python' ? 'py' : 'txt'}`;

async function post(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, projectId }) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409 && data.code === 'ruff-missing') setState({ ruff: false });
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, code: data.code });
  return data;
}

export async function refreshCodeTools() {
  try {
    const res = await fetch('/api/code/tools');
    const data = await res.json();
    setState({ ruff: !!data.ruff, jedi: !!data.jedi });
  } catch {
    // server restarting
  }
}

/** Install Ruff or Jedi into the studio (returns the run id whose output the caller shows in the terminal). */
export async function startToolInstall(tool: 'ruff' | 'jedi'): Promise<string> {
  setState({ installing: tool, error: null });
  try {
    const res = await fetch(`/api/code/tools/${tool}/install`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.runId;
  } catch (e) {
    setState({ installing: false });
    throw e;
  }
}
export async function finishToolInstall() {
  setState({ installing: false });
  await refreshCodeTools();
  for (const model of monaco.editor.getModels()) if (model.getLanguageId() === 'python') scheduleLint(model);
}

// ---------- Python checks ----------
const diagnosticsByModel = new Map<string, Diagnostic[]>();
const lintTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lintVersion = new Map<string, number>();

function toMarker(d: Diagnostic): Parameters<Monaco['editor']['setModelMarkers']>[2][number] {
  const sev = d.severity === 'error' ? monaco.MarkerSeverity.Error : d.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info;
  return {
    startLineNumber: d.line,
    startColumn: d.column,
    endLineNumber: d.endLine,
    // Zero-width ranges would be invisible
    endColumn: d.endLine === d.line && d.endColumn <= d.column ? d.column + 1 : d.endColumn,
    severity: sev,
    message: d.message,
    source: 'Ruff',
    code: d.url ? { value: d.code, target: monaco.Uri.parse(d.url) } : d.code,
  };
}

async function lintNow(model: Model) {
  if (model.isDisposed() || model.getLanguageId() !== 'python' || state.ruff === false) return;
  const key = model.uri.toString();
  const version = model.getVersionId();
  lintVersion.set(key, version);
  try {
    const { diagnostics } = (await post('/api/code/lint', { name: fileName(model), code: model.getValue() })) as { diagnostics: Diagnostic[] };
    if (model.isDisposed() || lintVersion.get(key) !== version) return; // an older answer
    if (state.ruff !== true) setState({ ruff: true });
    diagnosticsByModel.set(key, diagnostics);
    monaco.editor.setModelMarkers(model, OWNER, diagnostics.map(toMarker));
  } catch {
    if (!model.isDisposed()) monaco.editor.setModelMarkers(model, OWNER, []);
  }
}

/** Check a Python model after a short pause in typing. */
export function scheduleLint(model: Model) {
  if (model.getLanguageId() !== 'python') return;
  const key = model.uri.toString();
  clearTimeout(lintTimers.get(key));
  lintTimers.set(key, setTimeout(() => lintNow(model), LINT_DELAY_MS));
}

export function problemCount(model: Model | null): number {
  if (!model) return 0;
  return monaco.editor.getModelMarkers({ resource: model.uri, owner: OWNER }).length;
}

// ---------- registration ----------
let registered = false;

export function registerCodeTools() {
  if (registered) return;
  registered = true;
  refreshCodeTools();
  registerPythonIntel();
  setPyIntelHooks({
    fileName,
    projectId: () => projectId,
    onMissing: () => state.jedi !== false && setState({ jedi: false }),
    onAvailable: () => state.jedi !== true && setState({ jedi: true }),
  });

  // Registered after Monaco's own formatters, so these win for JS/TS/CSS/HTML/JSON
  for (const language of ['python', ...PRETTIER_LANGUAGES]) {
    monaco.languages.registerDocumentFormattingEditProvider(language, {
      displayName: language === 'python' ? 'Ruff' : 'Prettier',
      async provideDocumentFormattingEdits(model) {
        try {
          const { code } = await post('/api/code/format', { name: fileName(model), code: model.getValue() });
          setState({ error: null });
          if (code === model.getValue()) return [];
          return [{ range: model.getFullModelRange(), text: code }];
        } catch (e: any) {
          if (e.code !== 'ruff-missing') setState({ error: t('tools.formatFailed', { error: e.message }) });
          return [];
        }
      },
    });
  }

  monaco.languages.registerCodeActionProvider('python', {
    async provideCodeActions(model, range) {
      const diagnostics = diagnosticsByModel.get(model.uri.toString()) || [];
      const here = diagnostics.filter((d) => d.line <= range.endLineNumber && d.endLine >= range.startLineNumber);
      const actions: any[] = [];
      for (const d of here) {
        const marker = toMarker(d);
        if (d.fix) {
          actions.push({
            title: `${d.fix.message} (${d.code})`,
            kind: 'quickfix',
            diagnostics: [marker],
            isPreferred: true,
            edit: {
              edits: d.fix.edits.map((e) => ({
                resource: model.uri,
                versionId: model.getVersionId(),
                textEdit: { range: new monaco.Range(e.line, e.column, e.endLine, e.endColumn), text: e.text },
              })),
            },
          });
        }
        if (d.code !== 'invalid-syntax' && d.code !== 'syntax') {
          // "# noqa: CODE" at the end of the line hides this hint
          const line = model.getLineContent(d.line);
          const noqa = /#\s*noqa(?::\s*([\w, ]+))?\s*$/i.exec(line);
          const text = noqa ? `${line.slice(0, noqa.index).trimEnd()}  # noqa: ${[...(noqa[1] ? noqa[1].split(/[,\s]+/).filter(Boolean) : []), d.code].join(', ')}` : `${line}  # noqa: ${d.code}`;
          actions.push({
            title: t('tools.ignoreLine', { code: d.code }),
            kind: 'quickfix',
            diagnostics: [marker],
            edit: {
              edits: [
                {
                  resource: model.uri,
                  versionId: model.getVersionId(),
                  textEdit: { range: new monaco.Range(d.line, 1, d.line, line.length + 1), text },
                },
              ],
            },
          });
        }
      }
      if (diagnostics.some((d) => d.fix)) {
        actions.push({ title: t('tools.fixAll'), kind: 'source.fixAll', command: { id: FIX_ALL_COMMAND, title: t('tools.fixAll'), arguments: [model.uri.toString()] } });
      }
      return { actions, dispose() {} };
    },
  });

  monaco.editor.registerCommand(FIX_ALL_COMMAND, (_accessor, uri: string) => fixAll(monaco.editor.getModel(monaco.Uri.parse(uri))));
}

const FIX_ALL_COMMAND = 'scriptcraft.ruffFixAll';

/** Apply every safe Ruff fix to the file (one undo step). */
export async function fixAll(model: Model | null) {
  if (!model || model.getLanguageId() !== 'python') return;
  try {
    const { code } = await post('/api/code/fix', { name: fileName(model), code: model.getValue() });
    if (code !== model.getValue()) {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: code }], () => null);
      model.pushStackElement();
    }
    setState({ error: null });
  } catch (e: any) {
    if (e.code !== 'ruff-missing') setState({ error: t('tools.formatFailed', { error: e.message }) });
  }
}

export const formatsWithTools = (language: string) => language === 'python' || PRETTIER_LANGUAGES.includes(language);
