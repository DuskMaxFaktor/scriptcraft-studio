// Smoke test of an installed studio (scripts/clean_pc_check.ps1 starts it with a "clean PC" environment:
// no Python, Node.js or Git on PATH, an install folder with spaces and Cyrillic letters).
// Everything must work with what the studio brings along.
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

async function openProject(page: Page, request: APIRequestContext, name: string, files: { name: string; content: string; isEntry?: boolean }[]) {
  const res = await request.post('/api/projects', { data: { name, files } });
  expect(res.ok()).toBeTruthy();
  const project = (await res.json()) as { id: string };
  await page.addInitScript((id) => localStorage.setItem('scriptcraft-last-project', id), project.id);
  await page.goto('/');
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });
  return project;
}

const output = (page: Page) => page.locator('.font-mono.text-xs.space-y-1').first();
const runButton = (page: Page) => page.locator('button[title^="Запустить"]').first();

test('bundled tools are found', async ({ request }) => {
  const tools = await (await request.get('/api/code/tools')).json();
  expect(tools.ruff, 'Ruff from runtime\\python').toBeTruthy();
  expect(tools.eslint).toBeTruthy();
  // Disassembler: pefile, capstone and the assembler (keystone) come with the bundled Python
  const disasm = await (await request.get('/api/disasm/available')).json();
  expect(disasm).toMatchObject({ pefile: true, capstone: true, keystone: true });
  const asm = await (await request.post('/api/disasm/assemble', { data: { arch: 'x64', addr: 4096, code: 'nop; ret' } })).json();
  expect(asm.bytes).toBe('90c3');
});

test('Python program runs with the bundled Python (Cyrillic file name)', async ({ page, request }) => {
  await openProject(page, request, 'Проверка Python', [
    { name: 'привет.py', content: 'import sys, json\nprint("питон работает", sys.version_info.major)\n', isEntry: true },
  ]);
  await runButton(page).click();
  await expect(output(page)).toContainText('питон работает 3', { timeout: 30_000 });
});

test('JavaScript program runs with the bundled Node.js', async ({ page, request }) => {
  await openProject(page, request, 'Проверка JS', [{ name: 'app.js', content: 'console.log("node ok", typeof process.version)\n', isEntry: true }]);
  await runButton(page).click();
  await expect(output(page)).toContainText('node ok string', { timeout: 30_000 });
});

test('pytest from the bundled Python runs the Tests tab', async ({ page, request }) => {
  await openProject(page, request, 'Проверка тестов', [
    { name: 'calc.py', content: 'def add(a, b):\n    return a + b\n', isEntry: true },
    { name: 'test_calc.py', content: 'from calc import add\n\n\ndef test_add():\n    assert add(2, 2) == 4\n' },
  ]);
  await page.locator('[data-tab="tests"]').click();
  await page.getByRole('button', { name: /Запустить тесты Python/ }).click();
  await expect(page.locator('[data-test-case="test_add"]')).toHaveAttribute('data-status', 'passed', { timeout: 60_000 });
});

test('licenses ship with the build; the window loads nothing from Google', async ({ page, request }) => {
  const components = await (await request.get('/api/about/components')).json();
  expect(components.items.length).toBeGreaterThan(300);
  expect(components.items.some((i: { name: string }) => i.name === 'Python')).toBeTruthy();
  expect((await request.get('/api/about/licenses')).ok()).toBeTruthy();
  expect((await request.get('/api/about/privacy')).ok()).toBeTruthy();
  const external: string[] = [];
  page.on('request', (r) => {
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(r.url()) && !r.url().startsWith('data:')) external.push(r.url());
  });
  await openProject(page, request, 'Сеть', [{ name: 'main.py', content: 'print(1)', isEntry: true }]);
  await page.waitForTimeout(1500);
  expect(external.filter((u) => /fonts\.(googleapis|gstatic)\.com/.test(u))).toEqual([]);
});

test('the problem report names the installed build and the bundled Python', async ({ request }) => {
  const { report } = await (await request.post('/api/logs/report', { data: { description: 'smoke' } })).json();
  expect(report).toMatch(/ScriptCraft Studio \d+\.\d+\.\d+ \(installed\)/);
  expect(report).toMatch(/Python: Python 3\.\d+/);
});
