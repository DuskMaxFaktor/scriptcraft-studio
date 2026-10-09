// Studio server for the UI tests: runs in a fresh temporary folder (projects, settings, keys),
// so tests never see or change the user's real data. Started by playwright.config.ts.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const studioRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptcraft-ui-'));
process.chdir(tmp);
// No local models: tests must not depend on what is installed on this PC
// Backups: never into the real Documents folder, no automatic runs
fs.writeFileSync(
  'settings.json',
  JSON.stringify({ ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434' }, backups: { enabled: false, keep: 7, dir: path.join(tmp, 'backups') } })
);

// GitHub: a fake GitHub CLI, so UI tests never create repositories in a real account
process.env.SCRIPTCRAFT_GH_SCRIPT = path.join(studioRoot, 'tests', 'fixtures', 'fake-gh.mjs');
process.env.FAKE_GH_LOGGED = '1';
process.env.FAKE_GH_REMOTES = path.join(tmp, 'remotes');
fs.mkdirSync(process.env.FAKE_GH_REMOTES);

// Installed programs: a fixed fake list, and repairs only report their command — never touch the real PC
const appsFixture = path.join(tmp, 'apps.json');
fs.writeFileSync(
  appsFixture,
  JSON.stringify([
    { DisplayName: 'Test App', DisplayVersion: '1.2.3', Publisher: 'Test Inc', EstimatedSize: 10240, WindowsInstaller: 1, PSChildName: '{11111111-2222-3333-4444-555555555555}', Hive: 'HKLM' },
    { DisplayName: 'Broken Tool', Publisher: 'Nobody', UninstallString: `"${path.join(tmp, 'missing', 'uninst.exe')}"`, NoRepair: 1, PSChildName: 'Broken', Hive: 'HKCU' },
  ])
);
process.env.SCRIPTCRAFT_APPS_FIXTURE = appsFixture;
process.env.SCRIPTCRAFT_APPS_DRYRUN = '1';

const cleanup = () => {
  try {
    process.chdir(os.tmpdir());
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // files may still be in use; the OS cleans its temp folder
  }
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));

await import(pathToFileURL(path.join(studioRoot, 'server.ts')).href);
