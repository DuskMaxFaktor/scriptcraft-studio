import JSZip from 'jszip';
import { FileItem, FileLanguage } from '../types.ts';
import { detectLanguageFromName } from './presets.ts';

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  fileCount: number;
}

export interface ProjectFilePayload {
  name: string;
  language: FileLanguage;
  content: string;
  isEntry?: boolean;
}

/** A file in a save request: without content when it is unchanged since the last save. */
export type SavePayload = Omit<ProjectFilePayload, 'content'> & { content?: string };

/**
 * Only edited files carry their content (a big project would otherwise send megabytes on every pause
 * in typing, and a save on window close is limited to 64 KB). `saved`: name -> content the server has.
 */
export function changedPayload(files: FileItem[], saved: Map<string, string>): SavePayload[] {
  return files.map((f) =>
    saved.get(f.name) === f.content
      ? { name: f.name, language: f.language, isEntry: f.isEntry }
      : { name: f.name, language: f.language, content: f.content, isEntry: f.isEntry }
  );
}

export interface ProjectData {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  files: ProjectFilePayload[];
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data as T;
}

export const projectsApi = {
  list: () => request<{ projects: ProjectSummary[] }>('/api/projects').then((d) => d.projects),
  get: (id: string, rescan = false) => request<ProjectData>(`/api/projects/${encodeURIComponent(id)}${rescan ? '?rescan=1' : ''}`),
  create: (name: string, files: ProjectFilePayload[]) =>
    request<ProjectData>('/api/projects', { method: 'POST', body: JSON.stringify({ name, files }) }),
  save: (id: string, body: { name?: string; files?: SavePayload[]; snapshot?: boolean }) =>
    request<{ ok: boolean; updatedAt: number; name: string }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  remove: (id: string) => request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  openFolder: (id: string) =>
    request<{ ok: boolean; path: string }>(`/api/projects/${encodeURIComponent(id)}/open-folder`, { method: 'POST' }),
  // Trash: deleted projects stay restorable for a while
  trash: () => request<{ projects: TrashedProject[]; days: number }>('/api/trash'),
  restore: (trashId: string) => request<{ id: string; name: string }>(`/api/trash/${encodeURIComponent(trashId)}/restore`, { method: 'POST' }),
  deleteForever: (trashId: string) => request<{ ok: boolean }>(`/api/trash/${encodeURIComponent(trashId)}`, { method: 'DELETE' }),
  emptyTrash: () => request<{ ok: boolean }>('/api/trash', { method: 'DELETE' }),
};

export interface TrashedProject {
  trashId: string;
  id: string;
  name: string;
  deletedAt: number;
  fileCount: number;
}

export function filesToPayload(files: FileItem[]): ProjectFilePayload[] {
  return files.map((f) => ({ name: f.name, language: f.language, content: f.content, isEntry: f.isEntry }));
}

export function payloadToFiles(files: ProjectFilePayload[]): FileItem[] {
  const now = Date.now();
  return files.map((f, i) => ({
    id: `file-${now}-${i}`,
    name: f.name,
    // Always from the extension (older projects stored e.g. README.md as "javascript")
    language: detectLanguageFromName(f.name),
    content: f.content,
    isEntry: f.isEntry,
    updatedAt: now,
  }));
}

const RUN_BAT = `@echo off
setlocal
cd /d "%~dp0"
title Script Runner

set TARGET=
if exist "analytics.py" set TARGET=analytics.py
if exist "script.py" set TARGET=script.py
if exist "main.py" set TARGET=main.py

if "%TARGET%"=="" (
    for %%F in (*.py) do (
        set TARGET=%%F
        goto :found_py
    )
)

:found_py
if not "%TARGET%"=="" (
    echo [INFO] Running Python script: %TARGET%
    python "%TARGET%"
    if errorlevel 1 py -3 "%TARGET%"
    echo.
    pause
    exit /b 0
)

for %%F in (*.js) do (
    echo [INFO] Running JavaScript: %%F
    node "%%F"
    echo.
    pause
    exit /b 0
)

for %%F in (*.html) do (
    start "" "%%F"
    exit /b 0
)

echo [ERROR] No .py, .js or .html file found in this folder.
pause
`;

/** Make a safe file name for the downloaded archive. */
function archiveName(projectName: string): string {
  return (projectName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'project').slice(0, 80);
}

/** Pack project files (plus a Windows run_script.bat) into a ZIP and download it to the PC. */
export async function downloadProjectZip(projectName: string, files: { name: string; content: string }[]) {
  const zip = new JSZip();
  const folder = zip.folder(archiveName(projectName))!;
  files.forEach((f) => folder.file(f.name, f.content));
  if (!files.some((f) => f.name.toLowerCase() === 'run_script.bat')) {
    folder.file('run_script.bat', RUN_BAT.replace(/\n/g, '\r\n'));
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${archiveName(projectName)}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_FILES = 2000;

/** Folders that are never worth importing (dependencies, caches, VCS data). */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', 'env', '.idea', '.vscode',
  'dist', 'build', '.next', '.cache', '.pytest_cache', '.mypy_cache', '__MACOSX',
]);

/** A picked file together with its path relative to the chosen folder (or just its name). */
export interface PickedFile {
  file: File;
  path: string;
}

function isIgnoredPath(p: string): boolean {
  const parts = p.split('/');
  const fileName = parts[parts.length - 1];
  return parts.slice(0, -1).some((d) => IGNORED_DIRS.has(d)) || fileName === '.DS_Store' || fileName === 'Thumbs.db';
}

/** Files from an <input type="file"> (with or without webkitdirectory). */
export function pickedFromFileList(list: FileList | File[]): PickedFile[] {
  return Array.from(list).map((file) => ({ file, path: (file as any).webkitRelativePath || file.name }));
}

/** Files (and whole folders, recursively) dropped onto the page via drag & drop. */
export async function pickedFromDataTransfer(dt: DataTransfer): Promise<PickedFile[]> {
  const entries = Array.from(dt.items)
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => !!e);

  if (entries.length === 0) return pickedFromFileList(dt.files);

  const result: PickedFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      result.push({ file, path: rel });
    } else if (entry.isDirectory) {
      if (IGNORED_DIRS.has(entry.name)) return;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns results in batches until an empty batch
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, rel);
      }
    }
  };
  for (const entry of entries) await walk(entry, '');
  return result;
}

/** If every path starts with the same top folder, return its name (used to name a new project). */
export function commonRootFolder(paths: string[]): string | null {
  if (paths.length === 0 || paths.some((p) => !p.includes('/'))) return null;
  const root = paths[0].split('/')[0];
  return paths.every((p) => p.split('/')[0] === root) ? root : null;
}

function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes('\u0000');
}

function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    const slash = name.lastIndexOf('/');
    const dot = name.lastIndexOf('.');
    candidate = dot > slash + 1 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    n++;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Read files picked on the PC, keeping their folder structure ("src/app.py").
 * ZIP archives are unpacked; binary/very large files and junk folders (node_modules, .git...) are skipped.
 * `existingNames` avoids clashes with files already in the project.
 * `stripRoot` removes a shared top folder (used when the folder itself becomes a new project).
 */
export async function readImportedFiles(
  input: FileList | File[] | PickedFile[],
  existingNames: string[] = [],
  stripRoot = false
): Promise<{ files: ProjectFilePayload[]; skipped: string[] }> {
  const picked: PickedFile[] =
    Array.isArray(input) && input.length > 0 && 'path' in (input[0] as any)
      ? (input as PickedFile[])
      : pickedFromFileList(input as FileList | File[]);
  const taken = new Set(existingNames.map((n) => n.toLowerCase()));
  const files: ProjectFilePayload[] = [];
  const skipped: string[] = [];

  // Collect (path, loader) pairs first so a shared root folder can be stripped
  const items: { path: string; size: number; load: () => Promise<string> }[] = [];
  for (const { file, path: rawPath } of picked) {
    const p = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (isIgnoredPath(p)) continue;
    if (file.name.toLowerCase().endsWith('.zip')) {
      const zip = await JSZip.loadAsync(file);
      const zipDir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || isIgnoredPath(entry.name)) continue;
        items.push({ path: zipDir + entry.name, size: 0, load: () => entry.async('string') });
      }
    } else {
      items.push({ path: p, size: file.size, load: () => file.text() });
    }
  }

  const root = stripRoot ? commonRootFolder(items.map((i) => i.path)) : null;
  for (const item of items) {
    const rel = root ? item.path.slice(root.length + 1) : item.path;
    if (files.length >= MAX_IMPORT_FILES || item.size > MAX_IMPORT_BYTES) {
      skipped.push(rel);
      continue;
    }
    const content = await item.load();
    if (content.length > MAX_IMPORT_BYTES || looksBinary(content)) {
      skipped.push(rel);
      continue;
    }
    const name = uniqueName(rel, taken);
    files.push({ name, language: detectLanguageFromName(name), content });
  }
  return { files, skipped };
}
