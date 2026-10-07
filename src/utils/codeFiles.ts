// File names for the code blocks of an AI answer, so "New file" / "Create all files" use the names the AI meant.
// A block's name comes from (in this order):
//   ```python app.py   or   ```python title="app.py"
//   a first-line comment:  # app.py  |  // file: src/app.js  |  <!-- index.html -->  |  -- schema.sql
//   the line just above the block:  **app.py**  |  `app.py`  |  ### app.py  |  Файл app.py:

export interface CodeFileBlock {
  /** Offset of the opening fence in the markdown (matches react-markdown's node position) */
  offset: number;
  language: string;
  code: string;
  filename: string | null;
}

const EXT = 'py|pyw|js|mjs|cjs|jsx|ts|tsx|mts|html|htm|css|scss|json|md|sql|sh|bash|txt|yml|yaml|toml|ini|cfg|csv|xml|svg|bat|ps1|go|rs|java|c|cpp|h|hpp|cs|php|rb|kt|lua|dart';
const NAME = new RegExp(`(?:[\\w.-]+/)*[\\w-][\\w.-]*\\.(?:${EXT})(?![\\w])`, 'gi');
const COMMENT_NAME = new RegExp(
  `^\\s*(?:#|//|--|;|<!--|/\\*)\\s*(?:(?:file(?:name)?|файл)\\s*:?\\s*)?((?:[\\w.-]+/)*[\\w-][\\w.-]*\\.(?:${EXT}))\\s*(?:-->|\\*/)?\\s*$`,
  'i'
);

const safe = (name: string | undefined | null) => {
  if (!name) return null;
  const n = name.replace(/\\/g, '/').replace(/^\.\//, '');
  if (n.startsWith('/') || /^[a-z]:/i.test(n) || n.split('/').some((p) => p === '..' || p === '')) return null;
  return n.length <= 200 ? n : null;
};

function lastName(text: string): string | null {
  const all = [...text.matchAll(NAME)].map((m) => m[0]);
  // "e.g." or version numbers are not file names; a real name has a letter before the extension dot
  return safe(all.filter((n) => /[a-z0-9_-]\.[a-z]+$/i.test(n)).pop());
}

export function extractCodeFiles(markdown: string): CodeFileBlock[] {
  const blocks: CodeFileBlock[] = [];
  const re = /^([ \t]*)(`{3,}|~{3,})([^\n`]*)\n([\s\S]*?)\n?^\1\2[ \t]*$/gm;
  for (const m of markdown.matchAll(re)) {
    const offset = m.index! + m[1].length;
    const info = m[3].trim();
    const language = info.split(/\s+/)[0] || 'text';
    const code = m[4];
    let filename: string | null = null;

    const titled = /(?:title|file|filename|name)\s*=\s*["']?([^"'\s]+)/i.exec(info);
    if (titled) filename = safe(titled[1]);
    if (!filename) {
      const rest = info.split(/\s+/).slice(1).join(' ');
      if (rest) filename = lastName(rest);
    }
    if (!filename) {
      const first = code.split('\n', 1)[0] || '';
      filename = safe(COMMENT_NAME.exec(first)?.[1]);
    }
    if (!filename) {
      // The nearest non-empty line above the block, if it is short (a caption, not a paragraph)
      const before = markdown.slice(0, m.index).split('\n');
      while (before.length && !before[before.length - 1].trim()) before.pop();
      const caption = before.pop() || '';
      if (caption.length <= 160) filename = lastName(caption);
    }
    blocks.push({ offset, language, code, filename });
  }
  return blocks;
}

/** One entry per file name (a later block with the same name wins: usually the corrected version). */
export function namedFiles(blocks: CodeFileBlock[]): { name: string; content: string }[] {
  const map = new Map<string, string>();
  for (const b of blocks) if (b.filename) map.set(b.filename, b.code.endsWith('\n') ? b.code : b.code + '\n');
  return [...map].map(([name, content]) => ({ name, content }));
}
