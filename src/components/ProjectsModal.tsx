import React, { useEffect, useRef, useState } from 'react';
import {
  FolderOpen,
  X,
  Plus,
  Upload,
  Download,
  Trash2,
  Edit3,
  Check,
  Loader2,
  FolderInput,
  ExternalLink,
  RotateCcw,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { useI18n } from '../i18n.ts';
import { ALL_TEMPLATES } from '../utils/presets.ts';
import { BackupsSection } from './BackupsSection.tsx';
import type { TemplateProject } from '../types.ts';
import {
  projectsApi,
  downloadProjectZip,
  readImportedFiles,
  pickedFromFileList,
  commonRootFolder,
  ProjectSummary,
  ProjectFilePayload,
  type TrashedProject,
} from '../utils/projects.ts';
import { askConfirm, showAlert } from '../dialogs.tsx';

interface ProjectsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentProjectId: string | null;
  onOpenProject: (id: string) => void;
  onCreateProject: (name: string, templateId: string | null) => Promise<void>;
  onImportAsProject: (name: string, files: ProjectFilePayload[], binaries?: { name: string; data: Blob }[]) => Promise<void>;
  onProjectRenamed: (id: string, name: string) => void;
  onProjectDeleted: (id: string) => void;
}

const CATEGORY_ICON: Record<TemplateProject['category'], string> = {
  python: '🐍',
  web: '🌐',
  scripts: '⚙️',
  database: '🗄️',
  bots: '🤖',
  games: '🎮',
};

export const ProjectsModal: React.FC<ProjectsModalProps> = ({
  isOpen,
  onClose,
  currentProjectId,
  onOpenProject,
  onCreateProject,
  onImportAsProject,
  onProjectRenamed,
  onProjectDeleted,
}) => {
  const { t, lang } = useI18n();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState<string>('');
  const [creating, setCreating] = useState(false);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const importInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const templateLabel = (id: string, fallback: string) => {
    const label = t(`tpl.${id}`);
    return label.startsWith('tpl.') ? fallback : label;
  };

  const [trash, setTrash] = useState<TrashedProject[]>([]);
  const [trashDays, setTrashDays] = useState(30);
  const [showTrash, setShowTrash] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      setProjects(await projectsApi.list());
      const tr = await projectsApi.trash();
      setTrash(tr.projects);
      setTrashDays(tr.days);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setNotice(null);
      setError(null);
      refresh();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const run = async (id: string | null, fn: () => Promise<void>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleCreate = () =>
    run(null, async () => {
      setCreating(true);
      try {
        const tpl = ALL_TEMPLATES.find((x) => x.id === newTemplate);
        const name = newName.trim() || (tpl ? templateLabel(tpl.id, tpl.name) : t('projects.untitled'));
        await onCreateProject(name, newTemplate || null);
        setNewName('');
        onClose();
      } finally {
        setCreating(false);
      }
    });

  const handleImport = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    await run(null, async () => {
      const picked = pickedFromFileList(fileList);
      // A picked folder becomes the project itself: strip its name from the paths and use it as the project name
      const rootFolder = commonRootFolder(picked.map((p) => p.path));
      const { files, skipped, binaries } = await readImportedFiles(picked, [], true);
      if (files.length === 0 && binaries.length === 0) throw new Error(t('projects.importEmpty'));
      const first = fileList[0].name;
      const name =
        newName.trim() ||
        rootFolder ||
        (first.toLowerCase().endsWith('.zip') ? first.replace(/\.zip$/i, '') : first.replace(/\.[^.]+$/, ''));
      await onImportAsProject(name, files, binaries);
      if (skipped.length) await showAlert(t('projects.skipped', { files: skipped.slice(0, 30).join(', ') }));
      onClose();
    });
    if (importInputRef.current) importInputRef.current.value = '';
    if (folderInputRef.current) folderInputRef.current.value = '';
  };

  const handleRename = (p: ProjectSummary) =>
    run(p.id, async () => {
      const name = renameValue.trim();
      setRenamingId(null);
      if (!name || name === p.name) return;
      await projectsApi.save(p.id, { name });
      onProjectRenamed(p.id, name);
      await refresh();
    });

  const handleDelete = async (p: ProjectSummary) => {
    if (!(await askConfirm(t('projects.confirmDelete', { name: p.name }), { danger: true }))) return;
    run(p.id, async () => {
      await projectsApi.remove(p.id);
      onProjectDeleted(p.id);
      await refresh();
    });
  };

  const handleRestore = (p: TrashedProject) =>
    run(p.trashId, async () => {
      const r = await projectsApi.restore(p.trashId);
      await refresh();
      setNotice(t('projects.restored', { name: r.name }));
    });

  const handleDeleteForever = async (p: TrashedProject) => {
    if (!(await askConfirm(t('projects.confirmDeleteForever', { name: p.name }), { danger: true }))) return;
    run(p.trashId, async () => {
      await projectsApi.deleteForever(p.trashId);
      await refresh();
    });
  };

  const handleEmptyTrash = async () => {
    if (!(await askConfirm(t('projects.confirmEmptyTrash', { count: trash.length }), { danger: true }))) return;
    run(null, async () => {
      await projectsApi.emptyTrash();
      await refresh();
    });
  };

  const daysLeft = (deletedAt: number) => Math.max(0, Math.ceil(trashDays - (Date.now() - deletedAt) / 86_400_000));

  const handleDownload = (p: ProjectSummary) =>
    run(p.id, async () => {
      const data = await projectsApi.get(p.id);
      await downloadProjectZip(data.name, data.files);
    });

  const handleOpenFolder = (p: ProjectSummary) =>
    run(p.id, async () => {
      const res = await projectsApi.openFolder(p.id);
      setNotice(t('projects.folderOpened', { path: res.path }));
    });

  const formatDate = (ms: number) =>
    new Date(ms).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="bg-raised border border-slate-700/80 rounded-xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-modal">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
              <FolderOpen className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-fg">{t('projects.title')}</h2>
              <p className="text-xs text-slate-400">{t('projects.subtitle')}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-fg rounded-lg hover:bg-slate-800 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-5 flex-1">
          {/* New project */}
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              {t('projects.new')}
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                placeholder={t('projects.namePlaceholder')}
                className="flex-1 min-w-[180px] bg-deep border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-fg placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={handleCreate}
                disabled={creating}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold"
              >
                {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                <span>{t('projects.create')}</span>
              </button>
            </div>

            {/* Template gallery */}
            <div className="mt-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">{t('projects.templates')}</div>
            <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-[300px] overflow-y-auto pr-1" role="listbox">
              {[null, ...ALL_TEMPLATES].map((tpl: TemplateProject | null) => {
                const id = tpl?.id || '';
                const selected = newTemplate === id;
                const pkgs = tpl ? [...(tpl.packages?.pip || []), ...(tpl.packages?.npm || [])] : [];
                const desc = tpl ? t(`tpldesc.${tpl.id}`) : '';
                return (
                  <button
                    key={id || 'empty'}
                    role="option"
                    aria-selected={selected}
                    data-template={id || 'empty'}
                    onClick={() => setNewTemplate(id)}
                    onDoubleClick={() => {
                      setNewTemplate(id);
                      handleCreate();
                    }}
                    className={`text-left rounded-lg border p-2.5 transition-colors ${
                      selected ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-700 bg-deep hover:border-slate-500'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-base leading-none">{tpl ? tpl.icon || CATEGORY_ICON[tpl.category] : '📄'}</span>
                      <span className="text-xs font-semibold text-fg truncate">{tpl ? templateLabel(tpl.id, tpl.name) : t('projects.empty')}</span>
                    </div>
                    {tpl && (
                      <p className="mt-1 text-[11px] leading-snug text-slate-400 line-clamp-2">
                        {desc.startsWith('tpldesc.') ? tpl.description : desc}
                      </p>
                    )}
                    {tpl && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        <span className="px-1.5 py-0.5 rounded bg-slate-700/60 text-[10px] text-slate-300">{t(`projects.cat.${tpl.category}`)}</span>
                        {pkgs.map((p) => (
                          <span key={p} className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-[10px] text-emerald-300 font-mono">
                            {p}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            {(() => {
              const tpl = ALL_TEMPLATES.find((x) => x.id === newTemplate);
              const pkgs = tpl ? [...(tpl.packages?.pip || []), ...(tpl.packages?.npm || [])] : [];
              return pkgs.length ? <p className="mt-1.5 text-[11px] text-slate-400">{t('projects.packagesNote', { list: pkgs.join(', ') })}</p> : null;
            })()}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => importInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-panel hover:bg-hover border border-slate-700 text-slate-200 text-xs font-medium"
              >
                <Upload className="w-3.5 h-3.5 text-emerald-400" />
                <span>{t('projects.import')}</span>
              </button>
              <button
                onClick={() => folderInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-panel hover:bg-hover border border-slate-700 text-slate-200 text-xs font-medium"
              >
                <FolderInput className="w-3.5 h-3.5 text-amber-300" />
                <span>{t('projects.importFolder')}</span>
              </button>
              <span className="text-[11px] text-slate-500">{t('projects.importHint')}</span>
              <input
                ref={folderInputRef}
                type="file"
                multiple
                className="hidden"
                {...({ webkitdirectory: '', directory: '' } as any)}
                onChange={(e) => handleImport(e.target.files)}
              />
              <input
                ref={importInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => handleImport(e.target.files)}
              />
            </div>
          </div>

          {/* Project list */}
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              {t('projects.mine')} {projects.length > 0 && <span className="text-slate-500">({projects.length})</span>}
            </label>

            {loading && projects.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-slate-400 py-4">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('projects.loading')}
              </div>
            ) : projects.length === 0 ? (
              <div className="text-xs text-slate-500 py-4 text-center">{t('projects.none')}</div>
            ) : (
              <div className="space-y-1.5">
                {projects.map((p) => {
                  const isCurrent = p.id === currentProjectId;
                  const isBusy = busyId === p.id;
                  return (
                    <div
                      key={p.id}
                      data-project-row={p.name}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
                        isCurrent ? 'bg-indigo-950/40 border-indigo-500/60' : 'bg-card border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        {renamingId === p.id ? (
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleRename(p);
                              if (e.key === 'Escape') setRenamingId(null);
                            }}
                            onBlur={() => handleRename(p)}
                            className="w-full bg-canvas text-fg border border-indigo-500 rounded px-1.5 py-0.5 text-xs focus:outline-none"
                          />
                        ) : (
                          <div className="text-xs font-medium text-fg truncate">
                            {p.name}
                            {isCurrent && (
                              <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-indigo-600/40 text-indigo-200">
                                {t('projects.current')}
                              </span>
                            )}
                          </div>
                        )}
                        <div className="text-[10px] text-slate-500 mt-0.5">
                          {t('projects.filesCount', { count: p.fileCount })} · {formatDate(p.updatedAt)}
                        </div>
                      </div>

                      {isBusy && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}

                      <div className="flex items-center gap-0.5 text-slate-400">
                        {!isCurrent && (
                          <button
                            onClick={() => {
                              onOpenProject(p.id);
                              onClose();
                            }}
                            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-800 hover:text-fg text-[11px] text-indigo-300"
                            title={t('projects.open')}
                          >
                            <FolderInput className="w-3.5 h-3.5" />
                            <span>{t('projects.open')}</span>
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setRenamingId(p.id);
                            setRenameValue(p.name);
                          }}
                          className="p-1.5 rounded hover:bg-slate-800 hover:text-fg"
                          title={t('projects.rename')}
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDownload(p)}
                          className="p-1.5 rounded hover:bg-slate-800 hover:text-emerald-400"
                          title={t('projects.download')}
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleOpenFolder(p)}
                          className="p-1.5 rounded hover:bg-slate-800 hover:text-fg"
                          title={t('projects.openFolder')}
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(p)}
                          className="p-1.5 rounded hover:bg-slate-800 hover:text-rose-400"
                          title={t('projects.delete')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Backups */}
          <BackupsSection
            formatDate={formatDate}
            onRestored={async (name) => {
              await refresh();
              setNotice(t('backups.restored', { name }));
            }}
          />

          {/* Trash */}
          {trash.length > 0 && (
            <div data-trash>
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setShowTrash(!showTrash)}
                  className="flex items-center gap-1 text-xs font-semibold text-slate-400 uppercase tracking-wider hover:text-slate-200"
                >
                  {showTrash ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <Trash2 className="w-3.5 h-3.5" />
                  {t('projects.trash', { count: trash.length })}
                </button>
                {showTrash && (
                  <button onClick={handleEmptyTrash} className="text-[11px] text-rose-400 hover:underline">
                    {t('projects.emptyTrash')}
                  </button>
                )}
              </div>
              {showTrash && (
                <div className="mt-2 space-y-1.5">
                  <p className="text-[11px] text-slate-500">{t('projects.trashHint', { days: trashDays })}</p>
                  {trash.map((p) => (
                    <div key={p.trashId} data-trash-item={p.name} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-deep border border-slate-800 text-xs">
                      <div className="min-w-0 flex-1">
                        <div className="text-slate-300 truncate">{p.name}</div>
                        <div className="text-[10px] text-slate-500">
                          {t('projects.deletedAt', { date: formatDate(p.deletedAt), files: p.fileCount, days: daysLeft(p.deletedAt) })}
                        </div>
                      </div>
                      <button
                        onClick={() => handleRestore(p)}
                        disabled={busyId === p.trashId}
                        className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold"
                      >
                        {busyId === p.trashId ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                        {t('projects.restore')}
                      </button>
                      <button
                        onClick={() => handleDeleteForever(p)}
                        disabled={busyId === p.trashId}
                        className="p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-slate-800"
                        title={t('projects.deleteForever')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {notice && (
            <div className="p-2.5 rounded-lg bg-emerald-950/30 border border-emerald-800 text-xs text-emerald-300 flex items-center gap-2">
              <Check className="w-3.5 h-3.5 shrink-0" />
              <span className="break-all">{notice}</span>
            </div>
          )}
          {error && <div className="p-2.5 rounded-lg bg-rose-950/30 border border-rose-800 text-xs text-rose-300">{error}</div>}
        </div>
      </div>
    </div>
  );
};
