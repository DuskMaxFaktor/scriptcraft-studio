import React, { useCallback, useEffect, useState } from 'react';

interface ResizeHandleProps {
  /** 'x' = vertical bar changing a width, 'y' = horizontal bar changing a height */
  axis: 'x' | 'y';
  /** Current size of the panel being resized */
  size: number;
  /** +1 if dragging right/down grows the panel, -1 if it shrinks it */
  direction: 1 | -1;
  min: number;
  max: number;
  onResize: (size: number) => void;
  title?: string;
}

export const ResizeHandle: React.FC<ResizeHandleProps> = ({ axis, size, direction, min, max, onResize, title }) => {
  const [dragging, setDragging] = useState(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const start = axis === 'x' ? e.clientX : e.clientY;
      const startSize = size;
      setDragging(true);
      document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');

      const onMove = (ev: PointerEvent) => {
        const pos = axis === 'x' ? ev.clientX : ev.clientY;
        const next = startSize + (pos - start) * direction;
        onResize(Math.round(Math.min(max, Math.max(min, next))));
      };
      const onUp = () => {
        setDragging(false);
        document.body.classList.remove('resizing-x', 'resizing-y');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [axis, size, direction, min, max, onResize]
  );

  return (
    <div
      onPointerDown={handlePointerDown}
      title={title}
      className={`relative shrink-0 z-20 group ${
        axis === 'x' ? 'w-1 -mx-0.5 cursor-col-resize' : 'h-1 -my-0.5 cursor-row-resize'
      }`}
    >
      <div
        className={`absolute transition-colors ${
          axis === 'x' ? 'inset-y-0 left-1/2 w-px -translate-x-1/2' : 'inset-x-0 top-1/2 h-px -translate-y-1/2'
        } ${dragging ? 'bg-indigo-500' : 'bg-transparent group-hover:bg-indigo-500/70'}`}
      />
    </div>
  );
};

/** useState that persists a number in localStorage (falls back silently when storage is unavailable). */
export function usePersistentSize(key: string, initial: number): [number, (v: number) => void] {
  const [value, setValue] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      if (Number.isFinite(saved) && saved > 0) return saved;
    } catch {
      // storage unavailable
    }
    return initial;
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // storage unavailable
    }
  }, [key, value]);

  return [value, setValue];
}
