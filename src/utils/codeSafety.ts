// Programs run with the user's own rights. Before running code that does something hard to undo or typical
// of malware, the studio asks once more and says what it found. Not an antivirus: a second look at code
// pasted from the internet or written by the AI.

export type RiskKind =
  | 'deleteTree'
  | 'disk'
  | 'registry'
  | 'downloadExec'
  | 'shutdown'
  | 'defender'
  | 'secrets'
  | 'keylogger'
  | 'autostart'
  | 'inject'
  | 'encrypt'
  | 'elevate';

export interface Risk {
  kind: RiskKind;
  line: number;
  text: string;
}

const RULES: [RiskKind, RegExp][] = [
  // Deleting whole folders
  ['deleteTree', /\bshutil\.rmtree\s*\(|\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|Remove-Item\b[^\n]*-Recurse|\b(?:rd|rmdir)\s+\/s\b|\bdel\s+\/[a-z/ ]*s\b|fs\.(?:rmSync|rm|rmdirSync)\s*\([^)]*recursive\s*:\s*true|\bfs\.promises\.rm\s*\([^)]*recursive/i],
  // Disks: formatting, partitions, boot records
  ['disk', /\bformat(?:\.com)?\s+[a-z]:|\bdiskpart\b|\bbcdedit\b|\\\\\.\\PhysicalDrive|\bcipher\s+\/w/i],
  // Windows registry changes
  ['registry', /\bwinreg\.(?:SetValue|SetValueEx|DeleteKey|DeleteValue|CreateKey)|\breg(?:\.exe)?\s+(?:add|delete|import)\b|\b(?:Set|New|Remove)-ItemProperty\b[^\n]*HK(?:LM|CU)|\bRemove-Item\b[^\n]*HK(?:LM|CU):/i],
  // Download and run
  ['downloadExec', /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|curl|wget)\b[^\n|]*\|\s*(?:iex|Invoke-Expression|sh|bash|python)\b|\bInvoke-Expression\b|\biex\s*\(|\bexec\s*\(\s*(?:requests\.get|urllib\.request\.urlopen|urlopen)\b|\beval\s*\(\s*(?:await\s+)?\(?\s*(?:await\s+)?fetch\b|DownloadString\s*\(|\bcertutil\b[^\n]*-urlcache|\bbitsadmin\b[^\n]*\/transfer|\bmshta\b/i],
  // Shutting the PC down / logging off
  ['shutdown', /\bshutdown(?:\.exe)?\s+[/-][srlfp]\b|\bStop-Computer\b|\bRestart-Computer\b|os\.system\(\s*['"]shutdown|ExitWindowsEx/i],
  // Turning protection off
  ['defender', /\bSet-MpPreference\b|\bAdd-MpPreference\b[^\n]*Exclusion|DisableRealtimeMonitoring|\bnetsh\s+advfirewall\s+set\b[^\n]*off|\bvssadmin\b[^\n]*delete|\bwbadmin\b[^\n]*delete/i],
  // Browser passwords, cookies, wallets, Telegram sessions
  ['secrets', /Login Data|\bCookies\b[^\n]*(?:Chrome|Edge|User Data)|User Data[\\/]+Default|Local State[^\n]*encrypted_key|\bCryptUnprotectData\b|\bwallet\.dat\b|\\Exodus\\|\\Electrum\\|tdata[\\/]|\bkey4\.db\b|\blogins\.json\b/i],
  // Recording keys / the screen in the background
  ['keylogger', /\bpynput\.keyboard\b[^\n]*Listener|\bkeyboard\.Listener\s*\(|\bGetAsyncKeyState\b|\bSetWindowsHookEx(?:A|W)?\b|\bkeyboard\.on_press\b|\bkeyboard\.hook\s*\(/i],
  // Starting by itself with Windows
  ['autostart', /CurrentVersion\\+Run\b|\\Start Menu\\Programs\\Startup|shell:startup|\bschtasks\b[^\n]*\/create|\bRegister-ScheduledTask\b|\bNew-Service\b|\bsc(?:\.exe)?\s+create\b/i],
  // Writing into other programs' memory
  ['inject', /\bWriteProcessMemory\b|\bCreateRemoteThread\b|\bVirtualAllocEx\b|\bNtUnmapViewOfSection\b|\bQueueUserAPC\b/],
  // Encrypting files in bulk (ransomware pattern): a cipher together with walking folders
  ['encrypt', /(?=[\s\S]*\b(?:Fernet|AES\.new|Cipher\s*\(|createCipheriv)\b)(?=[\s\S]*\b(?:os\.walk|glob\.glob\([^)]*\*\*|Path\([^)]*\)\.rglob|readdirSync\([^)]*recursive|fs\.readdir)\b)[\s\S]*?\b(?:Fernet|AES\.new|Cipher\s*\(|createCipheriv)\b/],
  // Asking for administrator rights
  ['elevate', /ShellExecute(?:W|A|Ex)?\s*\([^)]*['"]runas['"]|-Verb\s+RunAs\b|\brunas\s+\/user/i],
];

/** Lines of the code that match a rule, at most 3 per kind. */
export function findRisks(code: string): Risk[] {
  const risks: Risk[] = [];
  const lines = code.split('\n');
  for (const [kind, re] of RULES) {
    if (kind === 'encrypt') {
      // Needs the whole file (cipher + folder walk can be far apart)
      const m = re.exec(code);
      if (m) {
        const line = code.slice(0, m.index + m[0].length).split('\n').length;
        risks.push({ kind, line, text: lines[line - 1].trim().slice(0, 160) });
      }
      continue;
    }
    let n = 0;
    for (let i = 0; i < lines.length && n < 3; i++) {
      const l = lines[i];
      // Comments are not code (# / // / REM / ::)
      if (/^\s*(#|\/\/|REM\b|::)/i.test(l)) continue;
      if (re.test(l)) {
        risks.push({ kind, line: i + 1, text: l.trim().slice(0, 160) });
        n++;
      }
    }
  }
  return risks.sort((a, b) => a.line - b.line);
}

// Remembers code the user already allowed (by content), so the same file is not questioned on every run
const ALLOWED_KEY = 'scriptcraft-allowed-risky';

async function digest(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function isAllowed(code: string): Promise<boolean> {
  try {
    const list: string[] = JSON.parse(localStorage.getItem(ALLOWED_KEY) || '[]');
    return list.includes(await digest(code));
  } catch {
    return false;
  }
}

export async function rememberAllowed(code: string) {
  try {
    const list: string[] = JSON.parse(localStorage.getItem(ALLOWED_KEY) || '[]');
    const d = await digest(code);
    if (!list.includes(d)) localStorage.setItem(ALLOWED_KEY, JSON.stringify([d, ...list].slice(0, 200)));
  } catch {
    /* private window: ask again next time */
  }
}
