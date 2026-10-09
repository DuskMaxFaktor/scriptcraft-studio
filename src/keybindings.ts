import { useSyncExternalStore } from 'react';
import type * as Monaco from 'monaco-editor';

// Keyboard shortcuts the user can change (the "Keyboard shortcuts" window).
// A combo is a string like "Ctrl+Shift+F", "F5", "Alt+↑"; an empty list means "no key".
// Studio commands are dispatched by App (window keydown, and by the code editor while it has focus);
// editor commands are Monaco's own, re-bound with keybinding rules.

export type CommandId =
  | 'run'
  | 'runActive'
  | 'quickOpen'
  | 'searchProject'
  | 'git'
  | 'split'
  | 'terminal'
  | 'debug'
  | 'debugStop'
  | 'debugNext'
  | 'debugStep'
  | 'debugOut'
  | 'help'
  | 'format'
  | 'comment'
  | 'quickFix'
  | 'rename'
  | 'definition'
  | 'copyLine'
  | 'nextMatch'
  | 'palette';

export interface CommandInfo {
  id: CommandId;
  label: string; // i18n key
  defaults: string[];
  /** Monaco command for editor commands */
  monaco?: string;
}

export const COMMANDS: CommandInfo[] = [
  { id: 'run', label: 'hotkeys.run', defaults: ['Ctrl+Enter'] },
  { id: 'runActive', label: 'hotkeys.runActive', defaults: ['Ctrl+Shift+Enter'] },
  { id: 'quickOpen', label: 'hotkeys.quickOpen', defaults: ['Ctrl+P'] },
  { id: 'searchProject', label: 'hotkeys.searchProject', defaults: ['Ctrl+Shift+F'] },
  { id: 'git', label: 'hotkeys.git', defaults: ['Ctrl+Shift+G'] },
  { id: 'split', label: 'hotkeys.split', defaults: ['Ctrl+\\'] },
  { id: 'terminal', label: 'hotkeys.terminal', defaults: ['Ctrl+`'] },
  { id: 'debug', label: 'hotkeys.debug', defaults: ['F5'] },
  { id: 'debugStop', label: 'hotkeys.debugStop', defaults: ['Shift+F5'] },
  { id: 'debugNext', label: 'hotkeys.debugNext', defaults: ['F10'] },
  { id: 'debugStep', label: 'hotkeys.debugInto', defaults: ['F11'] },
  { id: 'debugOut', label: 'hotkeys.debugOut', defaults: ['Shift+F11'] },
  { id: 'help', label: 'hotkeys.help', defaults: ['Ctrl+Shift+/'] },
  { id: 'format', label: 'hotkeys.format', defaults: ['Shift+Alt+F'], monaco: 'editor.action.formatDocument' },
  { id: 'comment', label: 'hotkeys.comment', defaults: ['Ctrl+/'], monaco: 'editor.action.commentLine' },
  { id: 'quickFix', label: 'hotkeys.quickFix', defaults: ['Ctrl+.'], monaco: 'editor.action.quickFix' },
  { id: 'rename', label: 'hotkeys.rename', defaults: ['F2'], monaco: 'editor.action.rename' },
  { id: 'definition', label: 'hotkeys.definition', defaults: ['F12'], monaco: 'editor.action.revealDefinition' },
  { id: 'copyLine', label: 'hotkeys.copyLine', defaults: ['Shift+Alt+↓'], monaco: 'editor.action.copyLinesDownAction' },
  { id: 'nextMatch', label: 'hotkeys.nextMatch', defaults: ['Ctrl+D'], monaco: 'editor.action.addSelectionToNextFindMatch' },
  { id: 'palette', label: 'hotkeys.palette', defaults: ['F1'], monaco: 'editor.action.quickCommand' },
];

export type Bindings = Record<CommandId, string[]>;

const STORAGE_KEY = 'scriptcraft-keybindings';

function defaults(): Bindings {
  return Object.fromEntries(COMMANDS.map((c) => [c.id, [...c.defaults]])) as Bindings;
}

function load(): Bindings {
  const b = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<Record<string, string[]>>;
    for (const c of COMMANDS) {
      const v = saved[c.id];
      if (Array.isArray(v) && v.every((x) => typeof x === 'string' && parseCombo(x))) b[c.id] = v;
    }
  } catch {
    /* no storage: defaults */
  }
  return b;
}

// Loaded on first use: parseCombo needs the key tables below
let loaded: Bindings | null = null;
const cur = () => (loaded ??= load());
const listeners = new Set<() => void>();

export function getBindings(): Bindings {
  return cur();
}

/** Only the changed commands are stored, so new default keys in later versions still arrive. */
export function setBindings(next: Bindings) {
  loaded = next;
  const changed: Partial<Bindings> = {};
  for (const c of COMMANDS) if (next[c.id].join('|') !== c.defaults.join('|')) changed[c.id] = next[c.id];
  try {
    if (Object.keys(changed).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(changed));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private window: works until reload */
  }
  listeners.forEach((l) => l());
}

export function resetBindings() {
  setBindings(defaults());
}

export function useBindings(): Bindings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    cur
  );
}

export const isDefault = (id: CommandId, b: Bindings = cur()) =>
  b[id].join('|') === COMMANDS.find((c) => c.id === id)!.defaults.join('|');

// ---------- combos ----------
// key name <-> KeyboardEvent.code (layout-independent: Ctrl+P works with the Russian layout too)
const CODE_TO_KEY: Record<string, string> = {
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backquote: '`',
  Backslash: '\\',
  Slash: '/',
  Period: '.',
  Comma: ',',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
};

function keyOfCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9])$/.test(code)) return code;
  return CODE_TO_KEY[code] ?? null;
}

const MODS = ['Ctrl', 'Shift', 'Alt'] as const;
interface Combo {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

export function parseCombo(s: string): Combo | null {
  // "Ctrl++"-style keys are not used; split on "+" but keep a trailing "+" key out of it
  const parts = s.split('+');
  const key = parts.pop();
  if (!key) return null;
  const mods = new Set(parts);
  if ([...mods].some((m) => !(MODS as readonly string[]).includes(m))) return null;
  const valid = /^[A-Z0-9]$/.test(key) || /^F([1-9]|1[0-9])$/.test(key) || Object.values(CODE_TO_KEY).includes(key);
  if (!valid) return null;
  return { ctrl: mods.has('Ctrl'), shift: mods.has('Shift'), alt: mods.has('Alt'), key };
}

function formatCombo(c: Combo): string {
  return [c.ctrl && 'Ctrl', c.shift && 'Shift', c.alt && 'Alt', c.key].filter(Boolean).join('+');
}

/** The combo a key press makes, or null for a lone modifier / an unknown key. */
export function comboFromEvent(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const key = keyOfCode(e.code);
  if (!key) return null;
  return formatCombo({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey, key });
}

/** Studio command for a key press (editor commands are handled by Monaco itself). */
export function studioCommandFor(e: KeyboardEvent): CommandId | null {
  const combo = comboFromEvent(e);
  if (!combo) return null;
  for (const c of COMMANDS) if (!c.monaco && cur()[c.id].includes(combo)) return c.id;
  return null;
}

/** Which other command already uses this combo. */
export function conflictOf(combo: string, except: CommandId, b: Bindings = cur()): CommandId | null {
  for (const c of COMMANDS) if (c.id !== except && b[c.id].includes(combo)) return c.id;
  return null;
}

/** For display: "Ctrl + Shift + F" */
export const prettyCombo = (s: string) => s.replace(/\+(?=.)/g, ' + ');

// ---------- Monaco ----------
const MONACO_KEY: Record<string, string> = {
  Enter: 'Enter',
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  '↑': 'UpArrow',
  '↓': 'DownArrow',
  '←': 'LeftArrow',
  '→': 'RightArrow',
  '`': 'Backquote',
  '\\': 'Backslash',
  '/': 'Slash',
  '.': 'Period',
  ',': 'Comma',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ';': 'Semicolon',
  "'": 'Quote',
};

export function toMonacoKeybinding(m: typeof Monaco, s: string): number | null {
  const c = parseCombo(s);
  if (!c) return null;
  const name = /^[A-Z]$/.test(c.key) ? `Key${c.key}` : /^\d$/.test(c.key) ? `Digit${c.key}` : /^F\d+$/.test(c.key) ? c.key : MONACO_KEY[c.key];
  const code = (m.KeyCode as unknown as Record<string, number>)[name];
  if (code === undefined) return null;
  return (c.ctrl ? m.KeyMod.CtrlCmd : 0) | (c.shift ? m.KeyMod.Shift : 0) | (c.alt ? m.KeyMod.Alt : 0) | code;
}

let editorRules: Monaco.IDisposable | null = null;

/**
 * Re-bind Monaco's own commands that the user changed: the default key is removed ("-command"),
 * the new keys are added. Applies to every editor (the main one, the split one, notebook cells).
 */
export function applyEditorBindings(m: typeof Monaco, b: Bindings = cur()) {
  editorRules?.dispose();
  const rules: Parameters<typeof m.editor.addKeybindingRules>[0] = [];
  for (const c of COMMANDS) {
    if (!c.monaco || isDefault(c.id, b)) continue;
    for (const old of c.defaults) {
      const kb = toMonacoKeybinding(m, old);
      if (kb !== null) rules.push({ keybinding: kb, command: `-${c.monaco}` });
    }
    for (const k of b[c.id]) {
      const kb = toMonacoKeybinding(m, k);
      if (kb !== null) rules.push({ keybinding: kb, command: c.monaco, when: 'editorTextFocus' });
    }
  }
  editorRules = rules.length ? m.editor.addKeybindingRules(rules) : null;
}

// ---------- dispatch ----------
let handler: ((id: CommandId) => void) | null = null;
/** App registers what each studio command does. */
export function setStudioCommandHandler(h: ((id: CommandId) => void) | null) {
  handler = h;
}
export function runStudioCommand(id: CommandId) {
  handler?.(id);
}
