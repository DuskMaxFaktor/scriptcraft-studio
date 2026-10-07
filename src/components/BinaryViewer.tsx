import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Download, Package, Save, Pencil, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useI18n } from '../i18n.ts';

// "Disassembler": inspect and patch a binary (.exe / .dll / .so ...) — like Ghidra's basics.
// Overview (headers, sections, imports/exports, strings), Disassembly (per section, via capstone),
// and a Hex editor that patches bytes in place (a .bak backup is made on the first save).

interface Section {
  name: string;
  vaddr: number;
  vsize: number;
  rawPtr: number;
  rawSize: number;
  read: boolean;
  write: boolean;
  exec: boolean;
}
interface Info {
  size: number;
  format: string;
  arch: string | null;
  archName: string | null;
  entryPoint: number | null;
  imageBase: number | null;
  subsystem?: number;
  dll?: boolean;
  timestamp?: number;
  sections: Section[];
  imports: { dll: string; functions: string[] }[];
  exports: { name: string; rva: number; ordinal: number }[];
  strings: { offset: number; enc: string; text: string }[];
}
interface Instruction {
  addr: number;
  offset: number;
  bytes: string;
  mnemonic: string;
  op: string;
}

interface Props {
  projectId: string;
  path: string;
  /** bumped when the file changes on disk, to re-read */
  version: number;
}

const hex = (n: number, pad = 0) => n.toString(16).padStart(pad, '0');
const DISASM_ARCHS = new Set(['x86', 'x64', 'arm', 'thumb', 'arm64']);
const HEX_PAGE = 512;

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { code: data?.code });
  return data;
}

async function readInstall(runId: string, onText: (t: string) => void): Promise<number | null> {
  const res = await fetch(`/api/run/${runId}/events`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return null;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(i + 2);
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === 'exit') {
        reader.cancel().catch(() => {});
        return ev.code;
      }
      if (typeof ev.data === 'string') onText(ev.data);
    }
  }
}

const InfoRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex gap-2">
    <span className="w-28 shrink-0 text-slate-500">{label}</span>
    <span className="font-mono text-slate-200 break-all">{children}</span>
  </div>
);

// ---------- Hex editor ----------
const HexView: React.FC<{ projectId: string; path: string; version: number; total: number; start?: number }> = ({ projectId, path, version, total, start = 0 }) => {
  const { t } = useI18n();
  const [offset, setOffset] = useState(0);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  // offset (absolute) -> new byte value
  const [edits, setEdits] = useState<Map<number, number>>(new Map());
  const [sel, setSel] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [gotoText, setGotoText] = useState('');

  const load = useCallback(
    async (off: number) => {
      setLoading(true);
      try {
        const d = await post('/api/disasm/bytes', { projectId, path, offset: off, length: HEX_PAGE });
        const bin = atob(d.bytes);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        setBytes(arr);
        setOffset(d.offset);
      } finally {
        setLoading(false);
      }
    },
    [projectId, path]
  );

  useEffect(() => {
    void load(Math.max(0, start - (start % 16)));
    setEdits(new Map());
  }, [load, version, start]);

  const byteAt = (abs: number, orig: number) => (edits.has(abs) ? edits.get(abs)! : orig);
  const commit = (abs: number, value: string) => {
    const v = parseInt(value, 16);
    if (value.length && !Number.isNaN(v) && v >= 0 && v <= 255) {
      setEdits((m) => {
        const next = new Map(m);
        next.set(abs, v);
        return next;
      });
    }
    setSel(null);
  };

  const save = async () => {
    if (!edits.size) return;
    setSaving(true);
    setSaved(null);
    try {
      const editsArr = [...edits.entries()].map(([o, v]) => ({ offset: o, hex: hex(v, 2) }));
      const r = await post('/api/disasm/patch', { projectId, path, edits: editsArr });
      setSaved(t('disasm.saved', { count: r.patched, backup: r.backup }));
      setEdits(new Map());
      await load(offset);
    } catch (e: any) {
      setSaved(e.message);
    } finally {
      setSaving(false);
    }
  };

  const go = () => {
    const v = parseInt(gotoText.replace(/^0x/i, ''), 16);
    if (!Number.isNaN(v)) void load(Math.max(0, Math.min(v - (v % 16), total - 1)));
  };

  const rows = useMemo(() => {
    if (!bytes) return [];
    const out: { abs: number; cells: number[] }[] = [];
    for (let i = 0; i < bytes.length; i += 16) out.push({ abs: offset + i, cells: [...bytes.subarray(i, i + 16)] });
    return out;
  }, [bytes, offset]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 text-[11px]">
        <button
          onClick={() => setEditing((e) => !e)}
          className={`flex items-center gap-1 px-2 py-0.5 rounded border ${editing ? 'border-amber-500/60 text-amber-300 bg-amber-500/10' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}
        >
          <Pencil className="w-3 h-3" /> {t('disasm.edit')}
        </button>
        {editing && <span className="text-slate-500">{t('disasm.editHint')}</span>}
        {edits.size > 0 && (
          <>
            <span className="text-amber-300">{t('disasm.dirty', { count: edits.size })}</span>
            <button onClick={save} disabled={saving} className="flex items-center gap-1 px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} {saving ? t('disasm.saving') : t('disasm.save')}
            </button>
            <button onClick={() => setEdits(new Map())} className="px-2 py-0.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800">
              {t('disasm.cancel')}
            </button>
          </>
        )}
        {saved && <span className="text-slate-400">{saved}</span>}
        <div className="ml-auto flex items-center gap-1">
          <input
            value={gotoText}
            onChange={(e) => setGotoText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
            placeholder={t('disasm.gotoOffset')}
            className="w-32 bg-deep border border-slate-700 rounded px-2 py-0.5 font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
          />
          <button disabled={offset === 0} onClick={() => load(Math.max(0, offset - HEX_PAGE))} className="p-0.5 rounded hover:bg-slate-800 disabled:opacity-30">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button disabled={offset + HEX_PAGE >= total} onClick={() => load(offset + HEX_PAGE)} className="p-0.5 rounded hover:bg-slate-800 disabled:opacity-30">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3 font-mono text-[11px] leading-5" data-hex-view>
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin text-slate-500" />
        ) : (
          <table className="border-collapse">
            <tbody>
              {rows.map((row) => (
                <tr key={row.abs}>
                  <td className="pr-4 text-slate-500 select-none">{hex(row.abs, 8)}</td>
                  {row.cells.map((orig, i) => {
                    const abs = row.abs + i;
                    const val = byteAt(abs, orig);
                    const changed = edits.has(abs);
                    if (editing && sel === abs) {
                      return (
                        <td key={i} className="px-0.5">
                          <input
                            autoFocus
                            defaultValue={hex(val, 2)}
                            maxLength={2}
                            onBlur={(e) => commit(abs, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                              if (e.key === 'Escape') setSel(null);
                            }}
                            className="w-5 bg-indigo-600 text-white text-center rounded-sm focus:outline-none uppercase"
                          />
                        </td>
                      );
                    }
                    return (
                      <td
                        key={i}
                        onClick={() => editing && setSel(abs)}
                        className={`px-0.5 uppercase ${editing ? 'cursor-pointer hover:bg-slate-700' : ''} ${changed ? 'text-amber-300 font-bold' : 'text-slate-300'}`}
                      >
                        {hex(val, 2)}
                      </td>
                    );
                  })}
                  <td className="pl-4 text-slate-400 select-none whitespace-pre">
                    {row.cells.map((orig, i) => {
                      const v = byteAt(row.abs + i, orig);
                      return v >= 32 && v < 127 ? String.fromCharCode(v) : '.';
                    }).join('')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

// ---------- Disassembly ----------
const Disassembly: React.FC<{ projectId: string; path: string; info: Info; version: number }> = ({ projectId, path, info, version }) => {
  const { t } = useI18n();
  const execSections = info.sections.filter((s) => s.exec && s.rawSize > 0);
  const entryIn = info.entryPoint != null ? info.sections.find((s) => info.entryPoint! >= s.vaddr && info.entryPoint! < s.vaddr + s.vsize) : null;
  const [sectionName, setSectionName] = useState((entryIn && entryIn.exec ? entryIn.name : execSections[0]?.name) || '');
  const [ins, setIns] = useState<Instruction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const section = info.sections.find((s) => s.name === sectionName);
  const canDisasm = info.arch && DISASM_ARCHS.has(info.arch);

  useEffect(() => {
    if (!section || !canDisasm) return;
    let alive = true;
    setLoading(true);
    setError(null);
    post('/api/disasm/disasm', {
      projectId,
      path,
      offset: section.rawPtr,
      length: Math.min(section.rawSize, 256 * 1024),
      vaddr: (info.imageBase || 0) + section.vaddr,
      arch: info.arch,
    })
      .then((d) => alive && setIns(d.instructions))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [projectId, path, sectionName, version, canDisasm]);

  if (!canDisasm) return <p className="p-4 text-slate-400 text-xs">{t('disasm.noDisasmArch', { arch: info.archName || info.arch || '?' })}</p>;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 text-[11px]">
        <span className="text-slate-500">{t('disasm.section')}</span>
        <select value={sectionName} onChange={(e) => setSectionName(e.target.value)} className="bg-deep border border-slate-700 rounded px-2 py-0.5 text-slate-200 focus:outline-none">
          {execSections.length === 0 && <option value="">—</option>}
          {execSections.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-500" />}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3 font-mono text-[11px] leading-5" data-disasm-view>
        {error && <p className="text-rose-300">{error}</p>}
        {!error && !loading && ins.length === 0 && <p className="text-slate-400">{t('disasm.noCode')}</p>}
        {!error && ins.length > 0 && (
          <table className="border-collapse">
            <tbody>
              {ins.map((x, i) => (
                <tr key={i} className="hover:bg-slate-800/40">
                  <td className="pr-4 text-indigo-400 select-none">{hex(x.addr, 8)}</td>
                  <td className="pr-4 text-slate-500 select-none">{x.bytes.replace(/(..)/g, '$1 ').trim()}</td>
                  <td className="pr-3 text-sky-300">{x.mnemonic}</td>
                  <td className="text-slate-200">{x.op}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

// ---------- Overview ----------
const Overview: React.FC<{ info: Info; onGotoHex: (offset: number) => void }> = ({ info, onGotoHex }) => {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const strings = useMemo(() => {
    const q = filter.toLowerCase();
    return info.strings.filter((s) => !q || s.text.toLowerCase().includes(q)).slice(0, 2000);
  }, [info.strings, filter]);

  return (
    <div className="flex-1 min-h-0 overflow-auto p-4 text-xs space-y-4">
      <div className="space-y-1">
        <InfoRow label={t('disasm.format')}>{info.format.toUpperCase()}</InfoRow>
        {info.archName && <InfoRow label={t('disasm.arch')}>{info.archName}</InfoRow>}
        {info.imageBase != null && <InfoRow label={t('disasm.imageBase')}>0x{hex(info.imageBase)}</InfoRow>}
        {info.entryPoint != null && <InfoRow label={t('disasm.entry')}>0x{hex(info.entryPoint)}</InfoRow>}
      </div>

      {info.sections.length > 0 && (
        <div>
          <h3 className="text-slate-400 font-semibold mb-1">{t('disasm.sections')}</h3>
          <table className="w-full font-mono text-[11px] border-collapse">
            <thead>
              <tr className="text-slate-500 text-left">
                <th className="pr-4 font-normal">{t('disasm.section')}</th>
                <th className="pr-4 font-normal">{t('disasm.vaddr')}</th>
                <th className="pr-4 font-normal">{t('disasm.size')}</th>
                <th className="pr-4 font-normal">{t('disasm.offset')}</th>
                <th className="font-normal">{t('disasm.flags')}</th>
              </tr>
            </thead>
            <tbody>
              {info.sections.map((s) => (
                <tr key={s.name} className="text-slate-300 hover:bg-slate-800/40 cursor-pointer" onClick={() => onGotoHex(s.rawPtr)}>
                  <td className="pr-4">{s.name}</td>
                  <td className="pr-4">0x{hex(s.vaddr)}</td>
                  <td className="pr-4">0x{hex(s.vsize)}</td>
                  <td className="pr-4">0x{hex(s.rawPtr)}</td>
                  <td className="text-slate-500">{`${s.read ? 'r' : '-'}${s.write ? 'w' : '-'}${s.exec ? 'x' : '-'}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {info.imports.length > 0 && (
        <div>
          <h3 className="text-slate-400 font-semibold mb-1">{t('disasm.imports')}</h3>
          <div className="space-y-1.5 font-mono text-[11px]">
            {info.imports.map((imp) => (
              <details key={imp.dll} className="group">
                <summary className="cursor-pointer text-sky-300">
                  {imp.dll} <span className="text-slate-500">({imp.functions.length})</span>
                </summary>
                <div className="pl-4 pt-1 text-slate-400 columns-2 md:columns-3">{imp.functions.map((f, i) => <div key={i} className="truncate">{f}</div>)}</div>
              </details>
            ))}
          </div>
        </div>
      )}

      {info.exports.length > 0 && (
        <div>
          <h3 className="text-slate-400 font-semibold mb-1">{t('disasm.exports')} ({info.exports.length})</h3>
          <div className="font-mono text-[11px] text-slate-400 columns-2 md:columns-3">
            {info.exports.slice(0, 1000).map((e, i) => <div key={i} className="truncate">{e.name}</div>)}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-slate-400 font-semibold">{t('disasm.strings')} ({info.strings.length})</h3>
          <div className="relative ml-auto">
            <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('disasm.search')} className="w-48 bg-deep border border-slate-700 rounded pl-6 pr-2 py-0.5 text-slate-200 focus:outline-none focus:border-indigo-500" />
          </div>
        </div>
        <table className="w-full font-mono text-[11px] border-collapse">
          <tbody>
            {strings.map((s, i) => (
              <tr key={i} className="text-slate-300 hover:bg-slate-800/40 cursor-pointer" onClick={() => onGotoHex(s.offset)}>
                <td className="pr-4 text-slate-500 align-top w-24">0x{hex(s.offset, 8)}</td>
                <td className="whitespace-pre-wrap break-all">{s.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export const BinaryViewer: React.FC<Props> = ({ projectId, path, version }) => {
  const { t } = useI18n();
  const [info, setInfo] = useState<Info | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [libsMissing, setLibsMissing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installOut, setInstallOut] = useState('');
  const [tab, setTab] = useState<'overview' | 'disasm' | 'hex'>('overview');
  const [hexBump, setHexBump] = useState(0);
  const hexStart = useRef(0);

  const analyze = useCallback(() => {
    setLoading(true);
    setError(null);
    post('/api/disasm/analyze', { projectId, path })
      .then((d) => {
        setInfo(d);
        setLibsMissing(false);
      })
      .catch((e: any) => {
        if (e.code === 'libs-missing') setLibsMissing(true);
        else setError(e.message);
      })
      .finally(() => setLoading(false));
  }, [projectId, path]);

  useEffect(() => {
    analyze();
  }, [analyze, version]);

  const install = async () => {
    setInstalling(true);
    setInstallOut('');
    try {
      const { runId } = await post('/api/disasm/install', {});
      await readInstall(runId, (s) => setInstallOut((o) => (o + s).slice(-20000)));
      analyze();
    } catch (e: any) {
      setInstallOut((o) => o + '\n' + e.message);
    } finally {
      setInstalling(false);
    }
  };

  const gotoHex = (offset: number) => {
    hexStart.current = offset;
    setTab('hex');
    setHexBump((b) => b + 1);
  };

  if (libsMissing) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-xs">
        <Package className="w-10 h-10 text-slate-600" />
        <p className="text-slate-300 max-w-md">{t('disasm.needLibs')}</p>
        <button onClick={install} disabled={installing} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold disabled:opacity-50">
          {installing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {installing ? t('disasm.installing') : t('disasm.install')}
        </button>
        {installOut && <pre className="max-h-40 w-full max-w-md overflow-auto text-left text-[10px] text-slate-500 bg-deep border border-slate-800 rounded p-2 whitespace-pre-wrap">{installOut}</pre>}
      </div>
    );
  }

  if (loading) return <div className="flex-1 flex items-center justify-center gap-2 text-xs text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> {t('disasm.loading')}</div>;
  if (error) return <p className="flex-1 flex items-center justify-center p-4 text-xs text-rose-300">{t('disasm.error', { error })}</p>;
  if (!info) return null;

  const TABS: { id: typeof tab; label: string }[] = [
    { id: 'overview', label: t('disasm.overview') },
    { id: 'disasm', label: t('disasm.disassembly') },
    { id: 'hex', label: t('disasm.hex') },
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-1 px-2 border-b border-slate-800 shrink-0">
        {TABS.map((x) => (
          <button
            key={x.id}
            data-disasm-tab={x.id}
            onClick={() => setTab(x.id)}
            className={`px-3 py-1.5 text-xs border-b-2 -mb-px ${tab === x.id ? 'border-indigo-500 text-fg' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            {x.label}
          </button>
        ))}
      </div>
      {tab === 'overview' && <Overview info={info} onGotoHex={gotoHex} />}
      {tab === 'disasm' && <Disassembly projectId={projectId} path={path} info={info} version={version} />}
      {tab === 'hex' && <HexView key={hexBump} projectId={projectId} path={path} version={version} total={info.size} start={hexStart.current} />}
    </div>
  );
};
