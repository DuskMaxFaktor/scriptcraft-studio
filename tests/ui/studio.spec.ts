// UI tests: a real browser opens the studio and uses it like a person would.
// Every test works in its own project (created through the API), so tests don't depend on each other.
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { spawnSync } from 'child_process';
import fs from 'fs';

const hasPython = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['--version'], { shell: true }).status === 0;

type FileSpec = { name: string; content: string; isEntry?: boolean; language?: string };

/** Create a project and open the studio on it; fails the test on any error in the browser console. */
async function openStudio(page: Page, request: APIRequestContext, name: string, files: FileSpec[]) {
  const res = await request.post('/api/projects', {
    data: { name, files: files.map((f) => ({ language: 'text', isEntry: false, ...f })) },
  });
  expect(res.ok()).toBeTruthy();
  const project = (await res.json()) as { id: string };

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  (page as Page & { consoleErrors?: string[] }).consoleErrors = errors;

  await page.addInitScript((id) => localStorage.setItem('scriptcraft-last-project', id), project.id);
  await page.goto('/');
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText(files[0].content.split('\n')[0].slice(0, 20));
  return project;
}

/** A file row in the explorer (the tab bar has elements with the same title). */
const sidebarFile = (page: Page, name: string) => page.locator(`div.group[title="${name}"]`);
const consoleErrors = (page: Page) => (page as Page & { consoleErrors?: string[] }).consoleErrors || [];
const runButton = (page: Page) => page.locator('button[title^="Запустить"]').first();
const output = (page: Page) => page.locator('.font-mono.text-xs.space-y-1').first();

async function projectFile(request: APIRequestContext, id: string, name: string) {
  const data = await (await request.get(`/api/projects/${id}`)).json();
  return data.files.find((f: { name: string }) => f.name === name)?.content as string | undefined;
}

test.afterEach(async ({ request }) => {
  // Remove the projects this test created
  const { projects } = (await (await request.get('/api/projects')).json()) as { projects: { id: string }[] };
  for (const p of projects) await request.delete(`/api/projects/${p.id}`);
});

test('the studio opens: header, files, editor, panels — without errors', async ({ page, request }) => {
  await openStudio(page, request, 'Открытие', [
    { name: 'main.py', content: 'print("hi")', isEntry: true },
    { name: 'README.md', content: '# Заголовок' },
  ]);
  await expect(page.getByText('ScriptCraft').first()).toBeVisible();
  await expect(sidebarFile(page, 'main.py')).toBeVisible();
  await expect(sidebarFile(page, 'README.md')).toBeVisible();
  await expect(page.getByText('Терминал').first()).toBeVisible();
  await expect(page.getByPlaceholder(/Попросите ИИ/)).toBeVisible();
  // Markdown is highlighted as Markdown, not JavaScript (no false error squiggles)
  await sidebarFile(page, 'README.md').click();
  await expect(page.getByText('markdown', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.squiggly-error')).toHaveCount(0);
  expect(consoleErrors(page)).toEqual([]);
});

test('runs a JavaScript file and shows its output', async ({ page, request }) => {
  await openStudio(page, request, 'JS', [{ name: 'main.js', content: 'console.log("сумма", 20 + 22)', isEntry: true }]);
  await runButton(page).click();
  await expect(output(page)).toContainText(/сумма\s42/);
  // Colors (Node colors numbers when FORCE_COLOR is set) are shown as colors, not as "[33m" codes
  await expect(output(page)).not.toContainText('[33m');
  await expect(output(page).locator('span[style*="color"]', { hasText: '42' })).toBeVisible();
});

test('runs Python with input() through the input field', async ({ page, request }) => {
  test.skip(!hasPython, 'python not installed');
  await openStudio(page, request, 'Ввод', [
    { name: 'main.py', content: 'name = input("Имя? ")\nprint("Привет,", name)', isEntry: true },
  ]);
  await runButton(page).click();
  const input = page.getByPlaceholder('Программа ждёт ввода — напишите и нажмите Enter');
  await expect(input).toBeVisible();
  await input.fill('Аня');
  await input.press('Enter');
  await expect(output(page)).toContainText(/Привет,\sАня/);
});

test('a failing program offers "Fix with AI"', async ({ page, request }) => {
  await openStudio(page, request, 'Ошибка', [{ name: 'main.js', content: 'throw new Error("boom")', isEntry: true }]);
  await runButton(page).click();
  await expect(output(page)).toContainText('boom');
  await expect(page.getByRole('button', { name: /Исправить с ИИ/ })).toBeVisible();
});

test('creates a file, types code and autosaves it to disk', async ({ page, request }) => {
  const project = await openStudio(page, request, 'Новый файл', [{ name: 'main.py', content: 'print(1)', isEntry: true }]);
  await page.locator('button[title="Новый файл"]').click();
  const nameInput = page.getByPlaceholder('script.py, src/app.js');
  await nameInput.fill('hello.js');
  await nameInput.press('Enter');
  await expect(sidebarFile(page, 'hello.js')).toBeVisible();
  // Wait until the editor is actually bound to the new file before typing — otherwise fast
  // synthetic keystrokes could land in the previously open file (the old flake here)
  await expect(page.locator('[data-active-file]')).toHaveAttribute('data-active-file', 'hello.js');

  const editor = page.locator('.monaco-editor').first();
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  // Human speed: a busy machine can drop instant synthetic keystrokes
  await page.keyboard.type('const answer = 6 * 7;', { delay: 30 });
  // What the editor actually holds — guards against a rare dropped synthetic keystroke, since this
  // test checks that autosave persists the editor's content to disk, not that typing is lossless
  const editorText = (await page.locator('.monaco-editor .view-lines').first().innerText()).replace(/ /g, ' ').trim();
  // ~21 typed chars; tolerate a rare dropped synthetic keystroke so the real check — autosave wrote
  // exactly the editor's content to disk — stays stable
  expect(editorText.length).toBeGreaterThanOrEqual(18);
  await expect.poll(() => projectFile(request, project.id, 'hello.js'), { timeout: 8000 }).toBe(editorText);
});

test('deletes a file after confirmation', async ({ page, request }) => {
  const project = await openStudio(page, request, 'Удаление', [
    { name: 'main.py', content: 'print(1)', isEntry: true },
    { name: 'extra.py', content: 'x = 1' },
  ]);
  const row = sidebarFile(page, 'extra.py');
  await row.hover();
  await row.locator('button[title="Удалить"]').click();
  // A themed confirmation, not the browser's white window; Esc would cancel it
  await expect(page.locator('[data-dialog="confirm"]')).toContainText('extra.py');
  await page.locator('[data-dialog-ok]').click(); // the studio's own (themed) confirmation
  await expect(row).toHaveCount(0);
  await expect.poll(() => projectFile(request, project.id, 'extra.py')).toBeUndefined();
});

test('confirmations use the themed studio window: Esc / Cancel keep things as they are', async ({ page, request }) => {
  const project = await openStudio(page, request, 'Окна', [
    { name: 'main.py', content: 'print(1)', isEntry: true },
    { name: 'keep.py', content: 'x = 1' },
  ]);
  const row = sidebarFile(page, 'keep.py');
  await row.hover();
  await row.locator('button[title="Удалить"]').click();
  const dialog = page.locator('[data-dialog="confirm"]');
  await expect(dialog).toBeVisible();
  // Not white in the dark theme: the window uses the studio's raised surface color
  const bg = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgb(255, 255, 255)');
  await expect(dialog.locator('[data-dialog-ok]')).toHaveClass(/bg-rose/); // deleting: a red button

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await row.hover();
  await row.locator('button[title="Удалить"]').click();
  await page.locator('[data-dialog-cancel]').click();
  await expect(row).toBeVisible();
  expect(await projectFile(request, project.id, 'keep.py')).toBe('x = 1');
});

test('project search finds text in other files', async ({ page, request }) => {
  await openStudio(page, request, 'Поиск', [
    { name: 'main.py', content: 'print(1)', isEntry: true },
    { name: 'lib/util.py', content: 'SECRET_MARKER = 5' },
  ]);
  await page.keyboard.press('Control+Shift+F');
  const box = page.getByPlaceholder('Искать во всех файлах');
  await expect(box).toBeVisible();
  await box.fill('SECRET_MARKER');
  await expect(page.locator('[title="lib/util.py"]').first()).toBeVisible();
});

test('project replace: one occurrence, undo, then replace in all files', async ({ page, request }) => {
  const project = await openStudio(page, request, 'Замена', [
    { name: 'a.py', content: 'name = 1\nprint(name)\n', isEntry: true },
    { name: 'b.py', content: 'name = 2\n' },
  ]);
  await page.keyboard.press('Control+Shift+F');
  await page.getByPlaceholder('Искать во всех файлах').fill('name');
  await page.getByTitle('Показать / скрыть замену').click();
  await page.getByPlaceholder('Заменить на').fill('value');
  await expect(page.locator('[data-search-match]')).toHaveCount(3);

  // Replace just the first match of a.py
  const first = page.locator('[data-search-match]').first();
  await first.hover();
  await first.locator('[data-replace-one]').click();
  await expect.poll(() => projectFile(request, project.id, 'a.py')).toBe('value = 1\nprint(name)\n');
  await expect(page.locator('[data-replace-done]')).toContainText('1');

  // Undo brings the file back
  await page.locator('[data-replace-undo]').click();
  await expect.poll(() => projectFile(request, project.id, 'a.py')).toBe('name = 1\nprint(name)\n');

  // Replace everywhere (after confirmation)
  await page.getByTitle('Заменить во всех файлах').click();
  await page.locator('[data-dialog-ok]').click(); // the studio's own (themed) confirmation
  await expect.poll(() => projectFile(request, project.id, 'a.py')).toBe('value = 1\nprint(value)\n');
  await expect.poll(() => projectFile(request, project.id, 'b.py')).toBe('value = 2\n');
});

test('programs on this PC: search, problems filter, repair (dry run)', async ({ page, request }) => {
  await openStudio(page, request, 'Программы', [{ name: 'main.py', content: 'print(1)', isEntry: true }]);
  await page.locator('[data-open-apps]').click();
  const modal = page.locator('[data-apps-modal]');
  await expect(modal.locator('[data-app-row]')).toHaveCount(2);

  // Search narrows the list
  await modal.locator('[data-apps-search]').fill('broken');
  await expect(modal.locator('[data-app-row]')).toHaveCount(1);
  await modal.locator('[data-apps-search]').fill('');

  // "With problems" shows the broken entry and why
  await modal.locator('[data-apps-problems]').click();
  await expect(modal.locator('[data-app-row]')).toHaveCount(1);
  await expect(modal.locator('[data-app-row="Broken Tool"] [data-app-problems]')).toContainText('нет деинсталлятора');
  await modal.locator('[data-apps-problems]').click();

  // Repair asks first, then starts the program's own repair (a dry run in tests)
  await modal.locator('[data-app-row="Test App"] [data-app-repair]').click();
  await page.locator('[data-dialog-ok]').click(); // the studio's own (themed) confirmation
  await expect(modal.locator('[data-apps-notice]')).toContainText('Ремонт «Test App» запущен');
  await expect(modal.locator('[data-app-row="Broken Tool"] [data-app-repair]')).toHaveCount(0);
  // Updates: a badge on the program, the updates view, and winget upgrade after confirmation (dry run)
  await expect(modal.locator('[data-app-row="Test App"]')).toContainText('→ 1.3.0');
  await modal.locator('[data-apps-updates]').click();
  await expect(modal.locator('[data-update-row]')).toHaveCount(1);
  await modal.locator('[data-update-row="Test.App"] [data-update-install]').click();
  await page.locator('[data-dialog-ok]').click(); // the studio's own (themed) confirmation
  await expect(modal.locator('[data-apps-notice]')).toContainText('winget upgrade --id Test.App --exact');
});

test('startup programs: listed, a leftover entry is flagged, switching off and on', async ({ page, request }) => {
  await openStudio(page, request, 'Автозагрузка', [{ name: 'main.py', content: 'print(1)', isEntry: true }]);
  await page.locator('[data-open-apps]').click();
  const modal = page.locator('[data-apps-modal]');
  await modal.locator('[data-apps-tab="startup"]').click();
  await expect(modal.locator('[data-startup-row]')).toHaveCount(2);
  await expect(modal.locator('[data-startup-row="Old Updater"] [data-startup-problems]')).toContainText('нет файла программы');

  const toggle = modal.locator('[data-startup-row="Old Updater"] [data-startup-toggle]');
  await expect(toggle).toHaveText('Вкл');
  await toggle.click();
  await expect(toggle).toHaveText('Выкл');
  await expect(modal.locator('[data-apps-notice]')).toContainText('больше не будет запускаться');
  await toggle.click();
  await expect(toggle).toHaveText('Вкл');
});

test('projects dialog creates and switches to a new project', async ({ page, request }) => {
  await openStudio(page, request, 'Первый', [{ name: 'main.py', content: 'print(1)', isEntry: true }]);
  await page.locator('button[title^="Мои проекты"]').click();
  await page.getByPlaceholder('Название проекта').fill('Второй проект');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(page.locator('button[title^="Мои проекты"]')).toContainText('Второй проект');
  const { projects } = (await (await request.get('/api/projects')).json()) as { projects: { name: string }[] };
  const names = projects.map((p) => p.name);
  expect(names).toContain('Второй проект');
});

test('theme and interface language switch', async ({ page, request }) => {
  await openStudio(page, request, 'Тема', [{ name: 'main.py', content: 'print(1)', isEntry: true }]);
  const html = page.locator('html');
  const before = await html.getAttribute('data-theme');
  await page.locator('button[title="Светлая тема"], button[title="Тёмная тема"]').click();
  await expect(html).not.toHaveAttribute('data-theme', before || '');

  await page.getByRole('button', { name: 'en', exact: true }).click();
  await expect(page.locator('button[title^="Run "]').first()).toBeVisible();
  await page.getByRole('button', { name: 'ru', exact: true }).click();
  await expect(runButton(page)).toBeVisible();
});

test('quick open (Ctrl+P) jumps to a file', async ({ page, request }) => {
  await openStudio(page, request, 'Переход', [
    { name: 'main.py', content: 'print(1)', isEntry: true },
    { name: 'tools/report.py', content: 'REPORT = True' },
  ]);
  await page.keyboard.press('Control+P');
  await page.keyboard.type('report'); // right away: the dialog must already catch the first keystrokes
  await page.keyboard.press('Enter');
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('REPORT = True');
});

test('markdown preview renders the .md file and toggles off', async ({ page, request }) => {
  await openStudio(page, request, 'Readme', [
    { name: 'README.md', language: 'markdown', isEntry: true, content: '# Заголовок\n\n- пункт один\n- пункт два\n\n**жирный** текст\n\n```js\nconst a = 1;\n```\n' },
  ]);
  const preview = page.locator('[data-md-preview]');
  await expect(preview).toBeVisible(); // on by default for .md
  await expect(preview.locator('h1')).toHaveText('Заголовок');
  await expect(preview.locator('li')).toHaveCount(2);
  await expect(preview.locator('strong')).toHaveText('жирный');
  await expect(preview.locator('pre code')).toContainText('const a = 1;');
  // The eye button hides the preview
  await page.locator('[data-md-preview-toggle]').click();
  await expect(preview).toBeHidden();
});

test('markdown preview: formulas (KaTeX), mermaid diagrams and export to HTML', async ({ page, request }) => {
  const md = '# Отчёт\n\nФормула $E = mc^2$ и блок:\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n```mermaid\ngraph TD\n  A[Старт] --> B[Финиш]\n```\n';
  await openStudio(page, request, 'Формулы', [{ name: 'report.md', language: 'markdown', isEntry: true, content: md }]);
  const preview = page.locator('[data-md-preview]');
  await expect(preview.locator('.katex').first()).toBeVisible();
  await expect(preview.locator('.katex-display')).toHaveCount(1);
  await expect(preview.locator('[data-mermaid] svg')).toBeVisible({ timeout: 20_000 });
  await expect(preview.locator('[data-mermaid] svg')).toContainText('Финиш');

  // Export: a standalone .html with the rendered formulas and the diagram
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-md-export]').click()]);
  expect(download.suggestedFilename()).toBe('report.html');
  const html = fs.readFileSync((await download.path())!, 'utf-8');
  expect(html).toContain('<!doctype html>');
  expect(html).toContain('class="katex');
  expect(html).toContain('<svg');
  expect(html).toContain('Финиш');
});

test('web preview shows the project page on its own port', async ({ page, request }) => {
  await openStudio(page, request, 'Сайт', [
    { name: 'index.html', content: '<!DOCTYPE html><html><head></head><body><h1 id="t">Мой сайт</h1></body></html>', isEntry: true },
  ]);
  await page.getByText('Веб-просмотр').first().click();
  const frame = page.frameLocator('iframe').first();
  await expect(frame.locator('#t')).toHaveText('Мой сайт');
  const src = await page.locator('iframe').first().getAttribute('src');
  expect(new URL(src!).port).toBe('3211');
  // Scrollbars inside the preview follow the studio's theme
  const theme = await page.locator('html').getAttribute('data-theme');
  await expect
    .poll(() => frame.locator('#__scriptcraft_scrollbars').evaluate((e) => e.textContent))
    .toContain(theme === 'light' ? '#cbd5e1 #f1f4f8' : '#334155 #0f141c');
});

test('built-in terminal runs a command', async ({ page, request }) => {
  test.skip(process.platform !== 'win32', 'shell names are Windows-specific');
  const project = await openStudio(page, request, 'Терминал', [{ name: 'main.py', content: 'print(1)', isEntry: true }]);
  await page.getByText('Командная строка').first().click();
  const term = page.locator('.xterm').first();
  await expect(term).toBeVisible();
  await term.click();
  await expect(page.locator('.xterm-rows').first()).toContainText('>', { timeout: 15000 });
  await page.keyboard.type('echo ui-terminal-ok');
  await page.keyboard.press('Enter');
  // The typed command and then its output
  await expect(page.locator('.xterm-rows').first()).toContainText(/ui-terminal-ok[\s\S]*ui-terminal-ok/, { timeout: 15000 });
  // A project with an open terminal can still be deleted (its shells are closed first)
  expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBeTruthy();
});

test('git panel: create a repository, commit, see a change, view the diff, discard it', async ({ page, request }) => {
  test.skip(spawnSync('git', ['--version']).status !== 0, 'git not installed');
  const project = await openStudio(page, request, 'Git', [{ name: 'main.py', content: 'print("v1")', isEntry: true }]);
  await page.keyboard.press('Control+Shift+G');
  await page.getByRole('button', { name: 'Создать репозиторий' }).click();
  await expect(page.locator('[data-git-file="main.py"]')).toBeVisible();
  await expect(page.locator('[data-git-file=".gitignore"]')).toBeVisible();
  // Author for this repository only (independent of the PC's git config)
  await request.post(`/api/git/${project.id}/identity`, { data: { name: 'UI Test', email: 'ui@example.com' } });

  await page.getByPlaceholder(/Описание коммита/).fill('Первая версия');
  await page.getByRole('button', { name: /Коммит \(2\)/ }).click();
  await expect(page.getByText('Нет изменений с последнего коммита')).toBeVisible();
  await expect(page.getByText('Первая версия').first()).toBeVisible();

  // Edit in the editor: after the autosave the file shows up as modified
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('print("v2")');
  const changed = page.locator('[data-git-file="main.py"]');
  await expect(changed).toBeVisible({ timeout: 10000 });
  await expect(changed).toContainText('M');

  await changed.click();
  await expect(page.getByText('main.py: последний коммит ↔ сейчас')).toBeVisible();
  await expect(page.locator('.monaco-diff-editor')).toContainText('v2');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);

  await changed.hover();
  await changed.locator('button[title="Отменить изменения"]').click();
  await page.locator('[data-dialog-ok]').click(); // the studio's own (themed) confirmation
  await expect(page.getByText('Нет изменений с последнего коммита')).toBeVisible();
  // The editor picks up the restored file from disk
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('v1', { timeout: 10000 });
});

test('git panel: create a branch, commit on it, file history, switch back', async ({ page, request }) => {
  test.skip(spawnSync('git', ['--version']).status !== 0, 'git not installed');
  const project = await openStudio(page, request, 'Ветки', [{ name: 'main.py', content: 'print("v1")', isEntry: true }]);
  const g = `/api/git/${project.id}`;
  await request.post(`${g}/init`);
  await request.post(`${g}/identity`, { data: { name: 'UI Test', email: 'ui@example.com' } });
  await request.post(`${g}/commit`, { data: { message: 'Первая версия' } });
  const main = (await (await request.get(`${g}/branches`)).json()).current as string;

  await page.keyboard.press('Control+Shift+G');
  const branches = page.locator('[data-git-branches]');
  await expect(branches.locator(`[data-git-branch="${main}"]`)).toContainText('текущая');

  // Create a branch: it becomes the current one
  await branches.locator('[data-git-new-branch]').fill('feature');
  await branches.locator('[data-git-create-branch]').click();
  await expect(branches.locator('[data-git-branch="feature"]')).toContainText('текущая');

  // Commit a change on the branch
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('print("v2")', { delay: 20 });
  await expect(page.locator('[data-git-file="main.py"]')).toBeVisible({ timeout: 10000 });
  await page.getByPlaceholder(/Описание коммита/).fill('Вторая версия');
  await page.getByRole('button', { name: /Коммит \(1\)/ }).click();
  await expect(page.getByText('Нет изменений с последнего коммита')).toBeVisible();

  // History: open the commit, see what it changed in main.py, then that file's own history
  await page.locator('[data-git-commit]', { hasText: 'Вторая версия' }).click();
  const fileRow = page.locator('[data-git-commit-file="main.py"]').first();
  await fileRow.click();
  await expect(page.locator('.monaco-diff-editor')).toContainText('v2');
  await page.mouse.click(5, 5);
  await fileRow.hover();
  await fileRow.locator('[data-git-file-history-btn]').click();
  await expect(page.locator('[data-git-file-history]')).toContainText('main.py (2)');

  // Switch back: the editor shows the file as it is on that branch
  await branches.locator(`[data-git-branch="${main}"] [data-git-switch]`).click();
  await expect(branches.locator(`[data-git-branch="${main}"]`)).toContainText('текущая');
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('v1', { timeout: 10000 });
});

test('git panel: merge a branch with a conflict — compare, take theirs, finish', async ({ page, request }) => {
  test.skip(spawnSync('git', ['--version']).status !== 0, 'git not installed');
  const project = await openStudio(page, request, 'Слияние', [{ name: 'main.py', content: 'print("v1")', isEntry: true }]);
  const g = `/api/git/${project.id}`;
  await request.post(`${g}/init`);
  await request.post(`${g}/identity`, { data: { name: 'UI Test', email: 'ui@example.com' } });
  await request.post(`${g}/commit`, { data: { message: 'start' } });
  const main = (await (await request.get(`${g}/branches`)).json()).current as string;
  const editor = page.locator('.monaco-editor').first();
  const lines = page.locator('.monaco-editor .view-lines').first();
  const typeAndCommit = async (text: string, message: string) => {
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(text, { delay: 20 });
    await expect.poll(() => projectFile(request, project.id, 'main.py')).toBe(text);
    await request.post(`${g}/commit`, { data: { message } });
  };

  // The same line changed on two branches
  await request.post(`${g}/branches`, { data: { name: 'feature' } });
  await typeAndCommit('print("feature")', 'feature change');
  await request.post(`${g}/switch`, { data: { name: main } });
  await expect(lines).toContainText('v1', { timeout: 10000 });
  await typeAndCommit('print("main")', 'main change');

  await page.keyboard.press('Control+Shift+G');
  await page.locator('[data-git-branch="feature"] [data-git-merge]').click();
  await page.locator('[data-dialog-ok]').click(); // the studio's own (themed) confirmation
  const banner = page.locator('[data-git-merge-banner]');
  await expect(banner.locator('[data-git-conflict="main.py"]')).toBeVisible();

  // Compare both sides
  await banner.locator('[data-git-conflict-compare]').click();
  await expect(page.locator('.monaco-diff-editor')).toContainText('"main"');
  await expect(page.locator('.monaco-diff-editor')).toContainText('"feature"');
  await page.mouse.click(5, 5);

  // Take the branch's version, then finish the merge
  await banner.locator('[data-git-take="theirs"]').click();
  await banner.locator('[data-git-finish-merge]').click();
  await expect(banner).toHaveCount(0);
  await expect(page.locator('[data-git-commit]').first()).toContainText("Merge branch 'feature'");
  await expect(lines).toContainText('feature', { timeout: 10000 });
});

test('template gallery: a starter project opens on its README and runs', async ({ page, request }) => {
  test.skip(!hasPython, 'python not installed');
  await openStudio(page, request, 'Шаблоны', [{ name: 'main.py', content: 'print(1)', isEntry: true }]);
  await page.locator('button[title^="Мои проекты"]').click();
  await expect(page.locator('[data-template="telegram-bot"]')).toContainText('aiogram');
  await page.locator('[data-template="text-quest"]').click();
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(page.locator('button[title^="Мои проекты"]')).toContainText('Текстовый квест');
  await expect(sidebarFile(page, 'quest.py')).toBeVisible();
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('# Текстовый квест');

  // The main file (★) runs even while the README is open
  await runButton(page).click();
  const input = page.getByPlaceholder('Программа ждёт ввода — напишите и нажмите Enter');
  await expect(input).toBeVisible();
  for (const choice of ['2', '1', '2', '1']) {
    await input.fill(choice);
    await input.press('Enter');
  }
  await expect(output(page)).toContainText('карта сокровищ');
});

test('javascript checks: ESLint underlines a problem and fixes it on Ctrl+.', async ({ page, request }) => {
  const project = await openStudio(page, request, 'ESLint', [{ name: 'app.js', language: 'javascript', content: 'const ok = 1;\nif (!!ok) console.log(ok);\n', isEntry: true }]);
  const status = page.locator('[data-eslint-status]');
  await expect(status).toContainText('проблем: 1');
  await expect(page.locator('.squiggly-error').first()).toBeVisible();

  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Control+.');
  await page.getByText(/Исправить \(no-extra-boolean-cast\)/).first().click();
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('if (ok)');
  await expect(status).toContainText('без замечаний');
  await expect.poll(() => projectFile(request, project.id, 'app.js')).toBe('const ok = 1;\nif (ok) console.log(ok);\n');
});

test('python checks and formatting: Ruff underlines problems, formats the file and fixes on Ctrl+.', async ({ page, request }) => {
  const tools = await (await request.get('/api/code/tools')).json();
  test.skip(!tools.ruff, 'ruff not installed');
  const project = await openStudio(page, request, 'Ruff', [
    { name: 'main.py', content: 'import os\ndef greet( name ):\n  return "Hi "+name\nprint(greet("Ann"))\n', isEntry: true },
  ]);
  const status = page.locator('[data-ruff-status]');
  await expect(status).toContainText('проблем');
  await expect(page.locator('.squiggly-warning').first()).toBeVisible();

  // Quick fix on the unused import
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+.');
  await page.getByText(/Remove unused import/).first().click();
  await expect(page.locator('.monaco-editor .view-lines').first()).not.toContainText('import os');

  // Shift+Alt+F: formatted like Black
  await page.keyboard.press('Shift+Alt+F');
  await expect
    .poll(async () => (await (await request.get(`/api/projects/${project.id}`)).json()).files[0].content, { timeout: 8000 })
    .toBe('def greet(name):\n    return "Hi " + name\n\n\nprint(greet("Ann"))\n');
  await expect(status).toContainText('без замечаний');
});

test('formatting JavaScript with Prettier', async ({ page, request }) => {
  const project = await openStudio(page, request, 'Prettier', [{ name: 'app.js', content: 'const a = {b:1,c:[1,2]}\n', isEntry: true }]);
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Shift+Alt+F');
  await expect
    .poll(async () => (await (await request.get(`/api/projects/${project.id}`)).json()).files[0].content, { timeout: 8000 })
    .toBe('const a = { b: 1, c: [1, 2] };\n');
});

test('chat menus are aligned under the selector bar and close on an outside click', async ({ page, request }) => {
  await openStudio(page, request, 'Нейросети', [{ name: 'main.py', content: 'print(1)', isEntry: true }]);
  // Role menu: exactly under the selector bar, closes on an outside click
  await page.getByRole('button', { name: /Архитектор и Full-Stack/ }).first().click();
  const menu = page.getByText('Выбор роли ИИ', { exact: false }).locator('..');
  await expect(menu).toBeVisible();
  const bar = await page.locator('.relative.px-3').first().boundingBox();
  const box = await menu.boundingBox();
  expect(Math.abs(box!.x - (bar!.x + 12))).toBeLessThan(2);
  expect(Math.abs(box!.x + box!.width - (bar!.x + bar!.width - 12))).toBeLessThan(2);
  await page.mouse.click(5, 300);
  await expect(menu).toBeHidden();

});

test('tests tab: runs pytest, shows passed / failed and opens the failing test', async ({ page, request }) => {
  test.skip(spawnSync('python', ['-c', 'import pytest']).status !== 0, 'pytest not installed');
  await openStudio(page, request, 'Тесты', [
    { name: 'calc.py', content: 'def add(a, b):\n    return a + b\n', isEntry: true },
    { name: 'test_calc.py', content: 'from calc import add\n\n\ndef test_ok():\n    assert add(1, 2) == 3\n\n\ndef test_bad():\n    assert add(1, 2) == 4\n' },
  ]);
  await page.locator('[data-tab="tests"]').click();
  await page.getByRole('button', { name: /Запустить тесты Python/ }).click();
  const summary = page.locator('[data-tests-summary]');
  await expect(summary).toBeVisible({ timeout: 30000 });
  await expect(page.locator('[data-test-case][data-status="passed"]')).toHaveCount(1);
  await expect(page.locator('[data-test-case="test_bad"]')).toHaveAttribute('data-status', 'failed');
  await expect(page.locator('[data-test-case="test_bad"]')).toContainText('assert 3 == 4');
  // Click: the failing test file opens in the editor
  await page.locator('[data-test-case="test_bad"] >> text=test_calc.py:9').first().click();
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('def test_bad');
});

test('keyboard shortcuts can be changed: a studio command and an editor command, kept after reload', async ({ page, request }) => {
  const project = await openStudio(page, request, 'Клавиши', [{ name: 'app.js', language: 'javascript', content: 'const a = {b:1}\nconsole.log("ran", a.b)\n', isEntry: true }]);
  await page.getByTitle('Горячие клавиши').click();
  const modal = page.locator('[data-hotkeys]');

  // Run on Ctrl+P: taken by "Go to file", so the window offers to move it
  await modal.locator('[data-hotkey="run"] [data-hotkey-edit]').click();
  await page.keyboard.press('Control+P');
  await expect(modal.locator('[data-hotkey-conflict]')).toContainText('Перейти к файлу');
  await modal.locator('[data-hotkey-reassign]').click();
  await expect(modal.locator('[data-hotkey="run"]')).toContainText('Ctrl + P');
  await expect(modal.locator('[data-hotkey="quickOpen"]')).toContainText('нет');

  // Format on Ctrl+Alt+L instead of Shift+Alt+F
  await modal.locator('[data-hotkey="format"] [data-hotkey-edit]').click();
  await page.keyboard.press('Control+Shift+I');
  await expect(modal.locator('[data-hotkey="format"]')).toContainText('Ctrl + Shift + I');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await expect(modal).toHaveCount(0);

  // Kept after reload
  await page.reload();
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  await page.locator('.monaco-editor').first().click();
  // The old format key does nothing now
  await page.keyboard.press('Shift+Alt+F');
  await page.waitForTimeout(2000); // formatting + autosave would have landed by now
  expect(await projectFile(request, project.id, 'app.js')).toBe('const a = {b:1}\nconsole.log("ran", a.b)\n');
  await page.keyboard.press('Control+Shift+I');
  await expect.poll(() => projectFile(request, project.id, 'app.js'), { timeout: 8000 }).toBe('const a = { b: 1 };\nconsole.log("ran", a.b);\n');
  // Ctrl+P in the editor runs the program, the file picker stays closed
  await page.keyboard.press('Control+P');
  await expect(output(page)).toContainText('ran 1');

  // Reset all: back to the defaults
  await page.getByTitle('Горячие клавиши').click();
  await modal.locator('[data-hotkeys-reset-all]').click();
  await expect(modal.locator('[data-hotkey="run"]')).toContainText('Ctrl + Enter');
  await expect(modal.locator('[data-hotkey="quickOpen"]')).toContainText('Ctrl + P');
  expect(await page.evaluate(() => localStorage.getItem('scriptcraft-keybindings'))).toBeNull();
});

test('about window: a new version is found, the header shows a dot, the update starts after confirmation', async ({ page, request }) => {
  let installCalls = 0;
  await page.route('**/api/update/check', (route) =>
    route.fulfill({
      json: { current: '1.1.0', latest: '1.2.0', available: true, name: 'v1.2.0', notes: '- быстрее', page: 'https://github.com/me/studio/releases', published: '', canInstall: true, size: 270 * 1024 * 1024 },
    })
  );
  await page.route('**/api/update/install', (route) => {
    installCalls++;
    return route.fulfill({ json: { ok: true, version: '1.2.0' } });
  });
  await openStudio(page, request, 'Обновления', [{ name: 'main.py', content: 'print(1)', isEntry: true }]);
  await page.locator('[data-open-about]').click();
  const about = page.locator('[data-about]');
  await expect(about.locator('[data-about-version]')).toContainText('Версия');
  // A bad repository name is refused by the server
  await about.locator('[data-update-repo]').fill('просто текст');
  await about.locator('[data-update-check]').click();
  await expect(about).toContainText('owner/name');
  await about.locator('[data-update-repo]').fill('https://github.com/me/studio');
  await about.locator('[data-update-check]').click();
  await expect(about.locator('[data-update-repo]')).toHaveValue('me/studio');
  await expect(about.locator('[data-update-available]')).toContainText('Новая версия 1.2.0');
  await expect(about.locator('[data-update-available]')).toContainText('быстрее');
  await expect(page.locator('[data-update-dot]')).toBeVisible();

  // Cancel in the confirmation: nothing happens
  await about.locator('[data-update-install]').click();
  await page.locator('[data-dialog-cancel]').click();
  expect(installCalls).toBe(0);
  await about.locator('[data-update-install]').click();
  await page.locator('[data-dialog-ok]').click();
  await expect(about.locator('[data-update-installing]')).toBeVisible();
  expect(installCalls).toBe(1);
});

test('report a problem: an interface error reaches the journal and the report', async ({ page, request }) => {
  await openStudio(page, request, 'Отчёт', [{ name: 'main.py', content: 'print(1)', isEntry: true }]);
  // An error somewhere in the interface
  await page.evaluate(() => setTimeout(() => {
    throw new Error('ui test boom 4711');
  }));
  await page.locator('[data-open-about]').click();
  await page.locator('[data-about-tab="report"]').click();
  await page.locator('[data-report-description]').fill('Кнопка не нажимается');
  await expect.poll(async () => {
    await page.locator('[data-report-build]').click();
    return page.locator('[data-report-text]').inputValue();
  }, { timeout: 10000 }).toContain('ui test boom 4711');
  const text = await page.locator('[data-report-text]').inputValue();
  expect(text).toContain('Кнопка не нажимается');
  expect(text).toMatch(/ScriptCraft Studio \d+\.\d+\.\d+/);
});

test('risky code: a warning before the run, Cancel keeps it from running, the answer is remembered', async ({ page, request }) => {
  test.skip(!hasPython, 'python not installed');
  // A folder that does not exist: even if it ran, nothing would be deleted
  await openStudio(page, request, 'Опасный код', [
    { name: 'clean.py', content: 'import shutil\nprint("start")\nshutil.rmtree("no_such_folder_4711", ignore_errors=True)\nprint("finished")\n', isEntry: true },
  ]);
  const dialog = page.locator('[data-dialog="confirm"]');
  await runButton(page).click();
  await expect(dialog).toContainText('удаляет папки целиком');
  await expect(dialog).toContainText('строка 3');
  await page.locator('[data-dialog-cancel]').click();
  await page.waitForTimeout(800);
  await expect(output(page)).not.toContainText('start');

  await runButton(page).click();
  await page.locator('[data-dialog-ok]').click();
  await expect(output(page)).toContainText('finished', { timeout: 20000 });
  // Same code again: no question
  await runButton(page).click();
  await expect(output(page).getByText('finished')).toHaveCount(2, { timeout: 20000 });
  await expect(dialog).toHaveCount(0);
});

test('tests tab: coverage paints run / not-run lines in the editor', async ({ page, request }) => {
  test.skip(spawnSync('python', ['-c', 'import pytest']).status !== 0, 'pytest not installed');
  await openStudio(page, request, 'Покрытие', [
    { name: 'calc.py', content: 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n', isEntry: true },
    { name: 'test_calc.py', content: 'from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n' },
  ]);
  await page.locator('[data-tab="tests"]').click();
  await page.locator('[data-tests-coverage-toggle]').check();
  await page.getByRole('button', { name: /Запустить тесты Python/ }).click();
  const row = page.locator('[data-coverage-file="calc.py"]');
  await expect(row).toBeVisible({ timeout: 30000 });
  // 2 def lines + return a + b ran; return a - b did not: 3 of 4
  await expect(row).toContainText('3/4');
  await expect(page.locator('[data-coverage-total]')).toHaveText('75%');
  await expect(row).toHaveAttribute('title', /6/);
  // Click: calc.py opens with a green / red bar next to the line numbers
  await row.click();
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('def sub');
  await expect(page.locator('.monaco-editor .sc-cov-hit')).toHaveCount(3);
  await expect(page.locator('.monaco-editor .sc-cov-miss')).toHaveCount(1);
  // Hide: the bars go away
  await page.locator('[data-coverage-show]').click();
  await expect(page.locator('.monaco-editor .sc-cov-hit')).toHaveCount(0);
});

test('chat answer with code: "Create files" makes every named file, the agent hint explains the modes', async ({ page, request }) => {
  const project = (await (await request.post('/api/projects', { data: { name: 'Чат', files: [{ name: 'main.py', language: 'python', content: 'print(1)', isEntry: true }] } })).json()) as { id: string };
  const answer = 'Вот проект.\n\n**app.py**\n```python\nfrom utils import hello\nprint(hello())\n```\n\n```python\n# utils.py\ndef hello():\n    return "hi"\n```';
  await request.put(`/api/projects/${project.id}/chat`, {
    data: {
      messages: [
        { id: 'u1', role: 'user', text: 'Сделай проект', timestamp: '10:00' },
        { id: 'm1', role: 'model', text: answer, timestamp: '10:00', modelUsed: 'test' },
      ],
    },
  });
  await page.addInitScript((id) => {
    localStorage.setItem('scriptcraft-last-project', id);
    localStorage.setItem('scriptcraft-agent-mode', 'off');
  }, project.id);
  await page.goto('/');
  const create = page.locator('[data-create-files]');
  await expect(create).toContainText('Создать файлы (2): app.py, utils.py');
  await expect(page.locator('[data-agent-hint]')).toBeVisible();
  await expect(page.locator('.chat-md').getByText('utils.py', { exact: true })).toBeVisible(); // the code block header shows the file name
  await create.click();
  await expect(sidebarFile(page, 'app.py')).toBeVisible();
  await expect(sidebarFile(page, 'utils.py')).toBeVisible();
  await expect
    .poll(async () => ((await (await request.get(`/api/projects/${project.id}`)).json()).files as { name: string }[]).map((f) => f.name).sort())
    .toEqual(['app.py', 'main.py', 'utils.py']);
});

test('chat: attach an image, it previews, is sent to the model and shows in the message', async ({ page, request }) => {
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  let sentBody: any = null;
  await page.route('**/api/chat/stream', async (route) => {
    sentBody = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: 'data: {"t":"Вижу картинку"}\n\ndata: {"done":true,"model":"test"}\n\n',
    });
  });
  await page.addInitScript(() => localStorage.setItem('scriptcraft-agent-mode', 'off'));
  await openStudio(page, request, 'Vision', [{ name: 'main.py', language: 'python', content: 'print(1)', isEntry: true }]);

  await page.locator('input[data-chat-file]').setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') });
  await expect(page.locator('[data-chat-images] img')).toHaveCount(1);

  const chat = page.getByPlaceholder(/Попросите ИИ|Опишите задачу/);
  await chat.fill('что на картинке?');
  await chat.press('Enter');

  // The streamed answer appears and the user bubble shows the image
  await expect(page.locator('.chat-md').getByText('Вижу картинку')).toBeVisible();
  await expect(page.locator('[data-message-images] img')).toHaveCount(1);
  // The image reached the server on the last message, as base64 with its MIME type
  const last = sentBody.messages.at(-1);
  expect(last.images[0]).toEqual({ mime: 'image/png', data: PNG_B64 });
  expect(last.text).toContain('что на картинке?');
  // After sending, the attachment strip is cleared
  await expect(page.locator('[data-chat-images]')).toHaveCount(0);
});

test('debugger: a conditional breakpoint stops on the right iteration and watches show values', async ({ page, request }) => {
  test.skip(!hasPython, 'python not installed');
  const code = 'total = 0\nfor v in [1, 2, 3]:\n    total += v * 2\nprint(total)\n';
  const project = (await (await request.post('/api/projects', { data: { name: 'Отладка', files: [{ name: 'main.py', language: 'python', content: code, isEntry: true }] } })).json()) as { id: string };
  // Seed a conditional breakpoint and watches the way the studio stores them
  await page.addInitScript((id) => {
    localStorage.setItem('scriptcraft-last-project', id);
    localStorage.setItem('scriptcraft-bp-' + id, JSON.stringify({ 'main.py': [{ line: 3, condition: 'v == 2' }] }));
    localStorage.setItem('scriptcraft-watch-' + id, JSON.stringify(['total', 'v']));
  }, project.id);
  await page.goto('/');
  await expect(page.locator('.monaco-editor').first()).toBeVisible();

  await page.locator('[data-debug-start]').click();

  // It skips v=1 and pauses on v=2; by then total already holds double(1)=2
  await expect(page.getByText(/Остановка на точке останова: main\.py:3/)).toBeVisible({ timeout: 30_000 });
  const watch = page.locator('[data-watch-panel]');
  await expect(watch.locator('[data-watch-row]', { hasText: 'total' })).toContainText('2');
  await expect(watch.locator('[data-watch-row]', { hasText: /^v/ })).toContainText('2');

  // Continue: v=3 fails the condition, so the program finishes
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(page.locator('[data-debug-start]')).toBeEnabled({ timeout: 20_000 });
});

test('debugger: hovering a variable shows its value; a logpoint prints without stopping', async ({ page, request }) => {
  test.skip(!hasPython, 'python not installed');
  const code = 'total = 0\nfor v in [1, 2, 3]:\n    total += v * 2\nprint(total)\n';
  const project = (await (await request.post('/api/projects', { data: { name: 'Наведение', files: [{ name: 'main.py', language: 'python', content: code, isEntry: true }] } })).json()) as { id: string };
  await page.addInitScript((id) => {
    localStorage.setItem('scriptcraft-last-project', id);
    localStorage.setItem(
      'scriptcraft-bp-' + id,
      JSON.stringify({ 'main.py': [{ line: 3, condition: 'v == 2' }, { line: 4, log: 'final={total}' }] })
    );
  }, project.id);
  await page.goto('/');
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  await page.locator('[data-debug-start]').click();
  await expect(page.getByText(/Остановка на точке останова: main\.py:3/)).toBeVisible({ timeout: 30_000 });

  // Hover "total" on line 1: the tooltip shows its value at this pause
  const token = page.locator('.monaco-editor .view-lines span span', { hasText: /^total$/ }).first();
  await token.hover();
  await expect(page.locator('.monaco-hover', { hasText: /total\s*=\s*2/ }).first()).toBeVisible({ timeout: 10_000 });

  // Continue: the logpoint on line 4 prints and the program runs to the end without another pause
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(page.locator('[data-debug-start]')).toBeEnabled({ timeout: 20_000 });
  await page.getByText('Терминал', { exact: true }).first().click();
  await expect(output(page)).toContainText('final=12');
});

test('notebook: markdown renders and a code cell runs against a stateful kernel', async ({ page, request }) => {
  test.skip(!hasPython, 'python not installed');
  const ipynb = JSON.stringify({
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Мой ноутбук'] },
      { cell_type: 'code', metadata: {}, execution_count: null, source: ['a = 20'], outputs: [] },
      { cell_type: 'code', metadata: {}, execution_count: null, source: ['a + 22'], outputs: [] },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });
  const project = (await (await request.post('/api/projects', { data: { name: 'Ноутбук', files: [{ name: 'notes.ipynb', language: 'text', content: ipynb, isEntry: true }] } })).json()) as { id: string };
  await page.addInitScript((id) => localStorage.setItem('scriptcraft-last-project', id), project.id);
  await page.goto('/');

  // The notebook view opens (not the plain code editor), markdown renders
  await expect(page.locator('[data-notebook]')).toBeVisible();
  await expect(page.locator('[data-md-cell] h1')).toHaveText('Мой ноутбук');
  // Code cells are real Monaco editors (syntax-highlighted), not plain text areas
  await expect(page.locator('[data-cell-type="code"] .monaco-editor').first()).toBeVisible();

  // Run all: the kernel keeps state, so the 2nd code cell sees `a` from the 1st and prints 42
  await page.getByRole('button', { name: 'Запустить всё', exact: true }).click();
  await expect(page.locator('[data-cell-output]').last()).toContainText('42', { timeout: 30_000 });
  await expect(page.locator('[data-kernel-status="ready"]')).toBeVisible();
  // Leave the notebook so its kernel shuts down (unmount → DELETE kernel) before afterEach removes the project
  await page.goto('about:blank');
});

test('notebook: a cell that returns an image shows it inline', async ({ page, request }) => {
  test.skip(!hasPython, 'python not installed');
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const ipynb = JSON.stringify({
    cells: [
      { cell_type: 'code', metadata: {}, execution_count: null, source: [`import base64\nclass Img:\n    def _repr_png_(self):\n        return base64.b64decode("${PNG}")`], outputs: [] },
      { cell_type: 'code', metadata: {}, execution_count: null, source: ['Img()'], outputs: [] },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });
  const project = (await (await request.post('/api/projects', { data: { name: 'Картинка', files: [{ name: 'img.ipynb', language: 'text', content: ipynb, isEntry: true }] } })).json()) as { id: string };
  await page.addInitScript((id) => localStorage.setItem('scriptcraft-last-project', id), project.id);
  await page.goto('/');
  await expect(page.locator('[data-notebook]')).toBeVisible();
  await page.getByRole('button', { name: 'Запустить всё', exact: true }).click();
  await expect(page.locator('[data-cell-image]')).toBeVisible({ timeout: 30_000 });
  await page.goto('about:blank');
});

test('snippets: a prefix expands to a template with tab stops', async ({ page, request }) => {
  await openStudio(page, request, 'Сниппеты', [{ name: 'main.js', language: 'javascript', content: '', isEntry: true }]);
  const editor = page.locator('.monaco-editor').first();
  await editor.click();
  await page.keyboard.type('forof', { delay: 25 }); // a unique prefix: only our snippet matches
  await page.keyboard.press('Control+Space');
  const row = page.locator('.suggest-widget .monaco-list-row', { hasText: 'forof' }).first();
  await expect(row).toBeVisible();
  await row.click(); // accept our snippet explicitly (not whatever Tab might do)
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('for (const item of items)');
});

test('custom snippets: add one in the manager, then it expands in the editor', async ({ page, request }) => {
  await openStudio(page, request, 'Свои сниппеты', [{ name: 'main.py', language: 'python', content: '', isEntry: true }]);

  // Add a snippet via the manager
  await page.locator('[data-open-snippets]').click();
  const modal = page.locator('[data-snippets-modal]');
  await expect(modal).toBeVisible();
  // python is the default language
  await modal.locator('[data-snip-add]').click();
  await modal.locator('[data-snip-prefix]').first().fill('hola');
  await modal.locator('[data-snip-body]').first().fill('print("hola ${1:name}")');
  await modal.locator('[data-snip-save]').click();
  await expect(modal).toBeHidden();

  // Now the prefix expands in a Python file
  const editor = page.locator('.monaco-editor').first();
  await editor.click();
  await page.keyboard.type('hola', { delay: 25 });
  await page.keyboard.press('Control+Space');
  const row = page.locator('.suggest-widget .monaco-list-row', { hasText: 'hola' }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('print("hola name")');
});

test('emmet: an HTML abbreviation expands on Tab', async ({ page, request }) => {
  await openStudio(page, request, 'Emmet', [{ name: 'index.html', language: 'html', content: '', isEntry: true }]);
  const editor = page.locator('.monaco-editor').first();
  await editor.click();
  await page.keyboard.type('ul>li*2', { delay: 25 });
  await page.keyboard.press('Tab'); // Emmet expands the abbreviation
  const lines = page.locator('.monaco-editor .view-lines').first();
  await expect(lines).toContainText('<ul>');
  await expect(lines).toContainText('<li></li>');
});

test('notebook: Interrupt stops a stuck cell and the kernel stays usable', async ({ page, request }) => {
  test.skip(!hasPython, 'python not installed');
  const ipynb = JSON.stringify({
    cells: [{ cell_type: 'code', metadata: {}, execution_count: null, source: ['while True:\n    pass'], outputs: [] }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });
  const project = (await (await request.post('/api/projects', { data: { name: 'Прерывание', files: [{ name: 'loop.ipynb', language: 'text', content: ipynb, isEntry: true }] } })).json()) as { id: string };
  await page.addInitScript((id) => localStorage.setItem('scriptcraft-last-project', id), project.id);
  await page.goto('/');
  await expect(page.locator('[data-notebook]')).toBeVisible();

  await page.getByRole('button', { name: 'Запустить всё', exact: true }).click();
  const stop = page.locator('[data-nb-interrupt]');
  await expect(stop).toBeVisible({ timeout: 15_000 }); // appears while the cell runs
  await stop.click();
  // The stuck cell is interrupted and the kernel returns to ready
  await expect(page.locator('[data-cell-output]')).toContainText('KeyboardInterrupt', { timeout: 15_000 });
  await expect(page.locator('[data-kernel-status="ready"]')).toBeVisible();
  await page.goto('about:blank');
});

test('chat: attach a code file as context, regenerate the answer, edit the question', async ({ page, request }) => {
  const bodies: any[] = [];
  await page.route('**/api/chat/stream', async (route) => {
    bodies.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: `data: {"t":"Ответ ${bodies.length}"}\n\ndata: {"done":true,"model":"test"}\n\n`,
    });
  });
  await page.addInitScript(() => localStorage.setItem('scriptcraft-agent-mode', 'off'));
  await openStudio(page, request, 'Файлы в чат', [{ name: 'main.py', language: 'python', content: 'print(1)', isEntry: true }]);

  // A text file becomes a chip; its content goes to the model with the question
  await page.locator('input[data-chat-file]').setInputFiles({ name: 'notes.py', mimeType: 'text/x-python', buffer: Buffer.from('SECRET = 42\n') });
  await expect(page.locator('[data-chat-file-chip]')).toContainText('notes.py');
  const chat = page.getByPlaceholder(/Попросите ИИ/);
  await chat.fill('что в файле?');
  await chat.press('Enter');
  await expect(page.locator('.chat-md').getByText('Ответ 1')).toBeVisible();
  await expect(page.locator('[data-message-files]')).toContainText('notes.py');
  const sent = bodies[0].messages.at(-1).text;
  expect(sent).toContain('что в файле?');
  expect(sent).toContain('[Attached file "notes.py"]');
  expect(sent).toContain('SECRET = 42');
  await expect(page.locator('[data-chat-file-chip]')).toHaveCount(0);

  // Regenerate: the same request again (context included), the answer is replaced
  await page.locator('[data-regenerate]').click();
  await expect(page.locator('.chat-md').getByText('Ответ 2')).toBeVisible();
  await expect(page.locator('.chat-md').getByText('Ответ 1')).toHaveCount(0);
  expect(bodies[1].messages).toEqual(bodies[0].messages);

  // Edit: the question returns to the input, the question and its answer leave the thread
  await page.locator('[data-edit-message]').click();
  await expect(chat).toHaveValue('что в файле?');
  await expect(page.locator('.chat-md').getByText('Ответ 2')).toHaveCount(0);
});

test('build .exe from the Export menu', async ({ page, request }) => {
  test.setTimeout(240_000);
  const project = await openStudio(page, request, 'Сборка', [{ name: 'hello.py', content: 'print("hello from exe")', isEntry: true }]);
  const info = await (await request.get(`/api/projects/${project.id}/exe`)).json();
  test.skip(!info.pyinstaller, 'PyInstaller not installed');
  await page.locator('button[title^="Экспорт"], button:has-text("Экспорт")').first().click();
  await page.locator('[data-menu-build-exe]').click();
  const modal = page.locator('[data-build-exe]');
  await expect(modal.locator('select')).toHaveValue('hello.py');
  await expect(modal.locator('input[maxlength="60"]')).toHaveValue('hello');
  await modal.getByRole('button', { name: 'Собрать', exact: true }).click();
  await expect(modal.locator('[data-build-result="ok"]')).toBeVisible({ timeout: 200_000 });
  await expect(modal.locator('[data-build="hello.exe"]')).toContainText('dist/hello.exe');
});

test('trash: a deleted project is restored from the Projects dialog', async ({ page, request }) => {
  await request.delete('/api/trash');
  await openStudio(page, request, 'Основной', [{ name: 'main.py', content: 'print(1)', isEntry: true }]);
  await request.post('/api/projects', { data: { name: 'Черновик', files: [{ name: 'draft.py', language: 'python', content: 'x = 1' }] } });
  await page.locator('button[title^="Мои проекты"]').click();
  await page.locator('[data-project-row="Черновик"] button[title="Удалить"]').click();
  await page.locator('[data-dialog-ok]').click(); // the studio's own (themed) confirmation
  const trash = page.locator('[data-trash]');
  await expect(trash).toContainText('Корзина (1)');
  await trash.getByText('Корзина (1)').click();
  await expect(page.locator('[data-trash-item="Черновик"]')).toContainText('осталось дней: 30');
  await page.locator('[data-trash-item="Черновик"]').getByRole('button', { name: 'Восстановить' }).click();
  await expect(page.getByText('Проект «Черновик» восстановлен')).toBeVisible();
  await expect(trash).toHaveCount(0);
  const { projects } = (await (await request.get('/api/projects')).json()) as { projects: { name: string }[] };
  expect(projects.map((p) => p.name)).toContain('Черновик');
});

test('backups: back up now, then restore a project from the backup', async ({ page, request }) => {
  await openStudio(page, request, 'Копируемый', [{ name: 'main.py', content: 'print("важное")', isEntry: true }]);
  await page.locator('button[title^="Мои проекты"]').click();
  const section = page.locator('[data-backups]');
  await section.getByText('Резервные копии').click();
  await section.getByRole('button', { name: 'Сделать копию сейчас' }).click();
  await expect(section.locator('[data-backups-last]')).toContainText('последняя');
  await section.locator('[data-backup]').first().locator('button').first().click();
  await section.locator('[data-backup-project="Копируемый"]').getByRole('button', { name: 'Восстановить' }).click();
  await expect(page.getByText(/Восстановлено из копии: «Копируемый \(/)).toBeVisible();
  const { projects } = (await (await request.get('/api/projects')).json()) as { projects: { name: string }[] };
  expect(projects.some((p) => /^Копируемый \(\d\d\.\d\d \d\d:\d\d\)$/.test(p.name))).toBeTruthy();
});

test('python hints: completions, parameter hints, F12 into another file and F2 rename across files', async ({ page, request }) => {
  const tools = await (await request.get('/api/code/tools')).json();
  test.skip(!tools.jedi, 'jedi not installed');
  const project = await openStudio(page, request, 'Подсказки', [
    { name: 'main.py', content: 'from helpers import greet\nprint(greet("Ann"))\n', isEntry: true },
    { name: 'helpers.py', content: 'def greet(name: str, excited: bool = False) -> str:\n    """Return a friendly greeting."""\n    return "Hi, " + name\n' },
  ]);
  const editor = page.locator('.monaco-editor').first();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('gre', { delay: 40 });
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.suggest-widget')).toContainText('greet');
  await page.keyboard.press('Enter');
  await page.keyboard.type('("Bob", ', { delay: 40 });
  await expect(page.locator('.parameter-hints-widget')).toContainText('excited: bool');
  await page.keyboard.press('Escape');

  // F12 on "greet" in line 2 opens helpers.py
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('F12');
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('def greet', { timeout: 10_000 });

  // F2 in helpers.py: rename greet -> welcome in every file
  await editor.click();
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('F2');
  const box = page.locator('.rename-box input, .rename-input').first();
  await expect(box).toBeVisible();
  await box.fill('welcome');
  await box.press('Enter');
  await expect
    .poll(async () => ((await (await request.get(`/api/projects/${project.id}`)).json()).files as { name: string; content: string }[]).find((f) => f.name === 'main.py')?.content, { timeout: 10_000 })
    .toContain('from helpers import welcome');
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('def welcome');
});

test('run parameters: env var and arguments set in the dialog reach the program', async ({ page, request }) => {
  await openStudio(page, request, 'Параметры', [
    { name: 'main.js', content: 'console.log("token=" + process.env.BOT_TOKEN, "args=" + process.argv.slice(2).join("|"))', isEntry: true },
  ]);
  await page.locator('[data-open-run-config]').click();
  const dialog = page.locator('[data-run-config]');
  const row = dialog.locator('[data-env-row="0"]');
  await row.locator('input').first().fill('bot_token');
  await expect(row.locator('input').first()).toHaveValue('BOT_TOKEN');
  await row.locator('input').nth(1).fill('123:ABC');
  await expect(row.locator('input').nth(1)).toHaveAttribute('type', 'password'); // secrets are hidden
  await dialog.locator('[data-run-args]').fill('--name "Ann Lee"');
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dialog).toBeHidden();
  await expect(sidebarFile(page, '.env')).toHaveCount(0); // not shown in the explorer
  await runButton(page).click();
  await expect(output(page)).toContainText('token=123:ABC args=--name|Ann Lee');
});

test('split editor: two files side by side, the same file stays in sync, Ctrl+\ toggles', async ({ page, request }) => {
  const project = await openStudio(page, request, 'Две панели', [
    { name: 'main.py', content: 'print("main")\n', isEntry: true },
    { name: 'utils.py', content: 'VALUE = 1\n' },
  ]);
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+Backslash');
  const right = page.locator('[data-split-editor]');
  await expect(right).toBeVisible();
  await right.locator('[data-split-file]').selectOption({ label: 'utils.py' });
  await expect(right.locator('.view-lines')).toContainText('VALUE = 1');
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('print("main")'); // left side unchanged

  // Edit on the right: saved into utils.py
  await right.locator('.monaco-editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('EXTRA = 2', { delay: 30 });
  await expect
    .poll(async () => ((await (await request.get(`/api/projects/${project.id}`)).json()).files as { name: string; content: string }[]).find((f) => f.name === 'utils.py')?.content)
    .toContain('EXTRA = 2');

  // The same file on both sides: typing on the right shows up on the left at once
  await right.locator('[data-split-file]').selectOption({ label: 'main.py' });
  await right.locator('.monaco-editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('# synced', { delay: 30 });
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('# synced');

  await page.keyboard.press('Control+Backslash');
  await expect(right).toHaveCount(0);
});

test('other files: an image and a SQLite database made by a program open in the viewer', async ({ page, request }) => {
  test.skip(!hasPython, 'python not installed');
  const program = [
    'import base64, sqlite3',
    "png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='",
    "open('logo.png', 'wb').write(base64.b64decode(png))",
    "db = sqlite3.connect('data.db')",
    "db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')",
    "db.executemany('INSERT INTO users (name) VALUES (?)', [('Аня',), ('Борис',), ('Вера',)])",
    'db.commit()',
    "print('files ready')",
  ].join('\n');
  await openStudio(page, request, 'Файлы', [{ name: 'make.py', content: program, isEntry: true }]);
  await runButton(page).click();
  await expect(output(page)).toContainText('files ready');

  const section = page.locator('[data-assets]');
  await expect(section).toContainText('Другие файлы (2)', { timeout: 10_000 });
  await page.locator('[data-asset="logo.png"]').click();
  await expect(page.locator('[data-asset-viewer="logo.png"] [data-image-size]')).toHaveText('1 × 1 px');

  await page.locator('[data-asset="data.db"]').click();
  const viewer = page.locator('[data-asset-viewer="data.db"]');
  await expect(viewer.locator('[data-db-table-name="users"]')).toContainText('3');
  await expect(viewer.locator('[data-db-table]')).toContainText('Борис');
  await viewer.locator('[data-db-query]').fill("SELECT name || '!' AS big FROM users WHERE id = 3");
  await viewer.locator('[data-db-query]').press('Enter');
  await expect(viewer.locator('[data-db-table]')).toContainText('Вера!');

  // Back to the code
  await page.locator('div.group[title="make.py"]').click();
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
});

test('disassembler: clicking a jmp target jumps to it; search filters instructions', async ({ page, request }) => {
  test.skip(!hasPython, 'python not installed');
  // A tiny x64 PE: jmp 0x14000100a ; 5×nop ; sub rsp,0x28 ; ret
  const program = [
    'import base64, zlib',
    "open('sample.exe', 'wb').write(zlib.decompress(base64.b64decode('eJzzjWIgGzgwMDAEuDIwpLQxooh/YFBi4GZiYOBHFhSAYgYGB0YYn4mBgQ0qDaMZFCDiIMBMpDsEyPcC1YBeSWpFCQPUz1C/wfwBAwoMDAkD5Dyc4CUr0L0TQMCj+Y3G4YF2ziigMwAAckINQA==')))",
    "print('exe ready')",
  ].join('\n');
  await openStudio(page, request, 'Бинарник', [{ name: 'make.py', content: program, isEntry: true }]);
  await runButton(page).click();
  await expect(output(page)).toContainText('exe ready');
  await page.locator('[data-asset="sample.exe"]').click({ timeout: 15_000 });
  const viewer = page.locator('[data-asset-viewer="sample.exe"]');
  await viewer.locator('[data-disasm-tab="disasm"]').click();
  const jmpRow = viewer.locator('[data-ins="5368713216"]');
  await expect(jmpRow).toContainText('jmp');

  // The jump target is a link: clicking it highlights the target instruction
  await jmpRow.getByRole('button', { name: '0x14000100a' }).click();
  await expect(viewer.locator('[data-ins="5368713226"]')).toHaveClass(/bg-amber/);

  // Search narrows the listing
  await viewer.locator('[data-disasm-search]').fill('ret');
  await expect(viewer.locator('[data-ins]')).toHaveCount(1);
  await expect(viewer.locator('[data-ins]')).toContainText('ret');
});

test('agent: proposes a package install, the user approves, pip runs into the project', async ({ page, request }) => {
  const project = (await (await request.post('/api/projects', { data: { name: 'Install', files: [{ name: 'main.py', language: 'python', content: 'print(1)', isEntry: true }] } })).json()) as { id: string };
  await page.addInitScript((id) => {
    localStorage.setItem('scriptcraft-last-project', id);
    localStorage.setItem('scriptcraft-agent-mode', 'on');
    localStorage.setItem('scriptcraft-agent-confirm', 'on'); // approvals on, so the install card shows
    localStorage.setItem('scriptcraft-agent-plan', 'off');
  }, project.id);

  let steps = 0;
  await page.route('**/api/agent/step', async (route) => {
    steps++;
    const step =
      steps === 1
        ? { message: 'Нужен requests', files: [], run: null, install: { python: ['requests'], node: [] }, done: false, planStep: null }
        : { message: 'Готово', files: [], run: null, install: null, done: true, planStep: null };
    await route.fulfill({ json: { step, model: 'test', notice: null } });
  });
  // The install endpoint and its run-stream are faked (no real pip): capture that it was asked for
  let installBody: any = null;
  await page.route('**/packages/install', async (route) => {
    installBody = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({ json: { runId: 'fake-run' } });
  });
  await page.route('**/api/run/fake-run/events', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: 'data: {"type":"output","data":"Successfully installed requests-2.0"}\n\ndata: {"type":"exit","code":0}\n\n',
    });
  });

  await page.goto('/');
  await page.getByPlaceholder(/Опишите задачу/).fill('Скачай страницу через requests');
  await page.getByPlaceholder(/Опишите задачу/).press('Enter');

  // The install approval card appears and lists the package
  const card = page.locator('[data-agent-approval="install"]');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('requests');
  await card.getByRole('button', { name: 'Установить', exact: true }).click();

  // The install was requested as pip + the package, and the result shows in the chat
  await expect.poll(() => installBody).toEqual({ manager: 'pip', packages: ['requests'] });
  await expect(page.getByText(/Установка пакетов/).last()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Агент завершил|Готово|завершил/).last()).toBeVisible({ timeout: 20_000 });
});

test('agent plan: propose, revise, run; the checklist is ticked off as the agent works', async ({ page, request }) => {
  const project = (await (await request.post('/api/projects', { data: { name: 'План', files: [{ name: 'main.py', language: 'python', content: 'print(1)', isEntry: true }] } })).json()) as { id: string };
  await page.addInitScript((id) => {
    localStorage.setItem('scriptcraft-last-project', id);
    localStorage.setItem('scriptcraft-agent-mode', 'on');
    localStorage.setItem('scriptcraft-agent-confirm', 'off');
    localStorage.setItem('scriptcraft-agent-plan', 'on');
  }, project.id);
  // The AI is replaced by fixed answers; files are really written and really run
  let plans = 0;
  await page.route('**/api/agent/plan', async (route) => {
    plans++;
    const steps = [
      { title: 'Создать calc.py', files: ['calc.py'] },
      { title: 'Запустить и проверить', files: [] },
    ];
    if (plans > 1) steps.splice(1, 0, { title: 'Добавить комментарий', files: ['calc.py'] });
    await route.fulfill({ json: { plan: { summary: 'Небольшой калькулятор', steps, questions: [] }, model: 'test', notice: null } });
  });
  let steps = 0;
  await page.route('**/api/agent/step', async (route) => {
    steps++;
    const step =
      steps === 1
        ? { message: 'Создаю файл', files: [{ path: 'calc.py', content: '# calculator\nprint(2 + 2)\n' }], run: null, done: false, planStep: 1 }
        : steps === 2
          ? { message: 'Комментарий уже есть', files: [], run: null, done: false, planStep: 2 }
          : { message: 'Проверяю', files: [], run: 'calc.py', done: true, planStep: 3 };
    await route.fulfill({ json: { step, model: 'test', notice: null } });
  });
  await page.goto('/');
  await page.getByPlaceholder(/Опишите задачу/).fill('Сделай калькулятор');
  await page.getByPlaceholder(/Опишите задачу/).press('Enter');

  const card = page.locator('[data-agent-plan]');
  await expect(card.locator('[data-plan-step]')).toHaveCount(2);
  await card.getByRole('button', { name: 'Изменить план' }).click();
  await card.locator('[data-plan-feedback]').fill('добавь комментарий в код');
  await card.getByRole('button', { name: 'Обновить план' }).click();
  await expect(card.locator('[data-plan-step]')).toHaveCount(3);
  await card.getByRole('button', { name: 'Выполнить план' }).click();
  await expect(card).toHaveCount(0);

  await expect(page.getByText(/Агент завершил|Готово|завершил/).last()).toBeVisible({ timeout: 30_000 });
  await expect(sidebarFile(page, 'calc.py')).toBeVisible();
  // The plan message: every step ticked
  const checklist = page.locator('.chat-md').filter({ hasText: 'Небольшой калькулятор' });
  await expect(checklist.locator('input[type="checkbox"]:checked')).toHaveCount(3);
  await expect(page.locator('.chat-md').filter({ hasText: 'Результат' }).or(page.locator('.chat-md').filter({ hasText: 'calc.py' })).last()).toContainText('4');
});

test('publish to GitHub from the Git panel (fake GitHub CLI)', async ({ page, request }) => {
  test.skip(spawnSync('git', ['--version']).status !== 0, 'git not installed');
  const project = await openStudio(page, request, 'Публикация', [{ name: 'main.py', content: 'print("hello")', isEntry: true }]);
  await page.keyboard.press('Control+Shift+G');
  await page.getByRole('button', { name: 'Создать репозиторий' }).click();
  await request.post(`/api/git/${project.id}/identity`, { data: { name: 'UI Test', email: 'ui@example.com' } });
  await page.locator('[data-github-open]').click();
  await expect(page.locator('[data-github-name]')).toHaveValue(project.id);
  await page.locator('[data-github-submit]').click();
  await expect(page.locator('[data-github-link]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-github-link]')).toHaveAttribute('href', new RegExp(`/${project.id}$`));
  await expect(page.getByText('Нет изменений с последнего коммита')).toBeVisible();
});
