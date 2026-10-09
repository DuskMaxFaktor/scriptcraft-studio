// Interface timings on a project at the studio's limit (2000 files). Not part of the regular UI run:
// npx playwright test --config tests/perf/playwright.config.ts
import { test, expect } from '@playwright/test';

const N = Number(process.env.PERF_FILES || 2000);
const line = 'def handler(request, response):\n    value = compute(request.args)\n    return response.send(value)\n';

test('big project: open, type, search, go to file', async ({ page, request }) => {
  const files = Array.from({ length: N }, (_, i) => ({
    name: `pkg${i % 40}/sub${i % 7}/module_${i}.py`,
    language: 'python',
    content: `# module ${i}\n` + line.repeat(25) + (i === N - 2 ? 'NEEDLE_4711 = 1\n' : ''),
    isEntry: i === 0,
  }));
  const project = (await (await request.post('/api/projects', { data: { name: 'Большой', files }, timeout: 120_000 })).json()) as { id: string };
  await page.addInitScript((id) => localStorage.setItem('scriptcraft-last-project', id), project.id);

  const times: Record<string, number> = {};
  const mark = async (name: string, fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    await fn();
    times[name] = Date.now() - t0;
  };

  await mark('open (until the editor shows the main file)', async () => {
    await page.goto('/');
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('module 0', { timeout: 60_000 });
  });

  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+End');
  await mark('type 40 characters', async () => {
    await page.keyboard.type('x = "' + 'a'.repeat(33) + '"\n', { delay: 0 });
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });
  await mark('autosave (until "saved")', async () => {
    await expect.poll(async () => (await (await request.get(`/api/projects/${project.id}`)).json()).files[0].content, { timeout: 30_000 }).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  await mark('project search (Ctrl+Shift+F)', async () => {
    await page.keyboard.press('Control+Shift+F');
    await page.getByPlaceholder('Искать во всех файлах').fill('NEEDLE_4711');
    await expect(page.locator('[data-search-match]').first()).toBeVisible({ timeout: 30_000 });
  });

  await mark('go to file (Ctrl+P)', async () => {
    await page.keyboard.press('Escape');
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+P');
    await page.keyboard.type(`module_${N - 1}`);
    await page.keyboard.press('Enter');
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText(`module ${N - 1}`, { timeout: 30_000 });
  });

  const heap = await page.evaluate(() => (performance as any).memory?.usedJSHeapSize || 0);
  console.log('\n' + Object.entries(times).map(([k, v]) => `${k.padEnd(46)} ${String(v).padStart(6)} ms`).join('\n'));
  console.log(`${'JS memory of the page'.padEnd(46)} ${(heap / 1024 / 1024).toFixed(0).padStart(6)} MB\n`);
  await request.delete(`/api/projects/${project.id}`);
});
