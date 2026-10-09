import { useSyncExternalStore } from 'react';

// Test coverage of the last run with "Coverage" on: the Tests tab sets it, the editor paints the gutter
// (green: a test ran this line, red: no test reached it).

export interface FileCoverage {
  covered: number[];
  missing: number[];
}
export interface CoverageReport {
  files: Record<string, FileCoverage>;
  percent: number;
  notMeasured?: string[];
}

let current: { projectId: string; report: CoverageReport } | null = null;
const listeners = new Set<() => void>();

export function setCoverage(projectId: string | null, report: CoverageReport | null) {
  current = projectId && report ? { projectId, report } : null;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Coverage of one file of the project, or null (not measured / another project / coverage hidden). */
export function useFileCoverage(projectId: string | null | undefined, file: string | undefined): FileCoverage | null {
  const snap = useSyncExternalStore(subscribe, () => current);
  if (!snap || !file || snap.projectId !== projectId) return null;
  return snap.report.files[file] || null;
}

export function useCoverage(): { projectId: string; report: CoverageReport } | null {
  return useSyncExternalStore(subscribe, () => current);
}
