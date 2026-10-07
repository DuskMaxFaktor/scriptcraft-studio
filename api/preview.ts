import express, { Router } from 'express';
import fs from 'fs';
import path from 'path';
import type { Server } from 'http';

// Live web preview: the project's files are served like a small website at /preview/<projectId>/<path>,
// so links between pages, <link>/<script src> and fetch() of project files work as in a real browser.
// Static files only - nothing here runs on the server. It is served on its OWN port (studio port + 1),
// i.e. a different browser origin: preview pages cannot call the studio API, yet fetch(), ES modules
// and localStorage work normally inside them.

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml',
  xml: 'application/xml; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  wasm: 'application/wasm',
};

/** Sends console output and errors of the preview page to the studio terminal; reports the current page;
 *  takes the studio's theme for the scrollbars (only their colours: the page's own design is untouched). */
const BRIDGE = `<script>
(function () {
  var send = function (type, args) {
    try {
      var text = Array.prototype.map.call(args, function (a) {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
        return String(a);
      }).join(' ');
      parent.postMessage({ source: 'scriptcraft-preview', type: type, message: text }, '*');
    } catch (e) {}
  };
  ['log', 'info', 'warn', 'error'].forEach(function (k) {
    var orig = console[k];
    console[k] = function () { orig.apply(console, arguments); send(k === 'log' ? 'log' : k, arguments); };
  });
  window.addEventListener('error', function (e) { send('error', [e.message + ' (' + (e.filename || '').split('/').pop() + ':' + e.lineno + ')']); });
  window.addEventListener('unhandledrejection', function (e) { send('error', ['Unhandled promise rejection: ' + (e.reason && e.reason.message || e.reason)]); });
  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data || e.data.source !== 'scriptcraft-studio' || e.data.type !== 'theme') return;
    var style = document.getElementById('__scriptcraft_scrollbars');
    if (!style) {
      style = document.createElement('style');
      style.id = '__scriptcraft_scrollbars';
      (document.head || document.documentElement).appendChild(style);
    }
    // The studio's own scrollbar colours (thumb, track) and thin bars without arrows; :where() keeps the page's own rules stronger
    var c = e.data.theme === 'light' ? '#cbd5e1 #f1f4f8' : '#334155 #0f141c';
    style.textContent = ':where(html, html *){scrollbar-color:' + c + ';scrollbar-width:thin}';
  });
  parent.postMessage({ source: 'scriptcraft-preview', type: 'location', message: location.pathname }, '*');
})();
</script>`;

function safeRel(p: string): string | null {
  const parts = p.split('/').filter(Boolean);
  if (parts.some((s) => s === '..' || s.startsWith('.'))) return null; // no traversal, no service files/folders
  return parts.join('/');
}

export const previewRouter = Router();

previewRouter.get(/^\/([a-zA-Z0-9_-]{1,80})(?:\/(.*))?$/, (req, res) => {
  // Same DNS-rebinding protection as the API: only answer requests addressed to localhost
  const host = String(req.headers.host || '').toLowerCase();
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  if (!LOCAL_HOSTNAMES.has(hostname)) return res.status(403).send('Forbidden');

  const projectId = (req.params as any)[0] as string;
  let rel = safeRel(decodeURIComponent(((req.params as any)[1] as string) || ''));
  if (rel === null) return res.status(400).send('Bad path');

  const root = path.join(process.cwd(), 'projects', projectId);
  if (!fs.existsSync(root)) return res.status(404).send('Project not found');
  let file = path.join(root, rel);
  if (rel === '' || (fs.existsSync(file) && fs.statSync(file).isDirectory())) {
    file = path.join(file, 'index.html');
    rel = path.relative(root, file).replace(/\\/g, '/');
  }
  if (!path.resolve(file).startsWith(path.resolve(root) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return res
      .status(404)
      .type('html')
      .send(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;color:#555;padding:24px">404: <code>${rel.replace(/[<>&]/g, '')}</code> — no such file in the project</body>`);
  }

  const ext = file.split('.').pop()?.toLowerCase() || '';
  res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store'); // always the latest saved version
  if (ext === 'html' || ext === 'htm') {
    const html = fs.readFileSync(file, 'utf-8');
    // The bridge must run before the page's own scripts
    const withBridge = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + BRIDGE) : BRIDGE + html;
    return res.send(withBridge);
  }
  fs.createReadStream(file).pipe(res);
});

let previewPort = 0;
let previewServer: Server | null = null;

/** Port of the preview server (0 if it is not running). */
export const getPreviewPort = () => previewPort;

/** Start the preview server on the first free port after the studio port. */
export function startPreviewServer(studioPort: number): Promise<number> {
  if (previewServer) return Promise.resolve(previewPort);
  const app = express();
  app.use('/preview', previewRouter);
  return new Promise((resolve) => {
    const tryPort = (port: number, attempts: number) => {
      const srv = app.listen(port, '127.0.0.1');
      srv.once('listening', () => {
        previewServer = srv;
        previewPort = port;
        resolve(port);
      });
      srv.once('error', () => {
        if (attempts > 0) tryPort(port + 1, attempts - 1);
        else resolve(0);
      });
    };
    tryPort(studioPort + 1, 10);
  });
}

/** Stop the preview server (used by tests). */
export function stopPreviewServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!previewServer) return resolve();
    previewServer.close(() => resolve());
    previewServer.closeAllConnections?.();
    previewServer = null;
    previewPort = 0;
  });
}
