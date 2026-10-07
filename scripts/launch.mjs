// Production launcher: install dependencies if needed, rebuild the UI only when sources changed,
// then start the server that serves the built UI and the API (much faster than the Vite dev server).
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const isWin = process.platform === 'win32';

const mtime = (p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/** Newest modification time of a file or of everything inside a folder. */
function newest(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let max = st.mtimeMs;
  for (const entry of fs.readdirSync(p)) max = Math.max(max, newest(path.join(p, entry)));
  return max;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin });
  if (r.status !== 0) {
    console.error(`\n[ERROR] "${cmd} ${args.join(' ')}" failed (exit code ${r.status}).`);
    process.exit(r.status || 1);
  }
}

// Portable build: dependencies and the UI are prepared in advance; never reinstall or rebuild
// (file times may change when the archive is unpacked)
// (a file with a unique name: Windows paths are case-insensitive, so "PORTABLE" would also match the portable\ output folder)
const portable = (() => {
  try {
    return fs.statSync('.portable-build').isFile();
  } catch {
    return false;
  }
})();

// 1. Dependencies: (re)install when package.json changed after the last install
const lock = path.join('node_modules', '.package-lock.json');
if (!fs.existsSync('node_modules') || (!portable && mtime('package.json') > mtime(lock))) {
  console.log('[INFO] Installing packages (npm install)... this can take a few minutes the first time.');
  run('npm', ['install', '--legacy-peer-deps', '--no-audit', '--no-fund']);
}

// 1b. Electron (own studio window, optional): download its binary if npm skipped the install script
const electronPkg = path.join('node_modules', 'electron');
if (fs.existsSync(path.join(electronPkg, 'install.js')) && !fs.existsSync(path.join(electronPkg, 'path.txt'))) {
  console.log('[INFO] Downloading the studio window (Electron)...');
  const r = spawnSync(process.execPath, [path.join(electronPkg, 'install.js')], { stdio: 'inherit' });
  if (r.status !== 0) console.log('[WARN] Electron download failed - the studio will open in Edge/Chrome instead.');
}

// 2. UI build: rebuild only if sources are newer than the last build
const builtAt = mtime(path.join('dist', 'index.html'));
const sourcesAt = Math.max(newest('src'), newest('public'), mtime('index.html'), mtime('vite.config.ts'), mtime('package.json'));
const canBuild = fs.existsSync(path.join('node_modules', 'vite'));
if (!builtAt && !canBuild) {
  console.error('[ERROR] The UI is not built and build tools are missing. Run "npm install" first.');
  process.exit(1);
}
if (!builtAt || (!portable && canBuild && sourcesAt > builtAt)) {
  console.log('[INFO] Building the studio UI (only after updates)...');
  run('npm', ['run', 'build']);
} else {
  console.log('[OK] UI build is up to date.');
}

// 3. Server
console.log('[INFO] Starting ScriptCraft Studio on http://localhost:3000 ...');
const server = spawn(process.execPath, [path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'server.ts'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
});
server.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));
