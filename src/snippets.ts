import type * as Monaco from 'monaco-editor';

// Code snippets: type a short prefix and pick it from the completion list (Tab/Enter) to expand a
// template with tab stops (${1}, ${2}, …). Registered once for each language.

export interface Snippet {
  prefix: string;
  body: string;
  description: string;
}

// Languages that get snippet completions (Monaco language ids). Custom snippets may target any of them.
export const SNIPPET_LANGUAGES = ['python', 'javascript', 'typescript', 'html', 'css', 'shell', 'sql', 'json', 'markdown', 'plaintext'];

const CUSTOM_KEY = 'scriptcraft-custom-snippets';
let custom: Record<string, Snippet[]> = loadCustom();

function loadCustom(): Record<string, Snippet[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '{}');
    const out: Record<string, Snippet[]> = {};
    for (const [lang, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      out[lang] = list
        .filter((s: any) => s && typeof s.prefix === 'string' && typeof s.body === 'string')
        .map((s: any) => ({ prefix: s.prefix, body: s.body, description: typeof s.description === 'string' ? s.description : '' }));
    }
    return out;
  } catch {
    return {};
  }
}

/** The user's own snippets, by language (a copy). */
export function getCustomSnippets(): Record<string, Snippet[]> {
  return JSON.parse(JSON.stringify(custom));
}

/** Replace the user's own snippets and persist them; completions pick them up immediately. */
export function setCustomSnippets(next: Record<string, Snippet[]>) {
  custom = {};
  for (const [lang, list] of Object.entries(next)) {
    const clean = (list || []).filter((s) => s.prefix.trim() && s.body).map((s) => ({ prefix: s.prefix.trim(), body: s.body, description: s.description || '' }));
    if (clean.length) custom[lang] = clean;
  }
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
  } catch {
    // storage unavailable
  }
}

const PY: Snippet[] = [
  { prefix: 'def', body: 'def ${1:name}(${2:args}):\n    ${3:pass}', description: 'Function' },
  { prefix: 'class', body: 'class ${1:Name}:\n    def __init__(self${2:, args}):\n        ${3:pass}', description: 'Class with __init__' },
  { prefix: 'for', body: 'for ${1:item} in ${2:iterable}:\n    ${3:pass}', description: 'for loop' },
  { prefix: 'while', body: 'while ${1:condition}:\n    ${2:pass}', description: 'while loop' },
  { prefix: 'if', body: 'if ${1:condition}:\n    ${2:pass}', description: 'if statement' },
  { prefix: 'ife', body: 'if ${1:condition}:\n    ${2:pass}\nelse:\n    ${3:pass}', description: 'if / else' },
  { prefix: 'try', body: 'try:\n    ${1:pass}\nexcept ${2:Exception} as ${3:e}:\n    ${4:pass}', description: 'try / except' },
  { prefix: 'with', body: 'with ${1:open(${2:path})} as ${3:f}:\n    ${4:pass}', description: 'with statement' },
  { prefix: 'main', body: 'def main():\n    ${1:pass}\n\n\nif __name__ == "__main__":\n    main()', description: 'main() guard' },
  { prefix: 'ifmain', body: 'if __name__ == "__main__":\n    ${1:main()}', description: '__main__ guard' },
  { prefix: 'print', body: 'print(${1})', description: 'print()' },
  { prefix: 'lambda', body: 'lambda ${1:x}: ${2:x}', description: 'lambda' },
];

const JS: Snippet[] = [
  { prefix: 'fn', body: 'function ${1:name}(${2:args}) {\n  ${3}\n}', description: 'Function' },
  { prefix: 'afn', body: 'const ${1:name} = (${2:args}) => {\n  ${3}\n};', description: 'Arrow function' },
  { prefix: 'for', body: 'for (let ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n  ${3}\n}', description: 'for loop' },
  { prefix: 'forof', body: 'for (const ${1:item} of ${2:items}) {\n  ${3}\n}', description: 'for…of' },
  { prefix: 'map', body: '${1:items}.map((${2:item}) => ${3:item});', description: 'Array.map' },
  { prefix: 'cl', body: 'class ${1:Name} {\n  constructor(${2:args}) {\n    ${3}\n  }\n}', description: 'Class' },
  { prefix: 'imp', body: "import ${1:name} from '${2:module}';", description: 'import' },
  { prefix: 'log', body: 'console.log(${1});', description: 'console.log' },
  { prefix: 'try', body: 'try {\n  ${1}\n} catch (${2:err}) {\n  ${3}\n}', description: 'try / catch' },
  { prefix: 'timeout', body: 'setTimeout(() => {\n  ${1}\n}, ${2:1000});', description: 'setTimeout' },
  { prefix: 'promise', body: 'new Promise((resolve, reject) => {\n  ${1}\n});', description: 'Promise' },
];

const BASH: Snippet[] = [
  { prefix: 'shebang', body: '#!/usr/bin/env bash\nset -euo pipefail\n\n${1}', description: 'Shebang + strict mode' },
  { prefix: 'for', body: 'for ${1:item} in ${2:list}; do\n  ${3}\ndone', description: 'for loop' },
  { prefix: 'if', body: 'if [[ ${1:condition} ]]; then\n  ${2}\nfi', description: 'if statement' },
  { prefix: 'func', body: '${1:name}() {\n  ${2}\n}', description: 'Function' },
];

const SQL: Snippet[] = [
  { prefix: 'select', body: 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition};', description: 'SELECT' },
  { prefix: 'insert', body: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});', description: 'INSERT' },
  { prefix: 'create', body: 'CREATE TABLE ${1:name} (\n  ${2:id} INTEGER PRIMARY KEY,\n  ${3}\n);', description: 'CREATE TABLE' },
];

const BY_LANGUAGE: Record<string, Snippet[]> = {
  python: PY,
  javascript: JS,
  typescript: JS,
  shell: BASH,
  sql: SQL,
};

let registered = false;

/** Register snippet completions for every supported language (once). Built-in + the user's own snippets. */
export function registerSnippets(monaco: typeof Monaco) {
  if (registered) return;
  registered = true;
  for (const language of SNIPPET_LANGUAGES) {
    monaco.languages.registerCompletionItemProvider(language, {
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        const snippets = [...(BY_LANGUAGE[language] || []), ...(custom[language] || [])];
        return {
          suggestions: snippets.map((s) => ({
            label: s.prefix,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: s.body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: { value: '```' + language + '\n' + s.body.replace(/\$\{\d+:?([^}]*)\}/g, '$1') + '\n```' },
            detail: `${s.description} (snippet)`,
            range,
          })),
        };
      },
    });
  }
}
