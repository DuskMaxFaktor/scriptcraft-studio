import { useSyncExternalStore } from 'react';
import { t } from './i18n.ts';

// Update check result shared by the header badge and the "About" window.
// On start the studio checks at most once a day (when a repository is set and auto-check is on).

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  name: string;
  notes: string;
  page: string;
  published: string;
  canInstall: boolean;
  size: number;
}

let info: UpdateInfo | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function useUpdateInfo(): UpdateInfo | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => info
  );
}

/** The server's error as the user should read it: "offline" in the studio's language. */
export function updateError(data: { error?: string; code?: string }, fallback: string): string {
  return data.code === 'offline' ? t('about.offline') : data.error || fallback;
}

/** Ask the server to look at the latest release; throws with the server's message. */
export async function checkForUpdates(): Promise<UpdateInfo> {
  const res = await fetch('/api/update/check', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(updateError(data, 'Update check failed'));
  info = data;
  emit();
  return data;
}

const LAST_CHECK = 'scriptcraft-update-checked';

/** Quiet daily check on start: no errors shown (offline, no repository...). */
export async function autoCheckForUpdates() {
  try {
    const s = await (await fetch('/api/update')).json();
    if (!s.repo || !s.autoCheck) return;
    let last = 0;
    try {
      last = Number(localStorage.getItem(LAST_CHECK) || 0);
    } catch {
      /* no storage */
    }
    if (Date.now() - last < 24 * 60 * 60 * 1000) return;
    await checkForUpdates();
    try {
      localStorage.setItem(LAST_CHECK, String(Date.now()));
    } catch {
      /* no storage */
    }
  } catch {
    /* offline or server restarting: try again next start */
  }
}
