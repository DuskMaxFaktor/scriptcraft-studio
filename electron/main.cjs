// ScriptCraft Studio's own window (Electron). The server is started separately (ScriptCraftStudio.exe or
// start_studio.bat); this process only shows its UI: electron.exe electron\main.cjs [--url=http://localhost:3000]
const { app, BrowserWindow, Menu, shell, session } = require('electron');
const fs = require('fs');
const path = require('path');

const urlArg = process.argv.find((a) => a.startsWith('--url='));
const START_URL = urlArg ? urlArg.slice(6) : 'http://localhost:3000';
const ORIGIN = new URL(START_URL).origin;
const ROOT = path.resolve(__dirname, '..');

app.setName('ScriptCraft Studio');
app.setPath('userData', path.join(app.getPath('appData'), 'ScriptCraft Studio'));
if (process.platform === 'win32') app.setAppUserModelId('ScriptCraftStudio');

// One window: a second launch (tray "Open", the exe again) focuses the existing one
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let win = null;
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (s && s.width >= 600 && s.height >= 400) return s;
  } catch {}
  return { width: 1360, height: 860 };
}

function saveState() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized(), zoom: win.webContents.getZoomFactor() }));
  } catch {}
}

const isStudioUrl = (u) => {
  try {
    return new URL(u).origin === ORIGIN;
  } catch {
    return false;
  }
};

/** Links to anything else (web preview "open in browser", links in the chat) go to the system browser. */
function openOutside(u) {
  try {
    const p = new URL(u).protocol;
    if (p === 'http:' || p === 'https:' || p === 'mailto:') shell.openExternal(u);
  } catch {}
}

function createWindow() {
  const state = loadState();
  win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: 'ScriptCraft Studio',
    icon: path.join(ROOT, 'app.ico'),
    backgroundColor: '#0f1115',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  const wc = win.webContents;
  if (state.zoom) wc.setZoomFactor(state.zoom);
  wc.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!isStudioUrl(url)) {
      e.preventDefault();
      openOutside(url);
    }
  });

  // The server may still be starting: show a short note and retry
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */) return;
    wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<body style="background:#0f1115;color:#9aa4b2;font:15px system-ui;display:grid;place-items:center;height:90vh">' +
      'ScriptCraft Studio запускается…</body>'));
    setTimeout(() => !win.isDestroyed() && wc.loadURL(START_URL), 1000);
  });

  // No menu bar; keep a few useful shortcuts (F5 and the like belong to the studio itself)
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (input.key === 'F12' || (ctrl && input.shift && key === 'i')) wc.toggleDevTools();
    else if (ctrl && input.shift && key === 'r') wc.reloadIgnoringCache();
    else if (input.key === 'F11') return;
    else if (ctrl && (key === '=' || key === '+')) wc.setZoomFactor(Math.min(wc.getZoomFactor() + 0.1, 3));
    else if (ctrl && key === '-') wc.setZoomFactor(Math.max(wc.getZoomFactor() - 0.1, 0.5));
    else if (ctrl && key === '0') wc.setZoomFactor(1);
    else return;
    e.preventDefault();
  });

  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, () => {
    clearTimeout(win.saveTimer);
    win.saveTimer = setTimeout(saveState, 500);
  });
  win.on('close', saveState);
  win.on('closed', () => (win = null));

  wc.loadURL(START_URL);
}

app.on('second-instance', () => {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // Only what the studio needs: clipboard (copy buttons) and fullscreen; everything else is refused
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) =>
    cb(allowed.has(permission) && isStudioUrl(details.requestingUrl || wc.getURL())));
  createWindow();
});

app.on('window-all-closed', () => app.quit());
