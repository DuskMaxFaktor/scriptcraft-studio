// AI "ghost text" suggestions in the editor, accepted with Tab.
// The server answers with an empty string when suggestions are turned off in AI settings.
import { monaco } from './monacoSetup.ts';

const DEBOUNCE_MS = 350;
const MAX_PREFIX = 4000;
const MAX_SUFFIX = 1500;

let registered = false;

function wait(ms: number, token: { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => unknown }) {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(!token.isCancellationRequested), ms);
    token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export function registerInlineCompletions() {
  if (registered) return;
  registered = true;

  monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
    async provideInlineCompletions(model, position, _context, token) {
      // Wait for a pause in typing; every new keystroke cancels this request
      if (!(await wait(DEBOUNCE_MS, token))) return { items: [] };

      const full = model.getValue();
      const offset = model.getOffsetAt(position);
      const prefix = full.slice(Math.max(0, offset - MAX_PREFIX), offset);
      const suffix = full.slice(offset, offset + MAX_SUFFIX);
      // Nothing useful to suggest at the very start of an empty file or in the middle of a word
      if (!prefix.trim()) return { items: [] };
      const nextChar = full.charAt(offset);
      if (nextChar && /\w/.test(nextChar)) return { items: [] };

      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        const res = await fetch('/api/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix, suffix }),
          signal: controller.signal,
        });
        const data = await res.json();
        const text: string = data.completion || '';
        if (!text.trim() || token.isCancellationRequested) return { items: [] };
        return {
          items: [{ insertText: text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }],
        };
      } catch {
        return { items: [] };
      }
    },
    disposeInlineCompletions() {
      // nothing to free
    },
  } as monaco.languages.InlineCompletionsProvider);
}
