// UI tests (Playwright): a real browser clicks through the studio.
// Run with: npm run test:ui   (builds the UI first; the server runs in a temporary folder, so real projects are never touched)
import { defineConfig } from '@playwright/test';
import fs from 'fs';

const PORT = 3210;

// Use an installed Chrome/Edge so no extra browser download is needed; otherwise Playwright's own Chromium
// ("npx playwright install chromium")
const channel = [
  ['chrome', `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`],
  ['chrome', `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`],
  ['msedge', `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`],
  ['msedge', `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`],
].find(([, exe]) => process.platform === 'win32' && fs.existsSync(exe))?.[0];

export default defineConfig({
  testDir: 'tests/ui',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  // One retry: a rare dropped synthetic keystroke (Monaco under load) is a harness artifact, not a
  // studio bug. A test that only passes on retry is reported as "flaky" (with its failed-attempt trace),
  // so real regressions — which fail every attempt — are never hidden.
  retries: 1,
  // Every failure leaves a report: a line log, a JSON file (test-results/report.json) and an HTML
  // report (playwright-report) with the trace and screenshot, so a rare flake can be studied afterwards.
  reporter: [['list'], ['json', { outputFile: 'test-results/report.json' }], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel,
    headless: true,
    locale: 'ru-RU',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // tsx CLI (not "node --import tsx"): it registers its loader by absolute path, which worker threads
    // (the terminal's node-pty) need after the server switches to its temporary folder
    command: 'node node_modules/tsx/dist/cli.mjs tests/ui/server.ts',
    url: `http://localhost:${PORT}/api/health`,
    env: { PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 60_000,
  },
  outputDir: 'test-results',
});
