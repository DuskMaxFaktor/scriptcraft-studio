import React from 'react';
import { Keyboard, X } from 'lucide-react';
import { useI18n } from '../i18n.ts';

const HOTKEYS: [string, string][] = [
  ['Ctrl + Enter', 'hotkeys.run'],
  ['Ctrl + Shift + Enter', 'hotkeys.runActive'],
  ['Ctrl + P', 'hotkeys.quickOpen'],
  ['Ctrl + Shift + F', 'hotkeys.searchProject'],
  ['Ctrl + Shift + G', 'hotkeys.git'],
  ['Ctrl + \\', 'hotkeys.split'],
  ['Ctrl + `', 'hotkeys.terminal'],
  ['F5', 'hotkeys.debug'],
  ['F10 / F11 / Shift + F11', 'hotkeys.debugStep'],
  ['Shift + F5', 'hotkeys.debugStop'],
  ['Ctrl + F / Ctrl + H', 'hotkeys.find'],
  ['Ctrl + /', 'hotkeys.comment'],
  ['Ctrl + Z / Ctrl + Y', 'hotkeys.undo'],
  ['Shift + Alt + F', 'hotkeys.format'],
  ['F12 / Ctrl + click', 'hotkeys.definition'],
  ['F2', 'hotkeys.rename'],
  ['Ctrl + .', 'hotkeys.quickFix'],
  ['Alt + ↑ / ↓', 'hotkeys.moveLine'],
  ['Shift + Alt + ↓', 'hotkeys.copyLine'],
  ['Ctrl + D', 'hotkeys.nextMatch'],
  ['Alt + click', 'hotkeys.multiCursor'],
  ['F1', 'hotkeys.palette'],
  ['Ctrl + ?', 'hotkeys.help'],
];

export const HotkeysModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const { t } = useI18n();
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onMouseDown={onClose}>
      <div className="bg-raised border border-slate-700 rounded-xl w-full max-w-md shadow-2xl overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between bg-modal">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Keyboard className="w-4 h-4 text-indigo-400" />
            {t('hotkeys.title')}
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-fg rounded-lg hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-1">
          {HOTKEYS.map(([keys, label]) => (
            <div key={keys} className="flex items-center justify-between text-xs py-1">
              <span className="text-slate-300">{t(label)}</span>
              <kbd className="font-mono text-[11px] px-1.5 py-0.5 rounded border border-slate-700 bg-panel text-slate-300">{keys}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
