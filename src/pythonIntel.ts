// Python code intelligence in the editor (Jedi on the server): completions, parameter hints, hover docs,
// go to definition (F12 / Ctrl+click, also into other project files) and rename everywhere (F2).
import { monaco } from './monacoSetup.ts';
import { t } from './i18n.ts';

type Model = ReturnType<(typeof monaco)['editor']['createModel']>;

export interface PyIntelHooks {
  fileName: (model: Model) => string;
  projectId: () => string | null;
  /** Jedi is not installed: the status bar offers to install it */
  onMissing: () => void;
  onAvailable: () => void;
  /** Open a project file at a line (go to definition into another file) */
  openFile?: (name: string, line: number) => void;
  /** Replace the content of project files (rename touches several files) */
  applyFiles?: (files: { name: string; content: string }[]) => void;
}

let hooks: PyIntelHooks | null = null;
export const setPyIntelHooks = (h: Partial<PyIntelHooks>) => {
  hooks = { ...(hooks as PyIntelHooks), ...h };
};

/** Other project files are addressed as scfile:/<name> so the editor opener can hand them to the studio */
const FILE_SCHEME = 'scfile';

async function ask(op: string, model: Model, position: { lineNumber: number; column: number }, more: Record<string, unknown> = {}) {
  if (!hooks) return null;
  const res = await fetch(`/api/code/py/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: hooks.fileName(model),
      code: model.getValue(),
      line: position.lineNumber,
      column: position.column,
      projectId: hooks.projectId(),
      ...more,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409 && data.code === 'jedi-missing') {
    hooks.onMissing();
    return null;
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  hooks.onAvailable();
  return data;
}

const KIND: Record<string, number> = {
  function: monaco.languages.CompletionItemKind.Function,
  class: monaco.languages.CompletionItemKind.Class,
  module: monaco.languages.CompletionItemKind.Module,
  instance: monaco.languages.CompletionItemKind.Variable,
  statement: monaco.languages.CompletionItemKind.Variable,
  param: monaco.languages.CompletionItemKind.Variable,
  property: monaco.languages.CompletionItemKind.Property,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  path: monaco.languages.CompletionItemKind.File,
};

const fence = (code: string) => '```python\n' + code + '\n```';
/** Jedi's docstrings start with the signature, which is shown separately */
const docOnly = (doc: string, name: string) => (doc.startsWith(name + '(') ? doc.split('\n\n').slice(1).join('\n\n') : doc).trim();

let registered = false;

export function registerPythonIntel() {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position) {
      try {
        const data = await ask('complete', model, position);
        if (!data) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        return {
          suggestions: data.items.map((it: any, i: number) => ({
            label: it.name,
            kind: KIND[it.type] ?? monaco.languages.CompletionItemKind.Text,
            insertText: it.name,
            range,
            detail: it.signature || (it.module && it.module !== '__main__' ? `${it.type} · ${it.module}` : it.type),
            documentation: it.doc && docOnly(it.doc, it.name) ? { value: docOnly(it.doc, it.name) } : undefined,
            // Jedi's order is meaningful (locals first, then imports...); "_private" names last
            sortText: `${it.name.startsWith('_') ? 'z' : 'a'}${String(i).padStart(4, '0')}`,
          })),
        };
      } catch {
        return { suggestions: [] };
      }
    },
  });

  monaco.languages.registerSignatureHelpProvider('python', {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],
    async provideSignatureHelp(model, position) {
      try {
        const data = await ask('signatures', model, position);
        if (!data?.signatures?.length) return null;
        const s = data.signatures[0];
        return {
          value: {
            signatures: data.signatures.map((sig: any) => ({
              label: sig.label,
              documentation: sig.doc ? { value: sig.doc } : undefined,
              parameters: sig.params.map((p: string) => ({ label: p })),
            })),
            activeSignature: 0,
            activeParameter: Math.max(0, s.index ?? 0),
          },
          dispose() {},
        };
      } catch {
        return null;
      }
    },
  });

  monaco.languages.registerHoverProvider('python', {
    async provideHover(model, position) {
      if (!model.getWordAtPosition(position)) return null;
      try {
        const data = await ask('hover', model, position);
        const it = data?.items?.[0];
        if (!it || (!it.signature && !it.doc && it.type === 'keyword')) return null;
        const head = it.signature || it.description || it.name;
        const where = it.module && it.module !== '__main__' && it.module !== 'builtins' ? `\n\n*${it.module}*` : '';
        const doc = it.doc ? docOnly(it.doc, it.name) : '';
        return { contents: [{ value: fence(head) }, ...(doc || where ? [{ value: (doc + where).trim() }] : [])] };
      } catch {
        return null;
      }
    },
  });

  monaco.languages.registerDefinitionProvider('python', {
    async provideDefinition(model, position) {
      try {
        const data = await ask('definition', model, position);
        const current = hooks?.fileName(model);
        const out: any[] = [];
        for (const loc of data?.locations || []) {
          if (loc.external || !loc.file) continue; // libraries: not opened in the studio
          const range = new monaco.Range(loc.line, loc.column, loc.line, loc.column + (loc.name?.length || 1));
          out.push({ uri: loc.file === current ? model.uri : monaco.Uri.from({ scheme: FILE_SCHEME, path: '/' + loc.file }), range });
        }
        return out;
      } catch {
        return [];
      }
    },
  });

  // F12 into another project file: the studio opens that file at the line
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== FILE_SCHEME || !hooks?.openFile) return false;
      const line = selectionOrPosition && 'startLineNumber' in selectionOrPosition ? selectionOrPosition.startLineNumber : (selectionOrPosition as any)?.lineNumber || 1;
      hooks.openFile(resource.path.replace(/^\//, ''), line);
      return true;
    },
  });

  monaco.languages.registerRenameProvider('python', {
    async provideRenameEdits(model, position, newName) {
      const data = await ask('rename', model, position, { newName });
      if (!data) return { edits: [], rejectReason: t('pyintel.missing') };
      const current = hooks?.fileName(model);
      const others = (data.files as { name: string; content: string }[]).filter((f) => f.name !== current);
      const mine = (data.files as { name: string; content: string }[]).find((f) => f.name === current);
      // Other files change in the studio's project state (with history), this one as a normal undoable edit
      if (others.length) hooks?.applyFiles?.(others);
      return {
        edits: mine
          ? [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: model.getFullModelRange(), text: mine.content } }]
          : [],
      };
    },
    async resolveRenameLocation(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '', rejectReason: t('pyintel.noSymbol') };
      return { range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), text: word.word };
    },
  });
}
