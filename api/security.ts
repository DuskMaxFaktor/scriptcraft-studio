import type { Request, Response, NextFunction } from 'express';

// The studio API can run arbitrary code, so it must only be reachable from the studio itself.
// Binding to 127.0.0.1 is not enough: with DNS rebinding a malicious website can make the browser
// send requests to 127.0.0.1 under its own domain name. So we also check Host / Origin headers.

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(hostHeader: string): string {
  // "[::1]:3000" -> "[::1]", "localhost:3000" -> "localhost"
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0];
}

function isLocalOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTNAMES.has(u.hostname);
  } catch {
    return false;
  }
}

export function localOnlyGuard(req: Request, res: Response, next: NextFunction) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!LOCAL_HOSTNAMES.has(hostnameOf(host))) {
    return res.status(403).json({ error: 'Forbidden: the studio API only accepts requests to localhost' });
  }

  // Browsers mark requests coming from other sites; reject them outright
  const fetchSite = String(req.headers['sec-fetch-site'] || '');
  if (fetchSite === 'cross-site') {
    return res.status(403).json({ error: 'Forbidden: cross-site request' });
  }

  // Any request that carries an Origin (all browser POSTs do) must come from the studio page itself:
  // same host AND port (the web preview runs on another port and must not reach the API)
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && (!isLocalOrigin(origin) || new URL(origin).host.toLowerCase() !== host)) {
    return res.status(403).json({ error: 'Forbidden: foreign origin' });
  }
  if (origin === 'null' && req.method !== 'GET') {
    return res.status(403).json({ error: 'Forbidden: opaque origin' });
  }
  next();
}
