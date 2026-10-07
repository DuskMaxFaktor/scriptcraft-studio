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
