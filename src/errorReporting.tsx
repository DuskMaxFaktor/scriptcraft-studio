import React from 'react';

// Interface errors go to the studio's error journal (logs/errors.log), so "Report a problem" can include them.
// A crash of the whole interface shows a recovery screen instead of a blank window.

const recent = new Map<string, number>();

export function reportClientError(message: string, stack = '', kind = 'error') {
  const key = message.slice(0, 200);
  const now = Date.now();
  // The same error in a loop: once per 10 s
  if (now - (recent.get(key) || 0) < 10_000) return;
  recent.set(key, now);
  fetch('/api/logs/client', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, stack, kind, url: location.hash || location.pathname }),
  }).catch(() => {});
}

export function installClientErrorLog() {
  window.addEventListener('error', (e) => {
    // Failed <img>/<script> loads have no message; Monaco's harmless "ResizeObserver loop" is not an error
    if (!e.message || /ResizeObserver loop/.test(e.message)) return;
    reportClientError(e.message, e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    // Cancelled requests and Monaco's own cancellations are normal
    if (r?.name === 'AbortError' || r?.name === 'Canceled' || r?.message === 'Canceled') return;
    reportClientError(r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : '', 'promise');
  });
}

const ru = () => {
  try {
    return localStorage.getItem('scriptcraft-lang') !== 'en';
  } catch {
    return true;
  }
};

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null; copied: boolean }> {
  state = { error: null as Error | null, copied: false };

  static getDerivedStateFromError(error: Error) {
    return { error, copied: false };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportClientError(error.message, `${error.stack || ''}\n${info.componentStack || ''}`, 'crash');
  }

  copyReport = async () => {
    try {
      const res = await fetch('/api/logs/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: `Interface crash: ${this.state.error?.message}`, ui: { userAgent: navigator.userAgent } }),
      });
      await navigator.clipboard.writeText((await res.json()).report);
      this.setState({ copied: true });
    } catch {
      /* the server is down too: the error is in the console */
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    const r = ru();
    return (
      <div className="h-screen flex items-center justify-center bg-canvas text-fg p-6" data-crash-screen>
        <div className="max-w-lg w-full p-6 rounded-xl border border-slate-700 bg-raised space-y-4 text-sm">
          <div className="text-lg font-semibold">{r ? 'Что-то сломалось' : 'Something broke'}</div>
          <p className="text-slate-400">
            {r
              ? 'Интерфейс студии упал. Ваши файлы сохраняются автоматически — перезагрузка вернёт всё как было.'
              : 'The studio interface crashed. Your files are saved automatically — reloading brings everything back.'}
          </p>
          <pre className="p-2 rounded bg-panel border border-slate-800 text-rose-300 text-xs whitespace-pre-wrap max-h-40 overflow-auto">{this.state.error.message}</pre>
          <div className="flex gap-2">
            <button onClick={() => location.reload()} className="px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-semibold" data-crash-reload>
              {r ? 'Перезагрузить' : 'Reload'}
            </button>
            <button onClick={this.copyReport} className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-white">
              {this.state.copied ? (r ? 'Скопировано' : 'Copied') : r ? 'Скопировать отчёт' : 'Copy report'}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
