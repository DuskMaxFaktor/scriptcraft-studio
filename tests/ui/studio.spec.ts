// UI tests: a real browser opens the studio and uses it like a person would.
// Every test works in its own project (created through the API), so tests don't depend on each other.
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { spawnSync } from 'child_process';

const hasPython = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['--version'], { shell: true }).status === 0;

type FileSpec = { name: string; content: string; isEntry?: boolean };

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
  page.once('dialog', (d) => d.accept());
  const row = sidebarFile(page, 'extra.py');
  await row.hover();
  await row.locator('button[title="Удалить"]').click();
  await expect(row).toHaveCount(0);
  await expect.poll(() => projectFile(request, project.id, 'extra.py')).toBeUndefined();
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

  page.once('dialog', (d) => d.accept());
  await changed.hover();
  await changed.locator('button[title="Отменить изменения"]').click();
  await expect(page.getByText('Нет изменений с последнего коммита')).toBeVisible();
  // The editor picks up the restored file from disk
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('v1', { timeout: 10000 });
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
  page.once('dialog', (d) => d.accept());
  await page.locator('[data-project-row="Черновик"] button[title="Удалить"]').click();
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
