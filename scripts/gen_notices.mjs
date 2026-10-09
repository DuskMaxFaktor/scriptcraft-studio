// Lists the licenses of everything ScriptCraft Studio ships:
//   - npm packages inside the built interface (dist/bundled-packages.json, written by the Vite build),
//   - npm packages the server needs (package-lock.json entries that are not dev-only),
//   - the bundled runtimes (Node.js, Python) and the pip packages installed into runtime\python.
// Writes THIRD_PARTY_NOTICES.md (summary), THIRD_PARTY_LICENSES.txt (full texts, identical texts once)
// and THIRD_PARTY.json (for the "Licenses and data" tab of the About window).
// Usage: node scripts/gen_notices.mjs [--root <folder with node_modules, dist, runtime>] [--out <folder>]
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const SRC = path.resolve('.');
const ROOT = path.resolve(arg('--root') || '.');
const OUT = path.resolve(arg('--out') || ROOT);

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
};
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

function licenseTexts(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => LICENSE_FILE.test(n));
  } catch {
    return [];
  }
  return names
    .map((n) => read(path.join(dir, n)))
    .filter(Boolean)
    .map((t) => t.replace(/\r\n/g, '\n').trim());
}

const items = new Map(); // key name@version -> item
function add(item) {
  const key = `${item.name}@${item.version}`;
  const prev = items.get(key);
  if (prev) {
    for (const s of item.sources) if (!prev.sources.includes(s)) prev.sources.push(s);
    return;
  }
  items.set(key, item);
}

// ---------- npm ----------
const lock = JSON.parse(read(path.join(SRC, 'package-lock.json')) || '{"packages":{}}');
const bundled = new Set(JSON.parse(read(path.join(ROOT, 'dist', 'bundled-packages.json')) || read(path.join(SRC, 'dist', 'bundled-packages.json')) || '[]'));
if (!bundled.size) console.warn('[WARN] dist/bundled-packages.json not found: run "npm run build" first');

for (const [key, entry] of Object.entries(lock.packages || {})) {
  if (!key.startsWith('node_modules/')) continue;
  const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const inUi = bundled.has(name);
  const onServer = !entry.dev;
  if (!inUi && !onServer) continue;
  // Server packages: only what is really there (optional packages for other systems are not installed)
  const dir = [path.join(ROOT, key), path.join(SRC, key)].find((d) => fs.existsSync(path.join(d, 'package.json')));
  if (!dir && !inUi) continue;
  const pkg = dir ? JSON.parse(read(path.join(dir, 'package.json')) || '{}') : {};
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  add({
    name,
    version: entry.version || pkg.version || '?',
    license: entry.license || (typeof pkg.license === 'string' ? pkg.license : pkg.license?.type) || 'see package',
    homepage: (pkg.homepage || repo || `https://www.npmjs.com/package/${name}`).replace(/^git\+/, '').replace(/\.git$/, ''),
    sources: [inUi ? 'interface' : 'server'],
    texts: dir ? licenseTexts(dir) : [],
  });
  const it = items.get(name + '@' + (entry.version || pkg.version || '?'));
  if (it && it.license === 'see package' && it.texts.some((t) => /Permission is hereby granted, free of charge/.test(t))) it.license = 'MIT';
}

// Electron ships Chromium and its many components: their notices come with it
const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
const chromiumNotes = fs.existsSync(path.join(electronDist, 'LICENSES.chromium.html')) ? 'node_modules/electron/dist/LICENSES.chromium.html' : null;

// ---------- runtimes ----------
const nodeDir = path.join(ROOT, 'runtime', 'node');
if (fs.existsSync(nodeDir)) {
  const version = (fs.readdirSync(nodeDir).length && read(path.join(nodeDir, 'CHANGELOG.md'))?.match(/# Node\.js ([\d.]+)/)?.[1]) || '';
  add({ name: 'Node.js', version: version || 'bundled', license: 'MIT and others (see text)', homepage: 'https://nodejs.org', sources: ['runtime'], texts: licenseTexts(nodeDir) });
}
const pyDir = path.join(ROOT, 'runtime', 'python');
if (fs.existsSync(pyDir)) {
  const ver = fs.readdirSync(pyDir).find((n) => /^python3\d+\.zip$/.test(n));
  add({ name: 'Python', version: ver ? `3.${ver.slice(7, -4)}` : 'bundled', license: 'PSF-2.0', homepage: 'https://www.python.org', sources: ['runtime'], texts: licenseTexts(pyDir) });
  const site = path.join(pyDir, 'Lib', 'site-packages');
  for (const d of fs.existsSync(site) ? fs.readdirSync(site).filter((n) => n.endsWith('.dist-info')) : []) {
    const meta = read(path.join(site, d, 'METADATA')) || '';
    const field = (f) => meta.match(new RegExp(`^${f}: (.+)$`, 'm'))?.[1]?.trim();
    const classifier = [...meta.matchAll(/^Classifier: License :: (?:OSI Approved :: )?(.+)$/gm)].map((m) => m[1]).join(', ');
    let license = field('License-Expression') || field('License') || classifier || 'see package';
    if (license.length > 80) license = classifier || license.split('\n')[0].slice(0, 80);
    const texts = [...licenseTexts(path.join(site, d)), ...licenseTexts(path.join(site, d, 'licenses'))];
    add({
      name: field('Name') || d.replace(/-[^-]+\.dist-info$/, ''),
      version: field('Version') || '?',
      license,
      homepage: field('Home-page') || meta.match(/^Project-URL: [^,]*(?:Home|Source|Repository)[^,]*, (.+)$/im)?.[1] || `https://pypi.org/project/${field('Name')}`,
      sources: ['runtime (pip)'],
      texts,
    });
  }
}

// ---------- output ----------
const list = [...items.values()].sort((a, b) => a.name.localeCompare(b.name));
const byLicense = new Map();
for (const it of list) byLicense.set(it.license, (byLicense.get(it.license) || 0) + 1);

const copyleft = list.filter((it) => /\b(L?GPL|AGPL|MPL|EPL|GNU)\b/i.test(it.license) && !/^\(?MIT OR/i.test(it.license) && !/MPL-2\.0 OR Apache/i.test(it.license));
const md = [
  '# Сторонние компоненты / Third-party components',
  '',
  'ScriptCraft Studio включает компоненты с открытым исходным кодом. Полные тексты лицензий — в [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).',
  'ScriptCraft Studio includes open-source components. Full license texts are in THIRD_PARTY_LICENSES.txt.',
  '',
  chromiumNotes ? `The studio window (Electron) contains Chromium; its component notices are in \`${chromiumNotes}\`.` : '',
  '',
  `Всего / Total: ${list.length}`,
  '',
  '| Лицензия / License | Компонентов |',
  '|---|---|',
  ...[...byLicense].sort((a, b) => b[1] - a[1]).map(([l, n]) => `| ${l} | ${n} |`),
  '',
  ...(copyleft.length
    ? [
        '## Копилефт / Copyleft',
        '',
        'Эти компоненты распространяются без изменений; их исходный код доступен по ссылкам. / These components are distributed unmodified; their source code is available at the links.',
        '',
        ...copyleft.map((it) => `- ${it.name} ${it.version} — ${it.license} — ${it.homepage}`),
        '',
      ]
    : []),
  '| Компонент | Версия | Лицензия | Где | Сайт |',
  '|---|---|---|---|---|',
  ...list.map((it) => `| ${it.name} | ${it.version} | ${it.license} | ${it.sources.join(', ')} | ${it.homepage} |`),
  '',
].join('\n');

// Identical license texts (hundreds of MIT files differ only in the copyright line) are kept per package,
// but byte-identical ones are written once with the list of packages that use them
const groups = new Map();
for (const it of list) {
  const texts = it.texts.length ? it.texts : [`(The package has no license file. License: ${it.license}. Source: ${it.homepage})`];
  for (const t of texts) {
    const h = crypto.createHash('sha1').update(t).digest('hex');
    if (!groups.has(h)) groups.set(h, { text: t, users: [] });
    groups.get(h).users.push(`${it.name} ${it.version}`);
  }
}
const txt = [
  'Third-party licenses of ScriptCraft Studio',
  '='.repeat(42),
  '',
  ...[...groups.values()].map((g) => `${'-'.repeat(78)}\n${g.users.join(', ')}\n${'-'.repeat(78)}\n\n${g.text}\n`),
].join('\n');

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'THIRD_PARTY_NOTICES.md'), md, 'utf-8');
fs.writeFileSync(path.join(OUT, 'THIRD_PARTY_LICENSES.txt'), txt, 'utf-8');
const json = list.map(({ texts, ...rest }) => ({ ...rest, hasText: texts.length > 0 }));
fs.writeFileSync(path.join(OUT, 'THIRD_PARTY.json'), JSON.stringify({ chromiumNotes, items: json }, null, 1), 'utf-8');
const missing = list.filter((it) => !it.texts.length).map((it) => it.name);
console.log(`[OK] ${list.length} components, ${byLicense.size} licenses; ${groups.size} distinct texts -> ${OUT}`);
if (missing.length) console.log(`[INFO] without a license file in the package (${missing.length}): ${missing.join(', ')}`);
