// powershell.exe started from a PowerShell 7 window: PowerShell 7's module folders are dropped from
// PSModulePath, so Windows PowerShell 5.1 finds its own commands again. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { windowsPowerShellModulePath, fixPowerShellModulePath } from '../api/winenv.ts';

// What pwsh 7 hands to the processes it starts: its folders first, then the system's
const fromPwsh = [
  'C:\\Users\\me\\Documents\\PowerShell\\Modules',
  'C:\\Program Files\\PowerShell\\Modules',
  'c:\\program files\\powershell\\7\\Modules',
  'C:\\Program Files\\WindowsPowerShell\\Modules',
  'C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules',
  'D:\\my\\modules',
].join(';');

test("PowerShell 7's folders go, Windows PowerShell's and the user's own stay", () => {
  assert.equal(
    windowsPowerShellModulePath(fromPwsh),
    'C:\\Program Files\\WindowsPowerShell\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules;D:\\my\\modules'
  );
  assert.equal(windowsPowerShellModulePath(''), '');
});

test('powershell.exe finds Get-FileHash again after the fix', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const run = (env: NodeJS.ProcessEnv) =>
    spawnSync('powershell', ['-NoProfile', '-Command', "(Get-FileHash -InputStream ([IO.MemoryStream]::new())).Hash"], { encoding: 'utf-8', windowsHide: true, env });
  const env = { ...process.env, PSModulePath: `${fromPwsh};${process.env.PSModulePath || ''}` };
  fixPowerShellModulePath(env);
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^E3B0C442/); // SHA-256 of nothing
});
