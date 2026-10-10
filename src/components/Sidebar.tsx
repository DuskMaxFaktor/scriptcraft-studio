import React, { useMemo, useRef, useState } from 'react';
import {
  FileCode,
  FilePlus,
  Trash2,
  Edit3,
  Check,
  X,
  Layers,
  ChevronRight,
  ChevronDown,
  Terminal,
  Database,
  Globe,
  Upload,
  FolderPlus,
  Folder,
  FolderOpen,
  Package,
  History,
  Star,
  Search,
  GitBranch,
  Image as ImageIcon,
  Music,
  Film,
  Binary,
  File,
} from 'lucide-react';
import { FileItem, FileLanguage } from '../types.ts';
import { detectLanguageFromName } from '../utils/presets.ts';
import { pickedFromDataTransfer, PickedFile } from '../utils/projects.ts';
import { useI18n } from '../i18n.ts';
import type { ProjectAsset } from '../types.ts';
import { askConfirm } from '../dialogs.tsx';

interface SidebarProps {
  files: FileItem[];
  activeFileId: string;
  onSelectFile: (fileId: string) => void;
  onCreateFile: (name: string, language: FileLanguage) => void;
  onRenameFile: (fileId: string, newName: string) => void;
  onDeleteFile: (fileId: string) => void;
  onDeleteFolder: (folderPath: string) => void;
  onImportFiles: (files: FileList | PickedFile[]) => void;
  onOpenPackages: () => void;
  onOpenHistory: (fileName: string | null) => void;
  onToggleEntry: (fileId: string) => void;
  onOpenSearch: () => void;
  onOpenGit: () => void;
  /** Non-text files of the project (images, databases...) and the one shown in the viewer */
  assets?: ProjectAsset[];
  activeAsset?: string | null;
  onOpenAsset?: (asset: ProjectAsset) => void;
}

interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  files: FileItem[];
}

/** Turn flat "a/b/c.py" file names into a folder tree (folders first, then files, alphabetically). */
function buildTree(files: FileItem[]): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: [], files: [] };
  for (const file of files) {
    const parts = file.name.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let child = node.folders.find((f) => f.path === path);
      if (!child) {
        child = { name: parts[i], path, folders: [], files: [] };
        node.folders.push(child);
      }
      node = child;
    }
    node.files.push(file);
  }
  const sortNode = (n: FolderNode) => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => a.name.localeCompare(b.name));
    n.folders.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

const ASSET_ICONS: Record<ProjectAsset['kind'], React.FC<{ className?: string }>> = {
  image: ImageIcon,
  sqlite: Database,
  audio: Music,
  video: Film,
  binary: Binary,
  other: File,
};

// Line counts per file object: a keystroke replaces only the edited file's object, so a big project
// is not split into lines again on every key press
const lineCounts = new WeakMap<FileItem, number>();
const BIG_PROJECT_FILES = 300;
function linesOf(f: FileItem): number {
  let n = lineCounts.get(f);
  if (n === undefined) {
    n = 1;
    for (let i = f.content.indexOf('\n'); i !== -1; i = f.content.indexOf('\n', i + 1)) n++;
    lineCounts.set(f, n);
  }
  return n;
}

export const Sidebar: React.FC<SidebarProps> = ({
  files,
  activeFileId,
  onSelectFile,
  onCreateFile,
  onRenameFile,
  onDeleteFile,
  onDeleteFolder,
  onImportFiles,
  onOpenPackages,
  onOpenHistory,
  onToggleEntry,
  onOpenSearch,
  onOpenGit,
  assets = [],
  activeAsset = null,
  onOpenAsset,
}) => {
  const { t } = useI18n();
  const importRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(true);
  const [newFileName, setNewFileName] = useState('');
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  /** Folders the user toggled: closed ones in a normal project, opened ones in a big one */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [isDragOver, setIsDragOver] = useState(false);

  // Rebuilt when files are added, renamed, deleted or the main file changes — not on every keystroke
  const structureKey = files.map((f) => `${f.id}\u0000${f.name}\u0000${f.language}\u0000${f.isEntry ? 1 : 0}`).join('\n');
  const filesRef = useRef(files);
  filesRef.current = files;
  const tree = useMemo(() => buildTree(filesRef.current), [structureKey]);

  const handleStartCreate = () => {
    setIsCreating(true);
    setNewFileName('');
  };

  const handleConfirmCreate = () => {
    const trimmed = newFileName.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!trimmed) {
      setIsCreating(false);
      return;
    }
    onCreateFile(trimmed, detectLanguageFromName(trimmed));
    setIsCreating(false);
    setNewFileName('');
  };

  const handleStartRename = (file: FileItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingFileId(file.id);
    setEditingName(file.name);
  };

  const handleConfirmRename = () => {
    const trimmed = editingName.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (editingFileId && trimmed) {
      live.current.onRenameFile(editingFileId, trimmed);
    }
    setEditingFileId(null);
  };

  // Rows call the latest handlers through a ref: the drawn tree can then be reused while the user types
  const live = useRef({ onSelectFile, onToggleEntry, onOpenHistory, onDeleteFile, onDeleteFolder, onRenameFile });
  live.current = { onSelectFile, onToggleEntry, onOpenHistory, onDeleteFile, onDeleteFolder, onRenameFile };

  const toggleFolder = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const picked = await pickedFromDataTransfer(e.dataTransfer);
    if (picked.length > 0) onImportFiles(picked);
  };

  const getFileIcon = (lang: FileLanguage) => {
    switch (lang) {
      case 'python':
        return <span className="text-yellow-400 font-mono text-[11px] font-bold">Py</span>;
      case 'javascript':
      case 'typescript':
        return <span className="text-amber-400 font-mono text-[11px] font-bold">JS</span>;
      case 'html':
      case 'css':
        return <Globe className="w-3.5 h-3.5 text-sky-400" />;
      case 'bash':
      case 'powershell':
        return <Terminal className="w-3.5 h-3.5 text-emerald-400" />;
      case 'sql':
        return <Database className="w-3.5 h-3.5 text-indigo-400" />;
      case 'json':
        return <span className="text-orange-400 font-mono text-[11px] font-bold">{'{}'}</span>;
      default:
        return <FileCode className="w-3.5 h-3.5 text-slate-400" />;
    }
  };

  const countFiles = (n: FolderNode): number => n.files.length + n.folders.reduce((acc, f) => acc + countFiles(f), 0);

  const renderFile = (file: FileItem, depth: number) => {
    const isActive = file.id === activeFileId;
    const isEditing = file.id === editingFileId;
    return (
      <div
        key={file.id}
        onClick={() => live.current.onSelectFile(file.id)}
        title={file.name}
        style={{ paddingLeft: 12 + depth * 14 }}
        className={`group flex items-center justify-between pr-3 py-1.5 text-xs cursor-pointer border-l-2 transition-colors ${
          isActive
            ? 'bg-active text-fg border-indigo-500'
            : 'text-slate-400 hover:text-slate-200 hover:bg-panel border-transparent'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-4 flex items-center justify-center shrink-0">{getFileIcon(file.language)}</div>
          {isEditing ? (
            <input
              type="text"
              autoFocus
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmRename();
                if (e.key === 'Escape') setEditingFileId(null);
              }}
              onBlur={handleConfirmRename}
              className="bg-canvas text-fg border border-indigo-500 rounded px-1.5 py-0.5 text-xs w-36 focus:outline-none"
            />
          ) : (
            <span className="truncate font-mono">{baseName(file.name)}</span>
          )}
          {file.isEntry && !isEditing && (
            <Star className="w-3 h-3 text-amber-400 fill-current shrink-0" aria-label={t('sidebar.entry')} />
          )}
        </div>

        {!isEditing && (
          <div className="hidden group-hover:flex items-center gap-1 shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation();
                live.current.onToggleEntry(file.id);
              }}
              className={`p-0.5 ${file.isEntry ? 'text-amber-400' : 'text-slate-400 hover:text-amber-400'}`}
              title={file.isEntry ? t('sidebar.unsetEntry') : t('sidebar.setEntry')}
            >
              <Star className="w-3 h-3" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                live.current.onOpenHistory(file.name);
              }}
              className="p-0.5 text-slate-400 hover:text-slate-200"
              title={t('sidebar.history')}
            >
              <History className="w-3 h-3" />
            </button>
            <button
              onClick={(e) => handleStartRename(file, e)}
              className="p-0.5 text-slate-400 hover:text-slate-200"
              title={t('sidebar.rename')}
            >
              <Edit3 className="w-3 h-3" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                live.current.onDeleteFile(file.id);
              }}
              className="p-0.5 text-slate-400 hover:text-red-400"
              title={t('sidebar.delete')}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderFolder = (folder: FolderNode, depth: number): React.ReactNode => {
    // Big projects start with folders closed (thousands of rows slow every keystroke down);
    // the folders of the open file are always shown
    const isCollapsed = bigProject ? !collapsed.has(folder.path) && !activeFolders.has(folder.path) : collapsed.has(folder.path);
    return (
      <div key={`dir:${folder.path}`}>
        <div
          onClick={() => toggleFolder(folder.path)}
          title={folder.path}
          style={{ paddingLeft: 8 + depth * 14 }}
          className="group flex items-center justify-between pr-3 py-1.5 text-xs cursor-pointer text-slate-300 hover:bg-panel border-l-2 border-transparent"
        >
          <div className="flex items-center gap-1 min-w-0">
            {isCollapsed ? (
              <ChevronRight className="w-3 h-3 text-slate-500 shrink-0" />
            ) : (
              <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" />
            )}
            {isCollapsed ? (
              <Folder className="w-3.5 h-3.5 text-amber-300/80 shrink-0" />
            ) : (
              <FolderOpen className="w-3.5 h-3.5 text-amber-300/80 shrink-0" />
            )}
            <span className="truncate font-mono ml-1">{folder.name}</span>
          </div>
          <div className="hidden group-hover:flex items-center gap-1 shrink-0">
            <span className="text-[10px] text-slate-500">{countFiles(folder)}</span>
            {(
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void askConfirm(t('sidebar.confirmDeleteFolder', { name: folder.path, count: countFiles(folder) }), { danger: true }).then(
                    (ok) => ok && live.current.onDeleteFolder(folder.path)
                  );
                }}
                className="p-0.5 text-slate-400 hover:text-red-400"
                title={t('sidebar.deleteFolder')}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
        {!isCollapsed && (
          <>
            {folder.folders.map((f) => renderFolder(f, depth + 1))}
            {folder.files.map((f) => renderFile(f, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const totalLines = files.reduce((acc, f) => acc + linesOf(f), 0);
  const bigProject = files.length > BIG_PROJECT_FILES;
  const activeName = files.find((f) => f.id === activeFileId)?.name || '';
  const activeFolders = new Set(activeName.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/')));
  // 2000 rows are not drawn again on every keystroke: only when the tree, the selection, a rename or a folder changes
  const treeView = useMemo(
    () => (
      <>
        {tree.folders.map((f) => renderFolder(f, 0))}
        {tree.files.map((f) => renderFile(f, 0))}
      </>
    ),
    [tree, activeFileId, editingFileId, editingName, collapsed, t, bigProject]
  );

  return (
    <aside
      data-tour="explorer"
      className={`w-full h-full border-r bg-side flex flex-col justify-between select-none transition-colors ${
        isDragOver ? 'border-indigo-500 bg-indigo-950/20' : 'border-slate-800'
      }`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setIsDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false);
      }}
      onDrop={handleDrop}
    >
      {/* Top Header */}
      <div className="min-h-0 flex flex-col">
        <div className="px-3 py-2.5 flex items-center justify-between border-b border-slate-800/80">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider min-w-0">
            <Layers className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{t('sidebar.explorer')}</span>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={onOpenSearch}
              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              title={t('search.open')}
            >
              <Search className="w-4 h-4" />
            </button>
            <button
              onClick={onOpenGit}
              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              title={t('git.open')}
            >
              <GitBranch className="w-4 h-4" />
            </button>
            <button
              onClick={onOpenPackages}
              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              title={t('sidebar.packages')}
            >
              <Package className="w-4 h-4" />
            </button>
            <button
              onClick={() => onOpenHistory(null)}
              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              title={t('sidebar.historyAll')}
            >
              <History className="w-4 h-4" />
            </button>
            <button
              onClick={() => importRef.current?.click()}
              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              title={t('sidebar.importFiles')}
            >
              <Upload className="w-4 h-4" />
            </button>
            <button
              onClick={() => folderRef.current?.click()}
              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              title={t('sidebar.importFolder')}
            >
              <FolderPlus className="w-4 h-4" />
            </button>
            <button
              onClick={handleStartCreate}
              className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              title={t('sidebar.newFile')}
            >
              <FilePlus className="w-4 h-4" />
            </button>
          </div>
          <input
            ref={importRef}
            type="file"
            multiple
            data-import-files
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) onImportFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            ref={folderRef}
            type="file"
            multiple
            className="hidden"
            {...({ webkitdirectory: '', directory: '' } as any)}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) onImportFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {/* New File Inline Input */}
        {isCreating && (
          <div className="p-2 border-b border-slate-800 bg-panel">
            <div className="flex items-center gap-1">
              <input
                type="text"
                autoFocus
                placeholder="script.py, src/app.js"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirmCreate();
                  if (e.key === 'Escape') setIsCreating(false);
                }}
                className="w-full bg-canvas text-xs text-fg border border-indigo-500/50 rounded px-2 py-1 focus:outline-none"
              />
              <button onClick={handleConfirmCreate} className="p-1 text-emerald-400 hover:bg-slate-800 rounded">
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setIsCreating(false)} className="p-1 text-slate-400 hover:bg-slate-800 rounded">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* File Tree */}
        <div className="py-1 overflow-y-auto min-h-0">
          {treeView}
          {assets.length > 0 && (
            <div className="mt-2 border-t border-slate-800/80 pt-1" data-assets>
              <button
                onClick={() => setAssetsOpen(!assetsOpen)}
                className="w-full px-3 py-1 flex items-center gap-1 text-[11px] font-semibold text-slate-500 uppercase tracking-wider hover:text-slate-300"
              >
                {assetsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                {t('assets.section', { count: assets.length })}
              </button>
              {assetsOpen &&
                assets.map((a) => {
                  const Icon = ASSET_ICONS[a.kind];
                  return (
                    <div
                      key={a.name}
                      data-asset={a.name}
                      onClick={() => onOpenAsset?.(a)}
                      title={a.name}
                      className={`flex items-center gap-2 px-3 py-1 text-xs cursor-pointer font-mono ${
                        activeAsset === a.name ? 'bg-active text-fg' : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5 shrink-0 text-slate-500" />
                      <span className="truncate">{a.name}</span>
                    </div>
                  );
                })}
            </div>
          )}
          <div className="px-3 pt-3 pb-2 text-[10px] text-slate-600 text-center">{t('sidebar.dropHint')}</div>
        </div>
      </div>

      {/* Bottom Stats */}
      <div className="p-3 border-t border-slate-800 text-[11px] text-slate-400 flex items-center justify-between shrink-0">
        <div>
          <span>
            {files.length} {files.length === 1 ? t('sidebar.file') : t('sidebar.files')}
          </span>
          <span className="mx-1.5 text-slate-600">·</span>
          <span>
            {totalLines} {t('sidebar.lines')}
          </span>
        </div>
        <div className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-400">
          {t('sidebar.ready')}
        </div>
      </div>
    </aside>
  );
};
