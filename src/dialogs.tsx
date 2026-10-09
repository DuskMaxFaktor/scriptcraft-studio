import React, { useEffect, useRef, useState } from 'react';
import { TriangleAlert, Info, HelpCircle } from 'lucide-react';
import { useI18n } from './i18n.ts';

// The studio's own dialogs, in the colors of the current theme — instead of the browser's white
// confirm() / alert() / prompt() windows. Call askConfirm / showAlert / askText from anywhere;
// <DialogHost /> (rendered once in App) shows them one at a time.

type Request =
  | { kind: 'confirm'; message: string; okLabel?: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: 'alert'; message: string; resolve: () => void }
  | { kind: 'prompt'; message: string; initial: string; resolve: (v: string | null) => void };

const queue: Request[] = [];
let notify: (() => void) | null = null;

function push(r: Request) {
  queue.push(r);
  notify?.();
}

/** Ask a yes/no question. `danger` paints the OK button red (deleting, overwriting…). */
export function askConfirm(message: string, opts: { okLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => push({ kind: 'confirm', message, ...opts, resolve }));
}

/** Show a message with an OK button. */
export function showAlert(message: string): Promise<void> {
  return new Promise((resolve) => push({ kind: 'alert', message, resolve }));
}

/** Ask for a line of text; null when cancelled. */
export function askText(message: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => push({ kind: 'prompt', message, initial, resolve }));
}

export const DialogHost: React.FC = () => {
  const { t } = useI18n();
  const [, setTick] = useState(0);
  const [value, setValue] = useState('');
  const okRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    notify = () => setTick((n) => n + 1);
    if (queue.length) notify();
    return () => {
      notify = null;
    };
  }, []);

  const current = queue[0];

  useEffect(() => {
    if (!current) return;
    if (current.kind === 'prompt') {
      setValue(current.initial);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    } else setTimeout(() => okRef.current?.focus(), 0);
  }, [current]);

  if (!current) return null;

  const close = (ok: boolean) => {
    queue.shift();
    if (current.kind === 'confirm') current.resolve(ok);
    else if (current.kind === 'alert') current.resolve();
    else current.resolve(ok ? value : null);
    setTick((n) => n + 1);
  };

  const Icon = current.kind === 'alert' ? Info : current.kind === 'confirm' && current.danger ? TriangleAlert : HelpCircle;
  const danger = current.kind === 'confirm' && current.danger;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4"
      onMouseDown={() => close(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close(false);
        } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          close(true);
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-dialog={current.kind}
        className="w-full max-w-md bg-raised border border-slate-700 rounded-xl shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4 pb-3 flex gap-3">
          <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${danger ? 'text-rose-400' : 'text-indigo-400'}`} />
          <div className="min-w-0 flex-1 space-y-3">
            <p className="text-sm text-fg whitespace-pre-wrap break-words leading-relaxed" data-dialog-message>
              {current.message}
            </p>
            {current.kind === 'prompt' && (
              <input
                ref={inputRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                data-dialog-input
                className="w-full bg-deep border border-slate-700 rounded px-2.5 py-1.5 text-sm font-mono text-fg focus:outline-none focus:border-indigo-500"
              />
            )}
          </div>
        </div>
        <div className="px-5 py-3 bg-modal border-t border-slate-800 flex justify-end gap-2">
          {current.kind !== 'alert' && (
            <button
              onClick={() => close(false)}
              data-dialog-cancel
              className="px-3 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:bg-hover text-xs"
            >
              {t('dialog.cancel')}
            </button>
          )}
          <button
            ref={okRef}
            onClick={() => close(true)}
            data-dialog-ok
            className={`px-4 py-1.5 rounded-md text-white text-xs font-semibold ${danger ? 'bg-rose-600 hover:bg-rose-500' : 'bg-indigo-600 hover:bg-indigo-500'}`}
          >
            {current.kind === 'confirm' && current.okLabel ? current.okLabel : t('dialog.ok')}
          </button>
        </div>
      </div>
    </div>
  );
};
