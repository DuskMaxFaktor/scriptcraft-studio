// Project-wide search & replace over the files open in the studio.

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Comma-separated file filters: "*.py, src/" (empty = all files); a leading "!" excludes */
  include: string;
}

export interface SearchMatch {
  line: number; // 1-based
  column: number; // 1-based
  length: number;
  preview: string; // the line text
}

export interface FileMatches {
  fileId: string;
  name: string;
  matches: SearchMatch[];
}

export const MAX_MATCHES = 2000;

/** Build the search RegExp; throws a readable error for an invalid regular expression. */
export function buildRegex(o: SearchOptions): RegExp | null {
  if (!o.query) return null;
  let source = o.regex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.wholeWord) source = `\\b(?:${source})\\b`;
  return new RegExp(source, o.caseSensitive ? 'g' : 'gi');
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`(^|/)${escaped}$`, 'i');
}

/** "*.py, src/, !tests/" -> does the file path pass the filter? */
export function matchesFilter(name: string, include: string): boolean {
  const parts = include
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return true;
  const test = (p: string) =>
    p.endsWith('/') ? `/${name}`.toLowerCase().includes(`/${p.toLowerCase()}`) : p.includes('*') || p.includes('?') ? globToRegex(p).test(name) : name.toLowerCase().includes(p.toLowerCase());
  const excludes = parts.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  const includes = parts.filter((p) => !p.startsWith('!'));
  if (excludes.some(test)) return false;
  return includes.length === 0 || includes.some(test);
}

export function searchFiles(
  files: { id: string; name: string; content: string }[],
  o: SearchOptions
): { results: FileMatches[]; total: number; truncated: boolean } {
  const re = buildRegex(o);
  const results: FileMatches[] = [];
  let total = 0;
  if (!re) return { results, total, truncated: false };
  for (const f of files) {
    if (!matchesFilter(f.name, o.include)) continue;
    const matches: SearchMatch[] = [];
    const lines = f.content.split('\n');
    for (let i = 0; i < lines.length && total < MAX_MATCHES; i++) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lines[i])) && total < MAX_MATCHES) {
        if (m[0].length === 0) {
          re.lastIndex++; // empty match (e.g. "^"): avoid an endless loop
          continue;
        }
        matches.push({ line: i + 1, column: m.index + 1, length: m[0].length, preview: lines[i] });
        total++;
      }
    }
    if (matches.length) results.push({ fileId: f.id, name: f.name, matches });
    if (total >= MAX_MATCHES) return { results, total, truncated: true };
  }
  return { results, total, truncated: false };
}

/** Replace every match in one text (regex mode supports $1, $2... groups). */
export function replaceInText(text: string, o: SearchOptions, replacement: string): { text: string; count: number } {
  const re = buildRegex(o);
  if (!re) return { text, count: 0 };
  let count = 0;
  // Search line by line, like searchFiles, so "^"/"$" and counts behave the same in both
  const out = text
    .split('\n')
    .map((line) => {
      const found = (line.match(re) || []).filter((m) => m.length > 0).length;
      if (found === 0) return line;
      count += found;
      // Regex mode: "$1" etc. refer to groups; plain mode: the replacement is inserted literally (a "$" stays "$")
      return o.regex ? line.replace(re, replacement) : line.replace(re, () => replacement);
    })
    .join('\n');
  return { text: out, count };
}

/** Replace only the match at (line, column) — "replace this one" in the results list. */
export function replaceOneInText(text: string, o: SearchOptions, replacement: string, line: number, column: number): { text: string; count: number } {
  const re = buildRegex(o);
  if (!re) return { text, count: 0 };
  const lines = text.split('\n');
  const src = lines[line - 1];
  if (src === undefined) return { text, count: 0 };
  re.lastIndex = column - 1;
  const m = re.exec(src);
  // The match must still be exactly where the results list saw it (the file may have changed)
  if (!m || m.index !== column - 1 || m[0].length === 0) return { text, count: 0 };
  const one = new RegExp(re.source, re.flags.replace('g', ''));
  const replaced = o.regex ? m[0].replace(one, replacement) : replacement;
  lines[line - 1] = src.slice(0, m.index) + replaced + src.slice(m.index + m[0].length);
  return { text: lines.join('\n'), count: 1 };
}
