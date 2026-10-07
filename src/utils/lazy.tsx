import React, { lazy, Suspense, useState, type ComponentType } from 'react';

/** React.lazy for a module's named export: loads the component as a separate chunk.
 *  `preload()` fetches the chunk ahead of time (so a dialog opens instantly on the first shortcut). */
export function lazyNamed<M extends Record<string, unknown>, K extends keyof M>(load: () => Promise<M>, name: K) {
  let pending: Promise<M> | null = null;
  const loadOnce = () => (pending ??= load().catch((err) => {
    pending = null; // allow a retry
    throw err;
  }));
  const component = lazy(async () => ({ default: (await loadOnce())[name] as ComponentType<any> }));
  return Object.assign(component, { preload: () => void loadOnce().catch(() => {}) }) as unknown as M[K] & { preload: () => void };
}

/** Renders its (lazy) children only once `when` has been true; afterwards they stay mounted (close animations). */
export const Deferred: React.FC<{ when: boolean; children: React.ReactNode }> = ({ when, children }) => {
  const [seen, setSeen] = useState(when);
  if (when && !seen) setSeen(true);
  return seen ? <Suspense fallback={null}>{children}</Suspense> : null;
};
