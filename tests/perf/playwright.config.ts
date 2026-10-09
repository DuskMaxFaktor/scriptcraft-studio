// Timings on a big project: npx playwright test --config tests/perf/playwright.config.ts
// (the same studio server as the UI tests, in a temporary folder)
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from '@playwright/test';
import base from '../../playwright.config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const server = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer!;

export default defineConfig({ ...base, testDir: '.', timeout: 300_000, retries: 0, reporter: 'list', webServer: { ...server, cwd: root } });
