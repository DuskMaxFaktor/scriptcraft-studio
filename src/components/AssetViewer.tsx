import React, { useEffect, useMemo, useState } from 'react';
import { X, Image as ImageIcon, Database, Music, Film, File, Binary, RefreshCw, Loader2, Play, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import type { Database as SqlDatabase } from 'sql.js';
import { useI18n } from '../i18n.ts';
import type { ProjectAsset } from '../types.ts';
import { loadSqlEngine } from '../utils/execution.ts';
import { BinaryViewer } from './BinaryViewer.tsx';

// Viewer for the project's non-text files: images, SQLite databases, sound and video.
// A database is opened as an in-memory copy: queries never change the file on disk.


interface Props {
  projectId: string;
  asset: ProjectAsset;
  onClose: () => void;
}

const sizeText = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);
const assetIcon = (kind: ProjectAsset['kind']) => ({ image: ImageIcon, sqlite: Database, audio: Music, video: Film, binary: Binary, other: File })[kind];

const PAGE = 100;

interface Result {
  columns: string[];
  rows: unknown[][];
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  return String(v);
}

const ResultTable: React.FC<{ result: Result }> = ({ result }) => (
  <div className="overflow-auto border border-slate-800 rounded">
    <table className="min-w-full text-[11px] font-mono" data-db-table>
      <thead className="bg-panel sticky top-0">
        <tr>
          {result.columns.map((c, i) => (
            <th key={i} className="px-2 py-1 text-left text-slate-300 font-semibold border-b border-slate-700 whitespace-nowrap">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((r, i) => (
          <tr key={i} className="hover:bg-panel/60">
            {r.map((v, j) => (
              <td key={j} className={`px-2 py-0.5 border-b border-slate-800/70 whitespace-nowrap max-w-[360px] truncate ${v === null ? 'text-slate-600 italic' : 'text-slate-300'}`} title={cell(v)}>
                {cell(v)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const DbViewer: React.FC<{ url: string }> = ({ url }) => {
  const { t } = useI18n();
  const [db, setDb] = useState<SqlDatabase | null>(null);
  const [tables, setTables] = useState<{ name: string; type: string; count: number }[]>([]);
  const [table, setTable] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    let opened: SqlDatabase | null = null;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [SQL, bytes] = await Promise.all([loadSqlEngine(), fetch(url, { cache: 'no-store' }).then((r) => r.arrayBuffer())]);
        opened = new SQL.Database(new Uint8Array(bytes));
        const list = opened.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
        const names = (list[0]?.values || []).map(([name, type]) => ({ name: String(name), type: String(type), count: 0 }));
        for (const n of names) {
          try {
            n.count = Number(opened.exec(`SELECT COUNT(*) FROM "${n.name.replace(/"/g, '""')}"`)[0].values[0][0]);
          } catch {
            n.count = -1;
          }
        }
        if (!alive) return opened.close();
        setDb(opened);
        setTables(names);
        setTable((cur) => (cur && names.some((x) => x.name === cur) ? cur : names[0]?.name || null));
      } catch (e: any) {
        if (alive) setError(t('assets.dbError', { error: e?.message || String(e) }));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
      opened?.close();
    };
  }, [url, reloadKey]);

  const run = (sql: string) => {
    if (!db) return;
    try {
      const res = db.exec(sql);
      const last = res[res.length - 1];
      setResult(last ? { columns: last.columns, rows: last.values } : { columns: [t('assets.done')], rows: [[t('assets.noRows')]] });
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  useEffect(() => {
    if (db && table) {
      setQuery('');
      run(`SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT ${PAGE} OFFSET ${page * PAGE}`);
    }
  }, [db, table, page]);

  const current = tables.find((x) => x.name === table);
  return (
    <div className="flex-1 min-h-0 flex text-xs">
      <div className="w-56 shrink-0 border-r border-slate-800 overflow-y-auto py-1">
        <div className="px-3 py-1 flex items-center justify-between text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
          {t('assets.tables')}
          <button onClick={() => setReloadKey((k) => k + 1)} title={t('assets.reload')} className="p-0.5 hover:text-slate-200">
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {tables.map((x) => (
          <button
            key={x.name}
            data-db-table-name={x.name}
            onClick={() => {
              setTable(x.name);
              setPage(0);
            }}
            className={`w-full text-left px-3 py-1 flex items-center gap-2 font-mono ${x.name === table ? 'bg-active text-fg' : 'text-slate-300 hover:bg-slate-800/60'}`}
          >
            <span className="truncate flex-1">{x.name}</span>
            <span className="text-[10px] text-slate-500">{x.count >= 0 ? x.count : '?'}</span>
          </button>
        ))}
        {!loading && !tables.length && !error && <p className="px-3 py-1 text-slate-500">{t('assets.noTables')}</p>}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-2 p-3 min-h-0">
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && query.trim() && run(query)}
            placeholder={table ? `SELECT * FROM "${table}" WHERE ...` : 'SELECT ...'}
            className="flex-1 min-w-0 bg-deep border border-slate-700 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-fg focus:outline-none focus:border-indigo-500"
            data-db-query
          />
          <button onClick={() => query.trim() && run(query)} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold">
            <Play className="w-3 h-3" /> {t('assets.run')}
          </button>
        </div>
        <p className="text-[10px] text-slate-500">{t('assets.readOnly')}</p>
        {error && <div className="p-2 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 whitespace-pre-wrap">{error}</div>}
        {loading ? <Loader2 className="w-4 h-4 animate-spin text-slate-500" /> : result && <ResultTable result={result} />}
        {current && !query && current.count > PAGE && (
          <div className="flex items-center gap-2 text-slate-400">
            <button disabled={page === 0} onClick={() => setPage(page - 1)} className="p-1 rounded hover:bg-slate-800 disabled:opacity-30">
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            {t('assets.rows', { from: page * PAGE + 1, to: Math.min((page + 1) * PAGE, current.count), total: current.count })}
            <button disabled={(page + 1) * PAGE >= current.count} onClick={() => setPage(page + 1)} className="p-1 rounded hover:bg-slate-800 disabled:opacity-30">
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export const AssetViewer: React.FC<Props> = ({ projectId, asset, onClose }) => {
  const { t } = useI18n();
  const [fit, setFit] = useState(true);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // mtime in the URL: a file rewritten by the program shows its new content
  const url = useMemo(
    () => `/api/projects/${encodeURIComponent(projectId)}/raw?path=${encodeURIComponent(asset.name)}&v=${Math.round(asset.mtime)}`,
    [projectId, asset.name, asset.mtime]
  );
  const Icon = assetIcon(asset.kind);
  useEffect(() => setDims(null), [url]);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-canvas border-r border-slate-800" data-asset-viewer={asset.name}>
      <div className="h-10 bg-bar border-b border-slate-800 flex items-center gap-2 px-3 select-none shrink-0 text-xs">
        <Icon className="w-4 h-4 text-indigo-400 shrink-0" />
        <span className="font-mono text-fg truncate">{asset.name}</span>
        <span className="text-slate-500 shrink-0">{sizeText(asset.size)}</span>
        {dims && <span className="text-slate-500 shrink-0" data-image-size>{dims.w} × {dims.h} px</span>}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {asset.kind === 'image' && (
            <button onClick={() => setFit(!fit)} className="px-2 py-0.5 rounded border border-slate-700 text-slate-300 hover:text-fg hover:bg-slate-800">
              {fit ? '100%' : t('assets.fit')}
            </button>
          )}
          <a href={url} download={asset.name.split('/').pop()} className="p-1 rounded text-slate-400 hover:text-fg hover:bg-slate-800" title={t('assets.download')}>
            <Download className="w-4 h-4" />
          </a>
          <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-fg hover:bg-slate-800" title={t('assets.close')}>
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {asset.kind === 'image' && (
        <div
          className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4"
          style={{ backgroundImage: 'repeating-conic-gradient(#80808022 0% 25%, transparent 0% 50%)', backgroundSize: '20px 20px' }}
        >
          <img
            src={url}
            alt={asset.name}
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            className={fit ? 'max-w-full max-h-full object-contain' : 'max-w-none'}
            style={{ imageRendering: dims && dims.w < 64 ? 'pixelated' : undefined, minWidth: fit && dims && dims.w < 64 ? 128 : undefined }}
          />
        </div>
      )}
      {asset.kind === 'sqlite' && <DbViewer url={url} />}
      {asset.kind === 'binary' && <BinaryViewer projectId={projectId} path={asset.name} version={Math.round(asset.mtime)} />}
      {asset.kind === 'audio' && (
        <div className="flex-1 flex items-center justify-center">
          <audio src={url} controls />
        </div>
      )}
      {asset.kind === 'video' && (
        <div className="flex-1 min-h-0 flex items-center justify-center p-4 bg-black">
          <video src={url} controls className="max-w-full max-h-full" />
        </div>
      )}
      {asset.kind === 'other' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-xs text-slate-400">
          <File className="w-10 h-10 text-slate-600" />
          <p>{t('assets.noPreview')}</p>
          <a href={url} download={asset.name.split('/').pop()} className="text-indigo-400 hover:underline">
            {t('assets.download')}
          </a>
        </div>
      )}
    </div>
  );
};
