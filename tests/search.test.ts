import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchFiles, replaceInText, replaceOneInText, matchesFilter, SearchOptions } from '../src/utils/search.ts';

const opts = (o: Partial<SearchOptions>): SearchOptions => ({
  query: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: '',
  ...o,
});

const files = [
  { id: '1', name: 'main.py', content: 'total = 0\nfor item in items:\n    total += item.Price\nprint(total)' },
  { id: '2', name: 'src/util.js', content: 'const totals = [];\n// TOTAL count' },
  { id: '3', name: 'tests/test_main.py', content: 'assert total == 0' },
];

test('search: plain, case-insensitive by default, with positions', () => {
  const r = searchFiles(files, opts({ query: 'total' }));
  assert.equal(r.total, 6); // main.py: 3, util.js: totals + TOTAL, test_main.py: 1
  const main = r.results.find((f) => f.name === 'main.py')!;
  assert.deepEqual(main.matches[0], { line: 1, column: 1, length: 5, preview: 'total = 0' });
  assert.deepEqual(main.matches.map((m) => m.line), [1, 3, 4]);
});

test('search: case sensitive and whole word', () => {
  assert.equal(searchFiles(files, opts({ query: 'TOTAL', caseSensitive: true })).total, 1);
  // "totals" is not a whole-word match for "total"
  assert.equal(searchFiles(files, opts({ query: 'total', wholeWord: true })).total, 5);
});

test('search: regular expressions and special characters', () => {
  assert.equal(searchFiles(files, opts({ query: 'item\\.\\w+', regex: true })).total, 1);
  // In plain mode regex characters are literal
  assert.equal(searchFiles(files, opts({ query: 'item.Price' })).total, 1);
  assert.equal(searchFiles(files, opts({ query: 'item.P.ice' })).total, 0);
  assert.throws(() => searchFiles(files, opts({ query: '(', regex: true })));
  // An empty-matching regex must not loop forever
  assert.equal(searchFiles(files, opts({ query: '^', regex: true })).total, 0);
});

test('search: file filters', () => {
  assert.ok(matchesFilter('main.py', '*.py'));
  assert.ok(!matchesFilter('src/util.js', '*.py'));
  assert.ok(matchesFilter('src/util.js', 'src/'));
  assert.ok(!matchesFilter('tests/test_main.py', '*.py, !tests/'));
  assert.ok(matchesFilter('a/b/c.ts', '**/*.ts'));
  const r = searchFiles(files, opts({ query: 'total', include: '*.py, !tests/' }));
  assert.deepEqual(r.results.map((f) => f.name), ['main.py']);
});

test('replace: plain text keeps "$" literally, regex supports groups', () => {
  const plain = replaceInText('price = 5\nprice2 = price', opts({ query: 'price', wholeWord: true }), 'cost$1');
  assert.deepEqual(plain, { text: 'cost$1 = 5\nprice2 = cost$1', count: 2 });
  const rx = replaceInText('def add(a, b):', opts({ query: '(\\w+)\\((\\w+), (\\w+)\\)', regex: true }), '$1($3, $2)');
  assert.deepEqual(rx, { text: 'def add(b, a):', count: 1 });
  assert.deepEqual(replaceInText('abc', opts({ query: 'x' }), 'y'), { text: 'abc', count: 0 });
});

test('replace one occurrence: only the match at that line/column changes', () => {
  const o = { query: 'name', caseSensitive: false, wholeWord: false, regex: false, include: '' };
  const text = 'name = 1\nprint(name, name)\n';
  // the second "name" on line 2 (column 13)
  assert.deepEqual(replaceOneInText(text, o, 'value', 2, 13), { text: 'name = 1\nprint(name, value)\n', count: 1 });
  // a stale position (the file changed since the search) changes nothing
  assert.deepEqual(replaceOneInText(text, o, 'value', 2, 3), { text, count: 0 });
  // regex mode keeps $1 groups
  const r = { ...o, query: String.raw`print\((\w+)`, regex: true };
  assert.equal(replaceOneInText(text, r, 'show($1', 2, 1).text, 'name = 1\nshow(name, name)\n');
});
