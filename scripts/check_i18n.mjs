// Checks the interface translations: every t('key') used in src/ exists in both languages, and both
// languages have the same keys. Usage: node scripts/check_i18n.mjs   (exit code 1 on problems)
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync('src/i18n.ts', 'utf-8');
// The dictionaries: `const en = {` ... `};` and `const ru: ... = {` ... `};`
function dict(name) {
  const start = src.search(new RegExp(`const ${name}\\b[^=]*=\\s*\\{`));
  if (start < 0) throw new Error(`dictionary ${name} not found`);
  const end = src.indexOf('\n};', start);
  const body = src.slice(start, end);
  return new Set([...body.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
}
const en = dict('en');
const ru = dict('ru');

const used = new Map(); // key -> first place
const dynamic = []; // t(`prefix.${x}`): prefixes, checked loosely
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|mts)$/.test(e.name) && e.name !== 'i18n.ts') {
      const text = fs.readFileSync(p, 'utf-8');
      for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.-]+)'/g)) {
        // t('nb.status.' + status): a prefix, checked like a template key
        if (m[1].endsWith('.')) dynamic.push([m[1].slice(0, -1), p]);
        else if (!used.has(m[1])) used.set(m[1], p);
      }
      // label: 'key' entries handed to t() later (e.g. lists of commands / tabs)
      for (const m of text.matchAll(/\b(?:label|labelKey|title|hint)\s*:\s*'([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9_.-]+)'/g)) if (!used.has(m[1])) used.set(m[1], p);
      for (const m of text.matchAll(/\bt\(\s*`([a-zA-Z0-9_.-]+)\.\$\{/g)) dynamic.push([m[1], p]);
    }
  }
};
walk('src');

let problems = 0;
const report = (title, list) => {
  if (!list.length) return;
  problems += list.length;
  console.log(`\n${title} (${list.length}):`);
  for (const line of list) console.log('  ' + line);
};
report('Used in code but missing in English', [...used].filter(([k]) => !en.has(k)).map(([k, p]) => `${k}  (${p})`));
report('Used in code but missing in Russian', [...used].filter(([k]) => !ru.has(k)).map(([k, p]) => `${k}  (${p})`));
report('Only in English', [...en].filter((k) => !ru.has(k)));
report('Only in Russian', [...ru].filter((k) => !en.has(k)));
report('Dynamic keys with no translation under the prefix', dynamic.filter(([pre]) => ![...en].some((k) => k.startsWith(pre + '.'))).map(([pre, p]) => `${pre}.*  (${p})`));
console.log(`\n${used.size} keys used, ${en.size} English, ${ru.size} Russian${problems ? `, ${problems} problems` : ' — all good'}`);
process.exit(problems ? 1 : 0);
