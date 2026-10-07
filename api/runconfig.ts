import fs from 'fs';
import path from 'path';

// Run parameters of a project: environment variables in the project's .env (secrets such as BOT_TOKEN) and
// command-line arguments in the project's settings. Used by runs, the debugger, tests and the terminal.
// .env is a service file: hidden in the explorer, never sent to the AI, not served by the web preview.

export const ENV_FILE = '.env';
const META_FILE = '.scriptcraft.json';
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
/** Characters the Windows shell would interpret even inside an argument */
export const BAD_ARG_CHARS = /["%^!\r\n]/;

function projectDir(projectId: unknown): string | null {
  if (typeof projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(projectId)) return null;
  const dir = path.join(process.cwd(), 'projects', projectId);
  return fs.existsSync(path.join(dir, META_FILE)) ? dir : null;
}

/** KEY=value lines; "quoted" and 'quoted' values, # comments, optional "export ". */
export function parseEnv(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (/^"(.*)"$/.test(value)) value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    else if (/^'(.*)'$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out.push({ key: m[1], value });
  }
  return out;
}

export function formatEnv(vars: { key: string; value: string }[]): string {
  const quote = (v: string) => (/[\s#"'\\=]/.test(v) || v === '' ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` : v);
  return '# Run parameters of this project (ScriptCraft Studio). Keep secrets here, not in the code.\n' + vars.map((v) => `${v.key}=${quote(v.value)}`).join('\n') + '\n';
}

export function readProjectEnv(projectId: unknown): { key: string; value: string }[] {
  const dir = projectDir(projectId);
  if (!dir) return [];
  try {
    return parseEnv(fs.readFileSync(path.join(dir, ENV_FILE), 'utf-8'));
  } catch {
    return [];
  }
}

/** Environment for a program of the project (later lines win for repeated keys). */
export function projectEnv(projectId: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { key, value } of readProjectEnv(projectId)) env[key] = value;
  return env;
}

/** Split an argument line like a shell: spaces separate, "double" or 'single' quotes keep spaces. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

export function readRunArgs(projectId: unknown): string {
  const dir = projectDir(projectId);
  if (!dir) return '';
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf-8'));
    return typeof meta.runArgs === 'string' ? meta.runArgs : '';
  } catch {
    return '';
  }
}

export const projectArgs = (projectId: unknown) => splitArgs(readRunArgs(projectId));
