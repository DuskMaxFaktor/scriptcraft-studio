import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, execFile } from 'child_process';

// "Programs on this PC": the installed applications Windows knows about (the same registry entries
// "Programs and Features" shows), a health check of each entry, and the program's OWN repair:
//   - Windows Installer (MSI) packages: msiexec /fa {ProductCode} (reinstall all files)
//   - other programs: their own setup in "modify / repair" mode (ModifyPath), when they provide one
// Nothing is uninstalled or changed without the user's explicit click; Windows asks for admin rights itself.
//
// Tests never touch the real PC: SCRIPTCRAFT_APPS_FIXTURE (a JSON file with registry-like entries)
// replaces the registry and SCRIPTCRAFT_APPS_DRYRUN=1 makes "repair" report the command instead of running it.

const isWin = process.platform === 'win32';

interface RawEntry {
  DisplayName?: string;
  DisplayVersion?: string;
  Publisher?: string;
  InstallDate?: string;
  EstimatedSize?: number; // KB
  InstallLocation?: string;
  DisplayIcon?: string;
  UninstallString?: string;
  ModifyPath?: string;
  WindowsInstaller?: number;
  NoRepair?: number;
  NoModify?: number;
  SystemComponent?: number;
  ParentKeyName?: string;
  ReleaseType?: string;
  PSChildName?: string; // the registry key name (the ProductCode for MSI packages)
  Hive?: string; // HKLM / HKLM32 / HKCU
}

export interface InstalledApp {
  id: string;
  name: string;
  version: string;
  publisher: string;
  installDate: string | null; // YYYY-MM-DD
  sizeMB: number | null;
  location: string | null;
  scope: 'machine' | 'user';
  msi: boolean;
  /** How it can be repaired, if at all */
  repair: 'msi' | 'modify' | null;
  problems: ('folder-missing' | 'exe-missing' | 'uninstaller-missing')[];
}

const GUID = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/;

const PS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$roots = @(
  @{ Hive = 'HKLM';   Path = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },
  @{ Hive = 'HKLM32'; Path = 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },
  @{ Hive = 'HKCU';   Path = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' }
)
$out = foreach ($r in $roots) {
  Get-ItemProperty -Path $r.Path -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object {
    [pscustomobject]@{
      DisplayName = $_.DisplayName; DisplayVersion = $_.DisplayVersion; Publisher = $_.Publisher
      InstallDate = $_.InstallDate; EstimatedSize = $_.EstimatedSize; InstallLocation = $_.InstallLocation
      DisplayIcon = $_.DisplayIcon; UninstallString = $_.UninstallString; ModifyPath = $_.ModifyPath
      WindowsInstaller = $_.WindowsInstaller; NoRepair = $_.NoRepair; NoModify = $_.NoModify
      SystemComponent = $_.SystemComponent; ParentKeyName = $_.ParentKeyName; ReleaseType = $_.ReleaseType
      PSChildName = $_.PSChildName; Hive = $r.Hive
    }
  }
}
@($out) | ConvertTo-Json -Depth 2 -Compress
`;

function readRegistry(): Promise<RawEntry[]> {
  const fixture = process.env.SCRIPTCRAFT_APPS_FIXTURE;
  if (fixture) return Promise.resolve(JSON.parse(fs.readFileSync(fixture, 'utf-8')));
  if (!isWin) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60_000, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return reject(new Error('Cannot read the list of installed programs: ' + err.message));
        const text = stdout.trim();
        if (!text) return resolve([]);
        try {
          const data = JSON.parse(text);
          resolve(Array.isArray(data) ? data : [data]);
        } catch {
          reject(new Error('Unexpected output while reading installed programs'));
        }
      }
    );
  });
}

/** The executable of a command line / icon path: "C:\x\a.exe" /S  ->  C:\x\a.exe ; C:\x\a.exe,0 -> C:\x\a.exe */
export function exeOf(command: string | undefined): string | null {
  if (!command) return null;
  const s = command.trim();
  if (!s) return null;
  let exe: string;
  if (s.startsWith('"')) exe = s.slice(1, s.indexOf('"', 1) > 0 ? s.indexOf('"', 1) : undefined);
  else {
    const m = /^(.*?\.(exe|com|bat|cmd|msi|ico|dll))\b/i.exec(s);
    exe = m ? m[1] : s.split(' ')[0];
  }
  exe = exe.replace(/,-?\d+$/, '').trim();
  return exe || null;
}

/** Windows' own tools (msiexec, rundll32) are always there: no point checking them */
const isSystemTool = (exe: string) => /^(msiexec|rundll32)(\.exe)?$/i.test(path.win32.basename(exe));

/** A stable id for an entry: hive + registry key name. */
const idOf = (e: RawEntry) => crypto.createHash('sha1').update(`${e.Hive || ''}|${e.PSChildName || e.DisplayName}`).digest('hex').slice(0, 16);

function toApp(e: RawEntry, exists: (p: string) => boolean): InstalledApp {
  const msi = e.WindowsInstaller === 1 && GUID.test(e.PSChildName || '');
  const problems: InstalledApp['problems'] = [];
  const location = e.InstallLocation?.trim().replace(/^"|"$/g, '') || null;
  if (location && !exists(location)) problems.push('folder-missing');
  const icon = exeOf(e.DisplayIcon);
  if (icon && /\.exe$/i.test(icon) && !isSystemTool(icon) && !exists(icon)) problems.push('exe-missing');
  const uninstaller = exeOf(e.UninstallString);
  if (uninstaller && !isSystemTool(uninstaller) && /\.(exe|bat|cmd)$/i.test(uninstaller) && !exists(uninstaller)) problems.push('uninstaller-missing');
  const repair: InstalledApp['repair'] = msi && e.NoRepair !== 1 ? 'msi' : e.ModifyPath && e.NoModify !== 1 ? 'modify' : null;
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(String(e.InstallDate || ''));
  return {
    id: idOf(e),
    name: String(e.DisplayName),
    version: String(e.DisplayVersion || ''),
    publisher: String(e.Publisher || ''),
    installDate: d ? `${d[1]}-${d[2]}-${d[3]}` : null,
    sizeMB: typeof e.EstimatedSize === 'number' && e.EstimatedSize > 0 ? Math.round((e.EstimatedSize / 1024) * 10) / 10 : null,
    location,
    scope: e.Hive === 'HKCU' ? 'user' : 'machine',
    msi,
    repair,
    problems,
  };
}

/** Installed programs as "Programs and Features" shows them (no system components, no updates). */
export async function listInstalledApps(): Promise<{ apps: InstalledApp[]; raw: Map<string, RawEntry> }> {
  const entries = await readRegistry();
  const raw = new Map<string, RawEntry>();
  const exists = (p: string) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  const apps: InstalledApp[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e?.DisplayName || e.SystemComponent === 1 || e.ParentKeyName || /update|hotfix/i.test(e.ReleaseType || '')) continue;
    const app = toApp(e, exists);
    // The same product can be listed in both registry views: keep one
    const dupKey = `${app.name}|${app.version}`.toLowerCase();
    if (seen.has(dupKey)) continue;
    seen.add(dupKey);
    raw.set(app.id, e);
    apps.push(app);
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  return { apps, raw };
}

/** Split a registry command line into the program and its (verbatim) arguments. */
function splitCommand(command: string): { exe: string; args: string } {
  const s = command.trim();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return { exe: s.slice(1, end), args: s.slice(end + 1).trim() };
  }
  const m = /^(.*?\.(exe|com|bat|cmd))(\s+|$)(.*)$/i.exec(s);
  if (m) return { exe: m[1], args: m[4] };
  const i = s.indexOf(' ');
  return i < 0 ? { exe: s, args: '' } : { exe: s.slice(0, i), args: s.slice(i + 1) };
}

/** The repair command for an entry, or null if the program offers no repair. */
export function repairCommand(e: RawEntry): { exe: string; args: string } | null {
  const msi = e.WindowsInstaller === 1 && GUID.test(e.PSChildName || '');
  if (msi && e.NoRepair !== 1) return { exe: 'msiexec.exe', args: `/fa ${e.PSChildName}` };
  if (e.ModifyPath && e.NoModify !== 1) {
    const c = splitCommand(e.ModifyPath);
    // "MsiExec.exe /I{GUID}" opens the MSI maintenance dialog (Modify / Repair / Remove)
    return c;
  }
  return null;
}

class AppsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const wrap =
  (fn: (req: any) => Promise<unknown>) =>
  async (req: any, res: any) => {
    try {
      res.json(await fn(req));
    } catch (err: any) {
      const status = err instanceof AppsError ? err.status : 500;
      if (status === 500) console.error('Installed programs error:', err);
      res.status(status).json({ error: err.message || 'Error' });
    }
  };

export const appsRouter = Router();

appsRouter.get(
  '/',
  wrap(async () => {
    if (!isWin && !process.env.SCRIPTCRAFT_APPS_FIXTURE) return { supported: false, apps: [] };
    const { apps } = await listInstalledApps();
    return { supported: true, apps };
  })
);

/** Start the program's own repair. Only for an entry from a fresh listing; nothing is passed through a shell. */
appsRouter.post(
  '/:id/repair',
  wrap(async (req) => {
    const { raw } = await listInstalledApps();
    const entry = raw.get(String(req.params.id));
    if (!entry) throw new AppsError(404, 'Program not found (the list may have changed — refresh it)');
    const cmd = repairCommand(entry);
    if (!cmd) throw new AppsError(409, 'This program does not offer a repair. Reinstall it from the publisher.');
    if (process.env.SCRIPTCRAFT_APPS_DRYRUN === '1') return { started: false, dryRun: true, command: cmd };
    const child = spawn(cmd.exe, cmd.args ? [cmd.args] : [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true, // the registry's argument string, exactly as Windows would run it
    });
    child.on('error', () => {});
    child.unref();
    return { started: true, command: cmd };
  })
);

/** Open the program's install folder in Explorer. */
appsRouter.post(
  '/:id/open-folder',
  wrap(async (req) => {
    const { raw, apps } = await listInstalledApps();
    const app = apps.find((a) => a.id === String(req.params.id));
    if (!app || !raw.has(app.id)) throw new AppsError(404, 'Program not found');
    if (!app.location || !fs.existsSync(app.location)) throw new AppsError(409, 'The install folder does not exist');
    if (process.env.SCRIPTCRAFT_APPS_DRYRUN === '1') return { opened: false, dryRun: true, folder: app.location };
    const child = spawn('explorer.exe', [app.location], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return { opened: true, folder: app.location };
  })
);
