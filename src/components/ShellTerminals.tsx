import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Plus, X } from 'lucide-react';
import { useI18n } from '../i18n.ts';
import { useTheme } from '../theme.ts';

type Shell = 'powershell' | 'cmd' | 'bash';
const SHELL_LABEL: Record<Shell, string> = { powershell: 'PowerShell', cmd: 'cmd', bash: 'Git Bash' };

interface TabInfo {
  key: string;
  shell: Shell;
  title: string;
}

const DARK = { background: '#0a0e17', foreground: '#e6edf3', cursor: '#e6edf3', selectionBackground: '#6366f155' };
const LIGHT = { background: '#fbfcfd', foreground: '#1e293b', cursor: '#1e293b', selectionBackground: '#6366f133' };

/** One shell session: xterm in the browser <-> pseudo-terminal on the server. */
const ShellView: React.FC<{ shell: Shell; projectId: string | null; visible: boolean; onExit: () => void }> = ({
  shell,
  projectId,
  visible,
  onExit,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<string | null>(null);
  const { theme } = useTheme();
  const { t } = useI18n();

  useEffect(() => {
    const term = new XTerm({
      fontFamily: "'Fira Code', Consolas, monospace",
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      theme: theme === 'light' ? LIGHT : DARK,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      // not laid out yet
    }

    let es: EventSource | null = null;
    let disposed = false;
    // Keystrokes are batched a little so typing fast doesn't send a request per character
    let pending = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (!pending || !idRef.current) return;
      const data = pending;
      pending = '';
      fetch(`/api/terminal/${idRef.current}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      }).catch(() => {});
    };
    const inputSub = term.onData((d) => {
      pending += d;
      if (!flushTimer) flushTimer = setTimeout(flush, 8);
    });

    (async () => {
      try {
        const res = await fetch('/api/terminal/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shell, projectId, cols: term.cols, rows: term.rows }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        if (disposed) {
          fetch(`/api/terminal/${data.id}/kill`, { method: 'POST' }).catch(() => {});
          return;
        }
        idRef.current = data.id;
        es = new EventSource(`/api/terminal/${data.id}/events`);
        es.onmessage = (m) => term.write(JSON.parse(m.data));
        es.addEventListener('exit', () => {
          es?.close();
          term.write(`\r\n\x1b[2m[${t('shell.exited')}]\x1b[0m\r\n`);
          onExit();
        });
      } catch (err: any) {
        term.write(`\x1b[31m${t('shell.startFailed')}: ${err.message || err}\x1b[0m\r\n`);
      }
    })();

    return () => {
      disposed = true;
      inputSub.dispose();
      es?.close();
      if (idRef.current) fetch(`/api/terminal/${idRef.current}/kill`, { method: 'POST' }).catch(() => {});
      term.dispose();
    };
  }, []);

  // Follow the studio theme
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = theme === 'light' ? LIGHT : DARK;
  }, [theme]);

  // Fit to the panel and tell the pseudo-terminal its new size
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let last = '';
    const resize = () => {
      const term = termRef.current;
      if (!term || !visible || host.clientWidth === 0) return;
      try {
        fitRef.current?.fit();
      } catch {
        return;
      }
      const size = `${term.cols}x${term.rows}`;
      if (size !== last && idRef.current) {
        last = size;
        fetch(`/api/terminal/${idRef.current}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols: term.cols, rows: term.rows }),
        }).catch(() => {});
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    if (visible) termRef.current?.focus();
    return () => ro.disconnect();
  }, [visible]);

  return <div ref={hostRef} className={`absolute inset-0 p-1.5 ${visible ? '' : 'invisible'}`} />;
};

export const ShellTerminals: React.FC<{ projectId: string | null; active: boolean }> = ({ projectId, active }) => {
  const { t } = useI18n();
  const [shells, setShells] = useState<Shell[]>(['powershell', 'cmd']);
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const counter = useRef(0);

  useEffect(() => {
    fetch('/api/terminal/shells')
      .then((r) => r.json())
      .then((d) => d.shells && setShells(d.shells))
      .catch(() => {});
  }, []);

  const addTab = (shell: Shell) => {
    counter.current += 1;
    const tab = { key: `t${counter.current}`, shell, title: `${SHELL_LABEL[shell]} ${counter.current}` };
    setTabs((prev) => [...prev, tab]);
    setCurrent(tab.key);
  };

  const closeTab = (key: string) => {
    setTabs((prev) => {
      const next = prev.filter((tb) => tb.key !== key);
      if (current === key) setCurrent(next[next.length - 1]?.key ?? null);
      return next;
    });
  };

  // Open the first terminal when the tab is shown for the first time
  useEffect(() => {
    if (active && tabs.length === 0) addTab(shells[0] || 'powershell');
  }, [active]);

  // Terminals belong to a project folder: start fresh when another project is opened
  useEffect(() => {
    setTabs([]);
    setCurrent(null);
  }, [projectId]);

  return (
    <div className={`w-full h-full flex flex-col ${active ? '' : 'hidden'}`}>
      <div className="flex items-center gap-1 px-2 py-1 border-b border-slate-800 bg-bar text-[11px] shrink-0 overflow-x-auto">
        {tabs.map((tb) => (
          <div
            key={tb.key}
            onClick={() => setCurrent(tb.key)}
            className={`flex items-center gap-1 px-2 py-0.5 rounded cursor-pointer shrink-0 ${
              tb.key === current ? 'bg-active text-fg' : 'text-slate-400 hover:text-fg'
            }`}
          >
            <span className="font-mono">{tb.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tb.key);
              }}
              className="p-0.5 rounded hover:bg-slate-700/50"
              title={t('shell.close')}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-0.5 ml-1 shrink-0">
          {shells.map((s) => (
            <button
              key={s}
              onClick={() => addTab(s)}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-slate-400 hover:text-fg hover:bg-slate-800"
              title={t('shell.new', { shell: SHELL_LABEL[s] })}
            >
              <Plus className="w-3 h-3" />
              {SHELL_LABEL[s]}
            </button>
          ))}
        </div>
        <span className="ml-auto text-slate-500 shrink-0 pl-2">{t('shell.cwdHint')}</span>
      </div>
      <div className="flex-1 relative min-h-0">
        {tabs.map((tb) => (
          <ShellView
            key={`${projectId}-${tb.key}`}
            shell={tb.shell}
            projectId={projectId}
            visible={active && tb.key === current}
            onExit={() => {}}
          />
        ))}
      </div>
    </div>
  );
};
