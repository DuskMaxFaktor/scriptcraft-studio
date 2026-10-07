// Monaco (the VS Code editor) bundled locally, so the studio works offline.
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// Scripts here run in Node, which the in-browser TypeScript service knows nothing about:
// don't flag missing modules (fs, path...), require/process, or untyped imports.
const IGNORED_TS_DIAGNOSTICS = [2307, 2580, 2584, 2591, 2592, 7016, 2792, 1375, 1378];
const compilerOptions = {
  target: monaco.typescript.ScriptTarget.ESNext,
  module: monaco.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
  allowJs: true,
  allowNonTsExtensions: true,
  esModuleInterop: true,
};
monaco.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
monaco.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ diagnosticCodesToIgnore: IGNORED_TS_DIAGNOSTICS });
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  diagnosticCodesToIgnore: IGNORED_TS_DIAGNOSTICS,
});

// Themes matching the studio surfaces
monaco.editor.defineTheme('scriptcraft-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0d1117',
    'editorGutter.background': '#090d14',
    'editorLineNumber.foreground': '#4b5563',
    'editorLineNumber.activeForeground': '#c9d1d9',
    'editor.lineHighlightBackground': '#161b2280',
    'editorWidget.background': '#161b22',
  },
});
monaco.editor.defineTheme('scriptcraft-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorGutter.background': '#f6f8fa',
    'editorLineNumber.foreground': '#9ca3af',
    'editorLineNumber.activeForeground': '#1f2937',
    'editor.lineHighlightBackground': '#f1f4f880',
  },
});

// Always use LF line endings: on Windows Monaco would default to CRLF, which breaks bash scripts
// ("$'\r': command not found") and makes files differ from what other tools write
monaco.editor.onDidCreateModel((model) => model.setEOL(monaco.editor.EndOfLineSequence.LF));

loader.config({ monaco });

export { monaco };
