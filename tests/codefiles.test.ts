import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCodeFiles, namedFiles } from '../src/utils/codeFiles.ts';

test('code blocks get the file names the AI meant', () => {
  const md = [
    'Here is the project.',
    '',
    '**app.py**',
    '```python',
    'print("app")',
    '```',
    '',
    '### src/utils/helpers.js',
    '',
    '```js',
    'export const x = 1;',
    '```',
    '',
    '```python',
    '# tests/test_app.py',
    'def test_x(): pass',
    '```',
    '',
    '```html title="index.html"',
    '<h1>Hi</h1>',
    '```',
    '',
    'Run it with this command, e.g. like this:',
    '```bash',
    'python app.py',
    '```',
    '',
    '```css style.css',
    'body {}',
    '```',
  ].join('\n');
  const blocks = extractCodeFiles(md);
  assert.deepEqual(
    blocks.map((b) => [b.language, b.filename]),
    [
      ['python', 'app.py'],
      ['js', 'src/utils/helpers.js'],
      ['python', 'tests/test_app.py'],
      ['html', 'index.html'],
      ['bash', null], // a sentence above the block is not a caption with a file name
      ['css', 'style.css'],
    ]
  );
  assert.equal(md.slice(blocks[0].offset, blocks[0].offset + 3), '```');
  assert.deepEqual(
    namedFiles(blocks).map((f) => f.name),
    ['app.py', 'src/utils/helpers.js', 'tests/test_app.py', 'index.html', 'style.css']
  );
});

test('unsafe names are ignored; a repeated name keeps the last version', () => {
  const md = '`../../evil.py`\n```python\nx = 1\n```\n\n**main.py**\n```python\nv = 1\n```\n\n**main.py** (fixed)\n```python\nv = 2\n```';
  const blocks = extractCodeFiles(md);
  assert.equal(blocks[0].filename, null);
  assert.deepEqual(namedFiles(blocks), [{ name: 'main.py', content: 'v = 2\n' }]);
});
