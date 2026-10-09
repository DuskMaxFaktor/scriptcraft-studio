// "Programs on this PC": listing, health check and repair commands.
// A fixture replaces the registry and repairs run in dry-run mode, so the real PC is never touched.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-apps-'));
const MSI = '{12345678-ABCD-1234-ABCD-1234567890AB}';
let server: import('http').Server;
let base = '';

async function api(method: string, url: string) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' } });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

before(async () => {
  const appDir = path.join(tmp, 'Good App');
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'good.exe'), '');
  const setup = path.join(tmp, 'setup.exe');
  fs.writeFileSync(setup, '');
  const fixture = [
    // MSI package, healthy, repairable with msiexec
    { DisplayName: 'Good App', DisplayVersion: '2.1', Publisher: 'Good Inc', InstallDate: '20260115', EstimatedSize: 20480, InstallLocation: appDir, DisplayIcon: `${path.join(appDir, 'good.exe')},0`, UninstallString: `MsiExec.exe /X${MSI}`, WindowsInstaller: 1, PSChildName: MSI, Hive: 'HKLM' },
    // the same product in the 32-bit registry view: shown once
    { DisplayName: 'Good App', DisplayVersion: '2.1', WindowsInstaller: 1, PSChildName: MSI, Hive: 'HKLM32' },
    // own setup in modify mode; its folder was deleted
    { DisplayName: 'Модный редактор', DisplayVersion: '5', InstallLocation: path.join(tmp, 'gone'), ModifyPath: `"${setup}" /modify`, UninstallString: `"${setup}" /uninstall`, PSChildName: 'ModEditor', Hive: 'HKLM' },
    // no repair offered, uninstaller is missing (a broken entry)
    { DisplayName: 'Broken Tool', NoRepair: 1, NoModify: 1, UninstallString: `"${path.join(tmp, 'nope', 'uninst.exe')}"`, PSChildName: 'Broken', Hive: 'HKCU' },
    // hidden from "Programs and Features": system components and updates
    { DisplayName: 'Hidden Runtime', SystemComponent: 1, PSChildName: 'Hidden', Hive: 'HKLM' },
    { DisplayName: 'Security Update KB1', ParentKeyName: 'Good App', PSChildName: 'KB1', Hive: 'HKLM' },
  ];
  const file = path.join(tmp, 'apps.json');
  fs.writeFileSync(file, JSON.stringify(fixture));
  process.env.SCRIPTCRAFT_APPS_FIXTURE = file;
  // What "winget upgrade" prints (with the progress spinner it draws before the table)
  const winget = path.join(tmp, 'winget.txt');
  fs.writeFileSync(
    winget,
    '   - \r   \\ \r' +
      'Name                 Id                 Version Available Source\r\n' +
      '------------------------------------------------------------------\r\n' +
      'Good App             Good.App           2.1     2.2       winget\r\n' +
      'Модный редактор      Mod.Editor         5       6.0.1     winget\r\n' +
      '2 upgrades available.\r\n'
  );
  process.env.SCRIPTCRAFT_WINGET_FIXTURE = winget;
  process.env.SCRIPTCRAFT_APPS_DRYRUN = '1';

  process.chdir(tmp);
  const express = (await import('express')).default;
  const { apiRouter } = await import(pathToFileURL(path.join(studioRoot, 'api', 'router.ts')).href);
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  delete process.env.SCRIPTCRAFT_APPS_FIXTURE;
  delete process.env.SCRIPTCRAFT_APPS_DRYRUN;
  delete process.env.SCRIPTCRAFT_WINGET_FIXTURE;
  server?.close();
  process.chdir(studioRoot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('installed programs: listed like "Programs and Features", with a health check', async () => {
  const { data } = await api('GET', '/api/apps');
  assert.equal(data.supported, true);
  const byName = Object.fromEntries(data.apps.map((a: any) => [a.name, a]));
  assert.deepEqual(Object.keys(byName).sort(), ['Broken Tool', 'Good App', 'Модный редактор']); // no system components, updates or duplicates

  const good = byName['Good App'];
  assert.equal(good.version, '2.1');
  assert.equal(good.installDate, '2026-01-15');
  assert.equal(good.sizeMB, 20);
  assert.equal(good.msi, true);
  assert.equal(good.repair, 'msi');
  assert.deepEqual(good.problems, []);

  assert.equal(byName['Модный редактор'].repair, 'modify');
  assert.deepEqual(byName['Модный редактор'].problems, ['folder-missing']);

  assert.equal(byName['Broken Tool'].repair, null);
  assert.equal(byName['Broken Tool'].scope, 'user');
  assert.deepEqual(byName['Broken Tool'].problems, ['uninstaller-missing']);
});

test('repair: msiexec /fa for MSI, the own setup for others, refused when not offered', async () => {
  const { data } = await api('GET', '/api/apps');
  const id = (name: string) => data.apps.find((a: any) => a.name === name).id;

  const msi = await api('POST', `/api/apps/${id('Good App')}/repair`);
  assert.equal(msi.status, 200);
  assert.deepEqual(msi.data.command, { exe: 'msiexec.exe', args: `/fa ${MSI}` });
  assert.equal(msi.data.dryRun, true);

  const mod = await api('POST', `/api/apps/${id('Модный редактор')}/repair`);
  assert.deepEqual(mod.data.command, { exe: path.join(tmp, 'setup.exe'), args: '/modify' });

  assert.equal((await api('POST', `/api/apps/${id('Broken Tool')}/repair`)).status, 409);
  assert.equal((await api('POST', '/api/apps/0000000000000000/repair')).status, 404);
});

test('open folder: only when the install folder exists', async () => {
  const { data } = await api('GET', '/api/apps');
  const id = (name: string) => data.apps.find((a: any) => a.name === name).id;
  const ok = await api('POST', `/api/apps/${id('Good App')}/open-folder`);
  assert.equal(ok.data.folder, path.join(tmp, 'Good App'));
  assert.equal((await api('POST', `/api/apps/${id('Модный редактор')}/open-folder`)).status, 409);
});

test('updates: the winget table is parsed (localized header too), install only a listed id', async () => {
  const { parseWingetUpgrade } = await import(pathToFileURL(path.join(studioRoot, 'api', 'apps.ts')).href);
  const ru = [
    'Имя        ИД            Версия Доступно Источник',
    '---------------------------------------------------',
    'Программа  Some.Program  1.0    1.1      winget',
    '',
  ].join('\n');
  assert.deepEqual(parseWingetUpgrade(ru), [{ name: 'Программа', id: 'Some.Program', version: '1.0', available: '1.1', source: 'winget' }]);
  assert.deepEqual(parseWingetUpgrade('No installed package found matching input criteria.'), []);

  const { data } = await api('GET', '/api/apps/updates');
  assert.equal(data.available, true);
  assert.deepEqual(
    data.updates.map((u: any) => [u.name, u.id, u.version, u.available]),
    [
      ['Good App', 'Good.App', '2.1', '2.2'],
      ['Модный редактор', 'Mod.Editor', '5', '6.0.1'],
    ]
  );
  const ok = await api('POST', '/api/apps/updates/Good.App/install');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.command.args.slice(0, 4), ['upgrade', '--id', 'Good.App', '--exact']);
  assert.equal((await api('POST', '/api/apps/updates/Not.Listed/install')).status, 404);
});
