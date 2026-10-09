// The Windows installer (installer/Setup.cs, built by make_installer.ps1) on a tiny fake package:
// install over an older version keeps the user's data, uninstall removes the program (and the data on request).
// Registry and shortcuts go to test locations (HKCU\Software\ScriptCraftStudioTest-*, a temp folder).
// Run with: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const isWin = process.platform === 'win32';
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const skip = !isWin ? 'Windows only' : !fs.existsSync(csc) ? 'csc.exe not found' : false;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-installer-'));
const regKey = `Software\\ScriptCraftStudioTest-${process.pid}`;

after(() => {
  if (isWin) spawnSync('reg', ['delete', `HKCU\\${regKey}`, '/f'], { windowsHide: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const write = (p: string, s: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
};
const regValue = (name: string) => {
  // PowerShell in UTF-8 (reg.exe prints in the console code page: Cyrillic paths come out garbled)
  const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $v = (Get-ItemProperty -Path 'HKCU:\\${regKey}' -ErrorAction SilentlyContinue).'${name}'; if ($null -ne $v) { [Console]::Write($v) } else { exit 3 }`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf-8', windowsHide: true });
  return r.status === 0 ? r.stdout : null;
};
async function waitFor(check: () => boolean, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out');
}

test('installer: installs, updates over user data, uninstalls', { skip, timeout: 180_000 }, async () => {
  // Package: what make_portable.ps1 zips (one top folder)
  const pkg = path.join(tmp, 'pkg', 'ScriptCraftStudio');
  write(path.join(pkg, 'api', 'new.txt'), 'v2');
  write(path.join(pkg, '.env'), 'TEMPLATE');
  write(path.join(pkg, '.portable-build'), 'portable');
  fs.copyFileSync(path.join(process.env.WINDIR!, 'System32', 'where.exe'), path.join(pkg, 'ScriptCraftStudio.exe'));
  const zip = path.join(tmp, 'pkg.zip');
  assert.equal(spawnSync(path.join(process.env.WINDIR!, 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', path.join(tmp, 'pkg'), 'ScriptCraftStudio']).status, 0);
  const setup = path.join(tmp, 'Setup.exe');
  const build = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'make_installer.ps1', '-Zip', zip, '-Out', setup], { encoding: 'utf-8', windowsHide: true });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  // The checksum file the auto-update verifies
  const sha = fs.readFileSync(setup + '.sha256', 'utf-8');
  assert.match(sha, /^[0-9a-f]{64} {2}Setup\.exe$/);

  // An older install with the user's data
  const app = path.join(tmp, 'Мои программы', 'Studio');
  write(path.join(app, 'api', 'old.txt'), 'v1');
  write(path.join(app, '.env'), 'GEMINI_API_KEY=mine');
  write(path.join(app, 'projects', 'p1', 'main.py'), 'print(1)');
  write(path.join(app, '.installed'), '1.0.0');
  const links = path.join(tmp, 'links');

  const inst = spawnSync(setup, ['/S', `/D=${app}`, `/regkey=${regKey}`, `/shortcutdir=${links}`], { windowsHide: true, timeout: 120_000 });
  assert.equal(inst.status, 0);
  assert.equal(fs.existsSync(path.join(app, 'api', 'old.txt')), false, 'old program files are replaced');
  assert.equal(fs.readFileSync(path.join(app, 'api', 'new.txt'), 'utf-8'), 'v2');
  assert.equal(fs.readFileSync(path.join(app, '.env'), 'utf-8'), 'GEMINI_API_KEY=mine', 'keys are kept');
  assert.equal(fs.readFileSync(path.join(app, 'projects', 'p1', 'main.py'), 'utf-8'), 'print(1)');
  // The "ready-made build" marker stays: without it the launcher would run npm install
  assert.ok(fs.existsSync(path.join(app, '.portable-build')));
  assert.equal(fs.readFileSync(path.join(app, '.installed'), 'utf-8'), JSON.parse(fs.readFileSync('package.json', 'utf-8')).version);
  assert.ok(fs.existsSync(path.join(app, 'Uninstall.exe')));
  assert.ok(fs.statSync(path.join(app, 'Uninstall.exe')).size < fs.statSync(setup).size, 'the uninstaller has no payload');
  assert.ok(fs.existsSync(path.join(links, 'ScriptCraft Studio.lnk')));
  assert.equal(regValue('DisplayName'), 'ScriptCraft Studio');
  assert.equal(regValue('InstallLocation'), app);

  // Uninstall, keeping the user's data
  spawnSync(path.join(app, 'Uninstall.exe'), ['/S', `/regkey=${regKey}`, `/shortcutdir=${links}`], { windowsHide: true });
  await waitFor(() => !fs.existsSync(path.join(app, 'Uninstall.exe')) && regValue('DisplayName') === null);
  assert.deepEqual(fs.readdirSync(app).sort(), ['.env', 'projects']);
  assert.equal(fs.existsSync(path.join(links, 'ScriptCraft Studio.lnk')), false);

  // Install again, then uninstall with the data
  assert.equal(spawnSync(setup, ['/S', `/D=${app}`, `/regkey=${regKey}`, '/noshortcuts'], { windowsHide: true, timeout: 120_000 }).status, 0);
  spawnSync(path.join(app, 'Uninstall.exe'), ['/S', '/deletedata', `/regkey=${regKey}`], { windowsHide: true });
  await waitFor(() => !fs.existsSync(app));
  assert.equal(regValue('DisplayName'), null);
});
