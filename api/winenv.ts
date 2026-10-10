// Windows PowerShell 5.1 (powershell.exe) next to PowerShell 7 (pwsh).
// pwsh puts its own module folders first in PSModulePath, and every process it starts inherits that.
// The studio started from a pwsh window (Windows Terminal, "npm start", GitHub Actions) then runs
// powershell.exe — the terminal, "Programs on PC", the Documents lookup, the build scripts — with
// pwsh's modules first, and 5.1 fails on its own basic commands ("Get-FileHash is not recognized").
// Dropping pwsh's folders lets 5.1 use its own again; everything else in PSModulePath stays.

/** PSModulePath without PowerShell 7's folders (…\PowerShell\Modules, …\PowerShell\7\Modules). */
export function windowsPowerShellModulePath(value: string): string {
  return value
    .split(';')
    .filter((p) => p && !/[\\/]PowerShell[\\/](\d[^\\/]*[\\/])?Modules[\\/]?$/i.test(p))
    .join(';');
}

/** Fix this process's PSModulePath once, so every powershell.exe it starts works. */
export function fixPowerShellModulePath(env: NodeJS.ProcessEnv = process.env) {
  if (process.platform !== 'win32' || !env.PSModulePath) return;
  env.PSModulePath = windowsPowerShellModulePath(env.PSModulePath);
}
