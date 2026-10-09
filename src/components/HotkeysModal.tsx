import React, { useEffect, useState } from 'react';
import { Keyboard, X, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n.ts';
import { COMMANDS, comboFromEvent, conflictOf, isDefault, prettyCombo, resetBindings, setBindings, useBindings, type CommandId } from '../keybindings.ts';

// Keys that are part of the editor and stay as they are (shown for reference)
const FIXED: [string, string][] = [
  ['Ctrl + F / Ctrl + H', 'hotkeys.find'],
  ['Ctrl + Z / Ctrl + Y', 'hotkeys.undo'],
  ['Alt + ↑ / ↓', 'hotkeys.moveLine'],
  ['Alt + click', 'hotkeys.multiCursor'],
  ['Ctrl + click', 'hotkeys.definitionClick'],
];

export const HotkeysModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const { t } = useI18n();
  const bindings = useBindings();
  const [recording, setRecording] = useState<CommandId | null>(null);
  const [pending, setPending] = useState<{ id: CommandId; combo: string; owner: CommandId } | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setRecording(null);
      setPending(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;
  const label = (id: CommandId) => t(COMMANDS.find((c) => c.id === id)!.label);

  const assign = (id: CommandId, combo: string, owner: CommandId | null) => {
    const next = { ...bindings, [id]: [combo] };
    if (owner) next[owner] = bindings[owner].filter((k) => k !== combo);
    setBindings(next);
    setRecording(null);
    setPending(null);
  };

  const onRecordKey = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecording(null);
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return; // a lone Ctrl / Shift / Alt: wait for the key
    // Letters and digits without Ctrl/Alt would type into the editor instead
    if (/^(Shift\+)?[A-Z0-9]$/.test(combo) || /^(Shift\+)?(Space|Enter|Tab|Backspace|[`\\/.,\-=[\];'])$/.test(combo)) return;
    const owner = conflictOf(combo, recording, bindings);
    if (owner) setPending({ id: recording, combo, owner });
    else assign(recording, combo, null);
  };

  const changed = COMMANDS.some((c) => !isDefault(c.id, bindings));

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="bg-raised border border-slate-700 rounded-xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onMouseDown={(e) => e.stopPropagation()}
        data-hotkeys
      >
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between bg-modal">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Keyboard className="w-4 h-4 text-indigo-400" />
            {t('hotkeys.title')}
          </div>
          <div className="flex items-center gap-1">
            {changed && (
              <button onClick={resetBindings} className="px-2 py-1 text-xs text-slate-400 hover:text-fg rounded hover:bg-slate-800 flex items-center gap-1" data-hotkeys-reset-all>
                <RotateCcw className="w-3.5 h-3.5" /> {t('hotkeys.resetAll')}
              </button>
            )}
            <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-fg rounded-lg hover:bg-slate-800">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="px-4 pt-3 text-[11px] text-slate-500">{t('hotkeys.editHint')}</div>
        <div className="p-4 pt-2 space-y-0.5 overflow-auto">
          {COMMANDS.map((c) => {
            const keys = bindings[c.id];
            const isRec = recording === c.id;
            return (
              <div key={c.id} className="group flex items-center gap-2 text-xs py-1" data-hotkey={c.id}>
                <span className="text-slate-300 flex-1">{t(c.label)}</span>
                {isRec ? (
                  <button
                    autoFocus
                    onKeyDown={onRecordKey}
                    onBlur={() => !pending && setRecording(null)}
                    className="font-mono text-[11px] px-2 py-0.5 rounded border border-indigo-500 bg-indigo-500/10 text-indigo-200 outline-none"
                    data-keybinding-recorder
                  >
                    {t('hotkeys.pressKeys')}
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setPending(null);
                      setRecording(c.id);
                    }}
                    className="flex items-center gap-1"
                    title={t('hotkeys.change')}
                    data-hotkey-edit
                  >
                    {keys.length ? (
                      keys.map((k) => (
                        <kbd
                          key={k}
                          className={`font-mono text-[11px] px-1.5 py-0.5 rounded border bg-panel ${isDefault(c.id, bindings) ? 'border-slate-700 text-slate-300' : 'border-indigo-500/60 text-indigo-200'}`}
                        >
                          {prettyCombo(k)}
                        </kbd>
                      ))
                    ) : (
                      <span className="text-slate-600 italic">{t('hotkeys.none')}</span>
                    )}
                    <Pencil className="w-3 h-3 text-slate-500 opacity-0 group-hover:opacity-100" />
                  </button>
                )}
                <span className="w-10 flex justify-end gap-0.5">
                  {keys.length > 0 && !isRec && (
                    <button onClick={() => setBindings({ ...bindings, [c.id]: [] })} title={t('hotkeys.remove')} className="p-0.5 text-slate-500 hover:text-rose-400 opacity-0 group-hover:opacity-100" data-hotkey-remove>
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                  {!isDefault(c.id, bindings) && (
                    <button onClick={() => setBindings({ ...bindings, [c.id]: [...c.defaults] })} title={t('hotkeys.reset')} className="p-0.5 text-slate-500 hover:text-fg" data-hotkey-reset>
                      <RotateCcw className="w-3 h-3" />
                    </button>
                  )}
                </span>
              </div>
            );
          })}
          {pending && (
            <div className="my-2 p-2 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs" data-hotkey-conflict>
              {t('hotkeys.conflict', { keys: prettyCombo(pending.combo), command: label(pending.owner) })}
              <div className="mt-2 flex gap-2">
                <button onClick={() => assign(pending.id, pending.combo, pending.owner)} className="px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold" data-hotkey-reassign>
                  {t('hotkeys.reassign')}
                </button>
                <button
                  onClick={() => {
                    setPending(null);
                    setRecording(null);
                  }}
                  className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white"
                >
                  {t('dialog.cancel')}
                </button>
              </div>
            </div>
          )}
          <div className="pt-2 mt-2 border-t border-slate-800 space-y-0.5">
            {FIXED.map(([keys, l]) => (
              <div key={keys} className="flex items-center justify-between text-xs py-1">
                <span className="text-slate-400">{t(l)}</span>
                <kbd className="font-mono text-[11px] px-1.5 py-0.5 rounded border border-slate-800 bg-panel text-slate-500 mr-12">{keys}</kbd>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
