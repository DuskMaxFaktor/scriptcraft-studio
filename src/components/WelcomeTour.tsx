import React, { useEffect, useLayoutEffect, useState } from 'react';
import { Sparkles, ShieldAlert, X } from 'lucide-react';
import { useI18n } from '../i18n.ts';

// A short tour on the very first start: what is where, plus two things worth knowing up front
// (programs run with the user's rights; what goes to the AI). Shown once; "Help" in the header repeats the details.

interface Step {
  /** data-tour="..." of the highlighted area; none = a card in the middle */
  target?: string;
  title: string;
  text: string;
}

export const WELCOME_DONE_KEY = 'scriptcraft-welcome-done';

export const WelcomeTour: React.FC<{ onClose: () => void; onOpenHelp: () => void }> = ({ onClose, onOpenHelp }) => {
  const { t } = useI18n();
  const steps: Step[] = [
    { title: t('tour.welcomeTitle'), text: t('tour.welcomeText') },
    { target: 'explorer', title: t('tour.explorerTitle'), text: t('tour.explorerText') },
    { target: 'run', title: t('tour.runTitle'), text: t('tour.runText') },
    { target: 'panel', title: t('tour.panelTitle'), text: t('tour.panelText') },
    { target: 'chat', title: t('tour.chatTitle'), text: t('tour.chatText') },
    { title: t('tour.doneTitle'), text: t('tour.doneText') },
  ];
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = steps[i];

  useLayoutEffect(() => {
    const measure = () => {
      const el = step.target ? document.querySelector(`[data-tour="${step.target}"]`) : null;
      const r = el?.getBoundingClientRect();
      setRect(r && r.width > 0 && r.height > 0 ? r : null);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [i]);

  const finish = () => {
    try {
      localStorage.setItem(WELCOME_DONE_KEY, '1');
    } catch {
      /* private window: shown again next time */
    }
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') (i < steps.length - 1 ? setI(i + 1) : finish());
      else if (e.key === 'ArrowLeft' && i > 0) setI(i - 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [i]);

  // The card sits next to the highlighted area, inside the window
  const W = 340;
  let pos: React.CSSProperties = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };
  if (rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const right = rect.right + 16 + W < vw;
    const left = rect.left - 16 - W > 0;
    if (right || left) {
      pos = { left: right ? rect.right + 16 : rect.left - 16 - W, top: Math.min(Math.max(16, rect.top), vh - 260) };
    } else {
      pos = { left: Math.min(Math.max(16, rect.left), vw - W - 16), top: rect.bottom + 16 < vh - 220 ? rect.bottom + 16 : Math.max(16, rect.top - 236) };
    }
  }

  return (
    <div className="fixed inset-0 z-[60]" data-tour-overlay>
      {rect ? (
        // A hole over the area: a huge shadow around a transparent box
        <div
          className="absolute rounded-lg ring-2 ring-indigo-400 transition-all duration-200 pointer-events-none"
          style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8, boxShadow: '0 0 0 9999px rgba(0,0,0,0.6)' }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/60" />
      )}
      <div className="absolute bg-raised border border-slate-700 rounded-xl shadow-2xl p-4 text-sm space-y-3" style={{ width: W, ...pos }} data-tour-step={i}>
        <div className="flex items-start gap-2">
          {i === 0 ? <Sparkles className="w-4 h-4 text-indigo-400 mt-0.5 shrink-0" /> : null}
          <div className="font-semibold text-fg flex-1">{step.title}</div>
          <button onClick={finish} className="p-0.5 text-slate-500 hover:text-fg" title={t('tour.skip')} data-tour-skip>
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-slate-300 text-xs leading-relaxed whitespace-pre-line">{step.text}</p>
        {i === 0 && (
          <div className="p-2 rounded border border-amber-500/40 bg-amber-500/10 text-amber-100 text-xs flex gap-2" data-tour-safety>
            <ShieldAlert className="w-4 h-4 shrink-0 text-amber-400" />
            <span>{t('tour.safety')}</span>
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[11px] text-slate-500">
            {i + 1} / {steps.length}
          </span>
          <div className="ml-auto flex gap-2">
            {i === steps.length - 1 ? (
              <>
                <button
                  onClick={() => {
                    finish();
                    onOpenHelp();
                  }}
                  className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-xs"
                >
                  {t('tour.openHelp')}
                </button>
                <button onClick={finish} className="px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold" data-tour-next>
                  {t('tour.start')}
                </button>
              </>
            ) : (
              <>
                {i > 0 && (
                  <button onClick={() => setI(i - 1)} className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-xs">
                    {t('tour.back')}
                  </button>
                )}
                <button onClick={() => setI(i + 1)} className="px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold" data-tour-next>
                  {t('tour.next')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
