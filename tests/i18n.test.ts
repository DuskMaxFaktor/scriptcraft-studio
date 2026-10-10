// Every t('key') in the interface exists in both languages, and both languages have the same keys.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';

test('translations: no missing keys in English or Russian', () => {
  const r = spawnSync(process.execPath, ['scripts/check_i18n.mjs'], { encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
