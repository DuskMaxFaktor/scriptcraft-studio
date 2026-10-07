import Prism from 'prismjs';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-markup';

export function highlightCode(code: string, language: string): string {
  const grammarMap: Record<string, any> = {
    python: Prism.languages.python,
    py: Prism.languages.python,
    javascript: Prism.languages.javascript,
    js: Prism.languages.javascript,
    typescript: Prism.languages.typescript,
    ts: Prism.languages.typescript,
    html: Prism.languages.markup,
    css: Prism.languages.css,
    bash: Prism.languages.bash,
    sh: Prism.languages.bash,
    shell: Prism.languages.bash,
    sql: Prism.languages.sql,
    json: Prism.languages.json,
  };

  if (['text', 'txt', 'plaintext', 'plain', 'output', 'console'].includes(language.toLowerCase())) {
    return escapeHtml(code);
  }
  const grammar = grammarMap[language.toLowerCase()] || Prism.languages.javascript;
  try {
    return Prism.highlight(code, grammar, language);
  } catch (e) {
    return escapeHtml(code);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
