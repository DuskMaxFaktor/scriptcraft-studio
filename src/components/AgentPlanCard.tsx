import React, { useState } from 'react';
import { ListChecks, Play, PencilLine, X, Loader2, HelpCircle } from 'lucide-react';
import { useI18n } from '../i18n.ts';
import type { AgentPlan } from '../utils/agent.ts';

// The agent's plan, shown before it changes anything: run it, ask for changes, or cancel.

interface Props {
  plan: AgentPlan;
  /** A revised plan is being prepared */
  busy?: boolean;
  onRun: () => void;
  onRevise: (feedback: string) => void;
  onCancel: () => void;
}

export const AgentPlanCard: React.FC<Props> = ({ plan, busy = false, onRun, onRevise, onCancel }) => {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState('');

  const send = () => {
    if (!feedback.trim()) return;
    onRevise(feedback.trim());
    setFeedback('');
    setEditing(false);
  };

  return (
    <div className="rounded-xl border border-indigo-500/50 bg-indigo-950/20 p-3 text-xs space-y-2" data-agent-plan>
      <div className="flex items-center gap-1.5 font-semibold text-indigo-200">
        <ListChecks className="w-4 h-4" /> {t('plan.proposed')}
      </div>
      {plan.summary && <p className="text-slate-300 leading-relaxed">{plan.summary}</p>}
      <ol className="space-y-1.5">
        {plan.steps.map((s, i) => (
          <li key={i} className="flex gap-2" data-plan-step={i + 1}>
            <span className="shrink-0 w-5 h-5 rounded-full bg-indigo-600/40 text-indigo-100 text-[10px] font-bold flex items-center justify-center">{i + 1}</span>
            <div className="min-w-0">
              <div className="text-slate-200">{s.title}</div>
              {s.files.length > 0 && <div className="text-[10px] font-mono text-slate-500 truncate">{s.files.join(', ')}</div>}
            </div>
          </li>
        ))}
      </ol>
      {plan.questions.length > 0 && (
        <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 space-y-1">
          <div className="flex items-center gap-1 text-amber-300 font-semibold">
            <HelpCircle className="w-3.5 h-3.5" /> {t('plan.questions')}
          </div>
          {plan.questions.map((q, i) => (
            <div key={i} className="text-amber-100/90">
              • {q}
            </div>
          ))}
        </div>
      )}

      {editing ? (
        <div className="space-y-1.5">
          <textarea
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                send();
              }
            }}
            rows={2}
            placeholder={plan.questions.length ? t('plan.answerPlaceholder') : t('plan.revisePlaceholder')}
            className="w-full resize-y bg-canvas border border-slate-700 rounded-lg px-2 py-1.5 text-fg focus:outline-none focus:border-indigo-500"
            data-plan-feedback
          />
          <div className="flex gap-1.5">
            <button onClick={send} disabled={!feedback.trim()} className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold">
              {t('plan.sendRevision')}
            </button>
            <button onClick={() => setEditing(false)} className="px-2.5 py-1 rounded-lg bg-panel border border-slate-700 text-slate-300">
              {t('plan.back')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <button onClick={onRun} disabled={busy} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold">
            <Play className="w-3.5 h-3.5" /> {t('plan.run')}
          </button>
          <button onClick={() => setEditing(true)} disabled={busy} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-panel hover:bg-hover border border-slate-700 text-slate-200 disabled:opacity-40">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PencilLine className="w-3.5 h-3.5" />}
            {plan.questions.length ? t('plan.answer') : t('plan.revise')}
          </button>
          <button onClick={onCancel} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-slate-400 hover:text-rose-300">
            <X className="w-3.5 h-3.5" /> {t('plan.cancel')}
          </button>
        </div>
      )}
    </div>
  );
};
